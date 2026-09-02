/**
 * `pnpm admin:customer-cleanup verify`
 *
 * Re-scans AWS for surviving customer stacks/RDS/ElastiCache/S3 by
 * `deployz:installation` tag, and prints the current row counts for the
 * tables `cleanup.ts` purges. Reads the manifest `inventory.ts` wrote
 * (`customer-cleanup-manifest.json`) to know which installations/regions to
 * check — after a successful `execute` run the `deployments` table itself is
 * empty, so the DB can no longer answer that question on its own. Exits
 * non-zero if anything customer-owned still exists, in AWS or in the DB.
 */

import { readFileSync } from 'node:fs';

import { findOwnedResources, listCustomerStacks } from './aws.js';
import { connectDb } from './db.js';
import { MANIFEST_PATH, type Manifest } from './inventory.js';
import * as schema from '@deployz/db/schema';
import { sql } from 'drizzle-orm';

function loadManifest(): Manifest | undefined {
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
  } catch {
    console.warn(
      `[customer-reset] no ${MANIFEST_PATH} found — skipping the AWS re-scan and checking DB counts only. ` +
        'Run `pnpm admin:customer-cleanup inventory` before `execute` to enable it next time.',
    );
    return undefined;
  }
}

const PURGED_TABLES = [
  { name: 'applications', table: schema.applications },
  { name: 'releases', table: schema.releases },
  { name: 'deployments', table: schema.deployments },
  { name: 'deployment_jobs', table: schema.deploymentJobs },
  { name: 'deployment_resources', table: schema.deploymentResources },
  { name: 'custom_domains', table: schema.customDomains },
  { name: 'usage_records', table: schema.usageRecords },
  { name: 'application_configs', table: schema.applicationConfigs },
] as const;

export async function runVerify(): Promise<void> {
  let clean = true;

  const manifest = loadManifest();
  if (manifest) {
    const installationIds = manifest.deployments
      .map((deployment) => deployment.installationId)
      .filter((id): id is string => Boolean(id));

    for (const region of manifest.regions) {
      const stacks = await listCustomerStacks(region);
      const surviving = stacks.filter((stack) => installationIds.includes(stack.installationTag));
      if (surviving.length > 0) {
        clean = false;
        for (const stack of surviving) {
          console.error(`[customer-reset] SURVIVING stack ${stack.stackName} (${region}, ${stack.stackStatus})`);
        }
      }

      for (const installationId of new Set(installationIds)) {
        const owned = await findOwnedResources(installationId, region);
        if (owned.rdsInstances.length || owned.replicationGroups.length || owned.buckets.length) {
          clean = false;
          console.error(
            `[customer-reset] SURVIVING resources for installation ${installationId} (${region}): ` +
              `rds=[${owned.rdsInstances.join(', ')}] cache=[${owned.replicationGroups.join(', ')}] buckets=[${owned.buckets.join(', ')}]`,
          );
        }
      }
    }
  }

  const { db, close } = connectDb();
  try {
    console.log('--- customer table row counts ---');
    for (const { name, table } of PURGED_TABLES) {
      const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(table);
      const count = row?.count ?? 0;
      console.log(`${name.padEnd(24)} ${count}`);
      if (count > 0) clean = false;
    }
  } finally {
    await close();
  }

  if (!clean) {
    console.error('[customer-reset] verify FAILED — customer data or resources remain');
    process.exitCode = 1;
    return;
  }
  console.log('[customer-reset] verify OK — no customer stacks, tagged AWS resources, or DB rows remain');
}
