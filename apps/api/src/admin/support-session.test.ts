import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from '../auth.js';
import { buildServer } from '../server.js';

// ── Shared test helpers (matches organizations.test.ts style) ──────────────

/** Signs up a fresh user, which provisions its own vendor org (auth.ts session hook). */
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
  if (!setCookie) {
    throw new Error('sign-in did not set a session cookie');
  }
  const memberships = await db
    .select({ organizationId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, signup.user.id))
    .limit(1);
  const organizationId = memberships[0]?.organizationId;
  if (!organizationId) {
    throw new Error('signup did not provision an organization');
  }
  return { userId: signup.user.id, organizationId, cookie: setCookie, email, name };
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

function postJson(app: FastifyInstance, url: string, body: unknown, extraHeaders: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    payload: JSON.stringify(body),
  });
}

function deleteReq(app: FastifyInstance, url: string, extraHeaders: Record<string, string> = {}) {
  return app.inject({ method: 'DELETE', url, headers: extraHeaders });
}

function getReq(app: FastifyInstance, url: string, extraHeaders: Record<string, string> = {}) {
  return app.inject({ method: 'GET', url, headers: extraHeaders });
}

// docs/admin/team-admin.md — Authorization model + View as Vendor security model.
describe('Team Admin: requireTeamAdmin + support-session lifecycle', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  // env grants ON — the E2E/local-dev configuration.
  let appEnvGrants: FastifyInstance;
  // env grants OFF — the deployed-Lambda configuration.
  let appNoEnvGrants: FastifyInstance;

  let vendor: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let admin: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let envAdmin: Awaited<ReturnType<typeof signUpAndGetOrg>>;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);

    vendor = await signUpAndGetOrg(auth, db, `vendor-${crypto.randomUUID()}@example.com`);
    admin = await signUpAndGetOrg(auth, db, `admin-${crypto.randomUUID()}@example.com`);
    envAdmin = await signUpAndGetOrg(auth, db, `env-admin-${crypto.randomUUID()}@example.com`);

    await db.update(schema.user).set({ platformRole: 'ADMIN' }).where(eq(schema.user.id, admin.userId));

    appEnvGrants = await buildServer({
      auth,
      db,
      teamAdminEmails: [envAdmin.email],
      teamAdminEnvGrantsEnabled: true,
    });
    appNoEnvGrants = await buildServer({
      auth,
      db,
      teamAdminEmails: [envAdmin.email],
      teamAdminEnvGrantsEnabled: false,
    });
  }, 60_000);

  afterAll(async () => {
    await appEnvGrants?.close();
    await appNoEnvGrants?.close();
    await client?.close();
  });

  it('a normal vendor user gets 403 NOT_TEAM_ADMIN on an admin route', async () => {
    const response = await postJson(
      appEnvGrants,
      `/api/admin/vendors/${vendor.organizationId}/support-session`,
      {},
      { cookie: vendor.cookie },
    );
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('NOT_TEAM_ADMIN');
  });

  it('a platformRole=ADMIN user passes the admin check', async () => {
    const response = await postJson(
      appEnvGrants,
      `/api/admin/vendors/${vendor.organizationId}/support-session`,
      {},
      { cookie: admin.cookie },
    );
    expect(response.statusCode).toBe(200);
    await deleteReq(appEnvGrants, '/api/admin/support-session', { cookie: admin.cookie });
  });

  it('an env-allowlisted user passes only while env grants are enabled', async () => {
    const enabled = await postJson(
      appEnvGrants,
      `/api/admin/vendors/${vendor.organizationId}/support-session`,
      {},
      { cookie: envAdmin.cookie },
    );
    expect(enabled.statusCode).toBe(200);
    await deleteReq(appEnvGrants, '/api/admin/support-session', { cookie: envAdmin.cookie });

    const disabled = await postJson(
      appNoEnvGrants,
      `/api/admin/vendors/${vendor.organizationId}/support-session`,
      {},
      { cookie: envAdmin.cookie },
    );
    expect(disabled.statusCode).toBe(403);
    expect(disabled.json().error.code).toBe('NOT_TEAM_ADMIN');
  });

  it('starting a support session sets the session pointer, reflects in /api/me, and writes an audit event', async () => {
    const start = await postJson(
      appEnvGrants,
      `/api/admin/vendors/${vendor.organizationId}/support-session`,
      {},
      { cookie: admin.cookie },
    );
    expect(start.statusCode).toBe(200);
    const startBody = start.json() as { organizationId: string; organizationName: string };
    expect(startBody.organizationId).toBe(vendor.organizationId);

    const me = await getReq(appEnvGrants, '/api/me', { cookie: admin.cookie });
    const meBody = me.json() as {
      organization: { id: string } | null;
      role: string | null;
      isTeamAdmin: boolean;
      supportMode: { organizationId: string; organizationName: string } | null;
    };
    expect(meBody.organization?.id).toBe(vendor.organizationId);
    expect(meBody.role).toBe('member');
    expect(meBody.isTeamAdmin).toBe(true);
    expect(meBody.supportMode).toEqual({
      organizationId: vendor.organizationId,
      organizationName: startBody.organizationName,
    });

    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.eventType, 'admin.support_session.started'));
    const event = events.find(
      (e) => e.organizationId === vendor.organizationId && e.actorId === admin.userId,
    );
    expect(event).toBeTruthy();
    expect((event!.payload as { adminEmail?: string }).adminEmail).toBe(admin.email);
  });

  it('read-only enforcement: vendor writes are rejected, vendor reads and admin routes still work', async () => {
    await insertCustomer(db, vendor.organizationId, { name: 'Support-visible customer' });

    const write = await postJson(
      appEnvGrants,
      '/api/customers',
      { name: 'blocked', email: 'blocked@example.com' },
      { cookie: admin.cookie },
    );
    expect(write.statusCode).toBe(403);
    expect(write.json().error.code).toBe('SUPPORT_MODE_READ_ONLY');

    const read = await getReq(appEnvGrants, '/api/customers', { cookie: admin.cookie });
    expect(read.statusCode).toBe(200);
    const customers = (read.json() as { customers: Array<{ organizationId: string }> }).customers;
    expect(customers.length).toBeGreaterThan(0);
    expect(customers.every((c) => c.organizationId === vendor.organizationId)).toBe(true);

    // Admin routes (even non-GET) stay reachable in support mode.
    const restart = await postJson(
      appEnvGrants,
      `/api/admin/vendors/${vendor.organizationId}/support-session`,
      {},
      { cookie: admin.cookie },
    );
    expect(restart.statusCode).toBe(200);
  });

  it('exiting clears the session pointer, restores /api/me, and writes an audit event', async () => {
    const exit = await deleteReq(appEnvGrants, '/api/admin/support-session', { cookie: admin.cookie });
    expect(exit.statusCode).toBe(204);

    const me = await getReq(appEnvGrants, '/api/me', { cookie: admin.cookie });
    const meBody = me.json() as { organization: { id: string } | null; supportMode: unknown };
    expect(meBody.organization?.id).toBe(admin.organizationId);
    expect(meBody.supportMode).toBeNull();

    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.eventType, 'admin.support_session.ended'));
    const event = events.find(
      (e) => e.organizationId === vendor.organizationId && e.actorId === admin.userId,
    );
    expect(event).toBeTruthy();

    // Idempotent: exiting again with nothing active writes no new audit row.
    const secondExit = await deleteReq(appEnvGrants, '/api/admin/support-session', { cookie: admin.cookie });
    expect(secondExit.statusCode).toBe(204);
    const eventsAfter = await db
      .select()
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.eventType, 'admin.support_session.ended'));
    expect(eventsAfter.length).toBe(events.length);
  });

  it('a non-admin session with support_organization_id set directly in the DB is ignored', async () => {
    await db
      .update(schema.session)
      .set({ supportOrganizationId: vendor.organizationId })
      .where(eq(schema.session.userId, envAdmin.userId));

    // Under appNoEnvGrants, envAdmin does not pass the platform-admin check.
    const me = await getReq(appNoEnvGrants, '/api/me', { cookie: envAdmin.cookie });
    const meBody = me.json() as { organization: { id: string } | null; supportMode: unknown };
    expect(meBody.organization?.id).toBe(envAdmin.organizationId);
    expect(meBody.supportMode).toBeNull();

    await db
      .update(schema.session)
      .set({ supportOrganizationId: null })
      .where(eq(schema.session.userId, envAdmin.userId));
  });
});
