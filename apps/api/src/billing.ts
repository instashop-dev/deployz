import { eq } from 'drizzle-orm';
import Stripe from 'stripe';

import type { SubscriptionStatus } from '@deployz/contracts';
import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import {
  BASE_PRICE_CENTS,
  decideBilling,
  METERED_PRICE_CENTS,
  shouldBillForDeployment,
} from './billing-correctness.js';
import { env } from './env.js';
import { ApiError } from './errors.js';

// §48 billing foundation: $49/month base subscription + $19 per live
// (HEALTHY or UPDATE_AVAILABLE, non-test) deployment per month, metered daily
// (U8 day-proration: ONE usage record per deployment per day, quantity 1).
// §7: vendor-owned test deployments (is_test_deployment = true) are exempt
// from the metered $19. BASE_PRICE_CENTS / METERED_PRICE_CENTS and the
// billing decision rules live in billing-correctness.ts — the single source
// of truth — and are re-exported here for convenience.
//
// Stripe SDK 22.x: legacy subscriptionItems.usageRecords was removed — metered
// usage is reported via billing.meterEvents against a meter attached to the
// metered price. The metered price is created with recurring.usage_type =
// 'metered' + recurring.meter = <meter id>; the meter aggregates events with
// formula 'sum' over payload key 'value', mapped to the customer by
// 'stripe_customer_id'.

export const METER_EVENT_NAME = 'deployz_healthy_deployment_days';
export { BASE_PRICE_CENTS, METERED_PRICE_CENTS };

export type StripeClient = Stripe;

// Degrade gracefully: no STRIPE_SECRET_KEY -> null client, every billing
// surface no-ops (tests without a key, local dev without billing).
export function createStripe(secretKey: string | undefined = env.stripeSecretKey): Stripe | null {
  if (!secretKey) {
    return null;
  }
  return new Stripe(secretKey);
}

export interface BillingDeps {
  db: RuntimeDb;
  stripe: Stripe | null;
}

// ---------------------------------------------------------------------------
// Checkout / subscription creation
// ---------------------------------------------------------------------------

export interface CreateCheckoutSessionParams {
  organizationId: string;
  customerEmail?: string | undefined;
}

// Creates a Stripe Checkout Session in subscription mode carrying the $49
// base price + the $19 metered price. Prices come from env when configured
// (STRIPE_PRICE_BASE / STRIPE_PRICE_METERED); otherwise they are created on
// the fly (test mode) so the flow works against a bare test key.
export async function createCheckoutSession(
  { db, stripe }: BillingDeps,
  { organizationId, customerEmail }: CreateCheckoutSessionParams,
): Promise<{ checkoutSessionId: string; url: string | null }> {
  if (!stripe) {
    throw new ApiError(503, 'BILLING_DISABLED', 'Stripe billing is not configured');
  }

  const basePriceId = env.stripePriceBase ?? (await ensureBasePrice(stripe)).id;
  const meteredPriceId = env.stripePriceMetered ?? (await ensureMeteredPrice(stripe)).id;

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [
      { price: basePriceId, quantity: 1 },
      { price: meteredPriceId },
    ],
    success_url: `${env.webUrl}/dashboard?billing=success`,
    cancel_url: `${env.webUrl}/dashboard?billing=cancelled`,
    ...(customerEmail ? { customer_email: customerEmail } : {}),
    metadata: { organizationId },
    subscription_data: { metadata: { organizationId } },
  });

  // Persist a pending subscription row so the org has a billing record before
  // the webhook lands; checkout.session.completed / invoice.paid fill in the
  // Stripe ids and lifecycle status.
  const stripeSubscriptionId =
    typeof session.subscription === 'string' ? session.subscription : (session.subscription?.id ?? session.id);

  await upsertSubscriptionRow(db, {
    organizationId,
    stripeSubscriptionId,
    stripeBasePriceId: basePriceId,
    stripeMeteredPriceId: meteredPriceId,
    status: 'INCOMPLETE',
    currentPeriodStart: null,
    currentPeriodEnd: null,
  });

  return { checkoutSessionId: session.id, url: session.url };
}

async function ensureBasePrice(stripe: Stripe): Promise<Stripe.Price> {
  const product = await stripe.products.create({ name: 'Deployz Base' });
  return stripe.prices.create({
    product: product.id,
    currency: 'usd',
    unit_amount: BASE_PRICE_CENTS,
    recurring: { interval: 'month' },
  });
}

async function ensureMeteredPrice(stripe: Stripe): Promise<Stripe.Price> {
  // Stripe refuses a second active meter with the same event name, so
  // creating one unconditionally fails every checkout after the first and
  // never recovers. Reuse the meter that is already there.
  const meter = (await findActiveMeter(stripe)) ?? (await createMeter(stripe));
  const product = await stripe.products.create({ name: 'Deployz Healthy Deployment' });
  return stripe.prices.create({
    product: product.id,
    currency: 'usd',
    unit_amount: METERED_PRICE_CENTS,
    billing_scheme: 'per_unit',
    recurring: { interval: 'month', usage_type: 'metered', meter: meter.id },
  });
}

async function findActiveMeter(stripe: Stripe): Promise<Stripe.Billing.Meter | undefined> {
  const meters = await stripe.billing.meters.list({ status: 'active', limit: 100 });
  return meters.data.find((meter) => meter.event_name === METER_EVENT_NAME);
}

async function createMeter(stripe: Stripe): Promise<Stripe.Billing.Meter> {
  return stripe.billing.meters.create({
    display_name: 'Healthy deployment days',
    event_name: METER_EVENT_NAME,
    default_aggregation: { formula: 'sum' },
    customer_mapping: { type: 'by_id', event_payload_key: 'stripe_customer_id' },
    value_settings: { event_payload_key: 'value' },
  });
}

// ---------------------------------------------------------------------------
// Webhook handling (signature-verified)
// ---------------------------------------------------------------------------

// Verifies the Stripe signature over the RAW body and returns the event.
// Throws ApiError(400) on a bad signature — the error handler renders the
// structured envelope, never a stack trace.
export function constructWebhookEvent(
  stripe: Stripe | null,
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
  webhookSecret: string | undefined = env.stripeWebhookSecret,
): Stripe.Event {
  if (!stripe || !webhookSecret) {
    throw new ApiError(503, 'BILLING_DISABLED', 'Stripe billing is not configured');
  }
  if (!signatureHeader) {
    throw new ApiError(400, 'WEBHOOK_SIGNATURE_MISSING', 'Missing stripe-signature header');
  }
  try {
    return stripe.webhooks.constructEvent(rawBody, signatureHeader, webhookSecret);
  } catch {
    throw new ApiError(400, 'WEBHOOK_SIGNATURE_INVALID', 'Webhook signature verification failed');
  }
}

// Applies a verified webhook event to the subscriptions table. Returns true
// when the event mutated state (used by tests + logging).
export async function handleWebhookEvent(
  { db, stripe }: BillingDeps,
  event: Stripe.Event,
): Promise<boolean> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const organizationId = session.metadata?.organizationId;
      const stripeSubscriptionId =
        typeof session.subscription === 'string'
          ? session.subscription
          : session.subscription?.id;
      if (!organizationId || !stripeSubscriptionId) {
        return false;
      }
      // Pull the subscription to learn the price ids + current period.
      let basePriceId = env.stripePriceBase ?? '';
      let meteredPriceId = env.stripePriceMetered ?? '';
      let status = 'ACTIVE';
      let periodStart: Date | null = null;
      let periodEnd: Date | null = null;
      if (stripe) {
        const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
        status = mapStripeStatus(sub.status);
        const item = sub.items.data[0];
        if (item) {
          periodStart = new Date(item.current_period_start * 1000);
          periodEnd = new Date(item.current_period_end * 1000);
        }
        for (const lineItem of sub.items.data) {
          const price = lineItem.price;
          if (price.recurring?.usage_type === 'metered') {
            meteredPriceId = price.id;
          } else {
            basePriceId = price.id;
          }
        }
      }
      await upsertSubscriptionRow(db, {
        organizationId,
        stripeSubscriptionId,
        stripeBasePriceId: basePriceId,
        stripeMeteredPriceId: meteredPriceId,
        status: status as SubscriptionStatus,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
      });
      await syncOrganizationPlan(db, stripeSubscriptionId, status as SubscriptionStatus);
      return true;
    }
    case 'invoice.paid':
    case 'invoice.finalized': {
      const invoice = event.data.object as Stripe.Invoice;
      const stripeSubscriptionId = extractInvoiceSubscriptionId(invoice);
      if (!stripeSubscriptionId) {
        return false;
      }
      const status = invoice.status === 'paid' ? 'ACTIVE' : undefined;
      await upsertSubscriptionRow(
        db,
        {
          organizationId: undefined,
          stripeSubscriptionId,
          stripeBasePriceId: undefined,
          stripeMeteredPriceId: undefined,
          status,
          currentPeriodStart: null,
          currentPeriodEnd: null,
        },
        { byStripeSubscriptionId: true },
      );
      await syncOrganizationPlan(db, stripeSubscriptionId, status as SubscriptionStatus | undefined);
      return true;
    }
    default:
      return false;
  }
}

/**
 * Keep organizations.plan in step with the subscription.
 *
 * The column was written once at signup and never again — not even here — so
 * Settings read "Plan: Free" forever while the billing screen showed a $49
 * charge, and nothing in the product ever recorded that an organization was
 * paying. Derived from the subscription status so there is one source of
 * truth, not two that can drift.
 */
async function syncOrganizationPlan(
  db: RuntimeDb,
  stripeSubscriptionId: string,
  status: SubscriptionStatus | undefined,
): Promise<void> {
  if (!status) return;
  const rows = await db
    .select({ organizationId: schema.subscriptions.organizationId })
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.stripeSubscriptionId, stripeSubscriptionId))
    .limit(1);
  const organizationId = rows[0]?.organizationId;
  if (!organizationId) return;

  // TRIALING counts as paying: the vendor has a live subscription and the
  // product should not behave as though they are on the free plan.
  const plan = status === 'ACTIVE' || status === 'TRIALING' || status === 'PAST_DUE' ? 'STARTER' : 'FREE';
  await db
    .update(schema.organization)
    .set({ plan })
    .where(eq(schema.organization.id, organizationId));
}

function extractInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const parent = invoice.parent;
  if (parent && typeof parent === 'object' && 'subscription_details' in parent) {
    const details = (parent as { subscription_details?: { subscription?: string | { id: string } | null } })
      .subscription_details;
    const sub = details?.subscription;
    if (typeof sub === 'string') return sub;
    if (sub && typeof sub === 'object') return sub.id;
  }
  return null;
}

function mapStripeStatus(status: Stripe.Subscription.Status): string {
  switch (status) {
    case 'active':
      return 'ACTIVE';
    case 'trialing':
      return 'TRIALING';
    case 'past_due':
      return 'PAST_DUE';
    case 'canceled':
    case 'unpaid':
    case 'incomplete_expired':
      return 'CANCELED';
    case 'incomplete':
    default:
      return 'INCOMPLETE';
  }
}

interface UpsertSubscriptionInput {
  organizationId: string | undefined;
  stripeSubscriptionId: string;
  stripeBasePriceId: string | undefined;
  stripeMeteredPriceId: string | undefined;
  status: SubscriptionStatus | undefined;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
}

async function upsertSubscriptionRow(
  db: RuntimeDb,
  input: UpsertSubscriptionInput,
  opts: { byStripeSubscriptionId?: boolean } = {},
): Promise<void> {
  const now = new Date();
  const base = {
    ...(input.status ? { status: input.status } : {}),
    ...(input.stripeBasePriceId !== undefined ? { stripeBasePriceId: input.stripeBasePriceId } : {}),
    ...(input.stripeMeteredPriceId !== undefined
      ? { stripeMeteredPriceId: input.stripeMeteredPriceId }
      : {}),
    currentPeriodStart: input.currentPeriodStart,
    currentPeriodEnd: input.currentPeriodEnd,
    updatedAt: now,
  };

  if (opts.byStripeSubscriptionId) {
    await db
      .update(schema.subscriptions)
      .set(base)
      .where(eq(schema.subscriptions.stripeSubscriptionId, input.stripeSubscriptionId));
    return;
  }

  if (!input.organizationId) {
    return;
  }

  const existing = await db
    .select({ id: schema.subscriptions.id })
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.organizationId, input.organizationId))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(schema.subscriptions).values({
      organizationId: input.organizationId,
      stripeSubscriptionId: input.stripeSubscriptionId,
      stripeBasePriceId: input.stripeBasePriceId ?? '',
      stripeMeteredPriceId: input.stripeMeteredPriceId ?? '',
      status: input.status ?? 'INCOMPLETE',
      currentPeriodStart: input.currentPeriodStart,
      currentPeriodEnd: input.currentPeriodEnd,
    });
    return;
  }

  await db
    .update(schema.subscriptions)
    .set({
      ...base,
      stripeSubscriptionId: input.stripeSubscriptionId,
    })
    .where(eq(schema.subscriptions.organizationId, input.organizationId));
}

// ---------------------------------------------------------------------------
// "Billable on Healthy" usage reporting (§48/U8 + §7 exemption)
// ---------------------------------------------------------------------------

export interface BillableDeployment {
  id: string;
  organizationId: string;
  state: string;
  isTestDeployment: boolean;
}

// §48: a deployment bills $19/month when it is live. §46: HEALTHY and
// UPDATE_AVAILABLE are both live serving states (a deployment moves to
// UPDATE_AVAILABLE simply because the vendor published a newer release, and
// §48 says "creating multiple releases does not affect billing" — it must
// stay billable). §7: the one vendor-owned test deployment is exempt.
// Delegates to shouldBillForDeployment in billing-correctness.ts, the single
// source of truth for this rule.
export function isBillable(deployment: {
  state: string;
  isTestDeployment: boolean;
}): boolean {
  return shouldBillForDeployment(deployment);
}

export interface ReportUsageResult {
  reported: number;
  skipped: number;
  meterEventIds: string[];
}

// Returns the calendar day immediately before `dateStr` (both 'YYYY-MM-DD',
// UTC) — used to look up whether a deployment was already billing yesterday.
function previousDateString(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Reports ONE meter event (quantity 1) per billable deployment for the given
// UTC date — the U8 day-proration shape. Records each report in usage_records
// (unique per deployment+date) and stamps stripe_usage_record_id with the
// meter event identifier once accepted.
//
// §48 correctness: billability for the day is decided by decideBilling (the
// single source of truth in billing-correctness.ts), not by re-deriving the
// rule from the current row state. decideBilling is told whether the
// deployment already had a usage_records row for the previous date
// (`wasBillingPreviously`) so a transient HEALTHY -> UPDATING -> FAILED ->
// HEALTHY run keeps billing straight through the FAILED day(s), per "temporary
// failed updates do not affect billing".
//
// Idempotent per (deployment, usageDate): a deployment that already has a
// usage_records row for `usageDate` is counted as reported and neither
// re-reported to Stripe nor re-inserted — safe to re-run for the same date
// (e.g. a retried scheduled invocation). See runDailyUsageReport below.
export async function reportUsageForDate(
  { db, stripe }: BillingDeps,
  usageDate: string,
): Promise<ReportUsageResult> {
  const deployments = await db
    .select({
      id: schema.deployments.id,
      organizationId: schema.deployments.organizationId,
      state: schema.deployments.state,
      isTestDeployment: schema.deployments.isTestDeployment,
    })
    .from(schema.deployments);

  const previousDate = previousDateString(usageDate);
  const [previousDayRecords, sameDayRecords] = await Promise.all([
    db
      .select({ deploymentId: schema.usageRecords.deploymentId })
      .from(schema.usageRecords)
      .where(eq(schema.usageRecords.usageDate, previousDate)),
    db
      .select({ deploymentId: schema.usageRecords.deploymentId })
      .from(schema.usageRecords)
      .where(eq(schema.usageRecords.usageDate, usageDate)),
  ]);
  const wasBillingYesterday = new Set(previousDayRecords.map((r) => r.deploymentId));
  const alreadyReportedToday = new Set(sameDayRecords.map((r) => r.deploymentId));

  const result: ReportUsageResult = { reported: 0, skipped: 0, meterEventIds: [] };

  for (const deployment of deployments) {
    const decision = decideBilling(deployment, wasBillingYesterday.has(deployment.id));
    if (!decision.bill) {
      result.skipped += 1;
      continue;
    }

    // Idempotent re-run for the same date: already reported, nothing to do.
    if (alreadyReportedToday.has(deployment.id)) {
      result.reported += 1;
      continue;
    }

    let meterEventId: string | null = null;
    if (stripe) {
      const subscription = await db
        .select({ stripeSubscriptionId: schema.subscriptions.stripeSubscriptionId })
        .from(schema.subscriptions)
        .where(eq(schema.subscriptions.organizationId, deployment.organizationId))
        .limit(1);
      const stripeSubscriptionId = subscription[0]?.stripeSubscriptionId;
      let stripeCustomerId: string | null = null;
      if (stripeSubscriptionId) {
        const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
        stripeCustomerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
      }
      if (stripeCustomerId) {
        const identifier = `${deployment.id}:${usageDate}`;
        const event = await stripe.billing.meterEvents.create({
          event_name: METER_EVENT_NAME,
          identifier,
          payload: { stripe_customer_id: stripeCustomerId, value: '1' },
        });
        meterEventId = event.identifier;
        result.meterEventIds.push(event.identifier);
      }
    }

    await db
      .insert(schema.usageRecords)
      .values({
        deploymentId: deployment.id,
        usageDate,
        quantity: 1,
        stripeUsageRecordId: meterEventId,
        reportedAt: meterEventId ? new Date() : null,
      })
      .onConflictDoNothing({
        target: [schema.usageRecords.deploymentId, schema.usageRecords.usageDate],
      });

    result.reported += 1;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Scheduled entry point (§48/U8)
// ---------------------------------------------------------------------------

// Named entry point for a scheduled (e.g. daily cron / EventBridge) trigger
// that reports metered usage to Stripe for one UTC calendar day. `date` is
// 'YYYY-MM-DD'. Idempotent: re-invoking for the same date is safe — see the
// idempotency note on reportUsageForDate. Provisioning the actual scheduler
// (cron config, EventBridge rule, etc.) is out of scope here; this is the
// callable unit the scheduler should invoke once per day.
export async function runDailyUsageReport(
  deps: BillingDeps,
  date: string,
): Promise<ReportUsageResult> {
  return reportUsageForDate(deps, date);
}
