// §42 onboarding + §19 readiness surfaces — data access + presentation data.
// Wired to `GET /api/applications/:id/readiness` and
// `POST /api/applications/:id/fix-instructions`. §19/§20: the readiness
// state and findings are always the deterministic analyser result — AI only
// ever produces the fix-instructions document, never a finding or a state.
// §65: all copy here is jargon-free. Never a percentage.

import { apiUrl } from '@/lib/api-url';
import type { Application } from '@/lib/applications';
import type { FleetDeployment } from '@/lib/deployments';

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
  environmentVariables: {
    key: string;
    required: boolean;
    secret: boolean;
    source: string[];
    /** Who supplies the value (mirrors `EnvVariableClassification` in @deployz/contracts); absent on older analyses. */
    classification?: 'deployz_managed' | 'deployz_generated' | 'customer_required' | 'optional' | 'unknown';
  }[];
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

// ── Application readiness page redesign helpers ───────────────────────────

/** The four lifecycle steps shown at the top of the redesigned readiness page. */
export type LifecycleStep = 'Analyze' | 'Prepare' | 'Test' | 'Customer ready';

export type LifecycleStepState =
  | { state: 'pending'; label: string }
  | { state: 'current'; label: string }
  | { state: 'done'; label: string }
  | { state: 'failed'; label: string };

function latestTestDeployment(deployments: FleetDeployment[]): FleetDeployment | null {
  const testDeployments = deployments
    .filter((d) => d.deploymentType === 'TEST' && !d.deletedAt)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return testDeployments[0] ?? null;
}

function testDeploymentStepLabel(deployment: FleetDeployment | null): LifecycleStepState {
  if (!deployment) return { state: 'pending', label: 'Not started' };
  if (deployment.state === 'HEALTHY') return { state: 'done', label: 'Verified' };
  if (deployment.state === 'FAILED') return { state: 'failed', label: 'Failed' };
  if (
    deployment.state === 'NOT_INSTALLED' ||
    deployment.state === 'WAITING_FOR_RELAY' ||
    deployment.state === 'INSTALLING' ||
    deployment.state === 'UPDATING'
  ) {
    return { state: 'current', label: 'Deploying' };
  }
  return { state: 'pending', label: 'Not started' };
}

/**
 * Derive the four-step lifecycle for the redesigned readiness page.
 * The first three steps can be pending/current/done/failed; the last step is
 * only done when every prerequisite is met.
 */
export function deriveLifecycleSteps(input: {
  analysisStatus: AnalysisStatus;
  readiness: ApplicationReadiness;
  deployments: FleetDeployment[];
}): Record<LifecycleStep, LifecycleStepState> {
  const { analysisStatus, readiness, deployments } = input;

  let analyze: LifecycleStepState;
  if (analysisStatus === 'FAILED') {
    analyze = { state: 'failed', label: 'Failed' };
  } else if (analysisStatus === 'COMPLETE') {
    analyze = { state: 'done', label: 'Done' };
  } else if (analysisStatus === 'ANALYZING') {
    analyze = { state: 'current', label: 'Analyzing' };
  } else {
    analyze = { state: 'pending', label: 'Analyze' };
  }

  const requiredFindings = readiness.findings.filter((f) => f.severity === 'required');
  let prepare: LifecycleStepState;
  if (analysisStatus !== 'COMPLETE') {
    prepare = { state: 'pending', label: 'Prepare' };
  } else if (requiredFindings.length > 0) {
    prepare = { state: 'current', label: 'Action required' };
  } else {
    prepare = { state: 'done', label: 'Ready' };
  }

  const testDeployment = latestTestDeployment(deployments);
  const testStep = testDeploymentStepLabel(testDeployment);

  let customerReady: LifecycleStepState;
  if (
    analysisStatus === 'COMPLETE' &&
    requiredFindings.length === 0 &&
    testDeployment?.state === 'HEALTHY'
  ) {
    customerReady = { state: 'done', label: 'Ready' };
  } else {
    customerReady = { state: 'pending', label: 'Customer ready' };
  }

  return {
    Analyze: analyze,
    Prepare: prepare,
    Test: testStep,
    'Customer ready': customerReady,
  };
}

/** Header copy for the redesigned readiness page. */
export interface ReadinessHeaderPresentation {
  heading: string;
  supportingLine: string;
}

/** What the redesigned readiness page header should say for a given state. */
export function readinessHeaderPresentation(
  readiness: ApplicationReadiness,
): ReadinessHeaderPresentation {
  if (readiness.analysisStatus === 'FAILED') {
    return {
      heading: "We couldn't check deployment readiness",
      supportingLine:
        readiness.failureReason ?? 'Something went wrong while reading your repository.',
    };
  }

  if (readiness.analysisStatus !== 'COMPLETE') {
    return {
      heading: 'Analyzing application',
      supportingLine: READINESS_SUPPORT_RUNNING,
    };
  }

  const requiredFindings = readiness.findings.filter((f) => f.severity === 'required');
  const requiredPassed = Math.max(0, readiness.requiredCount - requiredFindings.length);
  const recommendedFindings = readiness.findings.filter((f) => f.severity === 'recommended');

  if (requiredFindings.length > 0) {
    const issueWord = requiredFindings.length === 1 ? 'issue' : 'issues';
    return {
      heading: 'Action required before deployment',
      supportingLine: `${requiredPassed} of ${readiness.requiredCount} required checks passed · ${requiredFindings.length} blocking ${issueWord}`,
    };
  }

  let supportingLine = `${readiness.requiredCount} required checks passed`;
  if (recommendedFindings.length > 0) {
    const recWord = recommendedFindings.length === 1 ? 'recommendation' : 'recommendations';
    supportingLine += ` · ${recommendedFindings.length} ${recWord}`;
  }

  if (readiness.state === 'READY') {
    return {
      heading: 'Ready for test deployment',
      supportingLine,
    };
  }

  return {
    heading: 'Recommendation',
    supportingLine,
  };
}

/** Editable fields the readiness table lets a vendor override. */
export type EditableReadinessField =
  | 'containerPort'
  | 'healthPath'
  | 'migrationCommand'
  | 'databaseRequired'
  | 'storageRequired'
  | 'redisRequired';

type ApplicationReadinessFields = Pick<
  Application,
  'containerPort' | 'healthPath' | 'migrationCommand' | 'databaseRequired' | 'storageRequired' | 'redisRequired'
>;

/** Whether a given editable field is currently overridden (differs from detected). */
export function isFieldOverridden(
  field: EditableReadinessField,
  application: ApplicationReadinessFields,
  detected: DetectedApplication | null,
): boolean {
  if (!detected) return false;
  switch (field) {
    case 'containerPort':
      return (
        application.containerPort !== null &&
        application.containerPort !== (detected.network.port.value ?? null)
      );
    case 'healthPath':
      return (
        application.healthPath !== null &&
        application.healthPath !== (detected.healthCheck.path ?? null)
      );
    case 'migrationCommand':
      return (
        application.migrationCommand !== null &&
        application.migrationCommand !== (detected.migrations.command ?? null)
      );
    case 'databaseRequired':
      return application.databaseRequired !== detected.database.required;
    case 'storageRequired': {
      const detectedStorage =
        detected.storage.persistentLocalRequired || detected.storage.objectStorageDetected;
      return application.storageRequired !== detectedStorage;
    }
    case 'redisRequired':
      return application.redisRequired !== detected.redis.required;
    default:
      return false;
  }
}

/** The value Deployz will use for an editable field: application value if set, else detected. */
export function effectiveFieldValue(
  field: EditableReadinessField,
  application: ApplicationReadinessFields,
  detected: DetectedApplication | null,
): string {
  if (!detected) {
    if (field === 'containerPort') return application.containerPort?.toString() ?? '';
    if (field === 'healthPath') return application.healthPath ?? '';
    if (field === 'migrationCommand') return application.migrationCommand ?? '';
    if (field === 'databaseRequired') return application.databaseRequired ? 'Required' : 'Not required';
    if (field === 'storageRequired') return application.storageRequired ? 'Required' : 'Not required';
    if (field === 'redisRequired') return application.redisRequired ? 'Required' : 'Not required';
    return '';
  }
  switch (field) {
    case 'containerPort':
      return (
        application.containerPort?.toString() ??
        detected.network.port.value?.toString() ??
        ''
      );
    case 'healthPath':
      return application.healthPath ?? detected.healthCheck.path ?? '';
    case 'migrationCommand':
      return application.migrationCommand ?? detected.migrations.command ?? '';
    case 'databaseRequired':
      return application.databaseRequired || detected.database.required ? 'Required' : 'Not required';
    case 'storageRequired':
      return application.storageRequired ||
        detected.storage.persistentLocalRequired ||
        detected.storage.objectStorageDetected
        ? 'Required'
        : 'Not required';
    case 'redisRequired':
      return application.redisRequired || detected.redis.required ? 'Required' : 'Not required';
    default:
      return '';
  }
}

/** The raw detected value for an editable field, as a display string. */
export function detectedFieldValue(
  field: EditableReadinessField,
  detected: DetectedApplication | null,
): string {
  if (!detected) return '';
  switch (field) {
    case 'containerPort':
      return detected.network.port.value?.toString() ?? '';
    case 'healthPath':
      return detected.healthCheck.path ?? '';
    case 'migrationCommand':
      return detected.migrations.command ?? '';
    case 'databaseRequired':
      return detected.database.required ? 'Required' : 'Not required';
    case 'storageRequired': {
      const required =
        detected.storage.persistentLocalRequired || detected.storage.objectStorageDetected;
      return required ? 'Required' : 'Not required';
    }
    case 'redisRequired':
      return detected.redis.required ? 'Required' : 'Not required';
    default:
      return '';
  }
}

// ── Readiness table rows ────────────────────────────────────────────────────

/** One setting row in the redesigned deployment-readiness table. */
export interface ReadinessTableSetting {
  kind: 'setting';
  id: string;
  label: string;
  value: string;
  detectedValue: string;
  overridden: boolean;
  editable: boolean;
  field: EditableReadinessField | null;
  evidence: AnalysisEvidence[];
}

/** One passed-check row in the redesigned deployment-readiness table. */
export interface ReadinessTablePassed {
  kind: 'passed';
  id: string;
  check: PassedCheck;
}

/** One finding row in the redesigned deployment-readiness table. */
export interface ReadinessTableFinding {
  kind: 'finding';
  id: string;
  finding: ReadinessFinding;
}

export type ReadinessRow = ReadinessTableSetting | ReadinessTablePassed | ReadinessTableFinding;

const EDITABLE_FIELD_FOR_SETTING: Record<string, EditableReadinessField | null> = {
  runtime: null,
  framework: null,
  start: null,
  build: null,
  port: 'containerPort',
  database: 'databaseRequired',
  redis: 'redisRequired',
  storage: 'storageRequired',
  health: 'healthPath',
  migrations: 'migrationCommand',
};

/**
 * Build the rows for the redesigned deployment-readiness table: settings
 * derived from detected facts, any passed checks, and any unresolved findings.
 */
export function deriveReadinessRows(
  application: Application,
  readiness: ApplicationReadiness,
): ReadinessRow[] {
  const rows: ReadinessRow[] = [];

  // Settings from detected facts.
  if (readiness.detected) {
    const detectedRows = detectedFactRows(readiness.detected);
    for (const fact of detectedRows) {
      const field = EDITABLE_FIELD_FOR_SETTING[fact.id] ?? null;
      let value = fact.value;
      let detectedValue = fact.value;
      let overridden = false;
      if (field) {
        // Boolean settings (database, cache/queue, storage) show the rich
        // detected fact as the primary value, with the effective required/not
        // required state as secondary text. When overridden, the value becomes
        // the effective state and the secondary line shows the detected fact.
        const booleanSettings = ['database', 'redis', 'storage'];
        if (booleanSettings.includes(fact.id)) {
          const effectiveState = effectiveFieldValue(field, application, readiness.detected);
          const detectedState = detectedFieldValue(field, readiness.detected);
          overridden = isFieldOverridden(field, application, readiness.detected);
          value = overridden ? effectiveState : fact.value;
          detectedValue = overridden ? fact.value : detectedState;
        } else {
          value = effectiveFieldValue(field, application, readiness.detected);
          detectedValue = detectedFieldValue(field, readiness.detected);
          overridden = isFieldOverridden(field, application, readiness.detected);
        }
      }
      rows.push({
        kind: 'setting',
        id: fact.id,
        label: fact.label,
        value,
        detectedValue,
        overridden,
        editable: field !== null,
        field,
        evidence: fact.evidence,
      });
    }
  }

  // Background worker is not part of the detected facts; surface it only when
  // the vendor has configured one on the application row.
  if (application.workerCommand) {
    rows.push({
      kind: 'setting',
      id: 'worker',
      label: 'Background worker',
      value: application.workerCommand,
      detectedValue: '',
      overridden: false,
      editable: false,
      field: null,
      evidence: [],
    });
  }

  // Passed checks and findings render after settings so issues stay near the
  // bottom where the CTA points.
  for (const check of readiness.passed) {
    rows.push({ kind: 'passed', id: check.id, check });
  }
  for (const finding of readiness.findings) {
    rows.push({ kind: 'finding', id: finding.id, finding });
  }

  return rows;
}

// ── Fix instructions ────────────────────────────────────────────────────────

/** "Generated 5 Sept 2026, 14:02" — when the document was produced. */
export function fixInstructionsGeneratedLabel(generatedAt: string): string {
  const date = new Date(generatedAt);
  if (Number.isNaN(date.getTime())) return 'Generated for this analysis';
  return `Generated ${date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
}

/** The reuse note shown when the document came from the cache. */
export const FIX_INSTRUCTIONS_REUSED_NOTE =
  'Reused the instructions generated earlier for this analysis. Regenerate to write them again.';

/** A successful fix-instructions generation. */
export interface FixInstructions {
  instructions: string;
  generatedAt: string;
  /** True when the document was reused from an earlier generation for the same analysis. */
  cached: boolean;
}

/**
 * Generate the consolidated coding-agent prompt for the unresolved findings.
 * Generation is read-only: it never changes findings or the readiness state.
 * Every failure is retryable — the API's message says so in plain English.
 */
export async function generateFixInstructions(
  applicationId: string,
  options: { regenerate?: boolean } = {},
): Promise<FixInstructions> {
  const response = await fetch(
    `${apiUrl}/api/applications/${encodeURIComponent(applicationId)}/fix-instructions`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ regenerate: options.regenerate === true }),
    },
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
