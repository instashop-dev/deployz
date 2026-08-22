/**
 * Health monitoring (§28) — deployment health ONLY. No app observability (M14).
 *
 * This module is the control-plane's health logic for a single customer
 * deployment. It is deliberately scoped to DEPLOYMENT health: the 8 §28
 * signals are about infrastructure/connectivity deployment health, NOT
 * application-level observability (no app logs, no app metrics, no custom
 * dashboards — M14). CPU/memory here means the deployment's own task
 * capacity, not application performance metrics.
 *
 * The 8 §28 signals (one pure `check*` function each, injectable-seam style):
 *   1. CFN stack status            — checkStackStatus
 *   2. ECS service state           — checkServiceState
 *   3. Target health (ALB)         — checkTargetHealth
 *   4. RDS availability + §64      — checkBackupConfig
 *   5. Relay connectivity          — checkRelayConnectivity
 *   6. HTTP health (app /health)   — checkHttpHealth
 *   7. CPU/memory utilization      — checkUtilization
 *   8. Deployment state consistency— checkStateConsistency
 *
 * §64 backup-config health check: `checkBackupConfig` verifies RDS automated
 * backups are still configured/enabled. It is NOT a ninth signal — it IS the
 * RDS signal (#4): a database whose automated backups have been turned off is
 * DEGRADED, a database that is unreachable is UNHEALTHY.
 *
 * §59 desired-vs-observed drift reconciliation: `detectDrift` diffs the
 * control plane's desired state against the relay-reported observed state;
 * `handleDrift` re-spawns the matching job when drift exceeds the threshold,
 * with a kill-mid-flight rule so an orphaned/in-flight job of the same type is
 * superseded (never double-executed).
 *
 * The relay reports observed state on every poll (todo 12 REPORT_HEALTH); the
 * control plane is the source of desired state. This module is pure logic —
 * every check takes plain observed data (no AWS SDK), and every seam in
 * `handleDrift` is injectable, so it is fully testable without credentials.
 */

// ── Signal status + shape ─────────────────────────────────────────────────

/** Per-signal health. DEGRADED = impaired but not down; UNHEALTHY = down. */
export type SignalStatus = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';

/** The 8 §28 signal keys, in canonical order. */
export const HEALTH_SIGNAL_KEYS = [
  'stack',
  'service',
  'target-health',
  'rds',
  'relay',
  'http',
  'utilization',
  'consistency',
  'container-exit',
] as const;

export type HealthSignalKey = (typeof HEALTH_SIGNAL_KEYS)[number];

/** A single deployment-health signal. */
export interface HealthSignal {
  readonly key: HealthSignalKey;
  readonly status: SignalStatus;
  /** Plain-English one-liner (no raw service terminology — §65-friendly). */
  readonly summary: string;
  /** Technical detail (raw values) — surfaced only behind an expandable layer. */
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** Aggregate deployment health (§28). */
export type HealthStatus = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';

/**
 * Aggregate the 8 signals into a single deployment health status.
 *
 * UNHEALTHY wins over DEGRADED, DEGRADED over HEALTHY. No signals (empty
 * input) is vacuously HEALTHY — no signal, no known problem.
 */
export function evaluateHealth(signals: readonly HealthSignal[]): HealthStatus {
  if (signals.some((s) => s.status === 'UNHEALTHY')) return 'UNHEALTHY';
  if (signals.some((s) => s.status === 'DEGRADED')) return 'DEGRADED';
  return 'HEALTHY';
}

// ── 1. CFN stack status ────────────────────────────────────────────────────

/** Observed data for the stack signal. */
export interface StackStatusDeps {
  readonly stackStatus: string;
}

/** Terminal-success stack statuses. */
const STACK_HEALTHY = new Set([
  'CREATE_COMPLETE',
  'UPDATE_COMPLETE',
  'IMPORT_COMPLETE',
]);

/** In-progress or rolled-back statuses — deployed but not steady. */
const STACK_DEGRADED = new Set([
  'CREATE_IN_PROGRESS',
  'UPDATE_IN_PROGRESS',
  'REVIEW_IN_PROGRESS',
  'IMPORT_IN_PROGRESS',
  'ROLLBACK_COMPLETE',
  'UPDATE_ROLLBACK_COMPLETE',
  'IMPORT_ROLLBACK_COMPLETE',
]);

/** Signal 1 — the deployment's infrastructure stack. */
export function checkStackStatus(deps: StackStatusDeps): HealthSignal {
  const { stackStatus } = deps;
  let status: SignalStatus;
  let summary: string;
  if (STACK_HEALTHY.has(stackStatus)) {
    status = 'HEALTHY';
    summary = 'Infrastructure is up to date.';
  } else if (STACK_DEGRADED.has(stackStatus)) {
    status = 'DEGRADED';
    summary = 'Infrastructure is still provisioning.';
  } else {
    status = 'UNHEALTHY';
    summary = 'Infrastructure is in a failed state.';
  }
  return { key: 'stack', status, summary, detail: { stackStatus } };
}

// ── 2. ECS service state ───────────────────────────────────────────────────

/** Observed data for the service-state signal. */
export interface ServiceStateDeps {
  readonly runningCount: number;
  readonly desiredCount: number;
}

/** Signal 2 — are the right number of tasks running? */
export function checkServiceState(deps: ServiceStateDeps): HealthSignal {
  const { runningCount, desiredCount } = deps;
  let status: SignalStatus;
  let summary: string;
  if (desiredCount <= 0) {
    status = 'UNHEALTHY';
    summary = 'No running tasks are expected.';
  } else if (runningCount >= desiredCount) {
    status = 'HEALTHY';
    summary = 'All tasks are running.';
  } else if (runningCount > 0) {
    status = 'DEGRADED';
    summary = 'Some tasks are still starting.';
  } else {
    status = 'UNHEALTHY';
    summary = 'No tasks are running.';
  }
  return { key: 'service', status, summary, detail: { runningCount, desiredCount } };
}

// ── 3. Target health (ALB) ─────────────────────────────────────────────────

/** Observed data for the target-health signal. */
export interface TargetHealthDeps {
  readonly healthyTargets: number;
  readonly unhealthyTargets: number;
}

/** Signal 3 — is the deployment receiving traffic on healthy routes? */
export function checkTargetHealth(deps: TargetHealthDeps): HealthSignal {
  const { healthyTargets, unhealthyTargets } = deps;
  let status: SignalStatus;
  let summary: string;
  if (healthyTargets > 0 && unhealthyTargets === 0) {
    status = 'HEALTHY';
    summary = 'All routes are healthy.';
  } else if (healthyTargets > 0 && unhealthyTargets > 0) {
    status = 'DEGRADED';
    summary = 'Some routes are unhealthy.';
  } else {
    status = 'UNHEALTHY';
    summary = 'No healthy routes.';
  }
  return { key: 'target-health', status, summary, detail: { healthyTargets, unhealthyTargets } };
}

// ── 4. RDS availability + §64 backup-config ───────────────────────────────

/** Observed data for the RDS/§64 signal. */
export interface BackupConfigDeps {
  /** Whether the database is currently reachable. */
  readonly rdsAvailable: boolean;
  /** Whether automated backups are STILL configured + enabled (§64). */
  readonly automatedBackupsEnabled: boolean;
}

/**
 * Signal 4 — RDS availability (§28) + the §64 backup-config health check.
 *
 * §64: RDS automated backups are configured by the application stack at
 * install time. If they have been turned off (e.g. an out-of-band change in
 * the customer account), the deployment is DEGRADED — its data is no longer
 * protected. A database that is unreachable is UNHEALTHY.
 */
export function checkBackupConfig(
  deploymentId: string,
  deps: BackupConfigDeps,
): HealthSignal {
  const { rdsAvailable, automatedBackupsEnabled } = deps;
  let status: SignalStatus;
  let summary: string;
  if (!rdsAvailable) {
    status = 'UNHEALTHY';
    summary = 'The database is unreachable.';
  } else if (!automatedBackupsEnabled) {
    status = 'DEGRADED';
    summary = 'The database is reachable, but backups are turned off.';
  } else {
    status = 'HEALTHY';
    summary = 'The database is reachable and backups are enabled.';
  }
  return {
    key: 'rds',
    status,
    summary,
    detail: { deploymentId, rdsAvailable, automatedBackupsEnabled },
  };
}

// ── 5. Relay connectivity ──────────────────────────────────────────────────

/**
 * Relay silence thresholds. DEGRADED once the relay has not checked in for
 * this long; UNHEALTHY once it has been silent for the longer window.
 */
export const RELAY_DEGRADED_AFTER_MS = 5 * 60 * 1000; // 5 minutes
export const RELAY_DISCONNECTED_AFTER_MS = 15 * 60 * 1000; // 15 minutes

/** Observed data for the relay-connectivity signal. */
export interface RelayConnectivityDeps {
  /** Milliseconds since the relay last checked in (null = never). */
  readonly lastContactMsAgo: number | null;
}

/** Signal 5 — is the egress relay still checking in? */
export function checkRelayConnectivity(deps: RelayConnectivityDeps): HealthSignal {
  const { lastContactMsAgo } = deps;
  let status: SignalStatus;
  let summary: string;
  if (lastContactMsAgo === null) {
    status = 'UNHEALTHY';
    summary = 'The helper has never checked in.';
  } else if (lastContactMsAgo >= RELAY_DISCONNECTED_AFTER_MS) {
    status = 'UNHEALTHY';
    summary = 'The helper is disconnected.';
  } else if (lastContactMsAgo >= RELAY_DEGRADED_AFTER_MS) {
    status = 'DEGRADED';
    summary = 'The helper has not checked in recently.';
  } else {
    status = 'HEALTHY';
    summary = 'The helper is connected and checking in.';
  }
  return { key: 'relay', status, summary, detail: { lastContactMsAgo } };
}

// ── 6. HTTP health (app /health endpoint) ──────────────────────────────────

/** Observed data for the HTTP-health signal. */
export interface HttpHealthDeps {
  /** The app's /health endpoint status code (null = unreachable). */
  readonly statusCode: number | null;
}

/** Signal 6 — does the app's own /health endpoint respond? */
export function checkHttpHealth(deps: HttpHealthDeps): HealthSignal {
  const { statusCode } = deps;
  let status: SignalStatus;
  let summary: string;
  if (statusCode === null) {
    status = 'UNHEALTHY';
    summary = "The app's health check is unreachable.";
  } else if (statusCode >= 200 && statusCode < 300) {
    status = 'HEALTHY';
    summary = "The app's health check is passing.";
  } else if (statusCode >= 500) {
    status = 'DEGRADED';
    summary = "The app is up, but its health check is failing.";
  } else {
    status = 'UNHEALTHY';
    summary = "The app's health check is not responding normally.";
  }
  return { key: 'http', status, summary, detail: { statusCode } };
}

// ── 7. CPU/memory utilization ──────────────────────────────────────────────

/** Utilization thresholds (deployment capacity, not app metrics — M14). */
export const UTILIZATION_DEGRADED_PCT = 80;
export const UTILIZATION_UNHEALTHY_PCT = 95;

/** Observed data for the utilization signal. */
export interface UtilizationDeps {
  readonly cpuPercent: number;
  readonly memoryPercent: number;
}

/** Signal 7 — is the deployment's capacity within limits? */
export function checkUtilization(deps: UtilizationDeps): HealthSignal {
  const { cpuPercent, memoryPercent } = deps;
  const peak = Math.max(cpuPercent, memoryPercent);
  let status: SignalStatus;
  let summary: string;
  if (peak >= UTILIZATION_UNHEALTHY_PCT) {
    status = 'UNHEALTHY';
    summary = 'Capacity is exhausted.';
  } else if (peak >= UTILIZATION_DEGRADED_PCT) {
    status = 'DEGRADED';
    summary = 'Capacity is running high.';
  } else {
    status = 'HEALTHY';
    summary = 'Capacity is within limits.';
  }
  return { key: 'utilization', status, summary, detail: { cpuPercent, memoryPercent } };
}

// ── 8. Deployment state consistency ────────────────────────────────────────

/** Observed data for the state-consistency signal. */
export interface StateConsistencyDeps {
  /** The deployment state the control plane wants (§59 desired). */
  readonly desiredState: string;
  /** The deployment state the relay reported (§59 observed). */
  readonly observedState: string;
}

/** Signal 8 — does the observed state match the desired state? */
export function checkStateConsistency(deps: StateConsistencyDeps): HealthSignal {
  const { desiredState, observedState } = deps;
  const consistent = desiredState === observedState;
  return {
    key: 'consistency',
    status: consistent ? 'HEALTHY' : 'DEGRADED',
    summary: consistent
      ? 'Reported state matches what we expect.'
      : 'Reported state has drifted from what we expect.',
    detail: { desiredState, observedState },
  };
}

// ── 9. Container exit state ────────────────────────────────────────────────

/** Observed data for the container-exit signal. */
export interface ContainerExitStateDeps {
  readonly runningCount: number;
  readonly stoppedReason?: string | undefined;
}

/** Signal 9 — have containers exited unexpectedly? */
export function checkContainerExitState(deps: ContainerExitStateDeps): HealthSignal {
  const { runningCount, stoppedReason } = deps;
  let status: SignalStatus;
  let summary: string;
  if (runningCount === 0 && stoppedReason !== undefined) {
    status = 'UNHEALTHY';
    summary = `Container stopped: ${stoppedReason}`;
  } else if (runningCount === 0) {
    status = 'UNHEALTHY';
    summary = 'No containers are running.';
  } else if (stoppedReason !== undefined) {
    status = 'DEGRADED';
    summary = `Some containers stopped: ${stoppedReason}`;
  } else {
    status = 'HEALTHY';
    summary = 'All containers are running normally.';
  }
  return { key: 'container-exit', status, summary, detail: { runningCount, stoppedReason } };
}

// ── Collect all 8 signals ──────────────────────────────────────────────────

/** Aggregated observed data for all 8 §28 signals. */
export interface HealthCheckDeps {
  readonly deploymentId: string;
  readonly stackStatus: string;
  readonly runningCount: number;
  readonly desiredCount: number;
  readonly healthyTargets: number;
  readonly unhealthyTargets: number;
  readonly rdsAvailable: boolean;
  readonly automatedBackupsEnabled: boolean;
  readonly relayLastContactMsAgo: number | null;
  readonly httpStatusCode: number | null;
  readonly cpuPercent: number;
  readonly memoryPercent: number;
  readonly desiredState: string;
  readonly observedState: string;
  readonly stoppedReason?: string | undefined;
}

/**
 * Run all 8 §28 checks and return the signals in canonical order. This is the
 * single entry point a poller calls after collecting observed data from the
 * relay's REPORT_HEALTH (todo 12).
 */
export function collectHealthSignals(deps: HealthCheckDeps): HealthSignal[] {
  return [
    checkStackStatus({ stackStatus: deps.stackStatus }),
    checkServiceState({ runningCount: deps.runningCount, desiredCount: deps.desiredCount }),
    checkTargetHealth({ healthyTargets: deps.healthyTargets, unhealthyTargets: deps.unhealthyTargets }),
    checkBackupConfig(deps.deploymentId, {
      rdsAvailable: deps.rdsAvailable,
      automatedBackupsEnabled: deps.automatedBackupsEnabled,
    }),
    checkRelayConnectivity({ lastContactMsAgo: deps.relayLastContactMsAgo }),
    checkHttpHealth({ statusCode: deps.httpStatusCode }),
    checkUtilization({ cpuPercent: deps.cpuPercent, memoryPercent: deps.memoryPercent }),
    checkStateConsistency({ desiredState: deps.desiredState, observedState: deps.observedState }),
    checkContainerExitState({ runningCount: deps.runningCount, stoppedReason: deps.stoppedReason }),
  ];
}

// ── §59 desired-vs-observed drift ──────────────────────────────────────────

/** One drifted field (desired ≠ observed). */
export interface DriftEntry {
  readonly key: string;
  readonly desired: unknown;
  readonly observed: unknown;
}

/** Stable equality: `Object.is` fast path, then a JSON deep compare. */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Diff the control plane's desired state against the relay's observed state.
 *
 * Returns one entry per desired field whose observed value differs (including
 * fields present in desired but missing from observed). Equal states produce
 * an empty array.
 */
export function detectDrift(
  desiredState: Record<string, unknown>,
  observedState: Record<string, unknown>,
): DriftEntry[] {
  const entries: DriftEntry[] = [];
  for (const key of Object.keys(desiredState)) {
    const desired = desiredState[key];
    const observed = observedState[key];
    if (!valuesEqual(desired, observed)) {
      entries.push({ key, desired, observed });
    }
  }
  return entries;
}

/** Number of drifted fields tolerated before reconciliation fires. */
export const DRIFT_THRESHOLD = 1;

/** A drift report for one deployment, carrying the job type to re-spawn. */
export interface Drift {
  readonly deploymentId: string;
  /** The matching job type to re-spawn (e.g. INFRA_UPGRADE, DEPLOY_RELEASE). */
  readonly jobType: string;
  readonly entries: readonly DriftEntry[];
}

/** An in-flight (or orphaned) job that may be superseded. */
export interface InflightJob {
  readonly id: string;
  readonly type: string;
}

/** Injectable seams for §59 reconciliation (no AWS — tests inject mocks). */
export interface DriftDeps {
  listInflightJobs(deploymentId: string): Promise<readonly InflightJob[]>;
  supersedeJob(jobId: string, reason: string): Promise<void>;
  spawnJob(params: {
    deploymentId: string;
    type: string;
    reason: string;
  }): Promise<string>;
}

/** What `handleDrift` did. */
export interface DriftHandlingResult {
  readonly action: 'none' | 'respawned';
  /** Why no action was taken (set when action === 'none'). */
  readonly reason?: string | undefined;
  /** The newly spawned reconciliation job id (set when action === 'respawned'). */
  readonly newJobId?: string | undefined;
  /** In-flight jobs that were superseded (killed) before respawning. */
  readonly supersededJobIds: readonly string[];
}

/**
 * §59 reconciliation: re-spawn the matching job when drift exceeds threshold.
 *
 * Kill-mid-flight rule: before spawning, any in-flight (or orphaned) job of
 * the SAME type for this deployment is superseded — so a stale job that never
 * completed can never double-execute alongside the reconciliation job. Within
 * threshold, no action is taken (drift is tolerated and self-heals on the next
 * poll).
 */
export async function handleDrift(
  drift: Drift,
  deps: DriftDeps,
): Promise<DriftHandlingResult> {
  if (drift.entries.length <= DRIFT_THRESHOLD) {
    return {
      action: 'none',
      reason: `within drift threshold (${drift.entries.length} <= ${DRIFT_THRESHOLD})`,
      supersededJobIds: [],
    };
  }

  const inflight = await deps.listInflightJobs(drift.deploymentId);
  const supersededJobIds: string[] = [];
  for (const job of inflight) {
    if (job.type === drift.jobType) {
      await deps.supersedeJob(
        job.id,
        `superseded by drift reconciliation (${drift.entries.length} drifted fields)`,
      );
      supersededJobIds.push(job.id);
    }
  }

  const newJobId = await deps.spawnJob({
    deploymentId: drift.deploymentId,
    type: drift.jobType,
    reason: `drift detected across ${drift.entries.length} fields: ${drift.entries
      .map((e) => e.key)
      .join(', ')}`,
  });

  return { action: 'respawned', newJobId, supersededJobIds };
}
