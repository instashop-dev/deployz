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
