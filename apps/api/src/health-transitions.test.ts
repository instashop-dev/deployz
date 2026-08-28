import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import { hashRelayToken } from './relay-store.js';
import { buildServer } from './server.js';

// Task 3.4: health CHANGES produce one matching event each — degraded,
// unhealthy, recovered — and a newly failed ECS rollout records exactly one
// ecs.rollout_failed. Unchanged heartbeats produce no events.
describe('health transition events', () => {
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
  ): Promise<void> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/relay/health',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        installationId,
        observedState: rolloutState ? { deploymentRolloutState: rolloutState } : {},
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
