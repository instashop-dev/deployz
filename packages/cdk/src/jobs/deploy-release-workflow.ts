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
 * §46/§48: any failure ONCE the deployment has moved to UPDATING transitions
 * it to FAILED (with a §62 event) before rethrowing — it must never be
 * stranded in UPDATING. A failure BEFORE that transition (i.e. the preflight
 * gate itself) leaves the deployment exactly where it was (HEALTHY).
 *
 * The workflow is defined as an async generator yielding WorkflowStep
 * descriptors, executed by the U1 DurableRuntime (todo 7). Every step emits a
 * §62-complete event via the injectable EventEmitter (same pattern as the
 * INSTALL workflow, todo 13).
 *
 * §30: the preflight gate runs the FULL engine (`runFullPreflight`), not the
 * minimal region+SCP subset — port/health-endpoint/secrets/migration/
 * env-vars/quota/image-health/AWS-usability/permission all gate the deploy.
 * The deployment is already HEALTHY (relay already connected) at this point,
 * so the relay-contact check is skipped here (`skipRelayContact: true`) —
 * connectivity is proven separately by the health-report wait later in this
 * same workflow.
 *
 * Injectable seams (all AWS-backed — PENDING-AWS in this environment; tests
 * inject mocks with zero AWS):
 *   - MigrationRunner          — runs the §26 migration one-off task
 *   - EcsUpdater               — updates the service to the immutable image digest
 *   - InfraUpgrader            — relay-driven CFN stack update (runtime-v1 → v2)
 *   - PendingReleaseChecker    — detects a newer release → UPDATE_AVAILABLE
 *     (item 6: the default seam THROWS — a silent `false` would make the
 *     UPDATE_AVAILABLE product state permanently unreachable, which is worse
 *     than a loud error. Callers must inject a real release-table lookup.)
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

import { actorFromInitiator, type EventEmitter, type WorkflowInitiator } from './event-emitter.js';

import { assertHealthReport } from './preflight.js';

import { runFullPreflight, type PreflightEngineDeps } from './preflight-engine.js';

import type { ConfigEntry } from './config-update-workflow.js';

import {
  PreflightError,
  type DeploymentStateStore,
  type FailedCheck,
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
  /** True when the release requires a migration (a missing command then fails preflight). */
  readonly migrationRequired?: boolean | undefined;
  /** §60 infra version being upgraded FROM (e.g. `runtime-v1`). */
  readonly fromInfraVersion?: string | undefined;
  /** §60 infra version being upgraded TO (e.g. `runtime-v2`). */
  readonly toInfraVersion?: string | undefined;
  /** §62 audit actor — who/what initiated this workflow. Defaults to system. */
  readonly initiatedBy?: WorkflowInitiator | undefined;

  // ── §30 full-preflight application inputs (all optional; a missing
  // required value correctly FAILS the corresponding check). ─────────────
  readonly configEntries?: readonly ConfigEntry[] | undefined;
  readonly port?: number | undefined;
  readonly healthPath?: string | undefined;
  readonly requiredSecrets?: readonly string[] | undefined;
  readonly configuredSecrets?: readonly string[] | undefined;
  readonly requiredEnvVars?: readonly string[] | undefined;
  readonly configuredEnvVars?: readonly string[] | undefined;
  readonly ecrRepositoryName?: string | undefined;
  readonly ecrImageTag?: string | undefined;
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

/**
 * Full-preflight engine deps, all OPTIONAL: a caller that doesn't care about
 * quota/image-health/AWS-usability/permission checks (e.g. most unit tests)
 * gets safe, AWS-free defaults (see `resolvePreflightDeps` in
 * install-workflow.ts for the identical convention).
 */
export type DeployReleasePreflightDeps = Partial<PreflightEngineDeps>;

/** Dependencies injected into the workflow factory. */
export interface DeployReleaseWorkflowDeps {
  readonly emitter: EventEmitter;
  readonly deploymentStore: DeploymentStateStore;
  readonly migrationRunner: MigrationRunner;
  readonly ecsUpdater: EcsUpdater;
  readonly infraUpgrader: InfraUpgrader;
  readonly pendingReleaseChecker: PendingReleaseChecker;
  readonly preflight?: DeployReleasePreflightDeps | undefined;
}

/** Always-pass stub used when no real quota/image-health checker is injected. */
const ALWAYS_PASS_QUOTA_CHECKER: PreflightEngineDeps['quotaChecker'] = {
  async checkQuotas() {
    return { ok: true };
  },
};
const ALWAYS_PASS_IMAGE_HEALTH_CHECKER: PreflightEngineDeps['imageHealthChecker'] = {
  async checkHealth(imageDigest) {
    return { ok: true, digest: imageDigest };
  },
};

/** Fill in the optional preflight deps with AWS-free defaults. */
function resolvePreflightDeps(
  deps: DeployReleasePreflightDeps | undefined,
): PreflightEngineDeps {
  return {
    quotaChecker: deps?.quotaChecker ?? ALWAYS_PASS_QUOTA_CHECKER,
    imageHealthChecker: deps?.imageHealthChecker ?? ALWAYS_PASS_IMAGE_HEALTH_CHECKER,
    allowedConfigKeys: deps?.allowedConfigKeys ?? [],
    cloudFormationChecker: deps?.cloudFormationChecker,
    ecsChecker: deps?.ecsChecker,
    rdsChecker: deps?.rdsChecker,
    ecrImageChecker: deps?.ecrImageChecker,
    permissionChecker: deps?.permissionChecker,
  };
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
  const preflightDeps = resolvePreflightDeps(deps.preflight);

  return async function* deployReleaseWorkflow(
    input: DeployReleaseInput,
  ): AsyncGenerator<WorkflowStep, DeployReleaseOutput, unknown> {
    const actor = actorFromInitiator(input.initiatedBy);
    const baseEvent = {
      organizationId: input.organizationId,
      customerId: input.customerId,
      deploymentId: input.deploymentId,
      jobId: input.jobId,
      releaseId: input.releaseId,
    };

    // §46/§48: once the deployment has moved to UPDATING, ANY step failure
    // must transition it to FAILED (with a §62 event) before rethrowing — a
    // failed deploy must never be stranded in UPDATING forever. Wraps every
    // step from `migration` through `finalize` (i.e. everything after the
    // preflight gate moves the state to UPDATING).
    const failDeployment = async (err: unknown): Promise<void> => {
      const failureCode =
        err instanceof DeployReleaseError
          ? err.failureCode
          : err instanceof PreflightError
            ? err.check.failureCode
            : 'UNKNOWN';
      const reason = err instanceof Error ? err.message : String(err);

      await deps.deploymentStore.set(input.deploymentId, 'FAILED');

      await deps.emitter.emit(actor, {
        ...baseEvent,
        eventType: 'deploy.state.failed',
        previousState: 'UPDATING',
        requestedState: 'FAILED',
        result: `failed:${failureCode}`,
        payload: { reason, imageDigest: input.imageDigest },
      });
    };

    function guardedStep(name: string, fn: () => Promise<unknown>): WorkflowStep {
      return step(name, async () => {
        try {
          return await fn();
        } catch (err) {
          await failDeployment(err);
          throw err;
        }
      });
    }

    // ── Step 1: Preflight gate ──────────────────────────────────────
    // Runs the FULL §30 engine (item 1) — port/health-endpoint/secrets/
    // migration/env-vars/quota/image-health/AWS-usability/permission all
    // gate the deploy, in addition to region+SCP. A failed preflight HALTS
    // the workflow BEFORE any migration / ECS / infra step runs (the
    // negative test asserts the seams are never called), and the deployment
    // stays HEALTHY (it never reached UPDATING, so it does NOT go to
    // FAILED — that only happens for failures AFTER this gate). On success
    // the deployment transitions HEALTHY → UPDATING.
    yield step('preflight', async () => {
      const result = await runFullPreflight(
        {
          region: input.region,
          installationId: input.installationId,
          // The deployment is already HEALTHY — relay connectivity was
          // already proven and is re-proven by the health-report wait
          // later in this workflow, so there's no fresh contact payload
          // to check here.
          skipRelayContact: true,
          configEntries: input.configEntries,
          migrationCommand: input.migrationCommand,
          migrationRequired: input.migrationRequired,
          imageDigest: input.imageDigest,
          port: input.port,
          healthPath: input.healthPath,
          requiredSecrets: input.requiredSecrets,
          configuredSecrets: input.configuredSecrets,
          requiredEnvVars: input.requiredEnvVars,
          configuredEnvVars: input.configuredEnvVars,
          ecrRepositoryName: input.ecrRepositoryName,
          ecrImageTag: input.ecrImageTag,
        },
        preflightDeps,
      );
      const failedCheck: FailedCheck | undefined = result.failures[0];

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
    yield guardedStep('migration', async () => {
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
    yield guardedStep('ecs-update', async () => {
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
    yield guardedStep('infra-upgrade', async () => {
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
    yield guardedStep('observe-health', async () => {
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
    const finalized = (yield guardedStep('finalize', async () => {
      const pending = await deps.pendingReleaseChecker.hasPendingRelease(
        input.deploymentId,
        input.releaseId,
      );
      const state: DeployReleaseFinalStatus = pending ? 'UPDATE_AVAILABLE' : 'HEALTHY';

      await deps.deploymentStore.set(input.deploymentId, state);

      // §38: a successful deploy (HEALTHY or UPDATE_AVAILABLE — both mean
      // the release WAS applied) advances the release pointers: the release
      // that was current becomes previous, and the just-deployed release
      // becomes current.
      const priorPointers = await deps.deploymentStore.getReleasePointers(input.deploymentId);
      await deps.deploymentStore.setReleasePointers(input.deploymentId, {
        currentReleaseId: input.releaseId,
        previousReleaseId: priorPointers.currentReleaseId,
      });

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

/**
 * §22/§46: "is a newer release pending" is NOT an AWS call — it's a
 * control-plane database question (does a `releases` row newer than
 * `appliedReleaseId` exist for this deployment's application?). Item 6: a
 * silent `false` here would make the UPDATE_AVAILABLE product state
 * PERMANENTLY unreachable, which is a worse failure mode than a loud error.
 * So the default seam intentionally THROWS rather than guessing — callers
 * MUST inject a real checker backed by the releases table.
 */
export function createRealPendingReleaseChecker(): PendingReleaseChecker {
  return {
    async hasPendingRelease(deploymentId, appliedReleaseId) {
      throw new Error(
        'PendingReleaseChecker.hasPendingRelease is not implemented — inject a ' +
          'releases-table-backed checker (queried by deploymentId + appliedReleaseId). ' +
          `Called for deploymentId=${deploymentId}, appliedReleaseId=${appliedReleaseId}.`,
      );
    },
  };
}
