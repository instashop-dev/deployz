import type { FailureCode } from './diagnostic-vocabulary';

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
export interface Diagnostic {
  failureCode: FailureCode;
  event: DiagnosticEvent;
  explanation: DiagnosticExplanation | null;
  occurredAt: string;
}

interface DiagnosticsApiResponse {
  failureCode: string | null;
  what: string | null;
  why: string | null;
  fix: string | null;
  events: Array<{
    occurredAt: string;
    eventType: string;
    result: string | null;
  }>;
}

// ── Fetch helper ────────────────────────────────────────────────────────────

/**
 * Fetch a deployment's diagnostics. The API returns a single what/why/fix
 * classification for the deployment (not one per event) — a healthy or
 * non-failed deployment gets `failureCode: null`, which maps to an empty
 * list (the "no issues" state).
 */
export async function fetchDiagnostics(id: string): Promise<Diagnostic[]> {
  const response = await fetch(`${apiUrl}/api/deployments/${encodeURIComponent(id)}/diagnostics`, {
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Diagnostics request failed (${response.status})`);
  const body = (await response.json()) as DiagnosticsApiResponse;
  if (!body.failureCode) return [];

  const latestEvent = body.events[body.events.length - 1];
  return [
    {
      failureCode: body.failureCode as FailureCode,
      occurredAt: latestEvent?.occurredAt ?? new Date().toISOString(),
      event: latestEvent
        ? { source: 'deployment', action: latestEvent.eventType }
        : { source: 'deployment' },
      explanation:
        body.what && body.why && body.fix
          ? { what: body.what, why: body.why, fix: body.fix }
          : null,
    },
  ];
}

// ── Relay-observed infrastructure checks ─────────────────────────────────────

/** One check as the relay observed it (verify.js emits {name, passed, detail}). */
export interface InfraCheck {
  name: string;
  passed: boolean;
  detail: string;
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
