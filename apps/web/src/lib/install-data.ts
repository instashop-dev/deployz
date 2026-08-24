// §12/§44 public customer installation data — server-side fetch for the
// unauthenticated /install/:installLinkId page. Wired to the real
// (public, no-auth) `GET /api/install/:installLinkId` endpoint.
//
// The route parameter is the install-LINK id, which is not the relay's
// installation id. They used to be the same value, which made the link a
// customer is emailed also the identifier a relay authenticates against.

import { serverApiUrl } from '@/lib/api-url';

export interface InstallData {
  applicationName: string;
  publisherName: string;
  customerName: string;
  region: string;
  /** §44 "Deployz will create" list, e.g. ["Application runtime", "PostgreSQL database", ...]. */
  resourcesCreated: string[];
  /** Single-use code the bootstrap stack carries. Spent on the relay's first contact. */
  enrollmentCode: string;
  /** True once a relay has enrolled — the link has already been used. */
  alreadyInstalled: boolean;
}

/** Fetch the public install page data. Returns null on a 404 (unknown/invalid link). */
export async function fetchInstallData(installLinkId: string): Promise<InstallData | null> {
  const response = await fetch(`${serverApiUrl()}/api/install/${encodeURIComponent(installLinkId)}`, {
    cache: 'no-store',
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Install request failed (${response.status})`);
  }
  return (await response.json()) as InstallData;
}
