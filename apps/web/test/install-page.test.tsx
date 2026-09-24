import { JSDOM } from 'jsdom';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The /install page resolves public install links first, then falls back to
// the per-deployment flow. These tests cover the existing per-deployment
// branch and the public-link fall-through.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const mocks = vi.hoisted(() => ({
  fetchPublicInstallData: vi.fn(),
  fetchInstallData: vi.fn(),
  fetchInstallStatusServer: vi.fn(),
}));

vi.mock('../src/lib/public-install-data', () => ({
  fetchPublicInstallData: mocks.fetchPublicInstallData,
}));
vi.mock('../src/lib/install-data', () => ({
  fetchInstallData: mocks.fetchInstallData,
  launchInstall: vi.fn(),
}));
vi.mock('../src/lib/install-status', () => ({
  fetchInstallStatusServer: mocks.fetchInstallStatusServer,
}));

const InstallPage = (await import('../src/app/install/[installLinkId]/page')).default;

const LINK_ID = '11111111-1111-1111-1111-111111111111';
const QUICK_CREATE = 'https://console.aws.amazon.com/cloudformation/quickcreate';

function resolvedData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    applicationName: 'Acme App',
    publisherName: 'Acme Inc',
    customerName: 'Customer One',
    region: 'us-east-1',
    plan: {
      schemaVersion: 1,
      action: 'INSTALL',
      region: 'us-east-1',
      components: [
        { kind: 'application', name: 'Application', action: 'CREATE', lifecycle: 'delete' },
        { kind: 'endpoint', name: 'Secure endpoint', action: 'CREATE', lifecycle: 'delete' },
        { kind: 'database', name: 'Database', action: 'CREATE', lifecycle: 'retain' },
      ],
      awsResources: [
        {
          id: 'ecs_service',
          name: 'ECS Fargate service',
          purpose: 'Runs the application container and restarts it if it stops',
          group: 'compute_networking',
          componentKind: 'application',
          lifecycle: 'delete',
        },
        {
          id: 'database',
          name: 'RDS PostgreSQL database',
          purpose: 'Stores persistent application data',
          group: 'data',
          componentKind: 'database',
          lifecycle: 'retain',
        },
      ],
      requirementDrift: [],
    },
    quickCreateUrl: QUICK_CREATE,
    alreadyInstalled: false,
    deploymentId: 'dep-1',
    deploymentState: 'NOT_INSTALLED',
    domain: null,
    routingTarget: null,
    bootstrapStackName: 'deployz-bootstrap-acme-app-dep-1',
    waitingForRelay: false,
    relayStuck: false,
    components: null,
    releaseVersion: '1.2.0',
    ...overrides,
  };
}

async function renderPage(linkId: string = LINK_ID): Promise<Document> {
  const element = await InstallPage({
    params: Promise.resolve({ installLinkId: linkId }),
  });
  const { window } = new JSDOM(renderToString(element));
  return window.document;
}

beforeEach(() => {
  mocks.fetchPublicInstallData.mockReset();
  mocks.fetchInstallData.mockReset();
  mocks.fetchInstallStatusServer.mockReset().mockResolvedValue(null);
});

describe('InstallPage per-deployment flow', () => {
  it('renders the existing install page when no public install link matches', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue({ status: 'ok', data: resolvedData() });

    const doc = await renderPage();

    expect(doc.body.textContent).toContain('to your AWS account');
    expect(doc.body.textContent).toContain('Application');
    expect(doc.body.textContent).toContain('Review setup in AWS');
  });

  it('delegates an unknown link to the invitation token gate', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue({ status: 'not_found' });

    const doc = await renderPage();

    // The gate resolves on the client (the one-time token travels as a URL
    // fragment the server never sees); the server render shows its loading
    // state, and the token handling itself is covered by the gate tests.
    expect(doc.body.textContent).toContain('Opening your installation');
  });

  it('renders a distinct expired state for an expired link', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue({
      status: 'unavailable',
      code: 'INSTALL_LINK_EXPIRED',
      message: 'This installation link has expired. Ask the publisher for a new one.',
    });

    const doc = await renderPage();

    expect(doc.body.textContent).toContain('This installation link has expired');
    expect(doc.body.textContent).toContain('Ask the publisher for a new one.');
  });

  it('renders a distinct revoked state for a revoked link', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue({
      status: 'unavailable',
      code: 'INSTALL_LINK_REVOKED',
      message: 'This installation link was revoked by the publisher.',
    });

    const doc = await renderPage();

    expect(doc.body.textContent).toContain('This installation link was revoked');
    expect(doc.body.textContent).toContain('revoked by the publisher');
  });

  it('shows the waiting-for-relay view after the customer launched the install', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue({
      status: 'ok',
      data: resolvedData({
        waitingForRelay: true,
        relayStuck: true,
        deploymentState: 'WAITING_FOR_RELAY',
      }),
    });

    const doc = await renderPage();

    expect(doc.body.textContent).toContain('Acme App');
    expect(doc.body.textContent).toContain('setting up inside your AWS account');
    expect(doc.body.textContent).toContain('Still connecting');
  });

  it('renders the READY branch with the deployed-by heading', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue({
      status: 'ok',
      data: resolvedData({
        alreadyInstalled: true,
        deploymentState: 'HEALTHY',
      }),
    });

    const doc = await renderPage();

    expect(doc.body.textContent).toContain('Acme App');
    expect(doc.body.textContent).toContain('Deployed by Acme Inc');
  });

});
