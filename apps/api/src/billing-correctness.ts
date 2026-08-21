// §48 billing correctness assertions — pure functions that enforce the
// metered-billing rules. These are the guardrails that prevent double-billing,
// re-billing on transient failures, and billing for deleted deployments.
//
// Rules (from the plan):
//   1. Billable == HEALTHY and NOT a test deployment (§7 exemption).
//   2. Updates/releases don't re-bill — a deployment that was already HEALTHY
//      and stays HEALTHY through an update does NOT trigger a new billing cycle.
//   3. Billing stops on delete — DELETING or DELETED deployments are removed.
//   4. Failed/transient updates never re-bill — FAILED or DISCONNECTED
//      deployments stop billing.
//   5. U8 day-proration: ONE daily usage record per deployment with qty=1,
//      day-prorated at $19/30 per day (or $19/31, $19/28 depending on month).
//
// These functions are PURE — they take deployment state snapshots and return
// boolean decisions. The caller (reportUsageForDate in billing.ts) already
// implements the U8 shape; these functions add the correctness assertions
// that prevent the $570/month trap and other billing errors.

import { isBillable, BASE_PRICE_CENTS, METERED_PRICE_CENTS } from './billing.js';

// Re-export the constants so callers can import everything from one module.
export { BASE_PRICE_CENTS, METERED_PRICE_CENTS };

// ── Deployment state snapshot (subset of the full deployment row) ───────────

export interface DeploymentBillingState {
  state: string;
  isTestDeployment: boolean;
}

// ── §48 correctness assertions ──────────────────────────────────────────────

/**
 * Returns true ONLY when the deployment is HEALTHY and NOT a test deployment.
 * This is the canonical billing gate — wraps the existing isBillable from
 * billing.ts so all correctness logic flows through one function.
 */
export function shouldBillForDeployment(deployment: DeploymentBillingState): boolean {
  return isBillable(deployment);
}

/**
 * Returns true when the deployment was already HEALTHY and is still HEALTHY
 * after an update — meaning the update did NOT change the billing state.
 * Updates and releases don't re-bill; the deployment was already being billed
 * and continues to be billed at the same rate.
 */
export function shouldSkipBillingForUpdate(
  deployment: DeploymentBillingState,
  previousState: string,
): boolean {
  return previousState === 'HEALTHY' && deployment.state === 'HEALTHY';
}

/**
 * Returns true when the deployment is being deleted or has been deleted.
 * Billing stops on delete — the deployment is no longer live.
 */
export function shouldStopBillingForDelete(deployment: DeploymentBillingState): boolean {
  return deployment.state === 'DELETING' || deployment.state === 'DELETED';
}

/**
 * Returns true when the deployment is in a failed or disconnected state.
 * Failed and transient updates never re-bill — the deployment is not healthy
 * and should not accrue metered charges.
 */
export function shouldStopBillingForFailure(deployment: DeploymentBillingState): boolean {
  return deployment.state === 'FAILED' || deployment.state === 'DISCONNECTED';
}

// ── U8 day-proration calculation ────────────────────────────────────────────

/**
 * Returns the daily prorated amount in cents for the metered $19/month price.
 * U8: ONE daily usage record per deployment with qty=1, day-prorated at
 * $19 divided by the number of days in the billing month.
 *
 * Examples:
 *   - 30-day month: 1900 / 30 = 63 cents/day (truncated)
 *   - 31-day month: 1900 / 31 = 61 cents/day
 *   - 28-day month: 1900 / 28 = 67 cents/day
 */
export function calculateDailyProration(daysInMonth: number): number {
  if (daysInMonth <= 0) {
    return 0;
  }
  return Math.floor(METERED_PRICE_CENTS / daysInMonth);
}

/**
 * Returns the expected invoice total in cents for a billing period.
 *
 * Full month: $49 base + $19 metered = $68 = 6800 cents.
 * Mid-month delete: $49 base + prorated metered (billableDays × dailyRate).
 *
 * @param baseCents — the base subscription price in cents (default: BASE_PRICE_CENTS)
 * @param meteredCents — the metered price per deployment-month in cents (default: METERED_PRICE_CENTS)
 * @param billableDays — number of days the deployment was billable in the period
 * @param daysInMonth — total days in the billing month
 */
export function calculateInvoiceTotal(
  baseCents: number = BASE_PRICE_CENTS,
  meteredCents: number = METERED_PRICE_CENTS,
  billableDays: number,
  daysInMonth: number,
): number {
  if (billableDays <= 0 || daysInMonth <= 0) {
    return baseCents;
  }
  const dailyRate = Math.floor(meteredCents / daysInMonth);
  return baseCents + dailyRate * billableDays;
}

// ── Convenience: full correctness check for a deployment ────────────────────

export interface BillingDecision {
  /** Whether the deployment should be billed right now. */
  bill: boolean;
  /** Human-readable reason for the decision. */
  reason: string;
}

/**
 * Returns a billing decision for a deployment given its current and previous
 * state. This is the single entry point for correctness checks — callers
 * should use this instead of composing the individual functions.
 */
export function decideBilling(
  deployment: DeploymentBillingState,
  previousState: string | null,
): BillingDecision {
  // §7: test deployments are never billed.
  if (deployment.isTestDeployment) {
    return { bill: false, reason: '§7 exemption: test deployment is never billed' };
  }

  // Delete stops billing.
  if (shouldStopBillingForDelete(deployment)) {
    return { bill: false, reason: `billing stopped: deployment is ${deployment.state}` };
  }

  // Failure stops billing.
  if (shouldStopBillingForFailure(deployment)) {
    return { bill: false, reason: `billing stopped: deployment is ${deployment.state}` };
  }

  // Updates that don't change billing state don't re-bill.
  if (previousState !== null && shouldSkipBillingForUpdate(deployment, previousState)) {
    return { bill: true, reason: 'already billing (no state change)' };
  }

  // The canonical gate.
  if (shouldBillForDeployment(deployment)) {
    return { bill: true, reason: 'HEALTHY deployment — billing active' };
  }

  return { bill: false, reason: `not billable: state is ${deployment.state}` };
}