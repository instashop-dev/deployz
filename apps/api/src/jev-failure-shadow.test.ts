import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  JEV_FAILURE_DECISION_SET_VERSION,
  JEV_FAILURE_EVIDENCE_SCHEMA_VERSION,
  JevError,
  createFixtureJevClient,
  type JevClient,
} from '@deployz/analysis';
import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { resolveJevConfig } from './ai-config.js';
import { createAuth, type Auth } from './auth.js';
import {
  createJevFailureShadowRunner,
  createJevFailureShadowRunnerFromEnv,
  type JevFailureShadowParams,
} from './jev-shadow.js';
import { hashRelayToken } from './relay-store.js';
import { buildServer } from './server.js';

// Jev UNKNOWN-failure shadow (PR 3), over the relay result route's own
// harness (failure-semantics.test.ts). The invariants under test: known and
// refined codes stay fully deterministic (Jev is never asked), an UNKNOWN
// failure is classified exactly once (settle-once respected), and a Jev that
// answers maximally confidently WRONG changes nothing but the telemetry row.

/** A fixture client that classifies every failure as DEPLOYZ with high confidence. */
function createConfidentWrongDomainClient(): ReturnType<typeof createFixtureJevClient> {
  return createFixtureJevClient({
    'failure-shadow': {
      model: 'jev-test',
      usage: { input_tokens: 42, output_tokens: 7 },
      answers: {
        failureDomain: {
          type: 'choice',
          choice: 'DEPLOYZ',
          probabilities: {
            APPLICATION: 0.01,
            CUSTOMER_CONFIGURATION: 0.01,
            AWS: 0.01,
            DEPLOYZ: 0.96,
            DEPENDENCY: 0.003,
            REGISTRY: 0.003,
            NETWORK: 0.004,
          },
          confidence: 0.99,
        },
        likelyTransient: { type: 'noul', noul: 0.9 },
        recommendedAction: {
          type: 'choice',
          choice: 'deployz',
          probabilities: { none: 0.05, customer: 0.05, vendor: 0.05, deployz: 0.85 },
          confidence: 0.9,
        },
      },
    },
  });
}

describe('jev UNKNOWN-failure shadow (result route)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let appDisabled: FastifyInstance;
  let appEnabled: FastifyInstance;
  let appTimeout: FastifyInstance;
  let fixtureClient: ReturnType<typeof createConfidentWrongDomainClient>;
  let organizationId: string;
  let applicationId: string;
  let customerId: string;

  async function seedDeployment(
    overrides: Partial<typeof schema.deployments.$inferInsert> = {},
  ): Promise<{ id: string; token: string }> {
    const token = 'tok-' + randomUUID();
    const [row] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        state: 'HEALTHY',
        installationId: 'inst-' + randomUUID(),
        enrollmentCode: randomUUID(),
        enrollmentUsedAt: new Date(),
        relayTokenHash: hashRelayToken(token),
        relayStatus: 'CONNECTED',
        ...overrides,
      })
      .returning();
    return { id: row!.id, token };
  }

  async function seedRelease(version: string): Promise<string> {
    const [row] = await db
      .insert(schema.releases)
      .values({
        applicationId,
        version,
        gitSha: randomUUID().slice(0, 7),
        imageDigest: `sha256:${'b'.repeat(64)}`,
        buildStatus: 'SUCCEEDED',
        releaseStatus: 'READY',
      })
      .returning();
    return row!.id;
  }

  async function seedJob(
    deploymentId: string,
    type: (typeof schema.deploymentJobs.$inferInsert)['type'],
    payload: Record<string, unknown> = {},
  ): Promise<string> {
    const [row] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId,
        type,
        state: 'RUNNING',
        idempotencyKey: `${deploymentId}:${type}:${randomUUID()}`,
        payload,
      })
      .returning();
    return row!.id;
  }

  function postResult(
    app: FastifyInstance,
    jobId: string,
    token: string,
    body: Record<string, unknown>,
  ) {
    return app.inject({
      method: 'POST',
      url: `/api/relay/commands/${jobId}/result`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
  }

  async function loadJob(id: string) {
    const [row] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, id));
    return row!;
  }

  async function loadDeployment(id: string) {
    const [row] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, id));
    return row!;
  }

  /** The events for one job, with per-seed identity and timing noise removed. */
  async function eventsFor(jobId: string): Promise<string> {
    const rows = await db.select().from(schema.eventLogs).where(eq(schema.eventLogs.jobId, jobId));
    return JSON.stringify(
      rows.map(
        ({
          id: _id,
          occurredAt: _occurredAt,
          actorId: _actorId,
          deploymentId: _deploymentId,
          jobId: _jobId,
          ...rest
        }) => rest,
      ),
    );
  }

  async function failureRowCount(jobId: string): Promise<number> {
    const rows = await db
      .select({ id: schema.jevFailureClassifications.id })
      .from(schema.jevFailureClassifications)
      .where(eq(schema.jevFailureClassifications.jobId, jobId));
    return rows.length;
  }

  /** Wait for the detached shadow run to append its telemetry row. */
  async function waitForFailureRow(
    jobId: string,
  ): Promise<typeof schema.jevFailureClassifications.$inferSelect> {
    return vi.waitFor(async () => {
      const rows = await db
        .select()
        .from(schema.jevFailureClassifications)
        .where(eq(schema.jevFailureClassifications.jobId, jobId));
      expect(rows).toHaveLength(1);
      return rows[0]!;
    });
  }

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);

    const email = 'jev-failure-shadow@example.com';
    const password = 'super-secret-1';
    await auth.api.signUpEmail({ body: { email, password, name: 'JevFailure' } });
    const signin = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    const setCookie = signin.headers.get('set-cookie');
    if (!setCookie) throw new Error('no session cookie');

    fixtureClient = createConfidentWrongDomainClient();
    const timeoutClient: JevClient = {
      async evaluate() {
        throw new JevError('timeout', { attempts: 2 });
      },
    };
    appDisabled = await buildServer({ auth, db });
    appEnabled = await buildServer({
      auth,
      db,
      jevFailureShadow: createJevFailureShadowRunner({ db, client: fixtureClient }),
    });
    appTimeout = await buildServer({
      auth,
      db,
      jevFailureShadow: createJevFailureShadowRunner({ db, client: timeoutClient }),
    });

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
        repoFullName: `acme/jfs-${randomUUID().slice(0, 8)}`,
        repoUrl: 'https://github.com/acme/jfs',
        defaultBranch: 'main',
      })
      .returning();
    applicationId = application!.id;

    const [customer] = await db
      .insert(schema.customers)
      .values({ organizationId, name: 'Cust', email: `cust-${randomUUID()}@example.com` })
      .returning();
    customerId = customer!.id;
  }, 120_000);

  afterAll(async () => {
    await appDisabled?.close();
    await appEnabled?.close();
    await appTimeout?.close();
    await client?.close();
  });

  it(
    'a failure that refines to a known code never reaches Jev and stays deterministic',
    async () => {
      const knownBody = {
        success: false,
        error: 'CannotPullContainerError: pull access denied for the repository',
        failureCode: 'UNKNOWN',
      };

      // One shared release pair: both deployments point at v1, both jobs roll
      // v2, so both sides see the same day-2 failure shape (UPDATE_AVAILABLE).
      const v1 = await seedRelease('1.0.0');
      const v2 = await seedRelease('2.0.0');
      const disabled = await seedDeployment({ state: 'UPDATING', currentReleaseId: v1 });
      const disabledJob = await seedJob(disabled.id, 'DEPLOY_RELEASE', { releaseId: v2 });
      const enabled = await seedDeployment({ state: 'UPDATING', currentReleaseId: v1 });
      const enabledJob = await seedJob(enabled.id, 'DEPLOY_RELEASE', { releaseId: v2 });

      const disabledResponse = await postResult(appDisabled, disabledJob, disabled.token, knownBody);
      expect(disabledResponse.statusCode, disabledResponse.body).toBe(200);
      const enabledResponse = await postResult(appEnabled, enabledJob, enabled.token, knownBody);
      expect(enabledResponse.statusCode, enabledResponse.body).toBe(200);

      // Deterministic refinement sharpened UNKNOWN → IMAGE_PULL_FAILED in both.
      const disabledRow = await loadJob(disabledJob);
      const enabledRow = await loadJob(enabledJob);
      expect(disabledRow.failureCode).toBe('IMAGE_PULL_FAILED');
      expect(enabledRow.failureCode).toBe(disabledRow.failureCode);
      expect(enabledRow.state).toBe(disabledRow.state);
      expect(JSON.stringify(enabledRow.result)).toBe(JSON.stringify(disabledRow.result));

      const disabledDeployment = await loadDeployment(disabled.id);
      const enabledDeployment = await loadDeployment(enabled.id);
      expect(enabledDeployment.state).toBe(disabledDeployment.state);
      // The pointer never advances past the last successful release.
      expect(disabledDeployment.currentReleaseId).toBe(v1);
      expect(enabledDeployment.currentReleaseId).toBe(v1);

      expect(await eventsFor(enabledJob)).toBe(await eventsFor(disabledJob));

      expect(await failureRowCount(disabledJob)).toBe(0);
      expect(await failureRowCount(enabledJob)).toBe(0);
      expect(fixtureClient.lastRequest()).toBeUndefined();
    },
    60_000,
  );

  it(
    'an UNKNOWN failure is classified exactly once; a duplicate result adds nothing',
    async () => {
      const current = await seedRelease('3.0.0');
      const deployment = await seedDeployment({ state: 'UPDATING', currentReleaseId: current });
      const jobId = await seedJob(deployment.id, 'RESTART');
      const body = {
        success: false,
        error: 'an unusual internal fault occurred',
        failureCode: 'UNKNOWN',
      };

      const response = await postResult(appEnabled, jobId, deployment.token, body);
      expect(response.statusCode, response.body).toBe(200);

      const job = await loadJob(jobId);
      expect(job.state).toBe('FAILED');
      expect(job.failureCode).toBe('UNKNOWN');
      expect((await loadDeployment(deployment.id)).state).toBe('HEALTHY');

      const row = await waitForFailureRow(jobId);
      expect(row.ok).toBe(true);
      expect(row.errorKind).toBeNull();
      expect(row.deploymentStage).toBe('RESTART');
      expect(row.deployzFailureCode).toBe('UNKNOWN');
      expect(row.evidenceSchemaVersion).toBe(JEV_FAILURE_EVIDENCE_SCHEMA_VERSION);
      expect(row.decisionSetVersion).toBe(JEV_FAILURE_DECISION_SET_VERSION);
      expect(row.model).toBe('jev-test');
      expect(row.inputTokens).toBe(42);
      expect(row.outputTokens).toBe(7);

      const classification = row.classification as {
        failureDomain: string;
        domainConfidence: number;
        domainProbabilities: Record<string, number>;
        likelyTransient: boolean;
        likelyTransientProbability: number;
        recommendedAction: string;
        classificationUnclear: boolean;
      };
      expect(classification.failureDomain).toBe('DEPLOYZ');
      expect(classification.domainConfidence).toBe(0.99);
      expect(classification.domainProbabilities.DEPLOYZ).toBe(0.96);
      expect(classification.likelyTransient).toBe(true);
      expect(classification.likelyTransientProbability).toBe(0.9);
      expect(classification.recommendedAction).toBe('deployz');
      expect(classification.classificationUnclear).toBe(false);

      // Settle-once: the duplicate is acknowledged, changes no state, and
      // never reaches Jev a second time.
      const duplicate = await postResult(appEnabled, jobId, deployment.token, body);
      expect(duplicate.statusCode, duplicate.body).toBe(200);
      expect(duplicate.json()).toEqual({ received: true, alreadySettled: true });
      expect(await failureRowCount(jobId)).toBe(1);
      expect((await loadJob(jobId)).state).toBe('FAILED');
      expect((await loadDeployment(deployment.id)).state).toBe('HEALTHY');
    },
    60_000,
  );

  it(
    'a maximally confident WRONG classification leaves the settled state identical',
    async () => {
      const unknownBody = {
        success: false,
        error: 'an unusual internal fault occurred',
        failureCode: 'UNKNOWN',
      };

      // One shared current release (the newest seeded so far, so no side sees
      // a spurious newer READY release) — a failed day-2 operation returns
      // both deployments to HEALTHY.
      const current = await seedRelease('4.0.0');
      const disabled = await seedDeployment({ state: 'UPDATING', currentReleaseId: current });
      const disabledJob = await seedJob(disabled.id, 'RESTART');
      const enabled = await seedDeployment({ state: 'UPDATING', currentReleaseId: current });
      const enabledJob = await seedJob(enabled.id, 'RESTART');

      const disabledResponse = await postResult(appDisabled, disabledJob, disabled.token, unknownBody);
      expect(disabledResponse.statusCode, disabledResponse.body).toBe(200);
      const enabledResponse = await postResult(appEnabled, enabledJob, enabled.token, unknownBody);
      expect(enabledResponse.statusCode, enabledResponse.body).toBe(200);

      const disabledJobRow = await loadJob(disabledJob);
      const enabledJobRow = await loadJob(enabledJob);
      expect(enabledJobRow.state).toBe(disabledJobRow.state);
      expect(enabledJobRow.failureCode).toBe(disabledJobRow.failureCode);
      expect(JSON.stringify(enabledJobRow.result)).toBe(JSON.stringify(disabledJobRow.result));

      const disabledDeployment = await loadDeployment(disabled.id);
      const enabledDeployment = await loadDeployment(enabled.id);
      expect(enabledDeployment.state).toBe(disabledDeployment.state);
      expect(enabledDeployment.healthStatus).toBe(disabledDeployment.healthStatus);
      expect(enabledDeployment.relayStatus).toBe(disabledDeployment.relayStatus);

      expect(await eventsFor(enabledJob)).toBe(await eventsFor(disabledJob));

      expect(await failureRowCount(disabledJob)).toBe(0);
      expect(await failureRowCount(enabledJob)).toBe(1);
    },
    60_000,
  );

  it(
    'a Jev timeout fails open: row ok=false errorKind timeout, state identical',
    async () => {
      const current = await seedRelease('5.0.0');
      const disabled = await seedDeployment({ state: 'UPDATING', currentReleaseId: current });
      const disabledJob = await seedJob(disabled.id, 'RESTART');
      const timeout = await seedDeployment({ state: 'UPDATING', currentReleaseId: current });
      const timeoutJob = await seedJob(timeout.id, 'RESTART');
      const body = { success: false, error: 'an unusual internal fault occurred', failureCode: 'UNKNOWN' };

      const disabledResponse = await postResult(appDisabled, disabledJob, disabled.token, body);
      expect(disabledResponse.statusCode, disabledResponse.body).toBe(200);
      const timeoutResponse = await postResult(appTimeout, timeoutJob, timeout.token, body);
      expect(timeoutResponse.statusCode, timeoutResponse.body).toBe(200);

      const disabledRow = await loadJob(disabledJob);
      const timeoutRow = await loadJob(timeoutJob);
      expect(timeoutRow.state).toBe(disabledRow.state);
      expect(timeoutRow.failureCode).toBe(disabledRow.failureCode);
      expect((await loadDeployment(timeout.id)).state).toBe((await loadDeployment(disabled.id)).state);

      const row = await waitForFailureRow(timeoutJob);
      expect(row.ok).toBe(false);
      expect(row.errorKind).toBe('timeout');
      expect(row.classification).toBeNull();
    },
    60_000,
  );

  it('a disabled configuration yields the noop runner and writes no row', async () => {
    const params: JevFailureShadowParams = {
      deploymentId: randomUUID(),
      jobId: randomUUID(),
      deploymentStage: 'INSTALL',
      failureReason: 'watchdog test',
      deployzFailureCode: 'UNKNOWN',
    };
    await createJevFailureShadowRunnerFromEnv({ db }, resolveJevConfig({})).run(params);
    await createJevFailureShadowRunner({ db }).run(params);

    const rows = await db
      .select({ id: schema.jevFailureClassifications.id })
      .from(schema.jevFailureClassifications)
      .where(eq(schema.jevFailureClassifications.jobId, params.jobId));
    expect(rows).toHaveLength(0);
  });

  it(
    'a secret-bearing error string never reaches the telemetry row or Jev',
    async () => {
      const deployment = await seedDeployment({ state: 'INSTALLING', currentReleaseId: null });
      const jobId = await seedJob(deployment.id, 'INSTALL');
      const response = await postResult(appEnabled, jobId, deployment.token, {
        success: false,
        error: 'bootstrap failed: postgres://admin:secretpw@db.internal:5432/app unreachable',
        failureCode: 'UNKNOWN',
      });
      expect(response.statusCode, response.body).toBe(200);
      expect((await loadJob(jobId)).failureCode).toBe('UNKNOWN');

      const row = await waitForFailureRow(jobId);
      expect(row.ok).toBe(true);
      expect(row.deploymentStage).toBe('INSTALL');
      const rowJson = JSON.stringify(row);
      expect(rowJson).not.toContain('secretpw');
      expect(rowJson).not.toContain('postgres://admin:');

      const state = fixtureClient.lastRequest()?.state as unknown as {
        failureEvidence: { failureReason: string; deployzFailureCode: string };
      };
      expect(state.failureEvidence.failureReason).toContain('[REDACTED]');
      expect(state.failureEvidence.failureReason).not.toContain('secretpw');
      expect(state.failureEvidence.deployzFailureCode).toBe('UNKNOWN');
    },
    60_000,
  );
});
