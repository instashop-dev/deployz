// §12/§44 public customer installation data — server-side fetch for the
// unauthenticated /install/:installationId page. Wired to the real
// (public, no-auth) `GET /api/install/:installationId` endpoint.

import { serverApiUrl } from '@/lib/api-url';

export interface InstallData {
  applicationName: string;
  publisherName: string;
  customerName: string;
  region: string;
  /** §44 "Deployz will create" list, e.g. ["Application runtime", "PostgreSQL database", ...]. */
  resourcesCreated: string[];
  /**
   * CloudFormation Quick Create deep-link for THIS deployment, built by the
   * control plane (it owns both the published template URL and the
   * deployment's region). Null when no bootstrap template is published yet.
   */
  quickCreateUrl: string | null;
}

/** Fetch the public install page data. Returns null on a 404 (unknown/invalid link). */
export async function fetchInstallData(installationId: string): Promise<InstallData | null> {
  const response = await fetch(`${serverApiUrl()}/api/install/${encodeURIComponent(installationId)}`, {
    cache: 'no-store',
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Install request failed (${response.status})`);
  }
  return (await response.json()) as InstallData;
}
