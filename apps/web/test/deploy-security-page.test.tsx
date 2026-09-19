import { JSDOM } from 'jsdom';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The tokenized /deploy/:publicId/security page fails closed exactly like
// the /deploy page (same resolve, same reason mapping) and renders the
// shared SecurityDetailsContent on success. The token must never appear in
// page content — only in the back link's query string, the convention the
// /deploy page itself already uses.

const mocks = vi.hoisted(() => ({
  fetchDeployLinkData: vi.fn(),
}));

vi.mock('../src/lib/deploy-link-flow', () => ({
  fetchDeployLinkData: mocks.fetchDeployLinkData,
}));

const DeploySecurityPage = (await import('../src/app/deploy/[publicId]/security/page')).default;

const PUBLIC_ID = 'b7e2a91c-1f3a-4c5d-8e9f-0a1b2c3d4e5f';
const TOKEN = 'a'.repeat(64);
const SECURITY_HREF = `/deploy/${PUBLIC_ID}/security?token=${TOKEN}`;
const BACK_HREF = `/deploy/${PUBLIC_ID}?token=${TOKEN}`;

function resolvedData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    link: { status: 'active' },
    application: { name: 'Acme Analytics' },
    customer: { name: 'Acme' },
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
    deploymentState: 'INSTALLING',
    bootstrapStackName: 'deployz-bootstrap-acme-analytics-1',
    waitingForRelay: false,
    relayStuck: false,
    quickCreateUrl: null,
    domain: null,
    routingTarget: null,
    status: { stage: 'PROVISIONING' },
    ...overrides,
  };
}

async function renderPage(search?: string): Promise<Document> {
  // DeploySecurityPage is an async server component: await it to the
  // resolved JSX tree first — renderToString cannot suspend.
  const element = await DeploySecurityPage({
    params: Promise.resolve({ publicId: PUBLIC_ID }),
    searchParams: Promise.resolve(search === undefined ? { token: TOKEN } : {}),
  });
  const { window } = new JSDOM(renderToString(element));
  return window.document;
}

beforeEach(() => {
  mocks.fetchDeployLinkData.mockReset();
});

describe('DeploySecurityPage', () => {
  it('renders the security content from the resolved plan', async () => {
    mocks.fetchDeployLinkData.mockResolvedValue({ ok: true, data: resolvedData() });
    const doc = await renderPage();

    expect(doc.body.textContent).toContain('Security details');
    expect(doc.body.textContent).toContain('RDS PostgreSQL database');
    expect(mocks.fetchDeployLinkData).toHaveBeenCalledWith(PUBLIC_ID, TOKEN);
  });

  it('links back to the deploy page, carrying the token in the query string', async () => {
    mocks.fetchDeployLinkData.mockResolvedValue({ ok: true, data: resolvedData() });
    const doc = await renderPage();

    const back = [...doc.querySelectorAll('a')].find(
      (anchor) => anchor.textContent === 'Back to deployment',
    );
    expect(back?.getAttribute('href')).toBe(BACK_HREF);
  });

  it('never renders the raw token in page content', async () => {
    mocks.fetchDeployLinkData.mockResolvedValue({ ok: true, data: resolvedData() });
    const doc = await renderPage();

    // Visible text only — the back link carries the token as an href
    // attribute, which textContent does not include.
    expect(doc.body.textContent).not.toContain(TOKEN);
  });

  it('shows the honest unavailable states when the plan is null', async () => {
    mocks.fetchDeployLinkData.mockResolvedValue({ ok: true, data: resolvedData({ plan: null }) });
    const doc = await renderPage();

    expect(doc.body.textContent).toContain('Infrastructure details are unavailable');
    expect(doc.body.textContent).toContain('Security details');
    expect(doc.body.textContent).not.toContain('RDS PostgreSQL database');
  });

  it('treats a missing token as an invalid link', async () => {
    const doc = await renderPage('');
    expect(doc.body.textContent).toContain("isn't valid");
    expect(mocks.fetchDeployLinkData).not.toHaveBeenCalled();
  });

  it('shows the invalid copy for a 404 resolve', async () => {
    mocks.fetchDeployLinkData.mockResolvedValue({ ok: false, reason: 'invalid' });
    const doc = await renderPage();
    expect(doc.body.textContent).toContain("isn't valid");
  });

  it('shows the expired copy for a 410 DEPLOY_LINK_EXPIRED', async () => {
    mocks.fetchDeployLinkData.mockResolvedValue({ ok: false, reason: 'expired' });
    const doc = await renderPage();
    expect(doc.body.textContent).toContain('has expired');
  });

  it('shows the revoked copy for any other 410 code', async () => {
    mocks.fetchDeployLinkData.mockResolvedValue({ ok: false, reason: 'revoked' });
    const doc = await renderPage();
    expect(doc.body.textContent).toContain('no longer valid');
  });

  it('shows the unavailable copy for any other failure', async () => {
    mocks.fetchDeployLinkData.mockResolvedValue({ ok: false, reason: 'unavailable' });
    const doc = await renderPage();
    expect(doc.body.textContent).toContain('Try again in a moment');
  });

  it('never carries the token in link text or aria labels', async () => {
    mocks.fetchDeployLinkData.mockResolvedValue({ ok: true, data: resolvedData() });
    const doc = await renderPage();

    for (const anchor of [...doc.querySelectorAll('a')]) {
      expect(anchor.textContent).not.toContain(TOKEN);
      const label = anchor.getAttribute('aria-label');
      if (label !== null) {
        expect(label).not.toContain(TOKEN);
      }
    }
    expect(doc.querySelector(`a[href="${SECURITY_HREF}"]`)).toBeNull();
  });
});
