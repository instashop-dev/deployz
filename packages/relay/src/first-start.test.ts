import { describe, expect, it } from 'vitest';

import { createConfigUpdateExecutor, unappliedConfigurationKeys, type EffectiveConfigEntry } from './config-update.js';
import {
  createEcsDeployExecutor,
  createEcsDeployResumer,
  type EcsDeployClient,
  type EcsDeployDeps,
  type EcsTaskDefinition,
} from './deploy.js';
import { memoryPendingStore } from './pending.js';
import type { CloudFormationReader, StackResource } from './verify.js';

const REPO = '151955775369.dkr.ecr.us-east-1.amazonaws.com/deployz-images';
const DIGEST = 'sha256:' + '2'.repeat(64);
const DIGEST_NEXT = 'sha256:' + '3'.repeat(64);
const SERVICE_ARN = 'arn:aws:ecs:us-east-1:151955775369:service/app-cluster/app-service';
const CONFIG_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:151955775369:secret:AppConfigSecret-abc123';
const REVISION_PREFIX = 'arn:aws:ecs:us-east-1:151955775369:task-definition/app:';
const REV1 = `${REVISION_PREFIX}1`;
const REV2 = `${REVISION_PREFIX}2`;

const ENTRIES: EffectiveConfigEntry[] = [
  { key: 'MEMOS_DRIVER', isSecret: false, value: 'postgres', source: 'vendor' },
];

type Mutation =
  | { kind: 'register'; arn: string }
  | {
      kind: 'update';
      taskDefinition?: string;
      desiredCount?: number;
      /** The service state ECS holds after this call. */
      resultingTaskDefinition: string;
      resultingDesiredCount: number;
    };

interface World {
  service: {
    desiredCount: number;
    runningCount: number;
    taskDefinition: string;
    deployments: { status: string; rolloutState: string; taskDefinition: string }[];
  };
  definitions: Map<string, EcsTaskDefinition>;
  latest: string;
  /** Every ECS mutation, in call order. */
  log: Mutation[];
  failNextUpdate: boolean;
  failRegister: boolean;
}

/**
 * One ECS service shared by every executor. The template's revision (rev1)
 * already runs the release image but lacks MEMOS_DRIVER, and the service is
 * created at zero tasks (an install waiting for configuration).
 */
function createWorld(desiredCount = 0): World {
  const rev1: EcsTaskDefinition = {
    family: 'app',
    cpu: '256',
    memory: '512',
    networkMode: 'awsvpc',
    requiresCompatibilities: ['FARGATE'],
    executionRoleArn: 'arn:aws:iam::151955775369:role/deployz/app-execution',
    taskRoleArn: 'arn:aws:iam::151955775369:role/deployz/app-task',
    containerDefinitions: [
      { name: 'app', image: `${REPO}@${DIGEST}`, environment: [{ name: 'NODE_ENV', value: 'production' }] },
    ],
  };
  return {
    service: {
      desiredCount,
      runningCount: desiredCount,
      taskDefinition: REV1,
      deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED', taskDefinition: REV1 }],
    },
    definitions: new Map([[REV1, rev1]]),
    latest: REV1,
    log: [],
    failNextUpdate: false,
    failRegister: false,
  };
}

function fakeEcs(world: World): EcsDeployClient {
  return {
    async describeServices() {
      return { services: [world.service] };
    },
    async describeTaskDefinition({ taskDefinition }) {
      // An ARN names its revision; a bare family name names the latest one.
      const arn = world.definitions.has(taskDefinition) ? taskDefinition : world.latest;
      const found = world.definitions.get(arn)!;
      return {
        taskDefinition: {
          ...found,
          taskDefinitionArn: arn,
          containerDefinitions: found.containerDefinitions.map((container) => ({ ...container })),
        },
      };
    },
    async registerTaskDefinition(input) {
      if (world.failRegister) throw new Error('AccessDenied');
      const arn = `${REVISION_PREFIX}${world.definitions.size + 1}`;
      world.definitions.set(arn, {
        family: input.family,
        cpu: input.cpu,
        memory: input.memory,
        networkMode: input.networkMode,
        requiresCompatibilities: input.requiresCompatibilities,
        executionRoleArn: input.executionRoleArn,
        taskRoleArn: input.taskRoleArn,
        containerDefinitions: input.containerDefinitions as EcsTaskDefinition['containerDefinitions'],
      });
      world.latest = arn;
      world.log.push({ kind: 'register', arn });
      return { taskDefinitionArn: arn };
    },
    async updateService(input) {
      if (world.failNextUpdate) {
        world.failNextUpdate = false;
        throw new Error('ServiceNotActiveException');
      }
      // ECS keeps what an update leaves out.
      if (input.taskDefinition !== undefined) {
        world.service.taskDefinition = input.taskDefinition;
        world.service.deployments = [
          { status: 'PRIMARY', rolloutState: 'COMPLETED', taskDefinition: input.taskDefinition },
        ];
      }
      if (input.desiredCount !== undefined) world.service.desiredCount = input.desiredCount;
      world.log.push({
        kind: 'update',
        ...(input.taskDefinition !== undefined ? { taskDefinition: input.taskDefinition } : {}),
        ...(input.desiredCount !== undefined ? { desiredCount: input.desiredCount } : {}),
        resultingTaskDefinition: world.service.taskDefinition,
        resultingDesiredCount: world.service.desiredCount,
      });
    },
    async listTasks() {
      return { taskArns: [] };
    },
    async describeTasks() {
      return { tasks: [] };
    },
  };
}

const RESOURCES: StackResource[] = [
  { logicalId: 'Service', type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE', physicalId: SERVICE_ARN },
  {
    logicalId: 'TargetGroup',
    type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
    status: 'CREATE_COMPLETE',
    physicalId: 'arn:aws:elasticloadbalancing:us-east-1:151955775369:targetgroup/app/c1b2d3e4f5a6b7c8',
  },
  {
    logicalId: 'AppConfigSecret251CAC1E',
    type: 'AWS::SecretsManager::Secret',
    status: 'CREATE_COMPLETE',
    physicalId: CONFIG_SECRET_ARN,
  },
];

const cfn: CloudFormationReader = {
  async describeStack() {
    return { found: true, stack: { stackName: 'deployz-app', status: 'CREATE_COMPLETE', tags: {} } };
  },
  async describeStackResources() {
    return RESOURCES;
  },
};

const elb = {
  async describeTargetHealth() {
    return { targets: [{ state: 'healthy' }] };
  },
};

const secrets = {
  async getSecretValue() {
    return { arn: CONFIG_SECRET_ARN, secretString: '{}' };
  },
  async putSecretValue() {},
};

function deployCommand(imageDigest: string) {
  return {
    id: 'job-1',
    deploymentId: 'dep-1',
    type: 'DEPLOY_RELEASE' as const,
    idempotencyKey: 'dep-1:DEPLOY_RELEASE',
    payload: { imageRepository: REPO, imageDigest },
  };
}

/** The configuration executor and the deploy executor over one shared ECS service. */
function createRelay(world: World) {
  const ecs = fakeEcs(world);
  const configDeps = {
    cfn,
    ecs,
    secrets,
    fetchEffectiveConfig: async () => ENTRIES,
    stackName: 'deployz-app',
    installationId: 'inst-test',
  };
  const deployDeps: EcsDeployDeps = {
    cfn,
    ecs,
    elb,
    pending: memoryPendingStore(),
    stackName: 'deployz-app',
    installationId: 'inst-test',
    unappliedConfiguration: (definition) => unappliedConfigurationKeys(configDeps, definition),
    migrationPollIntervalMs: 0,
  };
  const configure = createConfigUpdateExecutor(configDeps);
  const deploy = createEcsDeployExecutor(deployDeps);
  const resume = createEcsDeployResumer(deployDeps);
  return {
    pending: deployDeps.pending,
    configure: () =>
      configure({
        id: 'job-config',
        deploymentId: 'dep-1',
        type: 'CONFIG_UPDATE',
        idempotencyKey: 'dep-1:CONFIG_UPDATE:msg-1',
        payload: { changedKeys: ['MEMOS_DRIVER'] },
      }),
    deploy: () => deploy(deployCommand(DIGEST)),
    resume,
  };
}

/** The log as readable lines: `register app:2`, `update app:2 count=1` (`-` = left out). */
function summarize(log: readonly Mutation[]): string[] {
  const short = (arn: string): string => arn.slice(arn.lastIndexOf('/') + 1);
  return log.map((mutation) =>
    mutation.kind === 'register'
      ? `register ${short(mutation.arn)}`
      : `update ${mutation.taskDefinition === undefined ? '-' : short(mutation.taskDefinition)} count=${mutation.desiredCount ?? '-'}`,
  );
}

/** No call may leave tasks running (or ask for them) on an unconfigured revision. */
function expectNoUnsafeStart(log: readonly Mutation[], unconfiguredArns: readonly string[]): void {
  const unsafe = log.filter(
    (mutation) =>
      mutation.kind === 'update' &&
      ((mutation.resultingDesiredCount > 0 && unconfiguredArns.includes(mutation.resultingTaskDefinition)) ||
        ((mutation.desiredCount ?? 0) > 0 &&
          mutation.taskDefinition !== undefined &&
          unconfiguredArns.includes(mutation.taskDefinition))),
  );
  expect(unsafe).toEqual([]);
}

describe('first start of a service created at zero tasks', () => {
  it('configures first, then scales up with one update on the configured revision (DEPLOY-009)', async () => {
    const world = createWorld();
    const relay = createRelay(world);

    expect((await relay.configure()).success).toBe(true);
    expect((await relay.deploy()).deferred).toBe(true);

    expect(summarize(world.log)).toEqual(['register app:2', 'update app:2 count=-', 'update app:2 count=1']);
    expect(world.log[1]).toMatchObject({ resultingDesiredCount: 0 });
    expectNoUnsafeStart(world.log, [REV1]);
    expect(world.service).toMatchObject({ taskDefinition: REV2, desiredCount: 1 });
  });

  it('defers a deploy that runs before the configuration and starts the service once configured (DEPLOY-009)', async () => {
    const world = createWorld();
    const relay = createRelay(world);

    expect((await relay.deploy()).deferred).toBe(true);
    expect(world.log).toEqual([]);
    expect(world.service).toMatchObject({ taskDefinition: REV1, desiredCount: 0 });

    expect((await relay.configure()).success).toBe(true);
    expect(summarize(world.log)).toEqual(['register app:2', 'update app:2 count=-']);
    expect(world.service).toMatchObject({ taskDefinition: REV2, desiredCount: 0 });

    // The marker of the deferred deploy has no rollout facts yet.
    expect((await relay.pending.read())?.payload['startedFromZero']).toBeUndefined();
    expect(await relay.resume()).toEqual([]);

    expect(summarize(world.log)).toEqual(['register app:2', 'update app:2 count=-', 'update app:2 count=1']);
    expectNoUnsafeStart(world.log, [REV1]);
    const payload = (await relay.pending.read())?.payload;
    expect(payload?.['startedFromZero']).toBe(true);
    expect(payload?.['targetTaskDefinitionArns']).toEqual({ [SERVICE_ARN]: REV2 });
  });

  it('does not register again when the configuration replays, and scales up exactly once (DEPLOY-009)', async () => {
    const world = createWorld();
    const relay = createRelay(world);

    expect((await relay.configure()).success).toBe(true);
    const afterFirst = summarize(world.log);
    const replay = await relay.configure();
    expect(replay.success).toBe(true);
    expect((replay.output as { alreadyApplied: boolean }).alreadyApplied).toBe(true);
    expect(summarize(world.log)).toEqual(afterFirst);

    await relay.deploy();
    expect(summarize(world.log)).toEqual(['register app:2', 'update app:2 count=-', 'update app:2 count=1']);
  });

  it('never scales from zero a second time, nor touches the unconfigured revision, when the deploy re-runs (DEPLOY-009)', async () => {
    const world = createWorld();
    const relay = createRelay(world);
    await relay.configure();
    await relay.deploy();
    const scaled = world.log.length;

    await relay.deploy();
    await relay.resume();

    const rerun = world.log.slice(scaled);
    expect(rerun.filter((mutation) => mutation.kind === 'register')).toEqual([]);
    for (const mutation of rerun) {
      expect(mutation).toMatchObject({ kind: 'update', taskDefinition: REV2 });
      expect((mutation as { desiredCount?: number }).desiredCount).toBeUndefined();
    }
    expectNoUnsafeStart(world.log, [REV1]);
    expect(world.service).toMatchObject({ taskDefinition: REV2, desiredCount: 1 });
  });

  it('reuses the revision a failed attach registered and starts it only once attached (DEPLOY-009)', async () => {
    const world = createWorld();
    const relay = createRelay(world);

    world.failNextUpdate = true;
    expect((await relay.configure()).success).toBe(false);
    expect(summarize(world.log)).toEqual(['register app:2']);
    expect(world.service).toMatchObject({ taskDefinition: REV1, desiredCount: 0 });

    expect((await relay.deploy()).deferred).toBe(true);
    expect(summarize(world.log)).toEqual(['register app:2']);
    expect(world.service).toMatchObject({ taskDefinition: REV1, desiredCount: 0 });

    expect((await relay.configure()).success).toBe(true);
    expect(summarize(world.log)).toEqual(['register app:2', 'update app:2 count=-']);
    expect(world.service).toMatchObject({ taskDefinition: REV2, desiredCount: 0 });

    expect(await relay.resume()).toEqual([]);
    expect(summarize(world.log)).toEqual(['register app:2', 'update app:2 count=-', 'update app:2 count=1']);
    expect(world.log.filter((mutation) => mutation.kind === 'register')).toHaveLength(1);
    expectNoUnsafeStart(world.log, [REV1]);
  });

  it('fails closed: a service whose configuration never arrives stays at zero tasks (DEPLOY-009)', async () => {
    const world = createWorld();
    const relay = createRelay(world);
    world.failRegister = true;

    expect((await relay.configure()).success).toBe(false);
    expect((await relay.deploy()).deferred).toBe(true);
    for (let pass = 0; pass < 3; pass++) {
      expect(await relay.resume()).toEqual([]);
      expect((await relay.configure()).success).toBe(false);
    }
    expect((await relay.deploy()).deferred).toBe(true);

    expect(world.log).toEqual([]);
    expect(world.service).toMatchObject({ taskDefinition: REV1, desiredCount: 0 });
  });

  it('leaves a running service alone: day-2 deploys never ask for the configuration (DEPLOY-009)', async () => {
    const world = createWorld(1);
    const executor = createEcsDeployExecutor({
      cfn,
      ecs: fakeEcs(world),
      elb,
      pending: memoryPendingStore(),
      stackName: 'deployz-app',
      installationId: 'inst-test',
      unappliedConfiguration: async () => {
        throw new Error('a running service must not be checked');
      },
    });

    const result = await executor(deployCommand(DIGEST_NEXT));

    expect(result.deferred).toBe(true);
    expect(summarize(world.log)).toEqual(['register app:2', 'update app:2 count=-']);
    expect(world.service).toMatchObject({ taskDefinition: REV2, desiredCount: 1 });
  });
});
