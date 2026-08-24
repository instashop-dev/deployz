import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Db } from './client.js';
import {
  applicationConfigs,
  deploymentJobs,
  deployments,
  user,
} from './schema/index.js';
import { createTestDb, seedBase, type BaseIds } from './test-utils.js';

// drizzle-orm wraps driver errors as `Failed query: ...`; the underlying
// Postgres message (constraint name, enum detail) lives on error.cause.
async function expectPgError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    const message = cause instanceof Error ? cause.message : String(cause ?? error);
    expect(message).toMatch(pattern);
    return;
  }
  throw new Error(`expected rejection matching ${pattern}, but the query succeeded`);
}

// Constraint + enum-validity tests against a fresh ephemeral Postgres.
// Negative enum cases use raw SQL: the whole point is that POSTGRES rejects
// the value, independent of any TypeScript-level typing.
describe('constraints and enums', () => {
  let client: PGlite | undefined;
  let db: Db | undefined;
  let ids: BaseIds;

  beforeAll(async () => {
    ({ client, db } = await createTestDb());
    ids = await seedBase(db);
  });

  afterAll(async () => {
    await client?.close();
  });

  describe('enum validity', () => {
    it('accepts a valid region and deployment state', async () => {
      await db!.insert(deployments).values({
        customerId: ids.customerId,
        applicationId: ids.applicationId,
        organizationId: ids.organizationId,
        region: 'eu-north-1',
        state: 'UPDATE_AVAILABLE',
        installationId: 'inst-valid-enum',
        enrollmentCode: 'code-inst-valid-enum',
      });
    });

    it('rejects a region outside the §32 allowlist', async () => {
      await expect(
        client!.query(
          `INSERT INTO deployments (customer_id, application_id, organization_id, region, installation_id)
           VALUES ($1, $2, $3, 'ap-southeast-3', 'inst-bad-region')`,
          [ids.customerId, ids.applicationId, ids.organizationId],
        ),
      ).rejects.toThrow(/invalid input value for enum region/);
    });

    it("rejects job-state vocabulary on deployments.state ('RUNNING' is a job state, not a §46 deployment state)", async () => {
      await expect(
        client!.query(
          `INSERT INTO deployments (customer_id, application_id, organization_id, region, state, installation_id)
           VALUES ($1, $2, $3, 'us-east-1', 'RUNNING', 'inst-bad-state')`,
          [ids.customerId, ids.applicationId, ids.organizationId],
        ),
      ).rejects.toThrow(/invalid input value for enum deployment_state/);
    });

    it('accepts all 10 §39 job types', async () => {
      const deploymentId = crypto.randomUUID();
      await db!.insert(deployments).values({
        id: deploymentId,
        customerId: ids.customerId,
        applicationId: ids.applicationId,
        organizationId: ids.organizationId,
        region: 'us-west-2',
        installationId: 'inst-job-types',
        enrollmentCode: 'code-inst-job-types',
      });
      const types = [
        'INSTALL',
        'DEPLOY_RELEASE',
        'ROLLBACK',
        'CONFIG_UPDATE',
        'DESTROY',
        'MIGRATION',
        'INFRA_UPGRADE',
        'HEALTH_REPORT',
        'PREFLIGHT',
        'HEALTH_CHECK',
      ] as const;
      for (const type of types) {
        await db!.insert(deploymentJobs).values({
          deploymentId,
          type,
          idempotencyKey: `idem-${type}`,
        });
      }
      const { rows } = await client!.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM deployment_jobs WHERE deployment_id = $1`,
        [deploymentId],
      );
      expect(rows[0]?.c).toBe(10);
    });

    it('rejects an unknown job type', async () => {
      const deploymentId = crypto.randomUUID();
      await db!.insert(deployments).values({
        id: deploymentId,
        customerId: ids.customerId,
        applicationId: ids.applicationId,
        organizationId: ids.organizationId,
        region: 'us-west-2',
        installationId: 'inst-bad-job-type',
        enrollmentCode: 'code-inst-bad-job-type',
      });
      await expect(
        client!.query(
          `INSERT INTO deployment_jobs (deployment_id, type, idempotency_key)
           VALUES ($1, 'RESTART', 'idem-bad-type')`,
          [deploymentId],
        ),
      ).rejects.toThrow(/invalid input value for enum job_type/);
    });

    it('rejects an unknown job state', async () => {
      const deploymentId = crypto.randomUUID();
      await db!.insert(deployments).values({
        id: deploymentId,
        customerId: ids.customerId,
        applicationId: ids.applicationId,
        organizationId: ids.organizationId,
        region: 'us-west-2',
        installationId: 'inst-bad-job-state',
        enrollmentCode: 'code-inst-bad-job-state',
      });
      await expect(
        client!.query(
          `INSERT INTO deployment_jobs (deployment_id, type, state, idempotency_key)
           VALUES ($1, 'INSTALL', 'PAUSED', 'idem-bad-state')`,
          [deploymentId],
        ),
      ).rejects.toThrow(/invalid input value for enum job_state/);
    });

    it('rejects an unknown §61 failure code', async () => {
      const deploymentId = crypto.randomUUID();
      await db!.insert(deployments).values({
        id: deploymentId,
        customerId: ids.customerId,
        applicationId: ids.applicationId,
        organizationId: ids.organizationId,
        region: 'us-west-2',
        installationId: 'inst-bad-failure-code',
        enrollmentCode: 'code-inst-bad-failure-code',
      });
      await expect(
        client!.query(
          `INSERT INTO deployment_jobs (deployment_id, type, failure_code, idempotency_key)
           VALUES ($1, 'INSTALL', 'DISK_FULL', 'idem-bad-fc')`,
          [deploymentId],
        ),
      ).rejects.toThrow(/invalid input value for enum failure_code/);
    });
  });

  describe('unique constraints', () => {
    it('rejects a duplicate deployment_jobs.idempotency_key (§39)', async () => {
      const deploymentId = crypto.randomUUID();
      await db!.insert(deployments).values({
        id: deploymentId,
        customerId: ids.customerId,
        applicationId: ids.applicationId,
        organizationId: ids.organizationId,
        region: 'us-east-1',
        installationId: 'inst-idem',
        enrollmentCode: 'code-inst-idem',
      });
      await db!.insert(deploymentJobs).values({
        deploymentId,
        type: 'INSTALL',
        idempotencyKey: 'idem-dup',
      });
      await expectPgError(
        db!.insert(deploymentJobs).values({
          deploymentId,
          type: 'DEPLOY_RELEASE',
          idempotencyKey: 'idem-dup',
        }),
        /duplicate key value violates unique constraint/,
      );
    });

    it('rejects a duplicate deployments.installation_id', async () => {
      await db!.insert(deployments).values({
        customerId: ids.customerId,
        applicationId: ids.applicationId,
        organizationId: ids.organizationId,
        region: 'us-east-1',
        installationId: 'inst-dup',
        enrollmentCode: 'code-inst-dup',
      });
      await expectPgError(
        db!.insert(deployments).values({
          customerId: ids.customerId,
          applicationId: ids.applicationId,
          organizationId: ids.organizationId,
          region: 'us-east-1',
          installationId: 'inst-dup',
          enrollmentCode: 'code-inst-dup',
        }),
        /duplicate key value violates unique constraint/,
      );
    });

    it('rejects a duplicate user.email', async () => {
      await db
        .insert(user)
        .values({ id: 'user_1', name: 'One', email: 'dup@example.com' });
      await expectPgError(
        db!.insert(user).values({ id: 'user_2', name: 'Two', email: 'dup@example.com' }),
        /duplicate key value violates unique constraint/,
      );
    });

    it('enforces unique(application_id, customer_id, key) on application_configs', async () => {
      await db!.insert(applicationConfigs).values({
        applicationId: ids.applicationId,
        customerId: ids.customerId,
        key: 'LOG_LEVEL',
        value: 'info',
      });
      await expectPgError(
        db!.insert(applicationConfigs).values({
          applicationId: ids.applicationId,
          customerId: ids.customerId,
          key: 'LOG_LEVEL',
          value: 'debug',
        }),
        /duplicate key value violates unique constraint/,
      );
    });

    it('dedupes vendor-default configs (customer_id NULL) via NULLS NOT DISTINCT', async () => {
      await db!.insert(applicationConfigs).values({
        applicationId: ids.applicationId,
        key: 'VENDOR_DEFAULT',
        value: 'one',
      });
      await expectPgError(
        db!.insert(applicationConfigs).values({
          applicationId: ids.applicationId,
          key: 'VENDOR_DEFAULT',
          value: 'two',
        }),
        /duplicate key value violates unique constraint/,
      );
    });

    it('allows the same key as both vendor default and customer override (§31)', async () => {
      await db!.insert(applicationConfigs).values({
        applicationId: ids.applicationId,
        key: 'TIER',
        value: 'standard',
      });
      await db!.insert(applicationConfigs).values({
        applicationId: ids.applicationId,
        customerId: ids.customerId,
        key: 'TIER',
        value: 'premium',
      });
    });
  });

  describe('foreign keys', () => {
    it('rejects a deployment with a bogus customer_id', async () => {
      await expectPgError(
        db!.insert(deployments).values({
          customerId: crypto.randomUUID(),
          applicationId: ids.applicationId,
          organizationId: ids.organizationId,
          region: 'us-east-1',
          installationId: 'inst-bad-fk',
          enrollmentCode: 'code-inst-bad-fk',
        }),
        /violates foreign key constraint/,
      );
    });
  });
});
