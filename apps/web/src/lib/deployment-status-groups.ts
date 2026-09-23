// One place that says what a deployment's status means to the vendor, so the
// Deployments badge, its status filter, the default sort and the Customers
// summary cannot drift apart.
//
// Two layers, kept apart on purpose:
//  - the precise status of ONE deployment (`deploymentDisplayStatus`): a
//    specific label such as "Starting application" or "Lost contact", and the
//    coarse filter group it belongs to;
//  - the customer-level bucket a deployment counts toward
//    (`customerBucket`), which the Customers list aggregates.
// Both are derived at read time from the §46 `state` and the columns the fleet
// API already returns. Nothing here is persisted and no raw AWS status reaches
// a label.

import type { DeploymentStep } from '@deployz/contracts';

import {
  DEPLOYMENT_STATE_LABELS,
  type DeploymentBadgeVariant,
} from '@/lib/deployment-vocabulary';
import type { FleetDeployment } from '@/lib/deployments';
import { attentionReason } from '@/lib/home-state';

// ── Filter groups ───────────────────────────────────────────────────────────

/** Ordered by operational priority — a group's index is its default-sort rank:
 *  what needs the vendor first, removed last. */
export const STATUS_GROUPS = [
  'attention',
  'in-progress',
  'waiting',
  'update-available',
  'healthy',
  'removed',
] as const;

export type StatusGroup = (typeof STATUS_GROUPS)[number];

export const STATUS_GROUP_LABELS: Record<StatusGroup, string> = {
  attention: 'Needs attention',
  'in-progress': 'In progress',
  waiting: 'Waiting for customer',
  'update-available': 'Update available',
  healthy: 'Healthy',
  removed: 'Removed',
};

/** The order the status filter lists its options in. */
export const STATUS_FILTER_GROUPS: readonly StatusGroup[] = [
  'healthy',
  'in-progress',
  'attention',
  'waiting',
  'update-available',
  'removed',
];

export function isStatusGroup(value: string): value is StatusGroup {
  return (STATUS_GROUPS as readonly string[]).includes(value);
}

export function statusGroupRank(group: StatusGroup): number {
  return STATUS_GROUPS.indexOf(group);
}

// ── Precise per-deployment status ───────────────────────────────────────────

export interface DeploymentDisplayStatus {
  group: StatusGroup;
  label: string;
  badge: DeploymentBadgeVariant;
}

/** What an install in flight is doing, in the words the row can afford. */
const INSTALL_STEP_LABEL: Partial<Record<DeploymentStep, string>> = {
  RELAY_CONNECT: 'Connecting',
  PREPARING: 'Provisioning',
  NETWORK: 'Provisioning',
  DATABASE_STORAGE: 'Provisioning',
  REDIS: 'Provisioning',
  MIGRATION: 'Running migrations',
  APPLICATION: 'Starting application',
  HEALTH_CHECK: 'Checking health',
  TLS: 'Preparing secure access',
};

// Mirrors `attentionReason`'s own order, so the label names the same cause the
// homepage and the customer summary count.
function attentionStatus(deployment: FleetDeployment): DeploymentDisplayStatus {
  if (deployment.state === 'FAILED') {
    return { group: 'attention', label: 'Failed', badge: 'destructive' };
  }
  if (deployment.state === 'DISCONNECTED') {
    return { group: 'attention', label: 'Disconnected', badge: 'destructive' };
  }
  if (deployment.relayStatus === 'DISCONNECTED') {
    return { group: 'attention', label: 'Lost contact', badge: 'destructive' };
  }
  if (deployment.healthStatus === 'UNHEALTHY') {
    return { group: 'attention', label: 'Unhealthy', badge: 'destructive' };
  }
  return { group: 'attention', label: 'Degraded', badge: 'warning' };
}

/**
 * The precise status one deployment row shows, and the group the status
 * filter puts it under. The §46 `state` is the anchor; attention is the one
 * overlay on top (a HEALTHY deployment whose relay went quiet reads "Lost
 * contact"). A state this build does not know is surfaced as attention rather
 * than hidden or passed off as healthy.
 */
export function deploymentDisplayStatus(deployment: FleetDeployment): DeploymentDisplayStatus {
  // Removal first: a deployment on its way out is neither healthy nor failing.
  if (deployment.state === 'DELETED') {
    return { group: 'removed', label: 'Removed', badge: 'secondary' };
  }
  if (deployment.state === 'DELETING') {
    return { group: 'in-progress', label: 'Removing', badge: 'info' };
  }
  if (attentionReason(deployment) !== null) return attentionStatus(deployment);

  switch (deployment.state as string) {
    case 'NOT_INSTALLED':
      return { group: 'waiting', label: 'Waiting for customer', badge: 'secondary' };
    case 'WAITING_FOR_RELAY':
      return {
        group: 'waiting',
        label: DEPLOYMENT_STATE_LABELS.WAITING_FOR_RELAY,
        badge: 'secondary',
      };
    case 'INSTALLING': {
      // Older API builds send no `step`; fall back to the state's own label.
      const step = deployment.deploymentStatus?.step as DeploymentStep | undefined;
      return {
        group: 'in-progress',
        label: (step && INSTALL_STEP_LABEL[step]) ?? DEPLOYMENT_STATE_LABELS.INSTALLING,
        badge: 'info',
      };
    }
    case 'UPDATING':
      return { group: 'in-progress', label: DEPLOYMENT_STATE_LABELS.UPDATING, badge: 'info' };
    case 'UPDATE_AVAILABLE':
      return {
        group: 'update-available',
        label: DEPLOYMENT_STATE_LABELS.UPDATE_AVAILABLE,
        badge: 'secondary',
      };
    case 'HEALTHY':
      return { group: 'healthy', label: DEPLOYMENT_STATE_LABELS.HEALTHY, badge: 'success' };
    default:
      return { group: 'attention', label: 'Unknown status', badge: 'warning' };
  }
}

// ── Customer-level buckets ──────────────────────────────────────────────────

export const CUSTOMER_BUCKETS = ['active', 'attention', 'pending', 'removing', 'removed'] as const;

export type CustomerBucket = (typeof CUSTOMER_BUCKETS)[number];

/**
 * What one deployment counts as on the Customers list. Derived from the same
 * classification the Deployments list uses, so a customer whose deployment
 * reads "Failed" there is "needs attention" here. A live app being updated is
 * still active; setup that has not finished — including one the customer has
 * not started — is pending.
 */
export function customerBucket(deployment: FleetDeployment): CustomerBucket {
  if (deployment.state === 'DELETED') return 'removed';
  if (deployment.state === 'DELETING') return 'removing';
  const { group } = deploymentDisplayStatus(deployment);
  if (group === 'attention') return 'attention';
  if (group === 'healthy' || group === 'update-available') return 'active';
  if (deployment.state === 'UPDATING') return 'active';
  return 'pending';
}

/** The badge each bucket's count wears in the Customers summary. */
export const CUSTOMER_BUCKET_BADGE: Record<CustomerBucket, DeploymentBadgeVariant> = {
  active: 'success',
  attention: 'warning',
  pending: 'secondary',
  removing: 'secondary',
  removed: 'secondary',
};
