/**
 * DESTROY workflow — the durable function that tears down a customer deployment.
 *
 * §63: the workflow distinguishes app resources / database / backups / S3 /
 * metadata — each is a separate step with its own §62 event. §64: the
 * final-snapshot option on RDS delete is an INPUT (vendor chooses), honored
 * by the workflow. §48: billing cessation is coupled to destroy — when the
 * deployment is deleted, metered usage reporting stops. Only deplayz:-tagged
 * resources are removed (IAM enforcement in the bootstrap stack backs this up).
 *
 * State machine:
 *   (any state) → (confirmation) → DELETING
 *     → (destroy app resources) → (destroy DB) → (destroy S3)
 *     → (revoke ECR pull grant) → (stop billing) → (mark DELETED)
 *
 * Degraded path: when the deployment is already DISCONNECTED (the relay is
 * unreachable), the workflow skips customer-account resource destruction
 * (app/DB/S3 — the control plane cannot reach the customer account) and
 * performs only ECR revoke + billing stop + metadata cleanup. A disclosure
 * event is emitted stating that customer-side resources must be removed
 * manually or via re-connect + retry.
 *
 * Customer-confirmation rule: the workflow suspends on a
 * `waitForCallback('destroy:confirm')` step — a destructive action requires
 * explicit vendor confirmation before any resources are touched.
 *
 * Metadata cleanup: the deployment row is marked DELETED (never physically
 * removed — FK constraints from event_logs require it to persist).
 *
 * Every step emits a §62-complete event via the injectable EventEmitter.
 */

import {
  step,
  waitForCallback,
  type DurableWorkflow,
  type WorkflowStep,
} from '../durable/durable-runtime.js';

import { actorFromInitiator, type EventEmitter, type WorkflowInitiator } from './event-emitter.js';

import {
  type DeploymentStateStore,
} from './install-workflow.js';

// ── Types ────────────────────────────────────────────────────────────────

/** Input to the DESTROY workflow. */
export interface DestroyInput {
  readonly deploymentId: string;
  readonly customerId: string;
  readonly organizationId: string;
  readonly jobId: string;
  readonly installationId: string;
  /** §64: take a final snapshot of the RDS instance before deleting it. */
  readonly finalSnapshot: boolean;
  /** §62 audit actor — who/what initiated this workflow. Defaults to system. */
  readonly initiatedBy?: WorkflowInitiator | undefined;
}

/** Output from the DESTROY workflow. */
export interface DestroyOutput {
  readonly status: 'DELETED';
  readonly deploymentId: string;
  /** True when customer-account resources were NOT destroyed (degraded path). */
  readonly degraded: boolean;
}

// ── Seam result types ────────────────────────────────────────────────────

/** Result of destroying app resources (CFN stack / ECS service). */
export type ResourceDestroyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/** Result of destroying the RDS database instance. */
export type DatabaseDestroyResult =
  | { readonly ok: true; readonly snapshotTaken: boolean }
  | { readonly ok: false; readonly reason: string };

/** Result of destroying the S3 bucket. */
export type StorageDestroyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/** Result of revoking the ECR cross-account pull grant. */
export type EcrRevokeResult =
  | { readonly ok: true; readonly removed: boolean }
  | { readonly ok: false; readonly reason: string };

/** Result of stopping billing for the deployment. */
export type BillingStopResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

// ── Seam interfaces ──────────────────────────────────────────────────────

/** Destroys app resources (CloudFormation stack, ECS service). */
export interface ResourceDestroyer {
  destroyResources(deploymentId: string, installationId: string): Promise<ResourceDestroyResult>;
}

/** Destroys the RDS database, honoring the §64 final-snapshot option. */
export interface DatabaseDestroyer {
  destroyDatabase(
    deploymentId: string,
    options: { readonly takeFinalSnapshot: boolean },
  ): Promise<DatabaseDestroyResult>;
}

/** Destroys the S3 bucket. */
export interface StorageDestroyer {
  destroyStorage(deploymentId: string): Promise<StorageDestroyResult>;
}

/** Revokes the ECR cross-account pull grant for an installation. */
export interface EcrGrantRevoker {
  revoke(installationId: string): Promise<EcrRevokeResult>;
}

/** Stops billing (metered usage reporting) for a deployment. */
export interface BillingStopper {
  stop(deploymentId: string): Promise<BillingStopResult>;
}

/** Dependencies injected into the workflow factory. */
export interface DestroyWorkflowDeps {
  readonly emitter: EventEmitter;
  readonly deploymentStore: DeploymentStateStore;
  readonly resourceDestroyer: ResourceDestroyer;
  readonly databaseDestroyer: DatabaseDestroyer;
  readonly storageDestroyer: StorageDestroyer;
  readonly ecrGrantRevoker: EcrGrantRevoker;
  readonly billingStopper: BillingStopper;
}

// ── Copy ─────────────────────────────────────────────────────────────────

export const DESTROY_COPY = {
  confirmation:
    'This action will permanently remove all deployment resources. It cannot be undone.',
  degradedRelayDisconnected:
    'The helper is unreachable. Customer-side resources could not be removed automatically. They must be removed manually or by reconnecting and retrying.',
} as const;

// ── Workflow factory ─────────────────────────────────────────────────────

export function createDestroyWorkflow(
  deps: DestroyWorkflowDeps,
): DurableWorkflow<DestroyInput, DestroyOutput> {
  return async function* destroyWorkflow(
    input: DestroyInput,
  ): AsyncGenerator<WorkflowStep, DestroyOutput, unknown> {
    const actor = actorFromInitiator(input.initiatedBy);
    const baseEvent = {
      organizationId: input.organizationId,
      customerId: input.customerId,
      deploymentId: input.deploymentId,
      jobId: input.jobId,
    };

    // ── Step 1: Wait for vendor confirmation ──────────────────────────
    // Destructive actions require explicit confirmation (§63).
    yield waitForCallback(`destroy:${input.deploymentId}:confirm`);

    // ── Step 2: Mark DELETING ─────────────────────────────────────────
    // Read the deployment's current state BEFORE transitioning so the
    // transition event captures it. If the deployment is already
    // DISCONNECTED, the degraded path skips customer-account destruction.
    const priorState = (yield step('mark-deleting', async () => {
      const current = await deps.deploymentStore.get(input.deploymentId);

      await deps.emitter.emit(actor, {
        ...baseEvent,
        eventType: 'destroy.confirmation',
        previousState: current,
        requestedState: 'DELETING',
        result: 'ok',
        payload: {
          disclosure: DESTROY_COPY.confirmation,
          finalSnapshot: input.finalSnapshot,
        },
      });

      await deps.deploymentStore.set(input.deploymentId, 'DELETING');

      await deps.emitter.emit(actor, {
        ...baseEvent,
        eventType: 'destroy.state.deleting',
        previousState: current,
        requestedState: 'DELETING',
        result: 'ok',
        payload: { installationId: input.installationId },
      });

      return { state: current };
    })) as { state: string };

    // ── Degraded-paths
    const isDegraded = priorState.state === 'DISCONNECTED';

    // ── Step 3: Destroy app resources ──────────────────────────────────
    if (isDegraded) {
      yield step('destroy-resources', async () => {
        await deps.emitter.emit(actor, {
          ...baseEvent,
          eventType: 'destroy.degraded.resources',
          previousState: 'DELETING',
          requestedState: 'DELETING',
          result: 'skipped',
          payload: { reason: DESTROY_COPY.degradedRelayDisconnected },
        });
        return { skipped: true, degraded: true };
      });
    } else {
      yield step('destroy-resources', async () => {
        const result = await deps.resourceDestroyer.destroyResources(
          input.deploymentId,
          input.installationId,
        );

        await deps.emitter.emit(actor, {
          ...baseEvent,
          eventType: 'destroy.resources',
          previousState: 'DELETING',
          requestedState: 'DELETING',
          result: result.ok ? 'ok' : `failed`,
          payload: {},
        });

        if (!result.ok) {
          throw new DestroyError('Resource destruction failed', result.reason);
        }
        return { destroyed: true };
      });
    }

    // ── Step 4: Destroy database ───────────────────────────────────────
    if (isDegraded) {
      yield step('destroy-database', async () => {
        await deps.emitter.emit(actor, {
          ...baseEvent,
          eventType: 'destroy.degraded.database',
          previousState: 'DELETING',
          requestedState: 'DELETING',
          result: 'skipped',
          payload: { reason: DESTROY_COPY.degradedRelayDisconnected },
        });
        return { skipped: true, degraded: true };
      });
    } else {
      yield step('destroy-database', async () => {
        const result = await deps.databaseDestroyer.destroyDatabase(
          input.deploymentId,
          { takeFinalSnapshot: input.finalSnapshot },
        );

        await deps.emitter.emit(actor, {
          ...baseEvent,
          eventType: 'destroy.database',
          previousState: 'DELETING',
          requestedState: 'DELETING',
          result: result.ok ? 'ok' : `failed`,
          payload: {
            finalSnapshot: input.finalSnapshot,
            snapshotTaken: result.ok ? result.snapshotTaken : false,
          },
        });

        if (!result.ok) {
          throw new DestroyError('Database destruction failed', result.reason);
        }
        return { destroyed: true, snapshotTaken: result.snapshotTaken };
      });
    }

    // ── Step 5: Destroy S3 storage ─────────────────────────────────────
    if (isDegraded) {
      yield step('destroy-storage', async () => {
        await deps.emitter.emit(actor, {
          ...baseEvent,
          eventType: 'destroy.degraded.storage',
          previousState: 'DELETING',
          requestedState: 'DELETING',
          result: 'skipped',
          payload: { reason: DESTROY_COPY.degradedRelayDisconnected },
        });
        return { skipped: true, degraded: true };
      });
    } else {
      yield step('destroy-storage', async () => {
        const result = await deps.storageDestroyer.destroyStorage(
          input.deploymentId,
        );

        await deps.emitter.emit(actor, {
          ...baseEvent,
          eventType: 'destroy.storage',
          previousState: 'DELETING',
          requestedState: 'DELETING',
          result: result.ok ? 'ok' : `failed`,
          payload: {},
        });

        if (!result.ok) {
          throw new DestroyError('Storage destruction failed', result.reason);
        }
        return { destroyed: true };
      });
    }

    // ── Step 6: Revoke ECR pull grant ──────────────────────────────────
    // The ECR grant is revoked even on the degraded path — the control
    // plane owns the ECR repo and can always revoke its own policy.
    yield step('destroy-ecr-grant', async () => {
      const result = await deps.ecrGrantRevoker.revoke(input.installationId);

      await deps.emitter.emit(actor, {
        ...baseEvent,
        eventType: 'destroy.ecr-grant',
        previousState: 'DELETING',
        requestedState: 'DELETING',
        result: result.ok ? 'ok' : `failed`,
        payload: { removed: result.ok ? result.removed : false },
      });

      if (!result.ok) {
        throw new DestroyError('ECR grant revocation failed', result.reason);
      }
      return { revoked: result.removed };
    });

    // ── Step 7: Stop billing (§48) ─────────────────────────────────────
    // Billing cessation runs even on the degraded path — this deployment
    // is gone whether or not we could reach the customer account.
    yield step('destroy-billing', async () => {
      const result = await deps.billingStopper.stop(input.deploymentId);

      await deps.emitter.emit(actor, {
        ...baseEvent,
        eventType: 'destroy.billing',
        previousState: 'DELETING',
        requestedState: 'DELETED',
        result: result.ok ? 'ok' : `failed`,
        payload: {},
      });

      if (!result.ok) {
        throw new DestroyError('Billing cessation failed', result.reason);
      }
      return { stopped: true };
    });

    // ── Step 8: Metadata cleanup ───────────────────────────────────────
    // Mark DELETED — never physically remove (FK constraints from event_logs).
    yield step('destroy-metadata', async () => {
      await deps.deploymentStore.set(input.deploymentId, 'DELETED');

      await deps.emitter.emit(actor, {
        ...baseEvent,
        eventType: 'destroy.metadata',
        previousState: 'DELETING',
        requestedState: 'DELETED',
        result: 'ok',
        payload: { installationId: input.installationId },
      });
      return { state: 'DELETED' };
    });

    // ── Completion ────────────────────────────────────────────────────
    yield step('destroy-complete', async () => {
      const suffix = isDegraded ? '.degraded' : '';
      await deps.emitter.emit(actor, {
        ...baseEvent,
        eventType: `destroy.complete${suffix}`,
        previousState: 'DELETING',
        requestedState: 'DELETED',
        result: 'ok',
        payload: {
          installationId: input.installationId,
          degraded: isDegraded,
        },
      });
      return { completed: true, degraded: isDegraded };
    });

    return {
      status: 'DELETED',
      deploymentId: input.deploymentId,
      degraded: isDegraded,
    };
  };
}

// ── Error ────────────────────────────────────────────────────────────────

export class DestroyError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(`${message}: ${reason}`);
    this.name = 'DestroyError';
  }
}