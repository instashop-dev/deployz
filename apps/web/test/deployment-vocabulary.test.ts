import { describe, expect, it } from 'vitest';

import {
  DEPLOYMENT_STATE_BADGE,
  DEPLOYMENT_STATE_LABELS,
  DEPLOYMENT_STATES,
  eventFailureReason,
  eventFamily,
  eventResultLabel,
  eventTypeLabel,
} from '../src/lib/deployment-vocabulary';

// Locks the §46/§65 guardrail: the fleet surfaces use ONLY the 9
// product-vocabulary states and jargon-free event labels — no raw
// AWS/CFN/ECS/ALB/IAM/Lambda/VPC terms reach the UI edge.

const JARGON = /\b(CloudFormation|IAM|ECS|ALB|Lambda|VPC|CFN)\b/i;

describe('§46 deployment states', () => {
  it('defines exactly the 9 product-vocabulary states', () => {
    expect(DEPLOYMENT_STATES).toEqual([
      'NOT_INSTALLED',
      'INSTALLING',
      'HEALTHY',
      'UPDATING',
      'UPDATE_AVAILABLE',
      'FAILED',
      'DISCONNECTED',
      'DELETING',
      'DELETED',
    ]);
  });

  it('maps every state to a non-empty, jargon-free label', () => {
    for (const state of DEPLOYMENT_STATES) {
      const label = DEPLOYMENT_STATE_LABELS[state];
      expect(label, `label for ${state}`).toBeTruthy();
      expect(label, `label for ${state}`).not.toMatch(JARGON);
    }
  });

  it('uses the plan §46 product wording for the key states', () => {
    expect(DEPLOYMENT_STATE_LABELS.HEALTHY).toBe('Healthy');
    expect(DEPLOYMENT_STATE_LABELS.INSTALLING).toBe('Installing');
    expect(DEPLOYMENT_STATE_LABELS.FAILED).toBe('Failed');
    expect(DEPLOYMENT_STATE_LABELS.UPDATE_AVAILABLE).toBe('Update available');
  });

  it('marks FAILED and DISCONNECTED as destructive', () => {
    expect(DEPLOYMENT_STATE_BADGE.FAILED).toBe('destructive');
    expect(DEPLOYMENT_STATE_BADGE.DISCONNECTED).toBe('destructive');
  });
});

describe('§65 event-type labels', () => {
  it('classifies the six §40 families', () => {
    expect(eventFamily('deploy.state.updating')).toBe('deploy');
    expect(eventFamily('rollback.restore')).toBe('rollback');
    expect(eventFamily('config.write')).toBe('config');
    expect(eventFamily('health.report')).toBe('health');
    expect(eventFamily('install.state.healthy')).toBe('install');
    expect(eventFamily('destroy.state.started')).toBe('destroy');
    expect(eventFamily('billing.usage')).toBeNull();
  });

  it('maps known workflow event types to human labels', () => {
    expect(eventTypeLabel('deploy.state.updating')).toBe('Update started');
    expect(eventTypeLabel('rollback.restore')).toBe('Previous version restored');
    expect(eventTypeLabel('install.state.healthy')).toBe('Installed and healthy');
    expect(eventTypeLabel('deploy.state.update-available')).toBe('Update available');
  });

  it('falls back to a family label for an unknown type (never raw)', () => {
    expect(eventTypeLabel('health.report')).toBe('Health');
    expect(eventTypeLabel('destroy.state.started')).toBe('Teardown');
  });

  it('classifies the redis family and maps its known event types', () => {
    expect(eventFamily('redis.provision.started')).toBe('redis');
    expect(eventTypeLabel('redis.provision.started')).toBe('Setting up cache');
    expect(eventTypeLabel('redis.provision.succeeded')).toBe('Cache ready');
    expect(eventTypeLabel('redis.provision.failed')).toBe('Cache setup failed');
  });

  it('produces no raw AWS terms for any known or fallback label', () => {
    for (const type of [
      'install.preflight.region',
      'install.preflight.scp',
      'install.relay.contact',
      'install.state.installing',
      'install.relay.health',
      'install.state.healthy',
      'deploy.preflight',
      'deploy.state.updating',
      'deploy.migration',
      'deploy.ecs-update',
      'deploy.infra-upgrade',
      'deploy.health',
      'deploy.state.healthy',
      'deploy.state.update-available',
      'rollback.state.updating',
      'rollback.disclosure',
      'rollback.restore',
      'rollback.health',
      'rollback.state.healthy',
      'config.validate',
      'config.write',
      'config.health',
      'config.state.healthy',
      'destroy.state.started',
      'health.report',
    ]) {
      expect(eventTypeLabel(type), `label for ${type}`).not.toMatch(JARGON);
    }
  });
});

describe('§62 event result labels', () => {
  it('maps results to jargon-free labels', () => {
    expect(eventResultLabel('ok')).toBe('Succeeded');
    expect(eventResultLabel('passed')).toBe('Succeeded');
    expect(eventResultLabel('success')).toBe('Succeeded');
    expect(eventResultLabel('skipped')).toBe('Skipped');
    expect(eventResultLabel('failed:MIGRATION_FAILED')).toBe('Failed');
    expect(eventResultLabel('failure')).toBe('Failed');
    expect(eventResultLabel(null)).toBeNull();
  });

  it('renders no badge for a pending result — a historical request is a fact, not ongoing state', () => {
    expect(eventResultLabel('pending')).toBeNull();
  });
});

describe('eventFailureReason', () => {
  it('surfaces payload.error for a failed result', () => {
    expect(eventFailureReason('failed:MIGRATION_FAILED', { error: 'Column already exists' })).toBe(
      'Column already exists',
    );
    // The API writes job-result events with the bare 'failure' result — the
    // form every relay-reported failure actually reaches the feed as.
    expect(eventFailureReason('failure', { error: 'No ECS service found in stack "deployz-app"' })).toBe(
      'No ECS service found in stack "deployz-app"',
    );
  });

  it('returns null for a non-failed result even with an error payload', () => {
    expect(eventFailureReason('ok', { error: 'stale leftover text' })).toBeNull();
    expect(eventFailureReason(null, { error: 'stale leftover text' })).toBeNull();
  });

  it('returns null for a failed result with no usable payload.error', () => {
    expect(eventFailureReason('failed:MIGRATION_FAILED', {})).toBeNull();
    expect(eventFailureReason('failed:MIGRATION_FAILED', { error: '' })).toBeNull();
    expect(eventFailureReason('failed:MIGRATION_FAILED', { error: '   ' })).toBeNull();
    expect(eventFailureReason('failed:MIGRATION_FAILED', { error: 42 })).toBeNull();
  });
});
