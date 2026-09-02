import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import { hashRelayToken } from './relay-store.js';
import { buildServer } from './server.js';

// Task 2.3 + §10.3: the digest the relay observes running in ECS reconciles
// the deployment's release pointer — but ONLY when exactly one READY release
// matches and THIS heartbeat passes every promotion gate (rollout COMPLETED,
// expected task count up, all targets healthy, HTTP probe succeeding). A
// partially-rolled-out or probe-failing release is never promoted.
describe('runtime digest reconciliation and the promotion gate', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let cookie: string;
  let organizationId: string;
  let applicationId: string;
  let customerId: string;

  const REPO = '151955775369.dkr.ecr.us-east-1.amazonaws.com/deployz-images';

  /** Every build produces its own digest — distinct versions never share one. */
  function digestFor(version: string): string {
    return `sha256:${hashRelayToken(version)}`;
  }

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
    observedState: Record<string, unknown> = {},
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/relay/health',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        installationId: deployment.installationId,
        observedState,
        healthStatus: 'HEALTHY',
        runningImageDigest,
      }),
    });
  }

  /** The §10.3 all-gates-pass heartbeat body: rollout done, counts full,
   *  targets healthy, HTTP probe succeeding. */
  function healthyObservedState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      deploymentRolloutState: 'COMPLETED',
      desiredCount: 2,
      runningCount: 2,
      unhealthyTargetCount: 0,
      pendingTargetCount: 0,
      unknownTargetCount: 0,
      httpProbe: {
        ok: true,
        statusCode: 200,
        latencyMs: 11,
        checkedAt: '2026-09-02T00:00:00.000Z',
      },
      ...overrides,
    };
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

  it('reconciles the pointer when exactly one READY release matches the runtime digest and every gate passes', async () => {
    const deployment = await seedDeployment();
    const token = (deployment as unknown as { __token: string }).__token;
    const v2Digest = digestFor('v2.0.0');
    const v3Digest = digestFor('v3.0.0');
    const v2 = await seedRelease('v2.0.0', v2Digest, 'READY');
    await db
      .update(schema.deployments)
      .set({ currentReleaseId: v2.id })
      .where(eq(schema.deployments.id, deployment.id));

    // Runtime drifted to v3's digest.
    const v3 = await seedRelease('v3.0.0', v3Digest, 'READY');
    const response = await heartbeat(deployment, token, v3Digest, healthyObservedState());
    expect(response.statusCode).toBe(200);

    const [row] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id))
      .limit(1);
    expect(row!.currentReleaseId).toBe(v3.id);
    expect(row!.previousReleaseId).toBe(v2.id);
    expect((row!.observedState as Record<string, unknown>)['runningImageDigest']).toBe(v3Digest);

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
      imageDigest: v3Digest,
    });
  });

  it('never promotes while the observed rollout is still IN_PROGRESS', async () => {
    const deployment = await seedDeployment();
    const token = (deployment as unknown as { __token: string }).__token;
    const v2Digest = digestFor('v2.4.0');
    const v3Digest = digestFor('v3.4.0');
    const v2 = await seedRelease('v2.4.0', v2Digest, 'READY');
    await db
      .update(schema.deployments)
      .set({ currentReleaseId: v2.id })
      .where(eq(schema.deployments.id, deployment.id));
    const v3 = await seedRelease('v3.4.0', v3Digest, 'READY');

    // The new digest runs, targets are healthy and the probe passes — but the
    // rollout has not completed, so a partially-rolled-out service must not
    // become current.
    const response = await heartbeat(
      deployment,
      token,
      v3Digest,
      healthyObservedState({ deploymentRolloutState: 'IN_PROGRESS' }),
    );
    expect(response.statusCode).toBe(200);

    const [row] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id))
      .limit(1);
    expect(row!.currentReleaseId).toBe(v2.id);
    expect(v3.id).not.toBe(v2.id);
  });

  it('never promotes while ALB targets are still pending', async () => {
    const deployment = await seedDeployment();
    const token = (deployment as unknown as { __token: string }).__token;
    const v2Digest = digestFor('v2.5.0');
    const v3Digest = digestFor('v3.5.0');
    const v2 = await seedRelease('v2.5.0', v2Digest, 'READY');
    await db
      .update(schema.deployments)
      .set({ currentReleaseId: v2.id })
      .where(eq(schema.deployments.id, deployment.id));
    const v3 = await seedRelease('v3.5.0', v3Digest, 'READY');

    const response = await heartbeat(
      deployment,
      token,
      v3Digest,
      healthyObservedState({ pendingTargetCount: 1 }),
    );
    expect(response.statusCode).toBe(200);

    const [row] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id))
      .limit(1);
    expect(row!.currentReleaseId).toBe(v2.id);
    expect(v3.id).not.toBe(v2.id);
  });

  it('never promotes while the HTTP probe is failing', async () => {
    const deployment = await seedDeployment();
    const token = (deployment as unknown as { __token: string }).__token;
    const v2Digest = digestFor('v2.6.0');
    const v3Digest = digestFor('v3.6.0');
    const v2 = await seedRelease('v2.6.0', v2Digest, 'READY');
    await db
      .update(schema.deployments)
      .set({ currentReleaseId: v2.id })
      .where(eq(schema.deployments.id, deployment.id));
    const v3 = await seedRelease('v3.6.0', v3Digest, 'READY');

    const response = await heartbeat(
      deployment,
      token,
      v3Digest,
      healthyObservedState({
        httpProbe: {
          ok: false,
          statusCode: 503,
          latencyMs: 7,
          checkedAt: '2026-09-02T00:00:00.000Z',
        },
      }),
    );
    expect(response.statusCode).toBe(200);

    const [row] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id))
      .limit(1);
    expect(row!.currentReleaseId).toBe(v2.id);

    // Once the app answers again, the same heartbeat promotes it.
    const recovered = await heartbeat(
      deployment,
      token,
      v3Digest,
      healthyObservedState({
        httpProbe: {
          ok: true,
          statusCode: 200,
          latencyMs: 8,
          checkedAt: '2026-09-02T00:00:01.000Z',
        },
      }),
    );
    expect(recovered.statusCode).toBe(200);
    const [after] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id))
      .limit(1);
    expect(after!.currentReleaseId).toBe(v3.id);
  });

  it('keeps the pointer and preserves the raw digest when no release matches', async () => {
    const deployment = await seedDeployment();
    const token = (deployment as unknown as { __token: string }).__token;
    const v2Digest = digestFor('v2.1.0');
    const v2 = await seedRelease('v2.1.0', v2Digest, 'READY');
    await db
      .update(schema.deployments)
      .set({ currentReleaseId: v2.id })
      .where(eq(schema.deployments.id, deployment.id));

    const unknownDigest = digestFor('v2.1.0-unknown');
    const response = await heartbeat(deployment, token, unknownDigest, healthyObservedState());
    expect(response.statusCode).toBe(200);

    const [row] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id))
      .limit(1);
    expect(row!.currentReleaseId).toBe(v2.id);
    expect((row!.observedState as Record<string, unknown>)['runningImageDigest']).toBe(unknownDigest);
  });

  it('does not reconcile while a mutating job is active', async () => {
    const deployment = await seedDeployment();
    const token = (deployment as unknown as { __token: string }).__token;
    const v2Digest = digestFor('v2.2.0');
    const v3Digest = digestFor('v3.2.0');
    const v2 = await seedRelease('v2.2.0', v2Digest, 'READY');
    await db
      .update(schema.deployments)
      .set({ currentReleaseId: v2.id })
      .where(eq(schema.deployments.id, deployment.id));
    const v3 = await seedRelease('v3.2.0', v3Digest, 'READY');

    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment.id,
      type: 'DEPLOY_RELEASE',
      state: 'RUNNING',
      idempotencyKey: `${deployment.id}:DEPLOY_RELEASE`,
      payload: {},
    });

    const response = await heartbeat(deployment, token, v3Digest, healthyObservedState());
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
    const v2Digest = digestFor('v2.3.0');
    const v2 = await seedRelease('v2.3.0', v2Digest, 'READY');
    await db
      .update(schema.deployments)
      .set({ currentReleaseId: v2.id })
      .where(eq(schema.deployments.id, deployment.id));

    const response = await heartbeat(deployment, token, v2Digest, healthyObservedState());
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
    const v3Digest = digestFor('v3.9.0');
    await seedRelease('v3.9.0', v3Digest, 'READY');
    await heartbeat(
      deployment,
      (deployment as unknown as { __token: string }).__token,
      v3Digest,
      healthyObservedState(),
    );
    const response = await app.inject({
      method: 'GET',
      url: '/api/deployments',
      headers: { cookie },
    });
    const rows = (response.json() as { deployments: Record<string, unknown>[] }).deployments;
    const row = rows.find((r) => r['id'] === deployment.id);
    expect(row?.['runningImageDigest']).toBe(v3Digest);
  });

  it('maintains last-success/last-failed probe timestamps across heartbeats and stores no response body', async () => {
    const deployment = await seedDeployment();
    const token = (deployment as unknown as { __token: string }).__token;

    // First check succeeds at T1.
    await heartbeat(
      deployment,
      token,
      null,
      healthyObservedState({
        httpProbe: { ok: true, statusCode: 200, latencyMs: 5, checkedAt: '2026-09-02T00:00:01.000Z' },
      }),
    );
    let [row] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id))
      .limit(1);
    let stored = (row!.observedState as { httpProbe: Record<string, unknown> }).httpProbe;
    expect(stored['lastSuccessAt']).toBe('2026-09-02T00:00:01.000Z');
    expect(stored['lastFailedAt']).toBeNull();

    // A later failed check at T2 keeps the last success and records the failure.
    await heartbeat(
      deployment,
      token,
      null,
      healthyObservedState({
        httpProbe: { ok: false, statusCode: 503, latencyMs: 9, checkedAt: '2026-09-02T00:00:02.000Z' },
      }),
    );
    [row] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id))
      .limit(1);
    stored = (row!.observedState as { httpProbe: Record<string, unknown> }).httpProbe;
    expect(stored['ok']).toBe(false);
    expect(stored['statusCode']).toBe(503);
    expect(stored['lastSuccessAt']).toBe('2026-09-02T00:00:01.000Z');
    expect(stored['lastFailedAt']).toBe('2026-09-02T00:00:02.000Z');
    // The stored record is exactly the measured fields — a response body is
    // never part of the contract, so no key could ever carry one.
    expect(Object.keys(stored).sort()).toEqual([
      'checkedAt',
      'lastFailedAt',
      'lastSuccessAt',
      'latencyMs',
      'ok',
      'statusCode',
    ]);
  });
});
