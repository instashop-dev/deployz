import { beforeEach, describe, expect, it } from 'vitest';

import { regionEnum } from '@deployz/db';

import {
  DurableRuntime,
  InMemoryStateStore,
  type DurableWorkflow,
} from '../src/durable/durable-runtime.js';

import {
  EventEmitter,
  InMemoryEventStore,
  type EventActor,
  type EventRecord,
} from '../src/jobs/event-emitter.js';

import {
  ALLOWED_REGIONS,
  assertHealthReport,
  assertRelayContact,
  checkScpBlocks,
  runPreflight,
  validateRegion,
} from '../src/jobs/preflight.js';

import {
  createInstallWorkflow,
  InMemoryDeploymentStateStore,
  PreflightError,
  type InstallInput,
  type InstallOutput,
} from '../src/jobs/install-workflow.js';

// ── Fixtures ─────────────────────────────────────────────────────────────

const FIXED_NOW = new Date('2026-08-20T00:00:00.000Z');

function makeInput(overrides: Partial<InstallInput> = {}): InstallInput {
  return {
    deploymentId: 'deployment-1',
    customerId: 'customer-1',
    organizationId: 'org-1',
    jobId: 'job-1',
    installationId: 'install-1',
    region: 'us-east-1',
    releaseId: 'release-1',
    // §30 full-preflight application inputs — must be valid for the new
    // full-preflight step (item 1) to pass.
    port: 3000,
    healthPath: '/health',
    ...overrides,
  };
}

interface WorkflowHarness {
  workflow: DurableWorkflow<InstallInput, InstallOutput>;
  runtime: DurableRuntime;
  eventStore: InMemoryEventStore;
  deploymentStore: InMemoryDeploymentStateStore;
}

function makeHarness(): WorkflowHarness {
  const eventStore = new InMemoryEventStore();
  const emitter = new EventEmitter(eventStore, () => FIXED_NOW);
  const deploymentStore = new InMemoryDeploymentStateStore();
  const workflow = createInstallWorkflow({ emitter, deploymentStore });
  const runtime = new DurableRuntime(new InMemoryStateStore());
  return { workflow, runtime, eventStore, deploymentStore };
}

// ── Preflight ────────────────────────────────────────────────────────────

describe('preflight', () => {
  describe('validateRegion (§32 allowlist)', () => {
    it('accepts every one of the 17 allowed regions', () => {
      for (const region of ALLOWED_REGIONS) {
        expect(validateRegion(region)).toEqual({ check: 'region', passed: true });
      }
    });

    it('rejects a region outside the allowlist', () => {
      const result = validateRegion('ap-southeast-3');
      expect(result.passed).toBe(false);
      if (!result.passed) {
        expect(result.failureCode).toBe('REGION_NOT_SUPPORTED');
        expect(result.reason).toContain('ap-southeast-3');
      }
    });
  });

  describe('checkScpBlocks', () => {
    it('always passes (real AWS check, degrades when creds unavailable)', async () => {
      const result = await checkScpBlocks();
      expect(result.check).toBe('scp');
      expect(result.passed).toBe(true);
    });
  });

  describe('assertRelayContact', () => {
    it('passes when the installation ID matches', () => {
      expect(
        assertRelayContact({ installationId: 'install-1' }, 'install-1'),
      ).toEqual({ check: 'relay-contact', passed: true });
    });

    it('fails when the installation ID does not match', () => {
      const result = assertRelayContact({ installationId: 'install-2' }, 'install-1');
      expect(result.passed).toBe(false);
      if (!result.passed) {
        expect(result.failureCode).toBe('RELAY_DISCONNECTED');
      }
    });

    it('fails on a non-object payload', () => {
      expect(assertRelayContact(null, 'install-1').passed).toBe(false);
      expect(assertRelayContact('garbage', 'install-1').passed).toBe(false);
    });
  });

  describe('assertHealthReport', () => {
    it('passes when installation matches and healthy is true', () => {
      expect(
        assertHealthReport(
          { installationId: 'install-1', healthy: true, observedState: 'HEALTHY' },
          'install-1',
        ),
      ).toEqual({ check: 'health-report', passed: true });
    });

    it('fails when healthy is not true', () => {
      const result = assertHealthReport(
        { installationId: 'install-1', healthy: false },
        'install-1',
      );
      expect(result.passed).toBe(false);
      if (!result.passed) {
        expect(result.failureCode).toBe('RELAY_DISCONNECTED');
      }
    });
  });

  describe('runPreflight', () => {
    it('aggregates region + scp checks and passes for a valid region', async () => {
      const result = await runPreflight('us-east-1');
      expect(result.passed).toBe(true);
      expect(result.checks).toHaveLength(2);
      expect(result.failureCode).toBeUndefined();
    });

    it('fails with REGION_NOT_SUPPORTED for an invalid region', async () => {
      const result = await runPreflight('moon-1');
      expect(result.passed).toBe(false);
      expect(result.failureCode).toBe('REGION_NOT_SUPPORTED');
    });
  });

  describe('region parity with @deployz/db', () => {
    it('ALLOWED_REGIONS === regionEnum.enumValues (sorted)', () => {
      expect([...ALLOWED_REGIONS].sort()).toEqual([...regionEnum.enumValues].sort());
    });

    it('has exactly 17 regions', () => {
      expect(ALLOWED_REGIONS).toHaveLength(17);
      expect(regionEnum.enumValues).toHaveLength(17);
    });
  });
});

// ── Event emitter ────────────────────────────────────────────────────────

describe('EventEmitter (§62)', () => {
  it('emits a §62-complete event with who/when/customer/states/release/job/result', async () => {
    const store = new InMemoryEventStore();
    const emitter = new EventEmitter(store, () => FIXED_NOW);

    const event = await emitter.emit({ type: 'user', id: 'user-1' }, {
      eventType: 'install.state.installing',
      organizationId: 'org-1',
      customerId: 'customer-1',
      deploymentId: 'deployment-1',
      jobId: 'job-1',
      releaseId: 'release-1',
      previousState: 'NOT_INSTALLED',
      requestedState: 'INSTALLING',
      result: 'ok',
      payload: { installationId: 'install-1' },
    });

    expect(event).toEqual({
      occurredAt: '2026-08-20T00:00:00.000Z',
      actorType: 'user',
      actorId: 'user-1',
      organizationId: 'org-1',
      customerId: 'customer-1',
      deploymentId: 'deployment-1',
      jobId: 'job-1',
      releaseId: 'release-1',
      eventType: 'install.state.installing',
      previousState: 'NOT_INSTALLED',
      requestedState: 'INSTALLING',
      result: 'ok',
      payload: { installationId: 'install-1' },
    });
  });

  it('defaults nullable §62 fields to null when omitted', async () => {
    const store = new InMemoryEventStore();
    const emitter = new EventEmitter(store, () => FIXED_NOW);

    const event = await emitter.emit({ type: 'system' }, {
      eventType: 'install.preflight.region',
      organizationId: 'org-1',
    });

    expect(event.customerId).toBeNull();
    expect(event.deploymentId).toBeNull();
    expect(event.jobId).toBeNull();
    expect(event.releaseId).toBeNull();
    expect(event.previousState).toBeNull();
    expect(event.requestedState).toBeNull();
    expect(event.result).toBeNull();
  });

  it('resolves actor type and id for user, relay, and system', async () => {
    const store = new InMemoryEventStore();
    const emitter = new EventEmitter(store, () => FIXED_NOW);

    const userEvent = await emitter.emit({ type: 'user', id: 'user-9' }, { eventType: 'e', organizationId: 'o' });
    const relayEvent = await emitter.emit({ type: 'relay', installationId: 'inst-9' }, { eventType: 'e', organizationId: 'o' });
    const systemEvent = await emitter.emit({ type: 'system' }, { eventType: 'e', organizationId: 'o' });

    expect([userEvent.actorType, userEvent.actorId]).toEqual(['user', 'user-9']);
    expect([relayEvent.actorType, relayEvent.actorId]).toEqual(['relay', 'inst-9']);
    expect([systemEvent.actorType, systemEvent.actorId]).toEqual(['system', 'system']);
  });

  it('appends events to the store (append-only)', async () => {
    const store = new InMemoryEventStore();
    const emitter = new EventEmitter(store, () => FIXED_NOW);

    expect(store.count).toBe(0);
    await emitter.emit({ type: 'system' }, { eventType: 'a', organizationId: 'o' });
    await emitter.emit({ type: 'system' }, { eventType: 'b', organizationId: 'o' });
    expect(store.count).toBe(2);
    expect(store.events.map((e) => e.eventType)).toEqual(['a', 'b']);
  });

  it('freezes emitted records (immutable)', async () => {
    const store = new InMemoryEventStore();
    const emitter = new EventEmitter(store, () => FIXED_NOW);

    await emitter.emit({ type: 'system' }, { eventType: 'a', organizationId: 'o' });
    const stored = store.events[0] as EventRecord;
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.payload)).toBe(true);
  });
});

// ── INSTALL workflow ─────────────────────────────────────────────────────

describe('INSTALL workflow', () => {
  let harness: WorkflowHarness;

  beforeEach(() => {
    harness = makeHarness();
  });

  it('executes preflight steps then suspends on relay-contact callback', async () => {
    const state = await harness.runtime.start(harness.workflow, makeInput(), 'exec-1');

    expect(state.status).toBe('WAITING_CALLBACK');
    expect(state.callbackToken).toBe('install:install-1:relay-contact');
    expect(state.history.map((h) => h.name)).toEqual([
      'validate-region',
      'check-scp',
      'full-preflight',
    ]);
    expect(state.currentStep).toBe(3);

    // 3 preflight events emitted — region, SCP, and the full §30 engine.
    expect(harness.eventStore.events.map((e) => e.eventType)).toEqual([
      'install.preflight.region',
      'install.preflight.scp',
      'install.preflight.full',
    ]);
    expect(harness.eventStore.events[2]?.result).toBe('passed');

    // Deployment state unchanged (still NOT_INSTALLED)
    expect(await harness.deploymentStore.get('deployment-1')).toBe('NOT_INSTALLED');
  });

  it('completes end-to-end through relay contact and health report', async () => {
    await harness.runtime.start(harness.workflow, makeInput(), 'exec-2');

    // Relay first contact
    const installing = await harness.runtime.resume(
      harness.workflow,
      'exec-2',
      { installationId: 'install-1', registeredAt: FIXED_NOW.toISOString() },
    );
    expect(installing.status).toBe('WAITING_CALLBACK');
    expect(installing.callbackToken).toBe('install:install-1:health-report');
    expect(await harness.deploymentStore.get('deployment-1')).toBe('INSTALLING');

    // Relay health report
    const healthy = await harness.runtime.resume(
      harness.workflow,
      'exec-2',
      { installationId: 'install-1', healthy: true, observedState: 'HEALTHY' },
    );

    expect(healthy.status).toBe('COMPLETED');
    expect(healthy.output).toEqual({ status: 'HEALTHY', deploymentId: 'deployment-1' });

    // All five steps executed in order
    expect(healthy.history.map((h) => h.name)).toEqual([
      'validate-region',
      'check-scp',
      'full-preflight',
      'mark-installing',
      'mark-healthy',
    ]);

    // Deployment state reached HEALTHY
    expect(await harness.deploymentStore.get('deployment-1')).toBe('HEALTHY');

    // §38: the first successful install seeds the release pointers.
    expect(await harness.deploymentStore.getReleasePointers('deployment-1')).toEqual({
      currentReleaseId: 'release-1',
      previousReleaseId: null,
    });
  });

  it('emits all seven §62 events in order', async () => {
    await harness.runtime.start(harness.workflow, makeInput(), 'exec-3');
    await harness.runtime.resume(
      harness.workflow,
      'exec-3',
      { installationId: 'install-1' },
    );
    await harness.runtime.resume(
      harness.workflow,
      'exec-3',
      { installationId: 'install-1', healthy: true },
    );

    expect(harness.eventStore.events.map((e) => e.eventType)).toEqual([
      'install.preflight.region',
      'install.preflight.scp',
      'install.preflight.full',
      'install.relay.contact',
      'install.state.installing',
      'install.relay.health',
      'install.state.healthy',
    ]);
  });

  it('emits state transitions with correct previous/requested states', async () => {
    await harness.runtime.start(harness.workflow, makeInput(), 'exec-4');
    await harness.runtime.resume(
      harness.workflow,
      'exec-4',
      { installationId: 'install-1' },
    );
    await harness.runtime.resume(
      harness.workflow,
      'exec-4',
      { installationId: 'install-1', healthy: true },
    );

    const installing = harness.eventStore.events.find(
      (e) => e.eventType === 'install.state.installing',
    );
    const healthy = harness.eventStore.events.find(
      (e) => e.eventType === 'install.state.healthy',
    );

    expect(installing?.previousState).toBe('NOT_INSTALLED');
    expect(installing?.requestedState).toBe('INSTALLING');
    expect(healthy?.previousState).toBe('INSTALLING');
    expect(healthy?.requestedState).toBe('HEALTHY');
  });

  it('rejects an unsupported region with a §62 failure event', async () => {
    await expect(
      harness.runtime.start(
        harness.workflow,
        makeInput({ region: 'ap-southeast-3' }),
        'exec-5',
      ),
    ).rejects.toThrow(PreflightError);

    const events = harness.eventStore.events;
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('install.preflight.region');
    expect(events[0]?.result).toBe('failed:REGION_NOT_SUPPORTED');
  });

  it('rejects a mismatched relay contact and never marks INSTALLING', async () => {
    await harness.runtime.start(harness.workflow, makeInput(), 'exec-6');

    await expect(
      harness.runtime.resume(
        harness.workflow,
        'exec-6',
        { installationId: 'wrong-install' },
      ),
    ).rejects.toThrow(PreflightError);

    expect(await harness.deploymentStore.get('deployment-1')).toBe('NOT_INSTALLED');
    // relay.contact event was emitted with a failure result before the throw
    expect(harness.eventStore.events.some((e) => e.eventType === 'install.relay.contact')).toBe(true);
  });

  it('rejects an unhealthy report and never marks HEALTHY', async () => {
    await harness.runtime.start(harness.workflow, makeInput(), 'exec-7');
    await harness.runtime.resume(
      harness.workflow,
      'exec-7',
      { installationId: 'install-1' },
    );

    await expect(
      harness.runtime.resume(
        harness.workflow,
        'exec-7',
        { installationId: 'install-1', healthy: false },
      ),
    ).rejects.toThrow(PreflightError);

    expect(await harness.deploymentStore.get('deployment-1')).toBe('INSTALLING');
    expect(harness.eventStore.events.some((e) => e.eventType === 'install.relay.health')).toBe(true);
  });

  it('is idempotent on re-resume of a completed workflow', async () => {
    await harness.runtime.start(harness.workflow, makeInput(), 'exec-8');
    await harness.runtime.resume(
      harness.workflow,
      'exec-8',
      { installationId: 'install-1' },
    );
    const first = await harness.runtime.resume(
      harness.workflow,
      'exec-8',
      { installationId: 'install-1', healthy: true },
    );

    const second = await harness.runtime.resume(
      harness.workflow,
      'exec-8',
      { installationId: 'install-1', healthy: true },
    );

    expect(second.status).toBe('COMPLETED');
    expect(second).toEqual(first);
    // No duplicate events on re-resume
    expect(harness.eventStore.count).toBe(7);
  });

  // ── §62 audit actor (item 9) ───────────────────────────────────────────

  it('attributes every event to the user who initiated it, when supplied', async () => {
    const input = makeInput({ initiatedBy: { type: 'user', id: 'user-42' } });
    await harness.runtime.start(harness.workflow, input, 'exec-initiator-1');

    expect(harness.eventStore.events.length).toBeGreaterThan(0);
    for (const event of harness.eventStore.events) {
      expect(event.actorType).toBe('user');
      expect(event.actorId).toBe('user-42');
    }
  });

  it('defaults to the system actor when initiatedBy is omitted', async () => {
    await harness.runtime.start(harness.workflow, makeInput(), 'exec-initiator-2');

    for (const event of harness.eventStore.events) {
      expect(event.actorType).toBe('system');
      expect(event.actorId).toBe('system');
    }
  });

  // ── Full §30 preflight (item 1) ─────────────────────────────────────────

  it('halts before waiting on relay contact when a required port is missing', async () => {
    await expect(
      harness.runtime.start(
        harness.workflow,
        makeInput({ port: undefined }),
        'exec-preflight-port',
      ),
    ).rejects.toThrow(PreflightError);

    expect(
      harness.eventStore.events.some((e) => e.eventType === 'install.preflight.full'),
    ).toBe(true);
    const full = harness.eventStore.events.find((e) => e.eventType === 'install.preflight.full');
    expect(full?.result).toBe('failed:INVALID_CONFIG');
    // Never reached the relay-contact wait, never transitioned INSTALLING.
    expect(await harness.deploymentStore.get('deployment-1')).toBe('NOT_INSTALLED');
  });

  it('halts before waiting on relay contact when required secrets are missing', async () => {
    await expect(
      harness.runtime.start(
        harness.workflow,
        makeInput({ requiredSecrets: ['DATABASE_PASSWORD'], configuredSecrets: [] }),
        'exec-preflight-secrets',
      ),
    ).rejects.toThrow(PreflightError);

    const full = harness.eventStore.events.find((e) => e.eventType === 'install.preflight.full');
    expect(full?.result).toBe('failed:MISSING_SECRET');
  });
});
