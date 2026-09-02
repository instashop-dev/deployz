/**
 * Resilience-boundary scenarios (deployment-resilience plan, Phase 16):
 * duplicate requests, transient AWS errors and a relay dying mid-DESTROY —
 * each driven through the REAL vendor API routes and the REAL relay
 * executors over the simulated account, like every other scenario spec.
 *
 * Reconciliation-watchdog behaviour (stale RUNNING jobs re-offered/parked)
 * lives in packages/cdk/test/worker.test.ts: the sweeps run in the worker
 * Lambda, which this harness deliberately does not boot — the sweep
 * functions are exercised directly there over the same PGlite migrations.
 */

import type { APIRequestContext } from '@playwright/test';

import { API_URL, expect, test } from './simulation/fixtures.js';

interface DeploymentResponse {
  state: string;
  applicationId: string;
  currentReleaseId: string | null;
}

interface EventRow {
  eventType: string;
}

async function getEvents(request: APIRequestContext, deploymentId: string): Promise<EventRow[]> {
  const response = await request.get(`${API_URL}/api/deployments/${deploymentId}/events`);
  if (!response.ok()) {
    throw new Error(`GET /api/deployments/${deploymentId}/events -> ${response.status()}`);
  }
  const body = (await response.json()) as { events: EventRow[] };
  return body.events;
}

async function createRelease(
  request: APIRequestContext,
  applicationId: string,
  version: string,
): Promise<string> {
  const response = await request.post(`${API_URL}/api/applications/${applicationId}/releases`, {
    data: { version, gitSha: `sha-${version}` },
  });
  if (!response.ok()) {
    throw new Error(`create release ${version} failed: ${response.status()} ${await response.text()}`);
  }
  return ((await response.json()) as { id: string }).id;
}

test.describe.configure({ mode: 'parallel' });

test.describe('duplicate-request', () => {
  test.use({ deployzScenario: 'happy-path' });

  test('@scenario:duplicate-request concurrent duplicate deploys collapse to one job; a different release is refused busy', async ({
    request,
    deployzInstall,
  }) => {
    test.setTimeout(30_000);
    const { deploymentId, api } = deployzInstall;

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for install to reach HEALTHY',
      })
      .toBe('HEALTHY');
    const installed = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;

    const releaseId = await createRelease(request, installed.applicationId, '1.0.0');

    // Two requests for the SAME release racing each other: both are answered
    // (202 created / 200 replayed), both name the same job, and exactly one
    // deploy.requested event exists — one logical operation, one execution.
    const [first, second] = await Promise.all([
      request.post(`${API_URL}/api/deployments/${deploymentId}/deploy`, { data: { releaseId } }),
      request.post(`${API_URL}/api/deployments/${deploymentId}/deploy`, { data: { releaseId } }),
    ]);
    expect([first.status(), second.status()].sort()).toEqual([200, 202]);
    const firstJob = ((await first.json()) as { jobId: string }).jobId;
    const secondJob = ((await second.json()) as { jobId: string }).jobId;
    expect(firstJob).toBe(secondJob);

    // A DIFFERENT release while the first operation is active: refused with
    // the busy gate, never a second concurrent mutation.
    const otherReleaseId = await createRelease(request, installed.applicationId, '1.1.0');
    const busy = await request.post(`${API_URL}/api/deployments/${deploymentId}/deploy`, {
      data: { releaseId: otherReleaseId },
    });
    expect(busy.status()).toBe(409);
    expect(((await busy.json()) as { error: { code: string } }).error.code).toBe('DEPLOYMENT_BUSY');

    // The one deploy settles normally.
    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for the deploy to settle',
      })
      .toBe('HEALTHY');
    const events = await getEvents(request, deploymentId);
    expect(events.filter((e) => e.eventType === 'deploy.requested')).toHaveLength(1);
    expect(events.filter((e) => e.eventType === 'deploy.completed')).toHaveLength(1);
  });
});

test.describe('transient-aws', () => {
  test.use({ deployzScenario: 'transient-aws' });

  test('@scenario:transient-aws an install rides out transient unreadable DescribeStacks polls', async ({
    deployzInstall,
  }) => {
    test.setTimeout(30_000);
    const { deploymentId, api } = deployzInstall;

    // The first two post-create describes answer as unreadable (throttled) —
    // the executor rides them out and the install still lands HEALTHY.
    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for the install to ride out the transient errors and reach HEALTHY',
      })
      .toBe('HEALTHY');
  });
});

test.describe('relay-death-destroy', () => {
  test.use({
    deployzScenario: 'retained-resources',
    deployzRelayOptions: { dieDuringDestroy: true },
  });

  test('@scenario:relay-death-destroy a relay dying mid-DESTROY leaves an honest DELETING, never a false DELETED or FAILED', async ({
    request,
    deployzInstall,
  }) => {
    test.setTimeout(30_000);
    const { deploymentId, api } = deployzInstall;

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for install to reach HEALTHY',
      })
      .toBe('HEALTHY');

    const destroy = await request.post(`${API_URL}/api/deployments/${deploymentId}/destroy`, {
      data: {},
    });
    expect(destroy.status()).toBe(202);

    // The teardown genuinely starts in the account, but the invocation
    // dies mid-command — no progress, no result, no heartbeat, ever.
    await expect
      .poll(
        async () => {
          const events = await getEvents(request, deploymentId);
          return events.some((e) => e.eventType === 'destroy.requested');
        },
        { timeout: 15_000, message: 'waiting for the destroy to be requested' },
      )
      .toBe(true);

    // Give the harness enough real time that a false settlement WOULD have
    // landed (the whole retained-resources destroy timeline spans well under
    // this), then pin the honest state: still DELETING — the watchdog never
    // times a DESTROY out, and nothing fabricates a completion the relay
    // never reported. Force-complete (gated on a 60-minute staleness window
    // production-side) is the vendor's escape hatch beyond this point.
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    const events = await getEvents(request, deploymentId);
    expect(events.some((e) => e.eventType === 'destroy.completed')).toBe(false);
    expect(events.some((e) => e.eventType === 'destroy.failed')).toBe(false);

    const after = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(after.state).toBe('DELETING');
  });
});
