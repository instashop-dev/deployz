// Paddle migration Phase 8 — the vendor's first production deployment. The
// API parks the request as a checkout intent and hands back a transaction id;
// this module opens Paddle's own checkout overlay on it. The deployment row
// is created by the API when Paddle reports the subscription as active, so
// the page only has to say that it is on its way.

import { CheckoutEventNames, initializePaddle, type Paddle } from '@paddle/paddle-js';

import { apiRequest } from '@/lib/api-client';

/** `GET /api/billing/config` — never the API key or the webhook secret. */
export interface BillingConfig {
  enabled: boolean;
  environment?: 'sandbox' | 'production';
  clientToken?: string;
  pricePlatform?: string;
  priceDeployment?: string;
}

export interface CheckoutIntent {
  checkoutIntentId: string;
  transactionId: string;
}

export interface CreateCheckoutIntentInput {
  applicationId: string;
  customerId: string;
  region: string;
}

export function fetchBillingConfig(): Promise<BillingConfig> {
  return apiRequest<BillingConfig>('/api/billing/config');
}

/** `POST /api/billing/checkout` — parks the deployment, opens a transaction.
 *  Nothing is provisioned and no deployment exists until the payment lands. */
export function createCheckoutIntent(input: CreateCheckoutIntentInput): Promise<CheckoutIntent> {
  return apiRequest<CheckoutIntent>('/api/billing/checkout', { method: 'POST', body: input });
}

/** 'completed' means Paddle took the payment; 'closed' means the vendor left
 *  the overlay. Neither is the authority on the subscription — the webhook is. */
export type CheckoutOutcome = 'completed' | 'closed';

let paddlePromise: Promise<Paddle | undefined> | null = null;
// Paddle.js takes its event callback once, at initialization, so the callback
// reads the settler of whichever checkout is open now rather than closing
// over the first one.
let settleOpenCheckout: ((outcome: CheckoutOutcome) => void) | null = null;

/**
 * Opens Paddle's checkout overlay on a transaction the API created, and
 * resolves once the vendor pays or closes it. Paddle.js is loaded once per
 * page session; the overlay is Paddle's, so no card details ever reach
 * Deployz.
 */
export async function openSubscriptionCheckout(
  config: BillingConfig,
  transactionId: string,
): Promise<CheckoutOutcome> {
  if (!config.enabled || !config.clientToken) {
    throw new Error('Billing is not configured.');
  }
  const outcome = new Promise<CheckoutOutcome>((resolve) => {
    settleOpenCheckout = resolve;
  });
  paddlePromise ??= initializePaddle({
    token: config.clientToken,
    ...(config.environment ? { environment: config.environment } : {}),
    eventCallback: (event) => {
      if (event.name === CheckoutEventNames.CHECKOUT_COMPLETED) settleOpenCheckout?.('completed');
      if (event.name === CheckoutEventNames.CHECKOUT_CLOSED) settleOpenCheckout?.('closed');
    },
  });
  const paddle = await paddlePromise;
  if (!paddle) {
    paddlePromise = null;
    throw new Error('Checkout could not be opened.');
  }
  paddle.Checkout.open({ transactionId });
  return outcome;
}
