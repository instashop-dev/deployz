import { describe, expect, it } from 'vitest';

import { JARGON_PATTERN } from '@deployz/copy-map';

import type { ConnectionState, VendorConnection } from '../src/lib/admin';
import {
  ADMIN_RELAY_STALE_AFTER_MS,
  deriveConnectionState,
} from '../src/lib/admin';
import {
  ANALYSIS_STATUS_LABEL,
  AUDIT_ACTION_OPTIONS,
  CONNECTION_STATE_BADGE,
  CONNECTION_STATE_DOT,
  CONNECTION_STATE_LABEL,
  CONNECTION_STATE_PROBLEM,
  COMPATIBILITY_STATUS_LABEL,
  JOB_PRESENTATION_BADGE,
  JOB_PRESENTATION_LABEL,
  PILOT_FAILURE_LABELS,
  STUCK_BADGE,
  STUCK_LABEL,
  VENDOR_CONNECTION_BADGE,
  VENDOR_CONNECTION_LABEL,
  adminEventTypeLabel,
  analysisStatusLabel,
  auditOutcomeLabel,
  compatibilityStatusLabel,
  jobPresentationState,
  pilotFailureLabel,
} from '../src/lib/admin-vocabulary';

const CONNECTION_STATES: ConnectionState[] = [
  'CONNECTED',
  'DEGRADED',
  'DISCONNECTED',
  'BOOTSTRAP_INCOMPLETE',
  'UNKNOWN',
];

const VENDOR_CONNECTIONS: VendorConnection[] = ['CONNECTED', 'DISCONNECTED', 'NONE', 'UNKNOWN'];

describe('connection state vocabulary', () => {
  it('every connection state has a label, badge, and dot', () => {
    for (const state of CONNECTION_STATES) {
      expect(CONNECTION_STATE_LABEL[state], `label for ${state}`).toBeTruthy();
      expect(CONNECTION_STATE_BADGE[state], `badge for ${state}`).toBeTruthy();
      expect(CONNECTION_STATE_DOT[state], `dot for ${state}`).toBeTruthy();
    }
  });

  it('CONNECTED is a positive badge; DISCONNECTED is destructive', () => {
    expect(CONNECTION_STATE_BADGE.CONNECTED).toBe('default');
    expect(CONNECTION_STATE_BADGE.DISCONNECTED).toBe('destructive');
  });

  it('every non-CONNECTED state has a problem callout with heading and body', () => {
    for (const state of CONNECTION_STATES.filter((s) => s !== 'CONNECTED')) {
      const problem = CONNECTION_STATE_PROBLEM[state as Exclude<ConnectionState, 'CONNECTED'>];
      expect(problem.heading, `heading for ${state}`).toBeTruthy();
      expect(problem.body, `body for ${state}`).toBeTruthy();
    }
  });

  it('every vendor connection summary value has a label and badge', () => {
    for (const state of VENDOR_CONNECTIONS) {
      expect(VENDOR_CONNECTION_LABEL[state], `label for ${state}`).toBeTruthy();
      expect(VENDOR_CONNECTION_BADGE[state], `badge for ${state}`).toBeTruthy();
    }
  });
});

describe('deriveConnectionState (client mirror of apps/api/src/admin/queries.ts)', () => {
  const base = { relayStatus: 'UNKNOWN' as const, lastHealthAt: null, installationId: null, state: 'NOT_INSTALLED' as const };

  it('DISCONNECTED relay always yields DISCONNECTED', () => {
    expect(deriveConnectionState({ ...base, relayStatus: 'DISCONNECTED' })).toBe('DISCONNECTED');
  });

  it('CONNECTED relay with a fresh heartbeat yields CONNECTED', () => {
    const now = Date.now();
    expect(
      deriveConnectionState(
        { ...base, relayStatus: 'CONNECTED', lastHealthAt: new Date(now - 60_000).toISOString() },
        now,
      ),
    ).toBe('CONNECTED');
  });

  it('CONNECTED relay with a stale heartbeat yields DEGRADED', () => {
    const now = Date.now();
    expect(
      deriveConnectionState(
        {
          ...base,
          relayStatus: 'CONNECTED',
          lastHealthAt: new Date(now - ADMIN_RELAY_STALE_AFTER_MS - 60_000).toISOString(),
        },
        now,
      ),
    ).toBe('DEGRADED');
  });

  it('no installation and no relay yields BOOTSTRAP_INCOMPLETE', () => {
    expect(deriveConnectionState({ ...base, installationId: null })).toBe('BOOTSTRAP_INCOMPLETE');
  });

  it('WAITING_FOR_RELAY state yields BOOTSTRAP_INCOMPLETE even with an installation id', () => {
    expect(
      deriveConnectionState({ ...base, installationId: 'inst-1', state: 'WAITING_FOR_RELAY' }),
    ).toBe('BOOTSTRAP_INCOMPLETE');
  });

  it('an installed deployment with an UNKNOWN relay and no WAITING state yields UNKNOWN', () => {
    expect(deriveConnectionState({ ...base, installationId: 'inst-1', state: 'HEALTHY' })).toBe('UNKNOWN');
  });
});

describe('STUCK presentation', () => {
  it('STUCK always wins over the underlying active state', () => {
    expect(jobPresentationState('RUNNING', true)).toBe('STUCK');
    expect(jobPresentationState('QUEUED', true)).toBe('STUCK');
  });

  it('maps non-stuck states to their own presentation', () => {
    expect(jobPresentationState('REQUESTED', false)).toBe('QUEUED');
    expect(jobPresentationState('QUEUED', false)).toBe('QUEUED');
    expect(jobPresentationState('WAITING', false)).toBe('RUNNING');
    expect(jobPresentationState('RUNNING', false)).toBe('RUNNING');
    expect(jobPresentationState('SUCCEEDED', false)).toBe('SUCCEEDED');
    expect(jobPresentationState('SUCCESS', false)).toBe('SUCCEEDED');
    expect(jobPresentationState('CANCELLED', false)).toBe('CANCELLED');
    expect(jobPresentationState('FAILED', false)).toBe('FAILED');
  });

  it('every presentation state has a label and badge', () => {
    const states = ['QUEUED', 'RUNNING', 'STUCK', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
    for (const state of states) {
      expect(JOB_PRESENTATION_LABEL[state], `label for ${state}`).toBeTruthy();
      expect(JOB_PRESENTATION_BADGE[state], `badge for ${state}`).toBeTruthy();
    }
  });

  it('STUCK label and badge match the shared constants', () => {
    expect(JOB_PRESENTATION_LABEL.STUCK).toBe(STUCK_LABEL);
    expect(JOB_PRESENTATION_BADGE.STUCK).toBe(STUCK_BADGE);
    expect(STUCK_BADGE).toBe('destructive');
  });
});

describe('application analysis / compatibility labels', () => {
  it('every analysis status has a label', () => {
    for (const status of ['PENDING', 'ANALYZING', 'COMPLETE', 'FAILED']) {
      expect(ANALYSIS_STATUS_LABEL[status], `label for ${status}`).toBeTruthy();
      expect(analysisStatusLabel(status)).toBe(ANALYSIS_STATUS_LABEL[status]);
    }
  });

  it('every compatibility status has a label; null passes through as null', () => {
    for (const status of ['READY', 'NEEDS_ATTENTION', 'NOT_COMPATIBLE']) {
      expect(COMPATIBILITY_STATUS_LABEL[status], `label for ${status}`).toBeTruthy();
      expect(compatibilityStatusLabel(status)).toBe(COMPATIBILITY_STATUS_LABEL[status]);
    }
    expect(compatibilityStatusLabel(null)).toBeNull();
  });

  it('falls back to the raw value for an unknown status', () => {
    expect(analysisStatusLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
});

describe('admin.* audit event labels', () => {
  it('has a specific label for every action this feature can emit', () => {
    expect(adminEventTypeLabel('admin.support_session.started')).toBe('Started viewing as vendor');
    expect(adminEventTypeLabel('admin.support_session.ended')).toBe('Stopped viewing as vendor');
    expect(adminEventTypeLabel('admin.install.retry_requested')).toBe('Retried install');
    expect(adminEventTypeLabel('admin.rollback.requested')).toBe('Requested rollback');
    expect(adminEventTypeLabel('admin.destroy.force_completed')).toBe('Force-completed disconnect');
    expect(adminEventTypeLabel('admin.relay.reset_requested')).toBe('Reset relay connection');
  });

  it('falls back to a family-derived label for an unrecognized admin.* type', () => {
    expect(adminEventTypeLabel('admin.something.new_thing')).toBe('Something');
  });

  it('every audit action filter option maps to a known event family', () => {
    for (const option of AUDIT_ACTION_OPTIONS) {
      expect(option.value.startsWith('admin.')).toBe(true);
      expect(option.label).toBeTruthy();
    }
  });
});

describe('audit outcome labels', () => {
  it('maps success/failure/unknown results', () => {
    expect(auditOutcomeLabel('success')).toBe('Succeeded');
    expect(auditOutcomeLabel('failure')).toBe('Failed');
    expect(auditOutcomeLabel('failed:SOME_CODE')).toBe('Failed');
    expect(auditOutcomeLabel(null)).toBe('Unknown');
  });
});

describe('pilot-insights failure-code labels', () => {
  it('labels every known release-build code', () => {
    expect(pilotFailureLabel('build_failed')).toBe('Build failed');
    expect(pilotFailureLabel('build_cancelled')).toBe('Build cancelled');
    expect(pilotFailureLabel('build_timeout')).toBe('Build timed out');
    expect(Object.keys(PILOT_FAILURE_LABELS)).toEqual(['build_failed', 'build_cancelled', 'build_timeout']);
  });

  it('resolves §61 install/deploy codes through the shared failure-code copy', () => {
    expect(pilotFailureLabel('PORT_MISMATCH')).toBe('Port conflict');
    expect(pilotFailureLabel('STACK_CREATE_FAILED')).toBeTruthy();
  });

  it('returns null for an unrecognized code so the caller renders it muted', () => {
    expect(pilotFailureLabel('BOOTSTRAP_TIMEOUT')).toBeNull();
    expect(pilotFailureLabel('something_new')).toBeNull();
  });
});

describe('§65 jargon-free parity', () => {
  it('every admin-vocabulary label is jargon-free against the copy-map JARGON_PATTERN', () => {
    for (const state of CONNECTION_STATES) {
      expect(CONNECTION_STATE_LABEL[state]).not.toMatch(JARGON_PATTERN);
    }
    for (const state of CONNECTION_STATES.filter((s) => s !== 'CONNECTED')) {
      const problem = CONNECTION_STATE_PROBLEM[state as Exclude<ConnectionState, 'CONNECTED'>];
      expect(problem.heading).not.toMatch(JARGON_PATTERN);
      expect(problem.body).not.toMatch(JARGON_PATTERN);
    }
    for (const state of VENDOR_CONNECTIONS) {
      expect(VENDOR_CONNECTION_LABEL[state]).not.toMatch(JARGON_PATTERN);
    }
    expect(STUCK_LABEL).not.toMatch(JARGON_PATTERN);
    for (const option of AUDIT_ACTION_OPTIONS) {
      expect(option.label).not.toMatch(JARGON_PATTERN);
    }
    for (const label of Object.values(PILOT_FAILURE_LABELS)) {
      expect(label).not.toMatch(JARGON_PATTERN);
    }
  });
});
