import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bootstrapStackName, errorEnvelopeSchema } from '@deployz/contracts';
import { applyMigrations, createDb, persistDeploymentResourceSnapshot, type Db } from '@deployz/db';
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
      // Unique per call: one application per repo per organization is now a
      // database constraint, and several tests seed two applications in the
      // same org.
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
      // Unique per call: one release per version per application is now a
      // database constraint, and several tests seed two releases for one app.
      version: `v1.0.0-${crypto.randomUUID().slice(0, 8)}`,
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
      // The control plane mints this when a deployment is created; the relay
      // trades it once for its binding.
      enrollmentCode: crypto.randomUUID(),
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

  // The 5xx envelope above is generic on purpose, so the log is the ONLY place
  // the real cause survives. The API ran `logger: false`, which meant a 500
  // left no trace anywhere — three production failures in a row could only be
  // diagnosed by reading configuration and guessing.
  it('logs the real cause of a 5xx, which the envelope deliberately withholds', async () => {
    const logged: Array<Record<string, unknown>> = [];
    const recorder = {
      level: 'warn',
      error: (obj: unknown) => {
        logged.push(obj as Record<string, unknown>);
      },
      warn: () => {},
      info: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
      silent: () => {},
      child: () => recorder,
    } as unknown as Parameters<typeof buildServer>[0]['loggerInstance'];

    const logging = await buildServer({ auth, db, loggerInstance: recorder });
    logging.get('/api/probe-logged-error', async () => {
      throw new Error('hunter2-internal-db-password');
    });
    logging.get('/api/probe-logged-client-error', async () => {
      throw new ApiError(404, 'NOT_FOUND', 'nope');
    });

    await logging.inject({ method: 'GET', url: '/api/probe-logged-error' });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      method: 'GET',
      url: '/api/probe-logged-error',
      code: 'INTERNAL_ERROR',
    });
    expect((logged[0]!['err'] as Error).message).toBe('hunter2-internal-db-password');

    // A 4xx is the caller's problem, not an incident — it stays out of the log.
    await logging.inject({ method: 'GET', url: '/api/probe-logged-client-error' });
    expect(logged).toHaveLength(1);

    await logging.close();
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
    // An application may only point at an installation its own organization
    // connected, so the connected installation has to exist first.
    await db.insert(schema.githubInstallations).values({
      id: 'inst-1',
      organizationId: orgA.organizationId,
      accountLogin: 'org-a',
      accountType: 'Organization',
    });
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

// ── §31: the config scope carries the customer NAME, and is org-owned ──────
describe('server — config scope resolution (§31,§65)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let orgA: { userId: string; organizationId: string; cookie: string };
  let orgB: { userId: string; organizationId: string; cookie: string };
  let application: typeof schema.applications.$inferSelect;
  let customer: typeof schema.customers.$inferSelect;
  let otherOrgCustomer: typeof schema.customers.$inferSelect;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    orgA = await signUpAndGetOrg(auth, db, 'config-scope-a@example.com');
    orgB = await signUpAndGetOrg(auth, db, 'config-scope-b@example.com');
    app = await buildServer({ auth, db });
    application = await insertApplication(db, orgA.organizationId, { name: 'Config Scope App' });
    customer = await insertCustomer(db, orgA.organizationId, { name: 'Acme Industries' });
    otherOrgCustomer = await insertCustomer(db, orgB.organizationId, { name: 'Other Org Customer' });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  // §65: the screen names the customer, so the id never has to be rendered.
  it('GET scoped to a customer returns that customer name', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/config?customerId=${customer.id}`,
      headers: { cookie: orgA.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ customerId: customer.id, customerName: 'Acme Industries' });
  });

  it('GET without a customer is the vendor scope — no customer id, no name', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/config`,
      headers: { cookie: orgA.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ customerId: null, customerName: null });
  });

  it('PUT scoped to a customer returns that customer name alongside the saved values', async () => {
    const response = await sendJson(
      app,
      'PUT',
      `/api/applications/${application.id}/config`,
      { customerId: customer.id, entries: [{ key: 'LOG_LEVEL', value: 'debug', isSecret: false }] },
      { cookie: orgA.cookie },
    );
    expect(response.statusCode).toBe(200);
    const body = response.json() as { customerName: string | null; customerOverrides: { key: string; value: string | null }[] };
    expect(body.customerName).toBe('Acme Industries');
    expect(body.customerOverrides).toContainEqual({ key: 'LOG_LEVEL', value: 'debug', isSecret: false });
  });

  it('a customer of another organization 404s on read and on write (§2)', async () => {
    const read = await app.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/config?customerId=${otherOrgCustomer.id}`,
      headers: { cookie: orgA.cookie },
    });
    expect(read.statusCode).toBe(404);

    const write = await sendJson(
      app,
      'PUT',
      `/api/applications/${application.id}/config`,
      { customerId: otherOrgCustomer.id, entries: [{ key: 'LEAK', value: 'no', isSecret: false }] },
      { cookie: orgA.cookie },
    );
    expect(write.statusCode).toBe(404);

    const rows = await db
      .select()
      .from(schema.applicationConfigs)
      .where(eq(schema.applicationConfigs.customerId, otherOrgCustomer.id));
    expect(rows).toHaveLength(0);
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

  it('PATCH records a changed contract field as a vendor override', async () => {
    const application = await insertApplication(db, org.organizationId, { containerPort: 3000 });
    const response = await sendJson(app, 'PATCH', `/api/applications/${application.id}`, { containerPort: 8080 }, { cookie: org.cookie });
    expect(response.statusCode).toBe(200);
    const metadata = (response.json() as { detectedMetadata: { vendorOverrides?: string[] } }).detectedMetadata;
    expect(metadata.vendorOverrides).toEqual(['containerPort']);
  });

  it('PATCH does not claim a contract field the vendor re-submitted unchanged', async () => {
    const application = await insertApplication(db, org.organizationId, { containerPort: 3000, healthPath: '/health' });
    const response = await sendJson(app, 'PATCH', `/api/applications/${application.id}`, { containerPort: 3000, healthPath: '/live' }, { cookie: org.cookie });
    expect(response.statusCode).toBe(200);
    const metadata = (response.json() as { detectedMetadata: { vendorOverrides?: string[] } }).detectedMetadata;
    expect(metadata.vendorOverrides).toEqual(['healthPath']);
  });

  it('PATCH keeps the analysis findings on detectedMetadata when claiming a field', async () => {
    const application = await insertApplication(db, org.organizationId, {
      containerPort: 3000,
      detectedMetadata: { checks: { ready: [{ label: 'Dockerfile found' }] } },
    });
    const response = await sendJson(app, 'PATCH', `/api/applications/${application.id}`, { containerPort: 8080 }, { cookie: org.cookie });
    expect(response.statusCode).toBe(200);
    const metadata = (response.json() as { detectedMetadata: Record<string, unknown> }).detectedMetadata;
    expect(metadata['checks']).toEqual({ ready: [{ label: 'Dockerfile found' }] });
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
  // The id the RELAY mints for itself inside the customer's account. The
  // control plane learns it at enrollment and never before.
  const RELAY_INSTALLATION_ID = 'inst-minted-in-customer-account';

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
      // Unbound: no relay has enrolled yet, which is the real shape of a
      // deployment a vendor has just created.
      installationId: null,
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('POST /api/relay/register without a bearer token is rejected', async () => {
    const response = await postJson(app, '/api/relay/register', {
      enrollmentCode: deployment.enrollmentCode,
      installationId: RELAY_INSTALLATION_ID,
    });
    expect(response.statusCode).toBe(401);
  });

  it('POST /api/relay/register 404s for an enrollment code with no matching deployment', async () => {
    const response = await postJson(
      app,
      '/api/relay/register',
      { enrollmentCode: 'not-a-real-code', installationId: RELAY_INSTALLATION_ID },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(response.statusCode).toBe(404);
  });

  it('binds the relay, creates the INSTALL job, and moves the deployment to INSTALLING (§6)', async () => {
    const response = await postJson(
      app,
      '/api/relay/register',
      {
        enrollmentCode: deployment.enrollmentCode,
        installationId: RELAY_INSTALLATION_ID,
        awsAccountId: '123456789012',
      },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(response.statusCode).toBe(200);

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(dep!.state).toBe('INSTALLING');
    // The binding, the relay's self-minted id and the customer's account id
    // are all learned here — none of them were knowable before this call.
    expect(dep!.installationId).toBe(RELAY_INSTALLATION_ID);
    expect(dep!.relayTokenHash).not.toBeNull();
    expect(dep!.enrollmentUsedAt).not.toBeNull();
    expect(dep!.awsAccountId).toBe('123456789012');

    const jobs = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.type).toBe('INSTALL');
    expect(jobs[0]!.state).toBe('REQUESTED');
  });

  it('a replay from the same relay is idempotent and creates no second INSTALL job', async () => {
    const response = await postJson(
      app,
      '/api/relay/register',
      { enrollmentCode: deployment.enrollmentCode, installationId: RELAY_INSTALLATION_ID },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(response.statusCode).toBe(200);
    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(and(eq(schema.deploymentJobs.deploymentId, deployment.id), eq(schema.deploymentJobs.type, 'INSTALL')));
    expect(jobs).toHaveLength(1);
  });

  // The takeover this replaced: registration used to bind whatever token the
  // caller supplied, checking only that the installation id existed — and
  // that id travelled in the customer's install URL. Anyone holding the link
  // could rebind the deployment to a token of their own, lock the real relay
  // out, read its job payloads, and drive the deployment's state into and out
  // of the states that start and stop billing.
  it('refuses a second relay with a different token, and leaves the first one working', async () => {
    const takeover = await postJson(
      app,
      '/api/relay/register',
      { enrollmentCode: deployment.enrollmentCode, installationId: 'inst-attacker' },
      { authorization: 'Bearer attacker-chosen-token' },
    );
    expect(takeover.statusCode).toBe(409);
    expect(takeover.json()).toMatchObject({ error: { code: 'RELAY_ALREADY_ENROLLED' } });

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(dep!.installationId).toBe(RELAY_INSTALLATION_ID);

    // Health, not the command poll: polling would consume the pending INSTALL
    // job that the next test asserts on, and authenticating is the point here.
    const stillWorks = await postJson(
      app,
      '/api/relay/health',
      { installationId: RELAY_INSTALLATION_ID },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(stillWorks.statusCode).toBe(200);
  });

  it('records a rejected enrollment as an event the vendor can see', async () => {
    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.deploymentId, deployment.id));
    expect(events.some((row) => row.eventType === 'install.enrollment.rejected')).toBe(true);
  });

  it('GET /api/relay/commands rejects a wrong bearer token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/relay/commands?installationId=${RELAY_INSTALLATION_ID}`,
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns the pending INSTALL command and moves it to RUNNING', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/relay/commands?installationId=${RELAY_INSTALLATION_ID}`,
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
      url: `/api/relay/commands?installationId=${RELAY_INSTALLATION_ID}`,
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
    // A fresh RUNNING install attempt: the original INSTALL job settled in an
    // earlier test, and a settled job ignores late results (alreadySettled)
    // instead of reprocessing them.
    const [installJob] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: deployment.id,
        type: 'INSTALL',
        state: 'RUNNING',
        idempotencyKey: `${deployment.id}:INSTALL:healthy-test`,
        payload: {},
      })
      .returning();

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

  it('a failed update keeps the deployment live and diagnostics still classify it', async () => {
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

    // The previous release (advanced by the successful DEPLOY_RELEASE above)
    // is still serving: a failed day-2 operation must not mark the whole
    // deployment FAILED. No newer READY release exists here, so HEALTHY.
    const [updated] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(updated!.state).toBe('HEALTHY');

    // §61: diagnostics must still report the code the relay gave — the gate
    // follows the latest mutating attempt, not only deployment.state.
    const diagnostics = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}/diagnostics`,
      headers: { cookie: org.cookie },
    });
    expect(diagnostics.statusCode).toBe(200);
    expect((diagnostics.json() as { failureCode: string }).failureCode).toBe('IMAGE_HEALTH_CHECK_FAILED');
  });

  // §22/§23/§42: known failure codes bypass AI entirely — the deterministic
  // §65 copy map is authoritative and the gateway must never be invoked.
  it('a known failure code returns remediation copy directly, without calling the AI gateway', async () => {
    let calls = 0;
    const countingApp = await buildServer({
      auth,
      db,
      aiGateway: {
        async generate() {
          calls += 1;
          throw new Error('AI gateway must not be called for a known failure code');
        },
      },
    });
    // Set the failure state directly so the test does not depend on which
    // other tests in this file have already run.
    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment.id,
      type: 'DEPLOY_RELEASE',
      state: 'FAILED',
      failureCode: 'PORT_MISMATCH',
      finishedAt: new Date(),
      idempotencyKey: `${deployment.id}:DEPLOY_RELEASE:known-code`,
      payload: {},
    });
    await db
      .update(schema.deployments)
      .set({ state: 'FAILED' })
      .where(eq(schema.deployments.id, deployment.id));

    const response = await countingApp.inject({
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
    expect(calls).toBe(0);
    await countingApp.close();
  });

  // §16/§23: an UNKNOWN failure code is the one path that calls AI, and the
  // only evidence it may see is the redacted, normalized job error — never
  // the raw text (ANSI codes, secrets) the relay reported.
  it('explains an UNKNOWN failure with AI text, sending only redacted evidence in the prompt', async () => {
    // Built from a char code rather than an embedded literal control byte, so
    // the source has no raw control character (matches redact.ts's own style).
    const ansiEsc = String.fromCharCode(27);
    let capturedPrompt = '';
    const aiApp = await buildServer({
      auth,
      db,
      aiGateway: {
        async generate(prompt) {
          capturedPrompt = prompt;
          return {
            object: {
              failureCode: 'UNKNOWN',
              what: 'The app failed for a reason the classifier could not identify.',
              why: 'The deploy reported an error that did not match a known failure pattern.',
              fix: 'Check the logs and contact support if this keeps happening.',
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
      failureCode: null,
      result: { error: `boom ${ansiEsc}[31mERR${ansiEsc}[0m postgresql://u:p@h/db` },
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

    const body = response.json() as { failureCode: string; what: string; why: string; fix: string };
    expect(body.failureCode).toBe('UNKNOWN');
    expect(body.what).toBe('The app failed for a reason the classifier could not identify.');
    expect(body.fix).toBe('Check the logs and contact support if this keeps happening.');
    expect(capturedPrompt).toContain('[REDACTED]');
    expect(capturedPrompt).not.toContain('u:p');
    await aiApp.close();
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
      { installationId: RELAY_INSTALLATION_ID, healthStatus: 'HEALTHY' },
      { authorization: 'Bearer wrong-token' },
    );
    expect(response.statusCode).toBe(401);
  });

  it('persists observedState/relayStatus/lastHealthAt/healthStatus from the relay payload', async () => {
    const response = await postJson(
      app,
      '/api/relay/health',
      { installationId: RELAY_INSTALLATION_ID, observedState: { tasksRunning: 2 }, healthStatus: 'DEGRADED' },
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
  let applicationId: string;
  let customerId: string;

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
    customerId = customer.id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  // One mutating operation per deployment: each job-creating test gets a
  // FRESH deployment so the busy gate cannot see a previous test's job, and
  // every deploy target is a READY release with a digest (the deploy
  // contract refuses anything less).
  async function freshDeployment(): Promise<typeof schema.deployments.$inferSelect> {
    return insertDeployment(db, org.organizationId, applicationId, customerId, { state: 'HEALTHY' });
  }

  async function deployableRelease(): Promise<string> {
    const release = await insertRelease(db, applicationId, {
      releaseStatus: 'READY',
      buildStatus: 'SUCCEEDED',
      imageDigest:
        '151955775369.dkr.ecr.us-east-1.amazonaws.com/deployz-images@sha256:' +
        crypto.randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
    });
    return release.id;
  }

  it('POST .../deploy twice with the same releaseId returns the SAME job (202 then 200), never a duplicate row', async () => {
    const deployment = await freshDeployment();
    const releaseId = await deployableRelease();
    const first = await postJson(app, `/api/deployments/${deployment.id}/deploy`, { releaseId }, { cookie: org.cookie });
    expect(first.statusCode, first.body).toBe(202);
    const second = await postJson(app, `/api/deployments/${deployment.id}/deploy`, { releaseId }, { cookie: org.cookie });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { jobId: string }).jobId).toBe((first.json() as { jobId: string }).jobId);

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.idempotencyKey, `${deployment.id}:DEPLOY_RELEASE:${releaseId}`));
    expect(jobs).toHaveLength(1);
  });

  it('a different releaseId produces a different job once the first settles', async () => {
    const deployment = await freshDeployment();
    const r1 = await postJson(app, `/api/deployments/${deployment.id}/deploy`, { releaseId: await deployableRelease() }, { cookie: org.cookie });
    expect(r1.statusCode, r1.body).toBe(202);
    // The busy gate refuses a SECOND mutating operation while the first is
    // active - settle it, as the relay reporting success would.
    await db
      .update(schema.deploymentJobs)
      .set({ state: 'SUCCEEDED', finishedAt: new Date() })
      .where(eq(schema.deploymentJobs.id, (r1.json() as { jobId: string }).jobId));

    const r2 = await postJson(app, `/api/deployments/${deployment.id}/deploy`, { releaseId: await deployableRelease() }, { cookie: org.cookie });
    expect(r2.statusCode, r2.body).toBe(202);
    expect((r1.json() as { jobId: string }).jobId).not.toBe((r2.json() as { jobId: string }).jobId);
  });

  it('an Idempotency-Key header overrides the derived key', async () => {
    const deployment = await freshDeployment();
    const first = await postJson(
      app,
      `/api/deployments/${deployment.id}/deploy`,
      { releaseId: await deployableRelease() },
      { cookie: org.cookie, 'idempotency-key': 'client-supplied-key-1' },
    );
    expect(first.statusCode, first.body).toBe(202);

    const jobs = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.idempotencyKey, 'client-supplied-key-1'));
    expect(jobs).toHaveLength(1);

    // Same header, different releaseId - still the same idempotent operation.
    const second = await postJson(
      app,
      `/api/deployments/${deployment.id}/deploy`,
      { releaseId: await deployableRelease() },
      { cookie: org.cookie, 'idempotency-key': 'client-supplied-key-1' },
    );
    expect(second.statusCode).toBe(200);
    expect((second.json() as { jobId: string }).jobId).toBe((first.json() as { jobId: string }).jobId);
  });

  it('POST .../rollback twice with the same target releaseId returns the SAME job', async () => {
    const deployment = await freshDeployment();
    const releaseId = await deployableRelease();
    const first = await postJson(app, `/api/deployments/${deployment.id}/rollback`, { releaseId }, { cookie: org.cookie });
    const second = await postJson(app, `/api/deployments/${deployment.id}/rollback`, { releaseId }, { cookie: org.cookie });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect((second.json() as { jobId: string }).jobId).toBe((first.json() as { jobId: string }).jobId);
  });

  it('POST .../deploy and .../rollback 404 for a releaseId the application does not own', async () => {
    const deployment = await freshDeployment();
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
    const deployment = await freshDeployment();
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

  it('deployment detail derives per-component state from requirements, verification checks and relay reports', async () => {
    const redisApp = await insertApplication(db, org.organizationId, { redisRequired: true });
    const redisCustomer = await insertCustomer(db, org.organizationId);
    const redisDeployment = await insertDeployment(db, org.organizationId, redisApp.id, redisCustomer.id);

    // Required but never observed: Not reporting (UNKNOWN). Compute and
    // ingress are always required for an installed deployment.
    const withRedis = await app.inject({
      method: 'GET',
      url: `/api/deployments/${redisDeployment.id}`,
      headers: { cookie: org.cookie },
    });
    expect((withRedis.json() as { components: Record<string, string> | null }).components).toEqual({
      application: 'UNKNOWN',
      loadBalancer: 'UNKNOWN',
      redis: 'UNKNOWN',
    });

    const noRedisApp = await insertApplication(db, org.organizationId, { redisRequired: false });
    const noRedisCustomer = await insertCustomer(db, org.organizationId);
    const noRedisDeployment = await insertDeployment(db, org.organizationId, noRedisApp.id, noRedisCustomer.id);

    const withoutRedis = await app.inject({
      method: 'GET',
      url: `/api/deployments/${noRedisDeployment.id}`,
      headers: { cookie: org.cookie },
    });
    expect((withoutRedis.json() as { components: Record<string, string> | null }).components).toEqual({
      application: 'UNKNOWN',
      loadBalancer: 'UNKNOWN',
    });

    // A component the relay HAS reported is preserved verbatim; required
    // ones it did not report (load balancer) are synthesized alongside.
    await db
      .update(schema.deployments)
      .set({ observedState: { components: { application: 'HEALTHY', redis: 'HEALTHY' } } })
      .where(eq(schema.deployments.id, redisDeployment.id));
    const reported = await app.inject({
      method: 'GET',
      url: `/api/deployments/${redisDeployment.id}`,
      headers: { cookie: org.cookie },
    });
    expect((reported.json() as { components: Record<string, string> | null }).components).toEqual({
      application: 'HEALTHY',
      loadBalancer: 'UNKNOWN',
      redis: 'HEALTHY',
    });

    // Required, verification looked, nothing there: Not provisioned.
    await db
      .update(schema.deployments)
      .set({
        observedState: {
          components: {},
          infraHealth: { verified: false, checks: [{ name: 'cache', passed: false, detail: '' }] },
        },
      })
      .where(eq(schema.deployments.id, redisDeployment.id));
    const notProvisioned = await app.inject({
      method: 'GET',
      url: `/api/deployments/${redisDeployment.id}`,
      headers: { cookie: org.cookie },
    });
    expect(
      (notProvisioned.json() as { components: Record<string, string> | null }).components?.redis,
    ).toBe('NOT_PROVISIONED');
  });

  it('readiness: analysis not COMPLETE returns state ANALYSIS_INCOMPLETE with empty findings, never a fabricated result', async () => {
    const application = await insertApplication(db, org.organizationId, { analysisStatus: 'ANALYZING' });
    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/readiness`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({
      analysisStatus: 'ANALYZING',
      state: 'ANALYSIS_INCOMPLETE',
      requiredCount: 0,
      recommendedCount: 0,
      summary: null,
      failureReason: null,
      findings: [],
      passed: [],
      analyzedCommitSha: null,
    });
  });

  // A FAILED analysis used to reach the page as an indistinguishable
  // "not COMPLETE yet" — same empty shape as ANALYZING, reason dropped. The
  // vendor saw "Analysing your app" for ever and Re-analyse looked inert.
  it('readiness: a FAILED analysis carries the reason it failed', async () => {
    const application = await insertApplication(db, org.organizationId, {
      analysisStatus: 'FAILED',
      compatibilityReason: 'Failed to mint a GitHub installation token',
    });
    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/readiness`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      analysisStatus: 'FAILED',
      state: 'ANALYSIS_INCOMPLETE',
      failureReason: 'Failed to mint a GitHub installation token',
    });
  });

  it('readiness: a row with a stored semantic report returns it verbatim, plus the analyzed commit sha', async () => {
    const finding = {
      id: 'health-check',
      category: 'health',
      title: 'Deployment health check',
      severity: 'required',
      blocking: false,
      plainEnglishExplanation: 'Deployz needs a reliable way to know when your app is running and ready.',
      whyItMatters: 'During every deployment, Deployz waits for your app to report healthy.',
      technicalEvidence: 'No health endpoint or container health check was found.',
      suggestedOutcome: 'Expose a lightweight route that returns success once the app is ready.',
      confidence: 'likely',
    };
    const readiness = {
      state: 'ALMOST_READY',
      requiredCount: 1,
      recommendedCount: 0,
      summary: 'Deployz found a few things to address before this app can be deployed reliably.',
      findings: [finding],
      passed: [{ id: 'dockerfile', label: 'Container setup found' }],
    };
    const application = await insertApplication(db, org.organizationId, {
      analysisStatus: 'COMPLETE',
      compatibilityStatus: 'NEEDS_ATTENTION',
      compatibilityReason: readiness.summary,
      detectedMetadata: { readiness, analysisCommitSha: 'deadbeef' },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/readiness`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({
      analysisStatus: 'COMPLETE',
      state: 'ALMOST_READY',
      requiredCount: 1,
      recommendedCount: 0,
      summary: readiness.summary,
      failureReason: null,
      findings: [finding],
      passed: readiness.passed,
      analyzedCommitSha: 'deadbeef',
    });
  });

  // Legacy rows (analysed before the semantic readiness report existed) only
  // carry `detected_metadata.checks` — computeReadiness must degrade these
  // into equivalent findings rather than 500 or silently drop them.
  it('readiness: a legacy row (checks only, no readiness report) degrades to equivalent findings', async () => {
    const application = await insertApplication(db, org.organizationId, {
      analysisStatus: 'COMPLETE',
      compatibilityStatus: 'NEEDS_ATTENTION',
      detectedMetadata: {
        checks: {
          ready: [{ label: 'Docker container detected' }, { label: 'PostgreSQL detected' }],
          needsAttention: [
            { title: 'Health endpoint missing', detail: 'Deployz requires an HTTP health endpoint.', suggestedFix: 'GET /health -> 200' },
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
      state: string;
      findings: Array<{ id: string; severity: string; blocking: boolean; title: string }>;
      passed: Array<{ id: string; label: string }>;
    };
    expect(body.state).toBe('ALMOST_READY');
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0]).toMatchObject({ severity: 'required', blocking: false, title: 'Health endpoint missing' });
    expect(body.passed).toHaveLength(2);
    expect(body.passed).toContainEqual({ id: 'legacy-passed-0', label: 'Docker container detected' });
  });

  it('readiness: a legacy NOT_COMPATIBLE row degrades its unsupported entries into blocking required findings', async () => {
    const application = await insertApplication(db, org.organizationId, {
      analysisStatus: 'COMPLETE',
      compatibilityStatus: 'NOT_COMPATIBLE',
      compatibilityReason: 'Persistent Redis is required.',
      detectedMetadata: {
        checks: {
          ready: [],
          needsAttention: [],
          unsupported: [{ title: 'This Redis setup is not supported', reason: 'Redis Stack modules detected.' }],
        },
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/readiness`,
      headers: { cookie: org.cookie },
    });
    const body = response.json() as {
      state: string;
      findings: Array<{ severity: string; blocking: boolean; title: string }>;
    };
    expect(body.state).toBe('NEEDS_CHANGES');
    expect(body.findings).toEqual([
      expect.objectContaining({ severity: 'required', blocking: true, title: 'This Redis setup is not supported' }),
    ]);
  });

  it('readiness: a legacy fully-READY row (no issues) has passed checks and no findings', async () => {
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
    const body = response.json() as { state: string; findings: unknown[]; passed: unknown[] };
    expect(body.state).toBe('READY');
    expect(body.findings).toEqual([]);
    expect(body.passed).toEqual([{ id: 'legacy-passed-0', label: 'Docker container detected' }]);
  });
});

// ── POST /api/applications/:id/fix-instructions ─────────────────────────────
// Generates the consolidated coding-agent prompt for the unresolved readiness
// findings. Read-only with respect to the analysis: generation never changes
// findings, readiness state, or the repository — success or failure.
describe('server — POST /api/applications/:id/fix-instructions', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let org: { userId: string; organizationId: string; cookie: string };

  const someFinding = {
    id: 'health-check',
    category: 'health',
    title: 'Deployment health check',
    severity: 'required',
    blocking: false,
    plainEnglishExplanation: 'Deployz needs a reliable way to know when your app is running and ready.',
    whyItMatters: 'During every deployment, Deployz waits for your app to report healthy.',
    technicalEvidence: 'No health endpoint or container health check was found.',
    suggestedOutcome: 'Expose a lightweight route that returns success once the app is ready.',
    confidence: 'likely',
  };

  async function insertAnalyzedApplication(
    overrides: Partial<typeof schema.applications.$inferInsert> = {},
  ): Promise<typeof schema.applications.$inferSelect> {
    return insertApplication(db, org.organizationId, {
      analysisStatus: 'COMPLETE',
      compatibilityStatus: 'NEEDS_ATTENTION',
      detectedMetadata: {
        readiness: {
          state: 'ALMOST_READY',
          requiredCount: 1,
          recommendedCount: 0,
          summary: 'Deployz found a few things to address before this app can be deployed reliably.',
          findings: [someFinding],
          passed: [],
        },
      },
      ...overrides,
    });
  }

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, 'fix-instructions@example.com');
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('200s with an instructions document containing the guardrail sentence, the repo name, and a generatedAt', async () => {
    const application = await insertAnalyzedApplication();
    const stubApp = await buildServer({
      auth,
      db,
      aiGateway: {
        async generate() {
          return {
            object: { perFinding: [{ id: 'health-check', guidance: 'Add a /health route.' }], generalNotes: [] },
            usage: { promptTokens: 100, completionTokens: 50 },
          };
        },
      },
    });

    const response = await postJson(
      stubApp,
      `/api/applications/${application.id}/fix-instructions`,
      {},
      { cookie: org.cookie },
    );
    expect(response.statusCode).toBe(200);
    const body = response.json() as { instructions: string; generatedAt: string };
    expect(body.instructions).toContain(
      'Do not assume Deployz findings are correct. Inspect the repository first.',
    );
    expect(body.instructions).toContain(application.repoFullName);
    expect(body.generatedAt).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false);

    await stubApp.close();
  });

  it('409s ANALYSIS_NOT_COMPLETE when the analysis has not finished', async () => {
    const application = await insertApplication(db, org.organizationId, { analysisStatus: 'ANALYZING' });
    const stubApp = await buildServer({
      auth,
      db,
      aiGateway: {
        async generate() {
          throw new Error('must not be called');
        },
      },
    });

    const response = await postJson(
      stubApp,
      `/api/applications/${application.id}/fix-instructions`,
      {},
      { cookie: org.cookie },
    );
    expect(response.statusCode).toBe(409);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('ANALYSIS_NOT_COMPLETE');

    await stubApp.close();
  });

  it('409s NO_UNRESOLVED_FINDINGS when the analysis is COMPLETE with a READY report and no findings', async () => {
    const application = await insertAnalyzedApplication({
      compatibilityStatus: 'READY',
      detectedMetadata: {
        readiness: {
          state: 'READY',
          requiredCount: 0,
          recommendedCount: 0,
          summary: 'This app can be deployed through Deployz.',
          findings: [],
          passed: [{ id: 'dockerfile', label: 'Container setup found' }],
        },
      },
    });
    const stubApp = await buildServer({
      auth,
      db,
      aiGateway: {
        async generate() {
          throw new Error('must not be called');
        },
      },
    });

    const response = await postJson(
      stubApp,
      `/api/applications/${application.id}/fix-instructions`,
      {},
      { cookie: org.cookie },
    );
    expect(response.statusCode).toBe(409);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('NO_UNRESOLVED_FINDINGS');

    await stubApp.close();
  });

  it('503s FIX_INSTRUCTIONS_UNAVAILABLE (retryable) when the AI gateway fails', async () => {
    const application = await insertAnalyzedApplication();
    const failingApp = await buildServer({
      auth,
      db,
      aiGateway: {
        async generate() {
          throw new Error('gateway unreachable');
        },
      },
    });

    const response = await postJson(
      failingApp,
      `/api/applications/${application.id}/fix-instructions`,
      {},
      { cookie: org.cookie },
    );
    expect(response.statusCode).toBe(503);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('FIX_INSTRUCTIONS_UNAVAILABLE');

    await failingApp.close();
  });

  it('never modifies the application row — readiness is identical before and after, on success and on failure', async () => {
    const application = await insertAnalyzedApplication();
    const readOnlyApp = await buildServer({ auth, db });

    const readinessBefore = await readOnlyApp.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/readiness`,
      headers: { cookie: org.cookie },
    });

    const succeedingApp = await buildServer({
      auth,
      db,
      aiGateway: {
        async generate() {
          return {
            object: { perFinding: [], generalNotes: [] },
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        },
      },
    });
    const success = await postJson(
      succeedingApp,
      `/api/applications/${application.id}/fix-instructions`,
      {},
      { cookie: org.cookie },
    );
    expect(success.statusCode).toBe(200);
    await succeedingApp.close();

    const failingApp = await buildServer({
      auth,
      db,
      aiGateway: {
        async generate() {
          throw new Error('gateway unreachable');
        },
      },
    });
    const failure = await postJson(
      failingApp,
      `/api/applications/${application.id}/fix-instructions`,
      {},
      { cookie: org.cookie },
    );
    expect(failure.statusCode).toBe(503);
    await failingApp.close();

    const readinessAfter = await readOnlyApp.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/readiness`,
      headers: { cookie: org.cookie },
    });
    expect(readinessAfter.json()).toEqual(readinessBefore.json());
    await readOnlyApp.close();
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

      // With no job queue configured the runner is awaited inline, so it has
      // already run by the time the 202 comes back.
      expect(calls).toEqual([application.id]);
    } finally {
      await app.close();
    }
  });

  // Task 6 commit-SHA analysis cache: the explicit "Re-analyse" action sends
  // `{ force: true }` in the body, which must reach the injected runner so it
  // bypasses the cache; an auto-trigger sends no body at all.
  it('threads an explicit { force: true } body through to the injected runner', async () => {
    const calls: Array<{ applicationId: string; force: boolean | undefined }> = [];
    const app = await buildServer({
      auth,
      db,
      analysisRunner: async (applicationId, options) => {
        calls.push({ applicationId, force: options?.force });
      },
    });
    try {
      const application = await insertApplication(db, org.organizationId);

      const response = await app.inject({
        method: 'POST',
        url: `/api/applications/${application.id}/analyse`,
        headers: { cookie: org.cookie },
        payload: { force: true },
      });

      expect(response.statusCode).toBe(202);
      expect(calls).toEqual([{ applicationId: application.id, force: true }]);
    } finally {
      await app.close();
    }
  });

  it('does not force a re-analysis when no body is sent', async () => {
    const calls: Array<boolean | undefined> = [];
    const app = await buildServer({
      auth,
      db,
      analysisRunner: async (_applicationId, options) => {
        calls.push(options?.force);
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
      expect(calls).toEqual([false]);
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

      // A rejecting runner must not surface as an unhandled rejection or
      // turn the accepted request into a 500.
      expect(response.statusCode).toBe(202);
    } finally {
      await app.close();
    }
  });
});

// ── GitHub App installation binding (§15/§17) ──────────────────────────────
describe('server — GitHub installation binding', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };
  let other: { userId: string; organizationId: string; cookie: string };

  // GitHub's own view of the installation. The setup route reads the account
  // from the API rather than trusting the browser for anything but the id.
  const githubFetch = (async (url: string) => ({
    status: url.includes('/app/installations/4242') ? 200 : 404,
    headers: { get: () => null },
    json: async () => ({ account: { login: 'acme-inc', type: 'Organization' } }),
  })) as unknown as Parameters<typeof buildServer>[0]['githubFetch'];

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    app = await buildServer({
      auth,
      db,
      githubFixtureMode: false,
      githubFetch,
      githubAppId: 'test-app-id',
      // A real key: the setup route signs an RS256 App JWT, so a placeholder
      // string fails inside node:crypto rather than in the route.
      githubAppPrivateKey: generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      }).privateKey,
    });
    org = await signUpAndGetOrg(auth, db, 'gh-owner@example.com');
    other = await signUpAndGetOrg(auth, db, 'gh-other@example.com');
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('binds an installation to the caller organization and redirects to the dashboard', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/github/setup?installation_id=4242',
      headers: { cookie: org.cookie },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toContain('/dashboard/applications?github=connected');

    const rows = await db.select().from(schema.githubInstallations);
    expect(rows).toEqual([
      expect.objectContaining({
        id: '4242',
        organizationId: org.organizationId,
        accountLogin: 'acme-inc',
        accountType: 'Organization',
      }),
    ]);
  });

  // GitHub redirects the installing vendor here whether or not they hold a
  // Deployz session. A JSON 401 strands them on an error page with the
  // installation unbound; sign-in carries the id so the binding still
  // completes on the way back. The callback is relative because the sign-in
  // page rejects absolute URLs as open redirects.
  it('redirects a signed-out setup hit to sign-in rather than erroring', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/github/setup?installation_id=4242',
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toContain(
      '/sign-in?callbackUrl=%2Fgithub%2Fsetup%3Finstallation_id%3D4242',
    );
  });

  // Same principle as the signed-out case above, for the other way this route
  // fails. GitHub sends a *browser* here, so an error envelope renders raw
  // JSON at the vendor — which is what a mangled App key produced in
  // production: `{"error":{"code":"INTERNAL_ERROR",...}}` on screen, and no
  // way back. Land them on the dashboard, which says what it knows.
  it('returns a failed setup to the dashboard instead of rendering JSON', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/github/setup?installation_id=9999',
      headers: { cookie: org.cookie },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toContain('/dashboard/applications?github=failed');
    expect(response.body).not.toContain('INTERNAL_ERROR');

    // A binding that did not happen is never recorded as if it had.
    const rows = await db.select().from(schema.githubInstallations);
    expect(rows.map((row) => row.id)).not.toContain('9999');
  });

  it('lists the bound installation for its own organization only', async () => {
    const mine = await app.inject({
      method: 'GET',
      url: '/api/github/installations',
      headers: { cookie: org.cookie },
    });
    expect((mine.json() as { installations: unknown[] }).installations).toEqual([
      { id: '4242', accountLogin: 'acme-inc', accountType: 'Organization' },
    ]);

    const theirs = await app.inject({
      method: 'GET',
      url: '/api/github/installations',
      headers: { cookie: other.cookie },
    });
    expect((theirs.json() as { installations: unknown[] }).installations).toEqual([]);
  });

  // An installation id is a small integer: without this check any signed-in
  // user could list the repositories of any installation by guessing one.
  it('404s repo listing for an installation the caller does not own', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/github/repos?installationId=4242',
      headers: { cookie: other.cookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it('404s application creation against an installation the caller does not own', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/applications',
      headers: { cookie: other.cookie },
      payload: {
        name: 'Borrowed',
        githubInstallationId: '4242',
        repoFullName: 'acme-inc/private',
        repoUrl: 'https://github.com/acme-inc/private',
        defaultBranch: 'main',
      },
    });

    expect(response.statusCode).toBe(404);
  });

  it('drops the installation on the installation.deleted webhook', async () => {
    const secret = 'webhook-secret';
    const webhookApp = await buildServer({
      auth,
      db,
      githubWebhookSecret: secret,
      githubFixtureMode: false,
      githubFetch,
    });
    try {
      const body = JSON.stringify({ action: 'deleted', installation: { id: 4242 } });
      const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

      const response = await webhookApp.inject({
        method: 'POST',
        url: '/api/github/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'installation',
          'x-hub-signature-256': signature,
        },
        payload: body,
      });

      expect(response.json()).toStrictEqual({ received: true, handled: 'removed' });
      expect(await db.select().from(schema.githubInstallations)).toEqual([]);
    } finally {
      await webhookApp.close();
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

    // Keyed on the install-LINK id. The relay's installation id is minted in
    // the customer's account and must never be the value in a public URL.
    const response = await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body).toStrictEqual({
      applicationName: 'Analytics Cloud',
      publisherName: orgRow!.name,
      customerName: 'Acme Analytics',
      region: 'eu-west-1',
      alreadyInstalled: false,
      resourcesCreated: ['Application runtime', 'PostgreSQL database', 'Networking', 'Monitoring'],
      // No BOOTSTRAP_TEMPLATE_URL in the test environment: nothing is
      // published, so there is no link to hand out. The enrollment code
      // travels inside that link, never as a field of its own.
      quickCreateUrl: null,
      // The install link already identifies exactly this deployment, so
      // handing back its own id/state/domain does not cross a tenant
      // boundary — it's the same scope the link already grants.
      deploymentId: deployment.id,
      deploymentState: 'NOT_INSTALLED',
      domain: null,
      routingTarget: null,
      // Pre-relay fields: no launch has been recorded yet, so the expected
      // bootstrap stack name is derived live (deterministic from the
      // deployment identity) and nothing is stuck.
      components: null,
      bootstrapStackName: bootstrapStackName({
        appName: 'Analytics Cloud',
        deploymentId: deployment.id,
        attempt: 0,
      }),
      waitingForRelay: false,
      relayStuck: false,
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('999999999999');
    expect(serialized).not.toContain(org.organizationId);
  });

  it('GET /api/install/:installationId lists "Redis cache" in resourcesCreated only when the application requires Redis', async () => {
    const application = await insertApplication(db, org.organizationId, {
      name: 'Cache App',
      databaseRequired: false,
      storageRequired: false,
      redisRequired: true,
    });
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id);

    const withRedis = await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}` });
    expect((withRedis.json() as { resourcesCreated: string[] }).resourcesCreated).toEqual([
      'Application runtime',
      'Redis cache',
      'Networking',
      'Monitoring',
    ]);

    await db
      .update(schema.applications)
      .set({ redisRequired: false })
      .where(eq(schema.applications.id, application.id));

    const withoutRedis = await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}` });
    expect((withoutRedis.json() as { resourcesCreated: string[] }).resourcesCreated).toEqual([
      'Application runtime',
      'Networking',
      'Monitoring',
    ]);
  });

  it('GET /api/install/:installationId stops handing out a link once the code is spent', async () => {
    const application = await insertApplication(db, org.organizationId, { name: 'Spent Code App' });
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id);

    // env is read at module load, so publish a template for this test only.
    const mutableEnv = env as { bootstrapTemplateUrl: string | undefined };
    const previous = mutableEnv.bootstrapTemplateUrl;
    mutableEnv.bootstrapTemplateUrl = 'https://templates.example.com/bootstrap-v1.json';
    try {
      const fresh = await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}` });
      const freshBody = fresh.json() as Record<string, unknown>;
      expect(freshBody['alreadyInstalled']).toBe(false);
      expect(String(freshBody['quickCreateUrl'])).toContain(deployment.enrollmentCode);

      // The relay has bound: the code is spent, the page renders its
      // "already set up" state, and a replayed link must not carry the code.
      await db
        .update(schema.deployments)
        .set({ enrollmentUsedAt: new Date() })
        .where(eq(schema.deployments.id, deployment.id));

      const replayed = await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}` });
      const replayedBody = replayed.json() as Record<string, unknown>;
      expect(replayedBody['alreadyInstalled']).toBe(true);
      expect(replayedBody['quickCreateUrl']).toBeNull();
      expect(JSON.stringify(replayedBody)).not.toContain(deployment.enrollmentCode);
    } finally {
      mutableEnv.bootstrapTemplateUrl = previous;
    }
  });

  it('GET /api/install/:installationId resolves the template for the deployment\'s OWN region', async () => {
    const application = await insertApplication(db, org.organizationId, { name: 'Regional App' });
    const customer = await insertCustomer(db, org.organizationId);
    // us-east-2 deployment: the link must point at the us-east-2 regional
    // template, never the us-east-1 legacy bucket (S3 PermanentRedirect).
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      region: 'us-east-2',
    });

    const mutableEnv = env as {
      bootstrapTemplateUrl: string | undefined;
      deployableAwsRegions: readonly string[];
    };
    const prevUrl = mutableEnv.bootstrapTemplateUrl;
    const prevRegions = mutableEnv.deployableAwsRegions;
    // A legacy us-east-1 URL is configured — it must NOT leak to us-east-2.
    mutableEnv.bootstrapTemplateUrl = 'https://legacy-bucket.s3.us-east-1.amazonaws.com/bootstrap/v1/bootstrap-template-v1.json';
    mutableEnv.deployableAwsRegions = ['us-east-1', 'us-east-2'];
    try {
      const response = await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}` });
      const body = response.json() as Record<string, unknown>;
      expect(response.statusCode).toBe(200);
      const url = String(body['quickCreateUrl']);
      expect(url).toContain('region=us-east-2');
      expect(url).toContain('deployz-templates-us-east-2.s3.us-east-2.amazonaws.com');
      // The legacy us-east-1 URL must never be used for a us-east-2 deployment.
      expect(url).not.toContain('legacy-bucket');
    } finally {
      mutableEnv.bootstrapTemplateUrl = prevUrl;
      mutableEnv.deployableAwsRegions = prevRegions;
    }
  });

  it('GET /api/install/:installationId fails closed (no link) for an unpublished region', async () => {
    const application = await insertApplication(db, org.organizationId, { name: 'Unpublished App' });
    const customer = await insertCustomer(db, org.organizationId);
    // us-east-2 is supported but not in the default deployable set → no link.
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      region: 'us-east-2',
    });

    const mutableEnv = env as { bootstrapTemplateUrl: string | undefined };
    const prev = mutableEnv.bootstrapTemplateUrl;
    mutableEnv.bootstrapTemplateUrl = 'https://legacy-bucket.s3.us-east-1.amazonaws.com/bootstrap/v1/bootstrap-template-v1.json';
    try {
      const response = await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}` });
      const body = response.json() as Record<string, unknown>;
      expect(body['quickCreateUrl']).toBeNull();
    } finally {
      mutableEnv.bootstrapTemplateUrl = prev;
    }
  });

  it('GET /api/regions returns only deployable regions (auth)', async () => {
    const mutableEnv = env as { deployableAwsRegions: readonly string[] };
    const prev = mutableEnv.deployableAwsRegions;
    mutableEnv.deployableAwsRegions = ['us-east-1', 'us-east-2'];
    try {
      const response = await app.inject({ method: 'GET', url: '/api/regions', headers: { cookie: org.cookie } });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { regions: Array<{ value: string; label: string }> };
      expect(body.regions).toEqual([
        { value: 'us-east-1', label: 'US East (N. Virginia)' },
        { value: 'us-east-2', label: 'US East (Ohio)' },
      ]);
    } finally {
      mutableEnv.deployableAwsRegions = prev;
    }
  });

  it('GET /api/regions requires auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/regions' });
    expect(response.statusCode).toBe(401);
  });

  it('POST /api/deployments rejects a supported-but-unpublished region', async () => {
    const application = await insertApplication(db, org.organizationId, { name: 'Guard App' });
    const customer = await insertCustomer(db, org.organizationId);

    const mutableEnv = env as { deployableAwsRegions: readonly string[] };
    const prev = mutableEnv.deployableAwsRegions;
    mutableEnv.deployableAwsRegions = ['us-east-1']; // us-east-2 not deployable
    try {
      const response = await postJson(
        app,
        '/api/deployments',
        { applicationId: application.id, customerId: customer.id, region: 'us-east-2' },
        { cookie: org.cookie },
      );
      expect(response.statusCode).toBe(422);
      expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('REGION_NOT_SUPPORTED');
    } finally {
      mutableEnv.deployableAwsRegions = prev;
    }
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
    const releaseId = (
      await insertRelease(db, application.id, {
        releaseStatus: 'READY',
        buildStatus: 'SUCCEEDED',
        imageDigest:
          '151955775369.dkr.ecr.us-east-1.amazonaws.com/deployz-images@sha256:' +
          crypto.randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
      })
    ).id;

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
    const release = await insertRelease(db, application.id, {
      releaseStatus: 'READY',
      buildStatus: 'SUCCEEDED',
      imageDigest:
        '151955775369.dkr.ecr.us-east-1.amazonaws.com/deployz-images@sha256:' +
        crypto.randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
    });

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

// ── pre-relay install lifecycle: launch signal, WAITING_FOR_RELAY, retry ──────
describe('server — pre-relay install lifecycle (waiting-for-relay and retry)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };

  interface Seeded {
    deployment: typeof schema.deployments.$inferSelect;
    installLinkId: string;
  }

  async function seedWaiting(overrides: Partial<typeof schema.deployments.$inferInsert> = {}): Promise<Seeded> {
    const application = await insertApplication(db, org.organizationId, { name: 'Widget Suite' });
    const customer = await insertCustomer(db, org.organizationId, { name: 'Widgets Inc' });
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      installationId: null,
      ...overrides,
    });
    return { deployment, installLinkId: deployment.installLinkId };
  }

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, 'waiting-relay@example.com');
    app = await buildServer({ auth, db });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('gives two deployments of the same application in the same region different stack names', async () => {
    const first = await seedWaiting();
    const second = await seedWaiting();

    const firstBody = (await app.inject({ method: 'GET', url: `/api/install/${first.installLinkId}` })).json() as {
      bootstrapStackName: string;
    };
    const secondBody = (await app.inject({ method: 'GET', url: `/api/install/${second.installLinkId}` })).json() as {
      bootstrapStackName: string;
    };

    expect(firstBody.bootstrapStackName).toBe(
      bootstrapStackName({ appName: 'Widget Suite', deploymentId: first.deployment.id, attempt: 0 }),
    );
    expect(secondBody.bootstrapStackName).toBe(
      bootstrapStackName({ appName: 'Widget Suite', deploymentId: second.deployment.id, attempt: 0 }),
    );
    expect(firstBody.bootstrapStackName).not.toBe(secondBody.bootstrapStackName);
  });

  it('POST /api/install/:installLinkId/launched moves NOT_INSTALLED to WAITING_FOR_RELAY and records the launch', async () => {
    const { deployment, installLinkId } = await seedWaiting();

    const response = await postJson(app, `/api/install/${installLinkId}/launched`, {});
    expect(response.statusCode).toBe(200);
    expect((response.json() as { state: string }).state).toBe('WAITING_FOR_RELAY');

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(dep!.state).toBe('WAITING_FOR_RELAY');
    expect(dep!.installStartedAt).not.toBeNull();
    expect(dep!.bootstrapStackName).toBe(
      bootstrapStackName({ appName: 'Widget Suite', deploymentId: deployment.id, attempt: 0 }),
    );

    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.deploymentId, deployment.id));
    expect(events.some((row) => row.eventType === 'install.launched')).toBe(true);
  });

  it('POST /api/install/:installLinkId/launched is idempotent while waiting', async () => {
    const { installLinkId } = await seedWaiting();

    const first = await postJson(app, `/api/install/${installLinkId}/launched`, {});
    const second = await postJson(app, `/api/install/${installLinkId}/launched`, {});
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
  });

  it('marks the install relay-stuck (never FAILED) when no relay enrolls within the staleness window', async () => {
    const { deployment, installLinkId } = await seedWaiting({
      state: 'WAITING_FOR_RELAY',
      installStartedAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    const body = (
      await app.inject({ method: 'GET', url: `/api/install/${installLinkId}` })
    ).json() as { deploymentState: string; waitingForRelay: boolean; relayStuck: boolean };
    expect(body.deploymentState).toBe('WAITING_FOR_RELAY');
    expect(body.waitingForRelay).toBe(true);
    expect(body.relayStuck).toBe(true);

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(dep!.state).toBe('WAITING_FOR_RELAY');
  });

  it('relay registration from WAITING_FOR_RELAY moves to INSTALLING and queues the first INSTALL job', async () => {
    const { deployment } = await seedWaiting({ state: 'WAITING_FOR_RELAY' });
    const rows = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id));
    const enrollmentCode = rows[0]!.enrollmentCode;

    const response = await postJson(
      app,
      '/api/relay/register',
      { enrollmentCode, installationId: 'inst-waiting-relay' },
      { authorization: 'Bearer waiting-relay-token' },
    );
    expect(response.statusCode).toBe(200);

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(dep!.state).toBe('INSTALLING');
    expect(dep!.relayBoundAt).not.toBeNull();

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.type).toBe('INSTALL');
    expect(jobs[0]!.state).toBe('REQUESTED');
  });

  it('POST /api/install/:installLinkId/retry starts a fresh attempt: new code, new stack name, dead jobs cancelled', async () => {
    const { deployment, installLinkId } = await seedWaiting({
      state: 'WAITING_FOR_RELAY',
      installationId: 'inst-old-attempt',
      enrollmentUsedAt: null,
    });
    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment.id,
      type: 'INSTALL',
      state: 'REQUESTED',
      idempotencyKey: `${deployment.id}:INSTALL`,
      payload: {},
      requestedBy: null,
    });
    const oldStackName = bootstrapStackName({
      appName: 'Widget Suite',
      deploymentId: deployment.id,
      attempt: 0,
    });
    await db
      .update(schema.deployments)
      .set({ bootstrapStackName: oldStackName, installStartedAt: new Date(Date.now() - 20 * 60 * 1000) })
      .where(eq(schema.deployments.id, deployment.id));

    const response = await postJson(app, `/api/install/${installLinkId}/retry`, {});
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      state: string;
      attemptNumber: number;
      bootstrapStackName: string;
      quickCreateUrl: string | null;
    };
    expect(body.state).toBe('NOT_INSTALLED');
    expect(body.attemptNumber).toBe(1);
    expect(body.bootstrapStackName).toBe(
      bootstrapStackName({ appName: 'Widget Suite', deploymentId: deployment.id, attempt: 1 }),
    );
    expect(body.bootstrapStackName).not.toBe(oldStackName);
    // No published template in the test environment: the fresh link is
    // handed out by the install page once the vendor publishes one.
    expect(body.quickCreateUrl).toBeNull();

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(dep!.state).toBe('NOT_INSTALLED');
    expect(dep!.installationId).toBeNull();
    expect(dep!.enrollmentUsedAt).toBeNull();
    expect(dep!.attemptNumber).toBe(1);
    expect(dep!.installStartedAt).toBeNull();
    expect(dep!.enrollmentCode).not.toBe(deployment.enrollmentCode);

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    expect(jobs[0]!.state).toBe('CANCELLED');

    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.deploymentId, deployment.id));
    expect(events.some((row) => row.eventType === 'install.retry.requested')).toBe(true);
  });

  it('POST /api/install/:installLinkId/retry refuses a deployment that already installed successfully', async () => {
    const { deployment, installLinkId } = await seedWaiting({ state: 'HEALTHY' });
    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment.id,
      type: 'INSTALL',
      state: 'SUCCEEDED',
      idempotencyKey: `${deployment.id}:INSTALL`,
      payload: {},
      requestedBy: null,
    });

    const response = await postJson(app, `/api/install/${installLinkId}/retry`, {});
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'INSTALL_ALREADY_SUCCEEDED' } });
  });

  it('POST /api/install/:installLinkId/retry 404s for an unknown link', async () => {
    const response = await postJson(app, `/api/install/${crypto.randomUUID()}/retry`, {});
    expect(response.statusCode).toBe(404);
  });

  it('relay/reset bumps the attempt, recomputes the stack name, and returns a never-installed deployment to NOT_INSTALLED', async () => {
    const application = await insertApplication(db, org.organizationId, { name: 'Reset App' });
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'FAILED',
      installationId: 'inst-reset-test',
      relayStatus: 'DISCONNECTED',
    });
    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment.id,
      type: 'INSTALL',
      state: 'REQUESTED',
      idempotencyKey: `${deployment.id}:INSTALL`,
      payload: {},
      requestedBy: null,
    });

    const response = await postJson(app, `/api/deployments/${deployment.id}/relay/reset`, {}, { cookie: org.cookie });
    expect(response.statusCode).toBe(200);

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(dep!.state).toBe('NOT_INSTALLED');
    expect(dep!.attemptNumber).toBe(1);
    expect(dep!.installationId).toBeNull();
    expect(dep!.installStartedAt).toBeNull();
    expect(dep!.bootstrapStackName).toBe(
      bootstrapStackName({ appName: 'Reset App', deploymentId: deployment.id, attempt: 1 }),
    );

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    expect(jobs[0]!.state).toBe('CANCELLED');
  });

  it('relay/reset keeps a healthy deployment in place (credential rotation only)', async () => {
    const application = await insertApplication(db, org.organizationId, { name: 'Healthy Reset App' });
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'HEALTHY',
    });
    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment.id,
      type: 'INSTALL',
      state: 'SUCCEEDED',
      idempotencyKey: `${deployment.id}:INSTALL`,
      payload: {},
      requestedBy: null,
    });

    const response = await postJson(app, `/api/deployments/${deployment.id}/relay/reset`, {}, { cookie: org.cookie });
    expect(response.statusCode).toBe(200);

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(dep!.state).toBe('HEALTHY');
    expect(dep!.attemptNumber).toBe(1);
    expect(dep!.installationId).toBeNull();
    expect(dep!.enrollmentCode).not.toBe(deployment.enrollmentCode);
  });

  it('serves the same §24 component view on the install page as the fleet row', async () => {
    const application = await insertApplication(db, org.organizationId, {
      name: 'Component Parity App',
      databaseRequired: true,
    });
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'HEALTHY',
      enrollmentUsedAt: new Date(),
      observedState: {
        components: { application: 'HEALTHY' },
        infraHealth: { checks: [{ name: 'database', passed: true }] },
      },
    });

    const installBody = (
      await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}` })
    ).json() as { components: Record<string, string> | null; alreadyInstalled: boolean };
    expect(installBody.alreadyInstalled).toBe(true);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}`,
      headers: { cookie: org.cookie },
    });
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json() as { components: Record<string, string> | null };

    expect(installBody.components).toStrictEqual(detailBody.components);
  });
});

// ── POST /api/deployments/:id/retry-install — first-install recovery ────────
describe('server — retry-install (first-install recovery)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };

  async function seedFailedInstall(
    overrides: Partial<typeof schema.deployments.$inferInsert> = {},
    jobOverrides: Partial<typeof schema.deploymentJobs.$inferInsert> = {},
  ): Promise<typeof schema.deployments.$inferSelect> {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'FAILED',
      installationId: `inst-recovery-${crypto.randomUUID()}`,
      ...overrides,
    });
    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment.id,
      type: 'INSTALL',
      state: 'FAILED',
      idempotencyKey: `${deployment.id}:INSTALL`,
      payload: {},
      requestedBy: null,
      ...jobOverrides,
    });
    return deployment;
  }

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, 'retry-install@example.com');
    app = await buildServer({ auth, db });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('202s from FAILED: queues a fresh INSTALL job carrying recovery, moves to INSTALLING, logs the event', async () => {
    const deployment = await seedFailedInstall();

    const response = await postJson(app, `/api/deployments/${deployment.id}/retry-install`, {}, { cookie: org.cookie });
    expect(response.statusCode).toBe(202);
    const { jobId } = response.json() as { jobId: string };

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(dep!.state).toBe('INSTALLING');

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(and(eq(schema.deploymentJobs.deploymentId, deployment.id), eq(schema.deploymentJobs.type, 'INSTALL')));
    expect(jobs).toHaveLength(2);
    const retry = jobs.find((j) => j.id === jobId)!;
    expect(retry.state).toBe('REQUESTED');
    expect(retry.idempotencyKey).toBe(`${deployment.id}:INSTALL:RETRY:1`);
    // §31 parameters travel alongside recovery — see install-parameters.test.ts
    // for the parameter-value coverage.
    expect(retry.payload).toMatchObject({ recovery: { neverInstalled: true } });
    expect(retry.payload['parameters']).toBeTypeOf('object');

    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(and(eq(schema.eventLogs.deploymentId, deployment.id), eq(schema.eventLogs.eventType, 'install.retry.requested')));
    expect(events).toHaveLength(1);
    expect(events[0]!.result).toBe('pending');
  });

  it('a double-click reuses the same retry job (200, no second job)', async () => {
    const deployment = await seedFailedInstall();

    const first = await postJson(app, `/api/deployments/${deployment.id}/retry-install`, {}, { cookie: org.cookie });
    expect(first.statusCode).toBe(202);
    const second = await postJson(app, `/api/deployments/${deployment.id}/retry-install`, {}, { cookie: org.cookie });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { jobId: string }).jobId).toBe((first.json() as { jobId: string }).jobId);

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(and(eq(schema.deploymentJobs.deploymentId, deployment.id), eq(schema.deploymentJobs.type, 'INSTALL')));
    expect(jobs).toHaveLength(2);
  });

  it('409s when any earlier INSTALL ever succeeded — recovery must stay destructive-only-for-never-installed', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'FAILED',
      installationId: 'inst-once-healthy',
    });
    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment.id,
      type: 'INSTALL',
      state: 'SUCCEEDED',
      idempotencyKey: `${deployment.id}:INSTALL`,
      payload: {},
      requestedBy: null,
    });

    const response = await postJson(app, `/api/deployments/${deployment.id}/retry-install`, {}, { cookie: org.cookie });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'INSTALL_ALREADY_SUCCEEDED' } });
  });

  it('409s when the deployment is not in a retryable state', async () => {
    const deployment = await seedFailedInstall({ state: 'NOT_INSTALLED', installationId: null });

    const response = await postJson(app, `/api/deployments/${deployment.id}/retry-install`, {}, { cookie: org.cookie });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'INSTALL_NOT_RETRYABLE' } });
  });

  it('409s (RELAY_NOT_CONNECTED) when no relay is bound to a FAILED deployment', async () => {
    const deployment = await seedFailedInstall({ installationId: null });

    const response = await postJson(app, `/api/deployments/${deployment.id}/retry-install`, {}, { cookie: org.cookie });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'RELAY_NOT_CONNECTED' } });
  });

  // A dead relay never picks the retry job up; the watchdog would re-fail the
  // deployment an hour later. The recovery for a dead relay is
  // re-enrollment (relay/reset), which the UI can point to only if this
  // route refuses.
  it('409s (RELAY_DISCONNECTED) when the bound relay is dead — re-enrollment, not another job', async () => {
    const deployment = await seedFailedInstall({ relayStatus: 'DISCONNECTED' });

    const response = await postJson(app, `/api/deployments/${deployment.id}/retry-install`, {}, { cookie: org.cookie });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'RELAY_DISCONNECTED' } });
  });

  it('409s while a fresh INSTALL attempt is still in flight', async () => {
    const deployment = await seedFailedInstall({ state: 'INSTALLING' }, { state: 'RUNNING', startedAt: new Date() });

    const response = await postJson(app, `/api/deployments/${deployment.id}/retry-install`, {}, { cookie: org.cookie });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'INSTALL_NOT_RETRYABLE' } });
  });

  it('supersedes a stale RUNNING install (dead relay invocation) and cancels the old job', async () => {
    const deployment = await seedFailedInstall(
      { state: 'INSTALLING' },
      { state: 'RUNNING', startedAt: new Date(Date.now() - 31 * 60 * 1000) },
    );

    const response = await postJson(app, `/api/deployments/${deployment.id}/retry-install`, {}, { cookie: org.cookie });
    expect(response.statusCode).toBe(202);

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(and(eq(schema.deploymentJobs.deploymentId, deployment.id), eq(schema.deploymentJobs.type, 'INSTALL')));
    expect(jobs.find((j) => j.idempotencyKey === `${deployment.id}:INSTALL`)!.state).toBe('CANCELLED');
    expect(jobs.find((j) => j.idempotencyKey === `${deployment.id}:INSTALL:RETRY:1`)!.state).toBe('REQUESTED');
  });
});

// ── §59: composed infrastructure inventory ───────────────────────────────────
describe('server — infrastructure inventory (§59)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };
  let applicationId: string;
  let customerId: string;
  const STACK_ID = 'arn:aws:cloudformation:us-east-1:123456789012:stack/deployz-app/test';
  const RELAY_TOKEN = 'infra-relay-token';

  interface InfraBody {
    provider: string;
    region: string;
    stackStatus: string | null;
    connectionState: string;
    snapshotState: string;
    summary: { status: string; componentCount: number; technicalResourceCount: number };
    components: Array<{
      kind: string;
      name: string;
      purpose: string;
      status: string;
      awsService: string;
      region: string;
      lifecycle: string;
      resources: Array<{
        logicalId: string;
        physicalId: string | null;
        type: string;
        status: string;
        statusReason: string | null;
      }>;
    }>;
    lastUpdatedAt: string | null;
    disconnectWarning: { lastVerifiedAt: string } | null;
  }

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, 'infra-org@example.com');
    app = await buildServer({ auth, db });

    const application = await insertApplication(db, org.organizationId);
    applicationId = application.id;
    const customer = await insertCustomer(db, org.organizationId);
    customerId = customer.id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  async function newDeployment(
    overrides: Partial<typeof schema.deployments.$inferInsert> = {},
  ): Promise<typeof schema.deployments.$inferSelect> {
    return insertDeployment(db, org.organizationId, applicationId, customerId, overrides);
  }

  async function getInfrastructure(
    deploymentId: string,
    headers: Record<string, string> = {},
  ): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> {
    return app.inject({
      method: 'GET',
      url: `/api/deployments/${deploymentId}/infrastructure`,
      headers,
    });
  }

  async function persistRows(
    deploymentId: string,
    resources: Array<{ logicalId: string; type: string; status: string; statusReason?: string }>,
    observedAt: string,
  ): Promise<void> {
    await persistDeploymentResourceSnapshot(db, {
      deploymentId,
      stackId: STACK_ID,
      resources,
      observedAt,
    });
  }

  async function bindRelay(
    deploymentId: string,
    installationId: string,
  ): Promise<void> {
    const [deployment] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deploymentId));
    const register = await postJson(
      app,
      '/api/relay/register',
      { enrollmentCode: deployment!.enrollmentCode, installationId },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(register.statusCode, register.body).toBe(200);
  }

  it('authorization — 401 without a session, 404 for another organization', async () => {
    const deployment = await newDeployment();
    const url = `/api/deployments/${deployment.id}/infrastructure`;

    const unauth = await app.inject({ method: 'GET', url });
    expect(unauth.statusCode).toBe(401);

    const snooper = await signUpAndGetOrg(auth, db, 'infra-snooper@example.com');
    const crossOrg = await app.inject({ method: 'GET', url, headers: { cookie: snooper.cookie } });
    expect(crossOrg.statusCode).toBe(404);
  });

  it('healthy — all-ready rows serve a healthy summary, fresh and connected', async () => {
    const deployment = await newDeployment({
      state: 'HEALTHY',
      relayStatus: 'CONNECTED',
      lastHealthAt: new Date(),
      observedState: { infraHealth: { provisioning: { stackStatus: 'CREATE_COMPLETE' } } },
    });
    await persistRows(
      deployment.id,
      [
        { logicalId: 'Service', type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' },
        { logicalId: 'Database', type: 'AWS::RDS::DBInstance', status: 'CREATE_COMPLETE' },
        { logicalId: 'AppBucket', type: 'AWS::S3::Bucket', status: 'CREATE_COMPLETE' },
      ],
      new Date().toISOString(),
    );

    const response = await getInfrastructure(deployment.id, { cookie: org.cookie });
    expect(response.statusCode).toBe(200);
    const body = response.json() as InfraBody;

    expect(body.provider).toBe('aws');
    expect(body.region).toBe('us-east-1');
    expect(body.stackStatus).toBe('CREATE_COMPLETE');
    expect(body.connectionState).toBe('connected');
    expect(body.snapshotState).toBe('fresh');
    expect(body.summary).toEqual({ status: 'healthy', componentCount: 3, technicalResourceCount: 3 });
    expect(body.components.map((c) => [c.kind, c.status])).toEqual([
      ['application', 'ready'],
      ['database', 'ready'],
      ['storage', 'ready'],
    ]);
    expect(body.components[0]!.awsService).toBe('ECS');
    expect(body.components[2]!.awsService).toBe('S3');
    // The technical disclosure carries the RAW AWS status, not the mapped one.
    expect(body.components[1]!.resources[0]).toMatchObject({
      type: 'AWS::RDS::DBInstance',
      status: 'CREATE_COMPLETE',
    });
    expect(body.lastUpdatedAt).not.toBeNull();
    expect(body.disconnectWarning).toBeNull();
  });

  it('provisioning — in-progress rows dominate the summary', async () => {
    const deployment = await newDeployment({ state: 'INSTALLING' });
    await persistRows(
      deployment.id,
      [
        { logicalId: 'Service', type: 'AWS::ECS::Service', status: 'CREATE_IN_PROGRESS' },
        { logicalId: 'Database', type: 'AWS::RDS::DBInstance', status: 'CREATE_IN_PROGRESS' },
      ],
      new Date().toISOString(),
    );

    const body = (await getInfrastructure(deployment.id, { cookie: org.cookie })).json() as InfraBody;
    expect(body.summary.status).toBe('provisioning');
    expect(body.components.every((c) => c.status === 'provisioning')).toBe(true);
  });

  it('failure — a CREATE_FAILED resource fails its component and the summary', async () => {
    const deployment = await newDeployment({ state: 'FAILED' });
    await persistRows(
      deployment.id,
      [
        { logicalId: 'Service', type: 'AWS::ECS::Service', status: 'CREATE_FAILED', statusReason: 'No space left on device' },
        { logicalId: 'Database', type: 'AWS::RDS::DBInstance', status: 'CREATE_COMPLETE' },
      ],
      new Date().toISOString(),
    );

    const body = (await getInfrastructure(deployment.id, { cookie: org.cookie })).json() as InfraBody;
    expect(body.summary.status).toBe('failed');
    const application = body.components.find((c) => c.kind === 'application')!;
    expect(application.status).toBe('failed');
    expect(application.resources[0]).toMatchObject({
      status: 'CREATE_FAILED',
      statusReason: 'No space left on device',
    });
    expect(body.components.find((c) => c.kind === 'database')!.status).toBe('ready');
  });

  it('disconnected — a stale snapshot keeps last-known healthy statuses and warns', async () => {
    const deployment = await newDeployment({ state: 'HEALTHY' });
    // Snapshot and relay liveness both an hour old — well past the 15-minute
    // staleness window.
    await persistRows(
      deployment.id,
      [{ logicalId: 'Service', type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' }],
      new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    );
    await db
      .update(schema.deployments)
      .set({ relayStatus: 'DISCONNECTED', lastHealthAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(schema.deployments.id, deployment.id));

    const body = (await getInfrastructure(deployment.id, { cookie: org.cookie })).json() as InfraBody;
    expect(body.connectionState).toBe('disconnected');
    expect(body.snapshotState).toBe('stale');
    expect(body.disconnectWarning).not.toBeNull();
    // The disconnect never rewrites the inventory: last-known rows stay ready.
    expect(body.components[0]!.status).toBe('ready');
    expect(body.summary.status).toBe('healthy');
  });

  it('deleted — the preserved final snapshot re-derives statuses from lifecycle', async () => {
    const deployment = await newDeployment({ state: 'DELETED', deletedAt: new Date() });
    await persistRows(
      deployment.id,
      [
        { logicalId: 'Service', type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' },
        { logicalId: 'Database', type: 'AWS::RDS::DBInstance', status: 'CREATE_COMPLETE' },
        { logicalId: 'BackupBucket', type: 'AWS::S3::Bucket', status: 'CREATE_COMPLETE' },
      ],
      new Date().toISOString(),
    );

    const body = (await getInfrastructure(deployment.id, { cookie: org.cookie })).json() as InfraBody;
    expect(body.components.map((c) => [c.kind, c.status])).toEqual([
      ['application', 'removed'],
      ['database', 'retained'],
      ['storage', 'retained'],
    ]);
    expect(body.summary.status).toBe('retained');
    // Technical detail from the final snapshot survives the override.
    expect(body.components[0]!.resources[0].status).toBe('CREATE_COMPLETE');
  });

  it('a relay heartbeat inventory persists and serves back through the endpoint', async () => {
    const deployment = await newDeployment({ state: 'NOT_INSTALLED' });
    const installationId = `inst-heartbeat-${crypto.randomUUID()}`;
    await bindRelay(deployment.id, installationId);

    const observedAt = new Date().toISOString();
    const health = await postJson(
      app,
      '/api/relay/health',
      {
        installationId,
        healthStatus: 'HEALTHY',
        observedState: {
          infraHealth: {
            verified: true,
            checks: [],
            inventory: {
              stackId: STACK_ID,
              observedAt,
              resources: [
                { logicalId: 'Service', type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' },
                { logicalId: 'Database', type: 'AWS::RDS::DBInstance', status: 'CREATE_COMPLETE' },
              ],
            },
          },
        },
      },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(health.statusCode).toBe(200);

    const persisted = await db
      .select()
      .from(schema.deploymentResources)
      .where(eq(schema.deploymentResources.deploymentId, deployment.id));
    expect(persisted).toHaveLength(2);
    expect(persisted.find((r) => r.logicalResourceId === 'Database')).toMatchObject({
      resourceStatus: 'ready',
      rawResourceStatus: 'CREATE_COMPLETE',
      componentKind: 'database',
    });

    const body = (await getInfrastructure(deployment.id, { cookie: org.cookie })).json() as InfraBody;
    expect(body.summary).toEqual({ status: 'healthy', componentCount: 2, technicalResourceCount: 2 });
    expect(body.snapshotState).toBe('fresh');
  });

  it('a heartbeat WITHOUT an inventory is a no-op that preserves the previous snapshot', async () => {
    const deployment = await newDeployment({ state: 'NOT_INSTALLED' });
    const installationId = `inst-noop-${crypto.randomUUID()}`;
    await bindRelay(deployment.id, installationId);
    // One row persisted directly — the "good" snapshot a later null read must
    // never disturb.
    await persistRows(
      deployment.id,
      [{ logicalId: 'Service', type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' }],
      new Date().toISOString(),
    );

    const health = await postJson(
      app,
      '/api/relay/health',
      { installationId, healthStatus: 'HEALTHY', observedState: { infraHealth: null } },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(health.statusCode).toBe(200);

    const rows = await db
      .select()
      .from(schema.deploymentResources)
      .where(eq(schema.deploymentResources.deploymentId, deployment.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resourceStatus).toBe('ready');

const body = (await getInfrastructure(deployment.id, { cookie: org.cookie })).json() as InfraBody;
    expect(body.summary).toEqual({ status: 'healthy', componentCount: 1, technicalResourceCount: 1 });
    expect(body.components[0]!.status).toBe('ready');
  });
});
