import { describe, expect, it } from 'vitest';

import {
  HEALTH_STATUS_BADGE,
  HEALTH_STATUS_LABEL,
  showHealthBadge,
  showInfrastructureRows,
} from '../src/lib/deployment-vocabulary';
import {
  infraCheckLabel,
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

  it('shows the health badge only for lifecycle states with a running app', () => {
    expect(showHealthBadge('HEALTHY')).toBe(true);
    expect(showHealthBadge('UPDATE_AVAILABLE')).toBe(true);
    expect(showHealthBadge('FAILED')).toBe(false);
    expect(showHealthBadge('NOT_INSTALLED')).toBe(false);
    expect(showHealthBadge('DELETED')).toBe(false);
  });

  it('shows infrastructure rows only for lifecycle states with a running app', () => {
    expect(showInfrastructureRows('HEALTHY')).toBe(true);
    expect(showInfrastructureRows('UPDATE_AVAILABLE')).toBe(true);
    expect(showInfrastructureRows('FAILED')).toBe(false);
    expect(showInfrastructureRows('NOT_INSTALLED')).toBe(false);
    expect(showInfrastructureRows('DELETED')).toBe(false);
  });
});

describe('relay infra checks', () => {
  it('maps raw check names to friendly names', () => {
    expect(infraCheckLabel('stack-exists')).toBe('Stack');
    expect(infraCheckLabel('compute')).toBe('Compute');
    expect(infraCheckLabel('ingress')).toBe('Ingress');
    expect(infraCheckLabel('database')).toBe('Database');
    expect(infraCheckLabel('storage')).toBe('Storage');
    expect(infraCheckLabel('cache')).toBe('Redis');
    expect(infraCheckLabel('anything-else')).toBe('anything-else');
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
