import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from '../auth.js';
import { buildServer } from '../server.js';
import { recordAdminAuditEvent } from './audit.js';

// ── Shared test helpers (matches admin-overview-vendors.test.ts style) ─────

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

function getReq(app: FastifyInstance, url: string, cookie: string) {
  return app.inject({ method: 'GET', url, headers: { cookie } });
}

describe('Team Admin: search + audit log read models', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;

  let admin: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let org: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let application: typeof schema.applications.$inferSelect;
  let customer: typeof schema.customers.$inferSelect;
  let deployment: typeof schema.deployments.$inferSelect;
  let job: typeof schema.deploymentJobs.$inferSelect;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);

    admin = await signUpAndGetOrg(auth, db, `admin-${crypto.randomUUID()}@example.com`);
    await db.update(schema.user).set({ platformRole: 'ADMIN' }).where(eq(schema.user.id, admin.userId));
    app = await buildServer({ auth, db, teamAdminEmails: [], teamAdminEnvGrantsEnabled: false });

    org = await signUpAndGetOrg(auth, db, `vendor-${crypto.randomUUID()}@example.com`);
    application = await insertApplication(db, org.organizationId, { name: 'Findable App' });
    customer = await insertCustomer(db, org.organizationId, {
      name: 'Findable Customer',
      email: 'findable-customer@example.com',
    });
    deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'HEALTHY',
      awsAccountId: '123456789012',
      bootstrapStackName: 'deployz-findable-stack',
    });
    await db.insert(schema.customDomains).values({
      deploymentId: deployment.id,
      organizationId: org.organizationId,
      hostname: 'findable.example.com',
      status: 'ACTIVE',
    });
    const [insertedJob] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: deployment.id,
        type: 'INSTALL',
        state: 'SUCCEEDED',
        idempotencyKey: `job-${crypto.randomUUID()}`,
      })
      .returning();
    job = insertedJob!;

    // A non-admin event — must never appear in the audit log.
    await db.insert(schema.eventLogs).values({
      actorType: 'system',
      actorId: 'relay',
      organizationId: org.organizationId,
      deploymentId: deployment.id,
      eventType: 'install.requested',
      result: 'success',
    });

    // admin.* events across two "actions" for the filter/cursor tests, oldest first.
    for (let i = 0; i < 3; i++) {
      await recordAdminAuditEvent(db, {
        actor: { id: admin.userId, name: admin.name, email: admin.email },
        eventType: 'admin.support_session.started',
        organizationId: org.organizationId,
        targetType: 'organization',
        targetId: org.organizationId,
      });
    }
    await recordAdminAuditEvent(db, {
      actor: { id: admin.userId, name: admin.name, email: admin.email },
      eventType: 'admin.rollback.requested',
      organizationId: org.organizationId,
      targetType: 'deployment',
      targetId: deployment.id,
      reason: 'customer requested rollback',
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  describe('GET /api/admin/search', () => {
    it('resolves a deployment by exact uuid id', async () => {
      const response = await getReq(app, `/api/admin/search?q=${deployment.id}`, admin.cookie);
      const body = response.json() as { deployments: { id: string }[] };
      expect(body.deployments.map((d) => d.id)).toContain(deployment.id);
    });

    it('resolves a deployment by exact installationId', async () => {
      const response = await getReq(app, `/api/admin/search?q=${deployment.installationId}`, admin.cookie);
      const body = response.json() as { deployments: { id: string }[] };
      expect(body.deployments.map((d) => d.id)).toContain(deployment.id);
    });

    it('resolves a deployment by exact awsAccountId', async () => {
      const response = await getReq(app, '/api/admin/search?q=123456789012', admin.cookie);
      const body = response.json() as { deployments: { id: string }[] };
      expect(body.deployments.map((d) => d.id)).toContain(deployment.id);
    });

    it('resolves a deployment by custom domain hostname', async () => {
      const response = await getReq(app, '/api/admin/search?q=findable.example.com', admin.cookie);
      const body = response.json() as { deployments: { id: string }[] };
      expect(body.deployments.map((d) => d.id)).toContain(deployment.id);
    });

    it('resolves a job by exact uuid id', async () => {
      const response = await getReq(app, `/api/admin/search?q=${job.id}`, admin.cookie);
      const body = response.json() as { jobs: { id: string }[] };
      expect(body.jobs.map((j) => j.id)).toContain(job.id);
    });

    it('resolves an owner email to their vendor organization', async () => {
      const response = await getReq(app, `/api/admin/search?q=${encodeURIComponent(org.email)}`, admin.cookie);
      const body = response.json() as { vendors: { id: string }[] };
      expect(body.vendors.map((v) => v.id)).toContain(org.organizationId);
    });

    it('resolves a customer by name/email and an application by name', async () => {
      const customerResponse = await getReq(app, '/api/admin/search?q=Findable%20Customer', admin.cookie);
      const customerBody = customerResponse.json() as { customers: { id: string }[] };
      expect(customerBody.customers.map((c) => c.id)).toContain(customer.id);

      const appResponse = await getReq(app, '/api/admin/search?q=Findable%20App', admin.cookie);
      const appBody = appResponse.json() as { applications: { id: string }[] };
      expect(appBody.applications.map((a) => a.id)).toContain(application.id);
    });

    it('does not throw on invalid uuid-shaped text', async () => {
      const response = await getReq(app, '/api/admin/search?q=not-a-uuid-at-all', admin.cookie);
      expect(response.statusCode).toBe(200);
    });

    it('returns empty groups for an empty or too-short query', async () => {
      const empty = await getReq(app, '/api/admin/search?q=', admin.cookie);
      expect(empty.json()).toEqual({ vendors: [], applications: [], customers: [], deployments: [], jobs: [] });

      const oneChar = await getReq(app, '/api/admin/search?q=a', admin.cookie);
      expect(oneChar.json()).toEqual({ vendors: [], applications: [], customers: [], deployments: [], jobs: [] });
    });
  });

  describe('GET /api/admin/audit-log', () => {
    it('lists only admin.* events, excluding non-admin event types', async () => {
      const response = await getReq(app, '/api/admin/audit-log', admin.cookie);
      expect(response.statusCode).toBe(200);
      const body = response.json() as { events: { eventType: string }[]; nextBefore: number | null };
      expect(body.events.length).toBeGreaterThanOrEqual(4);
      expect(body.events.every((event) => event.eventType.startsWith('admin.'))).toBe(true);
      expect(body.events.some((event) => event.eventType === 'install.requested')).toBe(false);
    });

    it('filters by action (exact eventType or family prefix)', async () => {
      const response = await getReq(app, '/api/admin/audit-log?action=admin.rollback.requested', admin.cookie);
      const body = response.json() as { events: { eventType: string }[] };
      expect(body.events.length).toBeGreaterThanOrEqual(1);
      expect(body.events.every((event) => event.eventType === 'admin.rollback.requested')).toBe(true);
    });

    it('filters by targetType', async () => {
      const response = await getReq(app, '/api/admin/audit-log?targetType=deployment', admin.cookie);
      const body = response.json() as { events: { payload: { targetType?: string } }[] };
      expect(body.events.length).toBeGreaterThanOrEqual(1);
      expect(body.events.every((event) => event.payload.targetType === 'deployment')).toBe(true);
    });

    it('filters by actor (actorId)', async () => {
      const response = await getReq(app, `/api/admin/audit-log?actor=${admin.userId}`, admin.cookie);
      const body = response.json() as { events: { actorId: string }[] };
      expect(body.events.length).toBeGreaterThanOrEqual(4);
      expect(body.events.every((event) => event.actorId === admin.userId)).toBe(true);
    });

    it('paginates with the before cursor, newest first with no overlap', async () => {
      const firstPage = await getReq(app, '/api/admin/audit-log?limit=2', admin.cookie);
      const firstBody = firstPage.json() as { events: { id: number }[]; nextBefore: number | null };
      expect(firstBody.events).toHaveLength(2);
      expect(firstBody.nextBefore).not.toBeNull();

      const secondPage = await getReq(
        app,
        `/api/admin/audit-log?limit=2&before=${firstBody.nextBefore}`,
        admin.cookie,
      );
      const secondBody = secondPage.json() as { events: { id: number }[] };
      const firstIds = firstBody.events.map((e) => e.id);
      const secondIds = secondBody.events.map((e) => e.id);
      expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
      // Newest first: every id on the first page is greater than every id on the second.
      expect(Math.min(...firstIds)).toBeGreaterThan(Math.max(...secondIds));
    });
  });
});
