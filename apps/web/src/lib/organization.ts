// Organization data access for the settings page. The organization API
// endpoint arrives in a later todo; until then fetchOrganization falls back
// to realistic FIXTURE data on a 404 (same pattern as todos 19/25/26/30).

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export type OrgPlan = 'FREE' | 'STARTER' | 'PRO';
export type StripeStatus = 'ACTIVE' | 'TRIALING' | 'NONE';

export interface OrganizationInfo {
  id: string;
  name: string;
  slug: string;
  plan: OrgPlan;
  stripeStatus: StripeStatus;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Organization request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.includes('(404)');
}

export async function fetchOrganization(): Promise<OrganizationInfo> {
  try {
    return await getJson<OrganizationInfo>('/api/organization');
  } catch (error) {
    if (isNotFound(error)) return FIXTURE_ORGANIZATION;
    throw error;
  }
}

export const PLAN_LABELS: Record<OrgPlan, string> = {
  FREE: 'Free',
  STARTER: 'Starter',
  PRO: 'Pro',
};

export const STRIPE_STATUS_LABELS: Record<StripeStatus, string> = {
  ACTIVE: 'Active',
  TRIALING: 'Trialing',
  NONE: 'None',
};

export const FIXTURE_ORGANIZATION: OrganizationInfo = {
  id: 'org-fixture',
  name: 'Acme Inc',
  slug: 'acme-inc',
  plan: 'STARTER',
  stripeStatus: 'ACTIVE',
};
