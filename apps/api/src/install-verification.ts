import type { FailureCode } from '@deployz/contracts';

/**
 * How long an installed deployment may stay INSTALLING without passing
 * release evidence. The load balancer alone allows 300 s of health-check
 * grace and an ECS rollout takes 3-5 minutes; a first start may also run
 * migrations. 30 minutes leaves room for all of that.
 */
export const INSTALL_VERIFICATION_WINDOW_MS = 30 * 60 * 1000;

/**
 * Release-evidence refusals that mean the application itself never became
 * healthy, mapped to the failure code that classifies them. Every other
 * reason (missing, stale or invalid evidence, no expected workloads, a
 * workload intentionally at zero tasks) says the connector or the start
 * order is the problem, not the application, and never fails the install.
 */
const APPLICATION_REASON_CODES: Readonly<Record<string, FailureCode>> = {
  PROBE_FAILED: 'IMAGE_HEALTH_CHECK_FAILED',
  PROBE_MISSING: 'IMAGE_HEALTH_CHECK_FAILED',
  TARGETS_UNHEALTHY: 'IMAGE_HEALTH_CHECK_FAILED',
  TASKS_INSUFFICIENT: 'CONTAINER_START_FAILED',
  WORKLOAD_MISSING: 'CONTAINER_START_FAILED',
  ROLLOUT_INCOMPLETE: 'ECS_DEPLOYMENT_FAILED',
  DIGEST_MIXED: 'UNKNOWN',
  DIGEST_UNKNOWN: 'UNKNOWN',
};

/** The job types whose settlement starts the verification window. */
const WINDOW_JOB_TYPES = new Set(['INSTALL', 'DEPLOY_RELEASE', 'CONFIG_UPDATE']);
const ACTIVE_STATES = new Set(['REQUESTED', 'QUEUED', 'WAITING', 'RUNNING']);
const SUCCEEDED_STATES = new Set(['SUCCEEDED', 'SUCCESS']);
const MUTATING_TYPES = new Set([
  'INSTALL',
  'DEPLOY_RELEASE',
  'ROLLBACK',
  'RESTART',
  'CONFIG_UPDATE',
  'DESTROY',
  'MIGRATION',
  'INFRA_UPGRADE',
]);

export interface VerificationJob {
  id: string;
  type: string;
  state: string;
  createdAt: Date;
  finishedAt: Date | null;
}

export interface UnverifiedInstall {
  /** The settled job the window was measured from; it carries the record. */
  anchorJobId: string;
  failureCode: FailureCode;
  reason: string;
}

/**
 * Whether an INSTALLING deployment has outlived its verification window with
 * the application still failing release evidence. Pure: the caller supplies
 * the deployment's jobs and the heartbeat's own verdict.
 */
export function unverifiedInstall(input: {
  jobs: readonly VerificationJob[];
  verdict: { pass: boolean; reason: string | null; notStarted: boolean };
  now: Date;
}): UnverifiedInstall | null {
  const { jobs, verdict, now } = input;
  if (verdict.pass || verdict.notStarted || verdict.reason === null) return null;
  const failureCode = APPLICATION_REASON_CODES[verdict.reason];
  if (failureCode === undefined) return null;

  const mutating = jobs.filter((job) => MUTATING_TYPES.has(job.type));
  if (mutating.some((job) => ACTIVE_STATES.has(job.state))) return null;
  if (!jobs.some((job) => job.type === 'INSTALL' && SUCCEEDED_STATES.has(job.state))) return null;

  // The latest mutating job must be a settled install, deploy or config
  // update; anything else (a failed job, a rollback) owns its own outcome.
  const latest = mutating.reduce<VerificationJob | null>(
    (best, job) => (best === null || job.createdAt > best.createdAt ? job : best),
    null,
  );
  if (
    latest === null ||
    !WINDOW_JOB_TYPES.has(latest.type) ||
    !SUCCEEDED_STATES.has(latest.state) ||
    latest.finishedAt === null ||
    now.getTime() - latest.finishedAt.getTime() < INSTALL_VERIFICATION_WINDOW_MS
  ) {
    return null;
  }
  return { anchorJobId: latest.id, failureCode, reason: verdict.reason };
}

/** The record stored on the anchor job's result when verification gives up. */
export interface InstallVerificationRecord {
  failureCode: FailureCode;
  reason: string;
}

export function readInstallVerification(
  result: Record<string, unknown> | null | undefined,
): InstallVerificationRecord | null {
  const raw = result?.['installVerification'] as Partial<InstallVerificationRecord> | null | undefined;
  if (raw === null || raw === undefined || typeof raw.failureCode !== 'string' || typeof raw.reason !== 'string') {
    return null;
  }
  return { failureCode: raw.failureCode as FailureCode, reason: raw.reason };
}
