import { describe, expect, it } from 'vitest';

import type { DeploymentStage, DeploymentStep, VendorDeploymentStatus } from '@deployz/contracts';

import { deriveHero, type HeroInput } from '../src/lib/deployment-hero';
import {
  checkedLabel,
  elapsedLabel,
  formatDurationRange,
  formatElapsedSeconds,
  isTerminalStage,
  liveDurationLine,
  recentActivityTimeLabel,
  REMOVED_PROGRESS,
  removedProgress,
  stageRank,
  stepWaitingOnInput,
  stepsBeforeLaunch,
  AWAITING_DOMAIN_STEP_DETAIL,
  PRE_LAUNCH_HEADLINE,
  STAGE_HEADLINE,
  stepsFromStatus,
  TAKING_LONGER_MESSAGE,
  type ProgressStepState,
} from '../src/lib/deployment-progress';

// Locks the client-side vocabulary map for the server-derived deployment
// stage/step (see apps/api/src/deployment-status.ts): the client only ever
// formats a received `stage`/`step`/`steps` into display steps, never infers
// lifecycle itself, so this module's pure functions are the entire surface
// worth testing here.

const FULL_STEPS: DeploymentStep[] = [
  'AWS_SETUP',
  'RELAY_CONNECT',
  'PREPARING',
  'NETWORK',
  'DATABASE_STORAGE',
  'REDIS',
  'MIGRATION',
  'APPLICATION',
  'HEALTH_CHECK',
  'TLS',
  'READY',
];

const NO_REDIS_STEPS: DeploymentStep[] = FULL_STEPS.filter((step) => step !== 'REDIS');
const NO_DB_NO_REDIS_STEPS: DeploymentStep[] = FULL_STEPS.filter(
  (step) => step !== 'REDIS' && step !== 'DATABASE_STORAGE',
);

function stateOf(steps: DeploymentStep[], step: DeploymentStep, stage: DeploymentStage, key: DeploymentStep): ProgressStepState {
  const found = stepsFromStatus({ steps, step, stage }).find((candidate) => candidate.key === key);
  if (!found) throw new Error(`no ${key} step in ${steps.join(',')}`);
  return found.state;
}

describe('stageRank', () => {
  it('orders the five positional stages', () => {
    expect(stageRank('WAITING_FOR_AWS')).toBe(0);
    expect(stageRank('CONNECTING')).toBe(1);
    expect(stageRank('PROVISIONING')).toBe(2);
    expect(stageRank('VERIFYING')).toBe(3);
    expect(stageRank('READY')).toBe(4);
  });

  it('ranks FAILED alongside PROVISIONING — every failure today interrupts infrastructure creation', () => {
    expect(stageRank('FAILED')).toBe(stageRank('PROVISIONING'));
  });
});

describe('isTerminalStage', () => {
  it('is true only for READY and FAILED', () => {
    expect(isTerminalStage('READY')).toBe(true);
    expect(isTerminalStage('FAILED')).toBe(true);
    expect(isTerminalStage('WAITING_FOR_AWS')).toBe(false);
    expect(isTerminalStage('CONNECTING')).toBe(false);
    expect(isTerminalStage('PROVISIONING')).toBe(false);
    expect(isTerminalStage('VERIFYING')).toBe(false);
  });
});

describe('stepsBeforeLaunch', () => {
  it('renders every server-sent step as not started — nothing spins before the customer presses Deploy to AWS', () => {
    const rows = stepsBeforeLaunch(['AWS_SETUP', 'RELAY_CONNECT', 'READY']);
    expect(rows.map((row) => row.state)).toEqual(['waiting', 'waiting', 'waiting']);
    expect(rows[0]!.label).toBe('AWS setup');
  });

  it('renders no rows when an older API omits steps', () => {
    expect(stepsBeforeLaunch(undefined)).toEqual([]);
  });

  it('the pre-launch headline never claims AWS is already at work', () => {
    expect(PRE_LAUNCH_HEADLINE.body).not.toMatch(/is creating/);
    expect(STAGE_HEADLINE.WAITING_FOR_AWS.body).toMatch(/is creating/);
  });
});

describe('stepsFromStatus', () => {
  it('renders no rows (instead of throwing) when an older API omits steps/step — the mixed-version rollout window', () => {
    expect(stepsFromStatus({ steps: undefined, step: undefined, stage: 'PROVISIONING' })).toEqual([]);
    expect(stepsFromStatus({ steps: FULL_STEPS, step: undefined, stage: 'PROVISIONING' })).toEqual([]);
  });

  it('uses the server-sent `steps` list verbatim, in order, without re-sorting or re-filtering', () => {
    const rendered = stepsFromStatus({ steps: NO_REDIS_STEPS, step: 'NETWORK', stage: 'PROVISIONING' });
    expect(rendered.map((step) => step.key)).toEqual(NO_REDIS_STEPS);
  });

  it('REDIS is present only when the server included it in `steps`', () => {
    const withRedis = stepsFromStatus({ steps: FULL_STEPS, step: 'REDIS', stage: 'PROVISIONING' });
    expect(withRedis.some((step) => step.key === 'REDIS')).toBe(true);

    const withoutRedis = stepsFromStatus({ steps: NO_REDIS_STEPS, step: 'APPLICATION', stage: 'PROVISIONING' });
    expect(withoutRedis.some((step) => step.key === 'REDIS')).toBe(false);
  });

  it('DATABASE_STORAGE is skipped entirely when neither database nor storage is required', () => {
    const rendered = stepsFromStatus({ steps: NO_DB_NO_REDIS_STEPS, step: 'NETWORK', stage: 'PROVISIONING' });
    expect(rendered.some((step) => step.key === 'DATABASE_STORAGE')).toBe(false);
  });

  it('steps before the active one are done, the active one is current, later ones wait', () => {
    expect(stateOf(FULL_STEPS, 'DATABASE_STORAGE', 'PROVISIONING', 'NETWORK')).toBe('done');
    expect(stateOf(FULL_STEPS, 'DATABASE_STORAGE', 'PROVISIONING', 'DATABASE_STORAGE')).toBe('current');
    expect(stateOf(FULL_STEPS, 'DATABASE_STORAGE', 'PROVISIONING', 'REDIS')).toBe('waiting');
    expect(stateOf(FULL_STEPS, 'DATABASE_STORAGE', 'PROVISIONING', 'READY')).toBe('waiting');
  });

  it('the active step label is the in-progress copy, not the pending or done copy', () => {
    const rendered = stepsFromStatus({ steps: FULL_STEPS, step: 'DATABASE_STORAGE', stage: 'PROVISIONING' });
    const active = rendered.find((step) => step.key === 'DATABASE_STORAGE')!;
    expect(active.label).toBe('Creating database & storage');
    const waiting = rendered.find((step) => step.key === 'REDIS')!;
    expect(waiting.label).toBe('Redis cache');
    const done = rendered.find((step) => step.key === 'NETWORK')!;
    expect(done.label).toBe('Network created');
  });

  it('FAILED: the interrupted step gets the attention state, not current — later steps still wait', () => {
    expect(stateOf(FULL_STEPS, 'AWS_SETUP', 'FAILED', 'AWS_SETUP')).toBe('attention');
    expect(stateOf(FULL_STEPS, 'DATABASE_STORAGE', 'FAILED', 'NETWORK')).toBe('done');
    expect(stateOf(FULL_STEPS, 'DATABASE_STORAGE', 'FAILED', 'DATABASE_STORAGE')).toBe('attention');
    expect(stateOf(FULL_STEPS, 'DATABASE_STORAGE', 'FAILED', 'REDIS')).toBe('waiting');
    // Still mid-sentence copy, not the completed form — the step never finished.
    const rendered = stepsFromStatus({ steps: FULL_STEPS, step: 'DATABASE_STORAGE', stage: 'FAILED' });
    expect(rendered.find((step) => step.key === 'DATABASE_STORAGE')!.label).toBe('Creating database & storage');
  });

  it('READY: every step renders done, with done copy', () => {
    const rendered = stepsFromStatus({ steps: FULL_STEPS, step: 'READY', stage: 'READY' });
    expect(rendered.every((step) => step.state === 'done')).toBe(true);
    expect(rendered.find((step) => step.key === 'HEALTH_CHECK')!.label).toBe('Health checks passed');
    expect(rendered.find((step) => step.key === 'READY')!.label).toBe('Ready');
  });

  it('WAITING_FOR_AWS/CONNECTING/VERIFYING transitions carry the right active step', () => {
    expect(stateOf(FULL_STEPS, 'AWS_SETUP', 'WAITING_FOR_AWS', 'AWS_SETUP')).toBe('current');
    expect(stateOf(FULL_STEPS, 'RELAY_CONNECT', 'CONNECTING', 'AWS_SETUP')).toBe('done');
    expect(stateOf(FULL_STEPS, 'RELAY_CONNECT', 'CONNECTING', 'RELAY_CONNECT')).toBe('current');
    expect(stateOf(FULL_STEPS, 'HEALTH_CHECK', 'VERIFYING', 'HEALTH_CHECK')).toBe('current');
    expect(stateOf(FULL_STEPS, 'TLS', 'VERIFYING', 'HEALTH_CHECK')).toBe('done');
    expect(stateOf(FULL_STEPS, 'TLS', 'VERIFYING', 'TLS')).toBe('current');
  });
});

describe('formatDurationRange', () => {
  it('renders a genuine range in whole minutes with an en dash', () => {
    expect(formatDurationRange({ min: 180, max: 480 })).toBe('3–8 minutes');
  });

  it('rounds 59s to 1 minute', () => {
    expect(formatDurationRange({ min: 59, max: 59 })).toBe('about 1 minute');
  });

  it('rounds 60s to exactly 1 minute', () => {
    expect(formatDurationRange({ min: 60, max: 60 })).toBe('about 1 minute');
  });

  it('rounds 90s up to 2 minutes (round-half-up)', () => {
    expect(formatDurationRange({ min: 90, max: 90 })).toBe('about 2 minutes');
  });

  it('a value that rounds to 0 minutes is floored to a minimum of 1, never 0', () => {
    expect(formatDurationRange({ min: 10, max: 10 })).toBe('about 1 minute');
  });

  it('a sub-minute min still floors to 1 minute, never 0', () => {
    expect(formatDurationRange({ min: 30, max: 420 })).toBe('1–7 minutes');
  });

  it('collapses to "about N minutes" once rounding makes min and max equal', () => {
    expect(formatDurationRange({ min: 61, max: 65 })).toBe('about 1 minute');
  });
});

describe('formatElapsedSeconds', () => {
  it('renders under a minute as seconds', () => {
    expect(formatElapsedSeconds(18)).toBe('18s');
    expect(formatElapsedSeconds(0)).toBe('0s');
    expect(formatElapsedSeconds(59)).toBe('59s');
  });

  it('renders a minute or more (under an hour) as minutes and seconds', () => {
    expect(formatElapsedSeconds(60)).toBe('1m 0s');
    expect(formatElapsedSeconds(272)).toBe('4m 32s');
  });

  it('renders an hour or more as hours and minutes, dropping seconds', () => {
    expect(formatElapsedSeconds(3600)).toBe('1h 0m');
    expect(formatElapsedSeconds(3600 + 4 * 60)).toBe('1h 4m');
  });
});

// A removed deployment keeps the stage it last earned, so every surface that
// renders a stage has to ask for the removed copy first — the canary showed a
// deleted deployment reading "Verifying · Running health checks" while its
// infrastructure was already gone.
describe('removedProgress', () => {
  it('describes a deployment that is being removed', () => {
    expect(removedProgress('DELETING')?.title).toBe('Removing deployment');
  });

  it('describes a deployment that is gone', () => {
    const removed = removedProgress('DELETED');
    expect(removed?.title).toBe('Deployment removed');
    expect(removed?.body).toContain('no longer running');
  });

  it('is null for every live state, so the stage keeps rendering', () => {
    for (const state of ['NOT_INSTALLED', 'WAITING_FOR_RELAY', 'INSTALLING', 'HEALTHY', 'UPDATE_AVAILABLE', 'FAILED']) {
      expect(removedProgress(state)).toBeNull();
    }
  });
});

// HTTPS is the one step Deployz cannot finish on its own. The canary watched
// "Setting up HTTPS (in progress)" count past an hour on a healthy
// deployment that was simply waiting for a domain.
describe('stepWaitingOnInput', () => {
  it('is true only for the HTTPS step while a domain is still needed', () => {
    expect(stepWaitingOnInput({ step: 'TLS', needsDomainSetup: true })).toBe(true);
    expect(stepWaitingOnInput({ step: 'TLS', needsDomainSetup: false })).toBe(false);
  });

  it('never claims another step is waiting on someone', () => {
    for (const step of ['NETWORK', 'DATABASE_STORAGE', 'APPLICATION', 'HEALTH_CHECK', 'READY'] as const) {
      expect(stepWaitingOnInput({ step, needsDomainSetup: true })).toBe(false);
    }
    expect(stepWaitingOnInput({ step: undefined, needsDomainSetup: true })).toBe(false);
  });

  it('names what it is waiting for, with no duration or nudge', () => {
    expect(AWAITING_DOMAIN_STEP_DETAIL).toContain('custom domain');
    expect(AWAITING_DOMAIN_STEP_DETAIL).not.toMatch(/minute|second|usual/i);
  });
});

// A removed deployment keeps whatever stage it last earned. These tests pin
// the removed vocabulary and the guard functions so a removing or removed
// deployment never reads as a failure.
describe('REMOVED_PROGRESS', () => {
  it('describes a deployment that is being removed', () => {
    expect(REMOVED_PROGRESS.DELETING.title).toBe('Removing deployment');
    expect(REMOVED_PROGRESS.DELETING.body).toContain("Deployz is removing this deployment's infrastructure");
  });

  it('describes a deployment that has been removed', () => {
    expect(REMOVED_PROGRESS.DELETED.title).toBe('Deployment removed');
    expect(REMOVED_PROGRESS.DELETED.body).toContain('no longer running');
  });

  it('never uses FAILED vocabulary for removed states', () => {
    expect(REMOVED_PROGRESS.DELETING.title).not.toMatch(/FAILED/i);
    expect(REMOVED_PROGRESS.DELETING.body).not.toMatch(/FAILED/i);
    expect(REMOVED_PROGRESS.DELETED.title).not.toMatch(/FAILED/i);
    expect(REMOVED_PROGRESS.DELETED.body).not.toMatch(/FAILED/i);
  });
});

describe('removed-state guards', () => {
  it('removedProgress returns the removed copy only for DELETING and DELETED', () => {
    expect(removedProgress('DELETING')).toEqual(REMOVED_PROGRESS.DELETING);
    expect(removedProgress('DELETED')).toEqual(REMOVED_PROGRESS.DELETED);
    expect(removedProgress('NOT_INSTALLED')).toBeNull();
    expect(removedProgress('HEALTHY')).toBeNull();
  });

  it('isTerminalStage does not treat removed states as terminal', () => {
    expect(isTerminalStage('DELETING' as unknown as DeploymentStage)).toBe(false);
    expect(isTerminalStage('DELETED' as unknown as DeploymentStage)).toBe(false);
  });

  const baseStatus: VendorDeploymentStatus = {
    stage: 'READY',
    updatedAt: '2026-09-01T00:00:00.000Z',
    currentActivity: 'Live and healthy.',
    step: 'READY',
    steps: ['READY'],
    typicalDurationSeconds: null,
    takingLongerThanUsual: false,
    stepStartedAt: null,
    stepTimings: [],
    statusUpdatesUnavailable: false,
    needsDomainSetup: false,
    components: [],
    relay: { connected: true, lastSeenAt: null },
    job: null,
    aws: { stackStatus: null },
    health: {
      status: 'HEALTHY',
      layers: { infrastructure: 'UNKNOWN', rollout: null, targets: null, http: null, relay: 'CONNECTED' },
    },
    url: 'https://app.example.com',
    failure: null,
  };

  function heroInput(overrides: Partial<HeroInput> = {}): HeroInput {
    return {
      state: 'HEALTHY',
      currentReleaseId: 'rel-1',
      version: '1.2.0',
      cleanupState: null,
      customerName: 'Acme',
      relayStatus: 'CONNECTED',
      jobs: [],
      deploymentStatus: baseStatus,
      ...overrides,
    };
  }

  it('a removing deployment derives the removing hero, not the failure hero', () => {
    const hero = deriveHero(heroInput({ state: 'DELETING' }));
    expect(hero.kind).toBe('deleting');
    expect(hero.title).toBe(REMOVED_PROGRESS.DELETING.title);
    expect(hero.tone).toBe('progress');
  });

  it('a removed deployment derives the removed hero, not the failure hero', () => {
    const hero = deriveHero(heroInput({ state: 'DELETED' }));
    expect(hero.kind).toBe('deleted');
    expect(hero.title).toBe(REMOVED_PROGRESS.DELETED.title);
    expect(hero.tone).toBe('neutral');
  });
});

// The live-progress-feedback pure formatters shared by LiveStepDetail (the
// customer install page's ticking active-step detail) and RecentActivity.
// nowMs is always passed in explicitly rather than read from Date.now(), so
// these stay pure and the ticker's own ticks are the only source of "now".

describe('elapsedLabel', () => {
  const now = Date.parse('2026-09-18T00:10:00.000Z');

  it('formats the time since stepStartedAt using formatElapsedSeconds', () => {
    expect(elapsedLabel('2026-09-18T00:05:48.000Z', now)) // 4m 12s earlier
      .toBe('4m 12s');
  });

  it('is null when stepStartedAt is missing — never invents an elapsed duration', () => {
    expect(elapsedLabel(null, now)).toBeNull();
    expect(elapsedLabel(undefined, now)).toBeNull();
  });

  it('is null for an unparsable timestamp', () => {
    expect(elapsedLabel('not-a-date', now)).toBeNull();
  });
});

describe('liveDurationLine', () => {
  it('composes the typical-range line with the live elapsed time', () => {
    expect(
      liveDurationLine({
        takingLongerThanUsual: false,
        typicalDurationSeconds: { min: 180, max: 600 },
        elapsed: '4m 12s',
      }),
    ).toBe('Usually takes 3–10 minutes · 4m 12s elapsed');
  });

  it('uses the exact reassuring sentence when taking longer than usual, with elapsed appended', () => {
    expect(
      liveDurationLine({
        takingLongerThanUsual: true,
        typicalDurationSeconds: { min: 180, max: 600 },
        elapsed: '14m 2s',
      }),
    ).toBe(`${TAKING_LONGER_MESSAGE} · 14m 2s elapsed`);
  });

  it('is elapsed alone when there is no typical range and it is not taking longer than usual', () => {
    expect(
      liveDurationLine({ takingLongerThanUsual: false, typicalDurationSeconds: null, elapsed: '4m 12s' }),
    ).toBe('4m 12s elapsed');
  });

  it('is the base line alone when elapsed is unknown', () => {
    expect(
      liveDurationLine({ takingLongerThanUsual: false, typicalDurationSeconds: { min: 180, max: 600 }, elapsed: null }),
    ).toBe('Usually takes 3–10 minutes');
    expect(
      liveDurationLine({ takingLongerThanUsual: true, typicalDurationSeconds: null, elapsed: null }),
    ).toBe(TAKING_LONGER_MESSAGE);
  });

  it('is undefined when nothing is known at all', () => {
    expect(
      liveDurationLine({ takingLongerThanUsual: false, typicalDurationSeconds: null, elapsed: null }),
    ).toBeUndefined();
  });
});

describe('checkedLabel', () => {
  it('is null until the first client fetch completes', () => {
    expect(checkedLabel(null, Date.now())).toBeNull();
  });

  it('reads "Checked just now" under 5 seconds', () => {
    const checkedAt = Date.now();
    expect(checkedLabel(checkedAt, checkedAt + 4_000)).toBe('Checked just now');
  });

  it('reads seconds between 5 and 59', () => {
    const checkedAt = Date.now();
    expect(checkedLabel(checkedAt, checkedAt + 12_000)).toBe('Checked 12 seconds ago');
    expect(checkedLabel(checkedAt, checkedAt + 6_000)).toBe('Checked 6 seconds ago');
  });

  it('reads minutes once a minute has passed', () => {
    const checkedAt = Date.now();
    expect(checkedLabel(checkedAt, checkedAt + 60_000)).toBe('Checked 1 minute ago');
    expect(checkedLabel(checkedAt, checkedAt + 5 * 60_000)).toBe('Checked 5 minutes ago');
  });
});

describe('recentActivityTimeLabel', () => {
  it('reads "just now" under a minute', () => {
    const at = new Date('2026-09-18T00:00:00.000Z').toISOString();
    expect(recentActivityTimeLabel(at, Date.parse(at) + 30_000)).toBe('just now');
  });

  it('reads a compact "N min ago" for minutes', () => {
    const at = new Date('2026-09-18T00:00:00.000Z').toISOString();
    expect(recentActivityTimeLabel(at, Date.parse(at) + 2 * 60_000)).toBe('2 min ago');
  });
});
