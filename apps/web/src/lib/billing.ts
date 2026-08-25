// §48 billing display — data access for the billing page. Wired to the real
// `GET /api/billing/summary` endpoint: {base, deployments: [{name (customer
// name), applicationName, amount}], total}. No fixture fallback — a failure
// here is a real failure, not a loading state. §65: all copy is jargon-free.

import { cookies } from 'next/headers';

import { serverApiUrl } from '@/lib/api-url';

// ── Wire shapes ────────────────────────────────────────────────────────────

/** One billable deployment line item — labelled by CUSTOMER name (§48). */
export interface BillingDeploymentLine {
  /** Customer name — the §48 line item label. */
  name: string;
  applicationName: string;
  /** Dollar amount for this line (always $19 at launch pricing, §7). */
  amount: number;
}

/** The §48 billing summary: base platform fee + one line per billed deployment. */
export interface BillingSummary {
  /** Base platform fee in whole dollars ($49). */
  base: number;
  deployments: BillingDeploymentLine[];
  /** base + sum(deployments.amount), in whole dollars. */
  total: number;
  /** The org's subscription, or null when it has never subscribed. */
  subscription: { status: string; currentPeriodEnd: string | null } | null;
}

// ── Fetch ───────────────────────────────────────────────────────────────────

async function getJson<T>(path: string): Promise<T> {
  const cookieHeader = (await cookies()).toString();
  const response = await fetch(`${serverApiUrl()}${path}`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Billing request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

/** Fetch the org's §48 billing summary. */
export async function fetchBillingSummary(): Promise<BillingSummary> {
  return getJson<BillingSummary>('/api/billing/summary');
}

// ── Formatting helpers ──────────────────────────────────────────────────────

/** Format a whole-dollar amount for display (e.g. 49 → "$49"). */
export function formatDollars(amount: number): string {
  return `$${amount}`;
}
