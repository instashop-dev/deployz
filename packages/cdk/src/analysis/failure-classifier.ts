/**
 * §61 failure classifier — the deterministic pipeline that maps a STRUCTURED
 * event to one of the ten stable failure codes BEFORE any AI is consulted.
 *
 * The §61 codes are the SINGLE failure taxonomy from day one. This classifier
 * is PURELY DETERMINISTIC (§20): synchronous, ordered rules, first match wins,
 * no AI, no ML, no randomness, no network, no Date. The AI layer (todo 29)
 * only EXPLAINS the code this classifier already decided — it never re-decides
 * it.
 *
 * Data boundary (§16): the input is a `StructuredEvent`, NEVER free-form log
 * text. Free-form log fields are rejected at the input edge (todo 29's Zod
 * schema), not here — this module only ever sees already-structured data, so
 * it carries no raw-log handling of its own.
 *
 * The failure-code vocabulary mirrors `failureCodeEnum` in packages/db verbatim
 * (parity locked by `failure-classifier.test.ts` importing the live pgEnum).
 */

import { ALLOWED_REGIONS } from '../jobs/preflight.js';

// ── §61 failure taxonomy ───────────────────────────────────────────────────

/**
 * The ten §61 stable failure codes, copied verbatim from
 * `packages/db/src/enums.ts` `failureCodeEnum`. Do not reorder, rename, or
 * extend without updating that enum and the parity test.
 */
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

// ── Structured event (§16) ────────────────────────────────────────────────

/**
 * The classifier's input: a STRUCTURED event, never free-form log text.
 *
 * Every field is a structured slot (§16 data boundary). The `context` record
 * carries typed structured signals (booleans, numbers, strings) — it must NOT
 * be used to smuggle free-form log lines through to the classifier. Callers
 * upstream (the relay, preflight, ECS/RDS observers) normalize their raw
 * signals into this shape before classification.
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

// ── Context readers ────────────────────────────────────────────────────────

/** Read a string-valued context field, or `undefined` if absent/not a string. */
function contextString(event: StructuredEvent, key: string): string | undefined {
  const value = event.context?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** Read a boolean context field, or `undefined` if absent/not a boolean. */
function contextBoolean(event: StructuredEvent, key: string): boolean | undefined {
  const value = event.context?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

// ── Rule predicates ────────────────────────────────────────────────────────

/**
 * True when `code` is an AWS access-denied code. SCP denials surface as
 * `AccessDenied` (the structured code) or `AccessDeniedException` (the SDK
 * exception name — see `scp-blocked.ts` for the full signature).
 */
function isAccessDeniedCode(code: string): boolean {
  return code === 'AccessDenied' || code === 'AccessDeniedException';
}

/**
 * Rule 1 — AWS_SCP_BLOCKED.
 *
 * An `AccessDenied` error whose message carries an SCP signature. The two
 * markers that distinguish an SCP denial from a plain IAM denial are
 * `explicit deny` / `service control policy` (the canonical AWS denial tail —
 * see `scp-blocked.ts`). Message matching is case-insensitive; the code check
 * is exact (codes are canonical).
 */
function isScpBlocked(event: StructuredEvent): boolean {
  const code = event.error?.code;
  const message = event.error?.message;
  if (code === undefined || !isAccessDeniedCode(code)) return false;
  if (message === undefined) return false;

  const m = message.toLowerCase();
  return m.includes('service control policy') || m.includes('explicit deny');
}

/**
 * Rule 2 — PORT_MISMATCH (§29).
 *
 * The canonical §29 failure: the app listens on a port different from the one
 * the service exposes. Three structured ways to signal it:
 *   1. `signal === 'port'` — the primary structured signal.
 *   2. `context.portMismatch === true`, or `context` carrying differing
 *      `expectedPort`/`actualPort` numbers (the §29 example shape).
 *   3. An error message describing a port difference.
 */
function isPortMismatch(event: StructuredEvent): boolean {
  // §29 canonical structured signal.
  if (event.signal === 'port') return true;

  // Explicit flag in structured context.
  if (contextBoolean(event, 'portMismatch') === true) return true;

  // §29 example shape: expectedPort/actualPort numbers that differ.
  const expectedPort = event.context?.['expectedPort'];
  const actualPort = event.context?.['actualPort'];
  if (
    typeof expectedPort === 'number' &&
    typeof actualPort === 'number' &&
    expectedPort !== actualPort
  ) {
    return true;
  }

  // Error message indicates the app listens on a port different from the exposed one.
  const message = event.error?.message;
  return message !== undefined && messageIndicatesPortMismatch(message);
}

/**
 * Message heuristic for the §29 fallback: the message references a port AND
 * signals a difference — either an explicit mismatch/difference word, or the
 * listening-vs-exposed comparison ("listens on port X … exposes port Y"), or a
 * named expected/actual port.
 */
function messageIndicatesPortMismatch(message: string): boolean {
  const m = message.toLowerCase();
  if (!m.includes('port')) return false;
  return (
    m.includes('mismatch') ||
    m.includes('different') ||
    m.includes('does not match') ||
    m.includes('listens on port') ||
    m.includes('exposed port') ||
    m.includes('exposes port') ||
    m.includes('expected port') ||
    m.includes('actual port')
  );
}

/**
 * Rule 4 — QUOTA_EXCEEDED.
 *
 * The error message carries a quota/limit/throttling marker. Matched
 * case-insensitively: `quota`, `limitexceeded`, or `throttling` (which covers
 * AWS's `LimitExceeded`/`Throttling` exception names and their lowercase
 * message forms).
 */
function indicatesQuotaExceeded(message: string | undefined): boolean {
  if (message === undefined) return false;
  const m = message.toLowerCase();
  return m.includes('quota') || m.includes('limitexceeded') || m.includes('throttling');
}

/**
 * Rule 7 — RELAY_DISCONNECTED.
 *
 * The relay reports lost connectivity (`signal: 'connectivity'` with
 * `connected: false`), or emits a direct relay-disconnect signal
 * (`signal: 'disconnected'`).
 */
function isRelayDisconnected(event: StructuredEvent): boolean {
  if (event.source !== 'relay') return false;
  if (event.signal === 'connectivity' && contextBoolean(event, 'connected') === false) {
    return true;
  }
  return event.signal === 'disconnected';
}

// ── Classifier ────────────────────────────────────────────────────────────

/**
 * Classify a structured event into its §61 failure code.
 *
 * Rules are evaluated in FIXED priority order; the FIRST match wins and the
 * rest are never consulted. UNKNOWN is the fallback. PURE: same input →
 * same code, synchronously, with no AI.
 */
export function classifyFailure(event: StructuredEvent): FailureCode {
  // 1. AWS_SCP_BLOCKED — AccessDenied with an SCP / explicit-deny signature.
  if (isScpBlocked(event)) return 'AWS_SCP_BLOCKED';

  // 2. PORT_MISMATCH — §29: app listens on a port different from what's exposed.
  if (isPortMismatch(event)) return 'PORT_MISMATCH';

  // 3. REGION_NOT_SUPPORTED — region not in the §32 17-region allowlist.
  const region = contextString(event, 'region');
  if (region !== undefined && !(ALLOWED_REGIONS as readonly string[]).includes(region)) {
    return 'REGION_NOT_SUPPORTED';
  }

  // 4. QUOTA_EXCEEDED — message indicates a quota/limit/throttling failure.
  if (indicatesQuotaExceeded(event.error?.message)) return 'QUOTA_EXCEEDED';

  // 5. IMAGE_HEALTH_CHECK_FAILED — target unhealthy during an image health check.
  if (
    event.source === 'health-check' &&
    event.signal === 'target-health' &&
    contextBoolean(event, 'healthy') === false
  ) {
    return 'IMAGE_HEALTH_CHECK_FAILED';
  }

  // 6. MIGRATION_FAILED — a deploy-time migration reported an error.
  if (
    event.source === 'deploy' &&
    event.action === 'migration' &&
    event.error !== undefined
  ) {
    return 'MIGRATION_FAILED';
  }

  // 7. RELAY_DISCONNECTED — relay connectivity signal lost.
  if (isRelayDisconnected(event)) return 'RELAY_DISCONNECTED';

  // 8. ECS_DEPLOYMENT_FAILED — any ECS-sourced error.
  if (event.source === 'ecs' && event.error !== undefined) {
    return 'ECS_DEPLOYMENT_FAILED';
  }

  // 9. RDS_UNAVAILABLE — an RDS-sourced error or an unavailable flag.
  if (
    event.source === 'rds' &&
    (event.error !== undefined || contextBoolean(event, 'available') === false)
  ) {
    return 'RDS_UNAVAILABLE';
  }

  // 10. UNKNOWN — fallback when no rule matches.
  return 'UNKNOWN';
}
