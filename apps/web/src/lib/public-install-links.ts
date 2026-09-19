// Public install link data access (vendor side). A public install link is an
// app-level, credential-free URL: any customer who holds it can review the
// offer and install the application into their own AWS account. The URL
// carries no secret, so — unlike deploy links — it stays copyable for as
// long as the link is live.

import { apiRequest } from '@/lib/api-client';

export type PublicInstallLinkStatus = 'active' | 'disabled' | 'revoked';

export interface PublicInstallLinkView {
  id: string;
  url: string;
  status: PublicInstallLinkStatus;
  createdAt: string;
  revokedAt: string | null;
}

/** The create/regenerate response — the only routes that carry the snippet. */
export interface PublicInstallLinkCreated {
  id: string;
  url: string;
  htmlSnippet: string;
  enabled: boolean;
  createdAt: string;
}

export function createPublicInstallLink(
  applicationId: string,
): Promise<PublicInstallLinkCreated> {
  return apiRequest<PublicInstallLinkCreated>(
    `/api/applications/${encodeURIComponent(applicationId)}/public-install-links`,
    { method: 'POST' },
  );
}

export async function fetchPublicInstallLinks(
  applicationId: string,
): Promise<PublicInstallLinkView[]> {
  const body = await apiRequest<{ links?: PublicInstallLinkView[] }>(
    `/api/applications/${encodeURIComponent(applicationId)}/public-install-links`,
  );
  return body.links ?? [];
}

export function setPublicInstallLinkEnabled(
  linkId: string,
  enabled: boolean,
): Promise<{ link: PublicInstallLinkView }> {
  return apiRequest<{ link: PublicInstallLinkView }>(
    `/api/public-install-links/${encodeURIComponent(linkId)}/${enabled ? 'enable' : 'disable'}`,
    { method: 'POST' },
  );
}

export function revokePublicInstallLink(linkId: string): Promise<{ link: PublicInstallLinkView }> {
  return apiRequest<{ link: PublicInstallLinkView }>(
    `/api/public-install-links/${encodeURIComponent(linkId)}/revoke`,
    { method: 'POST' },
  );
}

export function regeneratePublicInstallLink(
  linkId: string,
): Promise<PublicInstallLinkCreated> {
  return apiRequest<PublicInstallLinkCreated>(
    `/api/public-install-links/${encodeURIComponent(linkId)}/regenerate`,
    { method: 'POST' },
  );
}

/**
 * The fixed HTML snippet for a link URL — mirrors the API's server-built
 * `publicInstallHtmlSnippet` (constant anchor text, only the URL is
 * interpolated) so the copy button also works for a link loaded from the
 * list, which does not carry the snippet. A snippet the server returned in
 * this session is always preferred and copied verbatim.
 */
export function publicInstallHtmlSnippet(url: string): string {
  return `<a href="${url}">Deploy to AWS with Deployz</a>`;
}

/** Badge label + shadcn variant for a link status. */
export function publicInstallLinkStatusBadge(status: PublicInstallLinkStatus): {
  label: string;
  variant: 'success' | 'secondary';
} {
  if (status === 'active') return { label: 'Active', variant: 'success' };
  if (status === 'disabled') return { label: 'Disabled', variant: 'secondary' };
  return { label: 'Revoked', variant: 'secondary' };
}
