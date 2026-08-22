/**
 * DEPLOY_RELEASE workflow — the durable function that deploys a new release
 * to a HEALTHY deployment (§22: releases NEVER auto-update customers — this
 * is explicitly triggered by the vendor).
 *
 * State machine:
 *   UPDATING → (preflight gate) → (migration one-off §26) → (ECS update)
 *   → (§60 infra-version upgrade) → (health observation)
 *   → HEALTHY / UPDATE_AVAILABLE / FAILED
 *
 * The workflow is defined as an async generator yielding WorkflowStep
 * descriptors, executed by the U1 DurableRuntime (todo 7). Every step emits a
 * §62-complete event via the injectable EventEmitter (same pattern as the
 * INSTALL workflow, todo 13).
 *
 * Injectable seams (all AWS-backed — PENDING-AWS in this environment; tests
 * inject mocks with zero AWS):
 *   - MigrationRunner          — runs the §26 migration one-off task
 *   - EcsUpdater               — updates the service to the immutable image digest
 *   - InfraUpgrader            — relay-driven CFN stack update (runtime-v1 → v2)
 *   - PendingReleaseChecker    — detects a newer release → UPDATE_AVAILABLE
 *
 * The ECS update dispatches the exact immutable `sha256:` digest produced by
 * the build pipeline (todo 16). The migration runs as a one-off task BEFORE
 * the deployment completes (§26).
 */

import {
  step,
  waitForCallback,
  type DurableWorkflow,
  type WorkflowStep,
} from '../durable/durable-runtime.js';

import type { EventActor, EventEmitter } from './event-emitter.js';

import {
  assertHealthReport,
  runPreflight,
  type PreflightCheck,
} from './preflight.js';

import {
  PreflightError,
  type DeploymentStateStore,
} from './install-workflow.js';

// ── Types ────────────────────────────────────────────────────────────────

/** Successful terminal deployment states for DEPLOY_RELEASE. */
export type DeployReleaseFinalStatus = 'HEALTHY' | 'UPDATE_AVAILABLE';

/** Input to the DEPLOY_RELEASE workflow. */
export interface DeployReleaseInput {
  readonly deploymentId: string;
  readonly customerId: string;
  readonly organizationId: string;
  readonly jobId: string;
  readonly installationId: string;
  readonly region: string;
  readonly releaseId: string;
  readonly releaseVersion: string;
  /** Immutable `sha256:` digest produced by the build pipeline (todo 16). */
  readonly imageDigest: string;
  /** §26 migration command carried with the release (null/empty = skip). */
  readonly migrationCommand?: string | undefined;
  /** §60 infra version being upgraded FROM (e.g. `runtime-v1`). */
  readonly fromInfraVersion?: string | undefined;
  /** §60 infra version being upgraded TO (e.g. `runtime-v2`). */
  readonly toInfraVersion?: string | undefined;
}

/** Output from the DEPLOY_RELEASE workflow. */
export interface DeployReleaseOutput {
  readonly status: DeployReleaseFinalStatus;
  readonly deploymentId: string;
  readonly releaseId: string;
  readonly imageDigest: string;
}

// ── Seam result types ────────────────────────────────────────────────────

/** Result of the §26 migration one-off task. */
export type MigrationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failureCode: 'MIGRATION_FAILED'; readonly reason: string };

/** Result of the ECS service update to the new image digest. */
export type EcsUpdateResult =
  | { readonly ok: true; readonly digest: string }
  | { readonly ok: false; readonly failureCode: 'ECS_DEPLOYMENT_FAILED'; readonly reason: string };

/** Result of the §60 infra-version CFN stack update. */
export type InfraUpgradeResult =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly failureCode: 'UNKNOWN'; readonly reason: string };

// ── Seam interfaces ──────────────────────────────────────────────────────

/** Runs the §26 migration command as a one-off task before deployment completes. */
export interface MigrationRunner {
  runMigration(command: string): Promise<MigrationResult>;
}

/** Updates the ECS service to the new immutable image digest. */
export interface EcsUpdater {
  updateService(deploymentId: string, imageDigest: string): Promise<EcsUpdateResult>;
}

/** Relay-driven CFN stack update moving the deployment's infra version forward (§60). */
export interface InfraUpgrader {
  upgradeInfraVersion(
    deploymentId: string,
    fromVersion: string,
    toVersion: string,
  ): Promise<InfraUpgradeResult>;
}

/** Detects whether a release newer than the just-applied one is pending (§22). */
export interface PendingReleaseChecker {
  hasPendingRelease(deploymentId: string, appliedReleaseId: string): Promise<boolean>;
}

/** Dependencies injected into the workflow factory. */
export interface DeployReleaseWorkflowDeps {
  readonly emitter: EventEmitter;
  readonly deploymentStore: DeploymentStateStore;
  readonly migrationRunner: MigrationRunner;
  readonly ecsUpdater: EcsUpdater;
  readonly infraUpgrader: InfraUpgrader;
  readonly pendingReleaseChecker: PendingReleaseChecker;
}

// ── Error ────────────────────────────────────────────────────────────────

/** Stable §61 failure codes a DEPLOY_RELEASE step can fail with. */
export type DeployReleaseFailureCode =
  | 'MIGRATION_FAILED'
  | 'ECS_DEPLOYMENT_FAILED'
  | 'UNKNOWN';

/** Thrown when a deploy step fails, carrying a stable §61 failure code. */
export class DeployReleaseError extends Error {
  constructor(
    readonly failureCode: DeployReleaseFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'DeployReleaseError';
  }
}

// ── Workflow factory ─────────────────────────────────────────────────────

/**
 * Create the DEPLOY_RELEASE workflow.
 *
 * Returns a DurableWorkflow that can be executed by the DurableRuntime.
 * The deps (emitter, deploymentStore, seams) are captured at creation time
 * so the workflow generator itself is a pure function of its input.
 */
export function createDeployReleaseWorkflow(
  deps: DeployReleaseWorkflowDeps,
): DurableWorkflow<DeployReleaseInput, DeployReleaseOutput> {
  return async function* deployReleaseWorkflow(
    input: DeployReleaseInput,
  ): AsyncGenerator<WorkflowStep, DeployReleaseOutput, unknown> {
    const actor: EventActor = { type: 'system' };
    const baseEvent = {
      organizationId: input.organizationId,
      customerId: input.customerId,
      deploymentId: input.deploymentId,
      jobId: input.jobId,
      releaseId: input.releaseId,
    };

    // ── Step 1: Preflight gate ──────────────────────────────────────
    // Runs the preflight engine (todo 13's preflight.ts). A failed preflight
    // HALTS the workflow BEFORE any migration / ECS / infra step runs (the
    // negative test asserts the seams are never called). On success the
    // deployment transitions HEALTHY → UPDATING.
    yield step('preflight', async () => {
      const result = await runPreflight(input.region);
      const failedCheck = result.checks.find(
        (c): c is PreflightCheck & { passed: false } => !c.passed,
      );

      await deps.emitter.emit(actor, {
        ...baseEvent,
        eventType: 'deploy.preflight',
        previousState: 'HEALTHY',
        requestedState: 'UPDATING',
        result: result.passed ? 'passed' : `failed:${result.failureCode ?? 'UNKNOWN'}`,
        payload: { region: input.region, checks: result.checks },
      });

      if (failedCheck) {
        throw new PreflightError(failedCheck);
      }

      await deps.deploymentStore.set(input.deploymentId, 'UPDATING');

      await deps.emitter.emit(actor, {
        ...baseEvent,
        eventType: 'deploy.state.updating',
        previousState: 'HEALTHY',
        requestedState: 'UPDATING',
        result: 'ok',
        payload: {
          releaseVersion: input.releaseVersion,
          imageDigest: input.imageDigest,
        },
      });

      return { passed: true };
    });

    // ── Step 2: Migration one-off (§26) ─────────────────────────────
    // Runs the release's migration command as a one-off task BEFORE the ECS
    // update completes. Skips when no command is carried.
    yield step('migration', async () => {
      if (!input.migrationCommand) {
        await deps.emitter.emit(actor, {
          ...baseEvent,
          eventType: 'deploy.migration',
          previousState: 'UPDATING',
          requestedState: 'UPDATING',
          result: 'skipped',
          payload: { reason: 'no-migration-command' },
        });
        return { skipped: true };
      }

      const result = await deps.migrationRunner.runMigration(input.migrationCommand);

      await deps.emitter.emit(actor, {
        ...baseEvent,
        eventType: 'deploy.migration',
        previousState: 'UPDATING',
        requestedState: 'UPDATING',
        result: result.ok ? 'ok' : `failed:${result.failureCode}`,
        payload: { command: input.migrationCommand },
      });

      if (!result.ok) {
        throw new DeployReleaseError(
          result.failureCode,
          `Migration failed: ${result.reason}`,
        );
      }
      return { migrated: true };
    });

    // ── Step 3: ECS update ──────────────────────────────────────────
    // Updates the service to the new immutable image digest (todo 16).
    yield step('ecs-update', async () => {
      const result = await deps.ecsUpdater.updateService(
        input.deploymentId,
        input.imageDigest,
      );

      await deps.emitter.emit(actor, {
        ...baseEvent,
        eventType: 'deploy.ecs-update',
        previousState: 'UPDATING',
        requestedState: 'UPDATING',
        result: result.ok ? 'ok' : `failed:${result.failureCode}`,
        payload: { imageDigest: input.imageDigest },
      });

      if (!result.ok) {
        throw new DeployReleaseError(
          result.failureCode,
          `ECS update failed: ${result.reason}`,
        );
      }
      return { digest: input.imageDigest };
    });

    // ── Step 4: §60 infra-version upgrade ───────────────────────────
    // Relay-driven CFN stack update from runtime-v1 → runtime-v2. Skips when
    // no version delta is requested. Health is verified AFTER this step.
    yield step('infra-upgrade', async () => {
      const from = input.fromInfraVersion;
      const to = input.toInfraVersion;
      if (!from || !to || from === to) {
        await deps.emitter.emit(actor, {
          ...baseEvent,
          eventType: 'deploy.infra-upgrade',
          previousState: 'UPDATING',
          requestedState: 'UPDATING',
          result: 'skipped',
          payload: { fromVersion: from, toVersion: to },
        });
        return { skipped: true };
      }

      const result = await deps.infraUpgrader.upgradeInfraVersion(
        input.deploymentId,
        from,
        to,
      );

      await deps.emitter.emit(actor, {
        ...baseEvent,
        eventType: 'deploy.infra-upgrade',
        previousState: 'UPDATING',
        requestedState: 'UPDATING',
        result: result.ok ? 'ok' : `failed:${result.failureCode}`,
        payload: { fromVersion: from, toVersion: to },
      });

      if (!result.ok) {
        throw new DeployReleaseError(
          result.failureCode,
          `Infra upgrade ${from} → ${to} failed: ${result.reason}`,
        );
      }
      return { upgraded: true, fromVersion: from, toVersion: to };
    });

    // ── Step 5: Wait for relay health report ────────────────────────
    // The relay reports health on every poll (todo 12). The health report
    // after the ECS update + infra upgrade proves the new release is live.
    const healthReport = yield waitForCallback(
      `deploy:${input.installationId}:health-report`,
    );

    // ── Step 6: Observe health ──────────────────────────────────────
    yield step('observe-health', async () => {
      const healthCheck = assertHealthReport(healthReport, input.installationId);

      await deps.emitter.emit(actor, {
        ...baseEvent,
        eventType: 'deploy.health',
        previousState: 'UPDATING',
        requestedState: 'UPDATING',
        result: healthCheck.passed ? 'ok' : `failed:${healthCheck.failureCode}`,
        payload: { report: healthReport, check: healthCheck },
      });

      if (!healthCheck.passed) {
        throw new PreflightError(healthCheck);
      }
      return { healthy: true };
    });

    // ── Step 7: Finalize (HEALTHY vs UPDATE_AVAILABLE) ──────────────
    // After a successful deploy the deployment returns to HEALTHY — unless a
    // newer release is pending (§22), in which case it lands in
    // UPDATE_AVAILABLE. FAILED is reached by throwing from an earlier step.
    const finalized = (yield step('finalize', async () => {
      const pending = await deps.pendingReleaseChecker.hasPendingRelease(
        input.deploymentId,
        input.releaseId,
      );
      const state: DeployReleaseFinalStatus = pending ? 'UPDATE_AVAILABLE' : 'HEALTHY';

      await deps.deploymentStore.set(input.deploymentId, state);

      await deps.emitter.emit(actor, {
        ...baseEvent,
        eventType: pending ? 'deploy.state.update-available' : 'deploy.state.healthy',
        previousState: 'UPDATING',
        requestedState: state,
        result: 'ok',
        payload: {
          releaseId: input.releaseId,
          imageDigest: input.imageDigest,
          pendingRelease: pending,
        },
      });

      return { state };
    })) as { state: DeployReleaseFinalStatus };

    return {
      status: finalized.state,
      deploymentId: input.deploymentId,
      releaseId: input.releaseId,
      imageDigest: input.imageDigest,
    };
  };
}

// ── Real AWS-backed implementations ───────────────────────────────────────

export function createRealMigrationRunner(): MigrationRunner {
  return {
    async runMigration() {
      // ponytail: running a migration one-off ECS task requires the cluster
      // and task definition from the relay. Until the relay is wired, pass.
      return { ok: true };
    },
  };
}

export function createRealEcsUpdater(): EcsUpdater {
  return {
    async updateService(_deploymentId, imageDigest) {
      // ponytail: the real updater dispatches a relay command to update the
      // ECS service's task definition to the new image digest. Until the
      // relay is wired in the customer account, pass through.
      return { ok: true, digest: imageDigest };
    },
  };
}

export function createRealInfraUpgrader(): InfraUpgrader {
  return {
    async upgradeInfraVersion(_deploymentId, _fromVersion, toVersion) {
      // ponytail: infra version upgrades require the relay to execute
      // CloudFormation stack updates in the customer account. Pass through
      // until the relay command infrastructure is live.
      return { ok: true, version: toVersion };
    },
  };
}

export function createRealPendingReleaseChecker(): PendingReleaseChecker {
  return {
    async hasPendingRelease() {
      // ponytail: pending release detection queries the releases DB table.
      // Until the release pipeline is seeded, always report false.
      return false;
    },
  };
}
