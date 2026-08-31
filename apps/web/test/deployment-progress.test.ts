import { describe, expect, it } from 'vitest';

import {
  customerSteps,
  isTerminalStage,
  stageRank,
  type ProgressStepState,
} from '../src/lib/deployment-progress';
import type { DeploymentStage } from '@deployz/contracts';

// Locks the client-side vocabulary map for the server-derived deployment
// stage (see apps/api/src/deployment-status.ts): the client only ever
// translates a received `stage` into display steps, never infers lifecycle
// itself, so this module's pure functions are the entire surface worth
// testing here.

function stepState(stage: DeploymentStage, key: string): ProgressStepState {
  const step = customerSteps(stage).find((candidate) => candidate.key === key);
  if (!step) throw new Error(`no ${key} step for ${stage}`);
  return step.state;
}

function stepLabel(stage: DeploymentStage, key: string): string {
  const step = customerSteps(stage).find((candidate) => candidate.key === key);
  if (!step) throw new Error(`no ${key} step for ${stage}`);
  return step.label;
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

describe('customerSteps', () => {
  it('before the relay is talking (WAITING_FOR_AWS/CONNECTING), AWS setup and the Deployz connection are two distinct steps', () => {
    for (const stage of ['WAITING_FOR_AWS', 'CONNECTING'] as const) {
      expect(customerSteps(stage).map((step) => step.key)).toEqual([
        'aws',
        'connect',
        'infra',
        'health',
        'ready',
      ]);
    }
  });

  it('from PROVISIONING onward (incl. FAILED), the connect step has collapsed away entirely', () => {
    for (const stage of ['PROVISIONING', 'VERIFYING', 'READY', 'FAILED'] as const) {
      expect(customerSteps(stage).map((step) => step.key)).toEqual(['aws', 'infra', 'health', 'ready']);
    }
  });

  it('WAITING_FOR_AWS: AWS setup is the only current step', () => {
    expect(stepState('WAITING_FOR_AWS', 'aws')).toBe('current');
    expect(stepState('WAITING_FOR_AWS', 'connect')).toBe('waiting');
    expect(stepState('WAITING_FOR_AWS', 'infra')).toBe('waiting');
    expect(stepState('WAITING_FOR_AWS', 'health')).toBe('waiting');
    expect(stepState('WAITING_FOR_AWS', 'ready')).toBe('waiting');
  });

  it('CONNECTING: AWS setup has collapsed into a single done step, connect is current', () => {
    expect(stepState('CONNECTING', 'aws')).toBe('done');
    expect(stepState('CONNECTING', 'connect')).toBe('current');
    expect(stepState('CONNECTING', 'infra')).toBe('waiting');
  });

  it('PROVISIONING: infrastructure is current, health/ready still wait', () => {
    expect(stepState('PROVISIONING', 'aws')).toBe('done');
    expect(stepState('PROVISIONING', 'infra')).toBe('current');
    expect(stepLabel('PROVISIONING', 'infra')).toBe('Creating infrastructure');
    expect(stepState('PROVISIONING', 'health')).toBe('waiting');
    expect(stepState('PROVISIONING', 'ready')).toBe('waiting');
  });

  it('VERIFYING: infrastructure has finished and its label shifts tense to the completed form', () => {
    expect(stepState('VERIFYING', 'infra')).toBe('done');
    expect(stepLabel('VERIFYING', 'infra')).toBe('Infrastructure created');
    expect(stepState('VERIFYING', 'health')).toBe('current');
    expect(stepLabel('VERIFYING', 'health')).toBe('Running health checks');
    expect(stepState('VERIFYING', 'ready')).toBe('waiting');
  });

  it('READY: every step is done and health/ready labels shift tense to the completed form', () => {
    expect(stepState('READY', 'infra')).toBe('done');
    expect(stepState('READY', 'health')).toBe('done');
    expect(stepLabel('READY', 'health')).toBe('Health checks passed');
    expect(stepState('READY', 'ready')).toBe('done');
    expect(stepLabel('READY', 'ready')).toBe('Application ready');
  });

  it('FAILED: infrastructure gets the attention state, health/ready fall back to waiting', () => {
    expect(stepState('FAILED', 'aws')).toBe('done');
    expect(stepState('FAILED', 'infra')).toBe('attention');
    // Still mid-sentence, not "created" — the step never finished.
    expect(stepLabel('FAILED', 'infra')).toBe('Creating infrastructure');
    expect(stepState('FAILED', 'health')).toBe('waiting');
    expect(stepState('FAILED', 'ready')).toBe('waiting');
  });
});
