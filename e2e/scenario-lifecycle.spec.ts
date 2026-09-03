/**
 * Phase 1 D2 simulated-infrastructure E2E: lifecycle scenarios (update,
 * rollback, delete) — proves that the REAL relay deploy/rollback/destroy
 * executors (packages/relay/src/deploy.ts, destroy.ts), driven through the
 * REAL vendor API routes (POST releases, POST /deployments/:id/deploy,
 * /rollback, /destroy), produce the honest production behaviour documented
 * in docs/testing/discovery/deployment-lifecycle.md §6 — including where
 * that behaviour is a plain FAILED rather than a false success.
 *
 * Every test installs to HEALTHY first (happy-path-style timeline — see
 * e2e/simulation/scenarios/*.ts, each of which spreads `happyPath` and adds
 * only the lifecycle-specific knobs), then drives the lifecycle entirely
 * through the real HTTP API. No UI yet — that is a later phase. Test titles
 * carry `@scenario:<id>` matching the other scenario specs' convention.
 */

import type { APIRequestContext } from '@playwright/test';

import { API_URL, expect, test } from './simulation/fixtures.js';

interface DeploymentResponse {
  state: string;
  currentReleaseId: string | null;
  previousReleaseId: string | null;
  applicationId: string;
  deploymentStatus: {
    stage: string;
    failure: { code: string | null; awsStatus: string | null } | null;
  };
}

interface ReleaseResponse {
  id: string;
  version: string;
}

interface InfrastructureResponse {
  summary: { technicalResourceCount: number };
  components: Array<{ kind: string; status: string }>;
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
  const release = (await response.json()) as ReleaseResponse;
  return release.id;
}

async function deployRelease(request: APIRequestContext, deploymentId: string, releaseId: string) {
  return request.post(`${API_URL}/api/deployments/${deploymentId}/deploy`, { data: { releaseId } });
}

async function rollbackToRelease(request: APIRequestContext, deploymentId: string, releaseId: string) {
  return request.post(`${API_URL}/api/deployments/${deploymentId}/rollback`, { data: { releaseId } });
}

async function destroyDeployment(request: APIRequestContext, deploymentId: string) {
  return request.post(`${API_URL}/api/deployments/${deploymentId}/destroy`, { data: {} });
}

test.describe.configure({ mode: 'parallel' });

test.describe('update-failure', () => {
  test.use({ deployzScenario: 'update-failure' });

  test('@scenario:update-failure a failed rollout never advances the release pointer', async ({
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
    const applicationId = installed.applicationId;

    // v1 deploys and succeeds — a previous good release now exists.
    const v1ReleaseId = await createRelease(request, applicationId, '1.0.0');
    const deployV1 = await deployRelease(request, deploymentId, v1ReleaseId);
    expect(deployV1.status()).toBe(202);
    // Poll the release POINTER, not the state: this deployment is already
    // HEALTHY when the deploy starts, so polling `state` can return on its
    // very first read and assert the pointer before the deploy has settled.
    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).currentReleaseId, {
        timeout: 15_000,
        message: 'waiting for the v1 deploy to advance the release pointer',
      })
      .toBe(v1ReleaseId);
    const afterV1 = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(afterV1.state).toBe('HEALTHY');

    // v2's release creation flips this (already-HEALTHY) deployment to
    // UPDATE_AVAILABLE — the same synchronous write every HEALTHY deployment
    // of the application gets (server.ts's releases route).
    const v2ReleaseId = await createRelease(request, applicationId, '2.0.0');
    const afterV2Created = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(afterV2Created.state).toBe('UPDATE_AVAILABLE');

    // v2 deploys; the ECS deployment circuit breaker trips.
    const deployV2 = await deployRelease(request, deploymentId, v2ReleaseId);
    expect(deployV2.status()).toBe(202);
    const afterDeployV2Requested = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(afterDeployV2Requested.state).toBe('UPDATING');

    // A failed update does NOT mark the whole deployment FAILED: the circuit
    // breaker restored v1, which is still serving. The deployment returns to
    // UPDATE_AVAILABLE (v2 exists, READY, and is not running) and the FAILED
    // job carries the failure.
    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for the v2 rollout to fail',
      })
      .toBe('UPDATE_AVAILABLE');

    const failed = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    // The stage stays live (READY/VERIFYING, never FAILED) while the failure
    // itself is still surfaced with its real classification.
    expect(failed.deploymentStatus.stage).not.toBe('FAILED');
    expect(failed.deploymentStatus.failure!.code).toBe('ECS_DEPLOYMENT_FAILED');
    // The release pointer never advances past the last release that actually
    // deployed successfully.
    expect(failed.currentReleaseId).toBe(v1ReleaseId);

    const events = await getEvents(request, deploymentId);
    expect(events.some((e) => e.eventType === 'deploy.failed')).toBe(true);
  });
});

test.describe('rollback-success', () => {
  test.use({ deployzScenario: 'rollback-success' });

  test('@scenario:rollback-success rollback recovers a failed update', async ({ request, deployzInstall }) => {
    test.setTimeout(30_000);
    const { deploymentId, api } = deployzInstall;

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, { timeout: 15_000 })
      .toBe('HEALTHY');
    const installed = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    const applicationId = installed.applicationId;

    const v1ReleaseId = await createRelease(request, applicationId, '1.0.0');
    await deployRelease(request, deploymentId, v1ReleaseId);
    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, { timeout: 15_000 })
      .toBe('HEALTHY');

    const v2ReleaseId = await createRelease(request, applicationId, '2.0.0');
    await deployRelease(request, deploymentId, v2ReleaseId);
    // Failed-update semantics: the deployment returns to UPDATE_AVAILABLE
    // (v1 still serving, v2 READY but not running), never FAILED.
    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for the v2 rollout to fail',
      })
      .toBe('UPDATE_AVAILABLE');

    const beforeRollback = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(beforeRollback.currentReleaseId).toBe(v1ReleaseId);

    // UPDATE_AVAILABLE is in BULK_DEPLOYABLE_STATES, so `markJobRequested`
    // writes the transient UPDATING in-flight state while the rollback runs.
    const rollbackResponse = await rollbackToRelease(request, deploymentId, v1ReleaseId);
    expect(rollbackResponse.status()).toBe(202);
    const afterRollbackRequested = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(afterRollbackRequested.state).toBe('UPDATING');

    // The ROLLBACK job's own event, not a deployment.state transition, is
    // the authoritative "it settled" signal here: the simulated ECS service
    // converges to the rolled-back digest the instant UpdateService succeeds
    // (see simulated-account.ts's `ecsDeployClient`), so a heartbeat between
    // the request and the resumer's own result tick can already report
    // HEALTHY. Polling for a state the job result writes keeps this test
    // pinned to the settlement, not the race.
    await expect
      .poll(
        async () => {
          const events = await getEvents(request, deploymentId);
          return events.some((e) => e.eventType === 'rollback.completed');
        },
        { timeout: 15_000, message: 'waiting for the rollback job to settle' },
      )
      .toBe(true);

    const afterRollback = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(afterRollback.state).toBe('HEALTHY');
    expect(afterRollback.deploymentStatus.failure).toBeNull();
    // ROLLBACK success sets currentReleaseId to the rollback's target (v1)
    // and previousReleaseId to whatever currentReleaseId was beforehand —
    // which was ALSO v1, since v2's failed deploy never advanced it. The
    // honest pointer state here is current=v1/previous=v1, not previous=v2.
    expect(afterRollback.currentReleaseId).toBe(v1ReleaseId);
    expect(afterRollback.previousReleaseId).toBe(v1ReleaseId);
  });
});

test.describe('rollback-failure', () => {
  test.use({ deployzScenario: 'rollback-failure' });

  test('@scenario:rollback-failure a failed rollback reports FAILED, never a false success', async ({
    request,
    deployzInstall,
  }) => {
    test.setTimeout(30_000);
    const { deploymentId, api } = deployzInstall;

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, { timeout: 15_000 })
      .toBe('HEALTHY');
    const installed = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    const applicationId = installed.applicationId;

    const v1ReleaseId = await createRelease(request, applicationId, '1.0.0');
    await deployRelease(request, deploymentId, v1ReleaseId);
    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, { timeout: 15_000 })
      .toBe('HEALTHY');

    const v2ReleaseId = await createRelease(request, applicationId, '2.0.0');
    await deployRelease(request, deploymentId, v2ReleaseId);
    // Failed-update semantics: UPDATE_AVAILABLE, never FAILED (v1 serving).
    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for the v2 rollout to fail',
      })
      .toBe('UPDATE_AVAILABLE');

    const beforeRollback = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;

    const rollbackResponse = await rollbackToRelease(request, deploymentId, v1ReleaseId);
    expect(rollbackResponse.status()).toBe(202);

    // The rollback job's own event, not a state transition, is what proves
    // it settled (see rollback-success's comment on the heartbeat race).
    await expect
      .poll(
        async () => {
          const events = await getEvents(request, deploymentId);
          return events.some((e) => e.eventType === 'rollback.completed' || e.eventType === 'rollback.failed');
        },
        { timeout: 15_000, message: 'waiting for the rollback job to settle' },
      )
      .toBe(true);

    // The failed rollback also leaves the deployment live: v1 never stopped
    // serving, so the honest state is UPDATE_AVAILABLE with the FAILED job
    // carrying the classification.
    const after = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(after.state).toBe('UPDATE_AVAILABLE');
    expect(after.deploymentStatus.failure!.code).toBe('ECS_DEPLOYMENT_FAILED');
    // Pointers unchanged — the rollback never succeeded, so nothing advances.
    expect(after.currentReleaseId).toBe(beforeRollback.currentReleaseId);
    expect(after.previousReleaseId).toBe(beforeRollback.previousReleaseId);

    const events = await getEvents(request, deploymentId);
    expect(events.some((e) => e.eventType === 'rollback.failed')).toBe(true);
    expect(events.some((e) => e.eventType === 'rollback.completed')).toBe(false);
  });
});

test.describe('delete-failure', () => {
  test.use({ deployzScenario: 'delete-failure' });

  test('@scenario:delete-failure an unattributable DELETE_FAILED reports FAILED, never a false clean deletion', async ({
    request,
    deployzInstall,
  }) => {
    test.setTimeout(30_000);
    const { deploymentId, api } = deployzInstall;

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, { timeout: 15_000 })
      .toBe('HEALTHY');

    const destroyResponse = await destroyDeployment(request, deploymentId);
    expect(destroyResponse.status()).toBe(202);
    const afterRequested = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(afterRequested.state).toBe('DELETING');

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for the destroy to fail',
      })
      .toBe('FAILED');

    // The honest signal this scenario pins: production does NOT claim the
    // deployment was removed. State never reaches DELETED, the job carries
    // the real failure code, and the event log records the failure.
    const after = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(after.state).not.toBe('DELETED');
    expect(after.deploymentStatus.failure!.code).toBe('STACK_DELETE_FAILED');

    const events = await getEvents(request, deploymentId);
    expect(events.some((e) => e.eventType === 'destroy.failed')).toBe(true);
    expect(events.some((e) => e.eventType === 'destroy.completed')).toBe(false);
  });
});

test.describe('retained-resources', () => {
  test.use({ deployzScenario: 'retained-resources' });

  test('@scenario:retained-resources a clean destroy honestly surfaces retained data resources', async ({
    request,
    deployzInstall,
  }) => {
    test.setTimeout(30_000);
    const { deploymentId, api } = deployzInstall;

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, { timeout: 15_000 })
      .toBe('HEALTHY');

    // The resource inventory must be persisted BEFORE destroy — it is the
    // only source GET .../infrastructure reads from after deletion (see
    // packages/db/src/deployment-resources-persist.ts: "the last complete
    // snapshot IS the final snapshot").
    await expect
      .poll(
        async () => {
          const infra = (await api.getInfrastructure(deploymentId)) as unknown as InfrastructureResponse;
          return infra.summary.technicalResourceCount;
        },
        { timeout: 15_000, message: 'waiting for the resource inventory to be persisted' },
      )
      .toBeGreaterThan(0);

    const destroyResponse = await destroyDeployment(request, deploymentId);
    expect(destroyResponse.status()).toBe(202);

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for the destroy to complete',
      })
      .toBe('DELETED');

    // aggregateInfrastructureComponents (packages/contracts) re-derives every
    // persisted resource's status from its STATIC lifecycle classification
    // once state is DELETED: retain/snapshot -> 'retained', delete ->
    // 'removed'. RDS/S3 are always classified 'retain' regardless of the
    // actual per-resource delete outcome — this is the same real production
    // behaviour a genuine DeletionPolicy-Retain resource gets.
    const infra = (await api.getInfrastructure(deploymentId)) as unknown as InfrastructureResponse;
    const database = infra.components.find((c) => c.kind === 'database');
    const storage = infra.components.find((c) => c.kind === 'storage');
    const application = infra.components.find((c) => c.kind === 'application');
    expect(database?.status).toBe('retained');
    expect(storage?.status).toBe('retained');
    expect(application?.status).toBe('removed');

    const events = await getEvents(request, deploymentId);
    expect(events.some((e) => e.eventType === 'destroy.completed')).toBe(true);
  });
});
