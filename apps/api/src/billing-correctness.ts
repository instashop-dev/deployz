// §48 billing correctness assertions — pure functions that enforce the
// metered-billing rules. These are the guardrails that prevent double-billing,
// re-billing on transient failures, and billing for deleted deployments.
//
// Rules (from §48):
//   1. Billable == HEALTHY or UPDATE_AVAILABLE (both are live serving states
//      per §46 — a deployment moves to UPDATE_AVAILABLE simply because the
//      vendor published a newer release, so it must stay billable) and NOT a
//      test deployment (§7 exemption).
//   2. Updates/releases don't re-bill — a deployment that was already
//      billable and stays billable through an update does NOT trigger a new
//      billing cycle ("v1.0 → v1.1 → v1.2 remains ONE $19/month deployment").
//   3. Billing stops on delete — DELETING or DELETED deployments are removed
//      from future billing (past charges are untouched — usage_records are
//      never retracted).
//   4. Temporary failed updates do not affect billing — a deployment that was
//      already being billed keeps billing straight through a transient
//      UPDATING/FAILED/DISCONNECTED blip (e.g. HEALTHY → UPDATING → FAILED →
//      HEALTHY bills every day of that run). Only delete (rule 3) or never
//      having become billable in the first place stops billing.
//   5. U8 day-proration: ONE daily usage record per deployment with qty=1,
//      day-prorated at $19/30 per day (or $19/31, $19/28 depending on month).
//
// These functions are PURE — they take deployment state snapshots and return
// boolean decisions. decideBilling is the single source of truth for "is this
// deployment billable today" — reportUsageForDate in billing.ts calls it
// directly rather than re-deriving the rule from the raw state.

// This module has NO dependency on billing.ts (billing.ts depends on THIS
// module for decideBilling, so the price constants and the canonical
// billable predicate live here to avoid a circular import).
export const BASE_PRICE_CENTS = 4900; // $49/month base
export const METERED_PRICE_CENTS = 1900; // $19 per billable deployment-month

// ── Deployment state snapshot (subset of the full deployment row) ───────────

export interface DeploymentBillingState {
  state: string;
  isTestDeployment: boolean;
}

// ── §48 correctness assertions ──────────────────────────────────────────────

/**
 * Returns true ONLY when the deployment is HEALTHY or UPDATE_AVAILABLE (both
 * are live serving states per §46 — UPDATE_AVAILABLE just means a newer
 * release exists, per §48 "creating multiple releases does not affect
 * billing") and NOT a test deployment (§7 exemption). This is the canonical
 * billing gate — billing.ts's isBillable delegates to this function so all
 * correctness logic flows through one rule.
 */
export function shouldBillForDeployment(deployment: DeploymentBillingState): boolean {
  return (
    (deployment.state === 'HEALTHY' || deployment.state === 'UPDATE_AVAILABLE') &&
    !deployment.isTestDeployment
  );
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
 * Returns true when the deployment is in a failed or disconnected state —
 * i.e. NOT directly billable on its own state per rule 1. This does NOT by
 * itself mean billing stops: per §48 "temporary failed updates do not affect
 * billing", decideBilling still bills through this state when the deployment
 * was already being billed (see the `wasBillingPreviously` parameter).
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
 * Returns a billing decision for a deployment given its current state and
 * whether it was already being billed as of the immediately preceding
 * billing day (`wasBillingPreviously` — in production this is derived from
 * whether a usage_records row exists for the previous date; see
 * reportUsageForDate in billing.ts). This is the single entry point for
 * correctness checks — callers should use this instead of re-deriving the
 * rule from the raw state, and instead of composing the individual
 * predicates below.
 */
export function decideBilling(
  deployment: DeploymentBillingState,
  wasBillingPreviously: boolean,
): BillingDecision {
  // §7: test deployments are never billed.
  if (deployment.isTestDeployment) {
    return { bill: false, reason: '§7 exemption: test deployment is never billed' };
  }

  // Delete is the one unconditional stop: it always ends billing, even if
  // the deployment was mid-way through a run of billed days.
  if (shouldStopBillingForDelete(deployment)) {
    return { bill: false, reason: `billing stopped: deployment is ${deployment.state}` };
  }

  // The canonical gate: HEALTHY or UPDATE_AVAILABLE is billable on its own
  // merits — a fresh deployment becoming billable, or one that never
  // stopped, both land here.
  if (shouldBillForDeployment(deployment)) {
    if (wasBillingPreviously) {
      return { bill: true, reason: 'already billing (no interruption — releases/updates do not re-bill)' };
    }
    return { bill: true, reason: `${deployment.state} deployment — billing active` };
  }

  // Not directly billable right now (e.g. UPDATING, FAILED, DISCONNECTED).
  // §48: "temporary failed updates do not affect billing" — if the
  // deployment was already being billed, a transient dip does not interrupt
  // it. This is what keeps a HEALTHY -> UPDATING -> FAILED -> HEALTHY run
  // billing every day, including the FAILED day(s).
  if (wasBillingPreviously) {
    return {
      bill: true,
      reason: `billing continues through transient state ${deployment.state} (§48: temporary failures do not affect billing)`,
    };
  }

  return { bill: false, reason: `not billable: state is ${deployment.state}` };
}