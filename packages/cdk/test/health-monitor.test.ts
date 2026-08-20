import { describe, expect, it, vi } from 'vitest';

import {
  checkBackupConfig,
  checkHttpHealth,
  checkRelayConnectivity,
  checkServiceState,
  checkStackStatus,
  checkStateConsistency,
  checkTargetHealth,
  checkUtilization,
  collectHealthSignals,
  detectDrift,
  DRIFT_THRESHOLD,
  evaluateHealth,
  HEALTH_SIGNAL_KEYS,
  RELAY_DEGRADED_AFTER_MS,
  RELAY_DISCONNECTED_AFTER_MS,
  handleDrift,
  UTILIZATION_DEGRADED_PCT,
  UTILIZATION_UNHEALTHY_PCT,
  type DriftDeps,
  type HealthCheckDeps,
  type HealthSignal,
} from '../src/jobs/health-monitor.js';

// ── Signal 1: stack status ────────────────────────────────────────────────

describe('checkStackStatus', () => {
  it('HEALTHY for a terminal-success stack', () => {
    const signal = checkStackStatus({ stackStatus: 'CREATE_COMPLETE' });
    expect(signal.status).toBe('HEALTHY');
    expect(signal.key).toBe('stack');
  });

  it('DEGRADED for an in-progress or rolled-back stack', () => {
    expect(checkStackStatus({ stackStatus: 'UPDATE_IN_PROGRESS' }).status).toBe('DEGRADED');
    expect(checkStackStatus({ stackStatus: 'ROLLBACK_COMPLETE' }).status).toBe('DEGRADED');
  });

  it('UNHEALTHY for a failed stack', () => {
    expect(checkStackStatus({ stackStatus: 'CREATE_FAILED' }).status).toBe('UNHEALTHY');
    expect(checkStackStatus({ stackStatus: 'DELETE_FAILED' }).status).toBe('UNHEALTHY');
  });
});

// ── Signal 2: service state ───────────────────────────────────────────────

describe('checkServiceState', () => {
  it('HEALTHY when all desired tasks are running', () => {
    expect(checkServiceState({ runningCount: 2, desiredCount: 2 }).status).toBe('HEALTHY');
  });

  it('DEGRADED while tasks are still starting', () => {
    expect(checkServiceState({ runningCount: 1, desiredCount: 2 }).status).toBe('DEGRADED');
  });

  it('UNHEALTHY when no tasks are running or none are expected', () => {
    expect(checkServiceState({ runningCount: 0, desiredCount: 2 }).status).toBe('UNHEALTHY');
    expect(checkServiceState({ runningCount: 0, desiredCount: 0 }).status).toBe('UNHEALTHY');
  });
});

// ── Signal 3: target health ───────────────────────────────────────────────

describe('checkTargetHealth', () => {
  it('HEALTHY when all targets are healthy', () => {
    expect(checkTargetHealth({ healthyTargets: 2, unhealthyTargets: 0 }).status).toBe('HEALTHY');
  });

  it('DEGRADED when some targets are unhealthy', () => {
    expect(checkTargetHealth({ healthyTargets: 1, unhealthyTargets: 1 }).status).toBe('DEGRADED');
  });

  it('UNHEALTHY when no targets are healthy', () => {
    expect(checkTargetHealth({ healthyTargets: 0, unhealthyTargets: 2 }).status).toBe('UNHEALTHY');
  });
});

// ── Signal 4: RDS availability + §64 backup config ────────────────────────

describe('checkBackupConfig', () => {
  it('HEALTHY when the database is reachable and backups are enabled', () => {
    const signal = checkBackupConfig('deployment-1', {
      rdsAvailable: true,
      automatedBackupsEnabled: true,
    });
    expect(signal.status).toBe('HEALTHY');
    expect(signal.key).toBe('rds');
    expect(signal.detail?.deploymentId).toBe('deployment-1');
  });

  it('DEGRADED when §64 automated backups have been turned off', () => {
    const signal = checkBackupConfig('deployment-1', {
      rdsAvailable: true,
      automatedBackupsEnabled: false,
    });
    expect(signal.status).toBe('DEGRADED');
    expect(signal.summary).toContain('backups');
  });

  it('UNHEALTHY when the database is unreachable', () => {
    const signal = checkBackupConfig('deployment-1', {
      rdsAvailable: false,
      automatedBackupsEnabled: true,
    });
    expect(signal.status).toBe('UNHEALTHY');
  });
});

// ── Signal 5: relay connectivity ──────────────────────────────────────────

describe('checkRelayConnectivity', () => {
  it('HEALTHY when the relay checked in recently', () => {
    expect(checkRelayConnectivity({ lastContactMsAgo: 1000 }).status).toBe('HEALTHY');
  });

  it('DEGRADED when the relay is past the degraded threshold', () => {
    expect(
      checkRelayConnectivity({ lastContactMsAgo: RELAY_DEGRADED_AFTER_MS + 1 }).status,
    ).toBe('DEGRADED');
  });

  it('UNHEALTHY when the relay is disconnected or never checked in', () => {
    expect(
      checkRelayConnectivity({ lastContactMsAgo: RELAY_DISCONNECTED_AFTER_MS + 1 }).status,
    ).toBe('UNHEALTHY');
    expect(checkRelayConnectivity({ lastContactMsAgo: null }).status).toBe('UNHEALTHY');
  });
});

// ── Signal 6: HTTP health ─────────────────────────────────────────────────

describe('checkHttpHealth', () => {
  it('HEALTHY for a 2xx /health response', () => {
    expect(checkHttpHealth({ statusCode: 200 }).status).toBe('HEALTHY');
  });

  it('DEGRADED when the app is up but its health check fails (5xx)', () => {
    expect(checkHttpHealth({ statusCode: 503 }).status).toBe('DEGRADED');
  });

  it('UNHEALTHY when the health endpoint is unreachable', () => {
    expect(checkHttpHealth({ statusCode: null }).status).toBe('UNHEALTHY');
    expect(checkHttpHealth({ statusCode: 404 }).status).toBe('UNHEALTHY');
  });
});

// ── Signal 7: CPU/memory utilization ──────────────────────────────────────

describe('checkUtilization', () => {
  it('HEALTHY under the degraded threshold', () => {
    expect(checkUtilization({ cpuPercent: 30, memoryPercent: 40 }).status).toBe('HEALTHY');
  });

  it('DEGRADED above the degraded threshold but below critical', () => {
    expect(
      checkUtilization({ cpuPercent: UTILIZATION_DEGRADED_PCT + 1, memoryPercent: 10 }).status,
    ).toBe('DEGRADED');
  });

  it('UNHEALTHY at or above the critical threshold (peaks across CPU/memory)', () => {
    expect(
      checkUtilization({ cpuPercent: 10, memoryPercent: UTILIZATION_UNHEALTHY_PCT }).status,
    ).toBe('UNHEALTHY');
  });
});

// ── Signal 8: deployment state consistency ────────────────────────────────

describe('checkStateConsistency', () => {
  it('HEALTHY when observed matches desired', () => {
    expect(
      checkStateConsistency({ desiredState: 'HEALTHY', observedState: 'HEALTHY' }).status,
    ).toBe('HEALTHY');
  });

  it('DEGRADED when observed has drifted from desired', () => {
    expect(
      checkStateConsistency({ desiredState: 'HEALTHY', observedState: 'UPDATING' }).status,
    ).toBe('DEGRADED');
  });
});

// ── Aggregate ─────────────────────────────────────────────────────────────

describe('evaluateHealth', () => {
  const healthy = (key: HealthSignal['key']): HealthSignal => ({
    key,
    status: 'HEALTHY',
    summary: 'ok',
  });

  it('HEALTHY when every signal is healthy', () => {
    expect(evaluateHealth(HEALTH_SIGNAL_KEYS.map(healthy))).toBe('HEALTHY');
  });

  it('HEALTHY for an empty signal set (no signal, no known problem)', () => {
    expect(evaluateHealth([])).toBe('HEALTHY');
  });

  it('DEGRADED when any signal is degraded (and none unhealthy)', () => {
    const signals = HEALTH_SIGNAL_KEYS.map(healthy);
    signals[3] = { key: 'rds', status: 'DEGRADED', summary: 'backups off' };
    expect(evaluateHealth(signals)).toBe('DEGRADED');
  });

  it('UNHEALTHY wins over degraded and healthy', () => {
    const signals = HEALTH_SIGNAL_KEYS.map(healthy);
    signals[0] = { key: 'stack', status: 'DEGRADED', summary: 'provisioning' };
    signals[4] = { key: 'relay', status: 'UNHEALTHY', summary: 'disconnected' };
    expect(evaluateHealth(signals)).toBe('UNHEALTHY');
  });
});

// ── collectHealthSignals ──────────────────────────────────────────────────

describe('collectHealthSignals', () => {
  const HEALTHY_DEPS: HealthCheckDeps = {
    deploymentId: 'deployment-1',
    stackStatus: 'CREATE_COMPLETE',
    runningCount: 2,
    desiredCount: 2,
    healthyTargets: 2,
    unhealthyTargets: 0,
    rdsAvailable: true,
    automatedBackupsEnabled: true,
    relayLastContactMsAgo: 1000,
    httpStatusCode: 200,
    cpuPercent: 30,
    memoryPercent: 40,
    desiredState: 'HEALTHY',
    observedState: 'HEALTHY',
  };

  it('returns exactly the 8 §28 signals in canonical order', () => {
    const signals = collectHealthSignals(HEALTHY_DEPS);
    expect(signals.map((s) => s.key)).toEqual([...HEALTH_SIGNAL_KEYS]);
  });

  it('every healthy input produces an all-HEALTHY aggregate', () => {
    expect(evaluateHealth(collectHealthSignals(HEALTHY_DEPS))).toBe('HEALTHY');
  });

  it('a disconnected relay drags the aggregate to UNHEALTHY', () => {
    const signals = collectHealthSignals({
      ...HEALTHY_DEPS,
      relayLastContactMsAgo: null,
    });
    expect(evaluateHealth(signals)).toBe('UNHEALTHY');
  });
});

// ── §59 drift detection ───────────────────────────────────────────────────

describe('detectDrift', () => {
  it('returns no entries when desired and observed are equal', () => {
    expect(detectDrift({ infraVersion: 'runtime-v1' }, { infraVersion: 'runtime-v1' })).toEqual([]);
  });

  it('returns one entry per drifted field', () => {
    const entries = detectDrift(
      { infraVersion: 'runtime-v2', imageDigest: 'sha256:abc' },
      { infraVersion: 'runtime-v1', imageDigest: 'sha256:abc' },
    );
    expect(entries).toEqual([
      { key: 'infraVersion', desired: 'runtime-v2', observed: 'runtime-v1' },
    ]);
  });

  it('treats a field missing from observed as drift', () => {
    const entries = detectDrift({ infraVersion: 'runtime-v2' }, {});
    expect(entries).toEqual([
      { key: 'infraVersion', desired: 'runtime-v2', observed: undefined },
    ]);
  });

  it('deep-compares nested objects', () => {
    const entries = detectDrift(
      { config: { a: 1 } },
      { config: { a: 2 } },
    );
    expect(entries).toHaveLength(1);
    expect(detectDrift({ config: { a: 1 } }, { config: { a: 1 } })).toEqual([]);
  });
});

// ── §59 drift handling (kill-mid-flight) ──────────────────────────────────

describe('handleDrift', () => {
  function makeDeps(overrides: Partial<DriftDeps> = {}): DriftDeps {
    return {
      listInflightJobs: vi.fn().mockResolvedValue([]),
      supersedeJob: vi.fn().mockResolvedValue(undefined),
      spawnJob: vi.fn().mockResolvedValue('job-new'),
      ...overrides,
    };
  }

  const beyondThreshold = {
    deploymentId: 'deployment-1',
    jobType: 'INFRA_UPGRADE',
    entries: [
      { key: 'infraVersion', desired: 'runtime-v2', observed: 'runtime-v1' },
      { key: 'state', desired: 'HEALTHY', observed: 'UPDATING' },
    ],
  } as const;

  it('takes no action within threshold (drift tolerated)', async () => {
    const deps = makeDeps();
    const result = await handleDrift(
      {
        deploymentId: 'deployment-1',
        jobType: 'INFRA_UPGRADE',
        entries: [{ key: 'state', desired: 'HEALTHY', observed: 'UPDATING' }],
      },
      deps,
    );

    expect(result.action).toBe('none');
    expect(result.supersededJobIds).toEqual([]);
    expect(deps.spawnJob).not.toHaveBeenCalled();
    expect(deps.supersedeJob).not.toHaveBeenCalled();
  });

  it('re-spawns the matching job when drift exceeds threshold', async () => {
    const deps = makeDeps();
    const result = await handleDrift(beyondThreshold, deps);

    expect(result.action).toBe('respawned');
    expect(result.newJobId).toBe('job-new');
    expect(deps.spawnJob).toHaveBeenCalledTimes(1);
    expect(deps.spawnJob).toHaveBeenCalledWith(
      expect.objectContaining({ deploymentId: 'deployment-1', type: 'INFRA_UPGRADE' }),
    );
  });

  it('kill-mid-flight: supersedes an orphaned in-flight job of the same type, then spawns once (no double-execution)', async () => {
    const deps = makeDeps({
      listInflightJobs: vi.fn().mockResolvedValue([
        { id: 'job-orphan', type: 'INFRA_UPGRADE' },
        { id: 'job-other', type: 'DEPLOY_RELEASE' },
      ]),
    });

    const result = await handleDrift(beyondThreshold, deps);

    // The orphaned matching job is killed BEFORE the replacement is spawned.
    expect(deps.supersedeJob).toHaveBeenCalledTimes(1);
    expect(deps.supersedeJob).toHaveBeenCalledWith(
      'job-orphan',
      expect.stringContaining('superseded by drift reconciliation'),
    );
    // The non-matching in-flight job is left alone.
    expect(result.supersededJobIds).toEqual(['job-orphan']);
    // Exactly one reconciliation job is spawned — never a double execution.
    expect(deps.spawnJob).toHaveBeenCalledTimes(1);
  });

  it('does not supersede in-flight jobs of a different type', async () => {
    const deps = makeDeps({
      listInflightJobs: vi.fn().mockResolvedValue([{ id: 'job-other', type: 'DEPLOY_RELEASE' }]),
    });

    const result = await handleDrift(beyondThreshold, deps);

    expect(deps.supersedeJob).not.toHaveBeenCalled();
    expect(result.supersededJobIds).toEqual([]);
    expect(deps.spawnJob).toHaveBeenCalledTimes(1);
  });

  it('supersedes multiple matching orphans before spawning a single replacement', async () => {
    const deps = makeDeps({
      listInflightJobs: vi.fn().mockResolvedValue([
        { id: 'job-a', type: 'INFRA_UPGRADE' },
        { id: 'job-b', type: 'INFRA_UPGRADE' },
      ]),
    });

    const result = await handleDrift(beyondThreshold, deps);

    expect(result.supersededJobIds).toEqual(['job-a', 'job-b']);
    expect(deps.supersedeJob).toHaveBeenCalledTimes(2);
    expect(deps.spawnJob).toHaveBeenCalledTimes(1);
  });

  it('the default threshold is exactly one field', () => {
    expect(DRIFT_THRESHOLD).toBe(1);
  });
});
