import { describe, expect, it } from 'vitest';

import type { EcsDeployClient, EcsDeployDeps } from './deploy.js';
import { memoryPendingStore, type PendingStore } from './pending.js';
import { createRestartExecutor, createRestartResumer } from './restart.js';
import type { CloudFormationReader, StackResource } from './verify.js';

const WEB_ARN = 'arn:aws:ecs:us-east-1:151955775369:service/app-cluster/WebService';
const WORKER_ARN = 'arn:aws:ecs:us-east-1:151955775369:service/app-cluster/EmailWorkerService';
const DEF_ARN = 'arn:aws:ecs:us-east-1:151955775369:task-definition/app:7';

const command = {
  id: 'job-restart',
  deploymentId: 'dep-1',
  type: 'RESTART' as const,
  idempotencyKey: 'dep-1:RESTART',
  payload: {},
};

interface FakeService {
  desiredCount: number;
  /** How the service's forced deployment starts: it completes at once or keeps rolling. */
  rollout: 'COMPLETED' | 'IN_PROGRESS';
  deploymentId: string;
  rolloutState: string;
  /** The circuit breaker leaves the failed deployment beside a restored PRIMARY. */
  failed: string | null;
}

function service(desiredCount = 1, rollout: FakeService['rollout'] = 'COMPLETED'): FakeService {
  return { desiredCount, rollout, deploymentId: 'ecs-svc/1', rolloutState: 'COMPLETED', failed: null };
}

function cfnWith(arns: string[] | null): CloudFormationReader {
  const resources: StackResource[] = (arns ?? []).map((arn) => ({
    logicalId: arn.split('/')[2]!,
    type: 'AWS::ECS::Service',
    status: 'CREATE_COMPLETE',
    physicalId: arn,
  }));
  resources.push({
    logicalId: 'TargetGroup',
    type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
    status: 'CREATE_COMPLETE',
    physicalId: 'arn:aws:elasticloadbalancing:us-east-1:151955775369:targetgroup/app/c1b2d3e4f5a6b7c8',
  });
  return {
    async describeStack() {
      return { found: true, stack: { stackName: 'deployz-app', status: 'CREATE_COMPLETE', tags: {}, stackId: 'id' } };
    },
    async describeStackResources() {
      return resources;
    },
    async listStackResources() {
      return arns === null ? null : { resources };
    },
  };
}

function setup(services: Record<string, FakeService>, options: { unreadableStack?: boolean; targetState?: string | string[] } = {}) {
  const updates: { service: string; forceNewDeployment?: boolean; taskDefinition?: string }[] = [];
  let sequence = 1;
  const ecs = {
    async describeServices(input: { services: string[] }) {
      return {
        services: input.services.map((arn) => {
          const svc = services[arn]!;
          return {
            desiredCount: svc.desiredCount,
            runningCount: svc.desiredCount,
            taskDefinition: DEF_ARN,
            deployments: [
              { id: svc.deploymentId, status: 'PRIMARY', taskDefinition: DEF_ARN, rolloutState: svc.rolloutState },
              ...(svc.failed !== null
                ? [{ id: svc.failed, status: 'ACTIVE', taskDefinition: DEF_ARN, rolloutState: 'FAILED' }]
                : []),
            ],
          };
        }),
      };
    },
    async updateService(input: { service: string; forceNewDeployment?: boolean; taskDefinition?: string }) {
      updates.push(input);
      const svc = services[input.service]!;
      sequence += 1;
      svc.deploymentId = `ecs-svc/${sequence}`;
      svc.rolloutState = svc.rollout;
    },
    async describeTaskDefinition() {
      return { taskDefinition: { family: 'app', containerDefinitions: [{ name: 'app', image: 'repo@sha256:aaa' }] } };
    },
    async listTasks() {
      return { taskArns: [] };
    },
    async describeTasks() {
      return { tasks: [] };
    },
  } as unknown as EcsDeployClient;
  const deps: EcsDeployDeps = {
    cfn: cfnWith(options.unreadableStack ? null : Object.keys(services)),
    ecs,
    elb: {
      async describeTargetHealth() {
        return { targets: [options.targetState ?? 'healthy'].flat().map((state) => ({ state })) };
      },
    },
    pending: memoryPendingStore(),
    stackName: 'deployz-app',
    installationId: 'inst-test',
    unappliedConfiguration: async () => [],
  };
  return { deps, updates, services };
}

function unreadableStore(store: PendingStore): PendingStore {
  return {
    ...store,
    read: async () => null,
    inspect: async () => ({ state: 'unreadable', errorCode: 'AccessDeniedException' }),
  };
}

describe('a restart whose result report is lost', () => {
  it('re-reports the settled result from the marker and forces nothing again', async () => {
    const { deps, updates } = setup({ [WEB_ARN]: service(1, 'COMPLETED') });
    expect((await createRestartExecutor(deps)(command)).deferred).toBe(true);
    const [first] = await createRestartResumer(deps)();
    expect(first).toMatchObject({ success: true });

    // The POST failed: nothing clears the marker, so the next poll repeats it.
    expect(await createRestartResumer(deps)()).toEqual([first]);
    // The control plane re-offers the same command: same answer, no second deployment.
    expect(await createRestartExecutor(deps)(command)).toEqual(first);
    expect(updates).toHaveLength(1);
    expect(await deps.pending.read()).toMatchObject({ phase: 'settled' });

    // Only an accepted report clears it, and only for this command.
    expect(await deps.pending.compareAndSet('job-restart', null)).toBe(true);
    expect(await deps.pending.read()).toBeNull();
  });

  it('keeps a failed rollout failed after a lost report', async () => {
    const { deps, services, updates } = setup({ [WEB_ARN]: service(1, 'IN_PROGRESS') });
    await createRestartExecutor(deps)(command);
    services[WEB_ARN]!.failed = services[WEB_ARN]!.deploymentId;
    services[WEB_ARN]!.deploymentId = 'ecs-svc/9';
    services[WEB_ARN]!.rolloutState = 'COMPLETED';
    const [failed] = await createRestartResumer(deps)();
    expect(failed?.success).toBe(false);

    expect(await createRestartExecutor(deps)(command)).toEqual(failed);
    expect(updates).toHaveLength(1);
  });

  it('survives a new process: a fresh executor over the same store never forces a second deployment', async () => {
    const { deps, updates } = setup({ [WEB_ARN]: service(0) });
    const first = await createRestartExecutor(deps)(command);
    const second = await createRestartExecutor({ ...deps })(command);
    expect(second).toEqual(first);
    expect(updates).toHaveLength(0);
  });

  it('writes nothing over a newer command marker when this command settles', async () => {
    const { deps } = setup({ [WEB_ARN]: service(1, 'COMPLETED') });
    await createRestartExecutor(deps)(command);
    const newer = {
      commandId: 'job-newer',
      idempotencyKey: 'dep-1:CONFIG_UPDATE',
      type: 'CONFIG_UPDATE',
      stackName: 'deployz-app',
      startedAt: '2026-10-13T00:00:00.000Z',
      payload: {},
    };
    const store = deps.pending;
    let first = true;
    const racing: PendingStore = {
      ...store,
      inspect: async () => {
        const seen = await store.inspect();
        if (first) {
          first = false;
          await store.write(newer);
        }
        return seen;
      },
    };
    expect(await createRestartResumer({ ...deps, pending: racing })()).toEqual([]);
    expect(await store.read()).toMatchObject({ commandId: 'job-newer', type: 'CONFIG_UPDATE' });
  });
});

describe('an unreadable pending marker', () => {
  it('defers the executor and the resumer without touching the service', async () => {
    const { deps, updates } = setup({ [WEB_ARN]: service() });
    const blind = { ...deps, pending: unreadableStore(deps.pending) };
    expect(await createRestartExecutor(blind)(command)).toMatchObject({ success: false, deferred: true });
    expect(await createRestartResumer(blind)()).toEqual([]);
    expect(updates).toHaveLength(0);
    expect(await deps.pending.read()).toBeNull();
  });
});

describe('restart authority', () => {
  it('forces nothing for a command the control plane no longer owns', async () => {
    const { deps, updates } = setup({ [WEB_ARN]: service() });
    const result = await createRestartExecutor({ ...deps, checkAuthority: async () => false })(command);
    expect(result).toMatchObject({ success: false });
    expect(result.deferred).toBeUndefined();
    expect(updates).toHaveLength(0);
    expect(await deps.pending.read()).toBeNull();
  });

  it('defers when the authority answer is unknown', async () => {
    const { deps, updates } = setup({ [WEB_ARN]: service() });
    const result = await createRestartExecutor({ ...deps, checkAuthority: async () => null })(command);
    expect(result).toMatchObject({ success: false, deferred: true });
    expect(updates).toHaveLength(0);
  });

  it('forces the restart for an active command', async () => {
    const { deps, updates } = setup({ [WEB_ARN]: service() });
    await createRestartExecutor({ ...deps, checkAuthority: async () => true })(command);
    expect(updates).toHaveLength(1);
  });
});

describe('createRestartExecutor', () => {
  it('defers while the forced rollout runs and records its deployment on the marker', async () => {
    const { deps, updates } = setup({ [WEB_ARN]: service(1, 'IN_PROGRESS') });
    const result = await createRestartExecutor(deps)(command);
    expect(result).toMatchObject({ success: false, deferred: true });
    expect(updates).toEqual([{ cluster: 'app-cluster', service: WEB_ARN, forceNewDeployment: true }]);
    const marker = await deps.pending.read();
    expect(marker?.type).toBe('RESTART');
    expect(marker?.payload['configRollouts']).toEqual({
      [WEB_ARN]: { taskDefinition: DEF_ARN, deploymentId: 'ecs-svc/2', newRevision: false },
    });
    // Still rolling: the resumer reports nothing and keeps the marker.
    expect(await createRestartResumer(deps)()).toEqual([]);
    expect(await deps.pending.read()).not.toBeNull();
  });

  it('reports success only after the rollout completed, then clears the marker', async () => {
    const { deps, services } = setup({ [WEB_ARN]: service(1, 'IN_PROGRESS') });
    await createRestartExecutor(deps)(command);
    expect(await createRestartResumer(deps)()).toEqual([]);
    services[WEB_ARN]!.rolloutState = 'COMPLETED';
    const [result] = await createRestartResumer(deps)();
    expect(result).toMatchObject({ commandId: 'job-restart', success: true, output: { executed: true, type: 'RESTART' } });
    expect(await deps.pending.read()).toMatchObject({ phase: 'settled' });
  });

  it('waits while an ALB target is not healthy yet', async () => {
    const { deps } = setup({ [WEB_ARN]: service() }, { targetState: 'initial' });
    expect((await createRestartExecutor(deps)(command)).deferred).toBe(true);
    expect(await createRestartResumer(deps)()).toEqual([]);
  });

  it('settles without waiting for a draining target', async () => {
    const { deps } = setup({ [WEB_ARN]: service() }, { targetState: ['healthy', 'draining'] });
    await createRestartExecutor(deps)(command);
    const [result] = await createRestartResumer(deps)();
    expect(result).toMatchObject({ commandId: 'job-restart', success: true });
  });

  it('still waits for a registering target next to a draining one', async () => {
    const { deps } = setup({ [WEB_ARN]: service() }, { targetState: ['initial', 'draining'] });
    await createRestartExecutor(deps)(command);
    expect(await createRestartResumer(deps)()).toEqual([]);
  });

  it('fails with ECS_DEPLOYMENT_FAILED when the circuit breaker rolled the rollout back', async () => {
    const { deps, services } = setup({ [WEB_ARN]: service(1, 'IN_PROGRESS') });
    expect((await createRestartExecutor(deps)(command)).deferred).toBe(true);
    services[WEB_ARN]!.failed = services[WEB_ARN]!.deploymentId;
    services[WEB_ARN]!.deploymentId = 'ecs-svc/9';
    services[WEB_ARN]!.rolloutState = 'COMPLETED';
    const [result] = await createRestartResumer(deps)();
    expect(result?.success).toBe(false);
    expect(result?.failureCode).toBe('ECS_DEPLOYMENT_FAILED');
    expect(result?.error).toContain('the restart never became healthy');
    expect(result?.error).not.toContain('Secret');
    expect(await deps.pending.read()).toMatchObject({ phase: 'settled' });
  });

  it('a replayed command waits on its own marker and never forces a second deployment', async () => {
    const { deps, updates, services } = setup({ [WEB_ARN]: service(1, 'IN_PROGRESS') });
    await createRestartExecutor(deps)(command);
    expect((await createRestartExecutor(deps)(command)).deferred).toBe(true);
    expect(updates).toHaveLength(1);

    services[WEB_ARN]!.rolloutState = 'COMPLETED';
    const replayed = await createRestartExecutor(deps)(command);
    expect(replayed).toMatchObject({ success: true, output: { executed: true, type: 'RESTART' } });
    expect(updates).toHaveLength(1);
    expect(await deps.pending.read()).toMatchObject({ phase: 'settled' });
  });

  it('restarts EVERY app service and waits for all of them', async () => {
    const { deps, updates, services } = setup({
      [WEB_ARN]: service(1, 'COMPLETED'),
      [WORKER_ARN]: service(1, 'IN_PROGRESS'),
    });
    expect((await createRestartExecutor(deps)(command)).deferred).toBe(true);
    expect(updates.map((update) => update.service)).toEqual([WEB_ARN, WORKER_ARN]);
    expect(await createRestartResumer(deps)()).toEqual([]);
    services[WORKER_ARN]!.rolloutState = 'COMPLETED';
    const [result] = await createRestartResumer(deps)();
    expect(result?.success).toBe(true);
  });

  it('succeeds at once when every service is at zero tasks, forcing nothing', async () => {
    const { deps, updates } = setup({ [WEB_ARN]: service(0) });
    const result = await createRestartExecutor(deps)(command);
    expect(result.success).toBe(true);
    expect(updates).toHaveLength(0);
    expect(await deps.pending.read()).toMatchObject({ phase: 'settled' });
  });

  it('does not fail a restart whose stack resources cannot be read', async () => {
    const { deps, updates } = setup({ [WEB_ARN]: service() }, { unreadableStack: true });
    const result = await createRestartExecutor(deps)(command);
    expect(result).toMatchObject({ success: false, deferred: true });
    expect(result.error).toBeUndefined();
    expect(updates).toHaveLength(0);
  });

  it('fails when there is no service to restart', async () => {
    const { deps } = setup({});
    expect((await createRestartExecutor(deps)(command)).success).toBe(false);
  });
});

describe('createRestartResumer', () => {
  it('ignores a marker of another command type', async () => {
    const { deps } = setup({ [WEB_ARN]: service() });
    await deps.pending.write({
      commandId: 'job-config',
      idempotencyKey: 'dep-1:CONFIG_UPDATE',
      type: 'CONFIG_UPDATE',
      stackName: 'deployz-app',
      startedAt: '2026-10-13T00:00:00.000Z',
      payload: {},
    });
    expect(await createRestartResumer(deps)()).toEqual([]);
    expect(await deps.pending.read()).not.toBeNull();
  });
});
