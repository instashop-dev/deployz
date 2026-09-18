import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';
import { requiredAwsResources, toPlanAwsResource } from '@deployz/contracts';

import { createAuth, type Auth } from './auth.js';
import { buildServer } from './server.js';

// Phase 4 — GET /api/applications/:id/plan and GET /api/deployments/:id/plan,
// and the public install response's `plan` field. Mirrors
// install-parameters.test.ts's compact harness (own PGlite instance, no
// shared helpers module).

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
      name: 'Plan Test App',
      repoFullName: `acme/plan-test-${crypto.randomUUID().slice(0, 8)}`,
      repoUrl: 'https://github.com/acme/plan-test',
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
      name: 'Plan Test Customer',
      email: `plan-test-${crypto.randomUUID()}@example.com`,
      ...overrides,
    })
    .returning();
  return row!;
}

/** A stored manifest with a PostgreSQL database and no Redis, no Storage need. */
const POSTGRES_MANIFEST = {
  schemaVersion: 1,
  application: { root: '.', runtime: 'node', framework: 'express', dockerfilePath: 'Dockerfile' },
  build: { command: 'npm run build', context: '.' },
  web: { command: 'npm start', port: 3000 },
  health: { path: '/health' },
  database: { postgres: true },
  redis: { required: false, envBindings: [] },
  storage: { required: false, envBindings: [] },
  migration: { command: null },
  worker: { command: null },
  environment: { variables: [] },
  externalServices: [],
  unsupported: [],
} as const;

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
      desiredState: { manifest: POSTGRES_MANIFEST },
      ...overrides,
    })
    .returning();
  return row!;
}

describe('deployment plans (Phase 4)', () => {
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
    org = await signUpAndGetOrg(auth, db, 'plan-test@example.com');
    app = await buildServer({ auth, db });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('GET /api/applications/:id/plan 409s while analysis has not completed', async () => {
    const application = await insertApplication(db, org.organizationId);
    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/plan`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'ANALYSIS_NOT_COMPLETE' } });
  });

  it('GET /api/applications/:id/plan: a redis-required app carries a Cache CREATE entry', async () => {
    const application = await insertApplication(db, org.organizationId, {
      analysisStatus: 'COMPLETE',
      redisRequired: true,
    });
    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/plan`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const plan = response.json() as { action: string; region: string | null; components: unknown[] };
    expect(plan.action).toBe('INSTALL');
    expect(plan.region).toBeNull();
    expect(plan.components).toContainEqual({ kind: 'cache', name: 'Cache', action: 'CREATE', lifecycle: 'delete' });
  });

  it('GET /api/deployments/:id/plan?action=destroy: RETAINs Database and Storage, DELETEs Application and Secure endpoint', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id);

    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}/plan?action=destroy`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toStrictEqual({
      schemaVersion: 1,
      action: 'DESTROY',
      region: 'us-east-1',
      components: [
        { kind: 'application', name: 'Application', action: 'DELETE', lifecycle: 'delete' },
        { kind: 'endpoint', name: 'Secure endpoint', action: 'DELETE', lifecycle: 'delete' },
        { kind: 'database', name: 'Database', action: 'RETAIN', lifecycle: 'retain' },
        { kind: 'storage', name: 'Storage', action: 'RETAIN', lifecycle: 'retain' },
      ],
      awsResources: requiredAwsResources({ postgres: true, redis: false }).map(toPlanAwsResource),
      requirementDrift: [],
    });
  });

  it('GET /api/deployments/:id/plan?action=update: reports drift, never a CREATE, when the application gains Redis after the deployment was created', async () => {
    // databaseRequired: true matches POSTGRES_MANIFEST (the deployment's
    // frozen manifest) so only the Redis flip below produces drift.
    const application = await insertApplication(db, org.organizationId, { databaseRequired: true });
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id);

    // The application's live requirements diverge from the deployment's
    // frozen manifest — the MVP architecture cannot apply this in place.
    await db.update(schema.applications).set({ redisRequired: true }).where(eq(schema.applications.id, application.id));

    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}/plan?action=update`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const plan = response.json() as { components: Array<{ kind: string }>; requirementDrift: unknown[] };
    expect(plan.components.map((component) => component.kind)).not.toContain('cache');
    expect(plan.requirementDrift).toEqual([{ kind: 'cache', deployed: false, desired: true }]);
  });

  it('GET /api/deployments/:id/plan with an unknown action 400s', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id);

    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}/plan?action=bogus`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode, response.body).toBe(400);
  });

  it('GET /api/deployments/:id/plan 422s when the deployment has no stored manifest', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      desiredState: {},
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}/plan?action=install`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'MANIFEST_NEEDS_CONFIGURATION' } });
  });

  it('the public install response\'s plan equals GET /api/deployments/:id/plan?action=install', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id);

    const installResponse = await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}` });
    expect(installResponse.statusCode, installResponse.body).toBe(200);
    const installBody = installResponse.json() as { plan: unknown };

    const deploymentPlanResponse = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}/plan?action=install`,
      headers: { cookie: org.cookie },
    });
    expect(deploymentPlanResponse.statusCode, deploymentPlanResponse.body).toBe(200);

    expect(installBody.plan).toEqual(deploymentPlanResponse.json());
  });
});
