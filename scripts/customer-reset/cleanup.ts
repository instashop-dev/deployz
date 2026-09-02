/**
 * `pnpm admin:customer-cleanup execute --confirm FULL-CUSTOMER-RESET`
 *
 * Wipes every CUSTOMER deployment (AWS resources + DB rows) while preserving
 * control-plane data (auth, organizations, customers, subscriptions, github
 * installations, event_logs). Requires the literal `--confirm
 * FULL-CUSTOMER-RESET` token — there is no bypass flag.
 *
 * Per deployment, in order:
 *   1. Freeze the relay's EventBridge poll rule (best-effort, skippable).
 *   2. Delete the application stack (remediating DELETE_FAILED via the
 *      RDS/cache blockers pattern from packages/relay/src/recover.ts).
 *   3. Sweep tag-verified orphans (RDS/ElastiCache/S3) the stack delete may
 *      have left behind.
 *   4. Delete the bootstrap stack LAST — it is the relay's own home.
 * Deployments are processed with bounded concurrency (a pool of 3). Once
 * every deployment has been attempted, the DB rows are purged in one pass
 * (db.ts#purgeCustomerData) — AWS cleanup is best-effort per deployment, but
 * the DB purge is unconditional, matching what "execute" promises: a clean
 * customer slate.
 */

import { applicationStackNameForInstallation } from '@deployz/contracts';

import {
  deleteOrphansForInstallation,
  deleteStackAndWait,
  freezeRelayEventBridgeRules,
  remediateDeleteFailedStack,
  runPooled,
  type CustomerStack,
} from './aws.js';
import { connectDb, purgeCustomerData } from './db.js';
import { buildManifest, type Manifest, type ManifestDeployment } from './inventory.js';
import {
  assertNoOverlap,
  buildProtectedInventory,
  isOwnedByInstallation,
  requireConfirmToken,
  type DeletionCandidate,
} from './safety.js';

const CONCURRENCY = 3;

function findOwnedStack(
  stacks: readonly CustomerStack[],
  kind: 'application' | 'bootstrap',
  expectedStackName: string,
  installationId: string,
): CustomerStack | undefined {
  return stacks.find(
    (stack) =>
      stack.kind === kind &&
      stack.stackName === expectedStackName &&
      isOwnedByInstallation({ stackMatchesManifest: true, taggedInstallationId: stack.installationTag }, installationId),
  );
}

async function deleteOwnedStack(region: string, stack: CustomerStack): Promise<void> {
  if (stack.stackStatus === 'DELETE_FAILED') {
    await remediateDeleteFailedStack(region, stack.stackName);
  } else if (stack.stackStatus !== 'DELETE_IN_PROGRESS') {
    await deleteStackAndWait(region, stack.stackName);
  }
}

async function cleanUpDeployment(manifest: Manifest, deployment: ManifestDeployment): Promise<void> {
  const { installationId, region } = deployment;
  if (!installationId) {
    console.warn(`[customer-reset] deployment ${deployment.id} has no installationId — skipping AWS cleanup`);
    return;
  }

  const stacks = manifest.stacksByRegion[region] ?? [];

  if (deployment.bootstrapStackName) {
    await freezeRelayEventBridgeRules(region, deployment.bootstrapStackName);
  }

  const applicationStackName = deployment.applicationStackName ?? applicationStackNameForInstallation(installationId);
  const applicationStack = findOwnedStack(stacks, 'application', applicationStackName, installationId);
  if (applicationStack) {
    console.log(`[customer-reset] deleting application stack ${applicationStack.stackName} (${region})`);
    await deleteOwnedStack(region, applicationStack);
  }

  console.log(`[customer-reset] sweeping tag-verified orphans for installation ${installationId} (${region})`);
  const swept = await deleteOrphansForInstallation(installationId, region);
  if (swept.rdsInstancesDeleted.length || swept.replicationGroupsDeleted.length || swept.bucketsDeleted.length) {
    console.log(
      `[customer-reset]   rds=${swept.rdsInstancesDeleted.length} cache=${swept.replicationGroupsDeleted.length} buckets=${swept.bucketsDeleted.length}`,
    );
  }

  if (deployment.bootstrapStackName) {
    const bootstrapStack = findOwnedStack(stacks, 'bootstrap', deployment.bootstrapStackName, installationId);
    if (bootstrapStack) {
      console.log(`[customer-reset] deleting bootstrap stack ${bootstrapStack.stackName} (${region})`);
      await deleteOwnedStack(region, bootstrapStack);
    }
  }
}

export async function runCleanup(argv: readonly string[]): Promise<void> {
  requireConfirmToken(argv);

  const manifest = await buildManifest();
  const protectedInventory = buildProtectedInventory();
  const candidates: DeletionCandidate[] = Object.values(manifest.stacksByRegion)
    .flat()
    .map((stack) => ({ kind: 'stack', name: stack.stackName }));
  assertNoOverlap(candidates, protectedInventory);

  console.log(`[customer-reset] cleaning up ${manifest.deployments.length} deployment(s) across ${manifest.regions.length} region(s)`);

  await runPooled(manifest.deployments, CONCURRENCY, async (deployment) => {
    try {
      await cleanUpDeployment(manifest, deployment);
    } catch (err) {
      console.error(`[customer-reset] AWS cleanup failed for deployment ${deployment.id}: ${String(err)}`);
    }
  });

  console.log('[customer-reset] purging customer rows from the control-plane database');
  const { db, close } = connectDb();
  try {
    await purgeCustomerData(db);
  } finally {
    await close();
  }

  console.log('[customer-reset] done — run `pnpm admin:customer-cleanup verify` to confirm nothing remains');
}
