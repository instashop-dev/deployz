import { describe, expect, it, vi } from 'vitest';

import {
  checkBackupConfig,
  checkCacheStatus,
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
  reconcileDeploymentHealth,
  UTILIZATION_DEGRADED_PCT,
  UTILIZATION_UNHEALTHY_PCT,
  type DriftDeps,
  type HealthCheckDeps,
  type HealthSignal,
  type ReconcileDeploymentHealthDeps,
  type ReconcileDeploymentHealthInput,
} from '../src/jobs/health-monitor.js';

import { EventEmitter, InMemoryEventStore } from '../src/jobs/event-emitter.js';

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

// ── Signal 10: cache (Redis) status ───────────────────────────────────────

describe('checkCacheStatus', () => {
  it('HEALTHY (non-signal) when redis is not required, regardless of cache status', () => {
    expect(
      checkCacheStatus({ redisRequired: false, cacheStatus: null }).status,
    ).toBe('HEALTHY');
    expect(
      checkCacheStatus({ redisRequired: false, cacheStatus: 'failed' }).status,
    ).toBe('HEALTHY');
    expect(checkCacheStatus({ redisRequired: false, cacheStatus: null }).key).toBe('cache');
  });

  it('DEGRADED when redis is required but the observed status is missing', () => {
    expect(
      checkCacheStatus({ redisRequired: true, cacheStatus: null }).status,
    ).toBe('DEGRADED');
  });

  it('DEGRADED when redis is required but the observed status is not yet available', () => {
    expect(
      checkCacheStatus({ redisRequired: true, cacheStatus: 'creating' }).status,
    ).toBe('DEGRADED');
  });

  it('HEALTHY when redis is required and the observed status is available', () => {
    expect(
      checkCacheStatus({ redisRequired: true, cacheStatus: 'available' }).status,
    ).toBe('HEALTHY');
  });

  it('UNHEALTHY when the cache is reported failed', () => {
    expect(
      checkCacheStatus({ redisRequired: true, cacheStatus: 'failed' }).status,
    ).toBe('UNHEALTHY');
  });

  it('UNHEALTHY when the cache is reported deleted', () => {
    expect(
      checkCacheStatus({ redisRequired: true, cacheStatus: 'deleted' }).status,
    ).toBe('UNHEALTHY');
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
    redisRequired: false,
    cacheStatus: null,
  };

  it('returns exactly the 10 §28 signals in canonical order', () => {
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

  it('redis required but not yet available drags the aggregate to DEGRADED', () => {
    const signals = collectHealthSignals({
      ...HEALTHY_DEPS,
      redisRequired: true,
      cacheStatus: 'creating',
    });
    expect(evaluateHealth(signals)).toBe('DEGRADED');
  });

  it('redis required and available keeps the aggregate HEALTHY', () => {
    const signals = collectHealthSignals({
      ...HEALTHY_DEPS,
      redisRequired: true,
      cacheStatus: 'available',
    });
    expect(evaluateHealth(signals)).toBe('HEALTHY');
  });

  it('a failed cache drags the aggregate to UNHEALTHY', () => {
    const signals = collectHealthSignals({
      ...HEALTHY_DEPS,
      redisRequired: true,
      cacheStatus: 'failed',
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

// ── §28/§59 reconciliation entry point (item 10a) ──────────────────────────

describe('reconcileDeploymentHealth', () => {
  function makeHealthCheckDeps(overrides: Partial<HealthCheckDeps> = {}): HealthCheckDeps {
    return {
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
      cpuPercent: 10,
      memoryPercent: 10,
      desiredState: 'HEALTHY',
      observedState: 'HEALTHY',
      redisRequired: false,
      cacheStatus: null,
      ...overrides,
    };
  }

  function makeReconcileDeps(
    overrides: Partial<ReconcileDeploymentHealthDeps> = {},
  ): ReconcileDeploymentHealthDeps & {
    getDeploymentState: ReturnType<typeof vi.fn>;
    setDeploymentState: ReturnType<typeof vi.fn>;
  } {
    return {
      getDeploymentState: vi.fn().mockResolvedValue('HEALTHY'),
      setDeploymentState: vi.fn().mockResolvedValue(undefined),
      listInflightJobs: vi.fn().mockResolvedValue([]),
      supersedeJob: vi.fn().mockResolvedValue(undefined),
      spawnJob: vi.fn().mockResolvedValue('job-new'),
      ...overrides,
    };
  }

  function makeInput(overrides: Partial<ReconcileDeploymentHealthInput> = {}): ReconcileDeploymentHealthInput {
    return {
      deploymentId: 'deployment-1',
      organizationId: 'org-1',
      healthCheckDeps: makeHealthCheckDeps(),
      desiredState: { infraVersion: 'runtime-v2' },
      observedState: { infraVersion: 'runtime-v2' },
      jobType: 'INFRA_UPGRADE',
      ...overrides,
    };
  }

  it('collects signals and evaluates aggregate health for a fully healthy deployment', async () => {
    const deps = makeReconcileDeps();
    const result = await reconcileDeploymentHealth(makeInput(), deps);

    expect(result.aggregateHealth).toBe('HEALTHY');
    expect(result.signals).toHaveLength(HEALTH_SIGNAL_KEYS.length);
    expect(result.disconnected).toBe(false);
    expect(deps.setDeploymentState).not.toHaveBeenCalled();
  });

  it('does nothing extra when there is no drift (within threshold)', async () => {
    const deps = makeReconcileDeps();
    const result = await reconcileDeploymentHealth(makeInput(), deps);

    expect(result.drift.action).toBe('none');
    expect(deps.spawnJob).not.toHaveBeenCalled();
  });

  it('respawns the matching job via handleDrift when drift exceeds threshold', async () => {
    const deps = makeReconcileDeps();
    const input = makeInput({
      desiredState: { infraVersion: 'runtime-v2', state: 'HEALTHY' },
      observedState: { infraVersion: 'runtime-v1', state: 'UPDATING' },
    });

    const result = await reconcileDeploymentHealth(input, deps);

    expect(result.drift.action).toBe('respawned');
    expect(deps.spawnJob).toHaveBeenCalledWith(
      expect.objectContaining({ deploymentId: 'deployment-1', type: 'INFRA_UPGRADE' }),
    );
  });

  it('drives the deployment to DISCONNECTED on relay silence past the threshold, and emits health.relay.disconnected', async () => {
    const eventStore = new InMemoryEventStore();
    const emitter = new EventEmitter(eventStore, () => new Date('2026-01-01T00:00:00.000Z'));
    const deps = makeReconcileDeps({ emitter, getDeploymentState: vi.fn().mockResolvedValue('HEALTHY') });

    const input = makeInput({
      healthCheckDeps: makeHealthCheckDeps({
        relayLastContactMsAgo: RELAY_DISCONNECTED_AFTER_MS + 1000,
      }),
    });

    const result = await reconcileDeploymentHealth(input, deps);

    expect(result.disconnected).toBe(true);
    expect(deps.setDeploymentState).toHaveBeenCalledWith('deployment-1', 'DISCONNECTED');

    const event = eventStore.events.find((e) => e.eventType === 'health.relay.disconnected');
    expect(event).toBeDefined();
    expect(event?.previousState).toBe('HEALTHY');
    expect(event?.requestedState).toBe('DISCONNECTED');
  });

  it('does not re-transition or re-emit when the deployment is already DISCONNECTED', async () => {
    const eventStore = new InMemoryEventStore();
    const emitter = new EventEmitter(eventStore, () => new Date());
    const deps = makeReconcileDeps({
      emitter,
      getDeploymentState: vi.fn().mockResolvedValue('DISCONNECTED'),
    });

    const input = makeInput({
      healthCheckDeps: makeHealthCheckDeps({
        relayLastContactMsAgo: RELAY_DISCONNECTED_AFTER_MS + 1000,
      }),
    });

    const result = await reconcileDeploymentHealth(input, deps);

    expect(result.disconnected).toBe(true);
    expect(deps.setDeploymentState).not.toHaveBeenCalled();
    expect(eventStore.events).toEqual([]);
  });

  it('does NOT drive DISCONNECTED merely because the relay signal is DEGRADED (below the disconnect threshold)', async () => {
    const deps = makeReconcileDeps();
    const input = makeInput({
      healthCheckDeps: makeHealthCheckDeps({
        relayLastContactMsAgo: RELAY_DEGRADED_AFTER_MS + 1000,
      }),
    });

    const result = await reconcileDeploymentHealth(input, deps);

    expect(result.disconnected).toBe(false);
    expect(deps.setDeploymentState).not.toHaveBeenCalled();
  });

  it('emits health.degraded / health.unhealthy / health.recovered when previousHealth differs and the relay is not silent', async () => {
    const eventStore = new InMemoryEventStore();
    const emitter = new EventEmitter(eventStore, () => new Date());
    const deps = makeReconcileDeps({ emitter });

    // HEALTHY -> DEGRADED (a target is unhealthy).
    await reconcileDeploymentHealth(
      makeInput({
        previousHealth: 'HEALTHY',
        healthCheckDeps: makeHealthCheckDeps({ healthyTargets: 1, unhealthyTargets: 1 }),
      }),
      deps,
    );
    expect(eventStore.events.some((e) => e.eventType === 'health.degraded')).toBe(true);

    eventStore.clear();

    // DEGRADED -> HEALTHY.
    await reconcileDeploymentHealth(
      makeInput({ previousHealth: 'DEGRADED' }),
      deps,
    );
    expect(eventStore.events.some((e) => e.eventType === 'health.recovered')).toBe(true);
  });

  it('emits nothing extra when no emitter is injected (state transition + drift handling still run)', async () => {
    const deps = makeReconcileDeps({ emitter: undefined });
    const input = makeInput({
      healthCheckDeps: makeHealthCheckDeps({
        relayLastContactMsAgo: RELAY_DISCONNECTED_AFTER_MS + 1000,
      }),
    });

    const result = await reconcileDeploymentHealth(input, deps);

    expect(result.disconnected).toBe(true);
    expect(deps.setDeploymentState).toHaveBeenCalledWith('deployment-1', 'DISCONNECTED');
  });
});
