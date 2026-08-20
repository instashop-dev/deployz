/**
 * @deployz/copy-map — single source of truth for product vocabulary.
 *
 * Every user-facing label, badge variant, and copy string flows from this
 * module. Pages import from here (or from a web-local re-export that mirrors
 * these values) — never hardcode status strings, failure labels, or verdict
 * copy. §46: raw CFN/ECS statuses must be UNREACHABLE at the UI edge; this
 * module is the gate.
 *
 * §65 copy principles (documented below as §65_RULES) govern every label:
 * jargon-free top level, expandable technical detail, no raw AWS/CFN/ECS/IAM
 * terms at the top level.
 */

// ── §65 copy principles ─────────────────────────────────────────────────────

/**
 * The §65 copy rules that govern every user-facing string in Deployz.
 *
 * 1. **Jargon-free top level** — the first thing a user reads must be plain
 *    English. No "CloudFormation", "ECS", "RDS", "IAM", "ALB", "Lambda", "VPC",
 *    or "CFN" at the top level.
 *
 * 2. **Expandable technical detail** — raw service names, exact permission
 *    ARNs, and infrastructure identifiers live behind expandable sections
 *    (`<details>`, collapsible cards, "Technical detail" headings). The user
 *    chooses to see them.
 *
 * 3. **No raw AWS terms at top level** — even when the underlying system is
 *    AWS, the copy describes WHAT happens, not WHICH service does it.
 *    "Deployment failed" not "ECS deployment failed"; "Database unreachable"
 *    not "RDS unavailable".
 *
 * 4. **Honest trust story** — never claim permissions are "tiny" or
 *    "minimal" when they are substantial. Describe the boundary honestly.
 *
 * 5. **Masked secrets** — secrets are write-only. The UI shows "***" or a
 *    masked placeholder; plaintext never appears in API responses, event
 *    payloads, or serialized state.
 */
export const COPY_RULES_65 = {
  JARGON_FREE_TOP_LEVEL: true,
  EXPANDABLE_TECHNICAL_DETAIL: true,
  NO_RAW_AWS_TERMS_AT_TOP_LEVEL: true,
  HONEST_TRUST_STORY: true,
  MASKED_SECRETS: true,
} as const;

/** Regex matching raw AWS/CFN/ECS/IAM terms that must not appear at the top level. */
export const JARGON_PATTERN = /\b(CloudFormation|IAM|ECS|ALB|Lambda|VPC|CFN|RDS)\b/i;

// ── §46 deployment states ───────────────────────────────────────────────────

/** The 9 product-vocabulary deployment states (§46). */
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

/** Badge variant per state (maps to shadcn/ui Badge variants). */
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

/** Look up a human-readable label for a deployment state string. */
export function deploymentStateLabel(state: string): string {
  return DEPLOYMENT_STATE_LABELS[state as DeploymentState] ?? state;
}

// ── §40 event families ──────────────────────────────────────────────────────

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
 * workflows. Unknown types fall back to the family label (§65: jargon-free,
 * never raw).
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

// ── §62 event result labels ─────────────────────────────────────────────────

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

// ── §61 failure codes ───────────────────────────────────────────────────────

/** The ten §61 stable failure codes. */
export const FAILURE_CODES = [
  'AWS_SCP_BLOCKED',
  'PORT_MISMATCH',
  'REGION_NOT_SUPPORTED',
  'QUOTA_EXCEEDED',
  'IMAGE_HEALTH_CHECK_FAILED',
  'MIGRATION_FAILED',
  'RELAY_DISCONNECTED',
  'ECS_DEPLOYMENT_FAILED',
  'RDS_UNAVAILABLE',
  'UNKNOWN',
] as const;

/** A §61 failure code — exactly the ten values in `FAILURE_CODES`. */
export type FailureCode = (typeof FAILURE_CODES)[number];

/** Severity drives the color-coded badge: critical (destructive) vs warning. */
export type FailureSeverity = 'critical' | 'warning';

/** The §65 top-level copy for one failure code. */
export interface FailureCopy {
  /** Short, jargon-free label (e.g. "Cloud policy blocks this"). */
  label: string;
  /** One jargon-free sentence summarizing the failure. */
  description: string;
  /** Color-coded severity. */
  severity: FailureSeverity;
}

/**
 * Human-readable §65 copy for every §61 failure code. The label + description
 * are plain English — never raw AWS service names at the top level (§65).
 * The raw code lives behind the expandable technical-detail layer.
 */
export const FAILURE_CODE_COPY: Record<FailureCode, FailureCopy> = {
  AWS_SCP_BLOCKED: {
    label: 'Cloud policy blocks this',
    description: "A policy in your organization's cloud account is blocking the setup.",
    severity: 'critical',
  },
  PORT_MISMATCH: {
    label: 'Port conflict',
    description: 'Your app listens on one port, but the service expects another.',
    severity: 'warning',
  },
  REGION_NOT_SUPPORTED: {
    label: 'Region not supported',
    description: "The chosen region isn't one we can deploy to yet.",
    severity: 'warning',
  },
  QUOTA_EXCEEDED: {
    label: 'Account limit reached',
    description: 'Your cloud account has hit a resource limit.',
    severity: 'warning',
  },
  IMAGE_HEALTH_CHECK_FAILED: {
    label: 'Health check failing',
    description: "The app started, but its health check isn't passing.",
    severity: 'warning',
  },
  MIGRATION_FAILED: {
    label: 'Migration failed',
    description: "A database migration step didn't finish successfully.",
    severity: 'critical',
  },
  RELAY_DISCONNECTED: {
    label: 'Helper disconnected',
    description: 'The helper in your cloud account is no longer checking in.',
    severity: 'critical',
  },
  ECS_DEPLOYMENT_FAILED: {
    label: 'Deployment failed',
    description: "The new version couldn't be rolled out.",
    severity: 'critical',
  },
  RDS_UNAVAILABLE: {
    label: 'Database unreachable',
    description: "The database isn't reachable right now.",
    severity: 'critical',
  },
  UNKNOWN: {
    label: 'Unknown issue',
    description: "Something failed and we couldn't pin down the cause.",
    severity: 'critical',
  },
};

/** Badge variant for a severity (maps to shadcn/ui Badge variants). */
export type FailureBadgeVariant = 'destructive' | 'secondary';

export const FAILURE_SEVERITY_BADGE: Record<FailureSeverity, FailureBadgeVariant> = {
  critical: 'destructive',
  warning: 'secondary',
};

/** Status dot tone class for a severity. */
export const FAILURE_SEVERITY_DOT: Record<FailureSeverity, string> = {
  critical: 'bg-destructive',
  warning: 'bg-muted-foreground',
};

/**
 * Generic fallback for the why/fix sections when the AI explanation isn't
 * available yet (still §65 jargon-free — never fabricated detail).
 */
export const EXPLANATION_FALLBACK = {
  why: 'The cause is still being narrowed down. The technical detail below shows the signals we have.',
  fix: "If the cause isn't clear from the detail below, contact Deployz support.",
} as const;

/** §65 lookup for a failure code — falls back safely to UNKNOWN copy. */
export function failureCodeCopy(code: string): FailureCopy {
  return FAILURE_CODE_COPY[code as FailureCode] ?? FAILURE_CODE_COPY.UNKNOWN;
}

// ── §19 readiness verdicts ──────────────────────────────────────────────────

/** §19 verdict vocabulary: READY / NEEDS_ATTENTION / NOT_COMPATIBLE. */
export const COMPATIBILITY_VERDICTS = [
  'READY',
  'NEEDS_ATTENTION',
  'NOT_COMPATIBLE',
] as const;

export type CompatibilityVerdict = (typeof COMPATIBILITY_VERDICTS)[number];

export interface VerdictPresentation {
  /** The verdict headline (§65 copy). */
  heading: string;
  /** Short badge label. */
  label: string;
  /** Visual tone — READY is green (§19). */
  tone: 'ready' | 'attention' | 'incompatible';
}

export const VERDICT_PRESENTATION: Record<CompatibilityVerdict, VerdictPresentation> = {
  READY: { heading: 'Your app is ready to deploy.', label: 'Ready', tone: 'ready' },
  NEEDS_ATTENTION: { heading: 'Needs attention', label: 'Needs attention', tone: 'attention' },
  NOT_COMPATIBLE: {
    heading: 'Not currently compatible',
    label: 'Not currently compatible',
    tone: 'incompatible',
  },
};

// ── §42 onboarding steps ────────────────────────────────────────────────────

/** The six §42 onboarding steps, in exact order. Success = readiness (§5). */
export const ONBOARDING_STEPS = [
  'Connect GitHub',
  'Choose repository',
  'Analyse',
  'Fix compatibility issues',
  'Create test deployment',
  'Ready for customer deployment',
] as const;

// ── §31 secret mask ─────────────────────────────────────────────────────────

/** The value used to mask secrets in API responses and event payloads (§31). */
export const SECRET_MASK = '***';