import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { errorEnvelopeSchema } from '@deployz/contracts';
import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import { env } from './env.js';
import { ApiError } from './errors.js';
import { createRequireAuth } from './require-auth.js';
import { buildServer } from './server.js';

// ── Shared test helpers (used by the describe blocks below) ────────────────

/** Signs up a fresh user, which provisions its own vendor org (auth.ts session hook). */
async function signUpAndGetOrg(
  auth: Auth,
  db: Db,
  email: string,
): Promise<{ userId: string; organizationId: string; cookie: string }> {
  const password = 'super-secret-1';
  const signup = await auth.api.signUpEmail({ body: { email, password, name: email.split('@')[0]! } });
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
  return { userId: signup.user.id, organizationId, cookie: setCookie };
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
      repoFullName: 'acme/test-app',
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
      version: 'v1.0.0',
      gitSha: 'a1b2c3d',
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
      ...overrides,
    })
    .returning();
  return row!;
}

/** POST/PATCH/PUT a JSON body through app.inject, matching server.ts's raw-string JSON parser. */
function sendJson(
  app: FastifyInstance,
  method: 'POST' | 'PUT' | 'PATCH',
  url: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
) {
  return app.inject({
    method,
    url,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    payload: JSON.stringify(body),
  });
}

function postJson(
  app: FastifyInstance,
  url: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
) {
  return sendJson(app, 'POST', url, body, extraHeaders);
}

// Fastify base over a fresh in-memory PGlite (real Postgres semantics, full
// migrations). One signup in beforeAll; every assertion goes through
// app.inject against the real server with probe routes exercising the todo-4
// surface: auth middleware, ApiError envelope mapping, unknown-error
// containment.
describe('server (Fastify base over PGlite)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let cookie: string;
  let userId: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);

    const email = 'grace@example.com';
    const password = 'super-secret-1';
    const signup = await auth.api.signUpEmail({
      body: { email, password, name: 'Grace' },
    });
    userId = signup.user.id;
    const signin = await auth.api.signInEmail({
      body: { email, password },
      asResponse: true,
    });
    const setCookie = signin.headers.get('set-cookie');
    if (!setCookie) {
      throw new Error('sign-in did not set a session cookie');
    }
    cookie = setCookie;

    app = await buildServer({ auth, db });

    const requireAuth = createRequireAuth({ auth, db });
    app.get('/api/probe-auth', { preHandler: requireAuth }, async (request) => ({
      userId: request.user?.id ?? null,
      organizationId: request.organization?.id ?? null,
    }));
    app.get('/api/probe-api-error', async () => {
      throw new ApiError(422, 'PORT_MISMATCH', 'Port 8080 is not exposed by the image', {
        port: 8080,
      });
    });
    app.get('/api/probe-unknown-error', async () => {
      throw new Error('hunter2-internal-db-password');
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('GET /health returns 200', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
  });

  // The browser writes config with PUT and renames the org with PATCH. The
  // @fastify/cors default is GET,HEAD,POST, which fails both preflights and
  // makes those saves silently impossible from the dashboard.
  it.each(['PUT', 'PATCH', 'POST', 'GET'])(
    'CORS preflight allows %s from the web origin',
    async (method) => {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/api/organization',
        headers: {
          origin: env.webUrl,
          'access-control-request-method': method,
        },
      });
      expect(response.headers['access-control-allow-methods']).toContain(method);
      expect(response.headers['access-control-allow-origin']).toBe(env.webUrl);
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    },
  );

  it('GET /api/me without a session returns 401 as a structured envelope', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/me' });
    expect(response.statusCode).toBe(401);
    const envelope = errorEnvelopeSchema.parse(response.json());
    expect(envelope.error.code).toBe('UNAUTHORIZED');
  });

  it('GET /api/me with a session cookie returns 200 with the user', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { user: { email: string } };
    expect(body.user.email).toBe('grace@example.com');
  });

  it('protected probe resolves user + organization from the session cookie', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/probe-auth',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { userId: string; organizationId: string };
    expect(body.userId).toBe(userId);
    expect(body.organizationId).toBeTruthy();
  });

  it('ApiError renders as its code/message/details envelope', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/probe-api-error' });
    expect(response.statusCode).toBe(422);
    const envelope = errorEnvelopeSchema.parse(response.json());
    expect(envelope.error.code).toBe('PORT_MISMATCH');
    expect(envelope.error.message).toBe('Port 8080 is not exposed by the image');
    expect(envelope.error.details).toStrictEqual({ port: 8080 });
  });

  it('unknown errors render 500 INTERNAL_ERROR without leaking internals', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/probe-unknown-error' });
    expect(response.statusCode).toBe(500);
    const body = response.json() as unknown;
    const envelope = errorEnvelopeSchema.parse(body);
    expect(envelope.error.code).toBe('INTERNAL_ERROR');
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('hunter2-internal-db-password');
    expect(serialized).not.toContain('at '); // no stack frames
  });
});

// ── §1: organization identity comes from the session, never the client ─────
describe('server — organization identity comes from the session, not the client (§1)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let orgA: { userId: string; organizationId: string; cookie: string };
  let orgB: { userId: string; organizationId: string; cookie: string };

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    orgA = await signUpAndGetOrg(auth, db, 'org-a@example.com');
    orgB = await signUpAndGetOrg(auth, db, 'org-b@example.com');
    app = await buildServer({ auth, db });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('GET /api/applications ignores a spoofed ?organizationId query param', async () => {
    await insertApplication(db, orgA.organizationId, { name: 'Org A App' });
    await insertApplication(db, orgB.organizationId, { name: 'Org B App' });

    const response = await app.inject({
      method: 'GET',
      url: `/api/applications?organizationId=${orgB.organizationId}`,
      headers: { cookie: orgA.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { applications: Array<{ name: string }> };
    expect(body.applications.map((a) => a.name)).toEqual(['Org A App']);
  });

  it('POST /api/applications with no body.organizationId lands in the session org', async () => {
    const response = await postJson(
      app,
      '/api/applications',
      {
        name: 'No Org Field App',
        githubInstallationId: 'inst-1',
        repoFullName: 'acme/no-org-field',
        repoUrl: 'https://github.com/acme/no-org-field',
        defaultBranch: 'main',
      },
      { cookie: orgA.cookie },
    );
    expect(response.statusCode).toBe(201);
    expect((response.json() as { organizationId: string }).organizationId).toBe(orgA.organizationId);
  });

  it('POST /api/applications 403s when body.organizationId disagrees with the session', async () => {
    const response = await postJson(
      app,
      '/api/applications',
      {
        organizationId: orgB.organizationId,
        name: 'Spoofed Org App',
        githubInstallationId: 'inst-2',
        repoFullName: 'acme/spoofed',
        repoUrl: 'https://github.com/acme/spoofed',
        defaultBranch: 'main',
      },
      { cookie: orgA.cookie },
    );
    expect(response.statusCode).toBe(403);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('ORGANIZATION_MISMATCH');
  });

  it('POST /api/customers 403s on a cross-org body.organizationId, succeeds when it matches the session', async () => {
    const mismatch = await postJson(
      app,
      '/api/customers',
      { organizationId: orgB.organizationId, name: 'Spoofed Customer', email: 'spoofed@example.com' },
      { cookie: orgA.cookie },
    );
    expect(mismatch.statusCode).toBe(403);

    const ok = await postJson(
      app,
      '/api/customers',
      { organizationId: orgA.organizationId, name: 'Real Customer', email: 'real@example.com' },
      { cookie: orgA.cookie },
    );
    expect(ok.statusCode).toBe(201);
    expect((ok.json() as { organizationId: string }).organizationId).toBe(orgA.organizationId);
  });

  it('POST /api/deployments 403s on a cross-org body.organizationId (never silently inserts under the client-asserted org)', async () => {
    const application = await insertApplication(db, orgA.organizationId);
    const customer = await insertCustomer(db, orgA.organizationId);

    const response = await postJson(
      app,
      '/api/deployments',
      {
        applicationId: application.id,
        customerId: customer.id,
        organizationId: orgB.organizationId, // spoofed
        region: 'us-east-1',
      },
      { cookie: orgA.cookie },
    );
    expect(response.statusCode).toBe(403);
  });

  it('POST /api/deployments with the correct (or no) organizationId inserts under the session org', async () => {
    const application = await insertApplication(db, orgA.organizationId);
    const customer = await insertCustomer(db, orgA.organizationId);

    const response = await postJson(
      app,
      '/api/deployments',
      { applicationId: application.id, customerId: customer.id, region: 'us-east-1' },
      { cookie: orgA.cookie },
    );
    expect(response.statusCode).toBe(201);
    expect((response.json() as { organizationId: string }).organizationId).toBe(orgA.organizationId);
  });

  it('POST /api/deployments 404s for a well-formed but non-existent applicationId (not a 500)', async () => {
    const customer = await insertCustomer(db, orgA.organizationId);

    const response = await postJson(
      app,
      '/api/deployments',
      {
        applicationId: '00000000-0000-4000-8000-000000000000',
        customerId: customer.id,
        region: 'us-east-1',
      },
      { cookie: orgA.cookie },
    );
    expect(response.statusCode).toBe(404);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
  });

  it('POST /api/deployments 404s for a well-formed but non-existent customerId (not a 500)', async () => {
    const application = await insertApplication(db, orgA.organizationId);

    const response = await postJson(
      app,
      '/api/deployments',
      {
        applicationId: application.id,
        customerId: '00000000-0000-4000-8000-000000000001',
        region: 'us-east-1',
      },
      { cookie: orgA.cookie },
    );
    expect(response.statusCode).toBe(404);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
  });

  it('POST /api/deployments 404s for an applicationId that belongs to another org', async () => {
    const otherOrgApplication = await insertApplication(db, orgB.organizationId);
    const customer = await insertCustomer(db, orgA.organizationId);

    const response = await postJson(
      app,
      '/api/deployments',
      {
        applicationId: otherOrgApplication.id,
        customerId: customer.id,
        region: 'us-east-1',
      },
      { cookie: orgA.cookie },
    );
    expect(response.statusCode).toBe(404);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
  });

  it('POST /api/deployments 404s for a customerId that belongs to another org', async () => {
    const application = await insertApplication(db, orgA.organizationId);
    const otherOrgCustomer = await insertCustomer(db, orgB.organizationId);

    const response = await postJson(
      app,
      '/api/deployments',
      {
        applicationId: application.id,
        customerId: otherOrgCustomer.id,
        region: 'us-east-1',
      },
      { cookie: orgA.cookie },
    );
    expect(response.statusCode).toBe(404);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
  });

  it('POST /api/billing/checkout 403s on a cross-org body.organizationId', async () => {
    const response = await postJson(app, '/api/billing/checkout', { organizationId: orgB.organizationId }, { cookie: orgA.cookie });
    expect(response.statusCode).toBe(403);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('ORGANIZATION_MISMATCH');
  });
});

// ── §2: IDOR guards on every :id route ──────────────────────────────────────
describe('server — IDOR guards on :id routes (§2)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let orgA: { userId: string; organizationId: string; cookie: string };
  let orgB: { userId: string; organizationId: string; cookie: string };
  let appB: typeof schema.applications.$inferSelect;
  let depB: typeof schema.deployments.$inferSelect;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    orgA = await signUpAndGetOrg(auth, db, 'idor-a@example.com');
    orgB = await signUpAndGetOrg(auth, db, 'idor-b@example.com');
    app = await buildServer({ auth, db });

    appB = await insertApplication(db, orgB.organizationId, { name: 'Org B App' });
    const customerB = await insertCustomer(db, orgB.organizationId);
    depB = await insertDeployment(db, orgB.organizationId, appB.id, customerB.id, { state: 'HEALTHY' });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  const routes: Array<[string, () => string]> = [
    ['GET', () => `/api/applications/${appB.id}`],
    ['POST', () => `/api/applications/${appB.id}/analyse`],
    ['GET', () => `/api/applications/${appB.id}/readiness`],
    ['GET', () => `/api/applications/${appB.id}/config`],
    ['PUT', () => `/api/applications/${appB.id}/config`],
    ['POST', () => `/api/applications/${appB.id}/releases`],
    ['GET', () => `/api/applications/${appB.id}/releases`],
    ['GET', () => `/api/deployments/${depB.id}`],
    ['POST', () => `/api/deployments/${depB.id}/deploy`],
    ['POST', () => `/api/deployments/${depB.id}/rollback`],
    ['POST', () => `/api/deployments/${depB.id}/destroy`],
    ['GET', () => `/api/deployments/${depB.id}/events`],
    ['GET', () => `/api/deployments/${depB.id}/diagnostics`],
    ['PATCH', () => `/api/applications/${appB.id}`],
    ['DELETE', () => `/api/applications/${appB.id}`],
  ];

  it.each(routes)('%s %s 404s for a caller outside the owning org (never leaks existence)', async (method, urlFn) => {
    const response = await app.inject({
      method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      url: urlFn(),
      headers:
        method === 'GET' || method === 'DELETE'
          ? { cookie: orgA.cookie }
          : { cookie: orgA.cookie, 'content-type': 'application/json' },
      payload:
        method === 'GET' || method === 'DELETE'
          ? undefined
          : JSON.stringify({ releaseId: crypto.randomUUID(), version: '1.0.0', gitSha: 'abc', entries: [] }),
    });
    expect(response.statusCode).toBe(404);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
  });

  it('the owning org CAN reach its own application and deployment (the guard is not over-broad)', async () => {
    const appResponse = await app.inject({
      method: 'GET',
      url: `/api/applications/${appB.id}`,
      headers: { cookie: orgB.cookie },
    });
    expect(appResponse.statusCode).toBe(200);

    const depResponse = await app.inject({
      method: 'GET',
      url: `/api/deployments/${depB.id}`,
      headers: { cookie: orgB.cookie },
    });
    expect(depResponse.statusCode).toBe(200);
  });
});

// ── §36/§37: PATCH and DELETE /api/applications/:id ─────────────────────────
describe('server — PATCH/DELETE /api/applications/:id (§36,§37)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, 'patch-delete@example.com');
    app = await buildServer({ auth, db });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('PATCH updates a field and returns 200 with the new value', async () => {
    const application = await insertApplication(db, org.organizationId);
    const response = await sendJson(app, 'PATCH', `/api/applications/${application.id}`, { name: 'New Name' }, { cookie: org.cookie });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { name: string }).name).toBe('New Name');
  });

  it('PATCH with empty name returns 400 VALIDATION_ERROR', async () => {
    const application = await insertApplication(db, org.organizationId);
    const response = await sendJson(app, 'PATCH', `/api/applications/${application.id}`, { name: '' }, { cookie: org.cookie });
    expect(response.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('PATCH with empty body returns 200 with unchanged row', async () => {
    const application = await insertApplication(db, org.organizationId, { name: 'Original Name' });
    const response = await sendJson(app, 'PATCH', `/api/applications/${application.id}`, {}, { cookie: org.cookie });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { name: string }).name).toBe('Original Name');
  });

  it('PATCH with healthPath: null clears the field', async () => {
    const application = await insertApplication(db, org.organizationId, { healthPath: '/health' });
    const response = await sendJson(app, 'PATCH', `/api/applications/${application.id}`, { healthPath: null }, { cookie: org.cookie });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { healthPath: string | null }).healthPath).toBeNull();
  });

  it('PATCH with databaseRequired: null returns 400 VALIDATION_ERROR', async () => {
    const application = await insertApplication(db, org.organizationId);
    const response = await sendJson(app, 'PATCH', `/api/applications/${application.id}`, { databaseRequired: null }, { cookie: org.cookie });
    expect(response.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('PATCH with identity-locked field silently ignores it', async () => {
    const application = await insertApplication(db, org.organizationId, { repoFullName: 'acme/test-app' });
    const response = await sendJson(app, 'PATCH', `/api/applications/${application.id}`, { repoFullName: 'evil/repo' }, { cookie: org.cookie });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { repoFullName: string }).repoFullName).toBe('acme/test-app');
  });

  it('PATCH with non-uuid id returns 404 NOT_FOUND', async () => {
    const response = await sendJson(app, 'PATCH', '/api/applications/not-a-uuid', { name: 'test' }, { cookie: org.cookie });
    expect(response.statusCode).toBe(404);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
  });

  it('PATCH sets updatedBy to the session user id', async () => {
    const application = await insertApplication(db, org.organizationId);
    const response = await sendJson(app, 'PATCH', `/api/applications/${application.id}`, { name: 'Updated' }, { cookie: org.cookie });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { updatedBy: string | null }).updatedBy).toBe(org.userId);
  });

  it('DELETE removes the application and logs an event', async () => {
    const application = await insertApplication(db, org.organizationId, { name: 'To Delete' });
    const response = await app.inject({ method: 'DELETE', url: `/api/applications/${application.id}`, headers: { cookie: org.cookie } });
    expect(response.statusCode).toBe(204);

    const rows = await db.select().from(schema.applications).where(eq(schema.applications.id, application.id));
    expect(rows).toHaveLength(0);

    const events = await db.select().from(schema.eventLogs).where(eq(schema.eventLogs.eventType, 'APPLICATION_DELETED'));
    expect(events.length).toBeGreaterThanOrEqual(1);
    const deleteEvent = events[events.length - 1]!;
    expect((deleteEvent.payload as { applicationName?: string }).applicationName).toBe('To Delete');
  });

  it('DELETE with a deployment returns 409 APPLICATION_HAS_DEPLOYMENTS', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    await insertDeployment(db, org.organizationId, application.id, customer.id);

    const response = await app.inject({ method: 'DELETE', url: `/api/applications/${application.id}`, headers: { cookie: org.cookie } });
    expect(response.statusCode).toBe(409);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('APPLICATION_HAS_DEPLOYMENTS');

    const rows = await db.select().from(schema.applications).where(eq(schema.applications.id, application.id));
    expect(rows).toHaveLength(1);
  });

  it('DELETE cascades releases when there are no deployments', async () => {
    const application = await insertApplication(db, org.organizationId);
    await insertRelease(db, application.id);

    const response = await app.inject({ method: 'DELETE', url: `/api/applications/${application.id}`, headers: { cookie: org.cookie } });
    expect(response.statusCode).toBe(204);

    const releases = await db.select().from(schema.releases).where(eq(schema.releases.applicationId, application.id));
    expect(releases).toHaveLength(0);
  });

  it('DELETE is idempotent — second call returns 404', async () => {
    const application = await insertApplication(db, org.organizationId);
    const first = await app.inject({ method: 'DELETE', url: `/api/applications/${application.id}`, headers: { cookie: org.cookie } });
    expect(first.statusCode).toBe(204);

    const second = await app.inject({ method: 'DELETE', url: `/api/applications/${application.id}`, headers: { cookie: org.cookie } });
    expect(second.statusCode).toBe(404);
    expect(errorEnvelopeSchema.parse(second.json()).error.code).toBe('NOT_FOUND');
  });

  it('DELETE with non-uuid id returns 404 NOT_FOUND', async () => {
    const response = await app.inject({ method: 'DELETE', url: '/api/applications/not-a-uuid', headers: { cookie: org.cookie } });
    expect(response.statusCode).toBe(404);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
  });
});

// ── §3/§4/§6: relay bearer auth, INSTALL job creation, command/result/health ─
describe('server — relay bearer auth, INSTALL job, and command/result/health flow (§3,§4,§6)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };
  let deployment: typeof schema.deployments.$inferSelect;
  const RELAY_TOKEN = 'relay-token-abc123';

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, 'relay-org@example.com');
    app = await buildServer({ auth, db });

    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'NOT_INSTALLED',
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('POST /api/relay/register without a bearer token is rejected', async () => {
    const response = await postJson(app, '/api/relay/register', { installationId: deployment.installationId });
    expect(response.statusCode).toBe(401);
  });

  it('POST /api/relay/register 404s for an installationId with no matching deployment', async () => {
    const response = await postJson(
      app,
      '/api/relay/register',
      { installationId: 'not-a-real-installation' },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(response.statusCode).toBe(404);
  });

  it('registers the token, creates the INSTALL job, and moves the deployment to INSTALLING (§6)', async () => {
    const response = await postJson(
      app,
      '/api/relay/register',
      { installationId: deployment.installationId },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(response.statusCode).toBe(200);

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(dep!.state).toBe('INSTALLING');

    const jobs = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.type).toBe('INSTALL');
    expect(jobs[0]!.state).toBe('REQUESTED');
  });

  it('re-registering the same installation does not create a second INSTALL job', async () => {
    await postJson(
      app,
      '/api/relay/register',
      { installationId: deployment.installationId },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(and(eq(schema.deploymentJobs.deploymentId, deployment.id), eq(schema.deploymentJobs.type, 'INSTALL')));
    expect(jobs).toHaveLength(1);
  });

  it('GET /api/relay/commands rejects a wrong bearer token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/relay/commands?installationId=${deployment.installationId}`,
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns the pending INSTALL command and moves it to RUNNING', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/relay/commands?installationId=${deployment.installationId}`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { commands: Array<{ id: string; type: string; deploymentId: string }> };
    expect(body.commands).toHaveLength(1);
    expect(body.commands[0]!.type).toBe('INSTALL');
    expect(body.commands[0]!.deploymentId).toBe(deployment.id);

    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, body.commands[0]!.id));
    expect(job!.state).toBe('RUNNING');
    expect(job!.startedAt).not.toBeNull();
  });

  it('a second poll returns no commands (the job already left REQUESTED/QUEUED)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/relay/commands?installationId=${deployment.installationId}`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
    });
    expect((response.json() as { commands: unknown[] }).commands).toHaveLength(0);
  });

  it('POST /api/relay/commands/:id/result rejects a wrong bearer token', async () => {
    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    const response = await postJson(app, `/api/relay/commands/${job!.id}/result`, { success: true }, { authorization: 'Bearer wrong-token' });
    expect(response.statusCode).toBe(401);
  });

  it('success:true marks the job SUCCEEDED and stores the result/finishedAt', async () => {
    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    const response = await postJson(
      app,
      `/api/relay/commands/${job!.id}/result`,
      { success: true, output: { foo: 'bar' } },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(response.statusCode).toBe(200);

    const [updated] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, job!.id));
    expect(updated!.state).toBe('SUCCEEDED');
    expect(updated!.finishedAt).not.toBeNull();
    expect(updated!.result).toMatchObject({ success: true, output: { foo: 'bar' } });
  });

  it('success:false with a valid failureCode marks the job FAILED with that code', async () => {
    const [freshJob] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: deployment.id,
        type: 'DEPLOY_RELEASE',
        state: 'RUNNING',
        idempotencyKey: `${deployment.id}:DEPLOY_RELEASE:test-fail`,
        payload: {},
      })
      .returning();

    const response = await postJson(
      app,
      `/api/relay/commands/${freshJob!.id}/result`,
      { success: false, error: 'boom', failureCode: 'IMAGE_PULL_FAILED' },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(response.statusCode).toBe(200);

    const [updated] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, freshJob!.id));
    expect(updated!.state).toBe('FAILED');
    expect(updated!.failureCode).toBe('IMAGE_PULL_FAILED');
  });

  it('an invalid failureCode is dropped rather than persisted', async () => {
    const [freshJob] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: deployment.id,
        type: 'DEPLOY_RELEASE',
        state: 'RUNNING',
        idempotencyKey: `${deployment.id}:DEPLOY_RELEASE:test-fail-2`,
        payload: {},
      })
      .returning();

    await postJson(
      app,
      `/api/relay/commands/${freshJob!.id}/result`,
      { success: false, failureCode: 'NOT_A_REAL_CODE' },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );

    const [updated] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, freshJob!.id));
    expect(updated!.state).toBe('FAILED');
    expect(updated!.failureCode).toBeNull();
  });

  // §46: the relay reporting a finished command is what moves the deployment
  // itself. Without these transitions the fleet is stuck in INSTALLING, which
  // silently disables §25 bulk deploy, §29 diagnostics and §48 billing.
  it('a successful INSTALL moves the deployment to HEALTHY', async () => {
    const [installJob] = await db
      .select()
      .from(schema.deploymentJobs)
      .where(and(eq(schema.deploymentJobs.deploymentId, deployment.id), eq(schema.deploymentJobs.type, 'INSTALL')));

    await postJson(
      app,
      `/api/relay/commands/${installJob!.id}/result`,
      { success: true },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );

    const [updated] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(updated!.state).toBe('HEALTHY');
  });

  it('a successful DEPLOY_RELEASE moves to HEALTHY and advances the release pointers', async () => {
    const release = await insertRelease(db, deployment.applicationId, { version: 'v9.0.0' });
    const [before] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    const [job] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: deployment.id,
        type: 'DEPLOY_RELEASE',
        state: 'RUNNING',
        idempotencyKey: `${deployment.id}:DEPLOY_RELEASE:${release.id}`,
        payload: { releaseId: release.id },
      })
      .returning();

    await postJson(
      app,
      `/api/relay/commands/${job!.id}/result`,
      { success: true },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );

    const [updated] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(updated!.state).toBe('HEALTHY');
    expect(updated!.currentReleaseId).toBe(release.id);
    expect(updated!.previousReleaseId).toBe(before!.currentReleaseId);
  });

  it('a failed job moves the deployment to FAILED so diagnostics can classify it', async () => {
    const [job] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: deployment.id,
        type: 'DEPLOY_RELEASE',
        state: 'RUNNING',
        idempotencyKey: `${deployment.id}:DEPLOY_RELEASE:state-fail`,
        payload: {},
      })
      .returning();

    await postJson(
      app,
      `/api/relay/commands/${job!.id}/result`,
      { success: false, failureCode: 'IMAGE_HEALTH_CHECK_FAILED' },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );

    const [updated] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(updated!.state).toBe('FAILED');

    // §61: diagnostics must report the code the relay gave, not a hardcoded one.
    const diagnostics = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}/diagnostics`,
      headers: { cookie: org.cookie },
    });
    expect(diagnostics.statusCode).toBe(200);
    expect((diagnostics.json() as { failureCode: string }).failureCode).toBe('IMAGE_HEALTH_CHECK_FAILED');
  });

  // §29: the what/why/fix a failed deployment reports must come from the
  // deterministic remediation engine or the AI explainer — never a hardcoded
  // placeholder that says the same thing for every failure code.
  it('explains a failure with AI text when a gateway is configured', async () => {
    const aiApp = await buildServer({
      auth,
      db,
      aiGateway: {
        async generate() {
          return {
            object: {
              failureCode: 'IMAGE_HEALTH_CHECK_FAILED',
              what: 'The app started but never reported itself healthy.',
              why: 'The health check never passed.',
              fix: 'Check the health endpoint returns success.',
            },
            usage: { promptTokens: 20, completionTokens: 10 },
          };
        },
      },
    });
    // Set the failure state directly so the test does not depend on which
    // other tests in this file have already run.
    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment.id,
      type: 'DEPLOY_RELEASE',
      state: 'FAILED',
      failureCode: 'IMAGE_HEALTH_CHECK_FAILED',
      finishedAt: new Date(),
      idempotencyKey: `${deployment.id}:DEPLOY_RELEASE:ai-explained`,
      payload: {},
    });
    await db
      .update(schema.deployments)
      .set({ state: 'FAILED' })
      .where(eq(schema.deployments.id, deployment.id));

    const response = await aiApp.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}/diagnostics`,
      headers: { cookie: org.cookie },
    });

    const body = response.json() as { what: string; why: string; fix: string };
    expect(body.what).toBe('The app started but never reported itself healthy.');
    expect(body.fix).toBe('Check the health endpoint returns success.');
    await aiApp.close();
  });

  it('explains a failure with deterministic remediation when no gateway is configured', async () => {
    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment.id,
      type: 'DEPLOY_RELEASE',
      state: 'FAILED',
      failureCode: 'PORT_MISMATCH',
      finishedAt: new Date(),
      idempotencyKey: `${deployment.id}:DEPLOY_RELEASE:no-gateway`,
      payload: {},
    });
    await db
      .update(schema.deployments)
      .set({ state: 'FAILED' })
      .where(eq(schema.deployments.id, deployment.id));

    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}/diagnostics`,
      headers: { cookie: org.cookie },
    });

    const body = response.json() as { failureCode: string; what: string; fix: string };
    expect(body.failureCode).toBe('PORT_MISMATCH');
    // Code-specific guidance, not the old one-size-fits-all placeholder.
    expect(body.what).toContain('port');
    expect(body.what).not.toBe('Deployment failed');
    expect(body.fix.length).toBeGreaterThan(0);
  });

  // §31 config writes are non-disruptive — they must not disturb the lifecycle.
  it('a CONFIG_UPDATE result leaves the deployment state untouched', async () => {
    await db.update(schema.deployments).set({ state: 'HEALTHY' }).where(eq(schema.deployments.id, deployment.id));
    const [job] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: deployment.id,
        type: 'CONFIG_UPDATE',
        state: 'RUNNING',
        idempotencyKey: `${deployment.id}:CONFIG_UPDATE:1`,
        payload: {},
      })
      .returning();

    await postJson(
      app,
      `/api/relay/commands/${job!.id}/result`,
      { success: true },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );

    const [updated] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(updated!.state).toBe('HEALTHY');
  });

  it('a successful DESTROY marks the deployment DELETED and stamps deletedAt', async () => {
    const [job] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: deployment.id,
        type: 'DESTROY',
        state: 'RUNNING',
        idempotencyKey: `${deployment.id}:DESTROY`,
        payload: {},
      })
      .returning();

    await postJson(
      app,
      `/api/relay/commands/${job!.id}/result`,
      { success: true },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );

    const [updated] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(updated!.state).toBe('DELETED');
    expect(updated!.deletedAt).not.toBeNull();
  });

  it('POST /api/relay/health rejects a wrong bearer token', async () => {
    const response = await postJson(
      app,
      '/api/relay/health',
      { installationId: deployment.installationId, healthStatus: 'HEALTHY' },
      { authorization: 'Bearer wrong-token' },
    );
    expect(response.statusCode).toBe(401);
  });

  it('persists observedState/relayStatus/lastHealthAt/healthStatus from the relay payload', async () => {
    const response = await postJson(
      app,
      '/api/relay/health',
      { installationId: deployment.installationId, observedState: { tasksRunning: 2 }, healthStatus: 'DEGRADED' },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(response.statusCode).toBe(200);

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(dep!.relayStatus).toBe('CONNECTED');
    expect(dep!.healthStatus).toBe('DEGRADED');
    expect(dep!.observedState).toMatchObject({ tasksRunning: 2 });
    expect(dep!.lastHealthAt).not.toBeNull();
  });
});

// ── §5: idempotency ──────────────────────────────────────────────────────────
describe('server — idempotent job creation (§5)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };
  let deployment: typeof schema.deployments.$inferSelect;
  let applicationId: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, 'idem-org@example.com');
    app = await buildServer({ auth, db });

    const application = await insertApplication(db, org.organizationId);
    applicationId = application.id;
    const customer = await insertCustomer(db, org.organizationId);
    deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, { state: 'HEALTHY' });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('POST .../deploy twice with the same releaseId returns the SAME job (202 then 200), never a duplicate row', async () => {
    const releaseId = (await insertRelease(db, applicationId)).id;
    const first = await postJson(app, `/api/deployments/${deployment.id}/deploy`, { releaseId }, { cookie: org.cookie });
    expect(first.statusCode).toBe(202);
    const second = await postJson(app, `/api/deployments/${deployment.id}/deploy`, { releaseId }, { cookie: org.cookie });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { jobId: string }).jobId).toBe((first.json() as { jobId: string }).jobId);

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.idempotencyKey, `${deployment.id}:DEPLOY_RELEASE:${releaseId}`));
    expect(jobs).toHaveLength(1);
  });

  it('a different releaseId produces a different job', async () => {
    const r1 = await postJson(app, `/api/deployments/${deployment.id}/deploy`, { releaseId: (await insertRelease(db, applicationId)).id }, { cookie: org.cookie });
    const r2 = await postJson(app, `/api/deployments/${deployment.id}/deploy`, { releaseId: (await insertRelease(db, applicationId)).id }, { cookie: org.cookie });
    expect((r1.json() as { jobId: string }).jobId).not.toBe((r2.json() as { jobId: string }).jobId);
  });

  it('an Idempotency-Key header overrides the derived key', async () => {
    const first = await postJson(
      app,
      `/api/deployments/${deployment.id}/deploy`,
      { releaseId: (await insertRelease(db, applicationId)).id },
      { cookie: org.cookie, 'idempotency-key': 'client-supplied-key-1' },
    );
    expect(first.statusCode).toBe(202);

    const jobs = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.idempotencyKey, 'client-supplied-key-1'));
    expect(jobs).toHaveLength(1);

    // Same header, different releaseId — still the same idempotent operation.
    const second = await postJson(
      app,
      `/api/deployments/${deployment.id}/deploy`,
      { releaseId: (await insertRelease(db, applicationId)).id },
      { cookie: org.cookie, 'idempotency-key': 'client-supplied-key-1' },
    );
    expect(second.statusCode).toBe(200);
    expect((second.json() as { jobId: string }).jobId).toBe((first.json() as { jobId: string }).jobId);
  });

  it('POST .../rollback twice with the same target releaseId returns the SAME job', async () => {
    const releaseId = (await insertRelease(db, applicationId)).id;
    const first = await postJson(app, `/api/deployments/${deployment.id}/rollback`, { releaseId }, { cookie: org.cookie });
    const second = await postJson(app, `/api/deployments/${deployment.id}/rollback`, { releaseId }, { cookie: org.cookie });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect((second.json() as { jobId: string }).jobId).toBe((first.json() as { jobId: string }).jobId);
  });

  it('POST .../deploy and .../rollback 404 for a releaseId the application does not own', async () => {
    const otherApplication = await insertApplication(db, org.organizationId, { name: 'Foreign Release App' });
    const foreignRelease = await insertRelease(db, otherApplication.id);

    for (const action of ['deploy', 'rollback']) {
      const missing = await postJson(
        app,
        `/api/deployments/${deployment.id}/${action}`,
        { releaseId: crypto.randomUUID() },
        { cookie: org.cookie },
      );
      expect(missing.statusCode).toBe(404);

      const foreign = await postJson(
        app,
        `/api/deployments/${deployment.id}/${action}`,
        { releaseId: foreignRelease.id },
        { cookie: org.cookie },
      );
      expect(foreign.statusCode).toBe(404);
    }
  });

  it('POST .../destroy twice returns the SAME job (a double-click must not create two DESTROY jobs)', async () => {
    const first = await postJson(app, `/api/deployments/${deployment.id}/destroy`, {}, { cookie: org.cookie });
    const second = await postJson(app, `/api/deployments/${deployment.id}/destroy`, {}, { cookie: org.cookie });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect((second.json() as { jobId: string }).jobId).toBe((first.json() as { jobId: string }).jobId);

    const jobs = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.idempotencyKey, `${deployment.id}:DESTROY`));
    expect(jobs).toHaveLength(1);
  });
});

// ── §7/§8: fleet + detail joins, readiness derivation ───────────────────────
describe('server — fleet list & deployment detail joins, readiness derivation (§7,§8)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, 'fleet-org@example.com');
    app = await buildServer({ auth, db });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('GET /api/deployments carries customerName/applicationName/version/masked awsAccountId (§23/§24)', async () => {
    const application = await insertApplication(db, org.organizationId, { name: 'Analytics API' });
    const customer = await insertCustomer(db, org.organizationId, { name: 'Acme Corp' });
    const [release] = await db
      .insert(schema.releases)
      .values({ applicationId: application.id, version: '1.4.2', gitSha: 'deadbeef' })
      .returning();
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'HEALTHY',
      region: 'us-east-1',
      currentReleaseId: release!.id,
      awsAccountId: '123456789012',
    });

    const listResponse = await app.inject({ method: 'GET', url: '/api/deployments', headers: { cookie: org.cookie } });
    expect(listResponse.statusCode).toBe(200);
    const listBody = listResponse.json() as {
      deployments: Array<{
        id: string;
        customerName: string;
        applicationName: string;
        version: string | null;
        region: string;
        state: string;
        awsAccountId: string | null;
      }>;
    };
    const row = listBody.deployments.find((d) => d.id === deployment.id);
    expect(row).toBeDefined();
    expect(row!.customerName).toBe('Acme Corp');
    expect(row!.applicationName).toBe('Analytics API');
    expect(row!.version).toBe('1.4.2');
    expect(row!.region).toBe('us-east-1');
    expect(row!.state).toBe('HEALTHY');
    expect(row!.awsAccountId).toBe(`1234${'•'.repeat(8)}`);

    const detailResponse = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}`,
      headers: { cookie: org.cookie },
    });
    expect(detailResponse.statusCode).toBe(200);
    const detailBody = detailResponse.json() as {
      customerName: string;
      applicationName: string;
      version: string | null;
      jobs: unknown[];
    };
    expect(detailBody.customerName).toBe('Acme Corp');
    expect(detailBody.applicationName).toBe('Analytics API');
    expect(detailBody.version).toBe('1.4.2');
    expect(detailBody.jobs).toEqual([]);
  });

  it('version is null when the deployment has no current release', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id);

    const response = await app.inject({ method: 'GET', url: `/api/deployments/${deployment.id}`, headers: { cookie: org.cookie } });
    expect((response.json() as { version: string | null }).version).toBeNull();
  });

  it('readiness: analysis not COMPLETE returns analysisStatus instead of a fabricated score', async () => {
    const application = await insertApplication(db, org.organizationId, { analysisStatus: 'ANALYZING' });
    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/readiness`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({
      analysisStatus: 'ANALYZING',
      verdict: null,
      score: null,
      changesRequired: null,
      ready: [],
      needsAttention: [],
      unsupported: [],
    });
  });

  it('readiness: score is the ratio of satisfied checks, not a hardcoded constant', async () => {
    const application = await insertApplication(db, org.organizationId, {
      analysisStatus: 'COMPLETE',
      compatibilityStatus: 'NEEDS_ATTENTION',
      detectedMetadata: {
        checks: {
          ready: [{ label: 'Docker container detected' }, { label: 'PostgreSQL detected' }, { label: 'Port 3000 detected' }],
          needsAttention: [
            { title: 'Health endpoint missing', detail: 'Deployz requires an HTTP health endpoint.', suggestedFix: 'GET /health -> 200' },
            { title: 'Local file storage detected', detail: 'Files written to /uploads will disappear on restart.', suggestedFix: null },
          ],
          unsupported: [],
        },
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/readiness`,
      headers: { cookie: org.cookie },
    });
    const body = response.json() as {
      verdict: string;
      score: number;
      changesRequired: number;
      ready: unknown[];
      needsAttention: unknown[];
    };
    expect(body.verdict).toBe('NEEDS_ATTENTION');
    expect(body.score).toBe(60); // 3 ready / 5 total checks
    expect(body.changesRequired).toBe(2);
    expect(body.ready).toHaveLength(3);
    expect(body.needsAttention).toHaveLength(2);
  });

  it('readiness: NOT_COMPATIBLE with no persisted checks falls back to one unsupported entry from compatibilityReason', async () => {
    const application = await insertApplication(db, org.organizationId, {
      analysisStatus: 'COMPLETE',
      compatibilityStatus: 'NOT_COMPATIBLE',
      compatibilityReason: 'Persistent Redis is required.',
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/readiness`,
      headers: { cookie: org.cookie },
    });
    const body = response.json() as { verdict: string; score: number; unsupported: Array<{ title: string; reason: string }> };
    expect(body.verdict).toBe('NOT_COMPATIBLE');
    expect(body.score).toBe(0);
    expect(body.unsupported).toEqual([{ title: 'Not compatible', reason: 'Persistent Redis is required.' }]);
  });

  it('readiness: fully READY with no issues scores 100', async () => {
    const application = await insertApplication(db, org.organizationId, {
      analysisStatus: 'COMPLETE',
      compatibilityStatus: 'READY',
      detectedMetadata: { checks: { ready: [{ label: 'Docker container detected' }], needsAttention: [], unsupported: [] } },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/readiness`,
      headers: { cookie: org.cookie },
    });
    const body = response.json() as { verdict: string; score: number; changesRequired: number };
    expect(body.verdict).toBe('READY');
    expect(body.score).toBe(100);
    expect(body.changesRequired).toBe(0);
  });
});

// ── §18/§19: POST /:id/analyse wires the injectable analysis runner ────────
describe('server — POST /api/applications/:id/analyse wires ServerDeps.analysisRunner', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let org: { userId: string; organizationId: string; cookie: string };

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, 'analyse-org@example.com');
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('202s immediately, sets ANALYZING, and invokes the injected runner with the applicationId', async () => {
    const calls: string[] = [];
    const app = await buildServer({
      auth,
      db,
      analysisRunner: async (applicationId) => {
        calls.push(applicationId);
      },
    });
    try {
      const application = await insertApplication(db, org.organizationId);

      const response = await app.inject({
        method: 'POST',
        url: `/api/applications/${application.id}/analyse`,
        headers: { cookie: org.cookie },
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toStrictEqual({ status: 'ANALYZING' });

      const rows = await db
        .select({ analysisStatus: schema.applications.analysisStatus })
        .from(schema.applications)
        .where(eq(schema.applications.id, application.id));
      expect(rows[0]?.analysisStatus).toBe('ANALYZING');

      // The runner is fire-and-forget; give its microtask a tick to run.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls).toEqual([application.id]);
    } finally {
      await app.close();
    }
  });

  it('still 202s even when the injected runner rejects (defense-in-depth catch)', async () => {
    const app = await buildServer({
      auth,
      db,
      analysisRunner: async () => {
        throw new Error('boom — simulated runner failure');
      },
    });
    try {
      const application = await insertApplication(db, org.organizationId);

      const response = await app.inject({
        method: 'POST',
        url: `/api/applications/${application.id}/analyse`,
        headers: { cookie: org.cookie },
      });

      expect(response.statusCode).toBe(202);
      // Give the rejected background promise a tick — it must not surface
      // as an unhandled rejection or crash the process.
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      await app.close();
    }
  });
});

// ── §9: organization settings, public install page, bulk deploy ────────────
describe('server — organization settings, public install page, and bulk deploy (§9)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, 'org-settings@example.com');
    app = await buildServer({ auth, db });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('GET /api/organization requires auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/organization' });
    expect(response.statusCode).toBe(401);
  });

  it('GET /api/organization returns the session org', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/organization', headers: { cookie: org.cookie } });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { id: string; name: string; plan: string; createdAt: string };
    expect(body.id).toBe(org.organizationId);
    expect(body.plan).toBe('FREE');
    expect(typeof body.createdAt).toBe('string');
  });

  it('PATCH /api/organization updates the name', async () => {
    const patchResponse = await sendJson(app, 'PATCH', '/api/organization', { name: 'Renamed Org' }, { cookie: org.cookie });
    expect(patchResponse.statusCode).toBe(200);
    expect((patchResponse.json() as { name: string }).name).toBe('Renamed Org');

    const getResponse = await app.inject({ method: 'GET', url: '/api/organization', headers: { cookie: org.cookie } });
    expect((getResponse.json() as { name: string }).name).toBe('Renamed Org');
  });

  it('PATCH /api/organization rejects an empty name', async () => {
    const response = await sendJson(app, 'PATCH', '/api/organization', { name: '' }, { cookie: org.cookie });
    expect(response.statusCode).toBe(400);
  });

  it('GET /api/install/:installationId is public, unauthenticated, and returns only display fields (§12/§44)', async () => {
    const application = await insertApplication(db, org.organizationId, {
      name: 'Analytics Cloud',
      databaseRequired: true,
      storageRequired: false,
    });
    const customer = await insertCustomer(db, org.organizationId, { name: 'Acme Analytics' });
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      region: 'eu-west-1',
      awsAccountId: '999999999999',
    });
    const [orgRow] = await db.select().from(schema.organization).where(eq(schema.organization.id, org.organizationId));

    const response = await app.inject({ method: 'GET', url: `/api/install/${deployment.installationId}` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body).toStrictEqual({
      applicationName: 'Analytics Cloud',
      publisherName: orgRow!.name,
      customerName: 'Acme Analytics',
      region: 'eu-west-1',
      resourcesCreated: ['Application runtime', 'PostgreSQL database', 'Networking', 'Monitoring'],
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('999999999999');
    expect(serialized).not.toContain(deployment.id);
    expect(serialized).not.toContain(org.organizationId);
  });

  it('GET /api/install/:installationId 404s for an unknown installation', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/install/does-not-exist' });
    expect(response.statusCode).toBe(404);
  });

  it('POST /api/applications/:id/deploy-bulk fans out into individual per-deployment jobs and skips non-deployable states (§25)', async () => {
    const application = await insertApplication(db, org.organizationId, { name: 'Bulk App' });
    const customer = await insertCustomer(db, org.organizationId);
    const healthy1 = await insertDeployment(db, org.organizationId, application.id, customer.id, { state: 'HEALTHY' });
    const healthy2 = await insertDeployment(db, org.organizationId, application.id, customer.id, { state: 'UPDATE_AVAILABLE' });
    const installing = await insertDeployment(db, org.organizationId, application.id, customer.id, { state: 'INSTALLING' });
    const releaseId = (await insertRelease(db, application.id)).id;

    const response = await postJson(app, `/api/applications/${application.id}/deploy-bulk`, { releaseId }, { cookie: org.cookie });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { results: Array<{ deploymentId: string; status: string; jobId?: string }> };
    expect(body.results).toHaveLength(3);
    const byId = new Map(body.results.map((r) => [r.deploymentId, r]));
    expect(byId.get(healthy1.id)!.status).toBe('REQUESTED');
    expect(byId.get(healthy2.id)!.status).toBe('REQUESTED');
    expect(byId.get(installing.id)!.status).toBe('SKIPPED');

    // Never one aggregate job — one DEPLOY_RELEASE job per deployable target.
    const jobs = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.type, 'DEPLOY_RELEASE'));
    const jobDeploymentIds = jobs.map((j) => j.deploymentId).sort();
    expect(jobDeploymentIds).toEqual([healthy1.id, healthy2.id].sort());

    // Idempotent: calling again returns the SAME jobs, not new ones.
    const second = await postJson(app, `/api/applications/${application.id}/deploy-bulk`, { releaseId }, { cookie: org.cookie });
    const secondBody = second.json() as { results: Array<{ deploymentId: string; status: string }> };
    const secondById = new Map(secondBody.results.map((r) => [r.deploymentId, r]));
    expect(secondById.get(healthy1.id)!.status).toBe('ALREADY_REQUESTED');
  });

  it('POST /api/applications/:id/deploy-bulk with explicit deploymentIds only targets those', async () => {
    const application = await insertApplication(db, org.organizationId, { name: 'Selective Bulk App' });
    const customer = await insertCustomer(db, org.organizationId);
    const dep1 = await insertDeployment(db, org.organizationId, application.id, customer.id, { state: 'HEALTHY' });
    await insertDeployment(db, org.organizationId, application.id, customer.id, { state: 'HEALTHY' });
    const release = await insertRelease(db, application.id);

    const response = await postJson(
      app,
      `/api/applications/${application.id}/deploy-bulk`,
      { releaseId: release.id, deploymentIds: [dep1.id] },
      { cookie: org.cookie },
    );
    const body = response.json() as { results: Array<{ deploymentId: string }> };
    expect(body.results.map((r) => r.deploymentId)).toEqual([dep1.id]);
  });

  // A uuid-shaped releaseId that does not belong to the application must not
  // queue a job the relay can never carry out.
  it('POST /api/applications/:id/deploy-bulk 404s for a release that is not the application’s', async () => {
    const application = await insertApplication(db, org.organizationId, { name: 'Bulk Release Guard' });
    const otherApplication = await insertApplication(db, org.organizationId, { name: 'Other App' });
    const foreignRelease = await insertRelease(db, otherApplication.id);

    const missing = await postJson(
      app,
      `/api/applications/${application.id}/deploy-bulk`,
      { releaseId: crypto.randomUUID() },
      { cookie: org.cookie },
    );
    expect(missing.statusCode).toBe(404);

    const foreign = await postJson(
      app,
      `/api/applications/${application.id}/deploy-bulk`,
      { releaseId: foreignRelease.id },
      { cookie: org.cookie },
    );
    expect(foreign.statusCode).toBe(404);
  });

  it("POST /api/applications/:id/deploy-bulk 404s for an application outside the caller's org", async () => {
    const otherOrg = await signUpAndGetOrg(auth, db, 'bulk-other-org@example.com');
    const otherApp = await insertApplication(db, otherOrg.organizationId);

    const response = await postJson(
      app,
      `/api/applications/${otherApp.id}/deploy-bulk`,
      { releaseId: (await insertRelease(db, otherApp.id)).id },
      { cookie: org.cookie },
    );
    expect(response.statusCode).toBe(404);
  });
});
