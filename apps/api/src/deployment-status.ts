import { FAILURE_REMEDIATION, failureCodeCopy, type FailureCode } from '@deployz/copy-map';
import {
  DEPLOYMENT_STEP_ORDER,
  TYPICAL_STEP_DURATION_SECONDS,
  type ComponentProgress,
  type ComponentProgressStatus,
  type CustomDomainStatus,
  type CustomerDeploymentStatus,
  type DeploymentStage,
  type DeploymentState,
  type DeploymentStep,
  type HealthStatus,
  type JobState,
  type JobType,
  type RelayStatus,
  type VendorDeploymentStatus,
} from '@deployz/contracts';

// Unified deployment status — the read-time derivation described in
// packages/contracts/src/index.ts above customerDeploymentStatusSchema.
// Everything below is pure: given the same inputs it always returns the
// same DerivedDeploymentStatus, and nothing here reads a clock except the
// documented now() fallback for `updatedAt`. That purity is what makes the
// six-stage model unit-testable without a database and safe to call once
// per row in a list endpoint.

// ---------------------------------------------------------------------------
// §24 per-component merge — extracted from toFleetRow (server.ts), which
// still calls this. The relay's verification checks say what SHOULD exist
// (observedState.infraHealth.checks); its heartbeat says what is OBSERVED
// (observedState.components). Combining the two is what lets a screen say
// "Not provisioned" (required, verification found nothing) instead of "Not
// reporting" (no observation at all). Kept as ONE implementation so the
// fleet dashboard and the new stage derivation can never disagree about a
// component's merged state.
// ---------------------------------------------------------------------------

/** Whether each optional component is required, per the owning application. */
export interface ComponentRequirements {
  databaseRequired?: boolean | null;
  storageRequired?: boolean | null;
  redisRequired?: boolean | null;
}

/** Merged per-component state: HEALTHY/DEGRADED/UNHEALTHY/UNKNOWN/NOT_PROVISIONED. */
export type MergedComponentState = Record<string, string>;

const COMPONENT_REQUIREMENT_KEYS = ['application', 'loadBalancer', 'database', 'storage', 'redis'] as const;

// The verification check name each merged component key corresponds to —
// used to fall back to NOT_PROVISIONED/UNKNOWN when the heartbeat never
// reported the component at all.
const VERIFY_CHECK_BY_COMPONENT: Record<(typeof COMPONENT_REQUIREMENT_KEYS)[number], string> = {
  application: 'compute',
  loadBalancer: 'ingress',
  database: 'database',
  storage: 'storage',
  redis: 'cache',
};

/**
 * Merge a deployment's observed heartbeat components with its verification
 * checks into one per-key state map, or null when nothing is known yet.
 *   reported          → that state (HEALTHY/DEGRADED/UNHEALTHY/UNKNOWN)
 *   check says absent → NOT_PROVISIONED
 *   otherwise         → UNKNOWN when required, omitted when not
 */
export function mergeComponentState(
  observedState: Record<string, unknown> | null | undefined,
  requirements: ComponentRequirements,
): MergedComponentState | null {
  const observed = observedState as
    | {
        components?: Record<string, unknown>;
        infraHealth?: { checks?: { name?: string; passed?: boolean }[] };
      }
    | null
    | undefined;
  const components: Record<string, string> = {};
  for (const [key, value] of Object.entries(observed?.components ?? {})) {
    if (typeof value === 'string') components[key] = value;
  }
  const infraChecks = observed?.infraHealth?.checks ?? [];
  const componentRequirements: Record<(typeof COMPONENT_REQUIREMENT_KEYS)[number], boolean> = {
    application: true,
    loadBalancer: true,
    database: requirements.databaseRequired ?? false,
    storage: requirements.storageRequired ?? false,
    redis: requirements.redisRequired ?? false,
  };
  for (const key of COMPONENT_REQUIREMENT_KEYS) {
    if (components[key] !== undefined) continue;
    if (!componentRequirements[key]) continue;
    const check = infraChecks.find((candidate) => candidate.name === VERIFY_CHECK_BY_COMPONENT[key]);
    components[key] = check?.passed === false ? 'NOT_PROVISIONED' : 'UNKNOWN';
  }
  return Object.keys(components).length > 0 ? components : null;
}

// ---------------------------------------------------------------------------
// Derivation input — deliberately its own plain-object shape rather than the
// Drizzle row types server.ts uses. A db row satisfies this structurally (so
// server.ts can pass its query results straight through), but this module
// never imports @deployz/db: that is what keeps deriveDeploymentStatus
// callable from a unit test with a handful of object literals and no
// database.
// ---------------------------------------------------------------------------

export interface DerivationDeployment {
  state: DeploymentState;
  relayStatus: RelayStatus;
  /** STORED health, never the relay-disconnect-masked display value — see deriveDeploymentStatus. */
  healthStatus: HealthStatus;
  enrollmentUsedAt: Date | null;
  relayBoundAt: Date | null;
  lastHealthAt: Date | null;
  currentReleaseId: string | null;
  observedState: Record<string, unknown> | null;
  updatedAt: Date;
  /** When the customer launched the CloudFormation Quick Create — the AWS_SETUP step's authoritative start. */
  installStartedAt: Date | null;
  /** Persisted write-once step timestamps (deployments.step_timings) — see apps/api/src/step-timings.ts. */
  stepTimings: Record<string, { startedAt: string; completedAt?: string }> | null;
}

export interface DerivationApplication {
  databaseRequired?: boolean | null;
  storageRequired?: boolean | null;
  redisRequired?: boolean | null;
}

export interface DerivationJob {
  id: string;
  type: JobType;
  state: JobState;
  failureCode: FailureCode | null;
  result: Record<string, unknown> | null;
  lastProgressAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

export interface DerivationDomain {
  hostname: string;
  status: CustomDomainStatus;
}

export interface DeriveDeploymentStatusInput {
  deployment: DerivationDeployment;
  application: DerivationApplication;
  /** This deployment's jobs — at minimum every INSTALL job, the latest job overall, and the latest FAILED job. */
  jobs: DerivationJob[];
  domain: DerivationDomain | null;
  /** resolveAppUrl(jobs, domain) — https when a custom domain is ACTIVE, else http for a bare ALB, else null. */
  appUrl: string | null;
  /**
   * The second (and only other) documented clock exception, alongside the
   * existing `updatedAt` fallback below — used SOLELY to compare against a
   * step's `stepStartedAt` for `takingLongerThanUsual`. Defaults to
   * `new Date()`; tests inject a fixed value so the slow-step boundary is
   * deterministic.
   */
  now?: Date;
}

// ---------------------------------------------------------------------------
// Internal derived object — NOT exposed verbatim on any public wire. Both
// projections are pure views over this.
// ---------------------------------------------------------------------------

export interface DerivedFailure {
  code: FailureCode | null;
  component: string | null;
  reference: string;
  customerMessage: string;
  vendorMessage: string;
  awsStatus: string | null;
  /** Type of the job that failed — not necessarily the latest job, which may
   * be a later health/preflight job that has nothing to do with the failure. */
  jobType: string | null;
}

/** One entry of the vendor-only `stepTimings` list — see deploymentSchema in @deployz/contracts. */
export interface StepTimingEntry {
  step: DeploymentStep;
  startedAt: string;
  completedAt: string | null;
  durationSeconds: number | null;
}

export interface DerivedDeploymentStatus {
  stage: DeploymentStage;
  updatedAt: string;
  currentActivity: string;
  step: DeploymentStep;
  /** Applicable steps for this deployment, in canonical order (REDIS/DATABASE_STORAGE only when required). */
  steps: DeploymentStep[];
  /** When the active step started, per the resolution ladder — null when nothing authoritative is known yet. */
  stepStartedAt: string | null;
  typicalDurationSeconds: { min: number; max: number } | null;
  takingLongerThanUsual: boolean;
  /** Completed + active steps only, in canonical order — the vendor-only timing list. */
  stepTimings: StepTimingEntry[];
  /**
   * INTERNAL ONLY — never exposed on either wire projection. A per-step
   * completedAt sourced from the relay provisioning snapshot, when that
   * snapshot marks the category COMPLETE. Read by apps/api/src/
   * step-timings.ts (advanceStepTimings) to prefer a precise completion
   * time over "whenever the next step started" for the four
   * snapshot-backed steps (NETWORK/DATABASE_STORAGE/REDIS/APPLICATION).
   */
  stepSnapshotCompletedAt: Partial<Record<DeploymentStep, string>>;
  removed?: { state: 'DELETING' | 'DELETED' };
  statusUpdatesUnavailable: boolean;
  needsDomainSetup: boolean;
  components: ComponentProgress[];
  relay: { connected: boolean; lastSeenAt: string | null };
  job: { type: JobType; status: JobState } | null;
  aws: { stackStatus: string | null };
  health: { status: HealthStatus };
  result: { url: string } | null;
  failure: DerivedFailure | null;
}

// ---------------------------------------------------------------------------
// Failure mapping — every §61 failure code gets a (component, customer copy)
// entry. customerMessage reuses copy-map's already-vetted §65 jargon-free
// description instead of a second hand-written sentence per code, so the
// two copies can never drift; vendorMessage reuses the "what happened"
// clause of the existing §29 remediation copy for the same reason.
// ---------------------------------------------------------------------------

// component is null when no single component reliably explains the failure
// (an account-level or stack-level failure, not one piece of the app).
const FAILURE_COMPONENT: Record<FailureCode, string | null> = {
  AWS_SCP_BLOCKED: null,
  PORT_MISMATCH: 'runtime',
  REGION_NOT_SUPPORTED: null,
  QUOTA_EXCEEDED: null,
  IMAGE_HEALTH_CHECK_FAILED: 'runtime',
  MIGRATION_FAILED: 'database',
  RELAY_DISCONNECTED: null,
  ECS_DEPLOYMENT_FAILED: 'runtime',
  RDS_UNAVAILABLE: 'database',
  AWS_PERMISSION_DENIED: null,
  STACK_CREATE_FAILED: null,
  STACK_DELETE_FAILED: null,
  DATABASE_CREATE_FAILED: 'database',
  DATABASE_CONNECTION_FAILED: 'database',
  IMAGE_PULL_FAILED: 'runtime',
  CONTAINER_START_FAILED: 'runtime',
  MISSING_SECRET: 'runtime',
  UNSUPPORTED_ARCHITECTURE: 'runtime',
  UNKNOWN: null,
  REDIS_PROVISIONING_FAILED: 'redis',
  REDIS_CONNECTION_FAILED: 'redis',
};

interface FailureEntry {
  component: string | null;
  customerMessage: string;
  vendorMessage: string;
}

function failureEntryFor(code: FailureCode | null): FailureEntry {
  // A job can fail with no classified code at all (the relay sent something
  // failureCodeSchema does not recognise, or nothing). That is not the same
  // as the taxonomy's own UNKNOWN value, which still has real copy — this is
  // the last-resort generic message for when there is no code to look up.
  if (code === null) {
    return {
      component: null,
      customerMessage: 'Deployment needs attention.',
      vendorMessage: 'The deployment failed without a classified cause.',
    };
  }
  return {
    component: FAILURE_COMPONENT[code],
    customerMessage: failureCodeCopy(code).description,
    vendorMessage: FAILURE_REMEDIATION[code].what,
  };
}

// ---------------------------------------------------------------------------
// Component progress list
// ---------------------------------------------------------------------------

const COMPONENT_LABELS: Record<string, string> = {
  runtime: 'Application runtime',
  database: 'PostgreSQL database',
  storage: 'Storage',
  redis: 'Redis',
  https: 'Secure access (HTTPS)',
};

// result.checks[] entries name the AWS-side check, not the product-facing
// component — this is the same key space verifyCheckByComponent above maps
// FROM, inverted, minus loadBalancer/ingress (which has no ComponentProgress
// entry of its own).
const CHECK_NAME_TO_COMPONENT: Record<string, string> = {
  compute: 'runtime',
  database: 'database',
  storage: 'storage',
  cache: 'redis',
};

function failedCheckComponents(result: Record<string, unknown> | null | undefined): Set<string> {
  const source = unwrapJobResult(result) ?? result;
  const checks = (source as { checks?: { name?: string; passed?: boolean }[] } | null | undefined)?.checks ?? [];
  const out = new Set<string>();
  for (const check of checks) {
    if (check.passed === false && check.name) {
      const component = CHECK_NAME_TO_COMPONENT[check.name];
      if (component) out.add(component);
    }
  }
  return out;
}

/**
 * Maps one merged component's raw state to a ComponentProgress status, given
 * whether it is required and the overall stage. Deliberately never returns
 * READY without a positive HEALTHY signal — an UNKNOWN/absent component only
 * ever reaches PENDING, never READY, however far the deployment has otherwise
 * progressed (see the "no positive signal" branch below).
 */
function statusFromMerged(
  mergedValue: string | undefined,
  required: boolean,
  stage: DeploymentStage,
): ComponentProgressStatus {
  if (!required) return 'NOT_REQUIRED';
  if (mergedValue === 'HEALTHY') return 'READY';
  if (mergedValue === 'DEGRADED') return 'IN_PROGRESS';
  if (mergedValue === 'UNHEALTHY') return stage === 'FAILED' ? 'FAILED' : 'IN_PROGRESS';
  if (mergedValue === 'NOT_PROVISIONED') {
    if (stage === 'FAILED') return 'FAILED';
    return stage === 'PROVISIONING' ? 'IN_PROGRESS' : 'PENDING';
  }
  // mergedValue is undefined or 'UNKNOWN': no positive signal yet.
  if (stage === 'PROVISIONING') return 'IN_PROGRESS';
  if (stage === 'WAITING_FOR_AWS' || stage === 'CONNECTING') return 'PENDING';
  // VERIFYING/READY/FAILED with no signal on this specific component: the
  // vendor projection keeps PENDING (still useful operationally); the
  // customer projection drops it below — showing a "pending" step this late
  // would read as stalled progress with nothing behind it.
  return 'PENDING';
}

function httpsComponentStatus(
  domain: DerivationDomain | null,
  needsDomainSetup: boolean,
): ComponentProgressStatus | null {
  if (domain) {
    switch (domain.status) {
      case 'ACTIVE':
        return 'READY';
      case 'ERROR':
        // Component-level only — an HTTPS setup failure never fails the
        // whole deployment; the app itself may be perfectly healthy.
        return 'FAILED';
      case 'PENDING':
      case 'WAITING_FOR_DNS':
      case 'CONFIGURING':
      case 'REMOVING':
        return 'IN_PROGRESS';
      default:
        return 'IN_PROGRESS';
    }
  }
  return needsDomainSetup ? 'PENDING' : null;
}

function buildComponents(params: {
  stage: DeploymentStage;
  observedState: Record<string, unknown> | null;
  application: DerivationApplication;
  domain: DerivationDomain | null;
  needsDomainSetup: boolean;
  failureResult: Record<string, unknown> | null | undefined;
}): ComponentProgress[] {
  const merged = mergeComponentState(params.observedState, params.application) ?? {};
  const failedChecks = params.stage === 'FAILED' ? failedCheckComponents(params.failureResult) : new Set<string>();

  const components: ComponentProgress[] = [];
  const push = (key: string, mergedKey: string, required: boolean): void => {
    let status = statusFromMerged(merged[mergedKey], required, params.stage);
    if (required && params.stage === 'FAILED' && failedChecks.has(key)) {
      status = 'FAILED';
    }
    components.push({ key, label: COMPONENT_LABELS[key]!, status });
  };

  push('runtime', 'application', true);
  push('database', 'database', params.application.databaseRequired ?? false);
  push('storage', 'storage', params.application.storageRequired ?? false);
  push('redis', 'redis', params.application.redisRequired ?? false);

  const httpsStatus = httpsComponentStatus(params.domain, params.needsDomainSetup);
  if (httpsStatus !== null) {
    components.push({ key: 'https', label: COMPONENT_LABELS.https!, status: httpsStatus });
  }

  return components;
}

// ---------------------------------------------------------------------------
// Job helpers
// ---------------------------------------------------------------------------

function latestBy<T>(items: T[], keyFn: (item: T) => Date | null): T | undefined {
  let best: T | undefined;
  let bestTime = -Infinity;
  for (const item of items) {
    const time = keyFn(item)?.getTime();
    if (time !== undefined && time >= bestTime) {
      best = item;
      bestTime = time;
    }
  }
  return best;
}

function latestJob(jobs: DerivationJob[]): DerivationJob | undefined {
  return latestBy(jobs, (job) => job.createdAt);
}

function latestOfType(jobs: DerivationJob[], type: JobType): DerivationJob | undefined {
  return latestBy(
    jobs.filter((job) => job.type === type),
    (job) => job.createdAt,
  );
}

function latestFailedJob(jobs: DerivationJob[]): DerivationJob | undefined {
  return latestBy(
    jobs.filter((job) => job.state === 'FAILED'),
    (job) => job.createdAt,
  );
}

/**
 * The relay reports a settled job as `{ success, error, output }`, so its
 * fields live under `output` on the wire (the same nesting
 * albEndpointFromResult in server.ts unwraps); tests and older rows carry
 * them at the top level. Accept both.
 */
function unwrapJobResult(result: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null;
  const output = (result as { output?: unknown }).output;
  return output && typeof output === 'object' ? (output as Record<string, unknown>) : result;
}

function extractStackStatus(result: Record<string, unknown> | null | undefined): string | null {
  const nested = unwrapJobResult(result)?.stackStatus;
  if (typeof nested === 'string') return nested;
  const top = result?.stackStatus;
  return typeof top === 'string' ? top : null;
}

function buildFailure(job: DerivationJob | undefined, entry: FailureEntry): DerivedFailure {
  return {
    code: job?.failureCode ?? null,
    component: entry.component,
    // First 8 hex chars of the failed job's id — a uuid's leading segment is
    // exactly 8 hex characters, so no dash-stripping is needed. Falls back
    // to a fixed placeholder in the (should-not-happen) case where the
    // caller's job set omitted the FAILED job the deployment's own state
    // says exists.
    reference: job ? `DEP-${job.id.slice(0, 8).toUpperCase()}` : 'DEP-UNKNOWN',
    customerMessage: entry.customerMessage,
    vendorMessage: entry.vendorMessage,
    awsStatus: extractStackStatus(job?.result),
    jobType: job?.type ?? null,
  };
}

// ---------------------------------------------------------------------------
// Timestamp helper
// ---------------------------------------------------------------------------

function maxDate(...dates: (Date | null | undefined)[]): Date | null {
  let best: Date | null = null;
  for (const date of dates) {
    if (date instanceof Date && (best === null || date.getTime() > best.getTime())) {
      best = date;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Relay provisioning snapshot — the mid-PROVISIONING truth `observedState.
// infraHealth.provisioning` carries once a relay reports one (see
// packages/relay/src/provision-progress.ts). Absent entirely on older
// relays and on every heartbeat before the CFN stack exists, so every read
// here is defensive: an unrecognised shape is treated exactly like "no
// snapshot yet", never as an error.
// ---------------------------------------------------------------------------

type ProvisioningCategoryKey = 'network' | 'database' | 'storage' | 'redis' | 'application';
const PROVISIONING_CATEGORY_KEYS: readonly ProvisioningCategoryKey[] = [
  'network',
  'database',
  'storage',
  'redis',
  'application',
];
const PROVISIONING_CATEGORY_STATUSES = new Set(['IN_PROGRESS', 'COMPLETE', 'FAILED']);

interface ProvisioningCategory {
  status: 'IN_PROGRESS' | 'COMPLETE' | 'FAILED';
  startedAt?: string;
  completedAt?: string;
}
type ProvisioningSnapshot = Partial<Record<ProvisioningCategoryKey, ProvisioningCategory>>;

/** The live CloudFormation stack status the snapshot carries, if any — the
 *  only stack-status signal that exists while the INSTALL job has no result
 *  yet (see `aws.stackStatus` below). */
function readSnapshotStackStatus(observedState: Record<string, unknown> | null | undefined): string | null {
  const infraHealth = (observedState as { infraHealth?: unknown } | null | undefined)?.infraHealth;
  const provisioning = (infraHealth as { provisioning?: unknown } | null | undefined)?.provisioning;
  const stackStatus = (provisioning as { stackStatus?: unknown } | null | undefined)?.stackStatus;
  return typeof stackStatus === 'string' ? stackStatus : null;
}

function readProvisioningSnapshot(observedState: Record<string, unknown> | null | undefined): ProvisioningSnapshot | null {
  const infraHealth = (observedState as { infraHealth?: unknown } | null | undefined)?.infraHealth;
  const provisioning = (infraHealth as { provisioning?: unknown } | null | undefined)?.provisioning;
  const categories = (provisioning as { categories?: unknown } | null | undefined)?.categories;
  if (categories === null || typeof categories !== 'object') return null;

  const snapshot: ProvisioningSnapshot = {};
  for (const key of PROVISIONING_CATEGORY_KEYS) {
    const raw = (categories as Record<string, unknown>)[key];
    if (raw === null || typeof raw !== 'object') continue;
    const status = (raw as { status?: unknown }).status;
    if (typeof status !== 'string' || !PROVISIONING_CATEGORY_STATUSES.has(status)) continue;
    const startedAt = (raw as { startedAt?: unknown }).startedAt;
    const completedAt = (raw as { completedAt?: unknown }).completedAt;
    snapshot[key] = {
      status: status as ProvisioningCategory['status'],
      ...(typeof startedAt === 'string' ? { startedAt } : {}),
      ...(typeof completedAt === 'string' ? { completedAt } : {}),
    };
  }
  return Object.keys(snapshot).length > 0 ? snapshot : null;
}

/**
 * Which snapshot categories back a given step's timing — DATABASE_STORAGE
 * merges `database`+`storage`, restricted to whichever the application
 * actually requires (an unrequired component never gates the merged step).
 */
function categoryKeysForStep(step: DeploymentStep, application: DerivationApplication): ProvisioningCategoryKey[] {
  switch (step) {
    case 'NETWORK':
      return ['network'];
    case 'DATABASE_STORAGE': {
      const keys: ProvisioningCategoryKey[] = [];
      if (application.databaseRequired) keys.push('database');
      if (application.storageRequired) keys.push('storage');
      return keys;
    }
    case 'REDIS':
      return ['redis'];
    case 'APPLICATION':
      return ['application'];
    default:
      return [];
  }
}

/** Earliest known start across a step's backing categories, or null if none reported one yet. */
function snapshotStartedAt(
  snapshot: ProvisioningSnapshot | null,
  step: DeploymentStep,
  application: DerivationApplication,
): string | null {
  const dates = categoryKeysForStep(step, application)
    .map((key) => snapshot?.[key]?.startedAt)
    .filter((date): date is string => typeof date === 'string');
  return dates.length > 0 ? dates.reduce((min, date) => (date < min ? date : min)) : null;
}

/** Latest known completion across a step's backing categories, only once ALL of them are COMPLETE. */
function snapshotCompletedAt(
  snapshot: ProvisioningSnapshot | null,
  step: DeploymentStep,
  application: DerivationApplication,
): string | null {
  const keys = categoryKeysForStep(step, application);
  if (keys.length === 0) return null;
  const categories = keys.map((key) => snapshot?.[key]);
  if (categories.some((category) => category === undefined || category.status !== 'COMPLETE')) return null;
  const completions = categories
    .map((category) => category!.completedAt)
    .filter((date): date is string => typeof date === 'string');
  return completions.length === categories.length
    ? completions.reduce((max, date) => (date > max ? date : max))
    : null;
}

/**
 * The active PROVISIONING sub-step per the snapshot: first of NETWORK,
 * DATABASE_STORAGE (iff required), REDIS (iff required), APPLICATION whose
 * merged category is not COMPLETE. Returns null when there is no snapshot
 * at all — the caller decides the fallback (PREPARING for an in-flight
 * install, the FAILURE_COMPONENT map for a failed one).
 */
function provisioningLadderStep(
  snapshot: ProvisioningSnapshot | null,
  application: DerivationApplication,
): DeploymentStep | null {
  if (!snapshot) return null;
  const complete = (step: DeploymentStep): boolean => snapshotCompletedAt(snapshot, step, application) !== null;

  if (!complete('NETWORK')) return 'NETWORK';
  const databaseStorageRequired = (application.databaseRequired ?? false) || (application.storageRequired ?? false);
  if (databaseStorageRequired && !complete('DATABASE_STORAGE')) return 'DATABASE_STORAGE';
  if ((application.redisRequired ?? false) && !complete('REDIS')) return 'REDIS';
  return 'APPLICATION';
}

/**
 * The step whose backing category the snapshot marks FAILED, if any — in
 * canonical order, so a multi-category failure names the earliest step.
 * The only ladder question that stays answerable while a stack rolls back.
 */
function snapshotFailedStep(
  snapshot: ProvisioningSnapshot | null,
  application: DerivationApplication,
): DeploymentStep | null {
  if (!snapshot) return null;
  for (const step of ['NETWORK', 'DATABASE_STORAGE', 'REDIS', 'APPLICATION'] as const) {
    const failed = categoryKeysForStep(step, application).some(
      (key) => snapshot[key]?.status === 'FAILED',
    );
    if (failed) return step;
  }
  return null;
}

/** Applicable steps for this deployment, in canonical order — REDIS/DATABASE_STORAGE only when required. */
function applicableSteps(application: DerivationApplication): DeploymentStep[] {
  const databaseStorageRequired = (application.databaseRequired ?? false) || (application.storageRequired ?? false);
  return DEPLOYMENT_STEP_ORDER.filter((step) => {
    if (step === 'DATABASE_STORAGE') return databaseStorageRequired;
    if (step === 'REDIS') return application.redisRequired ?? false;
    return true;
  });
}

/**
 * stepStartedAt resolution ladder (first non-null wins):
 *   1. persisted deployments.step_timings[step].startedAt
 *   2. an authoritative fallback specific to the step
 *   3. null (and, per deriveDeploymentStatus, no slow-step flag either)
 */
function resolveStepStartedAt(
  step: DeploymentStep,
  params: {
    persisted: Record<string, { startedAt: string; completedAt?: string }> | null;
    deployment: DerivationDeployment;
    jobs: DerivationJob[];
    application: DerivationApplication;
    snapshot: ProvisioningSnapshot | null;
  },
): string | null {
  const persistedStartedAt = params.persisted?.[step]?.startedAt;
  if (persistedStartedAt) return persistedStartedAt;

  switch (step) {
    case 'AWS_SETUP':
      return params.deployment.installStartedAt?.toISOString() ?? null;
    case 'RELAY_CONNECT':
      return (params.deployment.enrollmentUsedAt ?? params.deployment.relayBoundAt)?.toISOString() ?? null;
    case 'PREPARING': {
      const installJob = latestOfType(params.jobs, 'INSTALL');
      const at = installJob?.startedAt ?? installJob?.createdAt ?? null;
      return at?.toISOString() ?? null;
    }
    case 'NETWORK':
    case 'DATABASE_STORAGE':
    case 'REDIS':
    case 'APPLICATION':
      return snapshotStartedAt(params.snapshot, step, params.application);
    case 'HEALTH_CHECK':
      return latestOfType(params.jobs, 'INSTALL')?.finishedAt?.toISOString() ?? null;
    case 'TLS':
    case 'READY':
      return null;
  }
}

/** The vendor-only `stepTimings` list: completed + active steps from the persisted map, in canonical order. */
function buildStepTimings(
  persisted: Record<string, { startedAt: string; completedAt?: string }> | null,
): StepTimingEntry[] {
  if (!persisted) return [];
  const entries: StepTimingEntry[] = [];
  for (const step of DEPLOYMENT_STEP_ORDER) {
    const record = persisted[step];
    if (!record) continue;
    const durationSeconds = record.completedAt
      ? Math.round((new Date(record.completedAt).getTime() - new Date(record.startedAt).getTime()) / 1000)
      : null;
    entries.push({ step, startedAt: record.startedAt, completedAt: record.completedAt ?? null, durationSeconds });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// currentActivity copy per stage. Deliberately short, vendor-grade sentences
// — the customer projection uses the SAME text (§65: no separate customer
// vocabulary needed here, none of this mentions AWS/CFN/ECS by name).
// ---------------------------------------------------------------------------

const STAGE_ACTIVITY: Record<'WAITING_FOR_AWS' | 'CONNECTING' | 'PROVISIONING' | 'READY', string> = {
  WAITING_FOR_AWS: 'Waiting for AWS setup to start.',
  CONNECTING: "Connecting to the customer's cloud account.",
  PROVISIONING: "Creating infrastructure in the customer's cloud account.",
  READY: 'Live and healthy.',
};

// Step-aware PROVISIONING copy — replaces the generic STAGE_ACTIVITY.PROVISIONING
// sentence once the active sub-step is known, so the install page can say what
// is actually happening instead of a single catch-all "creating infrastructure".
const PROVISIONING_STEP_ACTIVITY: Record<'PREPARING' | 'NETWORK' | 'DATABASE_STORAGE' | 'REDIS' | 'APPLICATION', string> = {
  PREPARING: 'Preparing the deployment.',
  NETWORK: 'Creating the network.',
  DATABASE_STORAGE: 'Creating the database and storage.',
  REDIS: 'Creating the Redis cache.',
  APPLICATION: 'Starting the application.',
};

const EVER_INSTALLED_STATES = new Set<DeploymentState>(['HEALTHY', 'UPDATING', 'UPDATE_AVAILABLE']);
const REMOVED_STATES = new Set<DeploymentState>(['DELETING', 'DELETED']);
const PROVISIONING_JOB_STATES = new Set<JobState>(['RUNNING', 'WAITING']);
const SUCCEEDED_JOB_STATES = new Set<JobState>(['SUCCEEDED', 'SUCCESS']);

/**
 * The pure read-time derivation. Precedence (exact, first match wins):
 *   1. state FAILED                              → FAILED
 *   2. everInstalled                              → READY or VERIFYING
 *   3. latest INSTALL job RUNNING/WAITING          → PROVISIONING
 *   4. relay registered (enrollment/bind/INSTALLING) → CONNECTING
 *   5. otherwise                                   → WAITING_FOR_AWS
 * `removed` is set separately (state DELETING/DELETED) and does not change
 * which of the above stages is computed — a removed deployment still carries
 * whatever stage it last earned, so both projections can render "removed"
 * chrome around a real last-known stage instead of a placeholder.
 */
export function deriveDeploymentStatus(input: DeriveDeploymentStatusInput): DerivedDeploymentStatus {
  const { deployment, application, jobs, domain, appUrl, now = new Date() } = input;

  // deployments.state 'DISCONNECTED' is a valid enum value that nothing in
  // this codebase currently writes (the persisted liveness sweep flips
  // relayStatus, not state). Handled defensively rather than assumed
  // unreachable: if it is ever written, treat it exactly like the relay
  // outage it would represent — retain the last confirmed stage instead of
  // regressing, same as a merely-stale relay does below.
  const everInstalled =
    deployment.state === 'DISCONNECTED' ||
    EVER_INSTALLED_STATES.has(deployment.state) ||
    deployment.currentReleaseId !== null ||
    jobs.some((job) => job.type === 'INSTALL' && SUCCEEDED_JOB_STATES.has(job.state));
  const httpsUrl = appUrl !== null && appUrl.startsWith('https://');
  const statusUpdatesUnavailable = deployment.relayStatus === 'DISCONNECTED' || deployment.state === 'DISCONNECTED';

  let stage: DeploymentStage;
  let needsDomainSetup = false;
  let currentActivity: string;

  const latestFailed = latestFailedJob(jobs);
  const installJobState = latestOfType(jobs, 'INSTALL')?.state;
  const failureEntry = deployment.state === 'FAILED' ? failureEntryFor(latestFailed?.failureCode ?? null) : undefined;

  if (deployment.state === 'FAILED') {
    stage = 'FAILED';
    currentActivity = failureEntry!.vendorMessage;
  } else if (everInstalled) {
    // The STORED healthStatus, never relay-liveness.ts's disconnect-masked
    // display value: masking exists so a screen doesn't claim to know
    // current health during an outage, but the STAGE must retain whatever
    // was last confirmed — regressing a deployment's stage because the
    // relay went quiet would read as the deployment breaking, when nothing
    // about the deployment itself changed.
    if (deployment.healthStatus === 'HEALTHY' && httpsUrl) {
      stage = 'READY';
      currentActivity = STAGE_ACTIVITY.READY;
    } else {
      stage = 'VERIFYING';
      if (deployment.healthStatus !== 'HEALTHY') {
        currentActivity = 'Running health checks.';
      } else {
        needsDomainSetup = true;
        currentActivity = 'Waiting for secure domain setup.';
      }
    }
  } else if (installJobState !== undefined && PROVISIONING_JOB_STATES.has(installJobState)) {
    stage = 'PROVISIONING';
    currentActivity = STAGE_ACTIVITY.PROVISIONING;
  } else if (
    deployment.enrollmentUsedAt !== null ||
    deployment.relayBoundAt !== null ||
    deployment.state === 'INSTALLING'
  ) {
    stage = 'CONNECTING';
    currentActivity = STAGE_ACTIVITY.CONNECTING;
  } else {
    // NOT_INSTALLED (link not launched) and WAITING_FOR_RELAY (customer
    // pressed Deploy to AWS, no relay yet) both land here: the spec's
    // WAITING_FOR_AWS covers everything before the relay's first contact,
    // and the install page distinguishes the two sub-states with the
    // launch-signal fields, not with a different stage.
    stage = 'WAITING_FOR_AWS';
    currentActivity = STAGE_ACTIVITY.WAITING_FOR_AWS;
  }

  // ── Step derivation (a read-time sub-step of `stage`, never persisted) ──
  const snapshot = readProvisioningSnapshot(deployment.observedState);
  const snapshotStackStatus = readSnapshotStackStatus(deployment.observedState);
  // A rolling-back (or deleting) stack still reports a snapshot, but its
  // categories describe resources being torn down, not created — feeding
  // them to the forward ladder made the step visibly REGRESS mid-rollback
  // (observed live: "Creating the network" while CloudFormation deleted it).
  // The one snapshot fact that stays truthful through a rollback is a
  // category that FAILED — that is where the attempt actually stopped.
  const snapshotRollingBack =
    snapshotStackStatus !== null && /ROLLBACK|DELETE/.test(snapshotStackStatus);
  const failedCategoryStep = snapshotFailedStep(snapshot, application);
  let step: DeploymentStep;
  switch (stage) {
    case 'WAITING_FOR_AWS':
      step = 'AWS_SETUP';
      break;
    case 'CONNECTING':
      step = 'RELAY_CONNECT';
      break;
    case 'PROVISIONING':
      step =
        failedCategoryStep ??
        (snapshotRollingBack ? 'PREPARING' : (provisioningLadderStep(snapshot, application) ?? 'PREPARING'));
      currentActivity = PROVISIONING_STEP_ACTIVITY[step as keyof typeof PROVISIONING_STEP_ACTIVITY];
      break;
    case 'VERIFYING':
      step = needsDomainSetup ? 'TLS' : 'HEALTH_CHECK';
      break;
    case 'READY':
      step = 'READY';
      break;
    case 'FAILED': {
      // INSTALL failures locate the step from the snapshot first (the most
      // truthful answer to "what was it doing"); only when no snapshot can
      // say does the failure's classified component stand in. A failed
      // job of any OTHER type (DEPLOY_RELEASE, RESTART, ...) never touched
      // provisioning at all, so it is attributed to APPLICATION uniformly.
      if (latestFailed?.type === 'INSTALL') {
        const ladderStep =
          failedCategoryStep ?? (snapshotRollingBack ? null : provisioningLadderStep(snapshot, application));
        if (ladderStep) {
          step = ladderStep;
        } else {
          const component = failureEntry?.component ?? null;
          step =
            component === 'database'
              ? 'DATABASE_STORAGE'
              : component === 'redis'
                ? 'REDIS'
                : component === 'runtime'
                  ? 'APPLICATION'
                  : 'PREPARING';
        }
      } else {
        step = 'APPLICATION';
      }
      break;
    }
  }

  const steps = applicableSteps(application);
  if (!steps.includes(step)) {
    // The failure-component fallback above can name a step the application's
    // current flags exclude (a REDIS_* failure code after redisRequired was
    // turned off, say). A step outside the applicable list would leave both
    // progress lists with nothing to highlight, so fall back to the broadest
    // truthful in-stage step instead.
    step = 'PREPARING';
  }
  const stepStartedAt = resolveStepStartedAt(step, { persisted: deployment.stepTimings, deployment, jobs, application, snapshot });
  const typicalDurationSeconds = TYPICAL_STEP_DURATION_SECONDS[step];
  // A silent relay cannot support "AWS is still working" — statusUpdatesUnavailable
  // suppresses the flag exactly like it suppresses every other live signal.
  // A rolling-back stack is not "still working" toward the step completing,
  // so the reassuring slow-step nudge is suppressed there too.
  const takingLongerThanUsual =
    typicalDurationSeconds !== null &&
    stepStartedAt !== null &&
    now.getTime() - new Date(stepStartedAt).getTime() > typicalDurationSeconds.max * 1000 &&
    stage !== 'READY' &&
    stage !== 'FAILED' &&
    !snapshotRollingBack &&
    !statusUpdatesUnavailable;
  const stepTimings = buildStepTimings(deployment.stepTimings);
  const stepSnapshotCompletedAt: Partial<Record<DeploymentStep, string>> = {};
  for (const snapshotStep of ['NETWORK', 'DATABASE_STORAGE', 'REDIS', 'APPLICATION'] as const) {
    const completedAt = snapshotCompletedAt(snapshot, snapshotStep, application);
    if (completedAt) stepSnapshotCompletedAt[snapshotStep] = completedAt;
  }

  const components = buildComponents({
    stage,
    observedState: deployment.observedState,
    application,
    domain,
    needsDomainSetup,
    failureResult: latestFailed?.result,
  });

  const latest = latestJob(jobs);
  // aws.stackStatus reflects the last CREATE/DELETE the customer's account
  // actually ran — DEPLOY_RELEASE/ROLLBACK/etc. never touch the stack, so
  // only INSTALL and DESTROY are candidates.
  const latestStackJob = latestBy(
    jobs.filter((job) => job.type === 'INSTALL' || job.type === 'DESTROY'),
    (job) => job.createdAt,
  );

  const updatedAt =
    maxDate(deployment.updatedAt, deployment.lastHealthAt, latest?.lastProgressAt, latest?.finishedAt) ?? new Date();

  return {
    stage,
    updatedAt: updatedAt.toISOString(),
    currentActivity,
    step,
    steps,
    stepStartedAt,
    typicalDurationSeconds,
    takingLongerThanUsual,
    stepTimings,
    stepSnapshotCompletedAt,
    ...(REMOVED_STATES.has(deployment.state) ? { removed: { state: deployment.state as 'DELETING' | 'DELETED' } } : {}),
    statusUpdatesUnavailable,
    needsDomainSetup,
    components,
    relay: {
      connected: deployment.relayStatus === 'CONNECTED',
      // No dedicated "last seen" column exists yet — the last health report
      // is the freshest signal this module has of the relay actually being
      // there, so it stands in for it.
      lastSeenAt: deployment.lastHealthAt?.toISOString() ?? null,
    },
    job: latest ? { type: latest.type, status: latest.state } : null,
    // A settled INSTALL/DESTROY result is the definitive answer; while one is
    // still running its result is null, and the relay snapshot's live status
    // (CREATE_IN_PROGRESS et al.) is the only stack-status signal there is.
    aws: {
      stackStatus:
        extractStackStatus(latestStackJob?.result) ?? readSnapshotStackStatus(deployment.observedState),
    },
    health: { status: deployment.healthStatus },
    result: stage === 'READY' && appUrl ? { url: appUrl } : null,
    failure: stage === 'FAILED' ? buildFailure(latestFailed, failureEntry!) : null,
  };
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

/**
 * The unauthenticated customer projection. Strips relay identity, job
 * detail, and the raw stack status (except the one word failure.technical
 * carries); components with no positive signal this late in the lifecycle
 * are dropped rather than shown as a stalled-looking PENDING step (see
 * statusFromMerged) — https is exempt because its own PENDING IS the
 * positive signal ("domain setup is next").
 */
export function toCustomerDeploymentStatus(derived: DerivedDeploymentStatus): CustomerDeploymentStatus {
  const noSignalStages: DeploymentStage[] = ['VERIFYING', 'READY', 'FAILED'];
  const components = derived.components.filter((component) => {
    if (component.status === 'NOT_REQUIRED') return false;
    if (component.key === 'https') return true;
    return !(component.status === 'PENDING' && noSignalStages.includes(derived.stage));
  });

  return {
    stage: derived.stage,
    updatedAt: derived.updatedAt,
    currentActivity: derived.currentActivity,
    step: derived.step,
    steps: derived.steps,
    typicalDurationSeconds: derived.typicalDurationSeconds,
    takingLongerThanUsual: derived.takingLongerThanUsual,
    removed: derived.removed !== undefined,
    statusUpdatesUnavailable: derived.statusUpdatesUnavailable,
    needsDomainSetup: derived.needsDomainSetup,
    components,
    url: derived.result?.url ?? null,
    failure: derived.failure
      ? {
          customerMessage: derived.failure.customerMessage,
          component: derived.failure.component,
          reference: derived.failure.reference,
          technical: {
            // "Which stage of the pipeline failed" (INSTALL, DEPLOY_RELEASE,
            // ...) — a job type, not an AWS service name, so it stays inside
            // §65's rules while still being useful to a customer's own ops
            // team relaying this to a vendor's support. The FAILED job's own
            // type, not the latest job's — a later health/preflight job must
            // not relabel the failure.
            stage: derived.failure.jobType ?? 'UNKNOWN',
            component: derived.failure.component,
            awsStatus: derived.failure.awsStatus,
          },
        }
      : null,
  };
}

/** The authenticated vendor projection — full operational detail. */
export function toVendorDeploymentStatus(derived: DerivedDeploymentStatus): VendorDeploymentStatus {
  return {
    stage: derived.stage,
    updatedAt: derived.updatedAt,
    currentActivity: derived.currentActivity,
    step: derived.step,
    steps: derived.steps,
    typicalDurationSeconds: derived.typicalDurationSeconds,
    takingLongerThanUsual: derived.takingLongerThanUsual,
    stepStartedAt: derived.stepStartedAt,
    stepTimings: derived.stepTimings,
    statusUpdatesUnavailable: derived.statusUpdatesUnavailable,
    needsDomainSetup: derived.needsDomainSetup,
    components: derived.components,
    relay: derived.relay,
    job: derived.job,
    aws: derived.aws,
    health: derived.health,
    url: derived.result?.url ?? null,
    failure: derived.failure
      ? {
          code: derived.failure.code,
          component: derived.failure.component,
          reference: derived.failure.reference,
          message: derived.failure.vendorMessage,
          awsStatus: derived.failure.awsStatus,
        }
      : null,
  };
}
