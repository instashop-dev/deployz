import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { errorEnvelopeSchema } from '@deployz/contracts';
import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import { DOMAIN_VALIDATION_MESSAGES } from './domain-validation.js';
import { hashRelayToken } from './relay-store.js';
import { buildServer } from './server.js';

// Task 4 — POST/GET /api/deployments/:id/domain and the relay-result
// integration that applies CONFIGURE_DOMAIN outcomes to the domain row
// without ever touching deployments.state.

// ── Shared test helpers (mirrors server.test.ts) ────────────────────────────

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

/** POST a JSON body through app.inject, matching server.ts's raw-string JSON parser. */
function postJson(
  app: FastifyInstance,
  url: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    payload: JSON.stringify(body),
  });
}

// ── POST / GET /api/deployments/:id/domain ──────────────────────────────────

describe('custom domain routes', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };
  let deployment: typeof schema.deployments.$inferSelect;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    app = await buildServer({ auth, db });

    org = await signUpAndGetOrg(auth, db, 'domain-owner@example.com');
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    deployment = await insertDeployment(db, org.organizationId, application.id, customer.id);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('GET returns { domain: null } before any domain is added', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}/domain`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ domain: null });
  });

  it('unauthenticated POST is rejected', async () => {
    const response = await postJson(app, `/api/deployments/${deployment.id}/domain`, {
      hostname: 'app.customer.com',
    });
    expect(response.statusCode).toBe(401);
  });

  it('POST rejects a URL instead of a bare hostname', async () => {
    const response = await postJson(
      app,
      `/api/deployments/${deployment.id}/domain`,
      { hostname: 'https://app.customer.com' },
      { cookie: org.cookie },
    );
    expect(response.statusCode).toBe(400);
    const envelope = errorEnvelopeSchema.parse(response.json());
    expect(envelope.error.code).toBe('URL_ENTERED');
    expect(envelope.error.message).toBe(DOMAIN_VALIDATION_MESSAGES.URL_ENTERED);
  });

  it('POST for a deployment in another org 404s (IDOR guard)', async () => {
    const otherOrg = await signUpAndGetOrg(auth, db, 'other-org@example.com');
    const response = await postJson(
      app,
      `/api/deployments/${deployment.id}/domain`,
      { hostname: 'app.customer.com' },
      { cookie: otherOrg.cookie },
    );
    expect(response.statusCode).toBe(404);
  });

  it('POST with a valid hostname creates a pending domain', async () => {
    const response = await postJson(
      app,
      `/api/deployments/${deployment.id}/domain`,
      { hostname: 'app.customer.com' },
      { cookie: org.cookie },
    );
    expect(response.statusCode).toBe(201);
    const body = response.json() as { domain: { hostname: string; status: string } };
    expect(body.domain.status).toBe('pending');
    expect(body.domain.hostname).toBe('app.customer.com');

    const job = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    expect(job.some((row) => row.type === 'CONFIGURE_DOMAIN')).toBe(true);
  });

  it('GET returns the domain view after it is created', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}/domain`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { domain: { hostname: string; status: string } | null };
    expect(body.domain).not.toBeNull();
    expect(body.domain!.hostname).toBe('app.customer.com');
    expect(body.domain!.status).toBe('pending');
  });

  it('POST for a second org with the same hostname is rejected as taken, without naming the first org', async () => {
    const secondOrg = await signUpAndGetOrg(auth, db, 'second-org@example.com');
    const secondApplication = await insertApplication(db, secondOrg.organizationId);
    const secondCustomer = await insertCustomer(db, secondOrg.organizationId);
    const secondDeployment = await insertDeployment(
      db,
      secondOrg.organizationId,
      secondApplication.id,
      secondCustomer.id,
    );

    const [firstOrgRow] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.id, org.organizationId));

    const response = await postJson(
      app,
      `/api/deployments/${secondDeployment.id}/domain`,
      { hostname: 'app.customer.com' },
      { cookie: secondOrg.cookie },
    );
    expect(response.statusCode).toBe(409);
    const envelope = errorEnvelopeSchema.parse(response.json());
    expect(envelope.error.code).toBe('DOMAIN_TAKEN');
    expect(envelope.error.message).not.toContain(firstOrgRow!.name);
  });
});

// ── Relay result integration ─────────────────────────────────────────────────

describe('custom domain relay result integration', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };
  const RELAY_TOKEN = 'relay-token-domain-xyz';

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    app = await buildServer({ auth, db });
    org = await signUpAndGetOrg(auth, db, 'relay-domain-org@example.com');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  /** Seeds a bound deployment + a pending custom domain + its CONFIGURE_DOMAIN job. */
  async function seedDomainInFlight() {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      // A domain being configured on an already-healthy deployment is the
      // real shape here — the regression this guards is nextState clobbering
      // an unrelated deployment lifecycle state.
      state: 'HEALTHY',
      installationId: `inst-${crypto.randomUUID()}`,
      relayTokenHash: hashRelayToken(RELAY_TOKEN),
    });
    const [domain] = await db
      .insert(schema.customDomains)
      .values({
        deploymentId: deployment.id,
        organizationId: org.organizationId,
        hostname: `app-${crypto.randomUUID().slice(0, 8)}.customer.com`,
        status: 'PENDING',
        createdBy: org.userId,
      })
      .returning();
    const [job] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: deployment.id,
        type: 'CONFIGURE_DOMAIN',
        state: 'RUNNING',
        idempotencyKey: `${deployment.id}:CONFIGURE_DOMAIN:${domain!.id}:0`,
        payload: { hostname: domain!.hostname, domainId: domain!.id },
      })
      .returning();
    return { deployment, domain: domain!, job: job! };
  }

  it('a successful CONFIGURE_DOMAIN result moves the domain to WAITING_FOR_DNS and leaves deployments.state unchanged', async () => {
    const { deployment, domain, job } = await seedDomainInFlight();

    const response = await postJson(
      app,
      `/api/relay/commands/${job.id}/result`,
      {
        success: true,
        output: {
          validationName: `_acme-challenge.${domain.hostname}`,
          validationValue: 'validation-value-abc',
        },
      },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(response.statusCode).toBe(200);

    const [updatedDomain] = await db
      .select()
      .from(schema.customDomains)
      .where(eq(schema.customDomains.id, domain.id));
    expect(updatedDomain!.status).toBe('WAITING_FOR_DNS');

    const [updatedDeployment] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id));
    expect(updatedDeployment!.state).toBe('HEALTHY');
  });

  it('a failed CONFIGURE_DOMAIN result moves the domain to ERROR and leaves deployments.state unchanged (regression guard)', async () => {
    const { deployment, domain, job } = await seedDomainInFlight();

    const response = await postJson(
      app,
      `/api/relay/commands/${job.id}/result`,
      { success: false, error: 'certificate request failed' },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(response.statusCode).toBe(200);

    const [updatedDomain] = await db
      .select()
      .from(schema.customDomains)
      .where(eq(schema.customDomains.id, domain.id));
    expect(updatedDomain!.status).toBe('ERROR');

    // This is the regression guard for the `nextState = 'FAILED'` pitfall:
    // a failed domain job must never drag the deployment's own lifecycle
    // state down with it.
    const [updatedDeployment] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id));
    expect(updatedDeployment!.state).toBe('HEALTHY');
  });
});
