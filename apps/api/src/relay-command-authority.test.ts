import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import { hashRelayToken } from './relay-store.js';
import { buildServer } from './server.js';

// The relay's "must I still run this?" probe, and the narrow teardown rule
// that lets a dead-relay INSTALL stop blocking DESTROY without weakening
// operation exclusivity for a live in-flight INSTALL.
describe('relay command authority + dead-relay teardown', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let organizationId: string;
  let applicationId: string;
  let customerId: string;
  let cookie: string;

  async function seedDeployment(
    overrides: Partial<typeof schema.deployments.$inferInsert> = {},
  ): Promise<{ deployment: typeof schema.deployments.$inferSelect; token: string }> {
    const token = `tok-${crypto.randomUUID()}`;
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        state: 'INSTALLING',
        installationId: `inst-${crypto.randomUUID()}`,
        enrollmentCode: crypto.randomUUID(),
        enrollmentUsedAt: new Date(),
        relayTokenHash: hashRelayToken(token),
        relayStatus: 'CONNECTED',
        ...overrides,
      })
      .returning();
    return { deployment: deployment!, token };
  }

  async function seedJob(
    deploymentId: string,
    overrides: Partial<typeof schema.deploymentJobs.$inferInsert> = {},
  ): Promise<typeof schema.deploymentJobs.$inferSelect> {
    const [job] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId,
        type: 'INSTALL',
        state: 'RUNNING',
        idempotencyKey: `${deploymentId}:${crypto.randomUUID()}`,
        payload: {},
        ...overrides,
      })
      .returning();
    return job!;
  }

  function authority(jobId: string, token: string) {
    return app.inject({
      method: 'GET',
      url: `/api/relay/commands/${jobId}/authority`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  function destroy(deploymentId: string) {
    return app.inject({
      method: 'POST',
      url: `/api/deployments/${deploymentId}/destroy`,
      headers: { 'content-type': 'application/json', cookie },
      payload: '{}',
    });
  }

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);

    const email = 'relay-authority@example.com';
    const password = 'super-secret-1';
    await auth.api.signUpEmail({ body: { email, password, name: 'Authority' } });
    const signin = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    cookie = signin.headers.get('set-cookie')!;

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
        repoFullName: `acme/authority-${crypto.randomUUID().slice(0, 8)}`,
        repoUrl: 'https://github.com/acme/authority',
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

  it('rejects a bearer token that does not belong to the job deployment', async () => {
    const { deployment, token } = await seedDeployment();
    const job = await seedJob(deployment.id);
    const response = await authority(job.id, 'wrong-token');
    expect(response.statusCode).toBe(401);
    // Sanity: the real token still works.
    expect((await authority(job.id, token)).statusCode).toBe(200);
  });

  it('404s for a job that does not exist', async () => {
    const { token } = await seedDeployment();
    const response = await authority(crypto.randomUUID(), token);
    expect(response.statusCode).toBe(404);
  });

  it('reports a RUNNING INSTALL on an INSTALLING deployment with no DESTROY as active', async () => {
    const { deployment, token } = await seedDeployment({ state: 'INSTALLING' });
    const job = await seedJob(deployment.id, { state: 'RUNNING' });
    const response = await authority(job.id, token);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ active: true, jobState: 'RUNNING' });
  });

  it('reports a FAILED INSTALL as settled', async () => {
    const { deployment, token } = await seedDeployment({ state: 'FAILED' });
    const job = await seedJob(deployment.id, { state: 'FAILED', finishedAt: new Date() });
    const response = await authority(job.id, token);
    expect(response.json()).toEqual({ active: false, jobState: 'FAILED', reason: 'settled' });
  });

  it('reports a CANCELLED INSTALL as settled', async () => {
    const { deployment, token } = await seedDeployment({ state: 'INSTALLING' });
    const job = await seedJob(deployment.id, { state: 'CANCELLED', finishedAt: new Date() });
    const response = await authority(job.id, token);
    expect(response.json()).toEqual({ active: false, jobState: 'CANCELLED', reason: 'settled' });
  });

  it('reports teardown when the deployment is DELETING', async () => {
    const { deployment, token } = await seedDeployment({ state: 'DELETING' });
    const job = await seedJob(deployment.id, { state: 'RUNNING' });
    const response = await authority(job.id, token);
    expect(response.json()).toEqual({ active: false, jobState: 'RUNNING', reason: 'teardown' });
  });

  it('reports an INSTALL superseded by a later DESTROY as inactive', async () => {
    const { deployment, token } = await seedDeployment({ state: 'INSTALLING' });
    const job = await seedJob(deployment.id, {
      state: 'RUNNING',
      createdAt: new Date(Date.now() - 60_000),
    });
    await seedJob(deployment.id, {
      type: 'DESTROY',
      state: 'CANCELLED',
      finishedAt: new Date(),
      createdAt: new Date(Date.now() - 30_000),
    });
    const response = await authority(job.id, token);
    expect(response.json()).toEqual({
      active: false,
      jobState: 'RUNNING',
      reason: 'superseded_by_teardown',
    });
  });

  it('does not treat a DESTROY created before the INSTALL as superseding it', async () => {
    const { deployment, token } = await seedDeployment({ state: 'INSTALLING' });
    await seedJob(deployment.id, {
      type: 'DESTROY',
      state: 'CANCELLED',
      finishedAt: new Date(),
      createdAt: new Date(Date.now() - 60_000),
    });
    const job = await seedJob(deployment.id, {
      state: 'RUNNING',
      createdAt: new Date(Date.now() - 30_000),
    });
    const response = await authority(job.id, token);
    expect(response.json()).toEqual({ active: true, jobState: 'RUNNING' });
  });

  it('keeps DEPLOYMENT_BUSY for a CONNECTED relay with an active INSTALL', async () => {
    const { deployment } = await seedDeployment({ state: 'INSTALLING', relayStatus: 'CONNECTED' });
    const job = await seedJob(deployment.id, { state: 'RUNNING' });

    const response = await destroy(deployment.id);
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'DEPLOYMENT_BUSY' } });

    const [unchanged] = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.id, job.id));
    expect(unchanged!.state).toBe('RUNNING');
  });

  it('cancels an active INSTALL and creates the DESTROY when the relay is DISCONNECTED', async () => {
    const { deployment } = await seedDeployment({
      state: 'INSTALLING',
      relayStatus: 'DISCONNECTED',
    });
    const job = await seedJob(deployment.id, { state: 'RUNNING' });

    const response = await destroy(deployment.id);
    expect(response.statusCode, response.body).toBe(202);

    const [cancelled] = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.id, job.id));
    expect(cancelled!.state).toBe('CANCELLED');
    expect(cancelled!.finishedAt).not.toBeNull();

    const destroys = await db
      .select()
      .from(schema.deploymentJobs)
      .where(
        and(
          eq(schema.deploymentJobs.deploymentId, deployment.id),
          eq(schema.deploymentJobs.type, 'DESTROY'),
        ),
      );
    expect(destroys).toHaveLength(1);
  });
});
