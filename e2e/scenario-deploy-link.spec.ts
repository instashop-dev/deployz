/**
 * Deploy Links (docs/deploy-links.md) Phase 9 simulated E2E: the complete
 * customer journey through the REAL pipeline — the vendor generates a
 * tokenized link, the customer resolves and launches it through the public
 * token-header routes, and the same SimulatedCustomerAccount relay drives
 * the same INSTALL pipeline the manual flow uses. Failure journeys cover the
 * invalid-token, revoked-mid-flow and repeated-launch edges. API-only, like
 * e2e/scenario-install.spec.ts.
 */

import { API_URL, expect, test } from './simulation/fixtures.js';

test.describe.configure({ mode: 'parallel' });

function linkHeaders(token: string): Record<string, string> {
  return { 'x-deployz-token': token };
}

test.describe('deploy-link happy path', () => {
  test.use({ deployzScenario: 'happy-path' });

  test('@scenario:deploy-link full journey: resolve, launch, install, fleet parity, audit events', async ({
    request,
    deployzLinkInstall,
  }) => {
    test.setTimeout(30_000);
    const { deploymentId, deployLinkPublicId, deployLinkToken, api } = deployzLinkInstall;

    // The same pipeline carries the link-created deployment to HEALTHY —
    // no deploy-link-specific install path exists or is needed.
    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for deployment.state to reach HEALTHY',
      })
      .toBe('HEALTHY');

    const deployment = await api.getDeployment(deploymentId);
    expect(deployment.source).toBe('deploy_link');

    // The customer's own projection, scoped by the link token.
    const status = await request.get(`${API_URL}/api/deploy-links/${deployLinkPublicId}/status`, {
      headers: linkHeaders(deployLinkToken),
    });
    expect(status.ok()).toBeTruthy();
    expect(((await status.json()) as { stage: string }).stage).toBe('VERIFYING');

    // Vendor dashboards list it like any other deployment.
    const fleet = await request.get(`${API_URL}/api/deployments`);
    expect(fleet.ok()).toBeTruthy();
    const fleetBody = (await fleet.json()) as { deployments: Array<{ id: string; source: string }> };
    expect(fleetBody.deployments.find((row) => row.id === deploymentId)?.source).toBe('deploy_link');

    // The audit trail records the whole link lifecycle on the deployment.
    const events = await request.get(`${API_URL}/api/deployments/${deploymentId}/events`);
    expect(events.ok()).toBeTruthy();
    const eventBody = (await events.json()) as { events: Array<{ eventType: string }> };
    const types = eventBody.events.map((event) => event.eventType);
    for (const expected of ['deploy_link.created', 'deploy_link.opened', 'deploy_link.launched']) {
      expect(types).toContain(expected);
    }
  });
});

test.describe('deploy-link failure journeys', () => {
  test.use({ deployzScenario: 'happy-path', deployzStartRelay: false });

  test('@scenario:deploy-link-invalid a wrong token never resolves', async ({ request, deployzLinkInstall }) => {
    const { deployLinkPublicId } = deployzLinkInstall;
    const response = await request.get(`${API_URL}/api/deploy-links/${deployLinkPublicId}`, {
      headers: linkHeaders('0'.repeat(64)),
    });
    expect(response.status()).toBe(404);
  });

  test('@scenario:deploy-link-revoked a revoked link fails closed mid-flow', async ({
    request,
    deployzLinkInstall,
  }) => {
    const { deployLinkPublicId, deployLinkToken } = deployzLinkInstall;
    // The vendor revokes while the customer's page is open (the fixture
    // already resolved and launched).
    const revoke = await request.post(`${API_URL}/api/deploy-links/${deployLinkPublicId}/revoke`, {
      data: {},
    });
    expect(revoke.ok()).toBeTruthy();

    const resolve = await request.get(`${API_URL}/api/deploy-links/${deployLinkPublicId}`, {
      headers: linkHeaders(deployLinkToken),
    });
    expect(resolve.status()).toBe(410);
    const launch = await request.post(
      `${API_URL}/api/deploy-links/${deployLinkPublicId}/launched`,
      { headers: linkHeaders(deployLinkToken), data: {} },
    );
    expect(launch.status()).toBe(410);
  });

  test('@scenario:deploy-link-double-submit repeated launches record exactly one launch event', async ({
    request,
    deployzLinkInstall,
  }) => {
    const { deployLinkPublicId, deploymentId, deployLinkToken } = deployzLinkInstall;
    // Two more submits racing (double click, refresh, retry) after the
    // fixture's own launch — the waiting state and the event stay single.
    const [first, second] = await Promise.all([
      request.post(`${API_URL}/api/deploy-links/${deployLinkPublicId}/launched`, {
        headers: linkHeaders(deployLinkToken),
        data: {},
      }),
      request.post(`${API_URL}/api/deploy-links/${deployLinkPublicId}/launched`, {
        headers: linkHeaders(deployLinkToken),
        data: {},
      }),
    ]);
    expect(first.ok()).toBeTruthy();
    expect(second.ok()).toBeTruthy();

    const events = await request.get(`${API_URL}/api/deployments/${deploymentId}/events`);
    expect(events.ok()).toBeTruthy();
    const eventBody = (await events.json()) as { events: Array<{ eventType: string }> };
    expect(
      eventBody.events.filter((event) => event.eventType === 'deploy_link.launched'),
    ).toHaveLength(1);
  });
});
