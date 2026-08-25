import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AiGatewayNotAvailableError, type AiGateway } from '@deployz/analysis';
import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { resolveExplanation, type ExplanationDeps } from './ai-explanation.js';

// ==========================================================================
// Gateways
// ==========================================================================

const modelText = { failureCode: 'PORT_MISMATCH', what: 'AI what', why: 'AI why', fix: 'AI fix' };

/** Records how many times the model was actually invoked. */
function countingGateway(calls: { n: number }, delayMs = 0): AiGateway {
  return {
    async generate() {
      calls.n += 1;
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return { object: modelText, usage: { promptTokens: 20, completionTokens: 10 } };
    },
  };
}

function throwingGateway(calls: { n: number }, error: Error): AiGateway {
  return {
    async generate() {
      calls.n += 1;
      throw error;
    },
  };
}

/** Never settles unless aborted — stands in for a hung gateway. */
function hangingGateway(calls: { n: number }): AiGateway {
  return {
    generate(_prompt, _schema, options) {
      calls.n += 1;
      return new Promise((_resolve, reject) => {
        const signal = options?.abortSignal;
        if (!signal) return;
        const abort = (): void => reject(new Error('aborted'));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort);
      });
    },
  };
}

// ==========================================================================
// Fixtures
// ==========================================================================

const event = { source: 'ecs', action: 'deploy', signal: 'target-health' } as const;

describe('resolveExplanation', () => {
  let client: PGlite | undefined;
  let db: Db;
  let deploymentId: string;
  let jobId: string;
  let calls: { n: number };

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);

    const organizationId = 'org_explain';
    const applicationId = crypto.randomUUID();
    const customerId = crypto.randomUUID();
    await db
      .insert(schema.organization)
      .values({ id: organizationId, name: 'Acme Corp', slug: 'acme' });
    await db.insert(schema.applications).values({
      id: applicationId,
      organizationId,
      name: 'shop',
      repoFullName: 'acme/shop',
      repoUrl: 'https://github.com/acme/shop',
    });
    await db.insert(schema.customers).values({
      id: customerId,
      organizationId,
      name: 'Buyer',
      email: 'buyer@example.com',
    });

    deploymentId = crypto.randomUUID();
    await db.insert(schema.deployments).values({
      id: deploymentId,
      customerId,
      applicationId,
      organizationId,
      region: 'us-east-1',
      installationId: 'inst-explain',
    });
  });

  afterAll(async () => {
    await client?.close();
  });

  beforeEach(async () => {
    calls = { n: 0 };
    jobId = crypto.randomUUID();
    await db.insert(schema.deploymentJobs).values({
      id: jobId,
      deploymentId,
      type: 'DEPLOY_RELEASE',
      idempotencyKey: `job-${jobId}`,
      state: 'FAILED',
      failureCode: 'PORT_MISMATCH',
    });
  });

  function deps(gateway: AiGateway, overrides: Partial<ExplanationDeps> = {}): ExplanationDeps {
    return { db, gateway, ...overrides };
  }

  async function readJob(): Promise<typeof schema.deploymentJobs.$inferSelect> {
    const [row] = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.id, jobId));
    return row!;
  }

  // ── Happy path ──────────────────────────────────────────────────────────

  it('generates and returns AI text on the first request', async () => {
    const text = await resolveExplanation(deps(countingGateway(calls)), {
      jobId,
      failureCode: 'PORT_MISMATCH',
      event,
    });

    expect(text).toEqual({ what: 'AI what', why: 'AI why', fix: 'AI fix' });
    expect(calls.n).toBe(1);
  });

  it('persists the generated text as READY', async () => {
    await resolveExplanation(deps(countingGateway(calls)), {
      jobId,
      failureCode: 'PORT_MISMATCH',
      event,
    });

    const row = await readJob();
    expect(row.aiExplanationState).toBe('READY');
    expect(row.aiExplanationWhat).toBe('AI what');
    expect(row.aiExplanationGeneratedAt).toBeInstanceOf(Date);
  });

  it('serves a cached explanation without calling the model again', async () => {
    await resolveExplanation(deps(countingGateway(calls)), {
      jobId,
      failureCode: 'PORT_MISMATCH',
      event,
    });

    const second = await resolveExplanation(deps(countingGateway(calls)), {
      jobId,
      failureCode: 'PORT_MISMATCH',
      event,
    });

    expect(second).toEqual({ what: 'AI what', why: 'AI why', fix: 'AI fix' });
    expect(calls.n).toBe(1);
  });

  // ── Single-flight ───────────────────────────────────────────────────────

  it('invokes the model at most once for concurrent requests', async () => {
    const gateway = countingGateway(calls, 50);

    const results = await Promise.all([
      resolveExplanation(deps(gateway), { jobId, failureCode: 'PORT_MISMATCH', event }),
      resolveExplanation(deps(gateway), { jobId, failureCode: 'PORT_MISMATCH', event }),
      resolveExplanation(deps(gateway), { jobId, failureCode: 'PORT_MISMATCH', event }),
    ]);

    expect(calls.n).toBe(1);
    // Every caller still gets usable text — the losers fall back to deterministic guidance.
    for (const text of results) {
      expect(text.what.length).toBeGreaterThan(0);
      expect(text.fix.length).toBeGreaterThan(0);
    }
  });

  it('does not call the model while another request holds a fresh claim', async () => {
    await db
      .update(schema.deploymentJobs)
      .set({ aiExplanationState: 'GENERATING', aiExplanationClaimedAt: new Date() })
      .where(eq(schema.deploymentJobs.id, jobId));

    await resolveExplanation(deps(countingGateway(calls)), {
      jobId,
      failureCode: 'PORT_MISMATCH',
      event,
    });

    expect(calls.n).toBe(0);
  });

  it('reclaims a stale GENERATING row orphaned by a dead process', async () => {
    await db
      .update(schema.deploymentJobs)
      .set({
        aiExplanationState: 'GENERATING',
        aiExplanationClaimedAt: new Date(Date.now() - 60 * 60 * 1000),
      })
      .where(eq(schema.deploymentJobs.id, jobId));

    const text = await resolveExplanation(
      deps(countingGateway(calls), { staleClaimMs: 5 * 60 * 1000 }),
      { jobId, failureCode: 'PORT_MISMATCH', event },
    );

    expect(calls.n).toBe(1);
    expect(text.what).toBe('AI what');
  });

  // ── Degradation ─────────────────────────────────────────────────────────

  it('falls back to deterministic remediation when the gateway is unconfigured', async () => {
    const text = await resolveExplanation(
      deps(throwingGateway(calls, new AiGatewayNotAvailableError('none'))),
      { jobId, failureCode: 'PORT_MISMATCH', event },
    );

    // PORT_MISMATCH remediation, not the model's words and not a placeholder.
    expect(text.what).toContain('port');
    expect(text.fix.length).toBeGreaterThan(0);
  });

  it('marks the row FAILED after a gateway error', async () => {
    await resolveExplanation(deps(throwingGateway(calls, new Error('gateway 500'))), {
      jobId,
      failureCode: 'PORT_MISMATCH',
      event,
    });

    expect((await readJob()).aiExplanationState).toBe('FAILED');
  });

  it('never changes the job or deployment state when generation fails', async () => {
    await resolveExplanation(deps(throwingGateway(calls, new Error('gateway 500'))), {
      jobId,
      failureCode: 'PORT_MISMATCH',
      event,
    });

    const [deployment] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deploymentId));
    expect((await readJob()).state).toBe('FAILED');
    expect(deployment?.state).toBe('NOT_INSTALLED');
  });

  it('retries generation on a later request after a failure', async () => {
    await resolveExplanation(deps(throwingGateway(calls, new Error('gateway 500'))), {
      jobId,
      failureCode: 'PORT_MISMATCH',
      event,
    });

    const retryCalls = { n: 0 };
    const text = await resolveExplanation(deps(countingGateway(retryCalls)), {
      jobId,
      failureCode: 'PORT_MISMATCH',
      event,
    });

    expect(retryCalls.n).toBe(1);
    expect(text.what).toBe('AI what');
    expect((await readJob()).aiExplanationState).toBe('READY');
  });

  it('gives up on a hung gateway and returns deterministic text', async () => {
    const text = await resolveExplanation(
      deps(hangingGateway(calls), { timeoutMs: 50 }),
      { jobId, failureCode: 'PORT_MISMATCH', event },
    );

    expect(text.what).toContain('port');
    expect((await readJob()).aiExplanationState).toBe('FAILED');
  });

  it('rejects model output that does not match the strict schema', async () => {
    const badGateway: AiGateway = {
      async generate() {
        calls.n += 1;
        return {
          object: { failureCode: 'PORT_MISMATCH', what: 'w', why: 'y' },
          usage: { promptTokens: 10, completionTokens: 5 },
        };
      },
    };

    const text = await resolveExplanation(deps(badGateway), {
      jobId,
      failureCode: 'PORT_MISMATCH',
      event,
    });

    expect(text.what).toContain('port');
    expect((await readJob()).aiExplanationState).toBe('FAILED');
  });
});
