// Public customer deploy-link data and flow calls. The secret token travels
// in the x-deployz-token header on every call — never in a request URL — so
// it does not leak into logs or referrers beyond the single shareable link
// itself. Mirrors install-data.ts / install-status.ts: a server-side fetch
// for the page's first paint and browser fetches for the client poll loop.

import type { CustomerDeploymentStatus } from '@deployz/contracts';

import { apiUrl, serverApiUrl } from '@/lib/api-url';
import type { CustomDomainView } from '@/lib/domains';
import { InstallRetryError } from '@/lib/install-data';

/** The secret half of a deploy link, as the /deploy page carries it. */
export interface DeployLinkToken {
  publicId: string;
  token: string;
}

export interface DeployLinkData {
  link: { status: 'active' };
  application: { name: string };
  customer: { name: string };
  region: string;
  /** §44 "Deployz will create" list, shared with the install page. */
  resources: string[];
  deploymentState: string;
  bootstrapStackName: string;
  waitingForRelay: boolean;
  relayStuck: boolean;
  quickCreateUrl: string | null;
  domain: CustomDomainView | null;
  /** The CNAME target a customer without a custom domain yet would point at. */
  routingTarget: string | null;
  status: CustomerDeploymentStatus;
}

export type DeployLinkResolve =
  | { ok: true; data: DeployLinkData }
  | { ok: false; reason: 'invalid' | 'revoked' | 'expired' | 'unavailable' };

/** Server-side resolve for the /deploy page's first paint. */
export async function fetchDeployLinkData(
  publicId: string,
  token: string,
): Promise<DeployLinkResolve> {
  const response = await fetch(
    `${serverApiUrl()}/api/deploy-links/${encodeURIComponent(publicId)}`,
    { cache: 'no-store', headers: { 'x-deployz-token': token } },
  );
  if (response.status === 404) return { ok: false, reason: 'invalid' };
  if (response.status === 410) {
    const payload: unknown = await response.json().catch(() => null);
    const code = (payload as { error?: { code?: string } } | null)?.error?.code;
    return { ok: false, reason: code === 'DEPLOY_LINK_EXPIRED' ? 'expired' : 'revoked' };
  }
  if (!response.ok) return { ok: false, reason: 'unavailable' };
  return { ok: true, data: (await response.json()) as DeployLinkData };
}

/** Server-side status for the initial paint. Null on ANY failure — the
 *  client poll loop is the real source of truth after hydration. */
export async function fetchDeployLinkStatusServer(
  publicId: string,
  token: string,
): Promise<CustomerDeploymentStatus | null> {
  try {
    const response = await fetch(statusUrl(publicId), {
      cache: 'no-store',
      headers: { 'x-deployz-token': token },
    });
    if (!response.ok) return null;
    return (await response.json()) as CustomerDeploymentStatus;
  } catch {
    return null;
  }
}

/** Browser fetch for the client poll loop. Throws on non-ok so
 *  useStatusPoll's own failure/backoff/staleness handling applies. */
export async function fetchDeployLinkStatus(
  publicId: string,
  token: string,
): Promise<CustomerDeploymentStatus> {
  const response = await fetch(statusUrl(publicId), {
    cache: 'no-store',
    headers: { 'x-deployz-token': token },
  });
  if (!response.ok) {
    throw new Error(`Deploy link status request failed (${response.status})`);
  }
  return (await response.json()) as CustomerDeploymentStatus;
}

function statusUrl(publicId: string): string {
  return `${apiUrl}/api/deploy-links/${encodeURIComponent(publicId)}/status`;
}

/** Best-effort launch signal — same rule as launchInstall: never blocks the
 *  handoff to the customer's own AWS console. */
export async function launchDeployLink(publicId: string, token: string): Promise<void> {
  try {
    await fetch(
      `${serverApiUrl()}/api/deploy-links/${encodeURIComponent(publicId)}/launched`,
      { method: 'POST', cache: 'no-store', headers: { 'x-deployz-token': token } },
    );
  } catch {
    // The customer still goes to AWS; the signal is not worth blocking on.
  }
}

/** The fresh-attempt response from POST /api/deploy-links/:id/retry. */
export interface RetryDeployLinkResult {
  state: 'NOT_INSTALLED';
  attemptNumber: number;
  bootstrapStackName: string;
  quickCreateUrl: string | null;
}

/** Customer-facing retry through the deploy link. 409
 *  INSTALL_ALREADY_SUCCEEDED when the deployment ever installed fine. */
export async function retryDeployLinkAttempt(
  publicId: string,
  token: string,
): Promise<RetryDeployLinkResult> {
  const response = await fetch(
    `${serverApiUrl()}/api/deploy-links/${encodeURIComponent(publicId)}/retry`,
    { method: 'POST', cache: 'no-store', headers: { 'x-deployz-token': token } },
  );
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const envelope = payload as { error?: { code?: string } } | null;
    throw new InstallRetryError(response.status, envelope?.error?.code ?? 'REQUEST_FAILED');
  }
  return (await response.json()) as RetryDeployLinkResult;
}

/** POST /api/deploy-links/:publicId/domain/check — customer-facing "Check now". */
export async function checkDomainByDeployLink(
  publicId: string,
  token: string,
): Promise<CustomDomainView> {
  const response = await fetch(
    `${apiUrl}/api/deploy-links/${encodeURIComponent(publicId)}/domain/check`,
    { method: 'POST', cache: 'no-store', headers: { 'x-deployz-token': token } },
  );
  if (!response.ok) {
    throw new Error(`Domain request failed (${response.status})`);
  }
  const body = (await response.json()) as { domain: CustomDomainView };
  return body.domain;
}

/** Re-GETs the resolve payload and returns its `.domain` field. */
export async function fetchDomainByDeployLink(
  publicId: string,
  token: string,
): Promise<CustomDomainView | null> {
  const resolve = await fetchDeployLinkData(publicId, token);
  return resolve.ok ? resolve.data.domain : null;
}
