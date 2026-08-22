// §41 screen 18 organization settings — data access. Wired to the real
// `GET/PATCH /api/organization` endpoints (§34): {id, name, plan, createdAt}.
// No fixture fallback — a failure here is a real failure, not a loading state.

import { cookies } from 'next/headers';

const apiUrl = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export type OrgPlan = 'FREE' | 'STARTER' | 'PRO';

export interface OrganizationInfo {
  id: string;
  name: string;
  plan: OrgPlan;
  createdAt: string;
}

async function getJson<T>(path: string): Promise<T> {
  const cookieHeader = (await cookies()).toString();
  const response = await fetch(`${apiUrl}${path}`, {
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

export const PLAN_LABELS: Record<OrgPlan, string> = {
  FREE: 'Free',
  STARTER: 'Starter',
  PRO: 'Pro',
};
