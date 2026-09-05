import type { FailureCode, FailureRecoverability } from './diagnostic-vocabulary';

// Diagnostics data access. Wired to the real
// `GET /api/deployments/:id/diagnostics` endpoint, which returns a single
// what/why/fix object (null fields when the deployment isn't FAILED) plus
// the recent event log — reshaped here into the card list the UI renders.
// §65 vocabulary at the top level — raw AWS/ECS terms only inside the
// expandable technical detail. Code-driven ONLY: no diagnostic bundles, no
// log export (S3).

import { apiUrl } from '@/lib/api-url';

// ── Wire shapes ────────────────────────────────────────────────────────────

/** One raw event from the deployment's event log (§40), as diagnostic context. */
export interface DiagnosticEvent {
  source: string;
  action?: string;
  signal?: string;
  error?: {
    code?: string;
    message?: string;
    statusCode?: number;
  };
  context?: Record<string, string | number | boolean>;
}

/** The plain-English explanation, when the deployment has actually failed. */
export interface DiagnosticExplanation {
  what: string;
  why: string;
  fix: string;
}

/**
 * One classified diagnostic: the deterministic §61 code, the structured event
 * that produced it (rendered behind the expandable layer), and the what/why/fix
 * explanation — all code-driven (no bundles, no log export).
 */
/** One failed resource from the normalised failure context (Phase 6). */
export interface DiagnosticFailedResource {
  logicalResourceId: string;
  resourceType: string;
  resourceStatus: string;
  reason: string | null;
}

/** The API's normalised failure context — phase, codes, blamed resource, failed events. */
export interface DiagnosticContext {
  phase: string;
  attempt: number | null;
  failureCode: string;
  reportedFailureCode: string | null;
  resourceType: string | null;
  message: string | null;
  relevantEvents: DiagnosticFailedResource[];
  applicationVersion: string | null;
}

export interface Diagnostic {
  failureCode: FailureCode;
  /** The normalised context, for the technical layer. Null on older API responses. */
  context: DiagnosticContext | null;
  /** §61 recoverability class — which affordance the card leads with. */
  recoverability: FailureRecoverability | null;
  event: DiagnosticEvent;
  explanation: DiagnosticExplanation | null;
  occurredAt: string;
}

interface DiagnosticsApiResponse {
  failureCode: string | null;
  recoverability?: string | null;
  what: string | null;
  why: string | null;
  fix: string | null;
  /**
   * What the relay said, verbatim (the failed job's error text). The API
   * serves it for exactly the §65 "Technical detail" disclosure — the web
   * client must not drop it on the floor.
   */
  technicalDetail?: string | null;
  context?: DiagnosticContext | null;
  events: Array<{
    occurredAt: string;
    eventType: string;
    result: string | null;
  }>;
}

// ── Response mapping ─────────────────────────────────────────────────────────

/**
 * Map the diagnostics endpoint's response onto the card list the UI renders.
 * Exported so the mapping is unit-testable without a fetch seam — the fetch
 * helper below is a thin wrapper over it.
 *
 * A healthy or non-failed deployment gets `failureCode: null`, which maps to
 * an empty list (the "no issues" state).
 */
export function toDiagnostics(body: DiagnosticsApiResponse): Diagnostic[] {
  if (!body.failureCode) return [];

  const latestEvent = body.events[body.events.length - 1];
  return [
    {
      failureCode: body.failureCode as FailureCode,
      context: body.context ?? null,
      recoverability: (body.recoverability as FailureRecoverability | undefined) ?? null,
      occurredAt: latestEvent?.occurredAt ?? new Date().toISOString(),
      event: {
        source: 'deployment',
        ...(latestEvent ? { action: latestEvent.eventType } : {}),
        // §14.3/§65: the relay's verbatim error text belongs inside the card's
        // expandable "Technical detail" layer, exactly where the raw code and
        // message live. It used to be dropped here, leaving the disclosure
        // empty on every failure.
        ...(typeof body.technicalDetail === 'string' && body.technicalDetail.length > 0
          ? { error: { message: body.technicalDetail } }
          : {}),
      },
      explanation:
        body.what && body.why && body.fix
          ? { what: body.what, why: body.why, fix: body.fix }
          : null,
    },
  ];
}

// ── Fetch helper ────────────────────────────────────────────────────────────

/**
 * Fetch a deployment's diagnostics. The API returns a single what/why/fix
 * classification for the deployment (not one per event).
 */
export async function fetchDiagnostics(id: string): Promise<Diagnostic[]> {
  const response = await fetch(`${apiUrl}/api/deployments/${encodeURIComponent(id)}/diagnostics`, {
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Diagnostics request failed (${response.status})`);
  const body = (await response.json()) as DiagnosticsApiResponse;
  return toDiagnostics(body);
}

// ── Relay-observed infrastructure checks ─────────────────────────────────────

/** One check as the relay observed it (verify.js emits {name, passed, detail}). */
export interface InfraCheck {
  name: string;
  passed: boolean;
  detail: string;
  /** `false` marks an informational observation — its failure is not an issue. */
  required?: boolean;
}

/** Whether a check represents an actual problem (informational checks never do). */
export function infraCheckIsIssue(check: InfraCheck): boolean {
  return !check.passed && check.required !== false;
}

/** Friendly names for the raw check names the relay reports. */
const INFRA_CHECK_LABELS: Record<string, string> = {
  'stack-exists': 'Stack',
  'stack-complete': 'Stack',
  'stack-tagged': 'Stack',
  compute: 'Compute',
  ingress: 'Ingress',
  database: 'Database',
  storage: 'Storage',
  cache: 'Redis',
};

export function infraCheckLabel(name: string): string {
  return INFRA_CHECK_LABELS[name] ?? name;
}

/** Reads the relay's infrastructure checks out of observedState, if any. */
export function readInfraChecks(
  observedState: Record<string, unknown> | null,
): InfraCheck[] {
  const checks = (observedState as { infraHealth?: { checks?: unknown } } | null)?.infraHealth
    ?.checks;
  if (!Array.isArray(checks)) return [];
  return checks.flatMap((check) => {
    if (
      typeof check === 'object' &&
      check !== null &&
      'name' in check &&
      typeof (check as { name: unknown }).name === 'string' &&
      'passed' in check &&
      typeof (check as { passed: unknown }).passed === 'boolean' &&
      'detail' in check &&
      typeof (check as { detail: unknown }).detail === 'string'
    ) {
      return [check as InfraCheck];
    }
    return [];
  });
}

/** "3 minutes ago" style relative time for the last relay report. */
export function relativeTime(iso: string | null, now: Date = new Date()): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'} ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// ── Redis provisioning truth ─────────────────────────────────────────────────

/**
 * Provisioning states for a Redis-requiring deployment. "Required and
 * detected" is not "provisioned": only the relay's cache check observing an
 * actual ElastiCache resource in AWS says the cache exists.
 */
export type RedisProvisioningStatus = 'HEALTHY' | 'UNHEALTHY' | 'NOT_PROVISIONED' | 'NOT_REPORTING';

export const REDIS_STATUS_LABEL: Record<RedisProvisioningStatus, string> = {
  HEALTHY: 'Healthy',
  UNHEALTHY: 'Unhealthy',
  NOT_PROVISIONED: 'Not provisioned',
  NOT_REPORTING: 'Not reporting',
};

/**
 * Derives Redis provisioning from observed AWS resources, never from
 * application analysis. Null when the application does not require Redis
 * (no row at all).
 */
export function redisProvisioningStatus(
  componentStatus: string | undefined,
  infraChecks: readonly InfraCheck[],
): RedisProvisioningStatus | null {
  if (componentStatus === undefined) return null;
  const cacheCheck = infraChecks.find((check) => check.name === 'cache');
  if (!cacheCheck) return 'NOT_REPORTING';
  if (!cacheCheck.passed) return 'NOT_PROVISIONED';
  if (componentStatus === 'UNHEALTHY' || componentStatus === 'DEGRADED') return 'UNHEALTHY';
  if (componentStatus === 'UNKNOWN') return 'NOT_REPORTING';
  return 'HEALTHY';
}
