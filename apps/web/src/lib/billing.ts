// §48 billing display — data access for the billing settings page. The
// billing API endpoint arrives in a later todo; until then this fetcher falls
// back to realistic FIXTURE data on a 404 so the billing page renders without
// a backend (same pattern as todos 19/25/26/30). §65: all copy is jargon-free.

import { cookies } from 'next/headers';

const apiUrl = process.env.API_URL ?? 'http://localhost:3001';

// ── Wire shapes ────────────────────────────────────────────────────────────

/** Subscription status as displayed on the billing page. */
export type BillingStatus = 'ACTIVE' | 'TRIALING' | 'PAST_DUE' | 'CANCELED' | 'INCOMPLETE' | 'NONE';

/** A billing period with start and end dates. */
export interface BillingPeriod {
  start: string;
  end: string;
}

/** One line item on the billing summary. */
export interface BillingLineItem {
  /** §65-friendly label (e.g. "Base subscription", "Healthy deployments"). */
  label: string;
  /** Price in cents. */
  amountCents: number;
  /** Human-readable amount (e.g. "$49.00"). */
  amountDisplay: string;
  /** Optional detail (e.g. "1 deployment × 30 days"). */
  detail?: string;
}

/** Everything the billing page needs for one organization. */
export interface BillingInfo {
  status: BillingStatus;
  /** The current billing period, if the org has an active subscription. */
  currentPeriod: BillingPeriod | null;
  /** Line items for the current period. */
  lineItems: BillingLineItem[];
  /** Total in cents for the current period. */
  totalCents: number;
  /** Human-readable total (e.g. "$68.00"). */
  totalDisplay: string;
  /** Whether the org has a Stripe subscription at all. */
  hasSubscription: boolean;
  /** URL to the Stripe customer portal for managing billing. */
  manageUrl: string | null;
}

// ── Fetch ───────────────────────────────────────────────────────────────────

async function getJson<T>(path: string): Promise<T> {
  const cookieHeader = (await cookies()).toString();
  const response = await fetch(`${apiUrl}${path}`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Billing request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

/** Fetch the org's billing info, falling back to fixture data on 404. */
export async function fetchBilling(): Promise<BillingInfo> {
  try {
    return await getJson<BillingInfo>('/api/billing');
  } catch (error) {
    if (isNotFound(error)) return FIXTURE_BILLING;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.includes('(404)');
}

// ── Formatting helpers ──────────────────────────────────────────────────────

/** Format cents as a dollar string (e.g. 4900 → "$49.00"). */
export function formatCents(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars.toFixed(2)}`;
}

/** Format a date string for display (e.g. "2026-08-01" → "Aug 1, 2026"). */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ── Fixture data (§65 jargon-free) ──────────────────────────────────────────

/** Realistic fixture fallback while the billing endpoint is absent. */
export const FIXTURE_BILLING: BillingInfo = {
  status: 'ACTIVE',
  currentPeriod: {
    start: '2026-08-01',
    end: '2026-08-31',
  },
  lineItems: [
    {
      label: 'Base subscription',
      amountCents: 4900,
      amountDisplay: '$49.00',
    },
    {
      label: 'Healthy deployments',
      amountCents: 1900,
      amountDisplay: '$19.00',
      detail: '1 deployment × 30 days',
    },
  ],
  totalCents: 6800,
  totalDisplay: '$68.00',
  hasSubscription: true,
  manageUrl: null,
};