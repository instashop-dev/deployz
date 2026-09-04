// §42 onboarding + §19 readiness surfaces — data access + presentation data.
// Wired to `GET /api/applications/:id/readiness` and
// `POST /api/applications/:id/fix-instructions`. §19/§20: the readiness
// state and findings are always the deterministic analyser result — AI only
// ever produces the fix-instructions document, never a finding or a state.
// §65: all copy here is jargon-free. Never a percentage.

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

/** Semantic readiness vocabulary — mirrors @deployz/copy-map. */
export type ReadinessState = 'READY' | 'ALMOST_READY' | 'NEEDS_CHANGES' | 'ANALYSIS_INCOMPLETE';

export type FindingSeverity = 'required' | 'recommended';
export type FindingConfidence = 'confirmed' | 'likely' | 'needs_confirmation';

/** One unresolved readiness finding (mirrors @deployz/analysis). */
export interface ReadinessFinding {
  id: string;
  category: string;
  title: string;
  severity: FindingSeverity;
  blocking: boolean;
  plainEnglishExplanation: string;
  whyItMatters: string;
  technicalEvidence: string;
  suggestedOutcome: string;
  confidence: FindingConfidence;
}

/** One passed check, for the collapsed "Passed checks" section. */
export interface PassedCheck {
  id: string;
  label: string;
}

/**
 * The exact `GET /api/applications/:id/readiness` response shape (§19).
 * When `analysisStatus !== 'COMPLETE'` the state is ANALYSIS_INCOMPLETE and
 * every list is empty — render the pending state, never a fabricated result.
 */
export interface ApplicationReadiness {
  analysisStatus: AnalysisStatus;
  state: ReadinessState;
  requiredCount: number;
  recommendedCount: number;
  summary: string | null;
  /** Why a FAILED analysis failed. Null in every other state. */
  failureReason: string | null;
  findings: ReadinessFinding[];
  passed: PassedCheck[];
  /** The commit the analysis ran against, when known. */
  analyzedCommitSha: string | null;
  /** What the analysis detected (mirrors `ApplicationAnalysis` in @deployz/contracts). Null until a recent analysis ran. */
  detected: DetectedApplication | null;
}

// ── Detected facts (mirrors `ApplicationAnalysis` in @deployz/contracts) ────

export type FactSource =
  | 'dockerfile'
  | 'package-manifest'
  | 'compose'
  | 'env-file'
  | 'procfile'
  | 'source'
  | 'ai'
  | 'none';

export interface AnalysisEvidence {
  file?: string;
  reason: string;
}

export interface DetectedFact<T> {
  value: T;
  source: FactSource;
  confidence: FindingConfidence;
  evidence: AnalysisEvidence[];
}

export interface DetectedApplication {
  analysisVersion: number;
  runtime: DetectedFact<string>;
  framework: DetectedFact<string | null>;
  build: DetectedFact<string | null>;
  start: DetectedFact<string | null>;
  network: {
    port: DetectedFact<number | null>;
    bindAddress: DetectedFact<'all-interfaces' | 'localhost' | null>;
  };
  database: {
    required: boolean;
    type: 'postgres' | 'unsupported' | 'none';
    confidence: FindingConfidence;
    evidence: AnalysisEvidence[];
  };
  redis: {
    required: boolean;
    detected: boolean;
    supported: boolean;
    confidence: FindingConfidence;
    purposes: string[];
    evidence: AnalysisEvidence[];
  };
  storage: {
    persistentLocalRequired: boolean;
    objectStorageDetected: boolean;
    evidence: AnalysisEvidence[];
  };
  healthCheck: {
    detected: boolean;
    path: string | null;
    confidence: FindingConfidence;
    evidence: AnalysisEvidence[];
  };
  migrations: {
    detected: boolean;
    command: string | null;
    tools: string[];
    evidence: AnalysisEvidence[];
  };
  environmentVariables: { key: string; required: boolean; secret: boolean; source: string[] }[];
}

/** One row of the "What Deployz detected" list. */
export interface DetectedFactRow {
  id: string;
  label: string;
  /** The normalized value in plain words, or what "not found" means for this fact. */
  value: string;
  /** Whether the value was found (a missing value renders quieter). */
  found: boolean;
  /** Where the value came from / how sure the analysis is — one short hint, or null when the value was not found. */
  hint: string | null;
  /** Renders the value as code (commands, paths, ports). */
  code: boolean;
  evidence: AnalysisEvidence[];
}

const RUNTIME_LABELS: Record<string, string> = {
  node: 'Node.js',
  python: 'Python',
  ruby: 'Ruby',
  go: 'Go',
  jvm: 'Java / JVM',
  dotnet: '.NET',
  php: 'PHP',
  elixir: 'Elixir',
  rust: 'Rust',
};

const SOURCE_HINTS: Record<FactSource, string | null> = {
  dockerfile: 'From the container setup',
  'package-manifest': 'From the package configuration',
  compose: 'From the compose file',
  'env-file': 'From an env file',
  procfile: 'From the Procfile',
  source: 'Inferred from the source code',
  ai: 'Inferred by AI analysis — verify before relying on it',
  none: null,
};

const CONFIDENCE_HINTS: Record<FindingConfidence, string | null> = {
  confirmed: null,
  likely: 'Likely',
  needs_confirmation: 'Needs confirmation',
};

function factHint(fact: { source: FactSource; confidence: FindingConfidence }): string | null {
  const parts = [SOURCE_HINTS[fact.source], fact.source === 'ai' ? null : CONFIDENCE_HINTS[fact.confidence]].filter(
    (part): part is string => part !== null,
  );
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * The detected facts as display rows, in reading order. Every value is
 * plain words or a short code value — never a percentage, never AWS
 * vocabulary. Evidence stays available for the row's disclosure.
 */
export function detectedFactRows(detected: DetectedApplication): DetectedFactRow[] {
  const command = (id: string, label: string, fact: DetectedFact<string | null>): DetectedFactRow => ({
    id,
    label,
    value: fact.value ?? 'Not found',
    found: fact.value !== null,
    hint: fact.value !== null ? factHint(fact) : null,
    code: fact.value !== null,
    evidence: fact.evidence,
  });

  const runtimeFound = detected.runtime.value !== 'unknown';
  const database = detected.database;
  const redis = detected.redis;
  const storage = detected.storage;
  const health = detected.healthCheck;
  const migrations = detected.migrations;

  return [
    {
      id: 'runtime',
      label: 'Runtime',
      value: runtimeFound ? RUNTIME_LABELS[detected.runtime.value] ?? detected.runtime.value : 'Not detected',
      found: runtimeFound,
      hint: runtimeFound ? factHint(detected.runtime) : null,
      code: false,
      evidence: detected.runtime.evidence,
    },
    {
      id: 'framework',
      label: 'Framework',
      value: detected.framework.value ?? 'None detected',
      found: detected.framework.value !== null,
      hint: detected.framework.value !== null ? factHint(detected.framework) : null,
      code: false,
      evidence: detected.framework.evidence,
    },
    command('start', 'Start command', detected.start),
    command('build', 'Build command', detected.build),
    {
      id: 'port',
      label: 'Port',
      value: detected.network.port.value !== null ? String(detected.network.port.value) : 'Not found',
      found: detected.network.port.value !== null,
      hint: detected.network.port.value !== null ? factHint(detected.network.port) : null,
      code: detected.network.port.value !== null,
      evidence: detected.network.port.evidence,
    },
    {
      id: 'database',
      label: 'Database',
      value:
        database.type === 'postgres'
          ? database.required
            ? 'PostgreSQL — Deployz provides a managed database'
            : 'PostgreSQL library present — not confirmed as required'
          : database.type === 'unsupported'
            ? 'Unsupported database'
            : 'None detected',
      found: database.type === 'postgres',
      hint: database.type === 'postgres' ? CONFIDENCE_HINTS[database.confidence] : null,
      code: false,
      evidence: database.evidence,
    },
    {
      id: 'redis',
      label: 'Cache / queue',
      value: redis.required
        ? `Redis — provisioned automatically${redis.purposes.length > 0 && !redis.purposes.includes('unknown') ? ` (${redis.purposes.join(', ')})` : ''}`
        : redis.detected
          ? redis.supported
            ? 'Redis usage detected — not confirmed as required'
            : 'Redis setup not supported'
          : 'None detected',
      found: redis.detected,
      hint: redis.detected ? CONFIDENCE_HINTS[redis.confidence] : null,
      code: false,
      evidence: redis.evidence,
    },
    {
      id: 'storage',
      label: 'File storage',
      value: storage.persistentLocalRequired
        ? 'Files written to local disk'
        : storage.objectStorageDetected
          ? 'Object storage — Deployz provides a bucket'
          : 'None detected',
      found: storage.objectStorageDetected || storage.persistentLocalRequired,
      hint: null,
      code: false,
      evidence: storage.evidence,
    },
    {
      id: 'health',
      label: 'Health check',
      value: health.detected ? health.path ?? 'Found' : 'Not found',
      found: health.detected,
      hint: health.detected ? CONFIDENCE_HINTS[health.confidence] : null,
      code: health.detected && health.path !== null,
      evidence: health.evidence,
    },
    {
      id: 'migrations',
      label: 'Database migrations',
      value: migrations.command ?? (migrations.detected ? migrations.tools.join(', ') || 'Found' : 'None detected'),
      found: migrations.detected,
      hint: null,
      code: migrations.command !== null,
      evidence: migrations.evidence,
    },
  ];
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
    heading: "We couldn't check deployment readiness",
    detail:
      readiness.failureReason ?? 'Something went wrong while reading your repository.',
  };
}

// ── Semantic state presentation (mirrors @deployz/copy-map) ─────────────────

export interface ReadinessStatePresentation {
  /** Short badge label. */
  label: string;
  /** Visual tone — READY is green (§19). */
  tone: 'ready' | 'attention' | 'incompatible' | 'pending';
}

export const READINESS_STATE_PRESENTATION: Record<ReadinessState, ReadinessStatePresentation> = {
  READY: { label: 'Ready', tone: 'ready' },
  ALMOST_READY: { label: 'Action needed', tone: 'attention' },
  NEEDS_CHANGES: { label: 'Changes needed', tone: 'incompatible' },
  ANALYSIS_INCOMPLETE: { label: 'Checking…', tone: 'pending' },
};

/** Map a persisted §19 verdict onto the semantic readiness state (mirrors
 *  @deployz/copy-map) — for surfaces that only have `compatibilityStatus`. */
export function readinessStateFromVerdict(verdict: CompatibilityVerdict): ReadinessState {
  if (verdict === 'READY') return 'READY';
  if (verdict === 'NEEDS_ATTENTION') return 'ALMOST_READY';
  return 'NEEDS_CHANGES';
}

/** "2 changes needed before deployment" (mirrors @deployz/copy-map) — a
 *  blocked state, never "almost ready": as long as a required check fails,
 *  deployment is blocked. */
export function readinessChangesHeading(count: number): string {
  return `${count} ${count === 1 ? 'change' : 'changes'} needed before deployment`;
}

/** The state headline (mirrors @deployz/copy-map). Blocked states read out
 *  the change count (§65: never "Almost ready" while deployment is actually
 *  blocked). */
export function readinessStateHeading(state: ReadinessState, changesCount: number): string {
  if (state === 'READY') return 'Ready to deploy';
  if (state === 'ANALYSIS_INCOMPLETE') return 'Checking deployment readiness…';
  return readinessChangesHeading(changesCount);
}

/** "4 of 6 checks passed" (mirrors @deployz/copy-map) — a check count,
 *  never a percentage. */
export function readinessChecksLabel(passedCount: number, totalCount: number): string {
  return `${passedCount} of ${totalCount} checks passed`;
}

/** Supporting line under a blocked state's heading (mirrors
 *  @deployz/copy-map). */
export function readinessBlockedSummary(
  passedCount: number,
  totalCount: number,
  changesCount: number,
): string {
  return `Your application passed ${passedCount} of ${totalCount} deployment checks. Fix the ${
    changesCount === 1 ? 'item' : 'items'
  } below before deploying.`;
}

/** Supporting line for the READY state (mirrors @deployz/copy-map). */
export const READINESS_SUPPORT_READY = 'Your application passed all required deployment checks.';

/** Supporting line while the analysis is still running (mirrors
 *  @deployz/copy-map). */
export const READINESS_SUPPORT_RUNNING =
  "We're reading your repository to see if it can be deployed. This usually takes a minute.";

/** Supporting line under the fix-instructions CTA (mirrors
 *  @deployz/copy-map). */
export function readinessFixCtaSupport(issuesCount: number): string {
  return `Creates one prompt to fix ${
    issuesCount === 1 ? 'this 1 issue' : `these ${issuesCount} issues`
  } with your coding agent.`;
}

// ── Onboarding step derivation ──────────────────────────────────────────────

/**
 * Where is this application on the §42 six-step flow? Returns the 1-based
 * current step. Steps 1-2 (Connect GitHub, Choose repository) are complete by
 * the time an application exists; success is readiness, not first install.
 */
export function deriveOnboardingStep(input: {
  analysisStatus: AnalysisStatus;
  state: ReadinessState;
  testDeploymentCreated: boolean;
}): number {
  if (input.testDeploymentCreated) return 6;
  if (input.analysisStatus !== 'COMPLETE') return 3; // Analyse
  if (input.state === 'READY') return 5; // Create test deployment
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

// ── Fix instructions ────────────────────────────────────────────────────────

/** A successful fix-instructions generation. */
export interface FixInstructions {
  instructions: string;
  generatedAt: string;
}

/**
 * Generate the consolidated coding-agent prompt for the unresolved findings.
 * Generation is read-only: it never changes findings or the readiness state.
 * Every failure is retryable — the API's message says so in plain English.
 */
export async function generateFixInstructions(applicationId: string): Promise<FixInstructions> {
  const response = await fetch(
    `${apiUrl}/api/applications/${encodeURIComponent(applicationId)}/fix-instructions`,
    { method: 'POST', credentials: 'include' },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(
      body?.error?.message ?? "We couldn't generate the instructions right now. Try again in a moment.",
    );
  }
  return (await response.json()) as FixInstructions;
}
