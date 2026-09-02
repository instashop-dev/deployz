import { describe, expect, it } from 'vitest';

import type { RuntimeHealthLayers } from '@deployz/contracts';

import type { DerivedDeploymentStatus } from './deployment-status.js';
import { advanceStepTimings, type StepTimings } from './step-timings.js';

// advanceStepTimings is pure: every test builds a plain DerivedDeploymentStatus
// fixture and a plain `previous` map, with no database and no server — same
// design goal as deployment-status.test.ts.

const NOW = new Date('2026-08-31T12:00:00.000Z');

/** Empty §10.1 layers — nothing observed yet, which is this fixture's default. */
function emptyLayers(): RuntimeHealthLayers {
  return { infrastructure: 'UNKNOWN', rollout: null, targets: null, http: null, relay: 'UNKNOWN' };
}

function makeDerived(overrides: Partial<DerivedDeploymentStatus> = {}): DerivedDeploymentStatus {
  return {
    stage: 'PROVISIONING',
    updatedAt: NOW.toISOString(),
    currentActivity: 'Creating the network.',
    step: 'NETWORK',
    steps: ['AWS_SETUP', 'RELAY_CONNECT', 'PREPARING', 'NETWORK', 'APPLICATION', 'HEALTH_CHECK', 'TLS', 'READY'],
    stepStartedAt: null,
    typicalDurationSeconds: { min: 120, max: 360 },
    takingLongerThanUsual: false,
    stepTimings: [],
    stepSnapshotCompletedAt: {},
    statusUpdatesUnavailable: false,
    needsDomainSetup: false,
    components: [],
    relay: { connected: true, lastSeenAt: null },
    job: null,
    aws: { stackStatus: null },
    health: { status: 'UNKNOWN', layers: emptyLayers() },
    result: null,
    failure: null,
    ...overrides,
  };
}

describe('advanceStepTimings', () => {
  it('gives the active step a startedAt when it has none, preferring the derivation stepStartedAt over now', () => {
    const derived = makeDerived({ step: 'NETWORK', stepStartedAt: '2026-08-31T11:58:00.000Z' });
    const result = advanceStepTimings(null, derived, NOW);
    expect(result.changed).toBe(true);
    expect(result.next.NETWORK?.startedAt).toBe('2026-08-31T11:58:00.000Z');
    expect(result.completedSteps).toEqual([]);
  });

  it('falls back to now for the active step startedAt when the derivation has no authoritative timestamp', () => {
    const derived = makeDerived({ step: 'NETWORK', stepStartedAt: null });
    const result = advanceStepTimings(null, derived, NOW);
    expect(result.next.NETWORK?.startedAt).toBe(NOW.toISOString());
  });

  it('is idempotent: a second call with the same derived/now makes no further changes', () => {
    const derived = makeDerived({ step: 'NETWORK', stepStartedAt: '2026-08-31T11:58:00.000Z' });
    const first = advanceStepTimings(null, derived, NOW);
    const second = advanceStepTimings(first.next, derived, NOW);
    expect(second.changed).toBe(false);
    expect(second.completedSteps).toEqual([]);
    expect(second.next).toEqual(first.next);
  });

  it('completes every applicable step before the active one that started but never completed', () => {
    const previous: StepTimings = {
      AWS_SETUP: { startedAt: '2026-08-31T11:00:00.000Z', completedAt: '2026-08-31T11:01:00.000Z' },
      RELAY_CONNECT: { startedAt: '2026-08-31T11:01:00.000Z', completedAt: '2026-08-31T11:02:00.000Z' },
      PREPARING: { startedAt: '2026-08-31T11:02:00.000Z' }, // started, never completed
    };
    const derived = makeDerived({ step: 'NETWORK', stepStartedAt: '2026-08-31T11:05:00.000Z' });
    const result = advanceStepTimings(previous, derived, NOW);

    expect(result.changed).toBe(true);
    expect(result.next.PREPARING).toEqual({
      startedAt: '2026-08-31T11:02:00.000Z',
      // No snapshot completion known for PREPARING, so it falls back to the
      // active step's own startedAt — PREPARING ended when NETWORK began.
      completedAt: '2026-08-31T11:05:00.000Z',
    });
    expect(result.completedSteps).toEqual([
      {
        step: 'PREPARING',
        startedAt: '2026-08-31T11:02:00.000Z',
        completedAt: '2026-08-31T11:05:00.000Z',
        durationSeconds: 180,
      },
    ]);
  });

  it('prefers the relay snapshot completedAt over the active step startedAt when both are known', () => {
    const previous: StepTimings = { NETWORK: { startedAt: '2026-08-31T11:05:00.000Z' } };
    const derived = makeDerived({
      step: 'DATABASE_STORAGE',
      steps: ['AWS_SETUP', 'RELAY_CONNECT', 'PREPARING', 'NETWORK', 'DATABASE_STORAGE', 'APPLICATION', 'HEALTH_CHECK', 'TLS', 'READY'],
      stepStartedAt: '2026-08-31T11:20:00.000Z',
      stepSnapshotCompletedAt: { NETWORK: '2026-08-31T11:18:00.000Z' },
    });
    const result = advanceStepTimings(previous, derived, NOW);
    expect(result.next.NETWORK?.completedAt).toBe('2026-08-31T11:18:00.000Z');
  });

  it('never rewrites an existing startedAt or completedAt, even when the derivation disagrees', () => {
    const previous: StepTimings = {
      AWS_SETUP: { startedAt: '2026-08-31T10:00:00.000Z', completedAt: '2026-08-31T10:05:00.000Z' },
    };
    const derived = makeDerived({
      stage: 'CONNECTING',
      step: 'RELAY_CONNECT',
      stepStartedAt: '2026-08-31T11:59:00.000Z',
    });
    const result = advanceStepTimings(previous, derived, NOW);
    expect(result.next.AWS_SETUP).toEqual(previous.AWS_SETUP);
  });

  it('a FAILED stage still records the failed step\'s own startedAt but completes nothing before it', () => {
    const previous: StepTimings = { PREPARING: { startedAt: '2026-08-31T11:02:00.000Z' } };
    const derived = makeDerived({
      stage: 'FAILED',
      step: 'NETWORK',
      stepStartedAt: null,
      failure: {
        code: null,
        component: null,
        reference: 'DEP-ABCDEF12',
        customerMessage: 'Deployment needs attention.',
        vendorMessage: 'The deployment failed without a classified cause.',
        awsStatus: null,
        jobType: 'INSTALL',
      },
    });
    const result = advanceStepTimings(previous, derived, NOW);

    expect(result.next.NETWORK?.startedAt).toBe(NOW.toISOString());
    expect(result.next.PREPARING).toEqual(previous.PREPARING);
    expect(result.completedSteps).toEqual([]);
  });

  it('a removed deployment completes nothing either, even mid-PROVISIONING', () => {
    const previous: StepTimings = { PREPARING: { startedAt: '2026-08-31T11:02:00.000Z' } };
    const derived = makeDerived({
      step: 'NETWORK',
      removed: { state: 'DELETING' },
    });
    const result = advanceStepTimings(previous, derived, NOW);
    expect(result.next.PREPARING).toEqual(previous.PREPARING);
    expect(result.completedSteps).toEqual([]);
  });
});
