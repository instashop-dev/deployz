import { cookies } from 'next/headers';

import type { OrgRole, OrganizationSummary } from './organization-vocabulary';

export interface Me {
  user: { id: string; name: string; email: string; image: string | null };
  organization: { id: string; name: string; slug: string } | null;
  /** The user's role in the active organization, null when they have none. */
  role: OrgRole | null;
  /** Every organization the user belongs to — the tenant switcher's data. */
  organizations: OrganizationSummary[];
}

import { serverApiUrl } from '@/lib/api-url';

// Server-side session resolution: forward the incoming request's cookies to
// the control-plane API. Returns null when the session is absent or invalid.
export async function fetchMe(): Promise<Me | null> {
  const cookieHeader = (await cookies()).toString();
  const response = await fetch(`${serverApiUrl()}/api/me`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
    cache: 'no-store',
  });
  if (!response.ok) {
    return null;
  }
  return (await response.json()) as Me;
}

export interface PendingInvitation {
  id: string;
  organizationName: string;
  role: string;
  expiresAt: string;
}

/** Live invitations addressed to the signed-in user, across every tenant. */
export async function fetchMyInvitations(): Promise<PendingInvitation[]> {
  const cookieHeader = (await cookies()).toString();
  const response = await fetch(`${serverApiUrl()}/api/invitations`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
    cache: 'no-store',
  });
  if (!response.ok) {
    return [];
  }
  const { invitations } = (await response.json()) as { invitations: PendingInvitation[] };
  return invitations;
}

export interface PublicInvitation {
  id: string;
  email: string;
  role: string;
  status: 'pending' | 'accepted' | 'rejected' | 'canceled' | 'expired';
  organizationName: string;
  inviterName: string;
  expiresAt: string;
}

/** The invitation as its recipient sees it. Unauthenticated: the invitee may
 *  not have an account yet. Returns null when the link is unknown. */
export async function fetchPublicInvitation(id: string): Promise<PublicInvitation | null> {
  const response = await fetch(`${serverApiUrl()}/api/invitations/${encodeURIComponent(id)}`, {
    cache: 'no-store',
  });
  if (!response.ok) {
    return null;
  }
  return (await response.json()) as PublicInvitation;
}
