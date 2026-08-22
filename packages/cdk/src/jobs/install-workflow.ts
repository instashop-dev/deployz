/**
 * INSTALL workflow — the durable function that orchestrates a customer
 * deployment from "link clicked" to "Healthy".
 *
 * This is the FIRST real consumer of the U1 DurableRuntime (todo 7).
 * The workflow is defined as an async generator yielding WorkflowStep
 * descriptors; the runtime executes steps one at a time, persisting
 * state between each.
 *
 * State machine:
 *   NOT_INSTALLED → (preflight) → INSTALLING → (health report) → HEALTHY
 *
 * Every step emits a §62-complete event (who/when/customer/previous state/
 * requested state/release/job ID/result) via the injectable EventEmitter.
 *
 * The workflow correlates CFN approval: the install ID is the callback
 * token for the relay's first contact. When the relay registers, the
 * control plane resumes this workflow with the contact payload.
 *
 * §30 preflight: after the minimal region+SCP gate (which must pass before
 * the bootstrap stack is even attempted), the workflow runs the FULL §30
 * engine (`runFullPreflight`) — port/health-endpoint/secrets/migration/
 * env-vars/quota/image-health/AWS-usability/permission — before waiting on
 * the relay's first contact. The relay-contact check itself hasn't got a
 * payload yet at that point, so it is passed with `skipRelayContact: true`;
 * it is still enforced at the correct time, right after the callback
 * resolves, via `assertRelayContact` in the `mark-installing` step below.
 */

import {
  step,
  waitForCallback,
  type DurableWorkflow,
  type WorkflowStep,
} from '../durable/durable-runtime.js';

import { actorFromInitiator, type EventEmitter, type WorkflowInitiator } from './event-emitter.js';

import {
  assertHealthReport,
  assertRelayContact,
  runPreflight,
} from './preflight.js';

import { runFullPreflight, type PreflightEngineDeps } from './preflight-engine.js';

import type { ConfigEntry } from './config-update-workflow.js';

// ── Types ────────────────────────────────────────────────────────────────

/** Input to the INSTALL workflow. */
export interface InstallInput {
  readonly deploymentId: string;
  readonly customerId: string;
  readonly organizationId: string;
  readonly jobId: string;
  readonly installationId: string;
  readonly region: string;
  readonly releaseId?: string | undefined;
  /** §62 audit actor — who/what initiated this workflow. Defaults to system. */
  readonly initiatedBy?: WorkflowInitiator | undefined;

  // ── §30 full-preflight application inputs (all optional; a missing
  // required value correctly FAILS the corresponding check rather than
  // silently skipping it — see preflight-engine.ts checks 8-11). ──────────
  readonly configEntries?: readonly ConfigEntry[] | undefined;
  readonly migrationCommand?: string | undefined;
  readonly migrationRequired?: boolean | undefined;
  readonly imageDigest?: string | undefined;
  readonly port?: number | undefined;
  readonly healthPath?: string | undefined;
  readonly requiredSecrets?: readonly string[] | undefined;
  readonly configuredSecrets?: readonly string[] | undefined;
  readonly requiredEnvVars?: readonly string[] | undefined;
  readonly configuredEnvVars?: readonly string[] | undefined;
  readonly ecrRepositoryName?: string | undefined;
  readonly ecrImageTag?: string | undefined;
}

/** Output from the INSTALL workflow. */
export interface InstallOutput {
  readonly status: 'HEALTHY';
  readonly deploymentId: string;
}

/** §38 release pointers persisted on the deployment row. */
export interface ReleasePointers {
  readonly currentReleaseId: string | null;
  readonly previousReleaseId: string | null;
}

/** Injectable deployment state store — transitions deployment.state. */
export interface DeploymentStateStore {
  get(deploymentId: string): Promise<string>;
  set(deploymentId: string, state: string): Promise<void>;
  /** §38: read the deployment's current/previous release pointers. */
  getReleasePointers(deploymentId: string): Promise<ReleasePointers>;
  /** §38: write the deployment's current/previous release pointers. */
  setReleasePointers(deploymentId: string, pointers: ReleasePointers): Promise<void>;
}

/**
 * Full-preflight engine deps, all OPTIONAL here: a caller that doesn't care
 * about quota/image-health/AWS-usability/permission checks (e.g. most unit
 * tests) gets safe, AWS-free defaults — quota + image-health default to an
 * always-pass stub (never a live AWS call), the AWS-usability/permission
 * seams default to "not injected" (the engine reports them as skipped, per
 * preflight-engine.ts items 2/3).
 */
export type InstallPreflightDeps = Partial<PreflightEngineDeps>;

/** Dependencies injected into the workflow factory. */
export interface InstallWorkflowDeps {
  readonly emitter: EventEmitter;
  readonly deploymentStore: DeploymentStateStore;
  readonly preflight?: InstallPreflightDeps | undefined;
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
function resolvePreflightDeps(deps: InstallPreflightDeps | undefined): PreflightEngineDeps {
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

/**
 * A failed check, generic across both preflight modules — `preflight.ts`'s
 * minimal `PreflightCheck` and `preflight-engine.ts`'s full `PreflightCheck`
 * carry different (but overlapping) `failureCode` literal unions, so
 * `PreflightError` accepts the shared shape rather than either module's
 * specific type.
 */
export interface FailedCheck {
  readonly check: string;
  readonly passed: false;
  readonly failureCode: string;
  readonly reason: string;
}

/** Thrown when a preflight check fails, halting the workflow. */
export class PreflightError extends Error {
  constructor(readonly check: FailedCheck) {
    super(`Preflight check "${check.check}" failed: ${check.reason}`);
    this.name = 'PreflightError';
  }
}

// ── Workflow factory ─────────────────────────────────────────────────────

/**
 * Create the INSTALL workflow.
 *
 * Returns a DurableWorkflow that can be executed by the DurableRuntime.
 * The deps (emitter, deploymentStore) are captured at creation time so
 * the workflow generator itself is a pure function of its input.
 */
export function createInstallWorkflow(
  deps: InstallWorkflowDeps,
): DurableWorkflow<InstallInput, InstallOutput> {
  const preflightDeps = resolvePreflightDeps(deps.preflight);

  return async function* installWorkflow(
    input: InstallInput,
  ): AsyncGenerator<WorkflowStep, InstallOutput, unknown> {
    const actor = actorFromInitiator(input.initiatedBy);
    const baseEvent = {
      organizationId: input.organizationId,
      customerId: input.customerId,
      deploymentId: input.deploymentId,
      jobId: input.jobId,
      releaseId: input.releaseId,
    };

    // ── Step 1: Validate region ──────────────────────────────────────
    yield step('validate-region', async () => {
      const result = await runPreflight(input.region);
      const regionCheck = result.checks[0];
      if (!regionCheck) throw new Error('Missing region check result');

      await deps.emitter.emit(actor, {
        ...baseEvent,
        eventType: 'install.preflight.region',
        previousState: 'NOT_INSTALLED',
        requestedState: 'NOT_INSTALLED',
        result: regionCheck.passed ? 'passed' : `failed:${regionCheck.failureCode}`,
        payload: { region: input.region, check: regionCheck },
      });

      if (!regionCheck.passed) {
        throw new PreflightError(regionCheck);
      }
      return regionCheck;
    });

    // ── Step 2: Check SCP blocks ─────────────────────────────────────
    yield step('check-scp', async () => {
      const result = await runPreflight(input.region);
      const scpCheck = result.checks[1];
      if (!scpCheck) throw new Error('Missing SCP check result');

      await deps.emitter.emit(actor, {
        ...baseEvent,
        eventType: 'install.preflight.scp',
        previousState: 'NOT_INSTALLED',
        requestedState: 'NOT_INSTALLED',
        result: scpCheck.passed ? 'passed' : `failed:${scpCheck.failureCode}`,
        payload: { installationId: input.installationId, check: scpCheck },
      });

      if (!scpCheck.passed) {
        throw new PreflightError(scpCheck);
      }
      return scpCheck;
    });

    // ── Step 3: Full §30 preflight ────────────────────────────────────
    // Gates ANY application-stack provisioning: port/health-endpoint/
    // secrets/migration/env-vars/quota/image-health/AWS-usability/
    // permission (preflight-engine.ts checks 3-6, 8-17). The relay hasn't
    // made first contact yet at this point, so check 7 is skipped here —
    // it's enforced separately, at the right time, in `mark-installing`.
    yield step('full-preflight', async () => {
      const result = await runFullPreflight(
        {
          region: input.region,
          installationId: input.installationId,
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

      await deps.emitter.emit(actor, {
        ...baseEvent,
        eventType: 'install.preflight.full',
        previousState: 'NOT_INSTALLED',
        requestedState: 'NOT_INSTALLED',
        result: result.passed ? 'passed' : `failed:${result.failureCode ?? 'UNKNOWN'}`,
        payload: { checks: result.checks },
      });

      const failedCheck = result.failures[0];
      if (failedCheck) {
        throw new PreflightError(failedCheck);
      }
      return { passed: true };
    });

    // ── Step 4: Wait for relay first contact ─────────────────────────
    // The relay's first contact is the external callback that proves the
    // bootstrap stack reached CREATE_COMPLETE. The callback token is the
    // installation ID — the control plane binds install ID ↔ credential
    // on the relay's first poll (todo 12).
    const relayContact = yield waitForCallback(
      `install:${input.installationId}:relay-contact`,
    );

    // ── Step 5: Mark as Installing ───────────────────────────────────
    yield step('mark-installing', async () => {
      // Validate the relay contact payload
      const contactCheck = assertRelayContact(
        relayContact,
        input.installationId,
      );

      await deps.emitter.emit(actor, {
        ...baseEvent,
        eventType: 'install.relay.contact',
        previousState: 'NOT_INSTALLED',
        requestedState: 'INSTALLING',
        result: contactCheck.passed ? 'ok' : `failed:${contactCheck.failureCode}`,
        payload: { contact: relayContact, check: contactCheck },
      });

      if (!contactCheck.passed) {
        throw new PreflightError(contactCheck);
      }

      // Transition deployment state: NOT_INSTALLED → INSTALLING
      await deps.deploymentStore.set(input.deploymentId, 'INSTALLING');

      await deps.emitter.emit(actor, {
        ...baseEvent,
        eventType: 'install.state.installing',
        previousState: 'NOT_INSTALLED',
        requestedState: 'INSTALLING',
        result: 'ok',
        payload: { installationId: input.installationId },
      });

      return { state: 'INSTALLING' };
    });

    // ── Step 6: Wait for relay health report ─────────────────────────
    // The relay reports health on every poll (todo 12). The first health
    // report after the application stack is deployed proves the app is
    // running and healthy.
    const healthReport = yield waitForCallback(
      `install:${input.installationId}:health-report`,
    );

    // ── Step 7: Mark as Healthy ──────────────────────────────────────
    yield step('mark-healthy', async () => {
      // Validate the health report payload
      const healthCheck = assertHealthReport(
        healthReport,
        input.installationId,
      );

      await deps.emitter.emit(actor, {
        ...baseEvent,
        eventType: 'install.relay.health',
        previousState: 'INSTALLING',
        requestedState: 'HEALTHY',
        result: healthCheck.passed ? 'ok' : `failed:${healthCheck.failureCode}`,
        payload: { report: healthReport, check: healthCheck },
      });

      if (!healthCheck.passed) {
        throw new PreflightError(healthCheck);
      }

      // Transition deployment state: INSTALLING → HEALTHY
      await deps.deploymentStore.set(input.deploymentId, 'HEALTHY');

      // §38: the first successful install seeds `currentReleaseId` — there is
      // no "previous" release yet (a rollback has nothing to target until a
      // DEPLOY_RELEASE or ROLLBACK moves the pointers forward).
      if (input.releaseId) {
        await deps.deploymentStore.setReleasePointers(input.deploymentId, {
          currentReleaseId: input.releaseId,
          previousReleaseId: null,
        });
      }

      await deps.emitter.emit(actor, {
        ...baseEvent,
        eventType: 'install.state.healthy',
        previousState: 'INSTALLING',
        requestedState: 'HEALTHY',
        result: 'ok',
        payload: { installationId: input.installationId },
      });

      return { state: 'HEALTHY' };
    });

    return {
      status: 'HEALTHY',
      deploymentId: input.deploymentId,
    };
  };
}

// ── In-memory deployment state store (for tests) ─────────────────────────

export class InMemoryDeploymentStateStore implements DeploymentStateStore {
  private readonly store = new Map<string, string>();
  private readonly releasePointers = new Map<string, ReleasePointers>();

  async get(deploymentId: string): Promise<string> {
    return this.store.get(deploymentId) ?? 'NOT_INSTALLED';
  }

  async set(deploymentId: string, state: string): Promise<void> {
    this.store.set(deploymentId, state);
  }

  async getReleasePointers(deploymentId: string): Promise<ReleasePointers> {
    return (
      this.releasePointers.get(deploymentId) ?? {
        currentReleaseId: null,
        previousReleaseId: null,
      }
    );
  }

  async setReleasePointers(deploymentId: string, pointers: ReleasePointers): Promise<void> {
    this.releasePointers.set(deploymentId, pointers);
  }
}