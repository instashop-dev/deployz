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
  expectBusyOrReplay,
  preflight,
  publishCanaryTemplate,
  rollbackAndVerify,
  seedMarker,
  setUpVendorAndApplication,
  snapshotInfrastructure,
  waitForPointer,
  type Canary,
} from './steps.js';
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
  await evidence.step('Re-deploying the running release replays idempotently (no second mutation)', async (details) => {
    const v2 = evidence.run.releases['v2']!;
    const succeededJob = [...(await api.getDeployment(evidence.run.deploymentId!)).jobs]
      .reverse()
      .find((j) => j.type === 'DEPLOY_RELEASE' && j.state === 'SUCCEEDED' && j.payload?.['releaseId'] === v2.id);
    if (!succeededJob) throw new Error('no succeeded v2 deploy job to replay');
    await expectBusyOrReplay(canary, () => api.deploy(evidence.run.deploymentId!, v2.id), succeededJob.id, details, 'redeploy-v2');
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
