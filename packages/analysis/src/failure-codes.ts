/**
 * §61 failure vocabulary — the stable failure taxonomy and the structured
 * event shape that carries a failure signal.
 *
 * This is the single home of the taxonomy, importable by every consumer
 * without a workspace cycle: `@deployz/cdk` and `@deployz/api` both depend
 * on `@deployz/analysis`. The classifier that once lived in `@deployz/cdk`
 * (packages/cdk/src/analysis) was removed in Phase 13 — failure refinement
 * now runs in `apps/api` (failure-classification.ts), which consumes the
 * codes from here.
 */

// ── §61 failure taxonomy ───────────────────────────────────────────────────

/**
 * The §61 stable failure codes, copied verbatim from
 * `packages/db/src/enums.ts` `failureCodeEnum`. Do not reorder, rename, or
 * extend without updating that enum and the parity tests in
 * `packages/contracts/src/index.test.ts` and
 * `packages/db/src/contracts-parity.test.ts`.
 */
export const FAILURE_CODES = [
  'AWS_SCP_BLOCKED',
  'AWS_PERMISSION_DENIED',
  'PORT_MISMATCH',
  'REGION_NOT_SUPPORTED',
  'QUOTA_EXCEEDED',
  'IMAGE_HEALTH_CHECK_FAILED',
  'MIGRATION_FAILED',
  'RELAY_DISCONNECTED',
  'STACK_CREATE_FAILED',
  'STACK_DELETE_FAILED',
  'DATABASE_CREATE_FAILED',
  'DATABASE_CONNECTION_FAILED',
  'IMAGE_PULL_FAILED',
  'CONTAINER_START_FAILED',
  'MISSING_SECRET',
  'ECS_DEPLOYMENT_FAILED',
  'RDS_UNAVAILABLE',
  'UNSUPPORTED_ARCHITECTURE',
  'UNKNOWN',
  'REDIS_PROVISIONING_FAILED',
  'REDIS_CONNECTION_FAILED',
  'DOMAIN_OPERATION_TIMEOUT',
  'RELAY_STATE_WRITE_FAILED',
] as const;

/** A §61 failure code — exactly the twenty values in `FAILURE_CODES`. */
export type FailureCode = (typeof FAILURE_CODES)[number];

// ── Structured event (§16) ────────────────────────────────────────────────

/**
 * The classifier's input and the explainer's context: a STRUCTURED event,
 * never free-form log text.
 *
 * Every field is a structured slot (§16 data boundary). The `context` record
 * carries typed structured signals (booleans, numbers, strings) — it must NOT
 * be used to smuggle free-form log lines through. Callers upstream (the relay,
 * preflight, ECS/RDS observers) normalize their raw signals into this shape
 * before classification.
 */
export interface StructuredEvent {
  /** Where the event originated, e.g. 'relay', 'ecs', 'rds', 'health-check', 'deploy'. */
  source: string;
  /** The action being performed, e.g. 'report-health', 'deploy', 'migration'. */
  action?: string;
  /** The structured signal this event carries, e.g. 'target-health', 'port', 'connectivity'. */
  signal?: string;
  /** Structured AWS error, if the event reports a failure. */
  error?: {
    /** AWS error code, e.g. 'AccessDenied', 'ValidationError'. */
    code?: string;
    /** AWS error message (structured, no raw logs). */
    message?: string;
    /** HTTP status code, if the failure surfaced over HTTP. */
    statusCode?: number;
  };
  /** Structured context (no free-form log fields). */
  context?: Record<string, unknown>;
}
