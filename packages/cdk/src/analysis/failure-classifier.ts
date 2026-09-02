/**
 * §61 failure classifier — the deterministic pipeline that maps a STRUCTURED
 * event to one of the twenty stable failure codes BEFORE any AI is consulted.
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

import type { FailureCode, StructuredEvent } from '@deployz/analysis';

import { ALLOWED_REGIONS } from '../jobs/preflight.js';

// ── §61 failure taxonomy + structured event (shared vocabulary) ───────────

/**
 * The failure taxonomy and the structured-event shape now live in
 * `@deployz/analysis` so `apps/api` can reach them without importing this
 * package (`@deployz/cdk` depends on `@deployz/api`, so that import would
 * close a dependency cycle). They are re-exported here so every existing
 * `./failure-classifier.js` import keeps working and there remains exactly
 * ONE definition of the taxonomy.
 */
export { FAILURE_CODES } from '@deployz/analysis';
export type { FailureCode, StructuredEvent } from '@deployz/analysis';

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
    m.includes('actual port') ||
    // §20 example: "Port unavailable" — the configured port could not be
    // bound, which is the same underlying port-configuration issue. Matched
    // as the exact phrase, NOT a bare `unavailable`: the message already had
    // to contain "port" to reach here, so a bare term would also swallow
    // unrelated messages such as "database on port 5432 unavailable".
    m.includes('port unavailable')
  );
}

/**
 * Rule 4 — QUOTA_EXCEEDED.
 *
 * A quota/limit/throttling marker in either the error CODE or the error
 * MESSAGE, matched case-insensitively: `quota`, `limitexceeded`, or
 * `throttl` (which covers AWS's `LimitExceeded`/`Throttling` exception
 * names — as bare error codes like `ResourceLimitExceeded`, e.g. §20's
 * example, as well as their lowercase message forms).
 */
function indicatesQuotaExceeded(event: StructuredEvent): boolean {
  const code = event.error?.code;
  if (code !== undefined) {
    const c = code.toLowerCase();
    if (c.includes('quota') || c.includes('limitexceeded') || c.includes('throttl')) return true;
  }

  const message = event.error?.message;
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

/**
 * Rule 1b — AWS_PERMISSION_DENIED.
 *
 * An `AccessDenied` or `UnauthorizedAccess` error that does NOT carry an SCP
 * signature. This catches plain IAM permission denials (missing permissions,
 * resource-level policies, KMS key policies, etc.) after the SCP check has
 * already ruled out an SCP block.
 */
function isAwsPermissionDenied(event: StructuredEvent): boolean {
  const code = event.error?.code;
  const message = event.error?.message;
  if (code === undefined && message === undefined) return false;

  if (code !== undefined && isAccessDeniedCode(code)) return true;

  if (message !== undefined) {
    const m = message.toLowerCase();
    if (m.includes('accessdenied') || m.includes('unauthorizedaccess')) return true;
  }

  return false;
}

/**
 * Rule 10 — DATABASE_CONNECTION_FAILED.
 *
 * An RDS-sourced connection failure: either the `connection-failed` signal,
 * or an error message that mentions both "connection" and "timeout".
 */
function isDatabaseConnectionFailed(event: StructuredEvent): boolean {
  if (event.source !== 'rds') return false;
  if (event.signal === 'connection-failed') return true;

  const message = event.error?.message;
  if (message === undefined) return false;
  const m = message.toLowerCase();
  return m.includes('connection') && m.includes('timeout');
}

/**
 * Rule 11 — IMAGE_PULL_FAILED.
 *
 * An ECS-sourced image pull failure: either the `image-pull-failed` signal,
 * or an error message that mentions "ImagePull" or "CannotPull".
 */
function isImagePullFailed(event: StructuredEvent): boolean {
  if (event.source !== 'ecs') return false;
  if (event.signal === 'image-pull-failed') return true;

  const message = event.error?.message;
  if (message === undefined) return false;
  const m = message.toLowerCase();
  return m.includes('imagepull') || m.includes('cannotpull');
}

/**
 * Rule 12 — CONTAINER_START_FAILED.
 *
 * An ECS-sourced container exit or start failure: either the `container-exit`
 * signal, or an error message that mentions "Container exited" or "start failed".
 */
function isContainerStartFailed(event: StructuredEvent): boolean {
  if (event.source !== 'ecs') return false;
  if (event.signal === 'container-exit') return true;

  const message = event.error?.message;
  if (message === undefined) return false;
  const m = message.toLowerCase();
  return m.includes('container exited') || m.includes('start failed');
}

/**
 * Rule 13 — MISSING_SECRET.
 *
 * An ECS-sourced missing-secret failure: either the `missing-secret` signal,
 * or an error message that mentions "SecretNotFound", "Invalid secret"
 * (§20's literal example), or "AccessDenied" with "secretsmanager".
 */
function isMissingSecret(event: StructuredEvent): boolean {
  if (event.source !== 'ecs') return false;
  if (event.signal === 'missing-secret') return true;

  const message = event.error?.message;
  if (message === undefined) return false;
  const m = message.toLowerCase();
  if (m.includes('secretnotfound')) return true;
  if (m.includes('invalid secret')) return true;
  return m.includes('accessdenied') && m.includes('secretsmanager');
}

/**
 * Message heuristic fallback for Rule 5: the §20 literal example "Target
 * failed health check" reported as a plain error message rather than the
 * structured `health-check`/`target-health` signal.
 */
function messageIndicatesHealthCheckFailure(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes('failed health check') || m.includes('health check failed');
}

/**
 * Rule 14 — REDIS_PROVISIONING_FAILED (Redis MVP).
 *
 * A CloudFormation/provisioning-source event referencing an `AWS::ElastiCache`
 * resource type — either in `context.resourceType` (the structured signal a
 * per-resource CFN failure carries, mirroring how `STACK_CREATE_FAILED`
 * reads `signal`) or, as a fallback, an error message that names the
 * resource type directly.
 */
function isRedisProvisioningFailed(event: StructuredEvent): boolean {
  if (event.source !== 'cloudformation') return false;

  const resourceType = contextString(event, 'resourceType');
  if (resourceType !== undefined && resourceType.startsWith('AWS::ElastiCache')) return true;

  const message = event.error?.message;
  return message !== undefined && message.includes('AWS::ElastiCache');
}

/** Redis connection-error codes (ioredis/node-redis + RESP protocol errors). */
const REDIS_CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'NOAUTH',
  'WRONGPASS',
  'MOVED',
  'CLUSTERDOWN',
]);

/**
 * True when the event identifies the cache as its subject — distinct from,
 * say, an RDS-sourced connection error carrying the SAME error code (an
 * `ECONNREFUSED` against a database must NOT be swept into this rule).
 * Structured signals only, no message sniffing (§16): `context.target`
 * naming the cache, or a `signal` mentioning cache/redis.
 */
function identifiesCache(event: StructuredEvent): boolean {
  if (event.source === 'cache' || event.source === 'redis' || event.source === 'elasticache') {
    return true;
  }

  const target = contextString(event, 'target');
  if (target === 'redis' || target === 'cache') return true;

  const signal = event.signal;
  return signal !== undefined && (signal.includes('cache') || signal.includes('redis'));
}

/**
 * Rule 15 — REDIS_CONNECTION_FAILED (Redis MVP).
 *
 * A connection-class error code AND an event that identifies the cache as
 * its subject. The error-code check alone is intentionally NOT sufficient —
 * `ECONNREFUSED` is a generic network error also seen from RDS (rule 17
 * below, RDS_UNAVAILABLE) and ECS; without `identifiesCache`, a database
 * connection refusal would misclassify as a Redis failure.
 */
function isRedisConnectionFailed(event: StructuredEvent): boolean {
  const code = event.error?.code;
  if (code === undefined || !REDIS_CONNECTION_ERROR_CODES.has(code)) return false;
  return identifiesCache(event);
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

  // 1b. AWS_PERMISSION_DENIED — AccessDenied without an SCP signature.
  if (isAwsPermissionDenied(event)) return 'AWS_PERMISSION_DENIED';

  // 2. PORT_MISMATCH — §29: app listens on a port different from what's exposed.
  if (isPortMismatch(event)) return 'PORT_MISMATCH';

  // 3. REGION_NOT_SUPPORTED — region not in the §32 17-region allowlist.
  const region = contextString(event, 'region');
  if (region !== undefined && !(ALLOWED_REGIONS as readonly string[]).includes(region)) {
    return 'REGION_NOT_SUPPORTED';
  }

  // 4. QUOTA_EXCEEDED — code or message indicates a quota/limit/throttling failure.
  if (indicatesQuotaExceeded(event)) return 'QUOTA_EXCEEDED';

  // 5. IMAGE_HEALTH_CHECK_FAILED — target unhealthy during an image health check.
  if (
    (event.source === 'health-check' &&
      event.signal === 'target-health' &&
      contextBoolean(event, 'healthy') === false) ||
    (event.error?.message !== undefined &&
      messageIndicatesHealthCheckFailure(event.error.message))
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

  // 8. STACK_CREATE_FAILED — CloudFormation stack creation failed.
  //
  // FORWARD-LOOKING RISK: this rule matches on source+signal alone, with no
  // resourceType check. If a per-resource CFN failure event is ever emitted
  // carrying this same blanket 'stack-create-failed' signal AND an
  // AWS::ElastiCache resourceType, this rule (checked first) will shadow
  // rule 14 (REDIS_PROVISIONING_FAILED) below — that event would misclassify
  // as STACK_CREATE_FAILED instead. Not reachable today (no CFN event
  // producer exists yet); whoever adds one must either give per-resource
  // ElastiCache failures a resource-scoped signal (not 'stack-create-failed'),
  // or this ordering must be revisited.
  if (
    event.source === 'cloudformation' &&
    event.signal === 'stack-create-failed'
  ) {
    return 'STACK_CREATE_FAILED';
  }

  // 8b. STACK_DELETE_FAILED — CloudFormation stack deletion failed.
  if (
    event.source === 'cloudformation' &&
    event.signal === 'stack-delete-failed'
  ) {
    return 'STACK_DELETE_FAILED';
  }

  // 9. DATABASE_CREATE_FAILED — RDS database creation failed.
  if (
    event.source === 'rds' &&
    event.signal === 'db-create-failed'
  ) {
    return 'DATABASE_CREATE_FAILED';
  }

  // 10. DATABASE_CONNECTION_FAILED — RDS connection failure.
  if (isDatabaseConnectionFailed(event)) return 'DATABASE_CONNECTION_FAILED';

  // 11. IMAGE_PULL_FAILED — ECS image pull failure.
  if (isImagePullFailed(event)) return 'IMAGE_PULL_FAILED';

  // 12. CONTAINER_START_FAILED — ECS container exit / start failure.
  if (isContainerStartFailed(event)) return 'CONTAINER_START_FAILED';

  // 13. MISSING_SECRET — ECS missing secret.
  if (isMissingSecret(event)) return 'MISSING_SECRET';

  // 14. REDIS_PROVISIONING_FAILED — CloudFormation event referencing an
  // AWS::ElastiCache resource (Redis MVP). Placed before the generic
  // ECS/RDS fallbacks (16/17), after every more-specific existing rule.
  if (isRedisProvisioningFailed(event)) return 'REDIS_PROVISIONING_FAILED';

  // 15. REDIS_CONNECTION_FAILED — a connection-class error code targeting
  // the cache (Redis MVP). Also placed before the generic fallbacks; see
  // `isRedisConnectionFailed` for why an RDS-targeted ECONNREFUSED is NOT
  // swept in here.
  if (isRedisConnectionFailed(event)) return 'REDIS_CONNECTION_FAILED';

  // 16. ECS_DEPLOYMENT_FAILED — any ECS-sourced error.
  if (event.source === 'ecs' && event.error !== undefined) {
    return 'ECS_DEPLOYMENT_FAILED';
  }

  // 17. RDS_UNAVAILABLE — an RDS-sourced error or an unavailable flag.
  if (
    event.source === 'rds' &&
    (event.error !== undefined || contextBoolean(event, 'available') === false)
  ) {
    return 'RDS_UNAVAILABLE';
  }

  // 18. UNSUPPORTED_ARCHITECTURE — preflight architecture check failed.
  if (
    event.source === 'preflight' &&
    event.signal === 'unsupported-arch'
  ) {
    return 'UNSUPPORTED_ARCHITECTURE';
  }

  // 18b. DOMAIN_OPERATION_TIMEOUT — a custom-domain operation outlived its
  // watchdog window (CONFIGURE_DOMAIN / REMOVE_DOMAIN; Phase 5 lifecycle).
  if (
    event.source === 'relay' &&
    event.signal === 'domain-operation-timeout'
  ) {
    return 'DOMAIN_OPERATION_TIMEOUT';
  }

  // 19. UNKNOWN — fallback when no rule matches.
  return 'UNKNOWN';
}
