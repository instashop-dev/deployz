import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  DurableRuntime,
  InMemoryStateStore,
  type DurableWorkflow,
} from '../src/durable/durable-runtime.js';

import {
  EventEmitter,
  InMemoryEventStore,
} from '../src/jobs/event-emitter.js';

import {
  InMemoryDeploymentStateStore,
  PreflightError,
} from '../src/jobs/install-workflow.js';

import {
  createDeployReleaseWorkflow,
  DeployReleaseError,
  type DeployReleaseInput,
  type DeployReleaseOutput,
  type EcsUpdateResult,
  type InfraUpgradeResult,
  type MigrationResult,
} from '../src/jobs/deploy-release-workflow.js';

// ── Fixtures ─────────────────────────────────────────────────────────────

const FIXED_NOW = new Date('2026-08-20T00:00:00.000Z');
const DIGEST =
  'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function makeInput(overrides: Partial<DeployReleaseInput> = {}): DeployReleaseInput {
  return {
    deploymentId: 'deployment-1',
    customerId: 'customer-1',
    organizationId: 'org-1',
    jobId: 'job-1',
    installationId: 'install-1',
    region: 'us-east-1',
    releaseId: 'release-2',
    releaseVersion: 'v2',
    imageDigest: DIGEST,
    migrationCommand: 'node migrate.js up',
    fromInfraVersion: 'runtime-v1',
    toInfraVersion: 'runtime-v2',
    ...overrides,
  };
}

interface MockConfig {
  migrationResult?: MigrationResult;
  ecsResult?: EcsUpdateResult;
  infraResult?: InfraUpgradeResult;
  pendingRelease?: boolean;
}

interface WorkflowHarness {
  workflow: DurableWorkflow<DeployReleaseInput, DeployReleaseOutput>;
  runtime: DurableRuntime;
  eventStore: InMemoryEventStore;
  deploymentStore: InMemoryDeploymentStateStore;
  runMigration: Mock<() => Promise<MigrationResult>>;
  updateService: Mock<() => Promise<EcsUpdateResult>>;
  upgradeInfraVersion: Mock<() => Promise<InfraUpgradeResult>>;
  hasPendingRelease: Mock<() => Promise<boolean>>;
}

function makeHarness(config: MockConfig = {}): WorkflowHarness {
  const eventStore = new InMemoryEventStore();
  const emitter = new EventEmitter(eventStore, () => FIXED_NOW);
  const deploymentStore = new InMemoryDeploymentStateStore();

  const runMigration = vi
    .fn<() => Promise<MigrationResult>>()
    .mockResolvedValue(config.migrationResult ?? { ok: true });
  const updateService = vi
    .fn<() => Promise<EcsUpdateResult>>()
    .mockResolvedValue(config.ecsResult ?? { ok: true, digest: DIGEST });
  const upgradeInfraVersion = vi
    .fn<() => Promise<InfraUpgradeResult>>()
    .mockResolvedValue(config.infraResult ?? { ok: true, version: 'runtime-v2' });
  const hasPendingRelease = vi
    .fn<() => Promise<boolean>>()
    .mockResolvedValue(config.pendingRelease ?? false);

  const workflow = createDeployReleaseWorkflow({
    emitter,
    deploymentStore,
    migrationRunner: { runMigration },
    ecsUpdater: { updateService },
    infraUpgrader: { upgradeInfraVersion },
    pendingReleaseChecker: { hasPendingRelease },
  });
  const runtime = new DurableRuntime(new InMemoryStateStore());

  return {
    workflow,
    runtime,
    eventStore,
    deploymentStore,
    runMigration,
    updateService,
    upgradeInfraVersion,
    hasPendingRelease,
  };
}

/** Set the deployment's starting state to HEALTHY (a DEPLOY_RELEASE precondition). */
async function seedHealthy(deploymentStore: InMemoryDeploymentStateStore): Promise<void> {
  await deploymentStore.set('deployment-1', 'HEALTHY');
}

// ── DEPLOY_RELEASE workflow ──────────────────────────────────────────────

describe('DEPLOY_RELEASE workflow', () => {
  let harness: WorkflowHarness;

  beforeEach(() => {
    harness = makeHarness();
  });

  it('runs preflight → migration → ECS → infra upgrade, then suspends on health', async () => {
    await seedHealthy(harness.deploymentStore);

    const state = await harness.runtime.start(harness.workflow, makeInput(), 'exec-1');

    expect(state.status).toBe('WAITING_CALLBACK');
    expect(state.callbackToken).toBe('deploy:install-1:health-report');
    expect(state.history.map((h) => h.name)).toEqual([
      'preflight',
      'migration',
      'ecs-update',
      'infra-upgrade',
    ]);

    // Seams were called with the exact inputs.
    expect(harness.runMigration).toHaveBeenCalledWith('node migrate.js up');
    expect(harness.updateService).toHaveBeenCalledWith('deployment-1', DIGEST);
    expect(harness.upgradeInfraVersion).toHaveBeenCalledWith(
      'deployment-1',
      'runtime-v1',
      'runtime-v2',
    );

    // Deployment transitioned HEALTHY → UPDATING.
    expect(await harness.deploymentStore.get('deployment-1')).toBe('UPDATING');
  });

  it('completes end-to-end to HEALTHY after a healthy report (full v1→v2)', async () => {
    await seedHealthy(harness.deploymentStore);

    await harness.runtime.start(harness.workflow, makeInput(), 'exec-2');
    const completed = await harness.runtime.resume(
      harness.workflow,
      'exec-2',
      { installationId: 'install-1', healthy: true, observedState: 'HEALTHY' },
    );

    expect(completed.status).toBe('COMPLETED');
    expect(completed.output).toEqual({
      status: 'HEALTHY',
      deploymentId: 'deployment-1',
      releaseId: 'release-2',
      imageDigest: DIGEST,
    });

    // All seven steps in order.
    expect(completed.history.map((h) => h.name)).toEqual([
      'preflight',
      'migration',
      'ecs-update',
      'infra-upgrade',
      'observe-health',
      'finalize',
    ]);

    expect(await harness.deploymentStore.get('deployment-1')).toBe('HEALTHY');
  });

  it('lands in UPDATE_AVAILABLE when a newer release is pending', async () => {
    await seedHealthy(harness.deploymentStore);
    harness.hasPendingRelease.mockResolvedValue(true);

    await harness.runtime.start(harness.workflow, makeInput(), 'exec-3');
    const completed = await harness.runtime.resume(
      harness.workflow,
      'exec-3',
      { installationId: 'install-1', healthy: true },
    );

    expect(completed.status).toBe('COMPLETED');
    expect((completed.output as DeployReleaseOutput).status).toBe('UPDATE_AVAILABLE');
    expect(await harness.deploymentStore.get('deployment-1')).toBe('UPDATE_AVAILABLE');
    expect(harness.hasPendingRelease).toHaveBeenCalledWith('deployment-1', 'release-2');
  });

  it('NEGATIVE TEST: a failed preflight halts before migration/ECS/infra ever run', async () => {
    await seedHealthy(harness.deploymentStore);

    await expect(
      harness.runtime.start(
        harness.workflow,
        makeInput({ region: 'ap-southeast-3' }),
        'exec-4',
      ),
    ).rejects.toThrow(PreflightError);

    // The migration, ECS, and infra seams were NEVER called.
    expect(harness.runMigration).not.toHaveBeenCalled();
    expect(harness.updateService).not.toHaveBeenCalled();
    expect(harness.upgradeInfraVersion).not.toHaveBeenCalled();

    // Deployment never left HEALTHY (no UPDATING transition).
    expect(await harness.deploymentStore.get('deployment-1')).toBe('HEALTHY');

    // Only the preflight event was emitted, with a failure result.
    expect(harness.eventStore.events.map((e) => e.eventType)).toEqual(['deploy.preflight']);
    expect(harness.eventStore.events[0]?.result).toBe('failed:REGION_NOT_SUPPORTED');
  });

  it('skips migration when no migration command is carried', async () => {
    await seedHealthy(harness.deploymentStore);

    await harness.runtime.start(
      harness.workflow,
      makeInput({ migrationCommand: undefined }),
      'exec-5',
    );

    expect(harness.runMigration).not.toHaveBeenCalled();
    const migrationEvent = harness.eventStore.events.find(
      (e) => e.eventType === 'deploy.migration',
    );
    expect(migrationEvent?.result).toBe('skipped');
  });

  it('fails with MIGRATION_FAILED when the migration one-off fails', async () => {
    await seedHealthy(harness.deploymentStore);
    harness.runMigration.mockResolvedValue({
      ok: false,
      failureCode: 'MIGRATION_FAILED',
      reason: 'column does not exist',
    });

    await expect(
      harness.runtime.start(harness.workflow, makeInput(), 'exec-6'),
    ).rejects.toThrow(DeployReleaseError);

    // ECS update never runs after a failed migration.
    expect(harness.updateService).not.toHaveBeenCalled();
    expect(harness.upgradeInfraVersion).not.toHaveBeenCalled();

    const migrationEvent = harness.eventStore.events.find(
      (e) => e.eventType === 'deploy.migration',
    );
    expect(migrationEvent?.result).toBe('failed:MIGRATION_FAILED');
  });

  it('fails with ECS_DEPLOYMENT_FAILED when the ECS update fails', async () => {
    await seedHealthy(harness.deploymentStore);
    harness.updateService.mockResolvedValue({
      ok: false,
      failureCode: 'ECS_DEPLOYMENT_FAILED',
      reason: 'service unreachable',
    });

    await expect(
      harness.runtime.start(harness.workflow, makeInput(), 'exec-7'),
    ).rejects.toThrow(DeployReleaseError);

    // Infra upgrade never runs after a failed ECS update.
    expect(harness.upgradeInfraVersion).not.toHaveBeenCalled();

    const ecsEvent = harness.eventStore.events.find(
      (e) => e.eventType === 'deploy.ecs-update',
    );
    expect(ecsEvent?.result).toBe('failed:ECS_DEPLOYMENT_FAILED');
  });

  it('skips infra upgrade when from/to versions are identical', async () => {
    await seedHealthy(harness.deploymentStore);

    await harness.runtime.start(
      harness.workflow,
      makeInput({ fromInfraVersion: 'runtime-v1', toInfraVersion: 'runtime-v1' }),
      'exec-8',
    );

    expect(harness.upgradeInfraVersion).not.toHaveBeenCalled();
    const infraEvent = harness.eventStore.events.find(
      (e) => e.eventType === 'deploy.infra-upgrade',
    );
    expect(infraEvent?.result).toBe('skipped');
  });

  it('fails when the infra upgrade fails (UNKNOWN failure code)', async () => {
    await seedHealthy(harness.deploymentStore);
    harness.upgradeInfraVersion.mockResolvedValue({
      ok: false,
      failureCode: 'UNKNOWN',
      reason: 'CFN update failed',
    });

    await expect(
      harness.runtime.start(harness.workflow, makeInput(), 'exec-9'),
    ).rejects.toThrow(DeployReleaseError);

    const infraEvent = harness.eventStore.events.find(
      (e) => e.eventType === 'deploy.infra-upgrade',
    );
    expect(infraEvent?.result).toBe('failed:UNKNOWN');
  });

  it('rejects an unhealthy report and never finalizes', async () => {
    await seedHealthy(harness.deploymentStore);

    await harness.runtime.start(harness.workflow, makeInput(), 'exec-10');

    await expect(
      harness.runtime.resume(
        harness.workflow,
        'exec-10',
        { installationId: 'install-1', healthy: false },
      ),
    ).rejects.toThrow(PreflightError);

    expect(await harness.deploymentStore.get('deployment-1')).toBe('UPDATING');
    expect(harness.eventStore.events.some((e) => e.eventType === 'deploy.health')).toBe(true);
    // Finalize never emitted a state event.
    expect(
      harness.eventStore.events.some((e) => e.eventType.startsWith('deploy.state.')),
    ).toBe(true); // only deploy.state.updating was emitted before the failure
    expect(
      harness.eventStore.events.some(
        (e) => e.eventType === 'deploy.state.healthy' || e.eventType === 'deploy.state.update-available',
      ),
    ).toBe(false);
  });

  it('emits every §62 event in order (happy path with migration + infra upgrade)', async () => {
    await seedHealthy(harness.deploymentStore);

    await harness.runtime.start(harness.workflow, makeInput(), 'exec-11');
    await harness.runtime.resume(
      harness.workflow,
      'exec-11',
      { installationId: 'install-1', healthy: true },
    );

    expect(harness.eventStore.events.map((e) => e.eventType)).toEqual([
      'deploy.preflight',
      'deploy.state.updating',
      'deploy.migration',
      'deploy.ecs-update',
      'deploy.infra-upgrade',
      'deploy.health',
      'deploy.state.healthy',
    ]);
  });

  it('emits state transitions with correct previous/requested states', async () => {
    await seedHealthy(harness.deploymentStore);

    await harness.runtime.start(harness.workflow, makeInput(), 'exec-12');
    await harness.runtime.resume(
      harness.workflow,
      'exec-12',
      { installationId: 'install-1', healthy: true },
    );

    const updating = harness.eventStore.events.find(
      (e) => e.eventType === 'deploy.state.updating',
    );
    const healthy = harness.eventStore.events.find(
      (e) => e.eventType === 'deploy.state.healthy',
    );

    expect(updating?.previousState).toBe('HEALTHY');
    expect(updating?.requestedState).toBe('UPDATING');
    expect(healthy?.previousState).toBe('UPDATING');
    expect(healthy?.requestedState).toBe('HEALTHY');
  });

  it('is idempotent on re-resume of a completed workflow', async () => {
    await seedHealthy(harness.deploymentStore);

    await harness.runtime.start(harness.workflow, makeInput(), 'exec-13');
    const first = await harness.runtime.resume(
      harness.workflow,
      'exec-13',
      { installationId: 'install-1', healthy: true },
    );
    const second = await harness.runtime.resume(
      harness.workflow,
      'exec-13',
      { installationId: 'install-1', healthy: true },
    );

    expect(second.status).toBe('COMPLETED');
    expect(second).toEqual(first);
    expect(harness.eventStore.count).toBe(7);
  });
});
