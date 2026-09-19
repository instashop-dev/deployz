import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import { hashRelayToken } from './relay-store.js';
import { buildServer } from './server.js';

// Phase 1 failure evidence: the relay's structured stopped-container verdict
// is redacted before it is persisted, threads into §61 refinement, and is
// served back redacted by the diagnostics route — while results without
// evidence settle exactly as they did before it existed.
describe('relay result evidence ingest and serving', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let cookie: string;
  let organizationId: string;
  let applicationId: string;
  let customerId: string;

  async function seedDeployment(): Promise<{ id: string; token: string }> {
    const token = 'tok-' + crypto.randomUUID();
    const [row] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        state: 'INSTALLING',
        installationId: 'inst-' + crypto.randomUUID(),
        enrollmentCode: crypto.randomUUID(),
        enrollmentUsedAt: new Date(),
        relayTokenHash: hashRelayToken(token),
        relayStatus: 'CONNECTED',
      })
      .returning();
    return { id: row!.id, token };
  }

  async function seedInstallJob(deploymentId: string): Promise<string> {
    const [row] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId,
        type: 'INSTALL',
        state: 'RUNNING',
        idempotencyKey: `${deploymentId}:INSTALL:${crypto.randomUUID()}`,
        payload: {},
      })
      .returning();
    return row!.id;
  }

  function postResult(jobId: string, token: string, body: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `/api/relay/commands/${jobId}/result`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
  }

  async function getJob(id: string) {
    const [row] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, id));
    return row!;
  }

  async function getDiagnostics(deploymentId: string) {
    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deploymentId}/diagnostics`,
      headers: { cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as {
      failureCode: string;
      evidence: {
        container: { exitCode: number | null; stopCode: string | null; stoppedReason: string | null; stoppedTaskCount: number | null } | null;
      } | null;
      retryEligibility: { action: string; retryable: boolean; whoMustAct: string | null } | null;
    };
  }

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);

    const email = 'failure-evidence@example.com';
    const password = 'super-secret-1';
    await auth.api.signUpEmail({ body: { email, password, name: 'Evidence' } });
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
        repoFullName: `acme/ev-${crypto.randomUUID().slice(0, 8)}`,
        repoUrl: 'https://github.com/acme/ev',
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

  it('stores evidence redacted in the job result and serves it redacted from diagnostics', async () => {
    const deployment = await seedDeployment();
    const jobId = await seedInstallJob(deployment.id);

    const response = await postResult(jobId, deployment.token, {
      success: false,
      error: 'Stack "deployz-app" finished in ROLLBACK_COMPLETE',
      failureCode: 'STACK_CREATE_FAILED',
      evidence: {
        container: {
          exitCode: 1,
          stopCode: 'EssentialContainerExited',
          stoppedReason: 'postgres://user:pass@host:5432/db connection refused',
          stoppedTaskCount: 2,
        },
      },
    });
    expect(response.statusCode, response.body).toBe(200);

    const job = await getJob(jobId);
    expect(job.state).toBe('FAILED');
    expect(job.failureCode).toBe('STACK_CREATE_FAILED');
    const stored = (job.result as { evidence?: { container?: { stoppedReason?: string } } }).evidence;
    expect(stored?.container?.stoppedReason).toContain('[REDACTED]@host:5432/db');
    expect(stored?.container?.stoppedReason).not.toContain('user:pass');

    const diagnostics = await getDiagnostics(deployment.id);
    expect(diagnostics.failureCode).toBe('STACK_CREATE_FAILED');
    expect(diagnostics.evidence?.container).toMatchObject({
      exitCode: 1,
      stopCode: 'EssentialContainerExited',
      stoppedTaskCount: 2,
    });
    expect(diagnostics.evidence?.container?.stoppedReason).toContain('[REDACTED]@host:5432/db');
    expect(diagnostics.evidence?.container?.stoppedReason).not.toContain('user:pass');

    expect(diagnostics.retryEligibility).toEqual({
      action: 'RETRY_INSTALL',
      retryable: true,
      whoMustAct: 'VENDOR',
    });
  });

  it('drops an unparseable evidence block instead of persisting it raw', async () => {
    const deployment = await seedDeployment();
    const jobId = await seedInstallJob(deployment.id);

    const response = await postResult(jobId, deployment.token, {
      success: false,
      error: 'Stack "deployz-app" finished in ROLLBACK_COMPLETE',
      failureCode: 'STACK_CREATE_FAILED',
      evidence: { container: { exitCode: 'one' } },
    });
    expect(response.statusCode, response.body).toBe(200);

    const job = await getJob(jobId);
    expect(job.state).toBe('FAILED');
    expect((job.result as Record<string, unknown>)['evidence']).toBeUndefined();
  });

  it('refines the failure code from the evidence signature', async () => {
    const deployment = await seedDeployment();
    const jobId = await seedInstallJob(deployment.id);

    const response = await postResult(jobId, deployment.token, {
      success: false,
      error: 'Stack "deployz-app" finished in ROLLBACK_COMPLETE',
      failureCode: 'STACK_CREATE_FAILED',
      evidence: {
        container: {
          exitCode: 1,
          stopCode: 'EssentialContainerExited',
          stoppedReason: 'connect ECONNREFUSED 10.0.1.5:5432',
          stoppedTaskCount: 3,
        },
      },
    });
    expect(response.statusCode, response.body).toBe(200);

    const job = await getJob(jobId);
    expect(job.failureCode).toBe('DATABASE_CONNECTION_FAILED');
  });

  it('settles a result without evidence exactly as before, and diagnostics reports evidence null', async () => {
    const deployment = await seedDeployment();
    const jobId = await seedInstallJob(deployment.id);

    const response = await postResult(jobId, deployment.token, {
      success: false,
      error: 'Stack "deployz-app" finished in ROLLBACK_COMPLETE',
      failureCode: 'STACK_CREATE_FAILED',
    });
    expect(response.statusCode, response.body).toBe(200);

    const job = await getJob(jobId);
    expect(job.state).toBe('FAILED');
    expect(job.failureCode).toBe('STACK_CREATE_FAILED');
    expect((job.result as Record<string, unknown>)['evidence']).toBeUndefined();

    const [row] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(row!.state).toBe('FAILED');

    const diagnostics = await getDiagnostics(deployment.id);
    expect(diagnostics.evidence).toBeNull();
  });

  it('reports retryEligibility null when there is no failed job', async () => {
    const deployment = await seedDeployment();

    const diagnostics = await getDiagnostics(deployment.id);
    expect(diagnostics.retryEligibility).toBeNull();
  });
});
