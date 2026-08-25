// §12/§44 public customer installation data — server-side fetch for the
// unauthenticated /install/:installLinkId page. Wired to the real
// (public, no-auth) `GET /api/install/:installLinkId` endpoint.
//
// The route parameter is the install-LINK id, which is not the relay's
// installation id. They used to be the same value, which made the link a
// customer is emailed also the identifier a relay authenticates against.

import { serverApiUrl } from '@/lib/api-url';
import type { CustomDomainView } from '@/lib/domains';

export interface InstallData {
  applicationName: string;
  publisherName: string;
  customerName: string;
  region: string;
  /** §44 "Deployz will create" list, e.g. ["Application runtime", "PostgreSQL database", ...]. */
  resourcesCreated: string[];
  /**
   * CloudFormation Quick Create deep-link for THIS deployment, built by the
   * control plane: it owns the published template URL, the deployment's
   * region and the single-use enrollment code. Null when no bootstrap
   * template is published yet.
   */
  quickCreateUrl: string | null;
  /** True once a relay has enrolled — the link has already been used. */
  alreadyInstalled: boolean;
  /** The deployment this install link names — needed once installed, to scope the domain card. */
  deploymentId: string;
  deploymentState: string;
  /** This deployment's active custom domain, if any. */
  domain: CustomDomainView | null;
  /** The CNAME target a customer without a custom domain yet would point at. */
  routingTarget: string | null;
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
