import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import { hashRelayToken } from './relay-store.js';
import { buildServer } from './server.js';

// Phase 4 contract: the deploy payload is derived server-side from a READY
// release, one mutating operation may run per deployment, and RESTART exists
// as a first-class command that never touches the release pointers.
describe('deploy contract, busy gate and restart', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let cookie: string;
  let organizationId: string;
  let applicationId: string;
  let customerId: string;

  const REPO = '151955775369.dkr.ecr.us-east-1.amazonaws.com/deployz-images';
  const DIGEST = 'sha256:' + 'a'.repeat(64);

  async function seedDeployment(
    overrides: Partial<typeof schema.deployments.$inferInsert> = {},
  ): Promise<{
    id: string;
    installationId: string;
    token: string;
  }> {
    const token = 'tok-' + crypto.randomUUID();
    const installationId = 'inst-' + crypto.randomUUID();
    const [row] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        state: 'HEALTHY',
        installationId,
        enrollmentCode: crypto.randomUUID(),
        enrollmentUsedAt: new Date(),
        relayTokenHash: hashRelayToken(token),
        relayStatus: 'CONNECTED',
        ...overrides,
      })
      .returning();
    return { id: row!.id, installationId, token };
  }

  /** Inserts a bare INSTALL job in the given state, for tests that need a
   *  deployment's install history without going through the real flow. */
  async function seedInstallJob(
    deploymentId: string,
    state: 'SUCCEEDED' | 'FAILED',
  ): Promise<void> {
    await db.insert(schema.deploymentJobs).values({
      deploymentId,
      type: 'INSTALL',
      state,
      idempotencyKey: `${deploymentId}:INSTALL:${crypto.randomUUID()}`,
      finishedAt: new Date(),
    });
  }

  async function seedRelease(
    version: string,
    options: {
      releaseStatus?: 'BUILDING' | 'READY' | 'FAILED';
      imageDigest?: string | null;
      migrationCommand?: string | null;
    } = {},
  ): Promise<string> {
    const [row] = await db
      .insert(schema.releases)
      .values({
        applicationId,
        version,
        gitSha: 'abc123',
        imageDigest:
          'imageDigest' in options ? options.imageDigest! : `${REPO}@${DIGEST}`,
        buildStatus: options.releaseStatus === 'READY' ? 'SUCCEEDED' : 'BUILDING',
        releaseStatus: options.releaseStatus ?? 'READY',
        ...('migrationCommand' in options ? { migrationCommand: options.migrationCommand } : {}),
      })
      .returning();
    return row!.id;
  }

  function post(path: string, body: unknown) {
    return app.inject({
      method: 'POST',
      url: path,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
  }

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);

    const email = 'deploy-contract@example.com';
    const password = 'super-secret-1';
    await auth.api.signUpEmail({ body: { email, password, name: 'Contract' } });
    const signin = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    const setCookie = signin.headers.get('set-cookie');
    if (!setCookie) throw new Error('no session cookie');
    cookie = setCookie;

    app = await buildServer({ auth, db });

    const memberships = await db
      .select({ organizationId: schema.member.organizationId })
      .from(schema.member)
      .limit(1);
    organizationId = memberships[0]!.organizationId;

    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'App',
        repoFullName: `acme/dc-${crypto.randomUUID().slice(0, 8)}`,
        repoUrl: 'https://github.com/acme/dc',
        defaultBranch: 'main',
      })
      .returning();
    applicationId = application!.id;

    const [customer] = await db
      .insert(schema.customers)
      .values({
        organizationId,
        name: 'Cust',
        email: `cust-${crypto.randomUUID()}@example.com`,
      })
      .returning();
    customerId = customer!.id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('derives the payload server-side from a READY release', async () => {
    const deployment = await seedDeployment();
    const releaseId = await seedRelease('v1.0.0');

    const response = await post(`/api/deployments/${deployment.id}/deploy`, { releaseId });
    expect(response.statusCode, response.body).toBe(202);

    const [job] = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    expect(job?.type).toBe('DEPLOY_RELEASE');
    expect(job?.payload).toEqual({
      releaseId,
      version: 'v1.0.0',
      imageRepository: REPO,
      imageDigest: DIGEST,
    });
  });

  it('threads the migration command into the DEPLOY_RELEASE payload (release override)', async () => {
    const deployment = await seedDeployment();
    const releaseId = await seedRelease('v1.1.0', { migrationCommand: 'node migrate.js up' });

    const response = await post(`/api/deployments/${deployment.id}/deploy`, { releaseId });
    expect(response.statusCode, response.body).toBe(202);

    const [job] = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    expect(job?.payload).toMatchObject({ migrationCommand: 'node migrate.js up' });
  });

  it('prefers the stored manifest migration.command over the release row', async () => {
    const deployment = await seedDeployment({
      desiredState: {
        manifest: {
          application: { root: '.', runtime: 'node', framework: null, dockerfilePath: null },
          build: { command: null, context: '.' },
          web: { command: null, port: 3000 },
          health: { path: '/health' },
          database: { postgres: true },
          redis: { required: false, envBindings: [] },
          storage: { required: false, envBindings: [] },
          migration: { command: 'npm run db:migrate' },
          worker: { command: null },
          environment: { variables: [] },
          externalServices: [],
          unsupported: [],
        },
      },
    });
    const releaseId = await seedRelease('v1.2.0', { migrationCommand: 'npm run release:migrate' });

    const response = await post(`/api/deployments/${deployment.id}/deploy`, { releaseId });
    expect(response.statusCode, response.body).toBe(202);

    const [job] = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    expect(job?.payload).toMatchObject({ migrationCommand: 'npm run db:migrate' });
  });

  it.each(['BUILDING', 'FAILED'] as const)(
    'refuses a deploy of a %s release with 409 RELEASE_NOT_READY',
    async (releaseStatus) => {
      const deployment = await seedDeployment();
      const releaseId = await seedRelease(`v1.4.${releaseStatus === 'BUILDING' ? 0 : 1}`, {
        releaseStatus,
        imageDigest: null,
      });

      const response = await post(`/api/deployments/${deployment.id}/deploy`, { releaseId });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'RELEASE_NOT_READY' } });
    },
  );

  it('refuses a READY release without a digest with 409 RELEASE_NOT_READY', async () => {
    const deployment = await seedDeployment();
    const releaseId = await seedRelease('v1.5.0', { imageDigest: null });

    const response = await post(`/api/deployments/${deployment.id}/deploy`, { releaseId });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'RELEASE_NOT_READY' } });
  });

  it('refuses every mutating command while one is active (DEPLOYMENT_BUSY)', async () => {
    const deployment = await seedDeployment();
    const releaseId = await seedRelease('v2.0.0');
    await post(`/api/deployments/${deployment.id}/deploy`, { releaseId });

    const other = await seedRelease('v2.1.0');
    for (const [path, body] of [
      [`/api/deployments/${deployment.id}/deploy`, { releaseId: other }],
      [`/api/deployments/${deployment.id}/rollback`, { releaseId: other }],
      [`/api/deployments/${deployment.id}/restart`, {}],
      [`/api/deployments/${deployment.id}/destroy`, { finalSnapshot: false }],
    ] as const) {
      const response = await post(path, body);
      expect(response.statusCode, `${path} ${response.body}`).toBe(409);
      expect(response.json()).toMatchObject({
        error: {
          code: 'DEPLOYMENT_BUSY',
          message: 'Another deployment operation is already in progress.',
        },
      });
    }
  });

  it('creates a RESTART job without touching the release pointers', async () => {
    const deployment = await seedDeployment();
    const current = await seedRelease('v3.0.0');
    await db
      .update(schema.deployments)
      .set({ currentReleaseId: current })
      .where(eq(schema.deployments.id, deployment.id));

    const response = await post(`/api/deployments/${deployment.id}/restart`, {});
    expect(response.statusCode, response.body).toBe(202);

    const [job] = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    expect(job?.type).toBe('RESTART');
    expect(job?.payload).toEqual({});

    const [row] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id));
    expect(row?.currentReleaseId).toBe(current);
    expect(row?.state).toBe('UPDATING');
  });

  it('rejects restart and deploy on a never-installed FAILED deployment with 409 DEPLOYMENT_NOT_DEPLOYABLE', async () => {
    const deployment = await seedDeployment({ state: 'FAILED' });
    const releaseId = await seedRelease('v5.0.0');

    for (const response of [
      await post(`/api/deployments/${deployment.id}/restart`, {}),
      await post(`/api/deployments/${deployment.id}/deploy`, { releaseId }),
    ]) {
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'DEPLOYMENT_NOT_DEPLOYABLE' } });
    }

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    expect(jobs).toHaveLength(0);
  });

  it('allows restart and deploy on a FAILED deployment that has a prior successful install', async () => {
    // Two separate deployments — restart's own job would otherwise leave the
    // deployment busy (DEPLOYMENT_BUSY) for the deploy call right after it.
    const restartTarget = await seedDeployment({ state: 'FAILED' });
    await seedInstallJob(restartTarget.id, 'SUCCEEDED');
    const restart = await post(`/api/deployments/${restartTarget.id}/restart`, {});
    expect(restart.statusCode, restart.body).toBe(202);

    const deployTarget = await seedDeployment({ state: 'FAILED' });
    await seedInstallJob(deployTarget.id, 'SUCCEEDED');
    const releaseId = await seedRelease('v5.1.0');
    const deploy = await post(`/api/deployments/${deployTarget.id}/deploy`, { releaseId });
    expect(deploy.statusCode, deploy.body).toBe(202);
  });

  it('a failed DESTROY is retryable: Disconnect after a FAILED destroy queues a fresh job', async () => {
    const deployment = await seedDeployment();

    const first = await post(`/api/deployments/${deployment.id}/destroy`, {});
    expect(first.statusCode, first.body).toBe(202);
    const { jobId: firstJobId } = first.json() as { jobId: string };

    const result = await app.inject({
      method: 'POST',
      url: `/api/relay/commands/${firstJobId}/result`,
      headers: { authorization: `Bearer ${deployment.token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ success: false, error: 'stack deletion failed' }),
    });
    expect(result.statusCode, result.body).toBe(200);

    const [deploymentRow] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id));
    expect(deploymentRow?.state).toBe('FAILED');

    const second = await post(`/api/deployments/${deployment.id}/destroy`, {});
    expect(second.statusCode, second.body).toBe(202);
    const { jobId: secondJobId } = second.json() as { jobId: string };
    expect(secondJobId).not.toBe(firstJobId);

    const destroyJobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    expect(destroyJobs.filter((j) => j.type === 'DESTROY')).toHaveLength(2);
  });

  it('a failed DEPLOY_RELEASE of the same release is retryable with a fresh job', async () => {
    // Observed live: the fixed derived key handed the FAILED job back on the
    // retry, so "Confirm Deploy" silently did nothing.
    const deployment = await seedDeployment();
    await seedInstallJob(deployment.id, 'SUCCEEDED');
    const releaseId = await seedRelease('v6.0.0');

    const first = await post(`/api/deployments/${deployment.id}/deploy`, { releaseId });
    expect(first.statusCode, first.body).toBe(202);
    const { jobId: firstJobId } = first.json() as { jobId: string };

    const result = await app.inject({
      method: 'POST',
      url: `/api/relay/commands/${firstJobId}/result`,
      headers: { authorization: `Bearer ${deployment.token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ success: false, error: 'AccessDenied on ecs:TagResource' }),
    });
    expect(result.statusCode, result.body).toBe(200);

    const second = await post(`/api/deployments/${deployment.id}/deploy`, { releaseId });
    expect(second.statusCode, second.body).toBe(202);
    const { jobId: secondJobId } = second.json() as { jobId: string };
    expect(secondJobId).not.toBe(firstJobId);
  });

  it('advances pointers v1 → v2 → v3 → rollback → v2 through job results', async () => {
    const deployment = await seedDeployment();
    const v1 = await seedRelease('v4.0.0');
    const v2 = await seedRelease('v4.1.0');
    const v3 = await seedRelease('v4.2.0');

    const reportSuccess = async (releaseId: string, type: string): Promise<void> => {
      const jobs = await db
        .select()
        .from(schema.deploymentJobs)
        .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
      const target = jobs
        .reverse()
        .find(
          (j) => j.type === type && (j.payload as { releaseId?: string }).releaseId === releaseId,
        );
      if (!target) throw new Error(`no ${type} job for ${releaseId}`);
      const response = await app.inject({
        method: 'POST',
        url: `/api/relay/commands/${target.id}/result`,
        headers: {
          authorization: `Bearer ${deployment.token}`,
          'content-type': 'application/json',
        },
        payload: JSON.stringify({ success: true }),
      });
      expect(response.statusCode, response.body).toBe(200);
    };

    const pointers = async () => {
      const [row] = await db
        .select()
        .from(schema.deployments)
        .where(eq(schema.deployments.id, deployment.id));
      return { current: row?.currentReleaseId ?? null, previous: row?.previousReleaseId ?? null };
    };

    await db.update(schema.deployments).set({ currentReleaseId: v1 }).where(eq(schema.deployments.id, deployment.id));
    await post(`/api/deployments/${deployment.id}/deploy`, { releaseId: v2 });
    await reportSuccess(v2, 'DEPLOY_RELEASE');
    expect(await pointers()).toEqual({ current: v2, previous: v1 });

    await post(`/api/deployments/${deployment.id}/deploy`, { releaseId: v3 });
    await reportSuccess(v3, 'DEPLOY_RELEASE');
    expect(await pointers()).toEqual({ current: v3, previous: v2 });

    await post(`/api/deployments/${deployment.id}/rollback`, { releaseId: v2 });
    await reportSuccess(v2, 'ROLLBACK');
    expect(await pointers()).toEqual({ current: v2, previous: v3 });
  });
});
