/**
 * CONFIG_UPDATE settlement, end to end in simulation. A configuration save
 * on a running deployment becomes a CONFIG_UPDATE (the queue-less API runs
 * the fan-out inline), and the real relay executor reports success only
 * after the service rollout completes:
 *
 *   @scenario:config-update-failure — the circuit breaker rolls the first
 *   configuration rollout back: the job fails, the previous revision keeps
 *   serving, the lifecycle state and the release pointer do not move, and
 *   the failure is surfaced. The next save rolls out and succeeds.
 */

import type { APIRequestContext } from '@playwright/test';

import { API_URL, buildApi, expect, test, waitForInstallAutoDeploy } from './simulation/fixtures.js';

interface DeploymentResponse {
  state: string;
  applicationId: string;
  customerId: string;
  currentReleaseId: string | null;
  deploymentStatus: { failure: { code: string | null } | null };
  jobs: Array<{ id: string; type: string; state: string; result: { error?: string } | null }>;
}

async function getDeployment(request: APIRequestContext, deploymentId: string): Promise<DeploymentResponse> {
  const response = await request.get(`${API_URL}/api/deployments/${deploymentId}`);
  if (!response.ok()) throw new Error(`GET /api/deployments/${deploymentId} -> ${response.status()}`);
  return (await response.json()) as DeploymentResponse;
}

async function saveLogLevel(request: APIRequestContext, deployment: DeploymentResponse, value: string): Promise<void> {
  const response = await request.put(`${API_URL}/api/applications/${deployment.applicationId}/config`, {
    data: { customerId: deployment.customerId, entries: [{ key: 'LOG_LEVEL', value, isSecret: false }] },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

/** The next CONFIG_UPDATE (not in `seen`) once it has settled. */
async function nextSettledConfigUpdate(request: APIRequestContext, deploymentId: string, seen: Set<string>) {
  let job: DeploymentResponse['jobs'][number] | undefined;
  await expect
    .poll(
      async () => {
        job = (await getDeployment(request, deploymentId)).jobs.find(
          (entry) => entry.type === 'CONFIG_UPDATE' && !seen.has(entry.id) && SETTLED.has(entry.state),
        );
        return job?.state ?? null;
      },
      { timeout: 30_000, message: 'waiting for the configuration update to settle' },
    )
    .not.toBeNull();
  seen.add(job!.id);
  return job!;
}

const SETTLED = new Set(['SUCCEEDED', 'FAILED']);

test.describe('configuration update settlement', () => {
  test.use({ deployzScenario: 'config-update-failure' });

  test('@scenario:config-update-failure a rolled-back configuration fails while the previous revision serves, then a retry succeeds', async ({
    request,
    deployzInstall,
  }) => {
    test.setTimeout(120_000);
    const { deploymentId, relay } = deployzInstall;
    await expect
      .poll(async () => (await getDeployment(request, deploymentId)).state, { timeout: 30_000 })
      .toBe('HEALTHY');
    await waitForInstallAutoDeploy(buildApi(request), deploymentId);
    const before = await getDeployment(request, deploymentId);
    const seen = new Set(before.jobs.filter((job) => job.type === 'CONFIG_UPDATE').map((job) => job.id));
    const servingBefore = relay!.account.serviceSnapshots();

    await saveLogLevel(request, before, 'debug');
    const failed = await nextSettledConfigUpdate(request, deploymentId, seen);
    expect(failed.state).toBe('FAILED');
    expect(String(failed.result?.error)).toContain('were not restored');

    const after = await getDeployment(request, deploymentId);
    expect(after.state).toBe(before.state);
    expect(after.currentReleaseId).toBe(before.currentReleaseId);
    expect(after.deploymentStatus.failure?.code).toBe('ECS_DEPLOYMENT_FAILED');
    // The previous revision keeps serving the same release.
    expect(relay!.account.operationLog.some((entry) => entry.startsWith('config-rollback:'))).toBe(true);
    expect(relay!.account.serviceSnapshots()).toEqual(servingBefore);

    await saveLogLevel(request, after, 'warn');
    const recovered = await nextSettledConfigUpdate(request, deploymentId, seen);
    expect(recovered.state).toBe('SUCCEEDED');
    expect(relay!.account.operationLog.some((entry) => entry.startsWith('config:'))).toBe(true);
    expect((await getDeployment(request, deploymentId)).deploymentStatus.failure).toBeNull();
  });
});
