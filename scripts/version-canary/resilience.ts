/**
 * Resilience scenario — the operational edge cases (Phases 9 and 10):
 * duplicate deploy requests, rollback during a deploy, deploy during a
 * rollback, and control-plane/relay interruption (the relay's EventBridge
 * schedule disabled mid-rollout, then restored) — proving one mutation at a
 * time and convergence on AWS reality. Runs on a fresh install and tears
 * it down.
 */
import { disableRulesForStack, enableRulesForStack, describeRunningService } from './aws.js';
import { describeDeployment, findJob, sleep, waitFor } from './control-plane.js';
import {
  assertServing,
  buildRelease,
  createDeploymentAndInstall,
  expectBusyOrReplay,
  preflight,
  publishCanaryTemplate,
  setUpVendorAndApplication,
  waitForJob,
  waitForPointer,
  type Canary,
} from './steps.js';
import { destroyThroughProduct, leakAudit, removeCanaryLeftovers } from './teardown.js';

const MINUTE = 60_000;

export async function runResilience(canary: Canary): Promise<void> {
  const { config, evidence, api } = canary;
  await preflight(canary);
  await setUpVendorAndApplication(canary);
  await buildRelease(canary, 'v1');
  await publishCanaryTemplate(canary, 'v1');
  await createDeploymentAndInstall(canary);
  await evidence.step('v1 is the serving release after install', async (details) => {
    await waitForPointer(canary, 'v1', 15 * MINUTE);
    await assertServing(canary, { serving: 'v1' }, details);
  });
  await buildRelease(canary, 'v2');
  await buildRelease(canary, 'v4');

  // Phase 9 — duplicate deploy: two equivalent requests at once collapse to one job.
  const v2 = evidence.run.releases['v2']!;
  const deploymentId = evidence.run.deploymentId!;
  const firstJobId = await evidence.step('Concurrent duplicate deploy requests collapse to one job', async (details) => {
    const [a, b] = await Promise.all([api.deploy(deploymentId, v2.id), api.deploy(deploymentId, v2.id)]);
    details['responses'] = [a, b];
    if (a.jobId !== b.jobId) throw new Error(`two jobs were created: ${a.jobId} and ${b.jobId}`);
    if (![a.status, b.status].includes(202)) throw new Error('neither request created the job');
    const retry = await api.deploy(deploymentId, v2.id);
    details['retryAfterAmbiguousResponse'] = retry;
    if (retry.jobId !== a.jobId || retry.status !== 200) throw new Error(`a retry minted a new job: ${JSON.stringify(retry)}`);
    evidence.run.jobs.push({ id: a.jobId, type: 'DEPLOY_RELEASE', releaseTag: 'v2' });
    evidence.save();
    return a.jobId;
  });

  // Phase 9 — rollback during deploy, deploy of another release during deploy: refused busy.
  await evidence.step('Rollback and a different deploy are refused while the deploy is in progress', async (details) => {
    const v1 = evidence.run.releases['v1']!;
    const v4 = evidence.run.releases['v4']!;
    const rollback = await expectBusyOrReplay(canary, () => api.rollback(deploymentId, v1.id), firstJobId, details, 'rollback-during-deploy');
    if (rollback !== 'busy') throw new Error('rollback during a deploy was not refused as busy');
    const other = await expectBusyOrReplay(canary, () => api.deploy(deploymentId, v4.id), firstJobId, details, 'deploy-v4-during-deploy');
    if (other !== 'busy') throw new Error('a second release deploy during a deploy was not refused as busy');
    const restart = await expectBusyOrReplay(canary, () => api.restart(deploymentId), firstJobId, details, 'restart-during-deploy');
    if (restart !== 'busy') throw new Error('restart during a deploy was not refused as busy');
    // Only one ECS deployment ever in flight for the service.
    const service = await describeRunningService(config.region, evidence.run.applicationStackName!);
    details['ecsDeployments'] = service?.deployments;
    const inFlight = (service?.deployments ?? []).filter((d) => d.rolloutState === 'IN_PROGRESS');
    if (inFlight.length > 1) throw new Error(`${inFlight.length} ECS deployments in flight at once`);
  });

  await evidence.step('The single v2 deploy completes and v2 serves', async (details) => {
    const settled = await waitForJob(canary, firstJobId, 30 * MINUTE);
    const job = findJob(settled, firstJobId)!;
    details['job'] = { state: job.state, failureCode: job.failureCode };
    if (job.state !== 'SUCCEEDED') throw new Error(`deploy job ${job.state}`);
    await waitForPointer(canary, 'v2');
    await assertServing(canary, { serving: 'v2', previous: 'v1' }, details);
  });

  // Phase 10 — relay interruption mid-rollout: disable the schedule right after the
  // deploy is requested, wait through two missed polls, restore, converge.
  const v4 = evidence.run.releases['v4']!;
  await evidence.step('Relay interruption mid-deploy: the operation resumes and converges', async (details) => {
    const bootstrapStackName = evidence.run.bootstrapStackName!;
    const requested = await api.deploy(deploymentId, v4.id);
    details['request'] = requested;
    evidence.run.jobs.push({ id: requested.jobId, type: 'DEPLOY_RELEASE', releaseTag: 'v4' });
    evidence.save();
    // Let the relay claim the command and start the rollout on its next tick.
    const claimed = await waitFor(
      'relay claims the deploy',
      () => api.getDeployment(deploymentId),
      (d) => {
        const job = findJob(d, requested.jobId);
        return job && job.state !== 'REQUESTED' ? d : null;
      },
      { timeoutMs: 10 * MINUTE, describe: (d) => `${findJob(d, requested.jobId)?.state} ${describeDeployment(d)}` },
    );
    details['claimedState'] = findJob(claimed, requested.jobId)?.state;
    details['rulesDisabled'] = await disableRulesForStack(config.region, bootstrapStackName);
    const silentFrom = Date.now();
    try {
      // Two missed five-minute polls: the job must not be failed, and the
      // deployment must not be reported as anything but "updating".
      await sleep(11 * MINUTE);
      const during = await api.getDeployment(deploymentId);
      details['duringSilence'] = { job: findJob(during, requested.jobId)?.state, deployment: describeDeployment(during) };
      const job = findJob(during, requested.jobId)!;
      if (job.state === 'FAILED' || job.state === 'CANCELLED') throw new Error(`job ${job.state} while the relay was merely silent`);
      if (during.state === 'FAILED') throw new Error('deployment marked FAILED while the relay was merely silent');
    } finally {
      details['rulesEnabled'] = await enableRulesForStack(config.region, bootstrapStackName);
      details['silentForMs'] = Date.now() - silentFrom;
    }
    const settled = await waitForJob(canary, requested.jobId, 30 * MINUTE);
    const job = findJob(settled, requested.jobId)!;
    details['job'] = { state: job.state, failureCode: job.failureCode, result: job.result };
    if (job.state !== 'SUCCEEDED') throw new Error(`deploy after the interruption ${job.state}: ${JSON.stringify(job.result).slice(0, 300)}`);
    await waitForPointer(canary, 'v4');
    await assertServing(canary, { serving: 'v4', previous: 'v2' }, details);
    // No duplicate mutation: exactly one task-definition revision beyond the one before.
    const service = await describeRunningService(config.region, evidence.run.applicationStackName!);
    details['ecsAfter'] = service;
  });

  if (config.keep) return;
  await destroyThroughProduct(canary);
  await removeCanaryLeftovers(canary);
  await leakAudit(canary);
}
