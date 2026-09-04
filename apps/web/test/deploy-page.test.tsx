import { JSDOM } from 'jsdom';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The /deploy page composes the install components; next/navigation hooks
// need a router context renderToString cannot provide.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const mocks = vi.hoisted(() => ({
  fetchDeployLinkData: vi.fn(),
  fetchDeployLinkStatusServer: vi.fn(),
}));

vi.mock('../src/lib/deploy-link-flow', () => ({
  fetchDeployLinkData: mocks.fetchDeployLinkData,
  fetchDeployLinkStatusServer: mocks.fetchDeployLinkStatusServer,
}));

const DeployPage = (await import('../src/app/deploy/[publicId]/page')).default;

// Page-state tests for the hosted /deploy page: each state is driven by the
// resolve result, and the customer-visible copy must stay jargon-free with
// no internal identifiers.

const PUBLIC_ID = 'b7e2a91c-1f3a-4c5d-8e9f-0a1b2c3d4e5f';
const TOKEN = 'a'.repeat(64);
const QUICK_CREATE = 'https://console.aws.amazon.com/cloudformation/quickcreate';

function resolvedData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    link: { status: 'active' },
    application: { name: 'Acme Analytics' },
    customer: { name: 'Acme' },
    region: 'us-east-1',
    resources: ['Application runtime', 'PostgreSQL database'],
    deploymentState: 'NOT_INSTALLED',
    bootstrapStackName: 'deployz-bootstrap-acme-analytics-1',
    waitingForRelay: false,
    relayStuck: false,
    quickCreateUrl: QUICK_CREATE,
    domain: null,
    routingTarget: null,
    status: { stage: 'WAITING_FOR_AWS' },
    ...overrides,
  };
}

async function renderPage(search?: string): Promise<Document> {
  // DeployPage is an async server component: await it to the resolved JSX
  // tree first — renderToString cannot suspend.
  const element = await DeployPage({
    params: Promise.resolve({ publicId: PUBLIC_ID }),
    searchParams: Promise.resolve(search === undefined ? { token: TOKEN } : {}),
  });
  const { window } = new JSDOM(renderToString(element));
  return window.document;
}

beforeEach(() => {
  mocks.fetchDeployLinkData.mockReset();
  mocks.fetchDeployLinkStatusServer.mockReset().mockResolvedValue(null);
});

describe('DeployPage', () => {
  it('shows the minimal review for a not-yet-launched deployment', async () => {
    mocks.fetchDeployLinkData.mockResolvedValue({ ok: true, data: resolvedData() });
    const doc = await renderPage();

    expect(doc.body.textContent).toContain('Acme Analytics');
    expect(doc.body.textContent).toContain('Deploy privately to your AWS');
    expect(doc.body.textContent).toContain('AWS account you control');
    expect(doc.body.textContent).toContain('PostgreSQL database');
    expect(doc.body.textContent).toContain('Powered by Deployz');
    expect(doc.querySelector('a[href="' + QUICK_CREATE + '"]')?.textContent).toBe('Deploy to AWS');
    // No internal identifiers in the page.
    expect(doc.body.textContent).not.toContain(PUBLIC_ID);
  });

  it('shows the connecting view once launched, with the stack name and retry on a stuck relay', async () => {
    mocks.fetchDeployLinkData.mockResolvedValue(
      await Promise.resolve({
        ok: true,
        data: resolvedData({
          waitingForRelay: true,
          relayStuck: true,
          deploymentState: 'WAITING_FOR_RELAY',
          status: { stage: 'WAITING_FOR_AWS' },
        }),
      }),
    );
    const doc = await renderPage();

    expect(doc.body.textContent).toContain('setting up inside your AWS account');
    expect(doc.body.textContent).toContain('deployz-bootstrap-acme-analytics-1');
    expect(doc.body.textContent).toContain('Still connecting');
    expect(doc.body.textContent).toContain('Retry deployment');
  });

  it('renders the resume/progress view for a launched deployment', async () => {
    mocks.fetchDeployLinkData.mockResolvedValue(
      await Promise.resolve({
        ok: true,
        data: resolvedData({
          deploymentState: 'INSTALLING',
          status: { stage: 'PROVISIONING' },
        }),
      }),
    );
    const doc = await renderPage();

    expect(doc.body.textContent).toContain('runs inside your AWS account');
    expect(doc.querySelector('[data-testid="deploy-link-url"]')).toBeNull();
  });

  it('renders friendly states for revoked and expired links', async () => {
    mocks.fetchDeployLinkData.mockResolvedValue({ ok: false, reason: 'revoked' });
    const revoked = await renderPage();
    expect(revoked.body.textContent).toContain('no longer valid');
    expect(revoked.body.textContent).toContain('request a new link');

    mocks.fetchDeployLinkData.mockResolvedValue({ ok: false, reason: 'expired' });
    const expired = await renderPage();
    expect(expired.body.textContent).toContain('has expired');
  });

  it('treats a missing token as an invalid link', async () => {
    const doc = await renderPage('');
    expect(doc.body.textContent).toContain("isn't valid");
    expect(mocks.fetchDeployLinkData).not.toHaveBeenCalled();
  });
});
