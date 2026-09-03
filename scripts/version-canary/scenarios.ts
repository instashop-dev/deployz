/**
 * Scenarios — compositions of steps.ts building blocks.
 *
 * `core` is the golden path the MVP release gate runs three times in a row:
 *
 *   v1 install → seed data → v2 deploy → rollback to v1 → v2 again →
 *   broken v3 (fails, v2 keeps serving) → recovery (rollback to v1 as the
 *   real mutation; re-deploying the running v2 replays idempotently) →
 *   v4 deploy → destroy → purge → leftovers → leak audit
 *
 * Releases are built just in time: INSTALL success auto-deploys the NEWEST
 * READY release, so building v4 before the install would skip the ladder.
 */
import {
  assertMarkers,
  assertSameInfrastructure,
  assertServing,
  buildRelease,
  createDeploymentAndInstall,
  deployAndVerify,
  deployExpectingFailure,
  preflight,
  publishCanaryTemplate,
  rollbackAndVerify,
  seedMarker,
  setUpVendorAndApplication,
  snapshotInfrastructure,
  waitForJob,
  waitForPointer,
  type Canary,
} from './steps.js';
import { describeRunningService } from './aws.js';
import { destroyThroughProduct, leakAudit, removeCanaryLeftovers } from './teardown.js';

export async function runCore(canary: Canary): Promise<void> {
  const { evidence, api } = canary;
  await preflight(canary);
  await setUpVendorAndApplication(canary);

  // Phase 4 — v1.
  await buildRelease(canary, 'v1');
  await publishCanaryTemplate(canary, 'v1');
  await createDeploymentAndInstall(canary);
  await evidence.step('v1 is the serving release after install (auto-deploy + digest reconciliation)', async (details) => {
    await waitForPointer(canary, 'v1', 15 * 60_000);
    await assertServing(canary, { serving: 'v1', deploymentState: ['HEALTHY', 'UPDATE_AVAILABLE'] }, details);
  });

  // Phase 5 — persistence baseline + v2.
  await seedMarker(canary, 'CANARY_DATA');
  const baseline = await snapshotInfrastructure(canary);
  await buildRelease(canary, 'v2');
  await deployAndVerify(canary, 'v2', 'v1');
  await evidence.step('Persistent data and infrastructure survive the v2 update', async (details) => {
    await assertMarkers(canary, details);
    const after = await snapshotInfrastructure(canary);
    details['infrastructure'] = { baseline, after };
    assertSameInfrastructure(baseline, after);
  });

  // Phase 6 — rollback to v1.
  await rollbackAndVerify(canary, 'v1', 'v2');
  await evidence.step('Persistent data and infrastructure survive the rollback', async (details) => {
    await assertMarkers(canary, details);
    const after = await snapshotInfrastructure(canary);
    details['infrastructure'] = { baseline, after };
    assertSameInfrastructure(baseline, after);
  });

  // Back to a known-good newer release before the failure test.
  await deployAndVerify(canary, 'v2', 'v1');

  // Phase 7 — broken v3 is isolated.
  await buildRelease(canary, 'v3-bad-health');
  await deployExpectingFailure(canary, 'v3-bad-health', 'v2', 'v1');
  await evidence.step('Persistent data survives the failed release', async (details) => {
    await assertMarkers(canary, details);
  });

  // Phase 8 — recovery, then a normal release after the failure.
  await evidence.step('Re-deploying the running release is a fresh attempt that changes nothing in ECS', async (details) => {
    const v2 = evidence.run.releases['v2']!;
    const before = await describeRunningService(canary.config.region, evidence.run.applicationStackName!);
    const requested = await api.deploy(evidence.run.deploymentId!, v2.id);
    details['request'] = requested;
    if (requested.status !== 202) throw new Error(`re-deploy of the running release -> ${requested.status}, expected a fresh attempt (202)`);
    evidence.run.jobs.push({ id: requested.jobId, type: 'DEPLOY_RELEASE', releaseTag: 'v2' });
    evidence.save();
    const settled = await waitForJob(canary, requested.jobId, 20 * 60_000);
    const job = settled.jobs.find((j) => j.id === requested.jobId)!;
    details['job'] = { state: job.state, failureCode: job.failureCode, result: job.result };
    if (job.state !== 'SUCCEEDED') throw new Error(`re-deploy job ${job.state}`);
    const output = (job.result as { output?: { alreadyRunning?: boolean } } | null)?.output;
    if (output?.alreadyRunning !== true) throw new Error('the relay mutated ECS for a release that was already running');
    const after = await describeRunningService(canary.config.region, evidence.run.applicationStackName!);
    details['taskDefinition'] = { before: before?.taskDefinition, after: after?.taskDefinition };
    if (before?.taskDefinition !== after?.taskDefinition) throw new Error('a new task-definition revision was registered for an already-running release');
    await assertServing(canary, { serving: 'v2', previous: 'v1' }, details);
  });
  await rollbackAndVerify(canary, 'v1', 'v2');
  await buildRelease(canary, 'v4');
  await deployAndVerify(canary, 'v4', 'v1');
  await evidence.step('History keeps every attempt, including the failed v3', async (details) => {
    const detail = await api.getDeployment(evidence.run.deploymentId!);
    const v3 = evidence.run.releases['v3-bad-health']!;
    const failed = detail.jobs.filter((j) => j.type === 'DEPLOY_RELEASE' && j.payload?.['releaseId'] === v3.id);
    details['v3Jobs'] = failed.map((j) => ({ id: j.id, state: j.state, failureCode: j.failureCode }));
    if (!failed.some((j) => j.state === 'FAILED')) throw new Error('failed v3 attempt is no longer in the history');
    await assertMarkers(canary, details);
  });

  // Phase 14 — teardown + audit.
  if (canary.config.keep) {
    console.log('\n--keep set: leaving the environment in place. Run cleanup --run-id later.');
    return;
  }
  await destroyThroughProduct(canary);
  await removeCanaryLeftovers(canary);
  await leakAudit(canary);
}
