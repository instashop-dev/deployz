// §42 onboarding + §19 readiness surfaces — data access + presentation data.
// Wired to the real `GET /api/applications/:id/readiness` endpoint. §19/§20:
// the verdict is always the deterministic rules-engine result — there is no
// AI explanation field on the wire (that stays out of scope until the AI
// explanation endpoint exists — never fabricated client-side). §65: all copy
// here is jargon-free.

import { apiUrl } from '@/lib/api-url';

// ── §42 onboarding steps (VERBATIM) ─────────────────────────────────────────

/** The six §42 onboarding steps, in exact order. Success = readiness (§5). */
export const ONBOARDING_STEPS = [
  'Connect GitHub',
  'Choose repository',
  'Analyse',
  'Fix compatibility issues',
  'Create test deployment',
  'Ready for customer deployment',
] as const;

// ── Types ───────────────────────────────────────────────────────────────────

/** Mirrors `analysisStatusEnum` in packages/db. */
export type AnalysisStatus = 'PENDING' | 'ANALYZING' | 'COMPLETE' | 'FAILED';

/** §19 verdict vocabulary (mirrors `compatibilityStatusEnum`). */
export type CompatibilityVerdict = 'READY' | 'NEEDS_ATTENTION' | 'NOT_COMPATIBLE';

/** §19 "Ready" checklist item. */
export interface ReadyCheck {
  label: string;
}

/** §19 "Needs attention" item — its own title, detail, and suggested fix. */
export interface AttentionCheck {
  title: string;
  detail: string;
  suggestedFix: string | null;
}

/** §19 "Unsupported" item — title + why it's rejected outright. */
export interface UnsupportedCheck {
  title: string;
  reason: string;
}

/**
 * The exact `GET /api/applications/:id/readiness` response shape (§19).
 * When `analysisStatus !== 'COMPLETE'` every field below is null/empty —
 * render the pending state, never a fabricated score.
 */
export interface ApplicationReadiness {
  analysisStatus: AnalysisStatus;
  verdict: CompatibilityVerdict | null;
  score: number | null;
  changesRequired: number | null;
  /** Why a FAILED analysis failed. Null in every other state. */
  failureReason: string | null;
  ready: ReadyCheck[];
  needsAttention: AttentionCheck[];
  unsupported: UnsupportedCheck[];
}

/** What to show when the analysis FAILED, or null when it did not. */
export interface ReadinessFailure {
  heading: string;
  detail: string;
}

/**
 * A FAILED analysis is its own state, not a slow one. It used to render as
 * "Analysing your app — this usually takes a minute" while polling had
 * already stopped, so pressing Re-analyse looked like it did nothing
 * whatsoever. Say what happened, and say that pressing it again is the retry.
 */
export function readinessFailure(readiness: ApplicationReadiness): ReadinessFailure | null {
  if (readiness.analysisStatus !== 'FAILED') return null;
  return {
    heading: "We couldn't analyse your app",
    detail:
      readiness.failureReason ?? 'Something went wrong while reading your repository.',
  };
}

// ── §19 verdict presentation ────────────────────────────────────────────────

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

/** §19 "82% — 2 changes required" summary line. */
export function readinessSummaryLabel(score: number, changesRequired: number): string {
  const changeWord = changesRequired === 1 ? 'change' : 'changes';
  return `${score}% — ${changesRequired} ${changeWord} required`;
}

// ── Onboarding step derivation ──────────────────────────────────────────────

/**
 * Where is this application on the §42 six-step flow? Returns the 1-based
 * current step. Steps 1-2 (Connect GitHub, Choose repository) are complete by
 * the time an application exists; success is readiness, not first install.
 */
export function deriveOnboardingStep(input: {
  analysisStatus: AnalysisStatus;
  verdict: CompatibilityVerdict | null;
  testDeploymentCreated: boolean;
}): number {
  if (input.testDeploymentCreated) return 6;
  if (input.analysisStatus !== 'COMPLETE') return 3; // Analyse
  if (input.verdict === 'READY') return 5; // Create test deployment
  return 4; // Fix compatibility issues
}

// ── Fetch ───────────────────────────────────────────────────────────────────

/** Fetch one application's §19 readiness result. */
export async function fetchReadiness(applicationId: string): Promise<ApplicationReadiness> {
  const response = await fetch(
    `${apiUrl}/api/applications/${encodeURIComponent(applicationId)}/readiness`,
    { credentials: 'include', cache: 'no-store' },
  );
  if (!response.ok) {
    throw new Error(`Readiness request failed (${response.status})`);
  }
  return (await response.json()) as ApplicationReadiness;
}
