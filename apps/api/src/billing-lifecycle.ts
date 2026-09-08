import { and, eq } from 'drizzle-orm';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { applyBillingTransition, type BillingSnapshot } from './billing-domain.js';
import { recordEvent, type EventWriter } from './events.js';

// Idempotent DB helpers for the two billing transitions the deployment
// lifecycle hooks into (docs/billing/MIGRATION_PROGRESS.md rulings R0-1/
// R0-2). Each computes the pure domain patch, applies it with a WHERE guard
// on the expected previous billing_state (so two concurrent writers can
// never both apply it), and records the matching event. A no-op transition
// (TEST deployment, already applied, terminal STOPPED, or a guard miss)
// writes nothing and returns false.

/** The db or an open transaction — same shape recordEvent already accepts. */
type BillingWriter = Pick<RuntimeDb, 'update'> & EventWriter;

/** The subset of a deployment row the billing writes need. */
export interface BillableDeployment extends BillingSnapshot {
  id: string;
  organizationId: string;
  customerId: string;
  installationId: string | null;
}

async function applyBillingWrite(
  db: BillingWriter,
  deployment: BillableDeployment,
  event: 'LIVE' | 'REMOVED',
  now: Date,
  eventType: 'deployment.billing_started' | 'deployment.billing_stopped',
  actorType: 'user' | 'relay' | 'system',
  actorId: string,
): Promise<boolean> {
  const patch = applyBillingTransition(deployment, event, now);
  if (patch === null) return false;

  const updated = await db
    .update(schema.deployments)
    .set(patch)
    .where(
      and(
        eq(schema.deployments.id, deployment.id),
        eq(schema.deployments.billingState, deployment.billingState),
      ),
    )
    .returning();
  // The WHERE guard missed: a concurrent writer already applied this exact
  // transition. Nothing left to record.
  if (updated.length === 0) return false;

  await recordEvent(db, {
    organizationId: deployment.organizationId,
    eventType,
    actorType,
    actorId,
    deploymentId: deployment.id,
    customerId: deployment.customerId,
    payload: { deploymentType: deployment.deploymentType, billingState: patch.billingState },
  });
  return true;
}

/**
 * The deployment reached its first verified READY stage — called from
 * `advanceStepTimingsAfterWrite`, itself only ever invoked from the relay-
 * authenticated write paths (heartbeat, job-result). `actor` defaults to
 * `relay`, which matches every other event those call sites record (e.g.
 * `deployment.reconciled`); the Phase 10 safety job overrides it, because a
 * promotion it makes was not the relay's doing.
 */
export function markDeploymentLive(
  db: BillingWriter,
  deployment: BillableDeployment,
  now: Date,
  actor: { actorType: 'user' | 'relay' | 'system'; actorId: string } = {
    actorType: 'relay',
    actorId: deployment.installationId ?? deployment.id,
  },
): Promise<boolean> {
  return applyBillingWrite(
    db,
    deployment,
    'LIVE',
    now,
    'deployment.billing_started',
    actor.actorType,
    actor.actorId,
  );
}

/**
 * A removal was accepted — called from the destroy route's accepted-removal
 * and immediate-DELETED paths, the DESTROY job SUCCEEDED handler, and the
 * force-complete backstop. `actor` defaults to the vendor action every one
 * of those sites otherwise records; the DESTROY job SUCCEEDED handler (a
 * relay-reported result) overrides it.
 */
export function markDeploymentRemoved(
  db: BillingWriter,
  deployment: BillableDeployment,
  now: Date,
  actor: { actorType: 'user' | 'relay' | 'system'; actorId: string } = {
    actorType: 'user',
    actorId: 'system',
  },
): Promise<boolean> {
  return applyBillingWrite(
    db,
    deployment,
    'REMOVED',
    now,
    'deployment.billing_stopped',
    actor.actorType,
    actor.actorId,
  );
}
