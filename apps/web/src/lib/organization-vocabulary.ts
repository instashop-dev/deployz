// Organization / membership vocabulary — shapes and §65 copy shared by the
// server pages and the client components. Kept apart from organization.ts
// (which reads `next/headers`) so a client component can import a role label
// without dragging server-only code into the browser bundle. Same split as
// deployment-vocabulary.ts vs deployments.ts.

export type SubscriptionStatus = 'ACTIVE' | 'PAST_DUE' | 'PAUSED' | 'CANCELED';

/** Membership roles. Exactly one owner per organization. */
export type OrgRole = 'owner' | 'admin' | 'member';

export interface OrganizationInfo {
  id: string;
  name: string;
  slug: string;
  subscriptionStatus: SubscriptionStatus | null;
  createdAt: string;
  role: OrgRole;
  memberCount: number;
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  subscriptionStatus: SubscriptionStatus | null;
  role: OrgRole;
  memberCount: number;
  createdAt: string;
}

export interface MemberInfo {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: OrgRole;
  createdAt: string;
}

export interface InvitationInfo {
  id: string;
  email: string;
  role: 'admin' | 'member';
  status: string;
  expired: boolean;
  expiresAt: string;
  createdAt: string;
  invitedByName: string;
}

export const SUBSCRIPTION_STATUS_LABELS: Record<SubscriptionStatus | 'EVALUATION', string> = {
  EVALUATION: 'Evaluating',
  ACTIVE: 'Active',
  PAST_DUE: 'Past due',
  PAUSED: 'Paused',
  CANCELED: 'Canceled',
};

/** `null` means the organization has no subscription yet (evaluation). */
export function subscriptionStatusLabel(status: SubscriptionStatus | null): string {
  return SUBSCRIPTION_STATUS_LABELS[status ?? 'EVALUATION'];
}

export const ROLE_LABELS: Record<OrgRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};

/** Roles that can be granted to someone else. Ownership moves by transfer. */
export const ASSIGNABLE_ROLES: readonly ('admin' | 'member')[] = ['admin', 'member'];

export function canManageTeam(role: OrgRole): boolean {
  return role === 'owner' || role === 'admin';
}
