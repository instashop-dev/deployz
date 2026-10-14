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
} from '@deployz/contracts';

import { createAuth, type Auth } from './auth.js';
import { compileDeploymentIntent } from './compiler-artifact.js';
import { hashRelayToken } from './relay-store.js';
import { buildServer } from './server.js';

// Task 3.4: health CHANGES produce one matching event each — degraded,
// unhealthy, recovered — and a newly failed ECS rollout records exactly one
// ecs.rollout_failed. Unchanged heartbeats produce no events. Readiness
// transitions (FAILED/INSTALLING → HEALTHY) need release evidence that passes;
// a relay healthStatus alone never earns them.
describe('health transition events', () => {
  const MANIFEST: DeploymentManifest = {
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
  const spec: DeploymentSpecV2 = compileDeploymentIntent({ manifest: MANIFEST, region: 'us-east-1' }).spec;
  const DIGEST = 'sha256:' + 'a'.repeat(64);

  function evidence(patch: (value: ReleaseEvidence) => void = () => {}): ReleaseEvidence {
    const at = new Date().toISOString();
    const value: ReleaseEvidence = {
      version: 1,
      observedAt: at,
      services: workloadServicesFromSpec(spec)!.map((workload) => ({
        workloadId: workload.id,
        serviceLogicalId: workload.serviceLogicalId,
        observed: true,
        desiredCount: 1,
        runningCount: 1,
        rolloutState: 'COMPLETED',
        runningDigests: [DIGEST],
        targets: { healthy: 1, unhealthy: 0, pending: 0, unknown: 0 },
      })),
      httpProbe: { ok: true, status: 200, checkedAt: at },
    };
    patch(value);
    return value;
  }

  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let organizationId: string;
  let applicationId: string;
  let customerId: string;

  async function seedDeployment(
    healthStatus: 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY',
    observedState: Record<string, unknown> = {},
  ): Promise<{ id: string; installationId: string; token: string }> {
    const token = 'tok-' + crypto.randomUUID();
    const installationId = 'inst-' + crypto.randomUUID();
    await db.insert(schema.deployments).values({
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
      healthStatus,
      observedState,
    });
    return { id: '', installationId, token };
  }

  async function heartbeat(
    installationId: string,
    token: string,
    healthStatus: string,
    rolloutState?: string,
    releaseEvidence?: ReleaseEvidence,
  ): Promise<void> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/relay/health',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        installationId,
        observedState: {
          ...(rolloutState ? { deploymentRolloutState: rolloutState } : {}),
          ...(releaseEvidence ? { releaseEvidence } : {}),
        },
        healthStatus,
        components: { application: healthStatus },
      }),
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  async function events(installationId: string): Promise<{ eventType: string }[]> {
    return db
      .select({ eventType: schema.eventLogs.eventType })
      .from(schema.eventLogs)
      .innerJoin(
        schema.deployments,
        eq(schema.eventLogs.deploymentId, schema.deployments.id),
      )
      .where(
        and(
          eq(schema.deployments.installationId, installationId),
          eq(schema.eventLogs.actorType, 'relay'),
        ),
      );
  }

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);

    const email = 'health-transitions@example.com';
    const password = 'super-secret-1';
    await auth.api.signUpEmail({ body: { email, password, name: 'Health' } });

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
        repoFullName: `acme/ht-${crypto.randomUUID().slice(0, 8)}`,
        repoUrl: 'https://github.com/acme/ht',
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

  it('recovers a FAILED-but-installed deployment to HEALTHY on a healthy heartbeat', async () => {
    const [release] = await db
      .insert(schema.releases)
      .values({
        applicationId,
        version: 'v9.9.9',
        gitSha: 'abc123',
        imageDigest: 'acme/app@sha256:' + 'a'.repeat(64),
        buildStatus: 'SUCCEEDED',
        releaseStatus: 'READY',
      })
      .returning();
    const token = 'tok-' + crypto.randomUUID();
    const installationId = 'inst-' + crypto.randomUUID();
    await db.insert(schema.deployments).values({
      organizationId,
      applicationId,
      customerId,
      region: 'us-east-1',
      state: 'FAILED',
      currentReleaseId: release!.id,
      installationId,
      enrollmentCode: crypto.randomUUID(),
      enrollmentUsedAt: new Date(),
      relayTokenHash: hashRelayToken(token),
      relayStatus: 'CONNECTED',
      healthStatus: 'HEALTHY',
      observedState: {},
      specV2: spec as unknown as Record<string, unknown>,
    });

    await heartbeat(installationId, token, 'HEALTHY');
    const [withoutEvidence] = await db
      .select({ state: schema.deployments.state })
      .from(schema.deployments)
      .where(eq(schema.deployments.installationId, installationId));
    expect(withoutEvidence?.state).toBe('FAILED');

    await heartbeat(installationId, token, 'HEALTHY', undefined, evidence((value) => {
      value.httpProbe = { ok: false, status: 503, checkedAt: value.observedAt };
    }));
    const [failedProbe] = await db
      .select({ state: schema.deployments.state })
      .from(schema.deployments)
      .where(eq(schema.deployments.installationId, installationId));
    expect(failedProbe?.state).toBe('FAILED');

    await heartbeat(installationId, token, 'HEALTHY', undefined, evidence());

    const [row] = await db
      .select({ state: schema.deployments.state })
      .from(schema.deployments)
      .where(eq(schema.deployments.installationId, installationId));
    expect(row?.state).toBe('HEALTHY');
    expect((await events(installationId)).map((e) => e.eventType)).toContain(
      'deployment.state_recovered',
    );
  });

  it('verifies an installed INSTALLING deployment HEALTHY only on passing release evidence', async () => {
    const token = 'tok-' + crypto.randomUUID();
    const installationId = 'inst-' + crypto.randomUUID();
    const [row] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        state: 'INSTALLING',
        installationId,
        enrollmentCode: crypto.randomUUID(),
        enrollmentUsedAt: new Date(),
        relayTokenHash: hashRelayToken(token),
        relayStatus: 'CONNECTED',
        healthStatus: 'UNKNOWN',
        observedState: {},
        specV2: spec as unknown as Record<string, unknown>,
      })
      .returning();
    await db.insert(schema.deploymentJobs).values({
      deploymentId: row!.id,
      type: 'INSTALL',
      state: 'SUCCEEDED',
      idempotencyKey: `${row!.id}:INSTALL`,
      finishedAt: new Date(),
    });
    const stateOf = async () =>
      (await db.select({ state: schema.deployments.state }).from(schema.deployments).where(eq(schema.deployments.id, row!.id)))[0]
        ?.state;

    await heartbeat(installationId, token, 'HEALTHY');
    expect(await stateOf()).toBe('INSTALLING');
    await heartbeat(installationId, token, 'HEALTHY', undefined, evidence((value) => {
      value.services[0]!.runningCount = 0;
    }));
    expect(await stateOf()).toBe('INSTALLING');
    await heartbeat(installationId, token, 'HEALTHY', undefined, evidence());
    expect(await stateOf()).toBe('HEALTHY');
  });

  describe('bounded install verification', () => {
    const LONG_AGO = new Date(Date.now() - 31 * 60 * 1000);

    async function seedInstalling(
      jobs: { type: 'INSTALL' | 'DEPLOY_RELEASE'; state: 'SUCCEEDED' | 'RUNNING'; finishedAt: Date | null }[],
    ) {
      const token = 'tok-' + crypto.randomUUID();
      const installationId = 'inst-' + crypto.randomUUID();
      const [row] = await db
        .insert(schema.deployments)
        .values({
          organizationId,
          applicationId,
          customerId,
          region: 'us-east-1',
          state: 'INSTALLING',
          installationId,
          enrollmentCode: crypto.randomUUID(),
          enrollmentUsedAt: new Date(),
          relayTokenHash: hashRelayToken(token),
          relayStatus: 'CONNECTED',
          healthStatus: 'UNKNOWN',
          observedState: {},
          specV2: spec as unknown as Record<string, unknown>,
        })
        .returning();
      let offset = jobs.length;
      for (const job of jobs) {
        await db.insert(schema.deploymentJobs).values({
          deploymentId: row!.id,
          type: job.type,
          state: job.state,
          idempotencyKey: `${row!.id}:${job.type}`,
          createdAt: new Date((job.finishedAt ?? new Date()).getTime() - offset-- * 1000),
          finishedAt: job.finishedAt,
        });
      }
      const stateOf = async () =>
        (await db.select({ state: schema.deployments.state }).from(schema.deployments).where(eq(schema.deployments.id, row!.id)))[0]
          ?.state;
      return { id: row!.id, installationId, token, stateOf };
    }

    const probeFails = () =>
      evidence((value) => {
        value.httpProbe = { ok: false, status: 503, checkedAt: value.observedAt };
      });

    it('fails an install that never verified once, with a classified code', async () => {
      const d = await seedInstalling([{ type: 'INSTALL', state: 'SUCCEEDED', finishedAt: LONG_AGO }]);

      await heartbeat(d.installationId, d.token, 'UNHEALTHY', undefined, probeFails());
      expect(await d.stateOf()).toBe('FAILED');
      await heartbeat(d.installationId, d.token, 'UNHEALTHY', undefined, probeFails());

      const recorded = (await events(d.installationId)).filter((e) => e.eventType === 'deployment.install_not_verified');
      expect(recorded).toHaveLength(1);
      const [install] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.deploymentId, d.id));
      expect(install!.result).toMatchObject({
        installVerification: { failureCode: 'IMAGE_HEALTH_CHECK_FAILED', reason: 'PROBE_FAILED' },
      });
    });

    it('waits inside the window and verifies a passing app', async () => {
      const d = await seedInstalling([{ type: 'INSTALL', state: 'SUCCEEDED', finishedAt: new Date() }]);
      await heartbeat(d.installationId, d.token, 'UNHEALTHY', undefined, probeFails());
      expect(await d.stateOf()).toBe('INSTALLING');
      await heartbeat(d.installationId, d.token, 'HEALTHY', undefined, evidence());
      expect(await d.stateOf()).toBe('HEALTHY');
    });

    it('measures the window from a later settled deploy', async () => {
      const d = await seedInstalling([
        { type: 'INSTALL', state: 'SUCCEEDED', finishedAt: LONG_AGO },
        { type: 'DEPLOY_RELEASE', state: 'SUCCEEDED', finishedAt: new Date() },
      ]);
      await heartbeat(d.installationId, d.token, 'UNHEALTHY', undefined, probeFails());
      expect(await d.stateOf()).toBe('INSTALLING');
    });

    it('never fails an old connector that sends no evidence', async () => {
      const d = await seedInstalling([{ type: 'INSTALL', state: 'SUCCEEDED', finishedAt: LONG_AGO }]);
      await heartbeat(d.installationId, d.token, 'HEALTHY');
      expect(await d.stateOf()).toBe('INSTALLING');
    });

    it('does not fail while a mutating job is active', async () => {
      const d = await seedInstalling([
        { type: 'INSTALL', state: 'SUCCEEDED', finishedAt: LONG_AGO },
        { type: 'DEPLOY_RELEASE', state: 'RUNNING', finishedAt: null },
      ]);
      await heartbeat(d.installationId, d.token, 'UNHEALTHY', undefined, probeFails());
      expect(await d.stateOf()).toBe('INSTALLING');
    });

    it('does not fail a configured first start that has not been deployed yet', async () => {
      const d = await seedInstalling([{ type: 'INSTALL', state: 'SUCCEEDED', finishedAt: LONG_AGO }]);
      await heartbeat(d.installationId, d.token, 'UNHEALTHY', undefined, evidence((value) => {
        for (const service of value.services) {
          service.desiredCount = 0;
          service.runningCount = 0;
          service.runningDigests = [];
          service.targets = { healthy: 0, unhealthy: 0, pending: 0, unknown: 0 };
        }
      }));
      expect(await d.stateOf()).toBe('INSTALLING');
    });
  });

  it('records no outage event while every workload is intentionally at zero tasks', async () => {
    const seeded = await seedDeployment('HEALTHY');
    await db
      .update(schema.deployments)
      .set({ specV2: spec as unknown as Record<string, unknown> })
      .where(eq(schema.deployments.installationId, seeded.installationId));

    await heartbeat(seeded.installationId, seeded.token, 'UNHEALTHY', undefined, evidence((value) => {
      for (const service of value.services) {
        service.desiredCount = 0;
        service.runningCount = 0;
        service.runningDigests = [];
        service.targets = { healthy: 0, unhealthy: 0, pending: 0, unknown: 0 };
      }
    }));
    expect((await events(seeded.installationId)).map((e) => e.eventType)).not.toContain('health.unhealthy');
    const [row] = await db
      .select({ observedState: schema.deployments.observedState })
      .from(schema.deployments)
      .where(eq(schema.deployments.installationId, seeded.installationId));
    expect((row!.observedState as { releaseVerdict: { notStarted: boolean } }).releaseVerdict.notStarted).toBe(true);
  });

  it('still records an outage event when tasks are missing without being scaled to zero', async () => {
    const seeded = await seedDeployment('HEALTHY');
    await db
      .update(schema.deployments)
      .set({ specV2: spec as unknown as Record<string, unknown> })
      .where(eq(schema.deployments.installationId, seeded.installationId));

    await heartbeat(seeded.installationId, seeded.token, 'UNHEALTHY', undefined, evidence((value) => {
      value.services[0]!.runningCount = 0;
    }));
    expect((await events(seeded.installationId)).map((e) => e.eventType)).toContain('health.unhealthy');
  });

  it('keeps a FAILED never-installed deployment FAILED on a healthy heartbeat', async () => {
    const token = 'tok-' + crypto.randomUUID();
    const installationId = 'inst-' + crypto.randomUUID();
    await db.insert(schema.deployments).values({
      organizationId,
      applicationId,
      customerId,
      region: 'us-east-1',
      state: 'FAILED',
      installationId,
      enrollmentCode: crypto.randomUUID(),
      enrollmentUsedAt: new Date(),
      relayTokenHash: hashRelayToken(token),
      relayStatus: 'CONNECTED',
      healthStatus: 'UNKNOWN',
      observedState: {},
    });

    await heartbeat(installationId, token, 'HEALTHY');

    const [row] = await db
      .select({ state: schema.deployments.state })
      .from(schema.deployments)
      .where(eq(schema.deployments.installationId, installationId));
    expect(row?.state).toBe('FAILED');
  });

  it('records health.degraded on HEALTHY → DEGRADED', async () => {
    const seeded = await seedDeployment('HEALTHY');
    await heartbeat(seeded.installationId, seeded.token, 'DEGRADED');
    const types = (await events(seeded.installationId)).map((e) => e.eventType);
    expect(types).toContain('health.degraded');
  });

  it('records health.unhealthy on DEGRADED → UNHEALTHY', async () => {
    const seeded = await seedDeployment('DEGRADED');
    await heartbeat(seeded.installationId, seeded.token, 'UNHEALTHY');
    const types = (await events(seeded.installationId)).map((e) => e.eventType);
    expect(types).toContain('health.unhealthy');
    expect(types).not.toContain('health.degraded');
  });

  it('records health.recovered on UNHEALTHY → HEALTHY', async () => {
    const seeded = await seedDeployment('UNHEALTHY');
    await heartbeat(seeded.installationId, seeded.token, 'HEALTHY');
    const types = (await events(seeded.installationId)).map((e) => e.eventType);
    expect(types).toContain('health.recovered');
  });

  it('records no health event when the status is unchanged', async () => {
    const seeded = await seedDeployment('HEALTHY');
    await heartbeat(seeded.installationId, seeded.token, 'HEALTHY');
    const types = (await events(seeded.installationId)).map((e) => e.eventType);
    expect(types.filter((t) => t.startsWith('health.'))).toEqual([]);
  });

  it('records ecs.rollout_failed once per observed failure', async () => {
    const seeded = await seedDeployment('HEALTHY');
    await heartbeat(seeded.installationId, seeded.token, 'UNHEALTHY', 'FAILED');
    await heartbeat(seeded.installationId, seeded.token, 'UNHEALTHY', 'FAILED');

    const types = (await events(seeded.installationId)).map((e) => e.eventType);
    expect(types.filter((t) => t === 'ecs.rollout_failed')).toHaveLength(1);
  });
});
