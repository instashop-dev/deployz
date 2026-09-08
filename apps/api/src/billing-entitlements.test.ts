import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import { buildServer } from './server.js';

// Paddle migration Phase 7 — free evaluation entitlements. Evaluation
// (signup, analysis, configuration, customer records, release builds, and
// ONE active TEST deployment per application) is free and consults billing
// nowhere; only a PRODUCTION deployment requires an ACTIVE subscription.
//
// §10 "existing tests unaffected without any subscription row" is covered
// by tests already in the suite, not duplicated here:
//   - analysis: telemetry-application-funnel.test.ts's `runAnalysis` tests
//     (POST /api/applications/:id/analyse), no subscription row seeded.
//   - customer creation: server.test.ts "POST /api/customers 403s on a
//     cross-org body.organizationId, succeeds when it matches the session".
//   - release builds: server.test.ts's release-build tests around
//     `listReleases` (POST/GET /api/applications/:id/releases).

const READY_METADATA = {
  hasDockerfile: true,
  dockerfilePath: 'Dockerfile',
  port: '3000',
  startupCommands: ['node dist/index.js'],
  usesPostgresql: false,
  postgres: { required: false },
  usesRedis: false,
  redis: { required: false },
  usesS3: false,
  usesLocalFilesystem: false,
  databaseState: 'none',
};

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
      name: 'Entitlements App',
      repoFullName: `acme/entitlements-${crypto.randomUUID().slice(0, 8)}`,
      repoUrl: 'https://github.com/acme/entitlements',
      defaultBranch: 'main',
      detectedMetadata: READY_METADATA,
      ...overrides,
    })
    .returning();
  return row!;
}

async function insertCustomer(
  db: Db,
  organizationId: string,
): Promise<typeof schema.customers.$inferSelect> {
  const [row] = await db
    .insert(schema.customers)
    .values({
      organizationId,
      name: 'Entitlements Customer',
      email: `entitlements-${crypto.randomUUID()}@example.com`,
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
      desiredState: { manifest: READY_METADATA },
      ...overrides,
    })
    .returning();
  return row!;
}

/** Fixture ids only — never realistic Paddle ids. */
async function setSubscription(
  db: Db,
  organizationId: string,
  status: (typeof schema.billingSubscriptions.$inferInsert)['status'],
): Promise<void> {
  await db.insert(schema.billingSubscriptions).values({
    organizationId,
    providerCustomerId: `ctm_fixture_${organizationId}`,
    providerSubscriptionId: `sub_fixture_${organizationId}`,
    status,
  });
}

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

describe('billing entitlements — free evaluation (Paddle migration Phase 7)', () => {
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
    org = await signUpAndGetOrg(auth, db, 'entitlements@example.com');
    app = await buildServer({ auth, db });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('1. POST /api/deployments TEST with no subscription -> 201 (evaluation is free)', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const response = await postJson(
      app,
      '/api/deployments',
      { applicationId: application.id, customerId: customer.id, region: 'us-east-1', deploymentType: 'TEST' },
      { cookie: org.cookie },
    );
    expect(response.statusCode, response.body).toBe(201);
  });

  it('2. a second TEST for the same application while the first is not DELETED -> 409 TEST_DEPLOYMENT_EXISTS', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const first = await postJson(
      app,
      '/api/deployments',
      { applicationId: application.id, customerId: customer.id, region: 'us-east-1', deploymentType: 'TEST' },
      { cookie: org.cookie },
    );
    expect(first.statusCode, first.body).toBe(201);
    const firstId = (first.json() as { id: string }).id;

    const second = await postJson(
      app,
      '/api/deployments',
      { applicationId: application.id, customerId: customer.id, region: 'us-east-1', deploymentType: 'TEST' },
      { cookie: org.cookie },
    );
    expect(second.statusCode).toBe(409);
    const body = second.json() as { error: { code: string; details?: { deploymentId?: string } } };
    expect(body.error.code).toBe('TEST_DEPLOYMENT_EXISTS');
    expect(body.error.details?.deploymentId).toBe(firstId);
  });

  it('3. after the first test deployment is DELETED, a new TEST -> 201', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const first = await postJson(
      app,
      '/api/deployments',
      { applicationId: application.id, customerId: customer.id, region: 'us-east-1', deploymentType: 'TEST' },
      { cookie: org.cookie },
    );
    expect(first.statusCode, first.body).toBe(201);
    const firstId = (first.json() as { id: string }).id;

    // Never installed — POST /destroy removes it synchronously (state DELETED).
    const destroyed = await postJson(app, `/api/deployments/${firstId}/destroy`, {}, { cookie: org.cookie });
    expect(destroyed.statusCode, destroyed.body).toBe(200);
    expect((destroyed.json() as { state: string }).state).toBe('DELETED');

    const again = await postJson(
      app,
      '/api/deployments',
      { applicationId: application.id, customerId: customer.id, region: 'us-east-1', deploymentType: 'TEST' },
      { cookie: org.cookie },
    );
    expect(again.statusCode, again.body).toBe(201);
  });

  it('4. PRODUCTION with no subscription row -> 402 SUBSCRIPTION_REQUIRED, subscriptionStatus null, no rows created', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const deploymentsBefore = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.applicationId, application.id));

    const response = await postJson(
      app,
      '/api/deployments',
      { applicationId: application.id, customerId: customer.id, region: 'us-east-1', deploymentType: 'PRODUCTION' },
      { cookie: org.cookie },
    );
    expect(response.statusCode, response.body).toBe(402);
    const body = response.json() as {
      error: { code: string; details?: { subscriptionStatus: unknown } };
    };
    expect(body.error.code).toBe('SUBSCRIPTION_REQUIRED');
    expect(body.error.details?.subscriptionStatus).toBeNull();

    const deploymentsAfter = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.applicationId, application.id));
    expect(deploymentsAfter.length).toBe(deploymentsBefore.length);
    const customerRow = await db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.id, customer.id));
    expect(customerRow).toHaveLength(1);
  });

  it('5. PRODUCTION with PAST_DUE / PAUSED / CANCELED -> 402 with the status in details', async () => {
    for (const status of ['PAST_DUE', 'PAUSED', 'CANCELED'] as const) {
      const statusOrg = await signUpAndGetOrg(auth, db, `status-${status.toLowerCase()}@example.com`);
      await setSubscription(db, statusOrg.organizationId, status);
      const application = await insertApplication(db, statusOrg.organizationId);
      const customer = await insertCustomer(db, statusOrg.organizationId);

      const response = await postJson(
        app,
        '/api/deployments',
        { applicationId: application.id, customerId: customer.id, region: 'us-east-1', deploymentType: 'PRODUCTION' },
        { cookie: statusOrg.cookie },
      );
      expect(response.statusCode, response.body).toBe(402);
      const body = response.json() as {
        error: { code: string; details?: { subscriptionStatus: unknown } };
      };
      expect(body.error.code).toBe('SUBSCRIPTION_REQUIRED');
      expect(body.error.details?.subscriptionStatus).toBe(status);
    }
  });

  it('6. PRODUCTION with ACTIVE -> 201, billingState NOT_STARTED', async () => {
    const activeOrg = await signUpAndGetOrg(auth, db, 'active-subscription@example.com');
    await setSubscription(db, activeOrg.organizationId, 'ACTIVE');
    const application = await insertApplication(db, activeOrg.organizationId);
    const customer = await insertCustomer(db, activeOrg.organizationId);

    const response = await postJson(
      app,
      '/api/deployments',
      { applicationId: application.id, customerId: customer.id, region: 'us-east-1', deploymentType: 'PRODUCTION' },
      { cookie: activeOrg.cookie },
    );
    expect(response.statusCode, response.body).toBe(201);
    expect((response.json() as { billingState: string }).billingState).toBe('NOT_STARTED');
  });

  it('7. deploy-link creation without an active subscription -> 402; with ACTIVE -> success', async () => {
    const linkOrg = await signUpAndGetOrg(auth, db, 'deploy-link-entitlements@example.com');
    const application = await insertApplication(db, linkOrg.organizationId);
    const customer = await insertCustomer(db, linkOrg.organizationId);

    const blocked = await postJson(
      app,
      `/api/customers/${customer.id}/deploy-links`,
      { applicationId: application.id, region: 'us-east-1' },
      { cookie: linkOrg.cookie },
    );
    expect(blocked.statusCode, blocked.body).toBe(402);
    expect((blocked.json() as { error: { code: string } }).error.code).toBe('SUBSCRIPTION_REQUIRED');

    await setSubscription(db, linkOrg.organizationId, 'ACTIVE');
    const ok = await postJson(
      app,
      `/api/customers/${customer.id}/deploy-links`,
      { applicationId: application.id, region: 'us-east-1' },
      { cookie: linkOrg.cookie },
    );
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it('8. rollback/restart/destroy on an existing production deployment with PAST_DUE -> not blocked (never 402)', async () => {
    const pastDueOrg = await signUpAndGetOrg(auth, db, 'past-due-actions@example.com');
    await setSubscription(db, pastDueOrg.organizationId, 'ACTIVE');
    const application = await insertApplication(db, pastDueOrg.organizationId);
    const customer = await insertCustomer(db, pastDueOrg.organizationId);

    // Created while ACTIVE, never installed — destroy removes it synchronously.
    const created = await postJson(
      app,
      '/api/deployments',
      { applicationId: application.id, customerId: customer.id, region: 'us-east-1', deploymentType: 'PRODUCTION' },
      { cookie: pastDueOrg.cookie },
    );
    expect(created.statusCode, created.body).toBe(201);
    const neverInstalledId = (created.json() as { id: string }).id;

    // A separate deployment seeded directly in a live state so restart has
    // something to act on.
    const running = await insertDeployment(db, pastDueOrg.organizationId, application.id, customer.id, {
      deploymentType: 'PRODUCTION',
      state: 'HEALTHY',
    });

    // Subscription lapses AFTER both deployments already exist — the day-2
    // actions below must keep working regardless (§ product rule).
    await db
      .update(schema.billingSubscriptions)
      .set({ status: 'PAST_DUE' })
      .where(eq(schema.billingSubscriptions.organizationId, pastDueOrg.organizationId));

    const destroy = await postJson(app, `/api/deployments/${neverInstalledId}/destroy`, {}, { cookie: pastDueOrg.cookie });
    expect(destroy.statusCode, destroy.body).toBe(200);
    expect((destroy.json() as { state: string }).state).toBe('DELETED');

    const restart = await postJson(app, `/api/deployments/${running.id}/restart`, {}, { cookie: pastDueOrg.cookie });
    expect(restart.statusCode, restart.body).toBe(202);
  });
});

// Fix round 1 (ruling R7-1) — billingFixtureMode: CI's simulated E2E suite
// creates PRODUCTION deployments through the real routes with no manual
// subscription seeding, so a fresh organization needs one automatically.
// Own PGlite/auth/app instance because the flag is resolved once inside
// buildServer and baked into createAuth's session hook at construction time.
describe('billing entitlements — billingFixtureMode (fix round 1)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db, { billingFixtureMode: true });
    app = await buildServer({ auth, db, billingFixtureMode: true });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('a fresh organization can create a PRODUCTION deployment with no manual subscription row', async () => {
    const org = await signUpAndGetOrg(auth, db, 'fixture-mode@example.com');

    // The signup session hook already seeded an ACTIVE row.
    const seeded = await db
      .select({ status: schema.billingSubscriptions.status })
      .from(schema.billingSubscriptions)
      .where(eq(schema.billingSubscriptions.organizationId, org.organizationId));
    expect(seeded[0]?.status).toBe('ACTIVE');

    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const response = await postJson(
      app,
      '/api/deployments',
      { applicationId: application.id, customerId: customer.id, region: 'us-east-1', deploymentType: 'PRODUCTION' },
      { cookie: org.cookie },
    );
    expect(response.statusCode, response.body).toBe(201);
  });

  it('the fixture route flips the subscription status, and null returns the org to 402', async () => {
    const org = await signUpAndGetOrg(auth, db, 'fixture-mode-flip@example.com');
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const attempt = () =>
      postJson(
        app,
        '/api/deployments',
        { applicationId: application.id, customerId: customer.id, region: 'us-east-1', deploymentType: 'PRODUCTION' },
        { cookie: org.cookie },
      );

    const pastDue = await postJson(
      app,
      '/internal/fixture/billing/subscription',
      { status: 'PAST_DUE' },
      { cookie: org.cookie },
    );
    expect(pastDue.statusCode, pastDue.body).toBe(200);
    expect((pastDue.json() as { subscriptionStatus: string }).subscriptionStatus).toBe('PAST_DUE');

    const blocked = await attempt();
    expect(blocked.statusCode, blocked.body).toBe(402);
    expect(
      (blocked.json() as { error: { details?: { subscriptionStatus: unknown } } }).error.details
        ?.subscriptionStatus,
    ).toBe('PAST_DUE');

    const cleared = await postJson(
      app,
      '/internal/fixture/billing/subscription',
      { status: null },
      { cookie: org.cookie },
    );
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect((cleared.json() as { subscriptionStatus: unknown }).subscriptionStatus).toBeNull();

    const evaluationBlocked = await attempt();
    expect(evaluationBlocked.statusCode).toBe(402);
    expect(
      (evaluationBlocked.json() as { error: { details?: { subscriptionStatus: unknown } } }).error
        .details?.subscriptionStatus,
    ).toBeNull();

    const activated = await postJson(
      app,
      '/internal/fixture/billing/subscription',
      { status: 'ACTIVE' },
      { cookie: org.cookie },
    );
    expect(activated.statusCode, activated.body).toBe(200);
    const allowed = await attempt();
    expect(allowed.statusCode, allowed.body).toBe(201);
  });

  it('rejects an invalid status', async () => {
    const org = await signUpAndGetOrg(auth, db, 'fixture-mode-invalid@example.com');
    const response = await postJson(
      app,
      '/internal/fixture/billing/subscription',
      { status: 'BOGUS' },
      { cookie: org.cookie },
    );
    expect(response.statusCode).toBe(400);
  });
});
