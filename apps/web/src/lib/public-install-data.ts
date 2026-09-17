import { serverApiUrl } from '@/lib/api-url';

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
 * fall through to the existing per-deployment flow.
 */
export async function fetchPublicInstallData(linkId: string): Promise<PublicInstallLookup> {
  try {
    const response = await fetch(
      `${serverApiUrl()}/api/public-install/${encodeURIComponent(linkId)}`,
      { cache: 'no-store' },
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
