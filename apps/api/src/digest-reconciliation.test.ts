import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import { hashRelayToken } from './relay-store.js';
import { buildServer } from './server.js';

// Task 2.3: the digest the relay observes running in ECS reconciles the
// deployment's release pointer — but only when exactly one READY release
// matches, and never while a mutating job is in flight.
describe('runtime digest reconciliation', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let cookie: string;
  let organizationId: string;
  let applicationId: string;
  let customerId: string;

  const DIGEST_V2 = 'sha256:' + '2'.repeat(64);
  const DIGEST_V3 = 'sha256:' + '3'.repeat(64);
  const REPO = '151955775369.dkr.ecr.us-east-1.amazonaws.com/deployz-images';

  async function seedDeployment(): Promise<typeof schema.deployments.$inferSelect> {
    const token = 'tok-' + crypto.randomUUID();
    const [row] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        state: 'HEALTHY',
        installationId: 'inst-' + crypto.randomUUID(),
        enrollmentCode: crypto.randomUUID(),
        enrollmentUsedAt: new Date(),
        relayTokenHash: hashRelayToken(token),
      })
      .returning();
    (row as { __token?: string }).__token = token;
    return row!;
  }

  async function seedRelease(
    version: string,
    digest: string | null,
    releaseStatus: 'BUILDING' | 'READY' | 'FAILED',
  ): Promise<typeof schema.releases.$inferSelect> {
    const [row] = await db
      .insert(schema.releases)
      .values({
        applicationId,
        version,
        gitSha: 'abc123',
        imageDigest: digest ? `${REPO}@${digest}` : null,
        buildStatus: releaseStatus === 'READY' ? 'SUCCEEDED' : 'BUILDING',
        releaseStatus,
      })
      .returning();
    return row!;
  }

  function heartbeat(
    deployment: { installationId: string },
    token: string,
    runningImageDigest: string | null,
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/relay/health',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        installationId: deployment.installationId,
        observedState: {},
        runningImageDigest,
      }),
    });
  }

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);

    const email = 'reconcile@example.com';
    const password = 'super-secret-1';
    await auth.api.signUpEmail({ body: { email, password, name: 'Rec' } });
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
        repoFullName: `acme/rec-${crypto.randomUUID().slice(0, 8)}`,
        repoUrl: 'https://github.com/acme/rec',
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

  it('reconciles the pointer when exactly one READY release matches the runtime digest', async () => {
    const deployment = await seedDeployment();
    const token = (deployment as unknown as { __token: string }).__token;
    const v2 = await seedRelease('v2.0.0', DIGEST_V2, 'READY');
    await db
      .update(schema.deployments)
      .set({ currentReleaseId: v2.id })
      .where(eq(schema.deployments.id, deployment.id));

    // Runtime drifted to v3's digest.
    const v3 = await seedRelease('v3.0.0', DIGEST_V3, 'READY');
    const response = await heartbeat(deployment, token, DIGEST_V3);
    expect(response.statusCode).toBe(200);

    const [row] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id))
      .limit(1);
    expect(row!.currentReleaseId).toBe(v3.id);
    expect(row!.previousReleaseId).toBe(v2.id);
    expect((row!.observedState as Record<string, unknown>)['runningImageDigest']).toBe(DIGEST_V3);

    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(
        and(
          eq(schema.eventLogs.deploymentId, deployment.id),
          eq(schema.eventLogs.eventType, 'deployment.reconciled'),
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      source: 'runtime-observation',
      previousReleaseId: v2.id,
      reconciledReleaseId: v3.id,
      imageDigest: DIGEST_V3,
    });
  });

  it('keeps the pointer and preserves the raw digest when no release matches', async () => {
    const deployment = await seedDeployment();
    const token = (deployment as unknown as { __token: string }).__token;
    const v2 = await seedRelease('v2.1.0', DIGEST_V2, 'READY');
    await db
      .update(schema.deployments)
      .set({ currentReleaseId: v2.id })
      .where(eq(schema.deployments.id, deployment.id));

    const response = await heartbeat(deployment, token, 'sha256:' + 'f'.repeat(64));
    expect(response.statusCode).toBe(200);

    const [row] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id))
      .limit(1);
    expect(row!.currentReleaseId).toBe(v2.id);
    expect((row!.observedState as Record<string, unknown>)['runningImageDigest']).toBe(
      'sha256:' + 'f'.repeat(64),
    );
  });

  it('does not reconcile while a mutating job is active', async () => {
    const deployment = await seedDeployment();
    const token = (deployment as unknown as { __token: string }).__token;
    const v2 = await seedRelease('v2.2.0', DIGEST_V2, 'READY');
    await db
      .update(schema.deployments)
      .set({ currentReleaseId: v2.id })
      .where(eq(schema.deployments.id, deployment.id));
    const v3 = await seedRelease('v3.1.0', DIGEST_V3, 'READY');

    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment.id,
      type: 'DEPLOY_RELEASE',
      state: 'RUNNING',
      idempotencyKey: `${deployment.id}:DEPLOY_RELEASE`,
      payload: {},
    });

    const response = await heartbeat(deployment, token, DIGEST_V3);
    expect(response.statusCode).toBe(200);

    const [row] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id))
      .limit(1);
    expect(row!.currentReleaseId).toBe(v2.id);
    expect(v3.id).not.toBe(v2.id);
  });

  it('is a no-op when the current release already matches', async () => {
    const deployment = await seedDeployment();
    const token = (deployment as unknown as { __token: string }).__token;
    const v2 = await seedRelease('v2.3.0', DIGEST_V2, 'READY');
    await db
      .update(schema.deployments)
      .set({ currentReleaseId: v2.id })
      .where(eq(schema.deployments.id, deployment.id));

    const response = await heartbeat(deployment, token, DIGEST_V2);
    expect(response.statusCode).toBe(200);

    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(
        and(
          eq(schema.eventLogs.deploymentId, deployment.id),
          eq(schema.eventLogs.eventType, 'deployment.reconciled'),
        ),
      );
    expect(events).toHaveLength(0);
  });

  it('exposes the observed digest on the fleet row', async () => {
    const deployment = await seedDeployment();
    await heartbeat(
      deployment,
      (deployment as unknown as { __token: string }).__token,
      DIGEST_V3,
    );
    const response = await app.inject({
      method: 'GET',
      url: '/api/deployments',
      headers: { cookie },
    });
    const rows = (response.json() as { deployments: Record<string, unknown>[] }).deployments;
    const row = rows.find((r) => r['id'] === deployment.id);
    expect(row?.['runningImageDigest']).toBe(DIGEST_V3);
  });
});
