/**
 * `pnpm admin:customer-cleanup inventory`
 *
 * Builds the manifest `cleanup.ts` and `verify.ts` both work from: the
 * control-plane DB's customer rows, plus a CloudFormation scan of every
 * region those rows mention for stacks matching the Deployz naming
 * convention and carrying the `deployz:installation` tag. Runs the same
 * `assertNoOverlap` safety check the execute path runs, so a manifest that
 * would collide with the protected control-plane inventory is refused
 * before anything is written. Writes `customer-cleanup-manifest.json` and
 * `customer-cleanup-protected.json` to the current working directory and
 * prints a summary — this step never deletes anything.
 */

import { writeFileSync } from 'node:fs';
import { applicationStackNameForInstallation } from '@deployz/contracts';

import { listCustomerStacks, type CustomerStack } from './aws.js';
import { connectDb, readInventory } from './db.js';
import { assertNoOverlap, buildProtectedInventory, type DeletionCandidate, type ProtectedInventory } from './safety.js';

export const MANIFEST_PATH = 'customer-cleanup-manifest.json';
export const PROTECTED_PATH = 'customer-cleanup-protected.json';

export interface ManifestDeployment {
  readonly id: string;
  readonly installationId: string | null;
  readonly bootstrapStackName: string | null;
  /** Derived via `applicationStackNameForInstallation` — null when installationId is unset. */
  readonly applicationStackName: string | null;
  readonly region: string;
  readonly awsAccountId: string | null;
  readonly state: string;
}

export type ManifestStack = CustomerStack;

export interface Manifest {
  readonly generatedAt: string;
  readonly applicationCount: number;
  readonly applicationIds: readonly string[];
  readonly deployments: readonly ManifestDeployment[];
  readonly customDomainCount: number;
  readonly deploymentResourceCount: number;
  readonly releaseCount: number;
  readonly jobCount: number;
  readonly usageRecordCount: number;
  readonly applicationConfigCount: number;
  readonly regions: readonly string[];
  readonly stacksByRegion: Readonly<Record<string, readonly ManifestStack[]>>;
}

/** Reads the DB inventory and scans every region it mentions for matching AWS stacks. */
export async function buildManifest(): Promise<Manifest> {
  const { db, close } = connectDb();
  try {
    const inventory = await readInventory(db);
    const regions = Array.from(new Set(inventory.deployments.map((d) => d.region))).filter(
      (region): region is string => Boolean(region),
    );

    const stacksByRegion: Record<string, ManifestStack[]> = {};
    for (const region of regions) {
      stacksByRegion[region] = await listCustomerStacks(region);
    }

    const deployments: ManifestDeployment[] = inventory.deployments.map((deployment) => ({
      ...deployment,
      applicationStackName: deployment.installationId
        ? applicationStackNameForInstallation(deployment.installationId)
        : null,
    }));

    return {
      generatedAt: new Date().toISOString(),
      applicationCount: inventory.applications.length,
      applicationIds: inventory.applications.map((application) => application.id),
      deployments,
      customDomainCount: inventory.customDomains.length,
      deploymentResourceCount: inventory.deploymentResources.length,
      releaseCount: inventory.releaseCount,
      jobCount: inventory.jobCount,
      usageRecordCount: inventory.usageRecordCount,
      applicationConfigCount: inventory.applicationConfigCount,
      regions,
      stacksByRegion,
    };
  } finally {
    await close();
  }
}

function serializeProtected(protectedInventory: ProtectedInventory) {
  return {
    stackNames: Array.from(protectedInventory.stackNames),
    bucketNamePatterns: protectedInventory.bucketNamePatterns.map((pattern) => pattern.source),
    ecrRepositoryNames: Array.from(protectedInventory.ecrRepositoryNames),
  };
}

export async function runInventory(): Promise<void> {
  const manifest = await buildManifest();
  const protectedInventory = buildProtectedInventory();

  const allStacks = Object.values(manifest.stacksByRegion).flat();
  const candidates: DeletionCandidate[] = allStacks.map((stack) => ({
    kind: 'stack',
    name: stack.stackName,
  }));
  assertNoOverlap(candidates, protectedInventory);

  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  writeFileSync(PROTECTED_PATH, JSON.stringify(serializeProtected(protectedInventory), null, 2));

  console.log('--- customer-cleanup inventory ---');
  console.log(`applications:         ${manifest.applicationCount}`);
  console.log(`deployments:          ${manifest.deployments.length}`);
  console.log(`custom_domains:       ${manifest.customDomainCount}`);
  console.log(`deployment_resources: ${manifest.deploymentResourceCount}`);
  console.log(`releases:             ${manifest.releaseCount}`);
  console.log(`deployment_jobs:      ${manifest.jobCount}`);
  console.log(`usage_records:        ${manifest.usageRecordCount}`);
  console.log(`application_configs:  ${manifest.applicationConfigCount}`);
  console.log(`regions scanned:      ${manifest.regions.join(', ') || '(none)'}`);
  console.log(`AWS stacks matched:   ${allStacks.length}`);
  console.log(`Wrote ${MANIFEST_PATH} and ${PROTECTED_PATH}`);
}
