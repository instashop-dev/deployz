// §41 screen 18 organization settings + team management — server-side data
// access. Wired to the real control-plane endpoints; no fixture fallback — a
// failure here is a real failure, not a loading state.
//
// SERVER ONLY (`next/headers`). Types and copy live in
// organization-vocabulary.ts, which client components import instead.

import { cookies } from 'next/headers';

import type {
  InvitationInfo,
  MemberInfo,
  OrganizationInfo,
  OrganizationSummary,
} from './organization-vocabulary';

import { serverApiUrl } from '@/lib/api-url';

async function getJson<T>(path: string): Promise<T> {
  const cookieHeader = (await cookies()).toString();
  const response = await fetch(`${serverApiUrl()}${path}`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Organization request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export async function fetchOrganization(): Promise<OrganizationInfo> {
  return getJson<OrganizationInfo>('/api/organization');
}

export async function fetchOrganizations(): Promise<OrganizationSummary[]> {
  const { organizations } = await getJson<{ organizations: OrganizationSummary[] }>(
    '/api/organizations',
  );
  return organizations;
}

export async function fetchMembers(): Promise<MemberInfo[]> {
  const { members } = await getJson<{ members: MemberInfo[] }>('/api/organization/members');
  return members;
}

export async function fetchInvitations(): Promise<InvitationInfo[]> {
  const { invitations } = await getJson<{ invitations: InvitationInfo[] }>(
    '/api/organization/invitations',
  );
  return invitations;
}
