// Customer data access and the Customers-list rollup.
//
// The customer id is the only anchor: every fetch, edit and delete below
// addresses a customer by its immutable id, and deployments are joined to a
// customer by `deployment.customerId`. Email and name are contact metadata
// that the vendor can change at any time without anything else moving.

import {
  CUSTOMER_DEPLOYMENT_STATUS_BADGE,
  CUSTOMER_DEPLOYMENT_STATUS_LABELS,
  type CustomerDeploymentRollup,
  type DeploymentBadgeVariant,
} from '@deployz/copy-map';

import { apiRequest } from '@/lib/api-client';
import type { FleetDeployment } from '@/lib/deployments';
import { attentionReason } from '@/lib/home-state';

export interface Customer {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  company: string | null;
  externalReference: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Contact metadata — the only customer fields a vendor can edit. */
export interface CustomerContactInput {
  name: string;
  email: string;
  company: string | null;
}

export async function fetchCustomers(): Promise<Customer[]> {
  const body = await apiRequest<{ customers?: Customer[] }>('/api/customers');
  return body.customers ?? [];
}

export function fetchCustomer(id: string): Promise<Customer> {
  return apiRequest<Customer>(`/api/customers/${encodeURIComponent(id)}`);
}

/** Update contact metadata. Never reissues an install link or moves a
 *  deployment — the API updates three text columns and nothing else. */
export function updateCustomer(id: string, input: CustomerContactInput): Promise<Customer> {
  return apiRequest<Customer>(`/api/customers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { name: input.name, email: input.email, company: input.company },
  });
}

/** Remove a customer record. The API refuses a customer that has any
 *  deployment, so this can never remove anything from an AWS account. */
export function deleteCustomer(id: string): Promise<void> {
  return apiRequest<void>(`/api/customers/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ── Deployment rollup ───────────────────────────────────────────────────────

/**
 * One customer's deployment answer for the list: the rollup status, the
 * deployment it was read from, and the install link to copy. Built entirely
 * from the fleet rows the API already returns — the §46 `state`, the
 * server-derived `deploymentStatus.stage`, and `attentionReason`, which the
 * homepage and the fleet list already classify with.
 */
export interface CustomerDeployment {
  status: CustomerDeploymentRollup;
  label: string;
  badge: DeploymentBadgeVariant;
  /** The deployment this status was read from, or null when there is none. */
  deployment: FleetDeployment | null;
  /** All of this customer's deployments, newest activity first. */
  deployments: FleetDeployment[];
  /** When this customer's deployments last changed, or null if never. */
  lastActivityAt: string | null;
}

/** Most actionable first: what the vendor should look at is what the row
 *  shows, and which deployment a single-destination action opens. */
const ROLLUP_RANK: Record<CustomerDeploymentRollup, number> = {
  NEEDS_ATTENTION: 0,
  INSTALLING: 1,
  LIVE: 2,
  NOT_INSTALLED: 3,
  REMOVING: 4,
  REMOVED: 5,
};

/**
 * One deployment's §46 state, said the way the Customers list says it.
 *
 * The §46 `state` is the anchor — the same column the fleet list badges — not
 * the derived progress stage: a deployment can be HEALTHY while its stage is
 * still VERIFYING (READY additionally waits on HTTPS), and a customer whose
 * application is up must read as Live, not as still installing. Attention is
 * the one overlay on top, from the same `attentionReason` the homepage and the
 * fleet list classify with. An update in flight stays under Installing: the
 * screen is operational, and "work is happening here" is the useful answer.
 */
function rollupFor(deployment: FleetDeployment): CustomerDeploymentRollup {
  if (deployment.state === 'DELETED') return 'REMOVED';
  if (deployment.state === 'DELETING') return 'REMOVING';
  if (attentionReason(deployment) !== null) return 'NEEDS_ATTENTION';
  if (deployment.state === 'NOT_INSTALLED') return 'NOT_INSTALLED';
  if (deployment.state === 'HEALTHY' || deployment.state === 'UPDATE_AVAILABLE') return 'LIVE';
  return 'INSTALLING';
}

function activityAt(deployment: FleetDeployment): string {
  return deployment.deploymentStatus.updatedAt;
}

/** Roll one customer's deployments up into the single answer the list shows. */
export function customerDeployment(deployments: FleetDeployment[]): CustomerDeployment {
  const sorted = [...deployments].sort(
    (a, b) => Date.parse(activityAt(b)) - Date.parse(activityAt(a)),
  );
  const primary =
    [...sorted].sort((a, b) => ROLLUP_RANK[rollupFor(a)] - ROLLUP_RANK[rollupFor(b)])[0] ?? null;
  const status = primary ? rollupFor(primary) : 'NOT_INSTALLED';
  return {
    status,
    label: CUSTOMER_DEPLOYMENT_STATUS_LABELS[status],
    badge: CUSTOMER_DEPLOYMENT_STATUS_BADGE[status],
    deployment: primary,
    deployments: sorted,
    lastActivityAt: sorted[0] ? activityAt(sorted[0]) : null,
  };
}

/** Group fleet rows by the customer id they belong to. */
export function deploymentsByCustomer(
  deployments: FleetDeployment[],
): Map<string, FleetDeployment[]> {
  const grouped = new Map<string, FleetDeployment[]>();
  for (const deployment of deployments) {
    const existing = grouped.get(deployment.customerId);
    if (existing) existing.push(deployment);
    else grouped.set(deployment.customerId, [deployment]);
  }
  return grouped;
}

/**
 * The deployment "View deployment" should open, or null when there is no
 * unambiguous destination — with several live deployments the customer page
 * is the honest answer, so the caller falls back to it.
 */
export function singleDeploymentDestination(rollup: CustomerDeployment): FleetDeployment | null {
  const live = rollup.deployments.filter((deployment) => deployment.state !== 'DELETED');
  if (live.length === 1) return live[0]!;
  if (live.length === 0 && rollup.deployments.length === 1) return rollup.deployments[0]!;
  return null;
}

// ── Install links ───────────────────────────────────────────────────────────

/**
 * The customer's install URL. Reading it is a pure read of the deployment's
 * existing `installLinkId` — copying a link never mints, rotates or revokes
 * one.
 */
export function installLinkUrl(deployment: FleetDeployment, origin: string): string {
  return `${origin}/install/${deployment.installLinkId}`;
}

/** The install link to offer for a customer: the one non-removed deployment's,
 *  or none when the customer has no deployment to install. */
export function installLinkDeployment(rollup: CustomerDeployment): FleetDeployment | null {
  return rollup.deployments.find((deployment) => deployment.state !== 'DELETED') ?? null;
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatDate(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Matches a customer against the list's search box: name, email, company. */
export function matchesCustomerSearch(customer: Customer, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (needle === '') return true;
  return `${customer.name} ${customer.email} ${customer.company ?? ''}`
    .toLowerCase()
    .includes(needle);
}
