import { describe, expect, it } from 'vitest';

import {
  HEALTH_STATUS_BADGE,
  HEALTH_STATUS_LABEL,
  showHealthBadge,
  showInfrastructureRows,
} from '../src/lib/deployment-vocabulary';
import {
  infraCheckLabel,
  infraCheckPresentation,
  readInfraChecks,
  redisProvisioningStatus,
  relativeTime,
} from '../src/lib/diagnostics';

describe('measured health vocabulary', () => {
  it('labels UNKNOWN without claiming the app is running', () => {
    expect(HEALTH_STATUS_LABEL.UNKNOWN).toBe('Health unknown');
    expect(HEALTH_STATUS_LABEL.HEALTHY).toBe('Healthy');
    expect(HEALTH_STATUS_LABEL.DEGRADED).toBe('Degraded');
    expect(HEALTH_STATUS_LABEL.UNHEALTHY).toBe('Unhealthy');
  });

  it('maps every health status to a badge variant', () => {
    for (const status of ['HEALTHY', 'DEGRADED', 'UNHEALTHY', 'UNKNOWN'] as const) {
      expect(HEALTH_STATUS_BADGE[status]).toBeDefined();
    }
  });

  it('shows the health badge only when something is actually running', () => {
    expect(showHealthBadge('HEALTHY')).toBe(true);
    expect(showHealthBadge('UPDATE_AVAILABLE')).toBe(true);
    // A failed FIRST install left nothing running; a failed day-2 operation
    // on a previously installed deployment leaves the app serving.
    expect(showHealthBadge('FAILED', null)).toBe(false);
    expect(showHealthBadge('FAILED', 'release-1')).toBe(true);
    expect(showHealthBadge('NOT_INSTALLED')).toBe(false);
    expect(showHealthBadge('DELETED')).toBe(false);
  });

  it('shows infrastructure rows once anything was attempted, including a failed install', () => {
    expect(showInfrastructureRows('HEALTHY')).toBe(true);
    expect(showInfrastructureRows('UPDATE_AVAILABLE')).toBe(true);
    // A FAILED install — first attempt or day-2 — always shows its resource
    // snapshot: the inventory of a failed first install is exactly what a
    // vendor debugging it needs (the stack may have created real resources
    // before rolling back). The health badge above stays honest (nothing may
    // be running), but the rows are not hidden behind that gate.
    expect(showInfrastructureRows('FAILED', null)).toBe(true);
    expect(showInfrastructureRows('FAILED', 'release-1')).toBe(true);
    expect(showInfrastructureRows('NOT_INSTALLED')).toBe(false);
    expect(showInfrastructureRows('WAITING_FOR_RELAY')).toBe(false);
    expect(showInfrastructureRows('DELETED')).toBe(false);
  });
});

describe('relay infra checks', () => {
  it('maps raw check names to friendly, jargon-free names', () => {
    expect(infraCheckLabel('stack-exists')).toBe('Application infrastructure');
    expect(infraCheckLabel('stack-complete')).toBe('Infrastructure setup');
    expect(infraCheckLabel('stack-tagged')).toBe('Infrastructure ownership');
    expect(infraCheckLabel('compute')).toBe('Application service');
    expect(infraCheckLabel('ingress')).toBe('Load balancer');
    expect(infraCheckLabel('database')).toBe('Database');
    expect(infraCheckLabel('storage')).toBe('Storage');
    expect(infraCheckLabel('cache')).toBe('Cache');
    expect(infraCheckLabel('verification-error')).toBe('Verification');
    expect(infraCheckLabel('anything-else')).toBe('Infrastructure check');
  });

  it('reads well-formed checks and drops malformed ones', () => {
    const observed = {
      infraHealth: {
        checks: [
          { name: 'compute', passed: true, detail: 'Found a complete ECS service' },
          { name: 'database', passed: false, detail: 'No complete database' },
          { malformed: true },
        ],
      },
    };
    const checks = readInfraChecks(observed);
    expect(checks).toHaveLength(2);
    expect(checks[1]).toEqual({ name: 'database', passed: false, detail: 'No complete database' });
  });

  it('returns nothing when no relay report exists', () => {
    expect(readInfraChecks(null)).toEqual([]);
    expect(readInfraChecks({})).toEqual([]);
  });
});

describe('infraCheckPresentation', () => {
  it('presents a passed check with its plain-English status text', () => {
    const presentation = infraCheckPresentation({
      name: 'compute',
      passed: true,
      detail: 'Found a complete ECS service',
    });
    expect(presentation).toEqual({
      label: 'Application service',
      outcome: 'passed',
      statusText: 'Running',
      problem: null,
      nextAction: null,
    });
  });

  it('presents a failed required check with a problem and next action', () => {
    const presentation = infraCheckPresentation({
      name: 'database',
      passed: false,
      detail: 'No complete database (AWS::RDS::DBInstance) in the stack',
    });
    expect(presentation.label).toBe('Database');
    expect(presentation.outcome).toBe('issue');
    expect(presentation.statusText).toBe('Needs attention');
    expect(presentation.problem).toBe('The database was not created.');
    expect(presentation.nextAction).toBe(
      'Wait for the current operation to finish. If this stays, open the issues below.',
    );
  });

  it('presents a failed informational cache check as not_required', () => {
    const presentation = infraCheckPresentation({
      name: 'cache',
      passed: false,
      required: false,
      detail: 'No cache cluster in the stack — not provisioned',
    });
    expect(presentation).toEqual({
      label: 'Cache',
      outcome: 'not_required',
      statusText: 'Not provisioned (this application does not require a cache)',
      problem: null,
      nextAction: null,
    });
  });

  it('falls back to the generic copy for an unknown check name', () => {
    const presentation = infraCheckPresentation({
      name: 'something-new',
      passed: false,
      detail: 'raw detail',
    });
    expect(presentation.label).toBe('Infrastructure check');
    expect(presentation.outcome).toBe('issue');
    expect(presentation.problem).toBe("A check on the deployment's infrastructure did not pass.");
    expect(presentation.nextAction).toBe(
      'Open the issues below for the cause, or wait for the next check.',
    );
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-08-28T12:00:00Z');

  it('renders seconds, minutes, hours and days ago', () => {
    expect(relativeTime('2026-08-28T11:59:45Z', now)).toBe('15 seconds ago');
    expect(relativeTime('2026-08-28T11:57:00Z', now)).toBe('3 minutes ago');
    expect(relativeTime('2026-08-28T09:00:00Z', now)).toBe('3 hours ago');
    expect(relativeTime('2026-08-26T12:00:00Z', now)).toBe('2 days ago');
  });

  it('returns null for missing or invalid timestamps', () => {
    expect(relativeTime(null, now)).toBeNull();
    expect(relativeTime('not-a-date', now)).toBeNull();
  });
});

describe('redisProvisioningStatus', () => {
  const passed = [{ name: 'cache', passed: true, detail: 'Found a complete cache' }];
  const failed = [{ name: 'cache', passed: false, detail: 'No complete cache in the stack' }];

  it('returns null when the application does not require Redis', () => {
    expect(redisProvisioningStatus(undefined, passed)).toBeNull();
  });

  it('reports Not provisioned when the observed cache check fails', () => {
    expect(redisProvisioningStatus('UNKNOWN', failed)).toBe('NOT_PROVISIONED');
  });

  it('reports Not reporting when no cache observation exists', () => {
    expect(redisProvisioningStatus('UNKNOWN', [])).toBe('NOT_REPORTING');
  });

  it('reports Healthy when the cache check passes and the component is healthy', () => {
    expect(redisProvisioningStatus('HEALTHY', passed)).toBe('HEALTHY');
  });

  it('collapses degraded components to Unhealthy once provisioned', () => {
    expect(redisProvisioningStatus('DEGRADED', passed)).toBe('UNHEALTHY');
  });
});
