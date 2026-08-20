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

// ── §65 event-type labels (§40 families) ──────────────────────────────────

/** The 6 §40 event families (§65): install/deploy/rollback/config/destroy/health. */
export const EVENT_FAMILIES = [
  'install',
  'deploy',
  'rollback',
  'config',
  'destroy',
  'health',
] as const;

export type EventFamily = (typeof EVENT_FAMILIES)[number];

/** First dot-segment of an event type, if it is one of the 6 families. */
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

  'config.validate': 'Configuration checked',
  'config.write': 'Configuration updated',
  'config.health': 'Health check after configuration change',
  'config.state.healthy': 'Configuration applied',
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
  if (result === 'ok' || result === 'passed') return 'Succeeded';
  if (result === 'skipped') return 'Skipped';
  if (result.startsWith('failed')) return 'Failed';
  return result;
}
