/**
 * §61 failure-code vocabulary + §65 copy mapping for the diagnostics surface.
 *
 * The UI must render each failure in what/why/fix form with a jargon-free top
 * level (§65) — NEVER raw AWS/ECS/CFN/IAM terms. The code →
 * label/description/severity copy is sourced from @deployz/copy-map (the
 * vetted single source) so it can never drift; pages keep importing from
 * this module.
 *
 * The §61 codes mirror `failureCodeEnum` (packages/db) and the classifier's
 * `FAILURE_CODES` (packages/cdk) verbatim, following the same web-local
 * pattern as `deployment-vocabulary.ts` (todo 19).
 */

import {
  APP_OWNED_STARTUP_FAILURE_CODES as COPY_MAP_APP_OWNED_STARTUP_FAILURE_CODES,
  FAILURE_CODE_COPY as COPY_MAP_FAILURE_CODE_COPY,
} from '@deployz/copy-map';

// ── §61 failure codes ───────────────────────────────────────────────────────

/** The twenty §61 stable failure codes (mirrors copy-map verbatim). */
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
  'AWS_PERMISSION_DENIED',
  'STACK_CREATE_FAILED',
  'STACK_DELETE_FAILED',
  'DATABASE_CREATE_FAILED',
  'DATABASE_CONNECTION_FAILED',
  'IMAGE_PULL_FAILED',
  'CONTAINER_START_FAILED',
  'MISSING_SECRET',
  'TEMPLATE_UNAVAILABLE',
  'UNSUPPORTED_ARCHITECTURE',
  'UNKNOWN',
  'REDIS_PROVISIONING_FAILED',
  'REDIS_CONNECTION_FAILED',
  'DOMAIN_OPERATION_TIMEOUT',
  'RELAY_STATE_WRITE_FAILED',
] as const;

/** A §61 failure code — exactly the twenty values in `FAILURE_CODES`. */
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
 * Human-readable §65 copy for every §61 failure code — @deployz/copy-map's
 * vetted record, re-exported under this module's stable API so pages never
 * import copy strings from anywhere else. The label + description are plain
 * English — never "AWS Service Control Policy", "ECS", "RDS", or
 * "CloudFormation" at the top level (§65). The raw code lives behind the
 * expandable technical-detail layer.
 */
export const FAILURE_CODE_COPY: Record<FailureCode, FailureCopy> = COPY_MAP_FAILURE_CODE_COPY;

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

// ── App-owned startup failures ──────────────────────────────────────────────

/**
 * The §61 codes that name the application's own startup/config work — the
 * vendor must fix the app before a retry can succeed; Deployz and the customer
 * have nothing to do. The vendor detail hero and the customer install card
 * both headline these as "Application couldn't start".
 */
export const APP_OWNED_STARTUP_FAILURE_CODES: ReadonlySet<string> =
  COPY_MAP_APP_OWNED_STARTUP_FAILURE_CODES;

/** True when a failure code names the application's own startup. */
export function isAppOwnedStartupFailure(
  code: string | null | undefined,
): code is FailureCode {
  return (
    code !== null &&
    code !== undefined &&
    APP_OWNED_STARTUP_FAILURE_CODES.has(code)
  );
}

/** §65 headline for a failed first install whose app could not start. */
export const STARTUP_FAILURE_TITLE = "Application couldn't start";

/** §65 reassurance on the customer card — the vendor owns this, not them. */
export const STARTUP_FAILURE_CUSTOMER_NOTE = 'No action is required from you.';

// ── §61 recoverability (mirrors @deployz/copy-map verbatim) ─────────────────

/** §61 recoverability — what kind of intervention (if any) a failure needs. */
export type FailureRecoverability =
  | 'RECONCILE_FIRST'
  | 'USER_ACTION'
  | 'DEPLOYZ_ACTION'
  | 'TERMINAL';

/** Recoverability per §61 code (mirrors @deployz/copy-map verbatim). */
export const FAILURE_RECOVERABILITY: Record<FailureCode, FailureRecoverability> = {
  AWS_SCP_BLOCKED: 'USER_ACTION',
  PORT_MISMATCH: 'USER_ACTION',
  REGION_NOT_SUPPORTED: 'TERMINAL',
  QUOTA_EXCEEDED: 'USER_ACTION',
  IMAGE_HEALTH_CHECK_FAILED: 'USER_ACTION',
  MIGRATION_FAILED: 'USER_ACTION',
  RELAY_DISCONNECTED: 'RECONCILE_FIRST',
  ECS_DEPLOYMENT_FAILED: 'USER_ACTION',
  RDS_UNAVAILABLE: 'RECONCILE_FIRST',
  AWS_PERMISSION_DENIED: 'USER_ACTION',
  STACK_CREATE_FAILED: 'USER_ACTION',
  STACK_DELETE_FAILED: 'USER_ACTION',
  DATABASE_CREATE_FAILED: 'USER_ACTION',
  DATABASE_CONNECTION_FAILED: 'RECONCILE_FIRST',
  IMAGE_PULL_FAILED: 'DEPLOYZ_ACTION',
  CONTAINER_START_FAILED: 'USER_ACTION',
  MISSING_SECRET: 'USER_ACTION',
  TEMPLATE_UNAVAILABLE: 'DEPLOYZ_ACTION',
  UNSUPPORTED_ARCHITECTURE: 'TERMINAL',
  UNKNOWN: 'RECONCILE_FIRST',
  REDIS_PROVISIONING_FAILED: 'DEPLOYZ_ACTION',
  REDIS_CONNECTION_FAILED: 'RECONCILE_FIRST',
  DOMAIN_OPERATION_TIMEOUT: 'RECONCILE_FIRST',
  RELAY_STATE_WRITE_FAILED: 'DEPLOYZ_ACTION',
};

/** §65 one-liner per recoverability class (mirrors @deployz/copy-map verbatim). */
export const RECOVERABILITY_COPY: Record<FailureRecoverability, string> = {
  RECONCILE_FIRST: 'This can recover on its own — Deployz keeps checking. Retry only if it persists.',
  USER_ACTION: 'Needs a change before a retry can succeed — see the fix above.',
  DEPLOYZ_ACTION: 'This needs a fix on the Deployz side — contact support rather than retrying.',
  TERMINAL: 'Retrying will not help until the underlying requirement changes.',
};

// ── AI explanation confidence (AI MVP Phase 7) ──────────────────────────────

/**
 * How the diagnostic card frames an AI-written explanation. High confidence
 * reads like deterministic copy; anything lower is presented as a reading,
 * never a verdict. Null means no hedge line.
 */
export const AI_CONFIDENCE_COPY = {
  high: null,
  medium: 'Deployz is fairly sure of this reading. Check the technical detail before acting on it.',
  low: 'Deployz could not determine the exact cause. This is its best reading of the most relevant failure — treat it as a lead, not a verdict.',
} as const;

/** Shown beside an AI-written explanation so the vendor knows its origin. */
export const AI_EXPLANATION_SOURCE_NOTE = 'Explained by Deployz from the failure signals.';
