import { describe, expect, it } from 'vitest';

import { JARGON_PATTERN } from '@deployz/copy-map';

import { activityFailureSummary, activityRawError, newestFirst } from '../src/lib/activity';
import type { ActivityEvent } from '../src/lib/deployments';

function event(overrides: Partial<ActivityEvent>): ActivityEvent {
  return {
    occurredAt: '2026-09-01T07:00:00.000Z',
    eventType: 'deploy.requested',
    actorType: 'user',
    result: null,
    previousState: null,
    requestedState: null,
    payload: {},
    ...overrides,
  };
}

describe('newestFirst', () => {
  it('reverses the API order so the latest event leads', () => {
    const sorted = newestFirst([
      event({ eventType: 'install.requested', occurredAt: '2026-09-01T07:24:00.000Z' }),
      event({ eventType: 'install.completed', occurredAt: '2026-09-01T07:31:00.000Z' }),
      event({ eventType: 'health.reported', occurredAt: '2026-09-01T07:30:00.000Z' }),
    ]);
    expect(sorted.map((item) => item.eventType)).toEqual([
      'install.completed',
      'health.reported',
      'install.requested',
    ]);
  });

  it('keeps the API order for events with the same timestamp, later-written first', () => {
    const sorted = newestFirst([
      event({ eventType: 'a', occurredAt: '2026-09-01T07:00:00.000Z' }),
      event({ eventType: 'b', occurredAt: '2026-09-01T07:00:00.000Z' }),
    ]);
    expect(sorted.map((item) => item.eventType)).toEqual(['b', 'a']);
  });

  it('does not mutate its input', () => {
    const events = [
      event({ eventType: 'a', occurredAt: '2026-09-01T07:00:00.000Z' }),
      event({ eventType: 'b', occurredAt: '2026-09-01T08:00:00.000Z' }),
    ];
    newestFirst(events);
    expect(events[0]!.eventType).toBe('a');
  });
});

describe('activityFailureSummary', () => {
  it('uses the jargon-free failure-code description at the top level', () => {
    const summary = activityFailureSummary(
      event({
        eventType: 'install.failed',
        result: 'failure',
        payload: {
          failureCode: 'DATABASE_CREATE_FAILED',
          error: 'Stack rolled back: AWS::RDS::DBInstance ApplicationDatabase CREATE_FAILED',
        },
      }),
    );
    expect(summary).toBeTruthy();
    expect(summary).not.toMatch(JARGON_PATTERN);
  });

  it('shows nothing at the top level when the failure carries no classified code', () => {
    expect(
      activityFailureSummary(
        event({ eventType: 'install.failed', result: 'failure', payload: { error: 'AWS::ECS::Service failed' } }),
      ),
    ).toBeNull();
  });

  it('keeps the raw relay error available for the technical disclosure', () => {
    expect(
      activityRawError(
        event({ eventType: 'install.failed', result: 'failure', payload: { error: 'raw error text' } }),
      ),
    ).toBe('raw error text');
    expect(activityRawError(event({ result: 'success', payload: { error: 'ignored' } }))).toBeNull();
  });
});
