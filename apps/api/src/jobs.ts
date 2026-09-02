import { and, eq, gt } from 'drizzle-orm';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { ApiError } from './errors.js';

// §39 deployment-job creation, shared by the API routes and the worker
// Lambda — both create jobs the relay picks up, and both must go through
// the same idempotency path.

/** Postgres unique-violation (23505), wherever drizzle/pg nested it. */
function isUniqueViolation(error: unknown): boolean {
  for (let cause: unknown = error; cause; cause = (cause as { cause?: unknown }).cause) {
    if ((cause as { code?: string }).code === '23505') return true;
  }
  return error instanceof Error && /unique|duplicate key/i.test(error.message);
}

/**
 * §39 idempotency: unique-constraint-violation-as-signal. A retry (same
 * derived or client-supplied key) must return the job that already exists,
 * never create a second one and never 500.
 *
 * Two unique constraints can fire here: the idempotency key (a replay — hand
 * back the existing row) and deployment_jobs_one_active_mutating_uidx (a
 * DIFFERENT mutating job is already active on this deployment — the racing
 * request that got past the route-level idle check loses here, with the same
 * DEPLOYMENT_BUSY answer it would have gotten from the check). Postgres does
 * not guarantee which constraint reports first when both are violated, so the
 * catch always re-checks the key before concluding "busy".
 */
export async function createOrReuseJob(
  db: RuntimeDb,
  params: {
    deploymentId: string;
    type: (typeof schema.deploymentJobs.$inferInsert)['type'];
    idempotencyKey: string;
    payload: Record<string, unknown>;
    requestedBy: string | null;
  },
): Promise<{ job: typeof schema.deploymentJobs.$inferSelect; created: boolean }> {
  let inserted: (typeof schema.deploymentJobs.$inferSelect)[];
  try {
    inserted = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: params.deploymentId,
        type: params.type,
        state: 'REQUESTED',
        idempotencyKey: params.idempotencyKey,
        payload: params.payload,
        requestedBy: params.requestedBy,
      })
      .onConflictDoNothing({ target: schema.deploymentJobs.idempotencyKey })
      .returning();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    inserted = [];
  }

  if (inserted.length > 0) {
    return { job: inserted[0]!, created: true };
  }

  // Conflict: the idempotency key already exists — return the existing job
  // (200) rather than manufacturing a duplicate or 500ing on the constraint.
  const existing = await db
    .select()
    .from(schema.deploymentJobs)
    .where(eq(schema.deploymentJobs.idempotencyKey, params.idempotencyKey))
    .limit(1);
  if (existing.length === 0) {
    // No row under this key: the violation came from the one-active-job
    // index — another mutating operation won the race.
    throw new ApiError(
      409,
      'DEPLOYMENT_BUSY',
      'Another deployment operation is already in progress.',
    );
  }
  return { job: existing[0]!, created: false };
}

/**
 * Whether a READY release newer than the deployment's current release
 * exists — the exact condition under which a live deployment is
 * UPDATE_AVAILABLE rather than HEALTHY (§46). Shared by the relay result
 * route and the stuck-job watchdog to settle failed day-2 operations.
 */
export async function newerReadyReleaseExists(
  db: RuntimeDb,
  applicationId: string,
  currentReleaseId: string | null,
): Promise<boolean> {
  if (currentReleaseId === null) return false;
  const current = await db
    .select({ createdAt: schema.releases.createdAt })
    .from(schema.releases)
    .where(eq(schema.releases.id, currentReleaseId))
    .limit(1);
  if (current.length === 0) return false;
  const newer = await db
    .select({ id: schema.releases.id })
    .from(schema.releases)
    .where(
      and(
        eq(schema.releases.applicationId, applicationId),
        eq(schema.releases.releaseStatus, 'READY'),
        gt(schema.releases.createdAt, current[0]!.createdAt),
      ),
    )
    .limit(1);
  return newer.length > 0;
}
