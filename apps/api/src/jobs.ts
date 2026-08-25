import { eq } from 'drizzle-orm';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { ApiError } from './errors.js';

// §39 deployment-job creation, shared by the API routes and the worker
// Lambda — both create jobs the relay picks up, and both must go through
// the same idempotency path.

/**
 * §39 idempotency: unique-constraint-violation-as-signal. A retry (same
 * derived or client-supplied key) must return the job that already exists,
 * never create a second one and never 500.
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
  const inserted = await db
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
    // Should be unreachable (we just conflicted on this exact key), but keep
    // the error path honest rather than asserting.
    throw new ApiError(500, 'INTERNAL_ERROR', 'Failed to create or locate the job');
  }
  return { job: existing[0]!, created: false };
}
