import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DOCUMENSO_PARAMETERS, IMAGE_REFERENCE_PARAMETER } from '@deployz/contracts';
import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import { DESIRED_COUNT_PARAMETER, buildInstallParameters } from './install-parameters.js';
import { buildServer } from './server.js';

// Task 4 — the CloudFormation parameter values an INSTALL job carries (§31),
// and the two job-creation sites that must attach them: relay registration
// and the retry-install recovery path.

// ── Shared test helpers (mirrors domain-routes.test.ts) ─────────────────────

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

/** A READY manifest — Phase 3 readiness gates re-evaluate it at relay register. */
const READY_MANIFEST = {
  application: { root: '.', runtime: 'node', framework: 'express', dockerfilePath: 'Dockerfile' },
  build: { command: 'npm run build', context: '.' },
  web: { command: 'npm start', port: 3000 },
  health: { path: '/health' },
  database: { postgres: true },
  redis: { required: false, envBindings: [] },
  storage: { required: false, envBindings: [] },
  migration: { command: 'npm run db:migrate' },
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
      desiredState: { manifest: READY_MANIFEST },
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
      version: `1.0.${crypto.randomUUID().slice(0, 8)}`,
      gitSha: crypto.randomUUID().replace(/-/g, ''),
      releaseStatus: 'READY',
      imageDigest: `123456789012.dkr.ecr.us-east-1.amazonaws.com/deployz-fixture@sha256:${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '')}`,
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

const SECRET_SHAPE = /^[A-Za-z0-9_-]{43}$/;

// ── buildInstallParameters ───────────────────────────────────────────────────

describe('buildInstallParameters', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let org: { userId: string; organizationId: string; cookie: string };

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, 'install-parameters@example.com');
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('with a custom domain: includes publicUrl and per-install secrets, no SMTP keys', async () => {
    const application = await insertApplication(db, org.organizationId);
    await insertRelease(db, application.id);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id);
    await db.insert(schema.customDomains).values({
      deploymentId: deployment.id,
      organizationId: org.organizationId,
      hostname: 'docs.example.com',
      status: 'PENDING',
      createdBy: org.userId,
    });

    const { parameters } = await buildInstallParameters(db, deployment.id);

    expect(parameters[DOCUMENSO_PARAMETERS.publicUrl]).toBe('https://docs.example.com');
    expect(parameters[DOCUMENSO_PARAMETERS.nextauthSecret]).toMatch(SECRET_SHAPE);
    expect(parameters[DOCUMENSO_PARAMETERS.encryptionKey]).toMatch(SECRET_SHAPE);
    expect(parameters[DOCUMENSO_PARAMETERS.encryptionSecondaryKey]).toMatch(SECRET_SHAPE);

    for (const key of [
      DOCUMENSO_PARAMETERS.smtpTransport,
      DOCUMENSO_PARAMETERS.smtpHost,
      DOCUMENSO_PARAMETERS.smtpPort,
      DOCUMENSO_PARAMETERS.smtpUsername,
      DOCUMENSO_PARAMETERS.smtpPassword,
      DOCUMENSO_PARAMETERS.smtpFromAddress,
      DOCUMENSO_PARAMETERS.smtpFromName,
    ]) {
      expect(parameters[key]).toBeUndefined();
    }
  });

  it('two calls produce different secrets', async () => {
    const application = await insertApplication(db, org.organizationId);
    await insertRelease(db, application.id);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id);

    const first = await buildInstallParameters(db, deployment.id);
    const second = await buildInstallParameters(db, deployment.id);

    expect(first.parameters[DOCUMENSO_PARAMETERS.nextauthSecret]).not.toBe(
      second.parameters[DOCUMENSO_PARAMETERS.nextauthSecret],
    );
    expect(first.parameters[DOCUMENSO_PARAMETERS.encryptionKey]).not.toBe(
      second.parameters[DOCUMENSO_PARAMETERS.encryptionKey],
    );
    expect(first.parameters[DOCUMENSO_PARAMETERS.encryptionSecondaryKey]).not.toBe(
      second.parameters[DOCUMENSO_PARAMETERS.encryptionSecondaryKey],
    );
  });

  it('without a domain: omits publicUrl', async () => {
    const application = await insertApplication(db, org.organizationId);
    await insertRelease(db, application.id);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id);

    const { parameters } = await buildInstallParameters(db, deployment.id);

    expect(parameters[DOCUMENSO_PARAMETERS.publicUrl]).toBeUndefined();
  });

  it('prefers an ACTIVE custom domain over an ACTIVE default HTTPS hostname', async () => {
    const application = await insertApplication(db, org.organizationId);
    await insertRelease(db, application.id);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id);
    await db
      .update(schema.deployments)
      .set({
        defaultHttps: {
          hostname: `d-${deployment.id}.deployz.dev`,
          status: 'ACTIVE',
          checkCycle: 0,
          lastError: null,
        },
      })
      .where(eq(schema.deployments.id, deployment.id));
    await db.insert(schema.customDomains).values({
      deploymentId: deployment.id,
      organizationId: org.organizationId,
      hostname: 'active.example.com',
      status: 'ACTIVE',
      createdBy: org.userId,
    });

    const { parameters } = await buildInstallParameters(db, deployment.id);

    expect(parameters[DOCUMENSO_PARAMETERS.publicUrl]).toBe('https://active.example.com');
  });

  it('falls back to the ACTIVE default HTTPS hostname when no ACTIVE custom domain exists', async () => {
    const application = await insertApplication(db, org.organizationId);
    await insertRelease(db, application.id);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id);

    const hostname = `d-${deployment.id}.deployz.dev`;
    await db
      .update(schema.deployments)
      .set({ defaultHttps: { hostname, status: 'ACTIVE', checkCycle: 0, lastError: null } })
      .where(eq(schema.deployments.id, deployment.id));

    const { parameters } = await buildInstallParameters(db, deployment.id);

    expect(parameters[DOCUMENSO_PARAMETERS.publicUrl]).toBe(`https://${hostname}`);
  });

  it('never hands a non-ACTIVE default HTTPS hostname to the app (keeps the custom-domain behavior instead)', async () => {
    const application = await insertApplication(db, org.organizationId);
    await insertRelease(db, application.id);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id);
    await db
      .update(schema.deployments)
      .set({
        defaultHttps: {
          hostname: `d-${deployment.id}.deployz.dev`,
          status: 'CONFIGURING',
          checkCycle: 0,
          lastError: null,
        },
      })
      .where(eq(schema.deployments.id, deployment.id));
    await db.insert(schema.customDomains).values({
      deploymentId: deployment.id,
      organizationId: org.organizationId,
      hostname: 'pending.example.com',
      status: 'PENDING',
      createdBy: org.userId,
    });

    const { parameters } = await buildInstallParameters(db, deployment.id);

    // Default HTTPS is not ACTIVE yet, so it never becomes the public URL; the
    // pre-existing install-time custom-domain value is preserved.
    expect(parameters[DOCUMENSO_PARAMETERS.publicUrl]).toBe('https://pending.example.com');
  });

  // ── DEPLOY-001: a fresh install runs the application's own release ──────

  it('carries the newest READY release image as the image-reference parameter', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id);
    await insertRelease(db, application.id, {
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const newest = await insertRelease(db, application.id, {
      createdAt: new Date('2026-02-01T00:00:00Z'),
    });

    const { parameters, releaseId } = await buildInstallParameters(db, deployment.id);

    expect(parameters[IMAGE_REFERENCE_PARAMETER]).toBe(newest.imageDigest);
    // The selected release id feeds the deployment identity tags.
    expect(releaseId).toBe(newest.id);
  });

  it('skips an UNAVAILABLE or BUILDING release in favor of the newest usable READY one', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id);
    const usable = await insertRelease(db, application.id, {
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    await insertRelease(db, application.id, {
      createdAt: new Date('2026-02-01T00:00:00Z'),
      imageUnavailableAt: new Date('2026-02-02T00:00:00Z'),
    });
    await insertRelease(db, application.id, {
      createdAt: new Date('2026-03-01T00:00:00Z'),
      releaseStatus: 'BUILDING',
      imageDigest: null,
    });

    const { parameters } = await buildInstallParameters(db, deployment.id);

    expect(parameters[IMAGE_REFERENCE_PARAMETER]).toBe(usable.imageDigest);
  });

  it('refuses the install when the application has no usable release (never the template default image)', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id);
    await insertRelease(db, application.id, { releaseStatus: 'BUILDING', imageDigest: null });
    await insertRelease(db, application.id, { imageUnavailableAt: new Date('2026-02-02T00:00:00Z') });

    await expect(buildInstallParameters(db, deployment.id)).rejects.toMatchObject({
      statusCode: 409,
      code: 'RELEASE_NOT_PUBLISHED',
    });
  });

  // ── DEPLOY-009: configuration reaches the task before its first start ───

  it('creates the service with zero tasks when configuration must precede the first start and there is a release to run', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id);
    await insertRelease(db, application.id, {});

    const deferred = await buildInstallParameters(db, deployment.id, { startAfterConfig: true });
    expect(deferred.parameters[DESIRED_COUNT_PARAMETER]).toBe('0');

    const plain = await buildInstallParameters(db, deployment.id);
    expect(plain.parameters[DESIRED_COUNT_PARAMETER]).toBeUndefined();
  });
});

// ── Route wiring: relay register and retry-install both attach parameters ──

describe('INSTALL job payload.parameters wiring', () => {
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
    org = await signUpAndGetOrg(auth, db, 'install-parameters-routes@example.com');
    app = await buildServer({ auth, db });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('POST /api/relay/register creates the INSTALL job with payload.parameters', async () => {
    const application = await insertApplication(db, org.organizationId);
    await insertRelease(db, application.id);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'NOT_INSTALLED',
      installationId: null,
    });
    await db.insert(schema.customDomains).values({
      deploymentId: deployment.id,
      organizationId: org.organizationId,
      hostname: 'register.example.com',
      status: 'PENDING',
      createdBy: org.userId,
    });

    const response = await postJson(
      app,
      '/api/relay/register',
      { enrollmentCode: deployment.enrollmentCode, installationId: `inst-${crypto.randomUUID()}` },
      { authorization: 'Bearer relay-token-install-params' },
    );
    expect(response.statusCode).toBe(200);

    const [job] = await db
      .select()
      .from(schema.deploymentJobs)
      .where(and(eq(schema.deploymentJobs.deploymentId, deployment.id), eq(schema.deploymentJobs.type, 'INSTALL')));
    const parameters = (job!.payload as { parameters?: Record<string, string> }).parameters;
    expect(parameters?.[DOCUMENSO_PARAMETERS.publicUrl]).toBe('https://register.example.com');
    expect(parameters?.[DOCUMENSO_PARAMETERS.nextauthSecret]).toMatch(SECRET_SHAPE);
    expect(parameters?.[DOCUMENSO_PARAMETERS.encryptionKey]).toMatch(SECRET_SHAPE);
    expect(parameters?.[DOCUMENSO_PARAMETERS.encryptionSecondaryKey]).toMatch(SECRET_SHAPE);
  });

  it('POST /api/relay/register carries redisRequired: true when the stored manifest requires Redis', async () => {
    // Phase 2: redisRequired is derived from the deployment's frozen
    // manifest, never the live application column — set it there.
    const application = await insertApplication(db, org.organizationId, { redisRequired: true });
    await insertRelease(db, application.id);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'NOT_INSTALLED',
      installationId: null,
      desiredState: { manifest: { ...READY_MANIFEST, redis: { required: true, envBindings: [] } } },
    });

    const response = await postJson(
      app,
      '/api/relay/register',
      { enrollmentCode: deployment.enrollmentCode, installationId: `inst-${crypto.randomUUID()}` },
      { authorization: 'Bearer relay-token-install-params-redis' },
    );
    expect(response.statusCode).toBe(200);

    const [job] = await db
      .select()
      .from(schema.deploymentJobs)
      .where(and(eq(schema.deploymentJobs.deploymentId, deployment.id), eq(schema.deploymentJobs.type, 'INSTALL')));
    expect((job!.payload as { redisRequired?: boolean }).redisRequired).toBe(true);
  });

  it('POST /api/relay/register carries redisRequired: false when the application does not require Redis', async () => {
    const application = await insertApplication(db, org.organizationId, { redisRequired: false });
    await insertRelease(db, application.id);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'NOT_INSTALLED',
      installationId: null,
    });

    const response = await postJson(
      app,
      '/api/relay/register',
      { enrollmentCode: deployment.enrollmentCode, installationId: `inst-${crypto.randomUUID()}` },
      { authorization: 'Bearer relay-token-install-params-no-redis' },
    );
    expect(response.statusCode).toBe(200);

    const [job] = await db
      .select()
      .from(schema.deploymentJobs)
      .where(and(eq(schema.deploymentJobs.deploymentId, deployment.id), eq(schema.deploymentJobs.type, 'INSTALL')));
    expect((job!.payload as { redisRequired?: boolean }).redisRequired).toBe(false);
  });

  it('carries redisRequired from the stored manifest even when the live application column disagrees', async () => {
    // The application row says Redis is NOT required, but the deployment's
    // frozen manifest says it IS — the manifest must win (Phase 2).
    const application = await insertApplication(db, org.organizationId, { redisRequired: false });
    await insertRelease(db, application.id);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'NOT_INSTALLED',
      installationId: null,
      desiredState: { manifest: { ...READY_MANIFEST, redis: { required: true, envBindings: [] } } },
    });

    const response = await postJson(
      app,
      '/api/relay/register',
      { enrollmentCode: deployment.enrollmentCode, installationId: `inst-${crypto.randomUUID()}` },
      { authorization: 'Bearer relay-token-install-params-drift' },
    );
    expect(response.statusCode).toBe(200);

    const [job] = await db
      .select()
      .from(schema.deploymentJobs)
      .where(and(eq(schema.deploymentJobs.deploymentId, deployment.id), eq(schema.deploymentJobs.type, 'INSTALL')));
    const payload = job!.payload as { redisRequired?: boolean; manifest?: { redis?: { required?: boolean } } };
    expect(payload.redisRequired).toBe(true);
    expect(payload.manifest?.redis?.required).toBe(true);
  });

  it('POST /api/relay/register carries the canonical manifest from desired_state.manifest', async () => {
    const application = await insertApplication(db, org.organizationId);
    await insertRelease(db, application.id);
    const customer = await insertCustomer(db, org.organizationId);
    const manifest = {
      application: { root: '.', runtime: 'node', framework: 'express', dockerfilePath: 'Dockerfile' },
      build: { command: 'npm run build', context: '.' },
      web: { command: 'node server.js', port: 8080 },
      health: { path: '/api/health' },
      database: { postgres: true },
      redis: { required: true, envBindings: [{ name: 'REDIS_URL', kind: 'url' }] },
      storage: { required: true, envBindings: [{ name: 'AWS_S3_BUCKET', kind: 'bucket' }] },
      migration: { command: 'npm run migrate' },
      worker: { command: null },
      environment: { variables: [{ key: 'LOG_LEVEL', required: false, secret: false, source: [] }] },
      externalServices: [],
      unsupported: [],
    };
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'NOT_INSTALLED',
      installationId: null,
      desiredState: { manifest },
    });

    const response = await postJson(
      app,
      '/api/relay/register',
      { enrollmentCode: deployment.enrollmentCode, installationId: `inst-${crypto.randomUUID()}` },
      { authorization: 'Bearer relay-token-install-params-manifest' },
    );
    expect(response.statusCode).toBe(200);

    const [job] = await db
      .select()
      .from(schema.deploymentJobs)
      .where(and(eq(schema.deploymentJobs.deploymentId, deployment.id), eq(schema.deploymentJobs.type, 'INSTALL')));
    // A manifest stored before schemaVersion existed is the v1 shape: it rides
    // the payload with schemaVersion 1 and nothing else changed.
    expect((job!.payload as { manifest?: unknown }).manifest).toEqual({ schemaVersion: 1, ...manifest });
  });

  it('POST /api/deployments/:id/retry-install keeps recovery.neverInstalled AND adds parameters', async () => {
    const application = await insertApplication(db, org.organizationId);
    await insertRelease(db, application.id);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'FAILED',
      installationId: `inst-recovery-${crypto.randomUUID()}`,
    });
    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment.id,
      type: 'INSTALL',
      state: 'FAILED',
      idempotencyKey: `${deployment.id}:INSTALL`,
      payload: {},
      requestedBy: null,
    });

    const response = await postJson(app, `/api/deployments/${deployment.id}/retry-install`, {}, { cookie: org.cookie });
    expect(response.statusCode).toBe(202);
    const { jobId } = response.json() as { jobId: string };

    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, jobId));
    const payload = job!.payload as {
      recovery?: { neverInstalled?: boolean };
      parameters?: Record<string, string>;
      redisRequired?: boolean;
    };
    expect(payload.recovery).toEqual({ neverInstalled: true });
    expect(payload.parameters?.[DOCUMENSO_PARAMETERS.nextauthSecret]).toMatch(SECRET_SHAPE);
    expect(payload.parameters?.[DOCUMENSO_PARAMETERS.encryptionKey]).toMatch(SECRET_SHAPE);
    expect(payload.parameters?.[DOCUMENSO_PARAMETERS.encryptionSecondaryKey]).toMatch(SECRET_SHAPE);
    expect(payload.redisRequired).toBe(false);
  });

  it('POST /api/deployments/:id/retry-install carries redisRequired: true when the stored manifest requires Redis', async () => {
    const application = await insertApplication(db, org.organizationId, { redisRequired: true });
    await insertRelease(db, application.id);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'FAILED',
      installationId: `inst-recovery-redis-${crypto.randomUUID()}`,
      desiredState: { manifest: { ...READY_MANIFEST, redis: { required: true, envBindings: [] } } },
    });
    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment.id,
      type: 'INSTALL',
      state: 'FAILED',
      idempotencyKey: `${deployment.id}:INSTALL`,
      payload: {},
      requestedBy: null,
    });

    const response = await postJson(app, `/api/deployments/${deployment.id}/retry-install`, {}, { cookie: org.cookie });
    expect(response.statusCode).toBe(202);
    const { jobId } = response.json() as { jobId: string };

    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, jobId));
    expect((job!.payload as { redisRequired?: boolean }).redisRequired).toBe(true);
  });
});
