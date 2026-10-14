import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import {
  workloadServicesFromSpec,
  type DeploymentManifest,
  type DeploymentSpecV2,
  type ReleaseEvidence,
  type ServiceEvidence,
} from '@deployz/contracts';

import { createAuth, type Auth } from './auth.js';
import { compileDeploymentIntent } from './compiler-artifact.js';
import { hashRelayToken } from './relay-store.js';
import { buildServer } from './server.js';

// Task 2.3 + §10.3: the digest the relay observes running in ECS reconciles
// the deployment's release pointer — but ONLY when exactly one READY release
// matches and THIS heartbeat's release evidence proves every workload the
// frozen spec requires runs that one digest at full capacity, behind healthy
// targets, with a successful public probe. Anything less, stale, out of order
// or absent never promotes, and stored evidence is never reused.
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

  const BASE_MANIFEST: DeploymentManifest = {
    schemaVersion: 1,
    application: { root: '.', runtime: 'node', framework: null, dockerfilePath: null },
    build: { command: null, context: '.' },
    web: { command: 'npm start', port: 3000 },
    health: { path: '/health' },
    database: { postgres: false },
    redis: { required: false, envBindings: [] },
    storage: { required: false, envBindings: [] },
    migration: { command: null },
    worker: { command: null },
    environment: { variables: [] },
    externalServices: [],
    unsupported: [],
  };
  const webSpec: DeploymentSpecV2 = compileDeploymentIntent({ manifest: BASE_MANIFEST, region: 'us-east-1' }).spec;
  const workerSpec: DeploymentSpecV2 = compileDeploymentIntent({
    manifest: { ...BASE_MANIFEST, worker: { command: 'node worker.js' } },
    region: 'us-east-1',
  }).spec;

  /** Every build produces its own digest — distinct versions never share one. */
  function digestFor(version: string): string {
    return `sha256:${hashRelayToken(version)}`;
  }

  async function seedDeployment(
    spec: DeploymentSpecV2 = webSpec,
  ): Promise<typeof schema.deployments.$inferSelect> {
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
        specV2: spec as unknown as Record<string, unknown>,
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

  function isoAgo(ms: number): string {
    return new Date(Date.now() - ms).toISOString();
  }

  /** One workload's healthy evidence: full capacity, rollout done, one digest. */
  function serviceEvidence(
    workload: { id: string; serviceLogicalId: string },
    digest: string,
    overrides: Partial<ServiceEvidence> = {},
  ): ServiceEvidence {
    return {
      workloadId: workload.id,
      serviceLogicalId: workload.serviceLogicalId,
      observed: true,
      desiredCount: 2,
      runningCount: 2,
      rolloutState: 'COMPLETED',
      runningDigests: [digest],
      targets: workload.id === 'web' ? { healthy: 2, unhealthy: 0, pending: 0, unknown: 0 } : null,
      ...overrides,
    };
  }

  /** The complete healthy release evidence for a spec's workloads, observed just now. */
  function healthyEvidence(digest: string, spec: DeploymentSpecV2 = webSpec): ReleaseEvidence {
    return {
      version: 1,
      observedAt: isoAgo(1_000),
      services: workloadServicesFromSpec(spec)!.map((workload) => serviceEvidence(workload, digest)),
      httpProbe: { ok: true, status: 200, checkedAt: isoAgo(1_000) },
    };
  }

  /** A heartbeat body carrying the evidence, edited by `patch` for the failing cases. */
  function healthyObservedState(
    digest: string,
    patch: (evidence: ReleaseEvidence) => void = () => {},
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const evidence = healthyEvidence(digest);
    patch(evidence);
    return { releaseEvidence: evidence, ...extra };
  }

  async function reload(id: string): Promise<typeof schema.deployments.$inferSelect> {
    const [row] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, id)).limit(1);
    return row!;
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
    const response = await heartbeat(deployment, token, v3Digest, healthyObservedState(v3Digest));
    expect(response.statusCode).toBe(200);

    const [row] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id))
      .limit(1);
    expect(row!.currentReleaseId).toBe(v3.id);
    expect(row!.previousReleaseId).toBe(v2.id);
    expect(row!.currentReleaseConfirmedAt).not.toBeNull();
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
      kind: 'drift',
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
      healthyObservedState(v3Digest, (evidence) => {
        evidence.services[0]!.rolloutState = 'IN_PROGRESS';
      }),
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
      healthyObservedState(v3Digest, (evidence) => {
        evidence.services[0]!.targets = { healthy: 1, unhealthy: 0, pending: 1, unknown: 0 };
      }),
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
      healthyObservedState(v3Digest, (evidence) => {
        evidence.httpProbe = { ok: false, status: 503, checkedAt: isoAgo(1_000) };
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
      healthyObservedState(v3Digest),
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
    const response = await heartbeat(deployment, token, unknownDigest, healthyObservedState(unknownDigest));
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

    const response = await heartbeat(deployment, token, v3Digest, healthyObservedState(v3Digest));
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

    const response = await heartbeat(deployment, token, v2Digest, healthyObservedState(v2Digest));
    expect(response.statusCode).toBe(200);
    // Same digest: the current release is re-confirmed, not re-promoted.
    expect((await reload(deployment.id)).currentReleaseConfirmedAt).not.toBeNull();

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
      healthyObservedState(v3Digest),
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
      {
        httpProbe: { ok: true, statusCode: 200, latencyMs: 5, checkedAt: '2026-09-02T00:00:01.000Z' },
      },
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
      {
        httpProbe: { ok: false, statusCode: 503, latencyMs: 9, checkedAt: '2026-09-02T00:00:02.000Z' },
      },
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

  /** A deployment on v2 with v3 built, so any promotion shows as a pointer change. */
  async function seedDrifted(
    tag: string,
    spec: DeploymentSpecV2 = webSpec,
  ): Promise<{ deployment: typeof schema.deployments.$inferSelect; token: string; v2: { id: string }; v3: { id: string }; v3Digest: string }> {
    const deployment = await seedDeployment(spec);
    const v2 = await seedRelease(`v2.${tag}`, digestFor(`v2.${tag}`), 'READY');
    const v3 = await seedRelease(`v3.${tag}`, digestFor(`v3.${tag}`), 'READY');
    await db
      .update(schema.deployments)
      .set({ currentReleaseId: v2.id })
      .where(eq(schema.deployments.id, deployment.id));
    return {
      deployment,
      token: (deployment as unknown as { __token: string }).__token,
      v2,
      v3,
      v3Digest: digestFor(`v3.${tag}`),
    };
  }

  describe('incomplete evidence never promotes', () => {
    const cases: Array<[string, (evidence: ReleaseEvidence) => void]> = [
      ['no services observed', (evidence) => (evidence.services = [])],
      ['the web service unobserved', (evidence) => (evidence.services[0] = { ...evidence.services[0]!, observed: false })],
      ['zero running tasks', (evidence) => (evidence.services[0]!.runningCount = 0)],
      ['zero desired tasks', (evidence) => {
        evidence.services[0]!.desiredCount = 0;
        evidence.services[0]!.runningCount = 0;
      }],
      ['no probe', (evidence) => (evidence.httpProbe = null)],
      ['a failed probe', (evidence) => (evidence.httpProbe = { ok: false, status: 502, checkedAt: isoAgo(1_000) })],
      ['an unread rollout', (evidence) => (evidence.services[0]!.rolloutState = null)],
      ['unread targets', (evidence) => (evidence.services[0]!.targets = null)],
      ['mixed digests', (evidence) => (evidence.services[0]!.runningDigests = [digestFor('other'), digestFor('mixed')])],
      ['stale evidence', (evidence) => {
        evidence.observedAt = isoAgo(20 * 60 * 1000);
        evidence.httpProbe = { ok: true, status: 200, checkedAt: isoAgo(20 * 60 * 1000) };
      }],
    ];
    it.each(cases)('%s', async (name, patch) => {
      const { deployment, token, v2, v3Digest } = await seedDrifted(`inc-${name.replace(/\W+/g, '')}`);
      const response = await heartbeat(deployment, token, v3Digest, healthyObservedState(v3Digest, patch));
      expect(response.statusCode).toBe(200);
      const row = await reload(deployment.id);
      expect(row.currentReleaseId).toBe(v2.id);
      expect(row.currentReleaseConfirmedAt).toBeNull();
    });
  });

  it('never promotes on an empty observation', async () => {
    const { deployment, token, v2, v3Digest } = await seedDrifted('empty');
    const response = await heartbeat(deployment, token, v3Digest, {});
    expect(response.statusCode).toBe(200);
    expect((await reload(deployment.id)).currentReleaseId).toBe(v2.id);
  });

  it('never promotes while a required worker is missing from the evidence', async () => {
    const { deployment, token, v2, v3Digest } = await seedDrifted('worker', workerSpec);
    const response = await heartbeat(
      deployment,
      token,
      v3Digest,
      healthyObservedState(v3Digest, (evidence) => {
        evidence.services = evidence.services.filter((service) => service.workloadId === 'web');
      }),
    );
    expect(response.statusCode).toBe(200);
    expect((await reload(deployment.id)).currentReleaseId).toBe(v2.id);

    const complete = await heartbeat(
      deployment,
      token,
      v3Digest,
      { releaseEvidence: healthyEvidence(v3Digest, workerSpec) },
    );
    expect(complete.statusCode).toBe(200);
    expect((await reload(deployment.id)).currentReleaseId).not.toBe(v2.id);
  });

  it('never promotes from a legacy heartbeat without release evidence, and flags the connector', async () => {
    const { deployment, token, v2, v3Digest } = await seedDrifted('legacy');
    const response = await heartbeat(deployment, token, v3Digest, {
      deploymentRolloutState: 'COMPLETED',
      desiredCount: 2,
      runningCount: 2,
      unhealthyTargetCount: 0,
      httpProbe: { ok: true, statusCode: 200, latencyMs: 11, checkedAt: new Date().toISOString() },
    });
    expect(response.statusCode).toBe(200);
    expect((await reload(deployment.id)).currentReleaseId).toBe(v2.id);

    const detail = await app.inject({ method: 'GET', url: `/api/deployments/${deployment.id}`, headers: { cookie } });
    const status = (detail.json() as { deploymentStatus: { connector: unknown } }).deploymentStatus;
    expect(status.connector).toMatchObject({ upgradeRequired: true, reason: 'RELEASE_EVIDENCE_MISSING' });
  });

  it('never reuses evidence stored by an earlier heartbeat', async () => {
    const { deployment, token, v2, v3Digest } = await seedDrifted('stored');
    // The earlier heartbeat's passing evidence is already in the row.
    await db
      .update(schema.deployments)
      .set({ observedState: { releaseEvidence: healthyEvidence(v3Digest) } })
      .where(eq(schema.deployments.id, deployment.id));

    const response = await app.inject({
      method: 'POST',
      url: '/api/relay/health',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        installationId: deployment.installationId,
        healthStatus: 'HEALTHY',
        runningImageDigest: v3Digest,
      }),
    });
    expect(response.statusCode).toBe(200);
    expect((await reload(deployment.id)).currentReleaseId).toBe(v2.id);
  });

  it('ignores an older heartbeat that arrives after a newer one was accepted', async () => {
    const { deployment, token, v2, v3, v3Digest } = await seedDrifted('order');
    const v2Digest = digestFor('v2.order');

    const accepted = await heartbeat(deployment, token, v3Digest, healthyObservedState(v3Digest));
    expect(accepted.statusCode).toBe(200);
    const promoted = await reload(deployment.id);
    expect(promoted.currentReleaseId).toBe(v3.id);

    const older = healthyEvidence(v2Digest);
    older.observedAt = isoAgo(5 * 60 * 1000);
    older.httpProbe = { ok: true, status: 200, checkedAt: isoAgo(5 * 60 * 1000) };
    const late = await heartbeat(deployment, token, v2Digest, { releaseEvidence: older });
    expect(late.statusCode).toBe(200);

    const after = await reload(deployment.id);
    expect(after.currentReleaseId).toBe(v3.id);
    expect(after.currentReleaseId).not.toBe(v2.id);
    expect(after.currentReleaseConfirmedAt).toEqual(promoted.currentReleaseConfirmedAt);
  });

  it('marks the first confirmation of a release as initial', async () => {
    const deployment = await seedDeployment();
    const v1 = await seedRelease('v1.initial', digestFor('v1.initial'), 'READY');
    const response = await heartbeat(
      deployment,
      (deployment as unknown as { __token: string }).__token,
      digestFor('v1.initial'),
      healthyObservedState(digestFor('v1.initial')),
    );
    expect(response.statusCode).toBe(200);
    expect((await reload(deployment.id)).currentReleaseId).toBe(v1.id);
    const [event] = await db
      .select()
      .from(schema.eventLogs)
      .where(
        and(eq(schema.eventLogs.deploymentId, deployment.id), eq(schema.eventLogs.eventType, 'deployment.reconciled')),
      );
    expect(event!.payload).toMatchObject({ kind: 'initial', previousReleaseId: null });
  });
});
