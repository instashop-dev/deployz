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

  async function seedDeployment(): Promise<{
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
      })
      .returning();
    return { id: row!.id, installationId, token };
  }

  async function seedRelease(
    version: string,
    options: {
      releaseStatus?: 'BUILDING' | 'READY' | 'FAILED';
      imageDigest?: string | null;
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
