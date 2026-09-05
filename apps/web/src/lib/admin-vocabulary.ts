/**
 * Team Admin-only vocabulary (docs/admin/team-admin.md) — connection states,
 * the STUCK presentation, and admin.* audit event labels. Same `*_LABELS` /
 * `*_BADGE` Record pattern as deployment-vocabulary.ts; jargon-free per §65
 * (raw AWS/CFN detail stays behind "Technical details" on the pages that use
 * this module).
 */

import type { ConnectionState, VendorConnection } from '@/lib/admin';
import { HEALTH_STATUS_DOT } from '@/lib/deployment-vocabulary';
import { FAILURE_CODES, failureCodeCopy } from '@/lib/diagnostic-vocabulary';

// ── Per-deployment connection state ─────────────────────────────────────────

export type AdminBadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline';

export const CONNECTION_STATE_LABEL: Record<ConnectionState, string> = {
  CONNECTED: 'Connected',
  DEGRADED: 'Degraded',
  DISCONNECTED: 'Disconnected',
  BOOTSTRAP_INCOMPLETE: 'Setup incomplete',
  UNKNOWN: 'Unknown',
};

export const CONNECTION_STATE_BADGE: Record<ConnectionState, AdminBadgeVariant> = {
  CONNECTED: 'default',
  DEGRADED: 'outline',
  DISCONNECTED: 'destructive',
  BOOTSTRAP_INCOMPLETE: 'secondary',
  UNKNOWN: 'secondary',
};

export const CONNECTION_STATE_DOT: Record<ConnectionState, string> = {
  CONNECTED: 'bg-primary',
  // Reuses deployment-vocabulary.ts's DEGRADED tone — the one sanctioned raw
  // Tailwind color for a status with no semantic theme token (docs/ui-system.md).
  DEGRADED: HEALTH_STATUS_DOT.DEGRADED,
  DISCONNECTED: 'bg-destructive',
  BOOTSTRAP_INCOMPLETE: 'bg-muted-foreground',
  UNKNOWN: 'bg-muted-foreground',
};

/**
 * The actionable problem callout for a connection detail page — what the
 * state means and what usually fixes it. CONNECTED carries no entry: the
 * page simply omits the callout when there is nothing to report.
 */
export const CONNECTION_STATE_PROBLEM: Record<
  Exclude<ConnectionState, 'CONNECTED'>,
  { heading: string; body: string }
> = {
  DEGRADED: {
    heading: 'The connection has gone quiet',
    body: 'The relay was last connected, but it has not checked in recently. This usually clears on its own within a few minutes; if it does not, the relay process in the customer account may have stopped.',
  },
  DISCONNECTED: {
    heading: 'Deployz cannot reach this account',
    body: 'The relay has not checked in and is considered offline. Recovery actions that require the relay (retry, rollback) will not run until it reconnects — resetting the relay issues a fresh connection link for the customer.',
  },
  BOOTSTRAP_INCOMPLETE: {
    heading: 'Setup was never finished',
    body: 'The customer has not completed the AWS setup step yet, so no relay has ever connected. Nothing is wrong — this deployment is waiting on the customer.',
  },
  UNKNOWN: {
    heading: 'Connection state is unclear',
    body: 'Deployz has not observed enough signal from this deployment to classify its connection. This is normal shortly after creation.',
  },
};

/** Vendor-list connection summary — the worst relay status across a vendor's deployments. */
export const VENDOR_CONNECTION_LABEL: Record<VendorConnection, string> = {
  CONNECTED: 'Connected',
  DISCONNECTED: 'Disconnected',
  NONE: 'No deployments',
  UNKNOWN: 'Unknown',
};

export const VENDOR_CONNECTION_BADGE: Record<VendorConnection, AdminBadgeVariant> = {
  CONNECTED: 'default',
  DISCONNECTED: 'destructive',
  NONE: 'secondary',
  UNKNOWN: 'secondary',
};

// ── STUCK presentation (shared job/deployment flag) ─────────────────────────

export const STUCK_LABEL = 'Stuck';
export const STUCK_BADGE: AdminBadgeVariant = 'destructive';
export const STUCK_EXPLANATION =
  'This has not made progress in longer than expected for its type and may need a recovery action.';

// ── §39 job state presentation (admin lists show a distinct Stuck state) ───

export type AdminJobPresentationState = 'QUEUED' | 'RUNNING' | 'STUCK' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

/** Collapses a job's raw state + the derived `stuck` flag into one badge
 *  state — STUCK always wins over its underlying active state, so a list
 *  never shows both "Running" and "Stuck" for the same row. */
export function jobPresentationState(state: string, stuck: boolean): AdminJobPresentationState {
  if (stuck) return 'STUCK';
  if (state === 'REQUESTED' || state === 'QUEUED') return 'QUEUED';
  if (state === 'WAITING' || state === 'RUNNING') return 'RUNNING';
  if (state === 'SUCCEEDED' || state === 'SUCCESS') return 'SUCCEEDED';
  if (state === 'CANCELLED') return 'CANCELLED';
  return 'FAILED';
}

export const JOB_PRESENTATION_LABEL: Record<AdminJobPresentationState, string> = {
  QUEUED: 'Queued',
  RUNNING: 'Running',
  STUCK: STUCK_LABEL,
  SUCCEEDED: 'Succeeded',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

export const JOB_PRESENTATION_BADGE: Record<AdminJobPresentationState, AdminBadgeVariant> = {
  QUEUED: 'secondary',
  RUNNING: 'outline',
  STUCK: STUCK_BADGE,
  SUCCEEDED: 'default',
  FAILED: 'destructive',
  CANCELLED: 'secondary',
};

// ── Application analysis / compatibility (vendor 360° Applications table) ──

export const ANALYSIS_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Pending',
  ANALYZING: 'Analyzing',
  COMPLETE: 'Complete',
  FAILED: 'Failed',
};

export const COMPATIBILITY_STATUS_LABEL: Record<string, string> = {
  READY: 'Ready',
  NEEDS_ATTENTION: 'Needs attention',
  NOT_COMPATIBLE: 'Not compatible',
};

export function analysisStatusLabel(status: string): string {
  return ANALYSIS_STATUS_LABEL[status] ?? status;
}

export function compatibilityStatusLabel(status: string | null): string | null {
  if (status === null) return null;
  return COMPATIBILITY_STATUS_LABEL[status] ?? status;
}

// ── admin.* audit event labels ──────────────────────────────────────────────

/**
 * Human-readable labels for the admin.* event_logs types this feature emits
 * (docs/admin/team-admin.md's "Supported admin actions" + support-session
 * lifecycle). Unknown admin.* types fall back to a family-derived label so a
 * newly added action never renders as a raw dotted string.
 */
const ADMIN_EVENT_TYPE_LABELS: Record<string, string> = {
  'admin.support_session.started': 'Started viewing as vendor',
  'admin.support_session.ended': 'Stopped viewing as vendor',
  'admin.install.retry_requested': 'Retried install',
  'admin.rollback.requested': 'Requested rollback',
  'admin.destroy.force_completed': 'Force-completed disconnect',
  'admin.relay.reset_requested': 'Reset relay connection',
};

function adminEventFamilyLabel(eventType: string): string {
  const segments = eventType.split('.');
  const family = segments[1] ?? eventType;
  return family
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function adminEventTypeLabel(eventType: string): string {
  return ADMIN_EVENT_TYPE_LABELS[eventType] ?? adminEventFamilyLabel(eventType);
}

/** Audit-log action filter options — every action label this feature can
 *  emit, plus family-level filters the `action` query param matches via
 *  prefix (apps/api/src/admin/queries.ts: `eventType = action OR eventType
 *  LIKE '${action}.%'`). */
export const AUDIT_ACTION_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'admin.support_session', label: 'View as Vendor' },
  { value: 'admin.install', label: 'Retry install' },
  { value: 'admin.rollback', label: 'Rollback' },
  { value: 'admin.destroy', label: 'Force-complete destroy' },
  { value: 'admin.relay', label: 'Reset relay' },
];

/** Plain-language outcome for an audit row's `result` column. */
export function auditOutcomeLabel(result: string | null): string {
  if (result === null) return 'Unknown';
  if (result === 'success') return 'Succeeded';
  if (result === 'failure' || result.startsWith('failed')) return 'Failed';
  return result;
}

// ── Pilot-insights failure-code labels ──────────────────────────────────────

/**
 * Human-readable labels for the pilot-insights `failures` codes
 * (apps/api/src/admin/queries.ts `getOverviewPilotInsights`) that are NOT
 * already covered by the §61 copy-map mirror in diagnostic-vocabulary.ts —
 * the release-build telemetry family emitted by the build worker
 * (packages/cdk/src/lambda/worker.ts) as `payload.failureCode`.
 */
export const PILOT_FAILURE_LABELS: Record<string, string> = {
  build_failed: 'Build failed',
  build_cancelled: 'Build cancelled',
  build_timeout: 'Build timed out',
};

/**
 * §65 label for one pilot-insights failure code. Returns null for codes the
 * admin vocabulary does not know so the caller can render the raw code in
 * muted text rather than a generic "Unknown" label.
 */
export function pilotFailureLabel(code: string): string | null {
  const buildCode = PILOT_FAILURE_LABELS[code];
  if (buildCode) return buildCode;
  // install/deploy failures surface the §61 taxonomy (packages/db failure_code),
  // whose labels live in the shared diagnostic-vocabulary copy-map mirror.
  if ((FAILURE_CODES as readonly string[]).includes(code)) return failureCodeCopy(code).label;
  return null;
}
