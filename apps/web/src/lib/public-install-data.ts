import { apiUrl, serverApiUrl } from '@/lib/api-url';

import type { DeploymentPlan } from '@deployz/contracts';

import type { PublicInstallResolve } from './public-install-types';

export type { PublicInstallResolve } from './public-install-types';

export type PublicInstallLookup =
  | { status: 'ok'; data: PublicInstallResolve }
  | { status: 'gone'; code: string }
  | null;

/**
 * Resolve a public install link. Returns the review projection on 200, null on
 * 404 (unknown public link), and a gone marker on 410 (revoked, disabled, or
 * no published release). Any other failure is treated as 404 so the page can
 * fall through to the existing per-deployment flow. `token` authorizes a
 * targeted invitation's private surface (uniform 404 when missing/wrong).
 */
export async function fetchPublicInstallData(
  linkId: string,
  token?: string,
): Promise<PublicInstallLookup> {
  try {
    const response = await fetch(
      `${serverApiUrl()}/api/public-install/${encodeURIComponent(linkId)}`,
      {
        cache: 'no-store',
        ...(token !== undefined ? { headers: { 'x-deployz-token': token } } : {}),
      },
    );
    if (response.status === 404) return null;
    if (response.status === 410) {
      const payload: unknown = await response.json().catch(() => null);
      const code =
        (payload as { error?: { code?: string } } | null)?.error?.code ??
        'PUBLIC_INSTALL_LINK_REVOKED';
      return { status: 'gone', code };
    }
    if (!response.ok) return null;
    const data = (await response.json()) as PublicInstallResolve;
    return { status: 'ok', data };
  } catch {
    return null;
  }
}

/**
 * The region-specific INSTALL plan for a public install link (Phase 3).
 * Pricing stays on the server. Returns null on any failure — the flow keeps
 * the resolve-time preview and renders "Estimate unavailable" instead of a
 * stale cost. `token` authorizes a targeted invitation's private surface.
 */
export async function fetchPublicInstallPlan(
  linkId: string,
  region: string,
  token?: string,
): Promise<DeploymentPlan | null> {
  try {
    const response = await fetch(
      `${apiUrl}/api/public-install/${encodeURIComponent(linkId)}/plan?region=${encodeURIComponent(region)}`,
      { cache: 'no-store', ...(token !== undefined ? { headers: { 'x-deployz-token': token } } : {}) },
    );
    if (!response.ok) return null;
    return (await response.json()) as DeploymentPlan;
  } catch {
    return null;
  }
}
