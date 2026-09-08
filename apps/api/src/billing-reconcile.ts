import { eq } from 'drizzle-orm';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { countBillableDeployments } from './billing-domain.js';
import type { PaddleBilling } from './paddle.js';

// Paddle migration Phase 9 — reconciliation. Deployz owns exactly one billing
// number: how many production deployments are actually live. This module
// pushes that ABSOLUTE count onto the subscription's per-deployment item —
// never a delta, never an increment. A missed or duplicated call therefore
// cannot drift the quantity: running it twice produces the same subscription
// as running it once.
//
// Everything here is decoupled from deployment safety (audit §4). It is
// called only after a billing state actually changed, it never runs inside
// the caller's transaction (a Paddle round trip must not hold a database
// connection open), and it never throws: a provider failure is recorded and
// the Phase 10 safety job picks the drift up on its next pass.

export interface ReconcileDeps {
  db: RuntimeDb;
  paddle: PaddleBilling | null;
  now?: () => Date;
}

/** What reconciliation did. Recorded verbatim in `billing_reconciliation_events.action`. */
export type ReconcileAction =
  | 'NONE' // provider already matched the expected quantity
  | 'QUANTITY_UPDATED' // the per-deployment item was set to the expected count
  | 'ITEM_REMOVED' // the last live deployment went away; the item was dropped
  | 'ITEM_ADDED' // the first live deployment appeared; the item was added
  | 'SKIPPED';

export interface ReconcileResult {
  status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
  action: ReconcileAction;
  /** What Deployz believes should be billed. */
  expected: number;
  /** What the provider had before the update — null when it was never read. */
  provider: number | null;
  reason?: string;
}

// The subscription states whose quantity Paddle will accept an update for.
// PAUSED and CANCELED are not updatable, and a CANCELED subscription bills
// nothing anyway.
const UPDATABLE_STATUSES: ReadonlySet<string> = new Set(['ACTIVE', 'PAST_DUE']);

async function recordReconciliation(
  db: RuntimeDb,
  organizationId: string,
  result: ReconcileResult,
): Promise<void> {
  await db.insert(schema.billingReconciliationEvents).values({
    organizationId,
    expectedDeploymentQuantity: result.expected,
    providerDeploymentQuantity: result.provider,
    action: result.action,
    status: result.status,
    error: result.reason ?? null,
  });
}

/**
 * Brings the organization's subscription in line with the number of live
 * production deployments.
 *
 * A no-op pass (the provider already agreed) writes no reconciliation row —
 * this runs on every billing transition and on the Phase 10 schedule, and a
 * ledger of "nothing happened" would bury the entries that matter. It still
 * stamps `lastReconciledAt`, which is what says the check ran.
 */
export async function reconcileBilling(
  deps: ReconcileDeps,
  organizationId: string,
): Promise<ReconcileResult> {
  const { db, paddle } = deps;
  const now = deps.now ?? (() => new Date());

  const rows = await db
    .select({
      deploymentType: schema.deployments.deploymentType,
      billingState: schema.deployments.billingState,
    })
    .from(schema.deployments)
    .where(eq(schema.deployments.organizationId, organizationId));
  const expected = countBillableDeployments(rows);

  if (!paddle) {
    // Billing is switched off for this deployment of the control plane; there
    // is no provider to disagree with.
    return { status: 'SKIPPED', action: 'SKIPPED', expected, provider: null, reason: 'billing disabled' };
  }

  const [subscription] = await db
    .select()
    .from(schema.billingSubscriptions)
    .where(eq(schema.billingSubscriptions.organizationId, organizationId))
    .limit(1);

  if (!subscription) {
    // Evaluation mode. Nothing was ever sold, so nothing can be reconciled.
    // Recorded only when Deployz believes something should be billed, which
    // would mean a live production deployment with no subscription behind it.
    const result: ReconcileResult = {
      status: 'SKIPPED',
      action: 'SKIPPED',
      expected,
      provider: null,
      reason: 'no subscription',
    };
    if (expected > 0) await recordReconciliation(db, organizationId, result);
    return result;
  }

  if (!UPDATABLE_STATUSES.has(subscription.status)) {
    const result: ReconcileResult = {
      status: 'SKIPPED',
      action: 'SKIPPED',
      expected,
      provider: null,
      reason: `subscription is ${subscription.status}`,
    };
    if (expected > 0) await recordReconciliation(db, organizationId, result);
    return result;
  }

  try {
    const live = await paddle.client.subscriptions.get(subscription.providerSubscriptionId);
    // Paddle keeps an item on the record as `inactive` once it has been
    // removed from the subscription. Those must be filtered out of BOTH the
    // count and the rebuilt list below: sending one back would resurrect an
    // item Paddle had already stopped billing.
    const liveItems = live.items.filter((item) => item.status !== 'inactive');
    // Paddle returns the full price object per item; the per-deployment item
    // is the one priced at PADDLE_PRICE_DEPLOYMENT. Its absence means zero.
    const deploymentItem = liveItems.find((item) => item.price?.id === paddle.config.priceDeployment);
    const provider = deploymentItem?.quantity ?? 0;

    if (provider === expected) {
      await db
        .update(schema.billingSubscriptions)
        .set({ lastReconciledAt: now() })
        .where(eq(schema.billingSubscriptions.organizationId, organizationId));
      return { status: 'SUCCEEDED', action: 'NONE', expected, provider };
    }

    // Paddle replaces the item list wholesale: anything omitted is removed,
    // so every other item has to be sent back unchanged. The per-deployment
    // item is dropped rather than set to zero — the price's own minimum
    // quantity is 1, so zero is not a value it can hold.
    const items = liveItems
      .filter((item) => item.price?.id !== paddle.config.priceDeployment)
      .map((item) => ({ priceId: item.price!.id, quantity: item.quantity }));
    if (expected > 0) {
      items.push({ priceId: paddle.config.priceDeployment, quantity: expected });
    }

    await paddle.client.subscriptions.update(subscription.providerSubscriptionId, {
      items,
      // Paddle owns the money math: a deployment that goes live mid-cycle is
      // charged for the part of the cycle it is live, and one that is removed
      // is credited the same way.
      prorationBillingMode: 'prorated_immediately',
      // The deployment is already running. Refusing the quantity change
      // because a card failed would only under-bill it; letting the change
      // land keeps the subscription honest and leaves Paddle to chase the
      // payment (Phase 13 acts on the resulting status).
      onPaymentFailure: 'apply_change',
    });

    const action: ReconcileAction =
      expected === 0 ? 'ITEM_REMOVED' : provider === 0 ? 'ITEM_ADDED' : 'QUANTITY_UPDATED';
    const result: ReconcileResult = { status: 'SUCCEEDED', action, expected, provider };
    await recordReconciliation(db, organizationId, result);
    await db
      .update(schema.billingSubscriptions)
      .set({ lastReconciledAt: now() })
      .where(eq(schema.billingSubscriptions.organizationId, organizationId));
    return result;
  } catch (error) {
    const result: ReconcileResult = {
      status: 'FAILED',
      action: 'NONE',
      expected,
      provider: null,
      reason: error instanceof Error ? error.message : String(error),
    };
    await recordReconciliation(db, organizationId, result).catch(() => {
      // The ledger write is best effort — losing it must not turn a billing
      // problem into a failed deployment request.
    });
    return result;
  }
}
