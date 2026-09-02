import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import { hashRelayToken } from './relay-store.js';
import { buildServer } from './server.js';

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

// Task 4: POST /api/relay/commands/:id/progress — the relay stack-event
// ingest endpoint. Snapshot folding is verified end-to-end through
// GET /api/install/:installLinkId/status (deriveDeploymentStatus), not by
// re-implementing deployment-status.ts's derivation here.
describe('POST /api/relay/commands/:id/progress', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let organizationId: string;
  let applicationId: string;
  let customerId: string;

  /** A READY manifest — the Phase 3 relay-register gate re-evaluates it. */
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

  /** Registers a fresh relay and polls once so its INSTALL job moves to RUNNING. */
  async function setupInstallJob(): Promise<{
    deployment: typeof schema.deployments.$inferSelect;
    token: string;
    installationId: string;
    job: { id: string; type: string };
    stackName: string;
  }> {
    const token = `progress-token-${crypto.randomUUID()}`;
    const installationId = `inst-${crypto.randomUUID()}`;
    const deployment = await insertDeployment();

    const register = await postJson(
      app,
      '/api/relay/register',
      { enrollmentCode: deployment.enrollmentCode, installationId },
      { authorization: `Bearer ${token}` },
    );
    expect(register.statusCode).toBe(200);

    const commands = await app.inject({
      method: 'GET',
      url: `/api/relay/commands?installationId=${installationId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const job = (commands.json() as { commands: Array<{ id: string; type: string }> }).commands[0]!;

    return { deployment, token, installationId, job, stackName: `stack-${deployment.id}` };
  }

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);

    const email = 'stack-progress@example.com';
    const password = 'super-secret-1';
    await auth.api.signUpEmail({ body: { email, password, name: 'Progress' } });

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
        name: 'Progress App',
        repoFullName: `acme/progress-app-${crypto.randomUUID().slice(0, 8)}`,
        repoUrl: 'https://github.com/acme/progress-app',
        defaultBranch: 'main',
      })
      .returning();
    applicationId = application!.id;

    const [customer] = await db
      .insert(schema.customers)
      .values({
        organizationId,
        name: 'Progress Customer',
        email: `progress-cust-${crypto.randomUUID()}@example.com`,
      })
      .returning();
    customerId = customer!.id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('accepts a batch, persists rows, and folds a provisioning snapshot into customer status', async () => {
    const { deployment, token, installationId, job, stackName } = await setupInstallJob();
    expect(job.type).toBe('INSTALL');

    const t0 = new Date();
    const response = await postJson(
      app,
      `/api/relay/commands/${job.id}/progress`,
      {
        commandId: job.id,
        installationId,
        stackName,
        events: [
          {
            eventId: 'evt-vpc',
            timestamp: t0.toISOString(),
            logicalResourceId: 'Vpc',
            resourceType: 'AWS::EC2::VPC',
            resourceStatus: 'CREATE_IN_PROGRESS',
          },
          {
            eventId: 'evt-subnet',
            timestamp: new Date(t0.getTime() + 1000).toISOString(),
            logicalResourceId: 'Subnet',
            resourceType: 'AWS::EC2::Subnet',
            resourceStatus: 'CREATE_IN_PROGRESS',
          },
        ],
      },
      { authorization: `Bearer ${token}` },
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: 2 });

    const rows = await db
      .select()
      .from(schema.deploymentStackEvents)
      .where(eq(schema.deploymentStackEvents.jobId, job.id));
    expect(rows).toHaveLength(2);

    const [updatedJob] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, job.id));
    expect(updatedJob!.lastProgressAt).not.toBeNull();

    const status = await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}/status` });
    expect(status.statusCode).toBe(200);
    const body = status.json() as { stage: string; step: string };
    expect(body.stage).toBe('PROVISIONING');
    expect(body.step).toBe('NETWORK');
  });

  it('the snapshot fold is scoped to the current job: a stray row from another job on the same deployment is not summarized', async () => {
    const { deployment, token, installationId, job, stackName } = await setupInstallJob();

    // A row left behind by a different job (e.g. a prior attempt) on the
    // same deployment — categorized "database", which would flip the
    // status derivation below if it leaked into this job's fold.
    const [otherJob] = await db
      .insert(schema.deploymentJobs)
      .values({ deploymentId: deployment.id, type: 'HEALTH_CHECK', idempotencyKey: crypto.randomUUID() })
      .returning();
    await db.insert(schema.deploymentStackEvents).values({
      deploymentId: deployment.id,
      jobId: otherJob!.id,
      providerEventId: 'evt-other-job-db',
      eventAt: new Date(),
      logicalResourceId: 'Db',
      resourceType: 'AWS::RDS::DBInstance',
      resourceStatus: 'CREATE_COMPLETE',
    });

    const t0 = new Date();
    const response = await postJson(
      app,
      `/api/relay/commands/${job.id}/progress`,
      {
        commandId: job.id,
        installationId,
        stackName,
        events: [
          {
            eventId: 'evt-scoped-vpc',
            timestamp: t0.toISOString(),
            logicalResourceId: 'Vpc',
            resourceType: 'AWS::EC2::VPC',
            resourceStatus: 'CREATE_IN_PROGRESS',
          },
        ],
      },
      { authorization: `Bearer ${token}` },
    );
    expect(response.statusCode).toBe(200);

    const status = await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}/status` });
    const body = status.json() as { stage: string; step: string };
    expect(body.stage).toBe('PROVISIONING');
    expect(body.step).toBe('NETWORK');
  });

  it('a duplicate batch is idempotent: second POST accepts 0, row count stays 1 per event', async () => {
    const { installationId, token, job, stackName } = await setupInstallJob();
    const payload = {
      commandId: job.id,
      installationId,
      stackName,
      events: [
        {
          eventId: 'evt-dup-1',
          timestamp: new Date().toISOString(),
          logicalResourceId: 'Vpc',
          resourceType: 'AWS::EC2::VPC',
          resourceStatus: 'CREATE_IN_PROGRESS',
        },
        {
          eventId: 'evt-dup-2',
          timestamp: new Date().toISOString(),
          logicalResourceId: 'Subnet',
          resourceType: 'AWS::EC2::Subnet',
          resourceStatus: 'CREATE_IN_PROGRESS',
        },
      ],
    };

    const first = await postJson(app, `/api/relay/commands/${job.id}/progress`, payload, {
      authorization: `Bearer ${token}`,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ accepted: 2 });

    const second = await postJson(app, `/api/relay/commands/${job.id}/progress`, payload, {
      authorization: `Bearer ${token}`,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ accepted: 0 });

    const rows = await db
      .select()
      .from(schema.deploymentStackEvents)
      .where(eq(schema.deploymentStackEvents.jobId, job.id));
    expect(rows).toHaveLength(2);
  });

  it('rejects a wrong bearer token', async () => {
    const { installationId, job, stackName } = await setupInstallJob();
    const response = await postJson(
      app,
      `/api/relay/commands/${job.id}/progress`,
      {
        commandId: job.id,
        installationId,
        stackName,
        events: [
          {
            eventId: 'evt-wrong-token',
            timestamp: new Date().toISOString(),
            logicalResourceId: 'Vpc',
            resourceType: 'AWS::EC2::VPC',
            resourceStatus: 'CREATE_IN_PROGRESS',
          },
        ],
      },
      { authorization: 'Bearer wrong-token' },
    );
    expect(response.statusCode).toBe(401);
  });

  it('404s for a job that belongs to another deployment', async () => {
    const jobA = await setupInstallJob();
    const jobB = await setupInstallJob();

    const response = await postJson(
      app,
      `/api/relay/commands/${jobA.job.id}/progress`,
      {
        commandId: jobA.job.id,
        installationId: jobB.installationId,
        stackName: jobA.stackName,
        events: [
          {
            eventId: 'evt-cross-deployment',
            timestamp: new Date().toISOString(),
            logicalResourceId: 'Vpc',
            resourceType: 'AWS::EC2::VPC',
            resourceStatus: 'CREATE_IN_PROGRESS',
          },
        ],
      },
      { authorization: `Bearer ${jobB.token}` },
    );
    expect(response.statusCode).toBe(404);
  });

  it('persists a redacted resourceStatusReason', async () => {
    const { installationId, token, job, stackName } = await setupInstallJob();
    const response = await postJson(
      app,
      `/api/relay/commands/${job.id}/progress`,
      {
        commandId: job.id,
        installationId,
        stackName,
        events: [
          {
            eventId: 'evt-secret',
            timestamp: new Date().toISOString(),
            logicalResourceId: 'DbSecret',
            resourceType: 'AWS::SecretsManager::Secret',
            resourceStatus: 'CREATE_FAILED',
            resourceStatusReason: 'connection refused: PASSWORD=hunter2',
          },
        ],
      },
      { authorization: `Bearer ${token}` },
    );
    expect(response.statusCode).toBe(200);

    const rows = await db
      .select()
      .from(schema.deploymentStackEvents)
      .where(eq(schema.deploymentStackEvents.jobId, job.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resourceStatusReason).not.toBeNull();
    expect(rows[0]!.resourceStatusReason).not.toContain('hunter2');
    expect(rows[0]!.resourceStatusReason).toContain('[REDACTED]');
  });

  it('a DESTROY job persists events but never rewrites observedState.infraHealth.provisioning', async () => {
    const token = `destroy-token-${crypto.randomUUID()}`;
    const installationId = `inst-${crypto.randomUUID()}`;
    const deployment = await insertDeployment({
      installationId,
      relayTokenHash: hashRelayToken(token),
      state: 'DELETING',
      observedState: { untouched: 'marker' },
    });
    const [destroyJob] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: deployment.id,
        type: 'DESTROY',
        state: 'RUNNING',
        idempotencyKey: `${deployment.id}:DESTROY:test`,
        payload: {},
      })
      .returning();

    const response = await postJson(
      app,
      `/api/relay/commands/${destroyJob!.id}/progress`,
      {
        commandId: destroyJob!.id,
        installationId,
        stackName: `stack-${deployment.id}`,
        events: [
          {
            eventId: 'evt-destroy',
            timestamp: new Date().toISOString(),
            logicalResourceId: 'Vpc',
            resourceType: 'AWS::EC2::VPC',
            resourceStatus: 'DELETE_IN_PROGRESS',
          },
        ],
      },
      { authorization: `Bearer ${token}` },
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: 1 });

    const rows = await db
      .select()
      .from(schema.deploymentStackEvents)
      .where(eq(schema.deploymentStackEvents.jobId, destroyJob!.id));
    expect(rows).toHaveLength(1);

    const [updatedDeployment] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id));
    expect(updatedDeployment!.observedState).toEqual({ untouched: 'marker' });
  });

  it('a stack-level ROLLBACK_IN_PROGRESS event keeps the existing rollback copy, no jargon, and does not flip stage on its own', async () => {
    const { deployment, installationId, token, job, stackName } = await setupInstallJob();

    const first = await postJson(
      app,
      `/api/relay/commands/${job.id}/progress`,
      {
        commandId: job.id,
        installationId,
        stackName,
        events: [
          {
            eventId: 'evt-network-progress',
            timestamp: new Date().toISOString(),
            logicalResourceId: 'Vpc',
            resourceType: 'AWS::EC2::VPC',
            resourceStatus: 'CREATE_IN_PROGRESS',
          },
        ],
      },
      { authorization: `Bearer ${token}` },
    );
    expect(first.statusCode).toBe(200);

    const rollback = await postJson(
      app,
      `/api/relay/commands/${job.id}/progress`,
      {
        commandId: job.id,
        installationId,
        stackName,
        events: [
          {
            eventId: 'evt-stack-rollback',
            timestamp: new Date(Date.now() + 1000).toISOString(),
            logicalResourceId: stackName,
            resourceType: 'AWS::CloudFormation::Stack',
            resourceStatus: 'ROLLBACK_IN_PROGRESS',
          },
        ],
      },
      { authorization: `Bearer ${token}` },
    );
    expect(rollback.statusCode).toBe(200);

    const [updatedJob] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, job.id));
    expect(updatedJob!.state).toBe('RUNNING');

    const status = await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}/status` });
    const body = status.json() as { stage: string; step: string; currentActivity: string };
    // Stage still comes from the job's own state (still RUNNING), not from
    // the snapshot — a rollback/failed category never flips it on its own.
    expect(body.stage).toBe('PROVISIONING');
    expect(body.step).toBe('PREPARING');
    expect(body.currentActivity).not.toMatch(/ROLLBACK|CloudFormation|AWS::/i);
  });
});

// Task 5: GET /api/deployments/:id/stack-events — the vendor diagnostics read
// endpoint. Org-scoped exactly like GET /api/deployments/:id/events.
describe('GET /api/deployments/:id/stack-events', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let ownerCookie: string;
  let deployment: typeof schema.deployments.$inferSelect;

  async function signUpAndSignIn(email: string): Promise<string> {
    const password = 'super-secret-1';
    await auth.api.signUpEmail({ body: { email, password, name: email.split('@')[0]! } });
    const signin = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    const setCookie = signin.headers.get('set-cookie');
    if (!setCookie) {
      throw new Error('sign-in did not set a session cookie');
    }
    return setCookie;
  }

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    app = await buildServer({ auth, db });

    ownerCookie = await signUpAndSignIn('stack-events-owner@example.com');
    const memberships = await db
      .select({ organizationId: schema.member.organizationId })
      .from(schema.member)
      .limit(1);
    const organizationId = memberships[0]!.organizationId;

    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'Stack Events App',
        repoFullName: `acme/stack-events-app-${crypto.randomUUID().slice(0, 8)}`,
        repoUrl: 'https://github.com/acme/stack-events-app',
        defaultBranch: 'main',
      })
      .returning();
    const [customer] = await db
      .insert(schema.customers)
      .values({
        organizationId,
        name: 'Stack Events Customer',
        email: `stack-events-cust-${crypto.randomUUID()}@example.com`,
      })
      .returning();
    [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId: application!.id,
        customerId: customer!.id,
        region: 'us-east-1',
        state: 'NOT_INSTALLED',
        installationId: `inst-${crypto.randomUUID()}`,
        enrollmentCode: crypto.randomUUID(),
      })
      .returning();

    const t0 = new Date();
    await db.insert(schema.deploymentStackEvents).values([
      {
        deploymentId: deployment.id,
        providerEventId: 'evt-vpc',
        eventAt: t0,
        logicalResourceId: 'Vpc',
        resourceType: 'AWS::EC2::VPC',
        resourceStatus: 'CREATE_IN_PROGRESS',
      },
      {
        deploymentId: deployment.id,
        providerEventId: 'evt-subnet',
        eventAt: new Date(t0.getTime() + 1000),
        logicalResourceId: 'Subnet',
        resourceType: 'AWS::EC2::Subnet',
        resourceStatus: 'CREATE_COMPLETE',
        resourceStatusReason: 'resource creation completed',
      },
      {
        deploymentId: deployment.id,
        providerEventId: 'evt-stack',
        eventAt: new Date(t0.getTime() + 2000),
        logicalResourceId: 'Stack',
        resourceType: 'AWS::CloudFormation::Stack',
        resourceStatus: 'CREATE_COMPLETE',
      },
    ]);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('returns the owner rows newest-first with raw vendor fields', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}/stack-events`,
      headers: { cookie: ownerCookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { events: Array<Record<string, unknown>> };
    expect(body.events.map((e) => e.logicalResourceId)).toEqual(['Stack', 'Subnet', 'Vpc']);
    expect(body.events[1]).toMatchObject({
      resourceType: 'AWS::EC2::Subnet',
      resourceStatus: 'CREATE_COMPLETE',
      resourceStatusReason: 'resource creation completed',
    });
    expect(typeof body.events[0]!.eventAt).toBe('string');
  });

  it('404s for a user from another org', async () => {
    const otherCookie = await signUpAndSignIn('stack-events-outsider@example.com');
    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}/stack-events`,
      headers: { cookie: otherCookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('401s when unauthenticated', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}/stack-events`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('respects the limit query param', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}/stack-events?limit=2`,
      headers: { cookie: ownerCookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { events: unknown[] };
    expect(body.events).toHaveLength(2);
  });
});
