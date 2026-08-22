import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  DurableRuntime,
  InMemoryStateStore,
  type DurableWorkflow,
} from '../src/durable/durable-runtime.js';

import {
  EventEmitter,
  InMemoryEventStore,
} from '../src/jobs/event-emitter.js';

import {
  InMemoryDeploymentStateStore,
} from '../src/jobs/install-workflow.js';

import {
  createDestroyWorkflow,
  DestroyError,
  DESTROY_COPY,
  type DestroyInput,
  type DestroyOutput,
  type ResourceDestroyResult,
  type DatabaseDestroyResult,
  type StorageDestroyResult,
  type EcrRevokeResult,
  type BillingStopResult,
} from '../src/jobs/destroy-workflow.js';

// ── Fixtures ─────────────────────────────────────────────────────────────

const FIXED_NOW = new Date('2026-08-20T00:00:00.000Z');

function makeInput(overrides: Partial<DestroyInput> = {}): DestroyInput {
  return {
    deploymentId: 'deployment-1',
    customerId: 'customer-1',
    organizationId: 'org-1',
    jobId: 'job-1',
    installationId: 'install-1',
    finalSnapshot: true,
    ...overrides,
  };
}

interface WorkflowHarness {
  workflow: DurableWorkflow<DestroyInput, DestroyOutput>;
  runtime: DurableRuntime;
  eventStore: InMemoryEventStore;
  deploymentStore: InMemoryDeploymentStateStore;
  resourceDestroyer: Mock<() => Promise<ResourceDestroyResult>>;
  databaseDestroyer: Mock<() => Promise<DatabaseDestroyResult>>;
  storageDestroyer: Mock<() => Promise<StorageDestroyResult>>;
  ecrGrantRevoker: Mock<() => Promise<EcrRevokeResult>>;
  billingStopper: Mock<() => Promise<BillingStopResult>>;
}

function makeHarness(config: {
  resourceResult?: ResourceDestroyResult;
  databaseResult?: DatabaseDestroyResult;
  storageResult?: StorageDestroyResult;
  ecrResult?: EcrRevokeResult;
  billingResult?: BillingStopResult;
} = {}): WorkflowHarness {
  const eventStore = new InMemoryEventStore();
  const emitter = new EventEmitter(eventStore, () => FIXED_NOW);
  const deploymentStore = new InMemoryDeploymentStateStore();

  const resourceDestroyer = vi
    .fn<() => Promise<ResourceDestroyResult>>()
    .mockResolvedValue(config.resourceResult ?? { ok: true });

  const databaseDestroyer = vi
    .fn<() => Promise<DatabaseDestroyResult>>()
    .mockResolvedValue(config.databaseResult ?? { ok: true, snapshotTaken: true });

  const storageDestroyer = vi
    .fn<() => Promise<StorageDestroyResult>>()
    .mockResolvedValue(config.storageResult ?? { ok: true });

  const ecrGrantRevoker = vi
    .fn<() => Promise<EcrRevokeResult>>()
    .mockResolvedValue(config.ecrResult ?? { ok: true, removed: true });

  const billingStopper = vi
    .fn<() => Promise<BillingStopResult>>()
    .mockResolvedValue(config.billingResult ?? { ok: true });

  const workflow = createDestroyWorkflow({
    emitter,
    deploymentStore,
    resourceDestroyer: { destroyResources: resourceDestroyer },
    databaseDestroyer: { destroyDatabase: databaseDestroyer },
    storageDestroyer: { destroyStorage: storageDestroyer },
    ecrGrantRevoker: { revoke: ecrGrantRevoker },
    billingStopper: { stop: billingStopper },
  });
  const runtime = new DurableRuntime(new InMemoryStateStore());

  return {
    workflow,
    runtime,
    eventStore,
    deploymentStore,
    resourceDestroyer,
    databaseDestroyer,
    storageDestroyer,
    ecrGrantRevoker,
    billingStopper,
  };
}

/** Seed the deployment in HEALTHY — the most common pre-destroy state. */
async function seedHealthy(deploymentStore: InMemoryDeploymentStateStore): Promise<void> {
  await deploymentStore.set('deployment-1', 'HEALTHY');
}

async function seedDisconnected(deploymentStore: InMemoryDeploymentStateStore): Promise<void> {
  await deploymentStore.set('deployment-1', 'DISCONNECTED');
}

/** Start the workflow up to the confirmation callback, then resume with the vendor confirming. */
async function runToConfirmationThenResume(
  harness: WorkflowHarness,
  input: DestroyInput,
  executionId: string,
) {
  // Start → suspends on destroy:confirm callback.
  const suspended = await harness.runtime.start(harness.workflow, input, executionId);
  expect(suspended.status).toBe('WAITING_CALLBACK');
  expect(suspended.callbackToken).toBe(`destroy:${input.deploymentId}:confirm`);

  // Vendor confirms → resume.
  return harness.runtime.resume(harness.workflow, executionId, { confirmed: true });
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('DESTROY workflow — happy path', () => {
  let harness: WorkflowHarness;

  beforeEach(() => {
    harness = makeHarness();
  });

  it('suspends on confirmation callback before any destruction', async () => {
    await seedHealthy(harness.deploymentStore);

    const suspended = await harness.runtime.start(harness.workflow, makeInput(), 'exec-1');

    expect(suspended.status).toBe('WAITING_CALLBACK');
    expect(suspended.callbackToken).toBe('destroy:deployment-1:confirm');

    // No destructors have been called yet.
    expect(harness.resourceDestroyer).not.toHaveBeenCalled();
    expect(harness.databaseDestroyer).not.toHaveBeenCalled();
    expect(harness.storageDestroyer).not.toHaveBeenCalled();
    expect(harness.ecrGrantRevoker).not.toHaveBeenCalled();
    expect(harness.billingStopper).not.toHaveBeenCalled();
  });

  it('completes the full happy path end-to-end (HEALTHY → DELETED)', async () => {
    await seedHealthy(harness.deploymentStore);

    const completed = await runToConfirmationThenResume(harness, makeInput(), 'exec-2');

    expect(completed.status).toBe('COMPLETED');
    expect(completed.output).toEqual({
      status: 'DELETED',
      deploymentId: 'deployment-1',
      degraded: false,
    });

    // Step history names in order.
    expect(completed.history.map((h) => h.name)).toEqual([
      'mark-deleting',
      'destroy-resources',
      'destroy-database',
      'destroy-storage',
      'destroy-ecr-grant',
      'destroy-billing',
      'destroy-metadata',
      'destroy-complete',
    ]);

    // Deployment landed at DELETED.
    expect(await harness.deploymentStore.get('deployment-1')).toBe('DELETED');
  });

  it('emits every §62 event in order (happy path)', async () => {
    await seedHealthy(harness.deploymentStore);

    await runToConfirmationThenResume(harness, makeInput(), 'exec-3');

    expect(harness.eventStore.events.map((e) => e.eventType)).toEqual([
      'destroy.confirmation',
      'destroy.state.deleting',
      'destroy.resources',
      'destroy.database',
      'destroy.storage',
      'destroy.ecr-grant',
      'destroy.billing',
      'destroy.metadata',
      'destroy.complete',
    ]);
  });

  it('marks DELETING in the transition event with the prior HEALTHY state', async () => {
    await seedHealthy(harness.deploymentStore);

    await runToConfirmationThenResume(harness, makeInput(), 'exec-4');

    const confirmation = harness.eventStore.events.find(
      (e) => e.eventType === 'destroy.confirmation',
    );
    expect(confirmation?.previousState).toBe('HEALTHY');
    expect(confirmation?.requestedState).toBe('DELETING');

    const deleting = harness.eventStore.events.find(
      (e) => e.eventType === 'destroy.state.deleting',
    );
    expect(deleting?.previousState).toBe('HEALTHY');
    expect(deleting?.requestedState).toBe('DELETING');
  });

  it('calls resource, database, storage, ECR, and billing destroyers exactly once each', async () => {
    await seedHealthy(harness.deploymentStore);

    await runToConfirmationThenResume(harness, makeInput(), 'exec-5');

    expect(harness.resourceDestroyer).toHaveBeenCalledTimes(1);
    expect(harness.resourceDestroyer).toHaveBeenCalledWith('deployment-1', 'install-1');

    expect(harness.databaseDestroyer).toHaveBeenCalledTimes(1);
    expect(harness.databaseDestroyer).toHaveBeenCalledWith('deployment-1', {
      takeFinalSnapshot: true,
    });

    expect(harness.storageDestroyer).toHaveBeenCalledTimes(1);
    expect(harness.storageDestroyer).toHaveBeenCalledWith('deployment-1');

    expect(harness.ecrGrantRevoker).toHaveBeenCalledTimes(1);
    expect(harness.ecrGrantRevoker).toHaveBeenCalledWith('install-1');

    expect(harness.billingStopper).toHaveBeenCalledTimes(1);
    expect(harness.billingStopper).toHaveBeenCalledWith('deployment-1');
  });
});

// ── §64 final-snapshot option ────────────────────────────────────────────

describe('DESTROY workflow — §64 final-snapshot option', () => {
  it('passes takeFinalSnapshot: true when input.finalSnapshot is true', async () => {
    const harness = makeHarness();
    await seedHealthy(harness.deploymentStore);

    await runToConfirmationThenResume(harness, makeInput({ finalSnapshot: true }), 'exec-snap-1');

    expect(harness.databaseDestroyer).toHaveBeenCalledWith('deployment-1', {
      takeFinalSnapshot: true,
    });

    const dbEvent = harness.eventStore.events.find(
      (e) => e.eventType === 'destroy.database',
    );
    expect(dbEvent?.payload.finalSnapshot).toBe(true);
    expect(dbEvent?.payload.snapshotTaken).toBe(true);
  });

  it('passes takeFinalSnapshot: false when input.finalSnapshot is false', async () => {
    const harness = makeHarness({
      databaseResult: { ok: true, snapshotTaken: false },
    });
    await seedHealthy(harness.deploymentStore);

    await runToConfirmationThenResume(harness, makeInput({ finalSnapshot: false }), 'exec-snap-2');

    expect(harness.databaseDestroyer).toHaveBeenCalledWith('deployment-1', {
      takeFinalSnapshot: false,
    });

    const dbEvent = harness.eventStore.events.find(
      (e) => e.eventType === 'destroy.database',
    );
    expect(dbEvent?.payload.finalSnapshot).toBe(false);
    expect(dbEvent?.payload.snapshotTaken).toBe(false);
  });
});

// ── Degraded path: DISCONNECTED → metadata + billing only ────────────────

describe('DESTROY workflow — degraded path (DISCONNECTED)', () => {
  it('skips all customer-account resource destruction when DISCONNECTED', async () => {
    const harness = makeHarness();
    await seedDisconnected(harness.deploymentStore);

    const completed = await runToConfirmationThenResume(harness, makeInput(), 'exec-deg-1');

    expect(completed.output).toEqual({
      status: 'DELETED',
      deploymentId: 'deployment-1',
      degraded: true,
    });

    // Resource/database/storage destroyers are NEVER called on the degraded path.
    expect(harness.resourceDestroyer).not.toHaveBeenCalled();
    expect(harness.databaseDestroyer).not.toHaveBeenCalled();
    expect(harness.storageDestroyer).not.toHaveBeenCalled();

    // ECR grant + billing + metadata cleanup still run.
    expect(harness.ecrGrantRevoker).toHaveBeenCalledTimes(1);
    expect(harness.billingStopper).toHaveBeenCalledTimes(1);
    expect(await harness.deploymentStore.get('deployment-1')).toBe('DELETED');
  });

  it('emits degraded skip events for resources, database, and storage', async () => {
    const harness = makeHarness();
    await seedDisconnected(harness.deploymentStore);

    await runToConfirmationThenResume(harness, makeInput(), 'exec-deg-2');

    const degradedEvents = harness.eventStore.events.filter((e) =>
      e.eventType.startsWith('destroy.degraded.'),
    );
    expect(degradedEvents.map((e) => e.eventType)).toEqual([
      'destroy.degraded.resources',
      'destroy.degraded.database',
      'destroy.degraded.storage',
    ]);

    for (const event of degradedEvents) {
      expect(event.result).toBe('skipped');
      expect(event.payload.reason).toBe(DESTROY_COPY.degradedRelayDisconnected);
    }
  });

  it('emits destroy.complete.degraded (not the normal complete event)', async () => {
    const harness = makeHarness();
    await seedDisconnected(harness.deploymentStore);

    await runToConfirmationThenResume(harness, makeInput(), 'exec-deg-3');

    const complete = harness.eventStore.events.find((e) =>
      e.eventType.startsWith('destroy.complete'),
    );
    expect(complete?.eventType).toBe('destroy.complete.degraded');

    // No normal complete event is emitted.
    expect(
      harness.eventStore.events.some((e) => e.eventType === 'destroy.complete'),
    ).toBe(false);
  });

  it('sets the DISCONNECTED prior state in the confirmation event', async () => {
    const harness = makeHarness();
    await seedDisconnected(harness.deploymentStore);

    await runToConfirmationThenResume(harness, makeInput(), 'exec-deg-4');

    const confirmation = harness.eventStore.events.find(
      (e) => e.eventType === 'destroy.confirmation',
    );
    expect(confirmation?.previousState).toBe('DISCONNECTED');
    expect(confirmation?.payload.degraded).toBeUndefined();
  });
});

// ── §63 distinctions — each step is separate ─────────────────────────────

describe('DESTROY workflow — §63 distinctions', () => {
  it('distinguishes app resource, database, storage, ECR, billing, and metadata as separate steps', async () => {
    const harness = makeHarness();
    await seedHealthy(harness.deploymentStore);

    await runToConfirmationThenResume(harness, makeInput(), 'exec-63-1');

    const stepNames = harness.eventStore.events
      .filter((e) => e.eventType.startsWith('destroy.') && e.eventType !== 'destroy.state.deleting')
      .map((e) => e.eventType);

    expect(stepNames).toEqual([
      'destroy.confirmation',
      'destroy.resources',
      'destroy.database',
      'destroy.storage',
      'destroy.ecr-grant',
      'destroy.billing',
      'destroy.metadata',
      'destroy.complete',
    ]);
  });

  it('discloses the destructive action in the confirmation event payload', async () => {
    const harness = makeHarness();
    await seedHealthy(harness.deploymentStore);

    await runToConfirmationThenResume(harness, makeInput(), 'exec-63-2');

    const confirmation = harness.eventStore.events.find(
      (e) => e.eventType === 'destroy.confirmation',
    );
    expect(confirmation?.payload.disclosure).toBe(DESTROY_COPY.confirmation);
    expect(confirmation?.payload.disclosure).toContain('permanently remove');
  });
});

// ── ECR pull grant revocation ────────────────────────────────────────────

describe('DESTROY workflow — ECR pull grant revocation', () => {
  it('revokes the ECR pull grant even on the degraded path', async () => {
    const harness = makeHarness();
    await seedDisconnected(harness.deploymentStore);

    await runToConfirmationThenResume(harness, makeInput(), 'exec-ecr-1');

    expect(harness.ecrGrantRevoker).toHaveBeenCalledTimes(1);
    expect(harness.ecrGrantRevoker).toHaveBeenCalledWith('install-1');
  });

  it('records removal in the event payload', async () => {
    const harness = makeHarness({ ecrResult: { ok: true, removed: true } });
    await seedHealthy(harness.deploymentStore);

    await runToConfirmationThenResume(harness, makeInput(), 'exec-ecr-2');

    const ecrEvent = harness.eventStore.events.find(
      (e) => e.eventType === 'destroy.ecr-grant',
    );
    expect(ecrEvent?.payload.removed).toBe(true);
  });

  it('records idempotent no-op in the event payload', async () => {
    const harness = makeHarness({ ecrResult: { ok: true, removed: false } });
    await seedHealthy(harness.deploymentStore);

    await runToConfirmationThenResume(harness, makeInput(), 'exec-ecr-3');

    const ecrEvent = harness.eventStore.events.find(
      (e) => e.eventType === 'destroy.ecr-grant',
    );
    expect(ecrEvent?.payload.removed).toBe(false);
  });
});

// ── §48 billing cessation ────────────────────────────────────────────────

describe('DESTROY workflow — §48 billing cessation', () => {
  it('stops billing even on the degraded path', async () => {
    const harness = makeHarness();
    await seedDisconnected(harness.deploymentStore);

    await runToConfirmationThenResume(harness, makeInput(), 'exec-bill-1');

    expect(harness.billingStopper).toHaveBeenCalledTimes(1);
    expect(harness.billingStopper).toHaveBeenCalledWith('deployment-1');
  });

  it('stops billing on the happy path', async () => {
    const harness = makeHarness();
    await seedHealthy(harness.deploymentStore);

    await runToConfirmationThenResume(harness, makeInput(), 'exec-bill-2');

    expect(harness.billingStopper).toHaveBeenCalledTimes(1);
  });

  it('emits a billing event with result ok', async () => {
    const harness = makeHarness();
    await seedHealthy(harness.deploymentStore);

    await runToConfirmationThenResume(harness, makeInput(), 'exec-bill-3');

    const billingEvent = harness.eventStore.events.find(
      (e) => e.eventType === 'destroy.billing',
    );
    expect(billingEvent?.requestedState).toBe('DELETED');
    expect(billingEvent?.result).toBe('ok');
  });
});

// ── Failure scenarios ────────────────────────────────────────────────────

describe('DESTROY workflow — failure scenarios', () => {
  it('throws DestroyError when resource destruction fails', async () => {
    const harness = makeHarness({
      resourceResult: { ok: false, reason: 'stack delete timeout' },
    });
    await seedHealthy(harness.deploymentStore);

    await expect(
      runToConfirmationThenResume(harness, makeInput(), 'exec-fail-1'),
    ).rejects.toThrow(DestroyError);

    // Deployment stays at DELETING.
    expect(await harness.deploymentStore.get('deployment-1')).toBe('DELETING');

    // Later steps never run.
    expect(harness.databaseDestroyer).not.toHaveBeenCalled();
  });

  it('throws DestroyError when database destruction fails', async () => {
    const harness = makeHarness({
      databaseResult: { ok: false, reason: 'instance in restricted state' },
    });
    await seedHealthy(harness.deploymentStore);

    await expect(
      runToConfirmationThenResume(harness, makeInput(), 'exec-fail-2'),
    ).rejects.toThrow(DestroyError);

    expect(harness.resourceDestroyer).toHaveBeenCalledTimes(1);
    expect(harness.storageDestroyer).not.toHaveBeenCalled();
  });

  it('throws DestroyError when storage destruction fails', async () => {
    const harness = makeHarness({
      storageResult: { ok: false, reason: 'bucket not empty' },
    });
    await seedHealthy(harness.deploymentStore);

    await expect(
      runToConfirmationThenResume(harness, makeInput(), 'exec-fail-3'),
    ).rejects.toThrow(DestroyError);

    expect(harness.databaseDestroyer).toHaveBeenCalledTimes(1);
    expect(harness.ecrGrantRevoker).not.toHaveBeenCalled();
  });

  it('throws DestroyError when ECR grant revocation fails', async () => {
    const harness = makeHarness({
      ecrResult: { ok: false, reason: 'repository not found' },
    });
    await seedHealthy(harness.deploymentStore);

    await expect(
      runToConfirmationThenResume(harness, makeInput(), 'exec-fail-4'),
    ).rejects.toThrow(DestroyError);

    expect(harness.storageDestroyer).toHaveBeenCalledTimes(1);
    expect(harness.billingStopper).not.toHaveBeenCalled();
  });

  it('throws DestroyError when billing cessation fails', async () => {
    const harness = makeHarness({
      billingResult: { ok: false, reason: 'Stripe API timeout' },
    });
    await seedHealthy(harness.deploymentStore);

    await expect(
      runToConfirmationThenResume(harness, makeInput(), 'exec-fail-5'),
    ).rejects.toThrow(DestroyError);

    expect(harness.ecrGrantRevoker).toHaveBeenCalledTimes(1);
    expect(await harness.deploymentStore.get('deployment-1')).toBe('DELETING');
  });

  it('preserves the DELETING state on failure (does not transition to DELETED prematurely)', async () => {
    const harness = makeHarness({
      resourceResult: { ok: false, reason: 'stack delete timeout' },
    });
    await seedHealthy(harness.deploymentStore);

    await expect(
      runToConfirmationThenResume(harness, makeInput(), 'exec-fail-6'),
    ).rejects.toThrow(DestroyError);

    // Still DELETING — metadata cleanup never ran.
    expect(await harness.deploymentStore.get('deployment-1')).toBe('DELETING');
    // No destroy.complete event.
    expect(
      harness.eventStore.events.some((e) => e.eventType.startsWith('destroy.complete')),
    ).toBe(false);
  });
});

// ── Idempotency ──────────────────────────────────────────────────────────

describe('DESTROY workflow — idempotency', () => {
  it('is idempotent on re-resume of a completed workflow', async () => {
    const harness = makeHarness();
    await seedHealthy(harness.deploymentStore);

    const first = await runToConfirmationThenResume(harness, makeInput(), 'exec-idem-1');
    const second = await harness.runtime.resume(harness.workflow, 'exec-idem-1', {});

    expect(second.status).toBe('COMPLETED');
    expect(second).toEqual(first);

    // Each destroyer called exactly once.
    expect(harness.resourceDestroyer).toHaveBeenCalledTimes(1);
    expect(harness.databaseDestroyer).toHaveBeenCalledTimes(1);
    expect(harness.billingStopper).toHaveBeenCalledTimes(1);
  });
});

// ── Edge cases ───────────────────────────────────────────────────────────

describe('DESTROY workflow — edge cases', () => {
  it('can destroy from any state (FAILED, UPDATING, etc.)', async () => {
    const harness = makeHarness();
    await harness.deploymentStore.set('deployment-1', 'FAILED');

    await runToConfirmationThenResume(harness, makeInput(), 'exec-edge-1');

    const confirmation = harness.eventStore.events.find(
      (e) => e.eventType === 'destroy.confirmation',
    );
    expect(confirmation?.previousState).toBe('FAILED');
    expect(await harness.deploymentStore.get('deployment-1')).toBe('DELETED');
  });

  it('metadata cleanup marks DELETED, never physically removes the row', async () => {
    const harness = makeHarness();
    await seedHealthy(harness.deploymentStore);

    await runToConfirmationThenResume(harness, makeInput(), 'exec-edge-2');

    // The store still holds the deployment — it's just marked DELETED.
    const state = await harness.deploymentStore.get('deployment-1');
    expect(state).toBe('DELETED');
  });

  it('confirmation event payload carries the finalSnapshot flag', async () => {
    const harness = makeHarness();
    await seedHealthy(harness.deploymentStore);

    await runToConfirmationThenResume(
      harness,
      makeInput({ finalSnapshot: false }),
      'exec-edge-3',
    );

    const confirmation = harness.eventStore.events.find(
      (e) => e.eventType === 'destroy.confirmation',
    );
    expect(confirmation?.payload.finalSnapshot).toBe(false);
  });

  it('complete event payload signals degraded flag', async () => {
    const harness = makeHarness();
    await seedDisconnected(harness.deploymentStore);

    await runToConfirmationThenResume(harness, makeInput(), 'exec-edge-4');

    const complete = harness.eventStore.events.find((e) =>
      e.eventType.startsWith('destroy.complete'),
    );
    expect(complete?.payload.degraded).toBe(true);
  });
});

// ── §62 audit actor (item 9) ─────────────────────────────────────────────

describe('DESTROY workflow — §62 audit actor', () => {
  it('attributes every event to the user who initiated it, when supplied', async () => {
    const harness = makeHarness();
    await seedHealthy(harness.deploymentStore);
    const input = makeInput({ initiatedBy: { type: 'user', id: 'user-8' } });

    await runToConfirmationThenResume(harness, input, 'exec-initiator-1');

    expect(harness.eventStore.events.length).toBeGreaterThan(0);
    for (const event of harness.eventStore.events) {
      expect(event.actorType).toBe('user');
      expect(event.actorId).toBe('user-8');
    }
  });

  it('defaults to the system actor when initiatedBy is omitted', async () => {
    const harness = makeHarness();
    await seedHealthy(harness.deploymentStore);

    await runToConfirmationThenResume(harness, makeInput(), 'exec-initiator-2');

    for (const event of harness.eventStore.events) {
      expect(event.actorType).toBe('system');
    }
  });
});