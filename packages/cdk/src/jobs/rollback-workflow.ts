/**
 * ROLLBACK workflow — the durable function that restores a deployment to the
 * previous release's image + task/service configuration.
 *
 * §22/§26: ROLLBACK restores image + task/service config ONLY. It does NOT
 * reverse database migrations — the UI discloses this, and this workflow has
 * NO migration seam (a rollback never runs a DB migration). The disclosure
 * copy is emitted as a §62 event.
 *
 * State machine:
 *   UPDATING (or FAILED) → (restore image digest) → (health observation) → HEALTHY
 *
 * Digest-equality: the rollback target is the PREVIOUS release's exact
 * immutable `sha256:` digest produced by the build pipeline (todo 16). The
 * workflow passes the digest through unchanged — no tag resolution — and the
 * executor is called with that exact digest. A non-`sha256:` target (e.g. a
 * tag) fails the immutability guard before any restore is dispatched.
 *
 * The workflow is defined as an async generator yielding WorkflowStep
 * descriptors, executed by the U1 DurableRuntime (todo 7). Every step emits a
 * §62-complete event via the injectable EventEmitter (same pattern as the
 * INSTALL workflow, todo 13).
 */

import {
  step,
  waitForCallback,
  type DurableWorkflow,
  type WorkflowStep,
} from '../durable/durable-runtime.js';

import type { EventActor, EventEmitter } from './event-emitter.js';

import { assertHealthReport } from './preflight.js';

import {
  PreflightError,
  type DeploymentStateStore,
} from './install-workflow.js';

// ── Types ────────────────────────────────────────────────────────────────

/** Input to the ROLLBACK workflow. */
export interface RollbackInput {
  readonly deploymentId: string;
  readonly customerId: string;
  readonly organizationId: string;
  readonly jobId: string;
  readonly installationId: string;
  /** The previous release being rolled back to. */
  readonly releaseId: string;
  /** The PREVIOUS release's exact immutable `sha256:` digest (todo 16). */
  readonly imageDigest: string;
}

/** Output from the ROLLBACK workflow. */
export interface RollbackOutput {
  readonly status: 'HEALTHY';
  readonly deploymentId: string;
  readonly releaseId: string;
  readonly imageDigest: string;
}

// ── Seam result types ────────────────────────────────────────────────────

/** Result of restoring the previous release's image + task/service config. */
export type RollbackResult =
  | { readonly ok: true; readonly digest: string }
  | { readonly ok: false; readonly failureCode: 'ROLLBACK_FAILED'; readonly reason: string };

// ── Seam interface ───────────────────────────────────────────────────────

/**
 * Restores image + task/service config ONLY (§22/§26 — never a DB migration).
 *
 * PENDING-AWS: the real executor dispatches a ROLLBACK relay command to the
 * customer's relay, which updates the ECS task/service back to the previous
 * release's image. Tests inject a mock with zero AWS.
 */
export interface RollbackExecutor {
  restore(deploymentId: string, imageDigest: string): Promise<RollbackResult>;
}

/** Dependencies injected into the workflow factory. */
export interface RollbackWorkflowDeps {
  readonly emitter: EventEmitter;
  readonly deploymentStore: DeploymentStateStore;
  readonly rollbackExecutor: RollbackExecutor;
}

// ── Copy map (§22/§26 disclosure) ────────────────────────────────────────

/** Disclosure copy emitted as a §62 event — rollback never reverses DB migrations. */
export const ROLLBACK_COPY = {
  noDbMigration:
    'Rollback restores the image and task/service configuration only. It does not reverse database migrations.',
} as const;

// ── Digest immutability ──────────────────────────────────────────────────

/** Immutable `sha256:` digest shape produced by the build pipeline (todo 16). */
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** True when the digest is an immutable `sha256:` digest (no tag resolution). */
export function isImmutableDigest(digest: string): boolean {
  return SHA256_DIGEST_PATTERN.test(digest);
}

// ── Error ────────────────────────────────────────────────────────────────

/** Stable §61 failure codes a ROLLBACK step can fail with. */
export type RollbackFailureCode = 'ROLLBACK_FAILED' | 'INVALID_DIGEST';

/** Thrown when a rollback step fails, carrying a stable §61 failure code. */
export class RollbackError extends Error {
  constructor(
    readonly failureCode: RollbackFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'RollbackError';
  }
}

// ── Workflow factory ─────────────────────────────────────────────────────

/**
 * Create the ROLLBACK workflow.
 *
 * Returns a DurableWorkflow that can be executed by the DurableRuntime.
 * The deps (emitter, deploymentStore, rollbackExecutor) are captured at
 * creation time so the workflow generator itself is a pure function of its
 * input.
 */
export function createRollbackWorkflow(
  deps: RollbackWorkflowDeps,
): DurableWorkflow<RollbackInput, RollbackOutput> {
  return async function* rollbackWorkflow(
    input: RollbackInput,
  ): AsyncGenerator<WorkflowStep, RollbackOutput, unknown> {
    const actor: EventActor = { type: 'system' };
    const baseEvent = {
      organizationId: input.organizationId,
      customerId: input.customerId,
      deploymentId: input.deploymentId,
      jobId: input.jobId,
      releaseId: input.releaseId,
    };

    // ── Step 1: Mark rolling back ──────────────────────────────────────
    // The rollback is triggered from UPDATING (mid-deploy) or FAILED (a
    // failed deploy). The deployment transitions to UPDATING while the image
    // is restored.
    yield step('mark-rolling-back', async () => {
      const previousState = await deps.deploymentStore.get(input.deploymentId);
      await deps.deploymentStore.set(input.deploymentId, 'UPDATING');

      await deps.emitter.emit(actor, {
        ...baseEvent,
        eventType: 'rollback.state.updating',
        previousState,
        requestedState: 'UPDATING',
        result: 'ok',
        payload: { targetDigest: input.imageDigest },
      });

      return { state: 'UPDATING' };
    });

    // ── Step 2: Restore image + task/service config ────────────────────
    // Restores the previous release's image + task/service config ONLY.
    // There is NO migration step — rollback does NOT reverse DB migrations
    // (§22/§26). The disclosure copy is emitted as its own §62 event.
    yield step('restore', async () => {
      // §62 disclosure: rollback does not reverse DB migrations.
      await deps.emitter.emit(actor, {
        ...baseEvent,
        eventType: 'rollback.disclosure',
        previousState: 'UPDATING',
        requestedState: 'UPDATING',
        result: 'ok',
        payload: { disclosure: ROLLBACK_COPY.noDbMigration },
      });

      // Digest-equality: the target MUST be the previous release's exact
      // immutable sha256: digest. A tag would fail this guard — no tag
      // resolution happens anywhere in the rollback path.
      if (!isImmutableDigest(input.imageDigest)) {
        await deps.emitter.emit(actor, {
          ...baseEvent,
          eventType: 'rollback.restore',
          previousState: 'UPDATING',
          requestedState: 'UPDATING',
          result: 'failed:INVALID_DIGEST',
          payload: { imageDigest: input.imageDigest },
        });
        throw new RollbackError(
          'INVALID_DIGEST',
          `Rollback target is not an immutable sha256: digest: ${input.imageDigest}`,
        );
      }

      const result = await deps.rollbackExecutor.restore(
        input.deploymentId,
        input.imageDigest,
      );

      await deps.emitter.emit(actor, {
        ...baseEvent,
        eventType: 'rollback.restore',
        previousState: 'UPDATING',
        requestedState: 'UPDATING',
        result: result.ok ? 'ok' : `failed:${result.failureCode}`,
        payload: { imageDigest: input.imageDigest },
      });

      if (!result.ok) {
        throw new RollbackError(
          result.failureCode,
          `Rollback failed: ${result.reason}`,
        );
      }
      return { digest: input.imageDigest };
    });

    // ── Step 3: Wait for relay health report ────────────────────────────
    // The relay reports health on every poll (todo 12). The health report
    // after the restore proves the previous release is live and healthy.
    const healthReport = yield waitForCallback(
      `rollback:${input.installationId}:health-report`,
    );

    // ── Step 4: Observe health → HEALTHY ────────────────────────────────
    yield step('observe-health', async () => {
      const healthCheck = assertHealthReport(healthReport, input.installationId);

      await deps.emitter.emit(actor, {
        ...baseEvent,
        eventType: 'rollback.health',
        previousState: 'UPDATING',
        requestedState: 'HEALTHY',
        result: healthCheck.passed ? 'ok' : `failed:${healthCheck.failureCode}`,
        payload: { report: healthReport, check: healthCheck },
      });

      if (!healthCheck.passed) {
        throw new PreflightError(healthCheck);
      }

      await deps.deploymentStore.set(input.deploymentId, 'HEALTHY');

      await deps.emitter.emit(actor, {
        ...baseEvent,
        eventType: 'rollback.state.healthy',
        previousState: 'UPDATING',
        requestedState: 'HEALTHY',
        result: 'ok',
        payload: { imageDigest: input.imageDigest },
      });

      return { healthy: true };
    });

    return {
      status: 'HEALTHY',
      deploymentId: input.deploymentId,
      releaseId: input.releaseId,
      imageDigest: input.imageDigest,
    };
  };
}
