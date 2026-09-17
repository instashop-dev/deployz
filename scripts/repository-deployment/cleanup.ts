/**
 * Cleanup for one attempt — the product's Disconnect and Purge, then the
 * customer-owned leftovers, then the leak audit — through the version
 * canary's teardown (every deletion keyed on an id the ledger recorded).
 * Runs in the attempt's `finally`, and again from `--cleanup` / `--resume`
 * for any ledger whose cleanup did not complete.
 */
import type { CanaryConfig } from '../version-canary/config.js';
import { waitFor, type ControlPlane } from '../version-canary/control-plane.js';
import type { Evidence, StepRecord } from '../version-canary/evidence.js';
import type { Canary } from '../version-canary/steps.js';
import { stageBRun } from './ledger.js';
import type { StageBResult } from './results.js';

/** PASS/FAIL/SKIPPED/NOT_ATTEMPTED for one of destroyThroughProduct's retained-state
 * verification steps, from the evidence record it left (absent when the step never ran). */
function stepOutcome(step: StepRecord | undefined): StageBResult['cleanup']['retainedState'] {
  if (!step) return 'NOT_ATTEMPTED';
  if (step.details['skipped']) return 'SKIPPED';
  return step.status === 'PASS' ? 'PASS' : 'FAIL';
}

export interface TeardownLike {
  destroyThroughProduct(canary: Canary): Promise<void>;
  removeCanaryLeftovers(canary: Canary): Promise<void>;
  leakAudit(canary: Canary): Promise<unknown>;
}

export interface CleanupInput {
  config: CanaryConfig;
  api: ControlPlane;
  evidence: Evidence;
  teardown: TeardownLike;
  now: () => number;
  /** How long to wait for an in-flight job (an INSTALL still reporting a rolled-back stack) before Disconnect. Default 60 min. */
  idleTimeoutMs?: number | undefined;
  pollIntervalMs?: number | undefined;
  /** Confirms a resource the leak audit lists still exists (the tagging API lags deletions). Default: assume it does. */
  resourceStillExists?: ((arn: string) => Promise<boolean>) | undefined;
}

const ACTIVE_JOB_STATES = new Set(['REQUESTED', 'QUEUED', 'WAITING', 'RUNNING']);

/**
 * Fill the result's `cleanup` section. A failure in any stage is recorded
 * and the later stages still run when they can (the leak audit always
 * runs), so the result says exactly what is left.
 */
export async function cleanupAttempt(input: CleanupInput, result: StageBResult): Promise<StageBResult['cleanup']> {
  const { config, api, evidence, teardown, now } = input;
  const run = stageBRun(evidence);
  const started = now();
  const canary: Canary = { config, evidence, api };
  const section = result.cleanup;
  const errors: string[] = [];

  // A created release may already be an ECR image in the control-plane
  // account (a build the ledger never saw finish is the risky case), so only
  // an attempt that created nothing at all is exempt.
  if (!run.deploymentId && !run.bootstrapStackName && Object.keys(run.releases).length === 0) {
    section.status = 'NOT_REQUIRED';
    section.detail = 'no AWS resources were created';
    run.stageB.cleanupCompletedAt = new Date(now()).toISOString();
    run.stageB.cleanupNeeded = false;
    evidence.save();
    return section;
  }

  // Disconnect is refused while another operation runs (409 DEPLOYMENT_BUSY);
  // an INSTALL that is still reporting a rolled-back stack is the usual case.
  if (run.deploymentId) {
    try {
      await waitFor(
        'deployment to be idle before Disconnect',
        () => api.getDeployment(run.deploymentId!),
        (d) => (d.jobs.some((j) => ACTIVE_JOB_STATES.has(j.state)) ? null : d),
        { timeoutMs: input.idleTimeoutMs ?? 60 * 60_000, intervalMs: input.pollIntervalMs ?? 30_000, describe: (d) => `${d.state} ${d.jobs.at(-1)?.type ?? '-'}:${d.jobs.at(-1)?.state ?? '-'}` },
      );
    } catch (error) {
      errors.push(`idle wait: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    await teardown.destroyThroughProduct(canary);
  } catch (error) {
    errors.push(`destroy/purge: ${error instanceof Error ? error.message : String(error)}`);
  }
  const destroyStep = [...evidence.run.steps].reverse().find((s) => s.name.startsWith('Disconnect'));
  const purgeStep = [...evidence.run.steps].reverse().find((s) => s.name.startsWith('Purge'));
  section.destroyJobState = ((destroyStep?.details['destroyJob'] as { state?: string } | null)?.state ?? (destroyStep?.details['skipped'] ? 'SKIPPED' : null)) ?? null;
  section.purgeJobState = ((purgeStep?.details['purgeJob'] as { state?: string } | null)?.state ?? (purgeStep?.details['skipped'] ? 'SKIPPED' : null)) ?? null;
  section.cleanupState = (purgeStep?.details['cleanupState'] as string | undefined) ?? (destroyStep?.details['cleanupState'] as string | undefined) ?? null;

  try {
    await teardown.removeCanaryLeftovers(canary);
  } catch (error) {
    errors.push(`leftovers: ${error instanceof Error ? error.message : String(error)}`);
  }
  const leftoversStep = [...evidence.run.steps].reverse().find((s) => s.name.startsWith('Remove the connector'));
  section.bootstrapStackFinal = (leftoversStep?.details['bootstrapStackFinal'] as string | undefined) ?? (leftoversStep?.details['bootstrapStack'] as string | undefined) ?? null;

  const retainedStep = [...evidence.run.steps].reverse().find((s) => s.name === 'Verify retained state between Disconnect and Purge');
  const purgedStep = [...evidence.run.steps].reverse().find((s) => s.name === 'Verify the retained set is gone after Purge');
  section.retainedState = stepOutcome(retainedStep);
  section.purgedState = stepOutcome(purgedStep);

  try {
    await teardown.leakAudit(canary);
    section.leaks = [];
  } catch (error) {
    const auditStep = [...evidence.run.steps].reverse().find((s) => s.name === 'AWS leak audit');
    const listed = (auditStep?.details['disposableLeft'] as string[] | undefined) ?? [error instanceof Error ? error.message : String(error)];
    const confirmed: string[] = [];
    for (const arn of listed) {
      if (input.resourceStillExists && arn.startsWith('arn:') && !(await input.resourceStillExists(arn))) continue;
      confirmed.push(arn);
    }
    section.leaks = confirmed;
    if (auditStep) auditStep.details['confirmedLeft'] = confirmed;
    if (confirmed.length > 0) errors.push(`leak audit: ${confirmed.length} resource(s) left`);
  }

  section.durationMs = now() - started;
  section.status = errors.length === 0 ? 'PASS' : 'FAIL';
  section.detail = errors.length === 0 ? null : errors.join(' | ').slice(0, 1000);
  if (errors.length === 0) {
    run.stageB.cleanupCompletedAt = new Date(now()).toISOString();
    run.stageB.cleanupNeeded = false;
  }
  evidence.save();
  return section;
}

/**
 * Apply a cleanup outcome to a result's classification: cleanup is part of
 * PASS. A later cleanup rerun that completes restores the funnel's own
 * verdict when the only failure had been the cleanup.
 */
export function applyCleanupToClassification(result: StageBResult): void {
  if (result.cleanup.status === 'PASS' && (result.classification === 'CLEANUP_LEAK' || result.classification === 'DESTROY_ERROR')) {
    result.classification = 'PASS';
    result.failureStage = null;
    result.rootCause = null;
    result.rootCauseEvidence = null;
    return;
  }
  if (result.cleanup.status !== 'FAIL') return;
  if (result.classification !== 'PASS' && result.classification !== 'EXPECTED_UNSUPPORTED') return;
  const leak = result.cleanup.leaks.length > 0;
  result.classification = leak ? 'CLEANUP_LEAK' : 'DESTROY_ERROR';
  result.failureStage = result.classification;
  result.rootCause = null;
  result.rootCauseEvidence = `${result.cleanup.detail ?? 'cleanup failed'} — decide DEPLOYZ_BUG vs AWS_TRANSIENT_FAILURE`;
}
