/**
 * §61 failure-code vocabulary + §65 copy mapping for the diagnostics surface.
 *
 * The UI must render each failure in what/why/fix form with a jargon-free top
 * level (§65) — NEVER raw AWS/ECS/CFN/IAM terms. This module is the single
 * source of truth for the code → label/description/severity mapping, so the
 * copy sweep (todo 34) can migrate it into packages/copy-map without touching
 * pages.
 *
 * The §61 codes mirror `failureCodeEnum` (packages/db) and the classifier's
 * `FAILURE_CODES` (packages/cdk) verbatim, following the same web-local
 * pattern as `deployment-vocabulary.ts` (todo 19).
 */

// ── §61 failure codes ───────────────────────────────────────────────────────

/** The ten §61 stable failure codes (mirrors the cdk classifier verbatim). */
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

// ── §65 labels + descriptions ───────────────────────────────────────────────

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
 * are plain English — never "AWS Service Control Policy", "ECS", "RDS", or
 * "CloudFormation" at the top level (§65). The raw code lives behind the
 * expandable technical-detail layer.
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

/**
 * Generic fallback for the why/fix sections when the AI explanation isn't
 * available yet (still §65 jargon-free — never fabricated detail).
 */
export const EXPLANATION_FALLBACK = {
  why: 'The cause is still being narrowed down. The technical detail below shows the signals we have.',
  fix: "If the cause isn't clear from the detail below, contact Deployz support.",
} as const;

// ── Presentation helpers ────────────────────────────────────────────────────

/** Badge variant for a severity (maps to the shadcn/ui Badge variants). */
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

/** §65 lookup for a failure code — falls back safely to UNKNOWN copy. */
export function failureCodeCopy(code: string): FailureCopy {
  return FAILURE_CODE_COPY[code as FailureCode] ?? FAILURE_CODE_COPY.UNKNOWN;
}
