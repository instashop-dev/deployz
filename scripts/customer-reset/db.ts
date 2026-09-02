/**
 * Control-plane database access for the customer-reset admin tool.
 *
 * Connects via DATABASE_URL (never the local PGlite dev database — see
 * `connectDb`) using the same Drizzle schema exports the API and worker use
 * (`@deployz/db/schema`), so this tool can never drift from the live table
 * shapes. `readInventory` is read-only. `purgeCustomerData` deletes every row
 * of the CUSTOMER tables, in FK-safe order, and NEVER touches control-plane
 * data: user, session, account, verification, organization, member,
 * invitation, customers, subscriptions, github_installations, or the
 * append-only event_logs (its immutability trigger would reject deletes
 * anyway — see packages/db/src/schema/events.ts).
 */

import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@deployz/db/schema';

export type Db = NodePgDatabase<typeof schema>;

export interface DbHandle {
  readonly db: Db;
  close(): Promise<void>;
}

/**
 * Opens a connection strictly from DATABASE_URL. Refuses to run at all when
 * it is unset, rather than silently falling back to the local file-backed
 * PGlite dev database the way `@deployz/db`'s `createRuntimeDb` does for
 * ordinary app startup — an admin reset tool must never guess which database
 * it is pointed at.
 */
export function connectDb(): DbHandle {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL must be set — refusing to run against the local PGlite dev database',
    );
  }
  const pool = new Pool({ connectionString: url });
  const db = drizzle({ client: pool, schema });
  return { db, close: () => pool.end() };
}

export interface DeploymentInventoryRow {
  readonly id: string;
  readonly installationId: string | null;
  readonly bootstrapStackName: string | null;
  readonly region: string;
  readonly awsAccountId: string | null;
  readonly state: string;
}

export interface CustomDomainInventoryRow {
  readonly id: string;
  readonly deploymentId: string;
  readonly certificateArn: string | null;
}

export interface DeploymentResourceInventoryRow {
  readonly deploymentId: string;
  readonly physicalResourceId: string | null;
  readonly resourceType: string;
}

export interface ApplicationInventoryRow {
  readonly id: string;
}

export interface DbInventory {
  readonly applications: readonly ApplicationInventoryRow[];
  readonly deployments: readonly DeploymentInventoryRow[];
  readonly customDomains: readonly CustomDomainInventoryRow[];
  readonly deploymentResources: readonly DeploymentResourceInventoryRow[];
  readonly releaseCount: number;
  readonly jobCount: number;
  readonly usageRecordCount: number;
  readonly applicationConfigCount: number;
}

/** Read-only snapshot of everything `purgeCustomerData` will delete. */
export async function readInventory(db: Db): Promise<DbInventory> {
  const [
    applications,
    deployments,
    customDomains,
    deploymentResources,
    releases,
    jobs,
    usageRecords,
    applicationConfigs,
  ] = await Promise.all([
    db.select({ id: schema.applications.id }).from(schema.applications),
    db
      .select({
        id: schema.deployments.id,
        installationId: schema.deployments.installationId,
        bootstrapStackName: schema.deployments.bootstrapStackName,
        region: schema.deployments.region,
        awsAccountId: schema.deployments.awsAccountId,
        state: schema.deployments.state,
      })
      .from(schema.deployments),
    db
      .select({
        id: schema.customDomains.id,
        deploymentId: schema.customDomains.deploymentId,
        certificateArn: schema.customDomains.certificateArn,
      })
      .from(schema.customDomains),
    db
      .select({
        deploymentId: schema.deploymentResources.deploymentId,
        physicalResourceId: schema.deploymentResources.physicalResourceId,
        resourceType: schema.deploymentResources.resourceType,
      })
      .from(schema.deploymentResources),
    db.select({ id: schema.releases.id }).from(schema.releases),
    db.select({ id: schema.deploymentJobs.id }).from(schema.deploymentJobs),
    db.select({ id: schema.usageRecords.id }).from(schema.usageRecords),
    db.select({ id: schema.applicationConfigs.id }).from(schema.applicationConfigs),
  ]);

  return {
    applications,
    deployments,
    customDomains,
    deploymentResources,
    releaseCount: releases.length,
    jobCount: jobs.length,
    usageRecordCount: usageRecords.length,
    applicationConfigCount: applicationConfigs.length,
  };
}

/**
 * Deletes every row of the CUSTOMER tables, in this exact FK-safe order.
 * Nothing else is ever touched — no cascades, no raw SQL against a table not
 * named here.
 */
export async function purgeCustomerData(db: Db): Promise<void> {
  await db.delete(schema.deploymentResources);
  await db.delete(schema.usageRecords);
  await db.delete(schema.customDomains);
  await db.delete(schema.deploymentJobs);
  await db.delete(schema.deployments);
  await db.delete(schema.applicationConfigs);
  await db.delete(schema.releases);
  await db.delete(schema.applications);
}
