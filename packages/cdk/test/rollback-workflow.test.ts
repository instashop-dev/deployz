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
  PreflightError,
} from '../src/jobs/install-workflow.js';

import {
  createRollbackWorkflow,
  isImmutableDigest,
  RollbackError,
  ROLLBACK_COPY,
  type RollbackInput,
  type RollbackOutput,
  type RollbackResult,
} from '../src/jobs/rollback-workflow.js';

// ── Fixtures ─────────────────────────────────────────────────────────────

const FIXED_NOW = new Date('2026-08-20T00:00:00.000Z');
const PREVIOUS_DIGEST =
  'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function makeInput(overrides: Partial<RollbackInput> = {}): RollbackInput {
  return {
    deploymentId: 'deployment-1',
    customerId: 'customer-1',
    organizationId: 'org-1',
    jobId: 'job-1',
    installationId: 'install-1',
    releaseId: 'release-1',
    imageDigest: PREVIOUS_DIGEST,
    ...overrides,
  };
}

interface WorkflowHarness {
  workflow: DurableWorkflow<RollbackInput, RollbackOutput>;
  runtime: DurableRuntime;
  eventStore: InMemoryEventStore;
  deploymentStore: InMemoryDeploymentStateStore;
  restore: Mock<() => Promise<RollbackResult>>;
}

function makeHarness(config: { restoreResult?: RollbackResult } = {}): WorkflowHarness {
  const eventStore = new InMemoryEventStore();
  const emitter = new EventEmitter(eventStore, () => FIXED_NOW);
  const deploymentStore = new InMemoryDeploymentStateStore();

  const restore = vi
    .fn<() => Promise<RollbackResult>>()
    .mockResolvedValue(config.restoreResult ?? { ok: true, digest: PREVIOUS_DIGEST });

  const workflow = createRollbackWorkflow({
    emitter,
    deploymentStore,
    rollbackExecutor: { restore },
  });
  const runtime = new DurableRuntime(new InMemoryStateStore());

  return { workflow, runtime, eventStore, deploymentStore, restore };
}

/** Seed the deployment in FAILED — a rollback trigger state. */
async function seedFailed(deploymentStore: InMemoryDeploymentStateStore): Promise<void> {
  await deploymentStore.set('deployment-1', 'FAILED');
}

// ── ROLLBACK workflow ────────────────────────────────────────────────────

describe('ROLLBACK workflow', () => {
  let harness: WorkflowHarness;

  beforeEach(() => {
    harness = makeHarness();
  });

  it('transitions FAILED → UPDATING, restores, then suspends on health', async () => {
    await seedFailed(harness.deploymentStore);

    const state = await harness.runtime.start(harness.workflow, makeInput(), 'exec-1');

    expect(state.status).toBe('WAITING_CALLBACK');
    expect(state.callbackToken).toBe('rollback:install-1:health-report');
    expect(state.history.map((h) => h.name)).toEqual(['mark-rolling-back', 'restore']);

    // Deployment transitioned FAILED → UPDATING.
    expect(await harness.deploymentStore.get('deployment-1')).toBe('UPDATING');
  });

  it('DIGEST-EQUALITY: dispatches the previous release exact sha256: digest (no tag resolution)', async () => {
    await seedFailed(harness.deploymentStore);

    await harness.runtime.start(harness.workflow, makeInput(), 'exec-2');

    // The executor is called with the EXACT immutable digest — no tag, no
    // resolution — equal to the previous release's stored image_digest.
    expect(harness.restore).toHaveBeenCalledTimes(1);
    expect(harness.restore).toHaveBeenCalledWith('deployment-1', PREVIOUS_DIGEST);
  });

  it('rejects a non-sha256 target (tag) with INVALID_DIGEST and never restores', async () => {
    await seedFailed(harness.deploymentStore);

    await expect(
      harness.runtime.start(
        harness.workflow,
        makeInput({ imageDigest: 'latest' }),
        'exec-3',
      ),
    ).rejects.toThrow(RollbackError);

    expect(harness.restore).not.toHaveBeenCalled();
    const restoreEvent = harness.eventStore.events.find(
      (e) => e.eventType === 'rollback.restore',
    );
    expect(restoreEvent?.result).toBe('failed:INVALID_DIGEST');
  });

  it('NO DB CHANGE: the workflow has no migration step and emits no migration event', async () => {
    await seedFailed(harness.deploymentStore);

    await harness.runtime.start(harness.workflow, makeInput(), 'exec-4');
    const completed = await harness.runtime.resume(
      harness.workflow,
      'exec-4',
      { installationId: 'install-1', healthy: true },
    );

    // The executed step history never contains a migration step.
    expect(completed.history.map((h) => h.name)).toEqual([
      'mark-rolling-back',
      'restore',
      'observe-health',
    ]);
    expect(completed.history.some((h) => h.name === 'migration')).toBe(false);

    // No emitted event is migration-related.
    expect(
      harness.eventStore.events.some((e) => e.eventType.includes('migration')),
    ).toBe(false);
  });

  it('COPY ASSERTION: emits the §62 disclosure that rollback does not reverse DB migrations', async () => {
    await seedFailed(harness.deploymentStore);

    await harness.runtime.start(harness.workflow, makeInput(), 'exec-5');

    const disclosure = harness.eventStore.events.find(
      (e) => e.eventType === 'rollback.disclosure',
    );
    expect(disclosure).toBeDefined();
    expect(disclosure?.payload.disclosure).toBe(ROLLBACK_COPY.noDbMigration);
    expect(disclosure?.payload.disclosure).toContain('does not reverse database migrations');
  });

  it('completes end-to-end to HEALTHY after a healthy report', async () => {
    await seedFailed(harness.deploymentStore);

    await harness.runtime.start(harness.workflow, makeInput(), 'exec-6');
    const completed = await harness.runtime.resume(
      harness.workflow,
      'exec-6',
      { installationId: 'install-1', healthy: true, observedState: 'HEALTHY' },
    );

    expect(completed.status).toBe('COMPLETED');
    expect(completed.output).toEqual({
      status: 'HEALTHY',
      deploymentId: 'deployment-1',
      releaseId: 'release-1',
      imageDigest: PREVIOUS_DIGEST,
    });
    expect(completed.history.map((h) => h.name)).toEqual([
      'mark-rolling-back',
      'restore',
      'observe-health',
    ]);
    expect(await harness.deploymentStore.get('deployment-1')).toBe('HEALTHY');
  });

  it('emits every §62 event in order (happy path)', async () => {
    await seedFailed(harness.deploymentStore);

    await harness.runtime.start(harness.workflow, makeInput(), 'exec-7');
    await harness.runtime.resume(
      harness.workflow,
      'exec-7',
      { installationId: 'install-1', healthy: true },
    );

    expect(harness.eventStore.events.map((e) => e.eventType)).toEqual([
      'rollback.state.updating',
      'rollback.disclosure',
      'rollback.restore',
      'rollback.health',
      'rollback.state.healthy',
    ]);
  });

  it('captures the prior FAILED state in the UPDATING transition event', async () => {
    await seedFailed(harness.deploymentStore);

    await harness.runtime.start(harness.workflow, makeInput(), 'exec-8');

    const updating = harness.eventStore.events.find(
      (e) => e.eventType === 'rollback.state.updating',
    );
    expect(updating?.previousState).toBe('FAILED');
    expect(updating?.requestedState).toBe('UPDATING');
  });

  it('fails with ROLLBACK_FAILED when the restore executor fails', async () => {
    await seedFailed(harness.deploymentStore);
    harness.restore.mockResolvedValue({
      ok: false,
      failureCode: 'ROLLBACK_FAILED',
      reason: 'service unreachable',
    });

    await expect(
      harness.runtime.start(harness.workflow, makeInput(), 'exec-9'),
    ).rejects.toThrow(RollbackError);

    const restoreEvent = harness.eventStore.events.find(
      (e) => e.eventType === 'rollback.restore',
    );
    expect(restoreEvent?.result).toBe('failed:ROLLBACK_FAILED');
    expect(await harness.deploymentStore.get('deployment-1')).toBe('UPDATING');
  });

  it('rejects an unhealthy report and stays UPDATING', async () => {
    await seedFailed(harness.deploymentStore);

    await harness.runtime.start(harness.workflow, makeInput(), 'exec-10');

    await expect(
      harness.runtime.resume(
        harness.workflow,
        'exec-10',
        { installationId: 'install-1', healthy: false },
      ),
    ).rejects.toThrow(PreflightError);

    expect(await harness.deploymentStore.get('deployment-1')).toBe('UPDATING');
    expect(harness.eventStore.events.some((e) => e.eventType === 'rollback.health')).toBe(true);
    expect(
      harness.eventStore.events.some((e) => e.eventType === 'rollback.state.healthy'),
    ).toBe(false);
  });

  it('is idempotent on re-resume of a completed workflow', async () => {
    await seedFailed(harness.deploymentStore);

    await harness.runtime.start(harness.workflow, makeInput(), 'exec-11');
    const first = await harness.runtime.resume(
      harness.workflow,
      'exec-11',
      { installationId: 'install-1', healthy: true },
    );
    const second = await harness.runtime.resume(
      harness.workflow,
      'exec-11',
      { installationId: 'install-1', healthy: true },
    );

    expect(second.status).toBe('COMPLETED');
    expect(second).toEqual(first);
    expect(harness.eventStore.count).toBe(5);
    expect(harness.restore).toHaveBeenCalledTimes(1);
  });
});

// ── Digest immutability helper ───────────────────────────────────────────

describe('isImmutableDigest', () => {
  it('accepts a valid sha256: digest', () => {
    expect(isImmutableDigest(PREVIOUS_DIGEST)).toBe(true);
  });

  it('rejects tags, short hashes, and non-sha256 schemes', () => {
    expect(isImmutableDigest('latest')).toBe(false);
    expect(isImmutableDigest('v1.2.3')).toBe(false);
    expect(isImmutableDigest('sha256:deadbeef')).toBe(false);
    expect(isImmutableDigest('md5:0123456789abcdef0123456789abcdef')).toBe(false);
  });
});
