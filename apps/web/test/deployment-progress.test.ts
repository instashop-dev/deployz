import { describe, expect, it } from 'vitest';

import {
  formatDurationRange,
  formatElapsedSeconds,
  isTerminalStage,
  stageRank,
  stepsFromStatus,
  type ProgressStepState,
} from '../src/lib/deployment-progress';
import type { DeploymentStage, DeploymentStep } from '@deployz/contracts';

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
