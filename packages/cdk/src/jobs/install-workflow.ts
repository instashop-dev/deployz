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
  assertRelayContact,
  runPreflight,
  type PreflightCheck,
} from './preflight.js';

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
}

/** Output from the INSTALL workflow. */
export interface InstallOutput {
  readonly status: 'HEALTHY';
  readonly deploymentId: string;
}

/** Injectable deployment state store — transitions deployment.state. */
export interface DeploymentStateStore {
  get(deploymentId: string): Promise<string>;
  set(deploymentId: string, state: string): Promise<void>;
}

/** Dependencies injected into the workflow factory. */
export interface InstallWorkflowDeps {
  readonly emitter: EventEmitter;
  readonly deploymentStore: DeploymentStateStore;
}

// ── Error ────────────────────────────────────────────────────────────────

/** Thrown when a preflight check fails, halting the workflow. */
export class PreflightError extends Error {
  constructor(readonly check: PreflightCheck & { passed: false }) {
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
  return async function* installWorkflow(
    input: InstallInput,
  ): AsyncGenerator<WorkflowStep, InstallOutput, unknown> {
    const actor: EventActor = { type: 'system' };
    const baseEvent = {
      organizationId: input.organizationId,
      customerId: input.customerId,
      deploymentId: input.deploymentId,
      jobId: input.jobId,
      releaseId: input.releaseId,
    };

    // ── Step 1: Validate region ──────────────────────────────────────
    yield step('validate-region', async () => {
      const result = runPreflight(input.region);
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
      const result = runPreflight(input.region);
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

    // ── Step 3: Wait for relay first contact ─────────────────────────
    // The relay's first contact is the external callback that proves the
    // bootstrap stack reached CREATE_COMPLETE. The callback token is the
    // installation ID — the control plane binds install ID ↔ credential
    // on the relay's first poll (todo 12).
    const relayContact = yield waitForCallback(
      `install:${input.installationId}:relay-contact`,
    );

    // ── Step 4: Mark as Installing ───────────────────────────────────
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

    // ── Step 5: Wait for relay health report ─────────────────────────
    // The relay reports health on every poll (todo 12). The first health
    // report after the application stack is deployed proves the app is
    // running and healthy.
    const healthReport = yield waitForCallback(
      `install:${input.installationId}:health-report`,
    );

    // ── Step 6: Mark as Healthy ──────────────────────────────────────
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

  async get(deploymentId: string): Promise<string> {
    return this.store.get(deploymentId) ?? 'NOT_INSTALLED';
  }

  async set(deploymentId: string, state: string): Promise<void> {
    this.store.set(deploymentId, state);
  }
}