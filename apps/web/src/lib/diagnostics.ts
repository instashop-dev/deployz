import type { FailureCode } from './diagnostic-vocabulary';

// Diagnostics data access. The diagnostics endpoint arrives in a later todo
// (or is AI-gated); until then this fetcher falls back to FIXTURE data on a
// 404 so the diagnostics surface renders without a backend. §65 vocabulary
// at the top level — raw AWS/ECS terms only inside the expandable technical
// detail. Code-driven ONLY: no diagnostic bundles, no log export (S3).

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

// ── Wire shapes ────────────────────────────────────────────────────────────

/** A structured diagnostic event (§16: structured slots only, never raw logs). */
export interface DiagnosticEvent {
  /** Where the event originated (e.g. 'ecs', 'rds', 'health-check', 'relay'). */
  source: string;
  /** The action being performed, if known. */
  action?: string;
  /** The structured signal carried, if known. */
  signal?: string;
  /** Structured error, if the event reports a failure. */
  error?: {
    code?: string;
    message?: string;
    statusCode?: number;
  };
  /** Structured scalar context (string/number/boolean only — §16). */
  context?: Record<string, string | number | boolean>;
}

/** The AI-generated plain-English explanation (todo 29), when available. */
export interface DiagnosticExplanation {
  what: string;
  why: string;
  fix: string;
}

/**
 * One classified diagnostic: the deterministic §61 code, the structured event
 * that produced it (rendered behind the expandable layer), and the optional
 * AI explanation — all code-driven (no bundles, no log export).
 */
export interface Diagnostic {
  failureCode: FailureCode;
  event: DiagnosticEvent;
  explanation: DiagnosticExplanation | null;
  occurredAt: string;
}

interface DiagnosticsResponse {
  diagnostics?: Diagnostic[];
}

// ── Fetch helper ────────────────────────────────────────────────────────────

/** Fetch a deployment's diagnostics, falling back to fixture data on a 404. */
export async function fetchDiagnostics(id: string): Promise<Diagnostic[]> {
  try {
    const response = await fetch(
      `${apiUrl}/api/deployments/${encodeURIComponent(id)}/diagnostics`,
      { credentials: 'include', cache: 'no-store' },
    );
    if (!response.ok) throw new Error(`Diagnostics request failed (${response.status})`);
    const body = (await response.json()) as DiagnosticsResponse;
    return body.diagnostics ?? [];
  } catch (error) {
    if (error instanceof Error && error.message.includes('(404)')) {
      return FIXTURE_DIAGNOSTICS[id] ?? [];
    }
    throw error;
  }
}

// ── Fixture data (§65 copy; raw terms only inside structured slots) ─────────

export const FIXTURE_DIAGNOSTICS: Record<string, Diagnostic[]> = {
  // The failed fixture deployment: one explained + one vocabulary-only issue,
  // proving both card paths (AI explanation optional, §20).
  'deployment-globex-portal': [
    {
      failureCode: 'ECS_DEPLOYMENT_FAILED',
      occurredAt: '2026-08-20T08:20:00.000Z',
      event: {
        source: 'ecs',
        action: 'deploy-update',
        error: {
          code: 'ServiceError',
          message: 'The service stopped before the new version became healthy.',
          statusCode: 502,
        },
      },
      explanation: {
        what: "The latest update didn't finish rolling out, so the app is down.",
        why: 'The new version stopped responding partway through the update.',
        fix: 'Roll back to the previous version from the deployment page, then check why the new version stopped.',
      },
    },
    {
      failureCode: 'RDS_UNAVAILABLE',
      occurredAt: '2026-08-20T08:22:00.000Z',
      event: {
        source: 'rds',
        signal: 'availability',
        context: { available: false },
      },
      explanation: null,
    },
  ],
};
