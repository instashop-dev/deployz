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
    mocks.fetchInstallData.mockResolvedValue(resolvedData());

    const doc = await renderPage();

    expect(doc.body.textContent).toContain('to your AWS account');
    expect(doc.body.textContent).toContain('Application');
    expect(doc.body.textContent).toContain('Review setup in AWS');
  });

  it('renders a not-found message when the link is invalid', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue(null);

    const doc = await renderPage();

    expect(doc.body.textContent).toContain("This link isn't valid");
  });

  it('shows the waiting-for-relay view after the customer launched the install', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue(
      resolvedData({
        waitingForRelay: true,
        relayStuck: true,
        deploymentState: 'WAITING_FOR_RELAY',
      }),
    );

    const doc = await renderPage();

    expect(doc.body.textContent).toContain('Acme App');
    expect(doc.body.textContent).toContain('setting up inside your AWS account');
    expect(doc.body.textContent).toContain('Still connecting');
  });

  it('renders the success summary in the READY branch', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue(
      resolvedData({
        alreadyInstalled: true,
        deploymentState: 'HEALTHY',
      }),
    );

    const doc = await renderPage();

    expect(doc.body.textContent).toContain('Acme App');
    expect(doc.body.textContent).toContain('Deployed by Acme Inc');
    expect(doc.body.textContent).toContain('Release 1.2.0');
    expect(doc.body.textContent).toContain('US East (N. Virginia)');
    expect(doc.body.textContent).toContain('Application');
    expect(doc.body.textContent).toContain('Secure endpoint');
    expect(doc.body.textContent).toContain('Database');
    expect(doc.body.textContent).toContain(
      'PostgreSQL and stored files are retained when the application is disconnected. They can continue to generate AWS charges until they are permanently purged.',
    );
    expect(doc.body.textContent).toContain('When this deployment is removed, Database stays in your AWS account.');
  });

  it('hides the release row when releaseVersion is null', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue(
      resolvedData({
        alreadyInstalled: true,
        deploymentState: 'HEALTHY',
        releaseVersion: null,
      }),
    );

    const doc = await renderPage();

    expect(doc.body.textContent).not.toContain('Release 1.2.0');
    expect(doc.body.textContent).toContain('Summary');
  });
});
