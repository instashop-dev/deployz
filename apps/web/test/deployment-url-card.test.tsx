import { JSDOM } from 'jsdom';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DeploymentUrlCard } from '../src/components/deployment-url-card';
import type { FleetDeploymentDetail, HealthStatus } from '../src/lib/deployments';

/**
 * Component/DOM tests for the deployment detail URL card (Phase 9).
 *
 * The card is rendered with react-dom/server and parsed with jsdom so we can
 * assert on the visible text and affordances without needing a full browser.
 */

function status(): FleetDeploymentDetail['deploymentStatus'] {
  return {
    stage: 'READY',
    updatedAt: '2026-09-01T00:00:00.000Z',
    currentActivity: 'Live and healthy.',
    step: 'READY',
    steps: ['AWS_SETUP', 'RELAY_CONNECT', 'PREPARING', 'NETWORK', 'APPLICATION', 'HEALTH_CHECK', 'TLS', 'READY'],
    typicalDurationSeconds: null,
    takingLongerThanUsual: false,
    stepStartedAt: null,
    stepTimings: [],
    statusUpdatesUnavailable: false,
    needsDomainSetup: false,
    components: [],
    relay: { connected: true, lastSeenAt: null },
    job: null,
    aws: { stackStatus: null },
    health: { status: 'HEALTHY', layers: { infrastructure: 'UNKNOWN', rollout: null, targets: null, http: null, relay: 'CONNECTED' } },
    url: 'https://d-dep-9f1c.deployz.dev',
    failure: null,
  } as unknown as FleetDeploymentDetail['deploymentStatus'];
}

function detail(overrides: Partial<FleetDeploymentDetail> = {}): FleetDeploymentDetail {
  return {
    id: 'dep-9f1c',
    customerId: 'cust-1',
    applicationId: 'app-1',
    organizationId: 'org-1',
    region: 'us-east-1',
    state: 'HEALTHY',
    awsAccountId: '1234••••••••',
    currentReleaseId: 'rel-1',
    previousReleaseId: null,
    relayStatus: 'CONNECTED',
    healthStatus: 'HEALTHY' as HealthStatus,
    components: null,
    installLinkId: 'link-1',
    desiredState: {},
    observedState: null,
    infraVersion: '1',
    installationId: 'inst-1',
    isTestDeployment: false,
    lastHealthAt: '2026-09-01T00:00:00.000Z',
    deletedAt: null,
    cleanupState: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    createdBy: null,
    updatedBy: null,
    customerName: 'Acme',
    applicationName: 'Example App',
    version: '1.0.0',
    relayVersion: null,
    bootstrapVersion: null,
    relayCapabilities: null,
    runningImageDigest: null,
    attemptNumber: 1,
    bootstrapStackName: null,
    installStartedAt: null,
    deploymentStatus: status(),
    jobs: [],
    customDomain: null,
    appUrl: 'https://d-dep-9f1c.deployz.dev',
    defaultUrl: 'https://d-dep-9f1c.deployz.dev',
    ...overrides,
  };
}

function render(d: FleetDeploymentDetail): Document {
  const html = renderToString(<DeploymentUrlCard detail={d} />);
  const { window } = new JSDOM(html);
  return window.document;
}

describe('DeploymentUrlCard', () => {
  it('shows the Deployz address as the application URL when no custom domain is configured', () => {
    const doc = render(detail());

    expect(doc.body.textContent).toContain('Application URL');
    expect(doc.body.textContent).toContain('https://d-dep-9f1c.deployz.dev');
    expect(doc.body.textContent).toContain('Healthy');
    expect(doc.body.textContent).toContain('Secure');
    expect(doc.body.textContent).toContain('Open application');
    expect(doc.body.textContent).toContain('Copy');

    expect(doc.body.textContent).toContain('Custom domain');
    expect(doc.body.textContent).toContain('Not configured');
    expect(doc.querySelector('a[href="/install/link-1"]')?.textContent).toBe('Add custom domain');
  });

  it('renders the API-provided defaultUrl rather than a client-minted hostname', () => {
    // The API's real default-HTTPS hostname (from the stored state) must win
    // over the client-side d-<id>.deployz.dev projection.
    const d = detail({
      appUrl: null,
      defaultUrl: 'https://d-from-api.deployz.dev',
    });
    const doc = render(d);

    expect(doc.body.textContent).toContain('https://d-from-api.deployz.dev');
    expect(doc.body.textContent).not.toContain('https://d-dep-9f1c.deployz.dev');
  });

  it('shows a pending custom domain alongside the active Deployz address', () => {
    const d = detail({
      appUrl: 'https://d-dep-9f1c.deployz.dev',
      customDomain: { hostname: 'app.customer.com', status: 'waiting_for_dns' },
    });
    const doc = render(d);

    expect(doc.body.textContent).toContain('Deployz address');
    expect(doc.body.textContent).toContain('https://d-dep-9f1c.deployz.dev');
    expect(doc.body.textContent).toContain('Active');
    expect(doc.body.textContent).toContain('Open application');

    expect(doc.body.textContent).toContain('Custom domain');
    expect(doc.body.textContent).toContain('https://app.customer.com');
    expect(doc.body.textContent).toContain('Waiting for domain setup');
    expect(doc.querySelector('a[href="/install/link-1"]')?.textContent).toBe('Check custom domain');
  });

  it('shows an active custom domain as the primary URL with the Deployz address as a fallback', () => {
    const d = detail({
      appUrl: 'https://app.customer.com',
      customDomain: { hostname: 'app.customer.com', status: 'active' },
    });
    const doc = render(d);

    expect(doc.body.textContent).toContain('Application URL');
    expect(doc.body.textContent).toContain('https://app.customer.com');
    expect(doc.body.textContent).toContain('Healthy');
    expect(doc.body.textContent).toContain('Secure');
    expect(doc.body.textContent).toContain('Open application');

    expect(doc.body.textContent).toContain('Deployz address');
    expect(doc.body.textContent).toContain('https://d-dep-9f1c.deployz.dev');

    // The secondary Deployz address is an address, not a duplicate CTA:
    // exactly one "Open application" affordance, pointing at the primary URL.
    const openLinks = [...doc.querySelectorAll('a')].filter((a) =>
      a.textContent?.includes('Open application'),
    );
    expect(openLinks).toHaveLength(1);
    expect(openLinks[0]?.getAttribute('href')).toBe('https://app.customer.com');

    expect(doc.body.textContent).toContain('Custom domain');
    expect(doc.body.textContent).toContain('Active');
    expect(doc.querySelector('a[href="/install/link-1"]')?.textContent).toBe('Manage custom domain');
  });

  it('shows a needs-attention treatment when the custom domain has failed', () => {
    const d = detail({
      appUrl: 'https://d-dep-9f1c.deployz.dev',
      customDomain: { hostname: 'app.customer.com', status: 'error' },
    });
    const doc = render(d);

    expect(doc.body.textContent).toContain('Deployz address');
    expect(doc.body.textContent).toContain('https://d-dep-9f1c.deployz.dev');
    expect(doc.body.textContent).toContain('Active');

    expect(doc.body.textContent).toContain('Custom domain needs attention');
    expect(doc.body.textContent).toContain('Your application remains available at:');
    expect(doc.body.textContent).toContain('https://d-dep-9f1c.deployz.dev');
    expect(doc.querySelector('a[href="/install/link-1"]')?.textContent).toBe('Manage custom domain');
  });

  it('shows a brief removing treatment while a custom domain is being removed', () => {
    const d = detail({
      appUrl: 'https://d-dep-9f1c.deployz.dev',
      customDomain: { hostname: 'app.customer.com', status: 'removing' },
    });
    const doc = render(d);

    expect(doc.body.textContent).toContain('Deployz address');
    expect(doc.body.textContent).toContain('https://d-dep-9f1c.deployz.dev');

    expect(doc.body.textContent).toContain('Custom domain');
    expect(doc.body.textContent).toContain('Removing domain…');
  });
});
