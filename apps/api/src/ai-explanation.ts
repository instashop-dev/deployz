import { and, eq, inArray, lt, or } from 'drizzle-orm';

import {
  DEFAULT_TIMEOUT_MS,
  explainDiagnostic,
  type AiGateway,
  type FailureCode,
  type StructuredEvent,
} from '@deployz/analysis';
import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

// §16/§29 AI explanation cache — the lazy, single-flight layer between the
// diagnostics route and the model.
//
// Three properties this module exists to guarantee:
//
//   1. Deployment execution NEVER depends on AI. Nothing here writes deployment
//      or job state; a failed explanation is recorded only in its own columns.
//   2. At most ONE model invocation per attempt. Concurrent requests race for
//      an atomic claim; the losers fall back to deterministic text rather than
//      queueing behind the winner or spending a second call.
//   3. It ALWAYS returns usable text. Every failure path degrades to the
//      caller-supplied deterministic copy (the §65 copy map), so the
//      diagnostics page never shows an error where an explanation belongs.
//
// The explanation is cached on the ATTEMPT (the job row), not the deployment:
// a later attempt of the same deployment gets its own explanation instead of
// inheriting a stale one.

/** The plain-English what/why/fix shown on the diagnostics page. */
export interface ExplanationText {
  what: string;
  why: string;
  fix: string;
}

/** Collaborators for `resolveExplanation`. */
export interface ExplanationDeps {
  db: RuntimeDb;
  /** The gateway seam. Unconfigured gateways throw and degrade gracefully. */
  gateway: AiGateway;
  /** Hard bound on one generation. Defaults to `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number | undefined;
  /** After this long, a GENERATING claim is treated as orphaned and reclaimed. */
  staleClaimMs?: number | undefined;
}

/** Which attempt to explain, and the deterministic inputs to explain it from. */
export interface ExplanationTarget {
  jobId: string;
  failureCode: FailureCode;
  event: StructuredEvent;
}

/**
 * How long a `GENERATING` claim is honoured before another request may take it
 * over. Bounds the damage from a process that died mid-generation, which would
 * otherwise pin the attempt in `GENERATING` forever.
 */
const DEFAULT_STALE_CLAIM_MS = 5 * 60 * 1000;

/**
 * Return the plain-English explanation for a failed attempt, generating it
 * once and serving it from the database thereafter.
 *
 * `fallback` is returned unchanged on every path where AI text is unavailable
 * — unconfigured gateway, gateway error, timeout, schema violation, or another
 * request already generating. The caller supplies it (from the §65 copy map)
 * rather than this module deriving a second source of the same copy.
 *
 * Never throws and never writes deployment or job state.
 */
export async function resolveExplanation(
  deps: ExplanationDeps,
  target: ExplanationTarget,
  fallback: ExplanationText,
): Promise<ExplanationText> {
  const { db, gateway } = deps;
  const { jobId, failureCode, event } = target;

  const cached = await readCached(db, jobId);
  if (cached) return cached;

  // Atomic claim. Exactly one concurrent request wins; the rest get zero rows
  // back and serve deterministic text rather than spending a second call.
  const staleCutoff = new Date(Date.now() - (deps.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS));
  const claimed = await db
    .update(schema.deploymentJobs)
    .set({ aiExplanationState: 'GENERATING', aiExplanationClaimedAt: new Date() })
    .where(
      and(
        eq(schema.deploymentJobs.id, jobId),
        or(
          inArray(schema.deploymentJobs.aiExplanationState, ['PENDING', 'FAILED']),
          and(
            eq(schema.deploymentJobs.aiExplanationState, 'GENERATING'),
            lt(schema.deploymentJobs.aiExplanationClaimedAt, staleCutoff),
          ),
        ),
      ),
    )
    // Bare `.returning()` because RuntimeDb is a union of two driver types and
    // the projected overload does not survive the union (every other call site
    // in apps/api does the same).
    .returning();

  if (claimed.length === 0) return fallback;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const explanation = await explainDiagnostic(failureCode, event, gateway, {
      abortSignal: controller.signal,
    });
    const text: ExplanationText = {
      what: explanation.what,
      why: explanation.why,
      fix: explanation.fix,
    };
    await db
      .update(schema.deploymentJobs)
      .set({
        aiExplanationState: 'READY',
        aiExplanationWhat: text.what,
        aiExplanationWhy: text.why,
        aiExplanationFix: text.fix,
        aiExplanationGeneratedAt: new Date(),
      })
      .where(eq(schema.deploymentJobs.id, jobId));
    return text;
  } catch {
    // Every failure mode lands here — unconfigured gateway, network error,
    // timeout, spend limit, schema violation. FAILED is retryable, so a later
    // diagnostics request tries again.
    await db
      .update(schema.deploymentJobs)
      .set({ aiExplanationState: 'FAILED' })
      .where(eq(schema.deploymentJobs.id, jobId));
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a completed explanation, or `undefined` when this attempt has none yet.
 *
 * Requires all three fields: a row marked READY with a missing field is
 * treated as absent rather than rendered with holes in it.
 */
async function readCached(
  db: RuntimeDb,
  jobId: string,
): Promise<ExplanationText | undefined> {
  const [row] = await db
    .select({
      state: schema.deploymentJobs.aiExplanationState,
      what: schema.deploymentJobs.aiExplanationWhat,
      why: schema.deploymentJobs.aiExplanationWhy,
      fix: schema.deploymentJobs.aiExplanationFix,
    })
    .from(schema.deploymentJobs)
    .where(eq(schema.deploymentJobs.id, jobId))
    .limit(1);

  if (!row || row.state !== 'READY') return undefined;
  if (row.what === null || row.why === null || row.fix === null) return undefined;
  return { what: row.what, why: row.why, fix: row.fix };
}
