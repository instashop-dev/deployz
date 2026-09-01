import type { VendorStackEvent } from '@deployz/contracts';

// Vendor-only raw CloudFormation stack-event feed (Task 5's endpoint).
// Modeled on fetchDeploymentEvents in ./deployments.ts.

import { apiUrl } from '@/lib/api-url';

export type { VendorStackEvent };

/** Fetch a deployment's raw stack events, newest-first. */
export async function fetchStackEvents(id: string): Promise<VendorStackEvent[]> {
  const response = await fetch(`${apiUrl}/api/deployments/${encodeURIComponent(id)}/stack-events`, {
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Stack events request failed (${response.status})`);
  }
  const body = (await response.json()) as { events?: VendorStackEvent[] };
  return body.events ?? [];
}
