import { and, eq } from 'drizzle-orm';

import type { Region } from '@deployz/contracts';
import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createDeploymentRecord, loadOwnedApplication, loadOwnedCustomer } from './deploy-links.js';
import { ApiError } from './errors.js';
import { getSubscriptionStatus } from './organizations.js';
import type { PaddleBilling } from './paddle.js';
import { requirePreflightReady, runApplicationPreflight } from './preflight.js';

// Paddle migration Phase 8 — first production activation. A vendor with no
// subscription asks for a customer deployment: nothing is provisioned, no
// deployment row is written and no install link exists. The request is parked
// as a billing_checkout_intents row tied to a Paddle transaction, and the
// vendor pays through Paddle.js. When the subscription activates, the Phase 6
// webhook resumes the intent and only then does the deployment row appear.

export interface CheckoutDeps {
  db: RuntimeDb;
  paddle: PaddleBilling | null;
  now?: () => Date;
}

export interface CreateCheckoutIntentParams {
  organizationId: string;
  applicationId: string;
  customerId: string;
  region: Region;
  createdBy: string | null;
}

export interface CreatedCheckoutIntent {
  checkoutIntentId: string;
  transactionId: string;
}

/**
 * Parks a production deployment request and opens a Paddle transaction for
 * it. Everything that can be checked before the vendor pays is checked here
 * — organization ownership of the application and the customer, and the same
 * preflight gate createDeploymentRecord runs — so a completed checkout does
 * not land on a request that was never going to work.
 */
export async function createCheckoutIntent(
  deps: CheckoutDeps,
  params: CreateCheckoutIntentParams,
): Promise<CreatedCheckoutIntent> {
  const { db, paddle } = deps;
  const now = deps.now ?? (() => new Date());
  if (!paddle) {
    throw new ApiError(503, 'BILLING_DISABLED', 'Paddle billing is not configured');
  }

  // An organization that already pays creates deployments directly — the
  // Phase 7 gate lets them through, so a second subscription must not be
  // sold here.
  const subscriptionStatus = await getSubscriptionStatus(db, params.organizationId);
  if (subscriptionStatus === 'ACTIVE') {
    throw new ApiError(
      409,
      'SUBSCRIPTION_ALREADY_ACTIVE',
      'This organization already has an active subscription. Create the deployment directly.',
    );
  }

  const application = await loadOwnedApplication(db, params.applicationId, params.organizationId);
  await loadOwnedCustomer(db, params.customerId, params.organizationId);
  const { result } = await runApplicationPreflight(db, application, params.customerId);
  requirePreflightReady(result);

  // One PENDING intent per organization (partial unique index): activation
  // resumes every pending intent, so a second one would provision a second
  // deployment for one checkout. A new checkout wins.
  await db
    .update(schema.billingCheckoutIntents)
    .set({ status: 'SUPERSEDED', resolvedAt: now() })
    .where(
      and(
        eq(schema.billingCheckoutIntents.organizationId, params.organizationId),
        eq(schema.billingCheckoutIntents.status, 'PENDING'),
      ),
    );

  const [intent] = await db
    .insert(schema.billingCheckoutIntents)
    .values({
      organizationId: params.organizationId,
      applicationId: params.applicationId,
      customerId: params.customerId,
      region: params.region,
      createdBy: params.createdBy,
    })
    .returning();

  // The intent id travels in customData so the webhook can attribute the
  // subscription to this organization before any subscription row exists —
  // hence the insert above must come first.
  let transactionId: string;
  try {
    const transaction = await paddle.client.transactions.create({
      items: [
        { priceId: paddle.config.pricePlatform, quantity: 1 },
        { priceId: paddle.config.priceDeployment, quantity: 1 },
      ],
      customData: { organizationId: params.organizationId, checkoutIntentId: intent!.id },
    });
    transactionId = transaction.id;
  } catch (error) {
    await db
      .update(schema.billingCheckoutIntents)
      .set({
        status: 'FAILED',
        error: error instanceof Error ? error.message : String(error),
        resolvedAt: now(),
      })
      .where(eq(schema.billingCheckoutIntents.id, intent!.id));
    throw new ApiError(502, 'CHECKOUT_UNAVAILABLE', 'Could not start checkout. Try again.');
  }

  await db
    .update(schema.billingCheckoutIntents)
    .set({ providerTransactionId: transactionId })
    .where(eq(schema.billingCheckoutIntents.id, intent!.id));

  return { checkoutIntentId: intent!.id, transactionId };
}

export interface ResumedCheckoutIntent {
  checkoutIntentId: string;
  status: 'COMPLETED' | 'FAILED';
  deploymentId?: string;
  error?: string;
}

/**
 * Creates the deployment for every PENDING intent of an organization whose
 * subscription just became ACTIVE. Never throws: this runs inside the webhook
 * path, and a failure to create the deployment must not make Paddle redeliver
 * a subscription event that was applied correctly. A failed intent is
 * recorded as FAILED with its reason — the subscription is real, so the
 * vendor now passes the Phase 7 gate and can create the deployment directly.
 */
export async function resumePendingCheckoutIntents(
  deps: CheckoutDeps,
  organizationId: string,
): Promise<ResumedCheckoutIntent[]> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const intents = await db
    .select()
    .from(schema.billingCheckoutIntents)
    .where(
      and(
        eq(schema.billingCheckoutIntents.organizationId, organizationId),
        eq(schema.billingCheckoutIntents.status, 'PENDING'),
      ),
    );

  const results: ResumedCheckoutIntent[] = [];
  for (const intent of intents) {
    try {
      const { deployment } = await createDeploymentRecord(db, {
        organizationId: intent.organizationId,
        applicationId: intent.applicationId,
        customerId: intent.customerId,
        region: intent.region,
        deploymentType: 'PRODUCTION',
        createdBy: intent.createdBy,
        updatedBy: intent.createdBy,
        source: 'manual',
      });
      await db
        .update(schema.billingCheckoutIntents)
        .set({ status: 'COMPLETED', deploymentId: deployment.id, resolvedAt: now() })
        .where(eq(schema.billingCheckoutIntents.id, intent.id));
      results.push({
        checkoutIntentId: intent.id,
        status: 'COMPLETED',
        deploymentId: deployment.id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db
        .update(schema.billingCheckoutIntents)
        .set({ status: 'FAILED', error: message, resolvedAt: now() })
        .where(eq(schema.billingCheckoutIntents.id, intent.id));
      results.push({ checkoutIntentId: intent.id, status: 'FAILED', error: message });
    }
  }
  return results;
}
