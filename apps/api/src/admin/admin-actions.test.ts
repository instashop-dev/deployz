import { PGlite } from '@electric-sql/pglite';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DESTROY_PENDING_STALE_AFTER_MS } from '@deployz/contracts';
import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from '../auth.js';
import { buildServer } from '../server.js';

// ── Shared test helpers (matches admin-deployments-jobs.test.ts style) ─────

async function signUpAndGetOrg(
  auth: Auth,
  db: Db,
  email: string,
): Promise<{ userId: string; organizationId: string; cookie: string; email: string; name: string }> {
  const password = crypto.randomUUID();
  const name = email.split('@')[0]!;
  const signup = await auth.api.signUpEmail({ body: { email, password, name } });
  const signin = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  const setCookie = signin.headers.get('set-cookie');
  if (!setCookie) throw new Error('sign-in did not set a session cookie');
  const memberships = await db
    .select({ organizationId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, signup.user.id))
    .limit(1);
  const organizationId = memberships[0]?.organizationId;
  if (!organizationId) throw new Error('signup did not provision an organization');
  return { userId: signup.user.id, organizationId, cookie: setCookie, email, name };
}

async function insertApplication(
  db: Db,
  organizationId: string,
  overrides: Partial<typeof schema.applications.$inferInsert> = {},
): Promise<typeof schema.applications.$inferSelect> {
  const [row] = await db
    .insert(schema.applications)
    .values({
      organizationId,
      name: 'Test App',
      repoFullName: `acme/test-app-${crypto.randomUUID().slice(0, 8)}`,
      repoUrl: 'https://github.com/acme/test-app',
      defaultBranch: 'main',
      ...overrides,
    })
    .returning();
  return row!;
}

async function insertCustomer(
  db: Db,
  organizationId: string,
  overrides: Partial<typeof schema.customers.$inferInsert> = {},
): Promise<typeof schema.customers.$inferSelect> {
  const [row] = await db
    .insert(schema.customers)
    .values({
      organizationId,
      name: 'Test Customer',
      email: `customer-${crypto.randomUUID()}@example.com`,
      ...overrides,
    })
    .returning();
  return row!;
}

async function insertRelease(
  db: Db,
  applicationId: string,
  overrides: Partial<typeof schema.releases.$inferInsert> = {},
): Promise<typeof schema.releases.$inferSelect> {
  const [row] = await db
    .insert(schema.releases)
    .values({
      applicationId,
      version: `v1.0.0-${crypto.randomUUID().slice(0, 8)}`,
      gitSha: 'a1b2c3d',
      ...overrides,
    })
    .returning();
  return row!;
}

async function insertDeployableRelease(db: Db, applicationId: string): Promise<string> {
  const release = await insertRelease(db, applicationId, {
    releaseStatus: 'READY',
    buildStatus: 'SUCCEEDED',
    imageDigest:
      '151955775369.dkr.ecr.us-east-1.amazonaws.com/deployz-images@sha256:' +
      crypto.randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
  });
  return release.id;
}

async function insertDeployment(
  db: Db,
  organizationId: string,
  applicationId: string,
  customerId: string,
  overrides: Partial<typeof schema.deployments.$inferInsert> = {},
): Promise<typeof schema.deployments.$inferSelect> {
  const [row] = await db
    .insert(schema.deployments)
    .values({
      organizationId,
      applicationId,
      customerId,
      region: 'us-east-1',
      state: 'NOT_INSTALLED',
      installationId: `inst-${crypto.randomUUID()}`,
      enrollmentCode: crypto.randomUUID(),
      ...overrides,
    })
    .returning();
  return row!;
}

async function insertJob(
  db: Db,
  deploymentId: string,
  overrides: Partial<typeof schema.deploymentJobs.$inferInsert> = {},
): Promise<typeof schema.deploymentJobs.$inferSelect> {
  const [row] = await db
    .insert(schema.deploymentJobs)
    .values({
      deploymentId,
      type: 'DEPLOY_RELEASE',
      state: 'RUNNING',
      idempotencyKey: `job-${crypto.randomUUID()}`,
      ...overrides,
    })
    .returning();
  return row!;
}

function postReq(app: FastifyInstance, url: string, cookie: string, body: unknown = {}) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', cookie },
    payload: JSON.stringify(body),
  });
}

// recordAdminAuditEvent (admin/audit.ts) writes targetId inside the JSONB
// payload, not a deploymentId column — match the pattern admin/queries.ts's
// getAuditLog uses for filtering on payload fields.
async function adminAuditRows(db: Db, deploymentId: string, eventType: string) {
  return db
    .select()
    .from(schema.eventLogs)
    .where(
      and(
        eq(schema.eventLogs.eventType, eventType),
        sql`${schema.eventLogs.payload}->>'targetId' = ${deploymentId}`,
      ),
    );
}

describe('Team Admin: safe recovery actions (API)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;

  let admin: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let org: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let application: typeof schema.applications.$inferSelect;
  let customer: typeof schema.customers.$inferSelect;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);

    admin = await signUpAndGetOrg(auth, db, `admin-${crypto.randomUUID()}@example.com`);
    await db.update(schema.user).set({ platformRole: 'ADMIN' }).where(eq(schema.user.id, admin.userId));
    app = await buildServer({ auth, db, teamAdminEmails: [], teamAdminEnvGrantsEnabled: false });

    // The admin acts CROSS-TENANT on a deployment owned by ANOTHER org.
    org = await signUpAndGetOrg(auth, db, `vendor-${crypto.randomUUID()}@example.com`);
    application = await insertApplication(db, org.organizationId, { name: 'Recovery App' });
    customer = await insertCustomer(db, org.organizationId, { name: 'Recovery Customer' });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  describe('403 for a non-admin vendor user', () => {
    it('rejects all four recovery actions with NOT_TEAM_ADMIN', async () => {
      const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
        state: 'FAILED',
      });

      const routes: [string, unknown][] = [
        [`/api/admin/deployments/${deployment.id}/retry-install`, {}],
        [`/api/admin/deployments/${deployment.id}/rollback`, { releaseId: crypto.randomUUID(), reason: 'test reason' }],
        [`/api/admin/deployments/${deployment.id}/force-complete-destroy`, { reason: 'test reason' }],
        [`/api/admin/deployments/${deployment.id}/relay-reset`, { reason: 'test reason' }],
      ];
      for (const [url, body] of routes) {
        const response = await postReq(app, url, org.cookie, body);
        expect.soft(response.statusCode, url).toBe(403);
        expect.soft(response.json(), url).toMatchObject({ error: { code: 'NOT_TEAM_ADMIN' } });
      }
    });
  });

  describe('POST /api/admin/deployments/:id/retry-install', () => {
    it('202s on a FAILED never-succeeded deployment: creates the INSTALL job, moves to INSTALLING, records vendor + admin events', async () => {
      const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
        state: 'FAILED',
        installationId: `inst-retry-${crypto.randomUUID()}`,
      });
      await insertJob(db, deployment.id, {
        type: 'INSTALL',
        state: 'FAILED',
        idempotencyKey: `${deployment.id}:INSTALL`,
      });

      const response = await postReq(
        app,
        `/api/admin/deployments/${deployment.id}/retry-install`,
        admin.cookie,
        { reason: 'customer asked us to retry' },
      );
      expect(response.statusCode, response.body).toBe(202);
      const { jobId } = response.json() as { jobId: string };

      const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
      expect(dep!.state).toBe('INSTALLING');

      const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, jobId));
      expect(job!.type).toBe('INSTALL');
      expect(job!.payload).toMatchObject({ recovery: { neverInstalled: true } });

      // Vendor-visible event, unchanged from the vendor route.
      const vendorEvents = await db
        .select()
        .from(schema.eventLogs)
        .where(and(eq(schema.eventLogs.deploymentId, deployment.id), eq(schema.eventLogs.eventType, 'install.retry.requested')));
      expect(vendorEvents).toHaveLength(1);

      // Admin audit row, in the TARGET org, carrying the admin's email + reason.
      const auditRows = await adminAuditRows(db, deployment.id, 'admin.install.retry_requested');
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]!.organizationId).toBe(org.organizationId);
      expect(auditRows[0]!.actorId).toBe(admin.userId);
      expect(auditRows[0]!.payload).toMatchObject({
        adminEmail: admin.email,
        reason: 'customer asked us to retry',
        jobId,
      });
    });

    it('propagates 409 INSTALL_ALREADY_SUCCEEDED and writes NO admin audit row', async () => {
      const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
        state: 'FAILED',
        installationId: `inst-succeeded-${crypto.randomUUID()}`,
      });
      await insertJob(db, deployment.id, {
        type: 'INSTALL',
        state: 'SUCCEEDED',
        idempotencyKey: `${deployment.id}:INSTALL`,
      });

      const response = await postReq(app, `/api/admin/deployments/${deployment.id}/retry-install`, admin.cookie, {});
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'INSTALL_ALREADY_SUCCEEDED' } });

      const auditRows = await adminAuditRows(db, deployment.id, 'admin.install.retry_requested');
      expect(auditRows).toHaveLength(0);
    });
  });

  describe('POST /api/admin/deployments/:id/rollback', () => {
    it('400s on a missing or blank reason and creates no job', async () => {
      const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
        state: 'HEALTHY',
      });
      const releaseId = await insertDeployableRelease(db, application.id);

      const missing = await postReq(app, `/api/admin/deployments/${deployment.id}/rollback`, admin.cookie, { releaseId });
      expect(missing.statusCode).toBe(400);
      expect(missing.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

      const blank = await postReq(app, `/api/admin/deployments/${deployment.id}/rollback`, admin.cookie, {
        releaseId,
        reason: '  ',
      });
      expect(blank.statusCode).toBe(400);
      expect(blank.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

      const jobs = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.deploymentId, deployment.id));
      expect(jobs).toHaveLength(0);
    });

    it('202s on a READY release: creates a ROLLBACK job and an audit row with releaseId + reason', async () => {
      const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
        state: 'HEALTHY',
      });
      const releaseId = await insertDeployableRelease(db, application.id);

      const response = await postReq(app, `/api/admin/deployments/${deployment.id}/rollback`, admin.cookie, {
        releaseId,
        reason: 'roll back to last known good release',
      });
      expect(response.statusCode, response.body).toBe(202);
      const { jobId } = response.json() as { jobId: string };

      const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, jobId));
      expect(job!.type).toBe('ROLLBACK');

      const auditRows = await adminAuditRows(db, deployment.id, 'admin.rollback.requested');
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]!.payload).toMatchObject({
        adminEmail: admin.email,
        reason: 'roll back to last known good release',
        releaseId,
        jobId,
      });
    });

    it('propagates the vendor guard error for a non-deployable state', async () => {
      const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
        state: 'NOT_INSTALLED',
      });

      const response = await postReq(app, `/api/admin/deployments/${deployment.id}/rollback`, admin.cookie, {
        releaseId: crypto.randomUUID(),
        reason: 'attempting a rollback anyway',
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'DEPLOYMENT_NOT_DEPLOYABLE' } });

      const auditRows = await adminAuditRows(db, deployment.id, 'admin.rollback.requested');
      expect(auditRows).toHaveLength(0);
    });
  });

  describe('POST /api/admin/deployments/:id/force-complete-destroy', () => {
    async function seedDisconnectingDeployment(overrides: {
      relayStatus: 'CONNECTED' | 'DISCONNECTED' | 'UNKNOWN';
      destroyJob: { state: 'REQUESTED' | 'RUNNING'; ageMinutes: number } | null;
    }): Promise<typeof schema.deployments.$inferSelect> {
      const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
        state: 'DELETING',
        relayStatus: overrides.relayStatus,
      });
      if (overrides.destroyJob) {
        const age = new Date(Date.now() - overrides.destroyJob.ageMinutes * 60 * 1000);
        await insertJob(db, deployment.id, {
          type: 'DESTROY',
          state: overrides.destroyJob.state,
          idempotencyKey: `${deployment.id}:DESTROY`,
          createdAt: age,
          startedAt: age,
          lastProgressAt: age,
        });
      }
      return deployment;
    }

    it('400s on a missing reason', async () => {
      const deployment = await seedDisconnectingDeployment({ relayStatus: 'DISCONNECTED', destroyJob: null });
      const response = await postReq(app, `/api/admin/deployments/${deployment.id}/force-complete-destroy`, admin.cookie, {});
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    });

    it('propagates the vendor guard error (RELAY_NOT_OFFLINE) when the relay still reads online', async () => {
      const deployment = await seedDisconnectingDeployment({
        relayStatus: 'CONNECTED',
        destroyJob: { state: 'RUNNING', ageMinutes: 90 },
      });
      const response = await postReq(app, `/api/admin/deployments/${deployment.id}/force-complete-destroy`, admin.cookie, {
        reason: 'relay looked offline in the dashboard',
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'RELAY_NOT_OFFLINE' } });

      const auditRows = await adminAuditRows(db, deployment.id, 'admin.destroy.force_completed');
      expect(auditRows).toHaveLength(0);
    });

    it('force-completes a stale DESTROY on a disconnected relay: same terminal state as the vendor flow + audit row', async () => {
      const deployment = await seedDisconnectingDeployment({
        relayStatus: 'DISCONNECTED',
        destroyJob: { state: 'RUNNING', ageMinutes: DESTROY_PENDING_STALE_AFTER_MS / 60_000 + 30 },
      });

      const response = await postReq(app, `/api/admin/deployments/${deployment.id}/force-complete-destroy`, admin.cookie, {
        reason: 'relay confirmed permanently offline',
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toStrictEqual({ state: 'DELETED', cleanupState: 'SKIPPED_RELAY_OFFLINE' });

      const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
      expect(dep!.state).toBe('DELETED');
      expect(dep!.cleanupState).toBe('SKIPPED_RELAY_OFFLINE');

      const auditRows = await adminAuditRows(db, deployment.id, 'admin.destroy.force_completed');
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]!.payload).toMatchObject({
        adminEmail: admin.email,
        reason: 'relay confirmed permanently offline',
        cleanupState: 'SKIPPED_RELAY_OFFLINE',
      });
    });
  });

  describe('POST /api/admin/deployments/:id/relay-reset', () => {
    it('400s on a missing reason', async () => {
      const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, { state: 'FAILED' });
      const response = await postReq(app, `/api/admin/deployments/${deployment.id}/relay-reset`, admin.cookie, {});
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    });

    it('mints a fresh enrollmentCode and bumps attemptNumber, matching the vendor flow, and writes an audit row', async () => {
      const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
        state: 'FAILED',
        installationId: `inst-reset-${crypto.randomUUID()}`,
        relayStatus: 'DISCONNECTED',
      });

      const response = await postReq(app, `/api/admin/deployments/${deployment.id}/relay-reset`, admin.cookie, {
        reason: 'relay credential was rotated',
      });
      expect(response.statusCode, response.body).toBe(200);

      const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
      expect(dep!.attemptNumber).toBe(deployment.attemptNumber + 1);
      expect(dep!.enrollmentCode).not.toBe(deployment.enrollmentCode);
      expect(dep!.installationId).toBeNull();
      expect(dep!.state).toBe('NOT_INSTALLED');

      const auditRows = await adminAuditRows(db, deployment.id, 'admin.relay.reset_requested');
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]!.payload).toMatchObject({
        adminEmail: admin.email,
        reason: 'relay credential was rotated',
        attemptNumber: deployment.attemptNumber + 1,
      });
    });
  });
});
