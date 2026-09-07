import type { DeploymentBillingState, DeploymentType } from '@deployz/contracts';

// Billing domain rules (Paddle migration Phase 2) — pure functions that
// decide whether, and when, a deployment becomes billable. Deployz displays
// prices but does no money math; the billing provider is the source of
// truth for charges and invoices. Provider-independent on purpose: nothing
// here names Paddle.

export const PLATFORM_PRICE_DOLLARS = 49; // base platform price, display only
export const DEPLOYMENT_PRICE_DOLLARS = 19; // price per billable deployment, display only

// ── Billing state machine ────────────────────────────────────────────────

/** The two lifecycle facts the billing state machine reacts to. */
export type BillingEvent = 'LIVE' | 'REMOVED';

/** The subset of a deployment row the billing rules need. */
export interface BillingSnapshot {
  deploymentType: DeploymentType;
  billingState: DeploymentBillingState;
}

/** The patch to persist for a transition — `null` means no change at all. */
export interface BillingPatch {
  billingState: DeploymentBillingState;
  billingStartedAt?: Date;
  billingStoppedAt?: Date;
}

/**
 * Applies one billing event to a deployment's current billing snapshot.
 * Deliberately does NOT take `state` (§46 health/lifecycle) as an input —
 * that absence is the structural guarantee that no health, rollback, or
 * recovery signal can ever move the billing state. Only two events exist:
 *
 *   - LIVE:    the deployment reached its first verified READY stage.
 *   - REMOVED: a removal was accepted (destroy requested, or a destroy/
 *              force-complete backstop).
 *
 * Rules:
 *   1. TEST deployments never become billable — every event returns null.
 *   2. PRODUCTION + NOT_STARTED + LIVE -> ACTIVE, billingStartedAt = now.
 *   3. ACTIVE + LIVE is a no-op (timestamps are write-once).
 *   4. PRODUCTION + not STOPPED + REMOVED -> STOPPED, billingStoppedAt = now
 *      (a never-live production deployment also stops, so it can never
 *      activate later).
 *   5. STOPPED is terminal — every event returns null.
 */
export function applyBillingTransition(
  deployment: BillingSnapshot,
  event: BillingEvent,
  now: Date,
): BillingPatch | null {
  if (deployment.deploymentType === 'TEST') return null;
  if (deployment.billingState === 'STOPPED') return null;

  if (event === 'LIVE') {
    if (deployment.billingState !== 'NOT_STARTED') return null;
    return { billingState: 'ACTIVE', billingStartedAt: now };
  }

  // event === 'REMOVED'
  return { billingState: 'STOPPED', billingStoppedAt: now };
}

/** True only for a PRODUCTION deployment whose billing is ACTIVE. */
export function isBillableDeployment(deployment: BillingSnapshot): boolean {
  return deployment.deploymentType === 'PRODUCTION' && deployment.billingState === 'ACTIVE';
}

/** Number of billable rows (Phase 9 reconciliation reads this). */
export function countBillableDeployments(rows: readonly BillingSnapshot[]): number {
  return rows.filter(isBillableDeployment).length;
}
