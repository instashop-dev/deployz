// Custom-domains MVP — client for the deployment-scoped and install-link-
// scoped `/domain` endpoints, plus the copy maps the domain panel renders.
// Wire shape: every endpoint returns `{ domain: <view|null> }`; mutations
// route through apiRequest so a thrown ApiRequestError carries the server's
// spec copy (§65) as its .message.

import { apiRequest, ApiRequestError } from '@/lib/api-client';
import { apiUrl } from '@/lib/api-url';

// ── Wire shapes ────────────────────────────────────────────────────────────

export type CustomDomainStatus =
  | 'pending'
  | 'waiting_for_dns'
  | 'configuring'
  | 'active'
  | 'error'
  | 'removing';

export interface DnsRecordView {
  purpose: 'verification' | 'routing';
  type: 'CNAME';
  name: string;
  value: string;
}

export interface CustomDomainView {
  hostname: string;
  status: CustomDomainStatus;
  records: DnsRecordView[];
  error: string | null;
  url: string | null;
}

// ── Copy (§65) ───────────────────────────────────────────────────────────

export const DOMAIN_STATUS_LABEL: Record<CustomDomainStatus, string> = {
  pending: 'Setting up',
  waiting_for_dns: 'Waiting for DNS',
  configuring: 'Connecting',
  active: 'Active',
  error: 'Needs attention',
  removing: 'Removing',
};

const GENERIC_ERROR_COPY = {
  title: "We couldn't connect this domain",
  body: 'Check the DNS records and try again.',
};

const DOMAIN_ERROR_COPY: Record<string, { title: string; body: string }> = {
  DNS_VALIDATION_NOT_FOUND: {
    title: 'Verification record not found',
    body: "We couldn't find the required DNS record yet. Check that it matches exactly.",
  },
  DNS_ROUTING_MISMATCH: {
    title: "Domain isn't pointing to this deployment",
    body: 'Update the routing CNAME to the value shown below.',
  },
  AWS_PERMISSION_DENIED: {
    title: "Deployz couldn't configure HTTPS",
    body: "The connected AWS account doesn't currently allow Deployz to complete the domain setup.",
  },
  CONFIGURE_FAILED: GENERIC_ERROR_COPY,
  HTTPS_NOT_REACHABLE: GENERIC_ERROR_COPY,
  REMOVE_FAILED: GENERIC_ERROR_COPY,
};

/** §65 copy for a domain's `error` code. Unknown codes fall back to the
 *  generic connect-failure copy; `null` (no error) maps to `null`. */
export function domainErrorCopy(code: string | null): { title: string; body: string } | null {
  if (code === null) return null;
  return DOMAIN_ERROR_COPY[code] ?? GENERIC_ERROR_COPY;
}

// ── Deployment-scoped client (authenticated dashboard) ──────────────────────

/** GET /api/deployments/:id/domain. Read-only: 401/403/404 (no session, no
 *  membership, or a cross-org id) come back as `null` rather than throwing —
 *  the dashboard treats "can't see it" the same as "there isn't one". */
export async function fetchDomain(deploymentId: string): Promise<CustomDomainView | null> {
  try {
    const body = await apiRequest<{ domain: CustomDomainView | null }>(
      `/api/deployments/${encodeURIComponent(deploymentId)}/domain`,
    );
    return body.domain;
  } catch (error) {
    if (error instanceof ApiRequestError && isReadOnlyCode(error.code)) {
      return null;
    }
    throw error;
  }
}

function isReadOnlyCode(code: string): boolean {
  return code === 'UNAUTHORIZED' || code === 'FORBIDDEN' || code === 'NOT_FOUND';
}

/** POST /api/deployments/:id/domain — attach a custom domain (§65 "Add domain"). */
export function addDomain(deploymentId: string, hostname: string): Promise<CustomDomainView> {
  return apiRequest<{ domain: CustomDomainView }>(
    `/api/deployments/${encodeURIComponent(deploymentId)}/domain`,
    { method: 'POST', body: { hostname } },
  ).then((body) => body.domain);
}

/** POST /api/deployments/:id/domain/check — vendor "Check now". */
export function checkDomain(deploymentId: string): Promise<CustomDomainView> {
  return apiRequest<{ domain: CustomDomainView }>(
    `/api/deployments/${encodeURIComponent(deploymentId)}/domain/check`,
    { method: 'POST' },
  ).then((body) => body.domain);
}

/** DELETE /api/deployments/:id/domain — starts removal (status -> 'removing'). */
export function removeDomain(deploymentId: string): Promise<CustomDomainView | null> {
  return apiRequest<{ domain: CustomDomainView | null }>(
    `/api/deployments/${encodeURIComponent(deploymentId)}/domain`,
    { method: 'DELETE' },
  ).then((body) => body.domain);
}

// ── Install-link-scoped client (unauthenticated customer page) ──────────────
//
// Mirrors deployments.ts's local getJson/postJson convention rather than
// apiRequest: these routes carry no session, so there is no error envelope
// worth unwrapping into ApiRequestError — a non-ok response is just a
// request failure.

async function linkGetJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Domain request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

async function linkPostJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error(`Domain request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

/** POST /api/install/:installLinkId/domain/check — customer-facing "Check now". */
export function checkDomainByLink(installLinkId: string): Promise<CustomDomainView> {
  return linkPostJson<{ domain: CustomDomainView }>(
    `/api/install/${encodeURIComponent(installLinkId)}/domain/check`,
  ).then((body) => body.domain);
}

/** Re-GETs /api/install/:installLinkId and returns its `.domain` field
 *  (Task 10 adds `domain: view | null` to that payload). */
export async function fetchDomainByLink(installLinkId: string): Promise<CustomDomainView | null> {
  const body = await linkGetJson<{ domain?: CustomDomainView | null }>(
    `/api/install/${encodeURIComponent(installLinkId)}`,
  );
  return body.domain ?? null;
}
