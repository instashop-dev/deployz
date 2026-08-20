// §42 onboarding + §19 readiness surfaces — data access + presentation data.
// The readiness API endpoint arrives in a later todo; until then
// fetchReadiness falls back to realistic FIXTURE data on a 404 so the
// readiness page renders a verdict without a backend (same pattern as the
// fleet dashboard, todo 19). §19/§20: the verdict is always the deterministic
// rules-engine result — the AI explanation is rendered UNDER it and can never
// change it. §65: all copy here is jargon-free.

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

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

/** Mirrors `analysisStatusSchema` in packages/contracts. */
export type AnalysisStatus = 'PENDING' | 'ANALYZING' | 'COMPLETE' | 'FAILED';

/** §19 verdict vocabulary (mirrors `compatibilityStatusSchema`). */
export type CompatibilityVerdict = 'READY' | 'NEEDS_ATTENTION' | 'NOT_COMPATIBLE';

/** A single deterministic issue from the rules engine (todo 23). */
export interface ReadinessIssue {
  severity: 'reject' | 'attention';
  code: string;
  message: string;
}

/** The §19 deterministic verdict plus the issues that produced it. */
export interface ReadinessVerdict {
  verdict: CompatibilityVerdict;
  reason: string;
  issues: ReadinessIssue[];
}

/** Todo-24 AI explanation — rendered UNDER the deterministic verdict (§20). */
export interface ReadinessExplanation {
  summary: string;
  why: string;
  fix: string;
}

/** Everything the readiness page needs for one application. */
export interface ApplicationReadiness {
  application: {
    id: string;
    name: string;
    repoFullName: string;
    analysisStatus: AnalysisStatus;
  };
  readiness: ReadinessVerdict | null;
  explanation: ReadinessExplanation | null;
  /** §7: whether the vendor's own (free) test deployment already exists. */
  testDeploymentCreated: boolean;
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

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Readiness request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

/** Fetch one application's readiness, falling back to fixture data on 404. */
export async function fetchReadiness(applicationId: string): Promise<ApplicationReadiness> {
  try {
    return await getJson<ApplicationReadiness>(
      `/api/applications/${encodeURIComponent(applicationId)}/readiness`,
    );
  } catch (error) {
    if (isNotFound(error)) return fixtureReadiness(applicationId);
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.includes('(404)');
}

// ── Fixture data (§65 jargon-free) ──────────────────────────────────────────

/**
 * Realistic fixture fallback while the readiness endpoint is absent. Keys
 * match the GitHub fixture repos (fixture-repo-1 ready / fixture-repo-2
 * incompatible, §216) so the whole §42 flow renders end-to-end without a
 * backend. Unknown ids fall back to READY — the success path.
 */
export function fixtureReadiness(applicationId: string): ApplicationReadiness {
  if (applicationId === 'fixture-repo-2' || applicationId.includes('legacy-redis')) {
    return {
      application: {
        id: applicationId,
        name: 'legacy-redis',
        repoFullName: 'deployz-demo/legacy-redis',
        analysisStatus: 'COMPLETE',
      },
      readiness: {
        verdict: 'NOT_COMPATIBLE',
        reason:
          'This app uses Redis for data storage, which is not supported. Deployz provides PostgreSQL for data storage.',
        issues: [
          {
            severity: 'reject',
            code: 'REDIS_DEPENDENCY',
            message: 'Uses Redis for data storage, which is not supported.',
          },
        ],
      },
      explanation: {
        summary: 'This app relies on Redis for data storage.',
        why: 'Deployz runs apps with managed PostgreSQL and does not provision Redis.',
        fix: 'Move the data that lives in Redis to PostgreSQL, then choose your repository again.',
      },
      testDeploymentCreated: false,
    };
  }

  if (applicationId === 'fixture-repo-attention' || applicationId.includes('attention')) {
    return {
      application: {
        id: applicationId,
        name: 'acme-analytics',
        repoFullName: 'deployz-demo/acme-analytics',
        analysisStatus: 'COMPLETE',
      },
      readiness: {
        verdict: 'NEEDS_ATTENTION',
        reason: 'Missing Dockerfile Missing health endpoint',
        issues: [
          { severity: 'attention', code: 'MISSING_DOCKERFILE', message: 'Missing Dockerfile' },
          {
            severity: 'attention',
            code: 'MISSING_HEALTH_ENDPOINT',
            message: 'Missing health endpoint',
          },
        ],
      },
      explanation: {
        summary: 'This app is close to ready, but two things are missing.',
        why: 'Deployz builds your app from its Dockerfile and keeps it healthy through its health endpoint.',
        fix: 'Add a Dockerfile and a health endpoint, then choose your repository again.',
      },
      testDeploymentCreated: false,
    };
  }

  return {
    application: {
      id: applicationId,
      name: applicationId === 'fixture-repo-1' ? 'express-api' : applicationId,
      repoFullName:
        applicationId === 'fixture-repo-1' ? 'deployz-demo/express-api' : applicationId,
      analysisStatus: 'COMPLETE',
    },
    readiness: {
      verdict: 'READY',
      reason: 'Compatible with Deployz',
      issues: [],
    },
    explanation: {
      summary: 'This app passed every check.',
      why: 'It has a Dockerfile, a health endpoint, and uses PostgreSQL for data storage.',
      fix: 'Nothing to fix — your app is ready to deploy.',
    },
    testDeploymentCreated: false,
  };
}
