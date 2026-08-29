/**
 * §46 product vocabulary + §65 copy mapping for the fleet surfaces.
 *
 * The UI must use the 9 product-language deployment states (§46) and
 * human-readable event labels (§65) — NEVER raw AWS/CFN/ECS/ALB lifecycle
 * terms at the top level. This module is the single source of truth for the
 * state → label/badge and event-type → label mappings, so a copy sweep
 * (todo 34) can migrate it into packages/copy-map without touching pages.
 */

// ── §46 deployment states ─────────────────────────────────────────────────

/** The 9 product-vocabulary deployment states (§46). Mirrors the contracts enum. */
export const DEPLOYMENT_STATES = [
  'NOT_INSTALLED',
  'INSTALLING',
  'HEALTHY',
  'UPDATING',
  'UPDATE_AVAILABLE',
  'FAILED',
  'DISCONNECTED',
  'DELETING',
  'DELETED',
] as const;

export type DeploymentState = (typeof DEPLOYMENT_STATES)[number];

/** Human-readable §46 labels — the only user-facing status wording. */
export const DEPLOYMENT_STATE_LABELS: Record<DeploymentState, string> = {
  NOT_INSTALLED: 'Not installed',
  INSTALLING: 'Installing',
  HEALTHY: 'Healthy',
  UPDATING: 'Updating',
  UPDATE_AVAILABLE: 'Update available',
  FAILED: 'Failed',
  DISCONNECTED: 'Disconnected',
  DELETING: 'Deleting',
  DELETED: 'Deleted',
};

/** Badge variant per state (maps to the shadcn/ui Badge variants). */
export type DeploymentBadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline';

export const DEPLOYMENT_STATE_BADGE: Record<DeploymentState, DeploymentBadgeVariant> = {
  NOT_INSTALLED: 'secondary',
  INSTALLING: 'outline',
  HEALTHY: 'default',
  UPDATING: 'outline',
  UPDATE_AVAILABLE: 'secondary',
  FAILED: 'destructive',
  DISCONNECTED: 'destructive',
  DELETING: 'outline',
  DELETED: 'secondary',
};

export function deploymentStateLabel(state: string): string {
  return DEPLOYMENT_STATE_LABELS[state as DeploymentState] ?? state;
}

// ── Measured runtime health ─────────────────────────────────────────────────

import type { HealthStatus as WireHealthStatus } from './deployments';

export type HealthStatus = WireHealthStatus;

/** Measured-health labels — the only user-facing wording for health. */
export const HEALTH_STATUS_LABEL: Record<HealthStatus, string> = {
  HEALTHY: 'Healthy',
  DEGRADED: 'Degraded',
  UNHEALTHY: 'Unhealthy',
  UNKNOWN: 'Health unknown',
};

export const HEALTH_STATUS_BADGE: Record<HealthStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  HEALTHY: 'default',
  DEGRADED: 'outline',
  UNHEALTHY: 'destructive',
  UNKNOWN: 'secondary',
};

/**
 * Whether a lifecycle state carries a running application whose health is
 * worth reporting. Not-installed/deleted/failed deployments have nothing
 * running to measure — a FAILED deployment showing "Health unknown" reads as
 * "running, we just don't know how" when it isn't running at all.
 */
export function showHealthBadge(state: DeploymentState): boolean {
  return state !== 'NOT_INSTALLED' && state !== 'DELETED' && state !== 'FAILED';
}

/**
 * Whether a lifecycle state has per-component infrastructure worth listing.
 * Same reasoning as `showHealthBadge`, applied to the Infrastructure rows: a
 * failed, not-yet-installed, or deleted deployment has nothing running, so
 * per-component rows (often still carrying a stale HEALTHY/UNKNOWN reading
 * from before the failure) would repeat the same lie at row level.
 */
export function showInfrastructureRows(state: DeploymentState): boolean {
  return state !== 'NOT_INSTALLED' && state !== 'DELETED' && state !== 'FAILED';
}

// ── Relay connectivity + capability gating ─────────────────────────────────

import type { RelayCapabilities, RelayStatus as WireRelayStatus } from './deployments';

export type RelayStatus = WireRelayStatus;

/** Relay connectivity labels, shared by the fleet list and detail page. */
export const RELAY_STATUS_LABEL: Record<RelayStatus, string> = {
  CONNECTED: 'Relay online',
  DISCONNECTED: 'Relay offline',
  UNKNOWN: 'Relay not connected yet',
};

/** Day-2 actions gated on the installed relay advertising the capability. */
export type DeploymentAction = 'deploy' | 'rollback' | 'restart' | 'configUpdate' | 'disconnect';

const ACTION_CAPABILITY: Record<DeploymentAction, keyof RelayCapabilities> = {
  deploy: 'deployRelease',
  rollback: 'rollback',
  restart: 'restart',
  configUpdate: 'configUpdate',
  disconnect: 'destroy',
};

/**
 * Whether the installed relay advertised the capability an action needs.
 * Null capabilities (pre-capability relay) supports nothing — an enabled
 * button over a stub executor is worse than a disabled one.
 */
export function actionSupported(
  capabilities: RelayCapabilities | null,
  action: DeploymentAction,
): boolean {
  return capabilities !== null && capabilities[ACTION_CAPABILITY[action]] === true;
}

export const UNSUPPORTED_ACTION_COPY =
  'This action is not supported by the currently installed Deployz connector.';

/**
 * Whether `state` denotes a deployment that has completed at least one
 * install — as opposed to one that never has, either because it hasn't been
 * installed yet or because its only install attempt failed before a release
 * ever ran. `currentReleaseId` is the signal: the API only ever sets it once
 * a release has actually deployed, so a FAILED deployment that still carries
 * one failed later, after having run — not during its first install.
 *
 * Deploy/rollback/restart/config all act on a running application, so they
 * make no sense to offer here even when the relay has reported capabilities
 * (it can connect and advertise capabilities before an install completes).
 * Disconnect is deliberately NOT gated by this — a deployment that failed to
 * ever come up must still be removable.
 */
export function everInstalled(state: DeploymentState, currentReleaseId: string | null): boolean {
  if (state === 'NOT_INSTALLED') return false;
  if (state === 'FAILED') return currentReleaseId !== null;
  return true;
}

export const NOT_YET_RUNNING_ACTION_COPY =
  "This deployment hasn't completed an install yet, so these actions aren't available.";

// ── §65 event-type labels (§40 families) ──────────────────────────────────

/** The §40 event families (§65). Mirrors @deployz/copy-map verbatim. */
export const EVENT_FAMILIES = [
  'install',
  'deploy',
  'rollback',
  'config',
  'destroy',
  'health',
  'relay',
  'redis',
] as const;

export type EventFamily = (typeof EVENT_FAMILIES)[number];

/** First dot-segment of an event type, if it is one of the families. */
export function eventFamily(eventType: string): EventFamily | null {
  const family = eventType.split('.')[0];
  if (!family) return null;
  return (EVENT_FAMILIES as readonly string[]).includes(family)
    ? (family as EventFamily)
    : null;
}

const FAMILY_LABELS: Record<EventFamily, string> = {
  install: 'Installation',
  deploy: 'Update',
  rollback: 'Rollback',
  config: 'Configuration',
  destroy: 'Teardown',
  health: 'Health',
  relay: 'Helper',
  redis: 'Cache',
};

/**
 * Specific human-readable labels for the event types emitted by the durable
 * workflows (todos 13, 17, 18). Unknown types fall back to the family label
 * (§65: jargon-free, never raw).
 */
const EVENT_TYPE_LABELS: Record<string, string> = {
  'install.preflight.region': 'Region check',
  'install.preflight.scp': 'Account policy check',
  'install.relay.contact': 'First check-in from the helper',
  'install.state.installing': 'Installation started',
  'install.relay.health': 'First health report',
  'install.state.healthy': 'Installed and healthy',

  'deploy.preflight': 'Pre-deployment checks',
  'deploy.state.updating': 'Update started',
  'deploy.migration': 'Database migration',
  'deploy.ecs-update': 'New version deployed',
  'deploy.infra-upgrade': 'Infrastructure upgrade',
  'deploy.health': 'Health check after update',
  'deploy.state.healthy': 'Update complete',
  'deploy.state.update-available': 'Update available',

  'rollback.state.updating': 'Rollback started',
  'rollback.disclosure': 'Rollback scope',
  'rollback.restore': 'Previous version restored',
  'rollback.health': 'Health check after rollback',
  'rollback.state.healthy': 'Rolled back and healthy',

  // The vocabulary the API emits at its own transition points. The entries
  // below this block are the durable workflows' finer-grained vocabulary,
  // kept because those events are still the intended shape once the workflow
  // layer runs.
  'install.requested': 'Installation started',
  'install.completed': 'Installed and healthy',
  'install.failed': 'Installation failed',
  'install.enrollment.rejected': 'Another helper tried to connect',
  'deploy.requested': 'Update started',
  'deploy.completed': 'Update complete',
  'deploy.failed': 'Update failed',
  'rollback.requested': 'Rollback started',
  'rollback.completed': 'Rolled back',
  'rollback.failed': 'Rollback failed',
  'restart.requested': 'Restart started',
  'restart.completed': 'Restarted',
  'restart.failed': 'Restart failed',
  'destroy.requested': 'Removal started',
  'destroy.completed': 'Deployment removed',
  'destroy.failed': 'Removal failed',
  'deployment.reconciled': 'Running version corrected from AWS',
  'config.updated': 'Configuration updated',
  'health.reported': 'Health reported',
  'health.degraded': 'Health degraded',
  'health.unhealthy': 'Health critical',
  'health.recovered': 'Back to healthy',
  'ecs.rollout_failed': 'Deployment rollout failed',
  'relay.reenrollment.requested': 'Reconnect requested',

  'config.validate': 'Configuration checked',
  'config.write': 'Configuration updated',
  'config.health': 'Health check after configuration change',
  'config.state.healthy': 'Configuration applied',

  'redis.provision.started': 'Setting up cache',
  'redis.provision.succeeded': 'Cache ready',
  'redis.provision.failed': 'Cache setup failed',
};

/** Human-readable label for an event type (§65). */
export function eventTypeLabel(eventType: string): string {
  const specific = EVENT_TYPE_LABELS[eventType];
  if (specific) return specific;
  const family = eventFamily(eventType);
  if (family) return FAMILY_LABELS[family];
  return titleCase(eventType);
}

function titleCase(value: string): string {
  const last = value.split('.').pop() ?? value;
  return last
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── §62 event result labels ───────────────────────────────────────────────

/**
 * Human-readable label for an event `result` value. The raw result (which may
 * carry a §61 failure code referencing a service) stays behind the expandable
 * payload layer; the top level shows only this jargon-free label (§65).
 */
export function eventResultLabel(result: string | null): string | null {
  if (result === null) return null;
  // A historical request is a fact, not ongoing state — the event-type
  // label already says what happened, so no badge at all beats a "Pending"
  // that reads as in-progress forever.
  if (result === 'pending') return null;
  if (result === 'ok' || result === 'passed') return 'Succeeded';
  if (result === 'skipped') return 'Skipped';
  if (result.startsWith('failed')) return 'Failed';
  return result;
}

/**
 * The human-readable failure reason to show at the top level of a failed
 * event, if it carries one. Previously this text only ever reached the
 * customer inside the collapsed JSON payload disclosure — a vendor debugging
 * a stuck deployment had to know to open every event to find it. `null` when
 * the event did not fail, or failed without a non-empty `payload.error`
 * string worth surfacing.
 */
export function eventFailureReason(
  result: string | null,
  payload: Record<string, unknown>,
): string | null {
  if (result === null || !result.startsWith('failed')) return null;
  const error = payload['error'];
  return typeof error === 'string' && error.trim().length > 0 ? error : null;
}
