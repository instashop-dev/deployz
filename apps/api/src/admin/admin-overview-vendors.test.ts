import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from '../auth.js';
import { buildServer } from '../server.js';

// ── Shared test helpers (matches support-session.test.ts / organizations.test.ts style) ──

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

function getReq(app: FastifyInstance, url: string, cookie: string) {
  return app.inject({ method: 'GET', url, headers: { cookie } });
}

// Every GET-only /api/admin/* route added in this phase — the 403 sweep below
// proves requireTeamAdmin gates all of them, not just the support-session
// lifecycle from Phase 1.
function adminRoutes(deploymentId: string, jobId: string, vendorId: string): string[] {
  return [
    '/api/admin/overview',
    '/api/admin/vendors',
    `/api/admin/vendors/${vendorId}`,
    '/api/admin/deployments',
    `/api/admin/deployments/${deploymentId}`,
    '/api/admin/jobs',
    `/api/admin/jobs/${jobId}`,
    '/api/admin/connections',
    `/api/admin/connections/${deploymentId}`,
    '/api/admin/search?q=test',
    '/api/admin/audit-log',
  ];
}

describe('Team Admin: overview + vendors read models', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;

  let admin: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let vendorUser: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let orgA: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let orgB: Awaited<ReturnType<typeof signUpAndGetOrg>>;

  let appA: typeof schema.applications.$inferSelect;
  let customerA: typeof schema.customers.$inferSelect;
  let depFailed: typeof schema.deployments.$inferSelect;
  let depUnhealthy: typeof schema.deployments.$inferSelect;
  let depDisconnected: typeof schema.deployments.$inferSelect;
  let depStuckJob: typeof schema.deployments.$inferSelect;
  let stuckJob: typeof schema.deploymentJobs.$inferSelect;

  let appB: typeof schema.applications.$inferSelect;
  let customerB: typeof schema.customers.$inferSelect;
  let depBFailed: typeof schema.deployments.$inferSelect;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);

    admin = await signUpAndGetOrg(auth, db, `admin-${crypto.randomUUID()}@example.com`);
    vendorUser = await signUpAndGetOrg(auth, db, `vendor-${crypto.randomUUID()}@example.com`);
    await db.update(schema.user).set({ platformRole: 'ADMIN' }).where(eq(schema.user.id, admin.userId));

    app = await buildServer({ auth, db, teamAdminEmails: [], teamAdminEnvGrantsEnabled: false });

    // ── Org A: one of everything the overview must catch ──
    orgA = await signUpAndGetOrg(auth, db, `vendor-a-${crypto.randomUUID()}@example.com`);
    appA = await insertApplication(db, orgA.organizationId, { name: 'Org A App' });
    customerA = await insertCustomer(db, orgA.organizationId, { name: 'Org A Customer' });

    depFailed = await insertDeployment(db, orgA.organizationId, appA.id, customerA.id, {
      state: 'FAILED',
      relayStatus: 'CONNECTED',
      healthStatus: 'UNKNOWN',
    });
    await insertJob(db, depFailed.id, { type: 'INSTALL', state: 'FAILED', failureCode: 'PORT_MISMATCH' });

    depUnhealthy = await insertDeployment(db, orgA.organizationId, appA.id, customerA.id, {
      state: 'HEALTHY',
      relayStatus: 'CONNECTED',
      healthStatus: 'UNHEALTHY',
    });

    await insertDeployment(db, orgA.organizationId, appA.id, customerA.id, {
      state: 'INSTALLING',
      relayStatus: 'UNKNOWN',
      healthStatus: 'UNKNOWN',
    });

    depDisconnected = await insertDeployment(db, orgA.organizationId, appA.id, customerA.id, {
      state: 'HEALTHY',
      relayStatus: 'DISCONNECTED',
      healthStatus: 'HEALTHY',
    });

    depStuckJob = await insertDeployment(db, orgA.organizationId, appA.id, customerA.id, {
      state: 'UPDATING',
      relayStatus: 'CONNECTED',
      healthStatus: 'HEALTHY',
    });
    // DEPLOY_RELEASE times out after 20 minutes — backdate lastProgressAt well past that.
    const stuckSignalAt = new Date(Date.now() - 25 * 60 * 1000);
    stuckJob = await insertJob(db, depStuckJob.id, {
      type: 'DEPLOY_RELEASE',
      state: 'RUNNING',
      startedAt: stuckSignalAt,
      lastProgressAt: stuckSignalAt,
    });

    await db.insert(schema.eventLogs).values([
      {
        actorType: 'system',
        actorId: 'relay',
        organizationId: orgA.organizationId,
        deploymentId: depFailed.id,
        eventType: 'install.failed',
        result: 'failure',
      },
      {
        actorType: 'system',
        actorId: 'relay',
        organizationId: orgA.organizationId,
        deploymentId: depUnhealthy.id,
        eventType: 'health.degraded',
        result: 'success',
      },
    ]);

    // ── Org B: cross-tenant noise + its own failure ──
    orgB = await signUpAndGetOrg(auth, db, `vendor-b-${crypto.randomUUID()}@example.com`);
    appB = await insertApplication(db, orgB.organizationId, { name: 'Org B App' });
    customerB = await insertCustomer(db, orgB.organizationId, { name: 'Org B Customer' });
    await insertDeployment(db, orgB.organizationId, appB.id, customerB.id, {
      state: 'HEALTHY',
      relayStatus: 'CONNECTED',
      healthStatus: 'HEALTHY',
    });
    depBFailed = await insertDeployment(db, orgB.organizationId, appB.id, customerB.id, {
      state: 'FAILED',
      relayStatus: 'CONNECTED',
      healthStatus: 'UNKNOWN',
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('403s a normal vendor user on every new admin route', async () => {
    for (const url of adminRoutes(depFailed.id, stuckJob.id, orgA.organizationId)) {
      const response = await getReq(app, url, vendorUser.cookie);
      expect.soft(response.statusCode, url).toBe(403);
      expect.soft(response.json().error.code, url).toBe('NOT_TEAM_ADMIN');
    }
  });

  describe('GET /api/admin/overview', () => {
    it('aggregates counts and lists across both organizations', async () => {
      const response = await getReq(app, '/api/admin/overview', admin.cookie);
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        counts: {
          failedDeployments: number;
          unhealthyDeployments: number;
          stuckJobs: number;
          disconnectedRelays: number;
          inProgressDeployments: number;
        };
        recentFailures: { id: string }[];
        stuckJobs: { id: string; deploymentId: string }[];
        disconnectedConnections: { id: string }[];
      };

      expect(body.counts.failedDeployments).toBe(2);
      expect(body.counts.unhealthyDeployments).toBe(1);
      expect(body.counts.stuckJobs).toBe(1);
      expect(body.counts.disconnectedRelays).toBe(1);
      // INSTALLING (depInstalling) + UPDATING (depStuckJob) both count as in-progress.
      expect(body.counts.inProgressDeployments).toBe(2);

      expect(body.recentFailures.map((r) => r.id).sort()).toEqual([depFailed.id, depBFailed.id].sort());
      expect(body.stuckJobs).toHaveLength(1);
      expect(body.stuckJobs[0]!.id).toBe(stuckJob.id);
      expect(body.stuckJobs[0]!.deploymentId).toBe(depStuckJob.id);
      expect(body.disconnectedConnections).toHaveLength(1);
      expect(body.disconnectedConnections[0]!.id).toBe(depDisconnected.id);
    });
  });

  describe('GET /api/admin/vendors', () => {
    it('aggregates per-organization rows correctly', async () => {
      const response = await getReq(app, '/api/admin/vendors', admin.cookie);
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        vendors: {
          organizationId: string;
          applicationCount: number;
          deploymentCount: number;
          connection: string;
          hasFailedDeployment: boolean;
          ownerEmail: string | null;
          lastActivityAt: string | null;
        }[];
      };

      const rowA = body.vendors.find((v) => v.organizationId === orgA.organizationId);
      expect(rowA).toBeTruthy();
      expect(rowA!.applicationCount).toBe(1);
      expect(rowA!.deploymentCount).toBe(5);
      expect(rowA!.connection).toBe('DISCONNECTED');
      expect(rowA!.hasFailedDeployment).toBe(true);
      expect(rowA!.ownerEmail).toBe(orgA.email);
      expect(rowA!.lastActivityAt).toBeTruthy();

      const rowB = body.vendors.find((v) => v.organizationId === orgB.organizationId);
      expect(rowB).toBeTruthy();
      expect(rowB!.deploymentCount).toBe(2);
      expect(rowB!.hasFailedDeployment).toBe(true);
      expect(rowB!.connection).toBe('CONNECTED');
    });

    it('filter=failed returns only vendors with a failed deployment', async () => {
      const response = await getReq(app, '/api/admin/vendors?filter=failed', admin.cookie);
      const body = response.json() as { vendors: { organizationId: string }[] };
      const ids = body.vendors.map((v) => v.organizationId);
      expect(ids).toContain(orgA.organizationId);
      expect(ids).toContain(orgB.organizationId);
      expect(ids).not.toContain(vendorUser.organizationId);
    });

    it('filter=disconnected returns only vendors whose worst connection is DISCONNECTED', async () => {
      const response = await getReq(app, '/api/admin/vendors?filter=disconnected', admin.cookie);
      const body = response.json() as { vendors: { organizationId: string }[] };
      const ids = body.vendors.map((v) => v.organizationId);
      expect(ids).toContain(orgA.organizationId);
      expect(ids).not.toContain(orgB.organizationId);
    });

    it('q matches owner email', async () => {
      const byOwnerEmail = await getReq(app, `/api/admin/vendors?q=${encodeURIComponent(orgA.email)}`, admin.cookie);
      const byOwnerIds = (byOwnerEmail.json() as { vendors: { organizationId: string }[] }).vendors.map(
        (v) => v.organizationId,
      );
      expect(byOwnerIds).toEqual([orgA.organizationId]);
    });

    it('q matches org name and slug', async () => {
      const byName = await getReq(app, `/api/admin/vendors?q=${encodeURIComponent(orgA.name)}`, admin.cookie);
      const byNameIds = (byName.json() as { vendors: { organizationId: string }[] }).vendors.map((v) => v.organizationId);
      expect(byNameIds).toContain(orgA.organizationId);
    });
  });

  describe('GET /api/admin/vendors/:id', () => {
    it('returns the 360° detail shape', async () => {
      const response = await getReq(app, `/api/admin/vendors/${orgA.organizationId}`, admin.cookie);
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        organization: { id: string; name: string };
        members: { userId: string; email: string; role: string }[];
        applications: { id: string; deploymentCount: number }[];
        deployments: { id: string }[];
        connections: { deploymentId: string }[];
        recentEvents: { eventType: string }[];
      };

      expect(body.organization.id).toBe(orgA.organizationId);
      const owner = body.members.find((m) => m.role === 'owner');
      expect(owner?.email).toBe(orgA.email);

      expect(body.applications).toHaveLength(1);
      expect(body.applications[0]!.deploymentCount).toBe(5);

      expect(body.deployments).toHaveLength(5);
      expect(body.connections).toHaveLength(5);
      expect(body.recentEvents.length).toBeGreaterThanOrEqual(2);
    });

    it('404s for an unknown vendor id', async () => {
      const response = await getReq(app, `/api/admin/vendors/${crypto.randomUUID()}`, admin.cookie);
      expect(response.statusCode).toBe(404);
    });
  });
});
