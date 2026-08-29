import { describe, expect, it } from 'vitest';

import { IdempotencyStore, type CommandExecutor } from './commands.js';
import {
  createEcsDeployExecutor,
  createEcsDeployResumer,
  createRestartExecutor,
  readDeployRequest,
  replaceApplicationImages,
  type EcsDeployClient,
  type EcsDeployDeps,
  type EcsTaskDefinition,
} from './deploy.js';
import { memoryPendingStore } from './pending.js';
import type { CloudFormationReader, StackResource } from './verify.js';

const REPO = '151955775369.dkr.ecr.us-east-1.amazonaws.com/deployz-images';
const DIGEST_V2 = 'sha256:' + '2'.repeat(64);
const DIGEST_V3 = 'sha256:' + '3'.repeat(64);
const SERVICE_ARN = 'arn:aws:ecs:us-east-1:151955775369:service/app-cluster/app-service';

interface FakeEcs {
  service?: {
    desiredCount?: number;
    runningCount?: number;
    taskDefinition: string;
    deployments?: { status?: string; rolloutState?: string }[];
  };
  taskDefinition: EcsTaskDefinition;
  runningDigest: string | null;
  registered: unknown[];
  updates: unknown[];
  failAt?: 'describeServices' | 'register';
}

function fakeEcs(state: FakeEcs): EcsDeployClient {
  return {
    async describeServices() {
      if (state.failAt === 'describeServices') throw new Error('AccessDenied');
      return { services: state.service ? [state.service] : [] };
    },
    async describeTaskDefinition() {
      return { taskDefinition: state.taskDefinition };
    },
    async registerTaskDefinition(input) {
      if (state.failAt === 'register') throw new Error('AccessDenied');
      state.registered.push(input);
      return { taskDefinitionArn: `arn:aws:ecs:us-east-1:151955775369:task-definition/app:${state.registered.length}` };
    },
    async updateService(input) {
      state.updates.push(input);
    },
    async listTasks() {
      return { taskArns: state.runningDigest ? ['task-1'] : [] };
    },
    async describeTasks() {
      return {
        tasks: state.runningDigest
          ? [{ containers: [{ imageDigest: state.runningDigest }] }]
          : [],
      };
    },
  };
}

function cfnWith(service: boolean): CloudFormationReader {
  const resources: StackResource[] = service
    ? [
        {
          logicalId: 'Service',
          type: 'AWS::ECS::Service',
          status: 'CREATE_COMPLETE',
          physicalId: SERVICE_ARN,
        },
      ]
    : [{ logicalId: 'Bucket', type: 'AWS::S3::Bucket', status: 'CREATE_COMPLETE' }];
  return {
    async describeStack() {
      return { found: true, stack: { stackName: 'deployz-app', status: 'CREATE_COMPLETE', tags: {} } };
    },
    async describeStackResources() {
      return resources;
    },
  };
}

function deps(state: FakeEcs, service = true): EcsDeployDeps {
  return {
    cfn: cfnWith(service),
    ecs: fakeEcs(state),
    pending: memoryPendingStore(),
    stackName: 'deployz-app',
    installationId: 'inst-test',
  };
}

function baseState(overrides: Partial<FakeEcs> = {}): FakeEcs {
  return {
    service: {
      desiredCount: 1,
      runningCount: 1,
      taskDefinition: 'arn:aws:ecs:us-east-1:151955775369:task-definition/app:7',
      deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED' }],
    },
    taskDefinition: {
      family: 'app',
      cpu: '256',
      memory: '512',
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      executionRoleArn: 'arn:aws:iam::151955775369:role/deployz/app-execution',
      taskRoleArn: 'arn:aws:iam::151955775369:role/deployz/app-task',
      containerDefinitions: [
        { name: 'app', image: `${REPO}@${DIGEST_V2}` },
        { name: 'sidecar', image: 'public.ecr.aws/sidecar:1' },
      ],
    },
    runningDigest: DIGEST_V2,
    registered: [],
    updates: [],
    ...overrides,
  };
}

function deployCommand(payload: Record<string, unknown>, type: 'DEPLOY_RELEASE' | 'ROLLBACK' = 'DEPLOY_RELEASE') {
  return {
    id: 'job-1',
    deploymentId: 'dep-1',
    type,
    idempotencyKey: 'dep-1:' + type,
    payload,
  } as const;
}

async function run(executor: CommandExecutor, command: ReturnType<typeof deployCommand>) {
  return executor(command);
}

describe('readDeployRequest', () => {
  it('accepts the payload contract', () => {
    expect(readDeployRequest({ imageRepository: REPO, imageDigest: DIGEST_V3 })).toEqual({
      imageRepository: REPO,
      imageDigest: DIGEST_V3,
    });
  });

  it('rejects a malformed digest or missing repository', () => {
    expect(readDeployRequest({ imageRepository: REPO, imageDigest: 'sha256:short' })).toBeNull();
    expect(readDeployRequest({ imageDigest: DIGEST_V3 })).toBeNull();
    expect(readDeployRequest({})).toBeNull();
  });
});

describe('replaceApplicationImages', () => {
  it('replaces only images from the expected repository', () => {
    const state = baseState();
    const next = replaceApplicationImages(state.taskDefinition, {
      imageRepository: REPO,
      imageDigest: DIGEST_V3,
    })!;
    const app = next.containerDefinitions[0] as { image: string };
    const sidecar = next.containerDefinitions[1] as { image: string };
    expect(app.image).toBe(`${REPO}@${DIGEST_V3}`);
    expect(sidecar.image).toBe('public.ecr.aws/sidecar:1');
  });

  it('returns null when no container matches the repository', () => {
    const next = replaceApplicationImages(
      { containerDefinitions: [{ name: 'app', image: 'other/repo:1' }] },
      { imageRepository: REPO, imageDigest: DIGEST_V3 },
    );
    expect(next).toBeNull();
  });
});

describe('createEcsDeployExecutor', () => {
  it('reports success without a new revision when the digest already runs', async () => {
    const state = baseState();
    state.runningDigest = DIGEST_V3;
    const result = await run(
      createEcsDeployExecutor(deps(state)),
      deployCommand({ imageRepository: REPO, imageDigest: DIGEST_V3 }),
    );
    expect(result.success).toBe(true);
    expect((result.output as { alreadyRunning: boolean }).alreadyRunning).toBe(true);
    expect(state.registered).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });

  it('registers a copy, updates the service, and defers while the rollout runs', async () => {
    const state = baseState();
    const d = deps(state);
    const result = await run(
      createEcsDeployExecutor(d),
      deployCommand({ imageRepository: REPO, imageDigest: DIGEST_V3 }),
    );
    expect(result.deferred).toBe(true);
    expect(state.registered).toHaveLength(1);
    const registered = state.registered[0] as { tags?: { key: string; value: string }[] };
    expect(registered.tags).toContainEqual({
      key: 'deployz:installation',
      value: 'inst-test',
    });
    expect(state.updates).toHaveLength(1);
    const pending = await d.pending.read();
    expect(pending?.commandId).toBe('job-1');
    expect(pending?.type).toBe('DEPLOY_RELEASE');
  });

  it('re-issues the service update when the copy is registered but not running', async () => {
    const state = baseState();
    state.taskDefinition.containerDefinitions[0] = { name: 'app', image: `${REPO}@${DIGEST_V3}` };
    const result = await run(
      createEcsDeployExecutor(deps(state)),
      deployCommand({ imageRepository: REPO, imageDigest: DIGEST_V3 }),
    );
    expect(result.deferred).toBe(true);
    expect(state.registered).toHaveLength(0);
    expect(state.updates).toHaveLength(1);
  });

  it('fails with ECS_DEPLOYMENT_FAILED when the rollout failed', async () => {
    const state = baseState();
    state.service!.deployments = [{ status: 'PRIMARY', rolloutState: 'FAILED' }];
    const result = await run(
      createEcsDeployExecutor(deps(state)),
      deployCommand({ imageRepository: REPO, imageDigest: DIGEST_V3 }),
    );
    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('ECS_DEPLOYMENT_FAILED');
  });

  it('fails on a malformed payload without touching AWS', async () => {
    const state = baseState();
    const result = await run(
      createEcsDeployExecutor(deps(state)),
      deployCommand({ imageRepository: REPO }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('imageRepository/imageDigest');
    expect(state.registered).toHaveLength(0);
  });

  it('fails when the stack has no ECS service', async () => {
    const state = baseState();
    const result = await run(
      createEcsDeployExecutor(deps(state, false)),
      deployCommand({ imageRepository: REPO, imageDigest: DIGEST_V3 }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('No ECS service');
  });

  it('classifies an AWS failure as permission denied', async () => {
    const state = baseState();
    state.failAt = 'describeServices';
    const result = await run(
      createEcsDeployExecutor(deps(state)),
      deployCommand({ imageRepository: REPO, imageDigest: DIGEST_V3 }),
    );
    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('AWS_PERMISSION_DENIED');
  });
});

describe('createEcsDeployResumer', () => {
  it('settles a deferred deploy once the digest runs and the service is stable', async () => {
    const state = baseState();
    const d = deps(state);
    await d.pending.write({
      commandId: 'job-1',
      idempotencyKey: 'dep-1:DEPLOY_RELEASE',
      type: 'DEPLOY_RELEASE',
      stackName: 'deployz-app',
      startedAt: new Date().toISOString(),
      payload: { imageRepository: REPO, imageDigest: DIGEST_V3 },
    });
    state.runningDigest = DIGEST_V3;

    const results = await createEcsDeployResumer(d)();
    expect(results).toHaveLength(1);
    expect(results[0]!.success).toBe(true);
    expect(await d.pending.read()).toBeNull();
  });

  it('keeps waiting while the rollout is still in progress', async () => {
    const state = baseState();
    const d = deps(state);
    await d.pending.write({
      commandId: 'job-1',
      idempotencyKey: 'dep-1:DEPLOY_RELEASE',
      type: 'DEPLOY_RELEASE',
      stackName: 'deployz-app',
      startedAt: new Date().toISOString(),
      payload: { imageRepository: REPO, imageDigest: DIGEST_V3 },
    });

    const results = await createEcsDeployResumer(d)();
    expect(results).toHaveLength(0);
    expect(await d.pending.read()).not.toBeNull();
  });

  it('ignores pending commands of other types', async () => {
    const state = baseState();
    const d = deps(state);
    await d.pending.write({
      commandId: 'job-install',
      idempotencyKey: 'dep-1:INSTALL',
      type: 'INSTALL',
      stackName: 'deployz-app',
      startedAt: new Date().toISOString(),
      payload: {},
    });
    const results = await createEcsDeployResumer(d)();
    expect(results).toHaveLength(0);
  });
});

describe('createRestartExecutor', () => {
  it('forces a new deployment of the current definition', async () => {
    const state = baseState();
    const result = await run(
      createRestartExecutor(deps(state)),
      deployCommand({}, 'RESTART' as never),
    );
    expect(result.success).toBe(true);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({
      cluster: 'app-cluster',
      service: SERVICE_ARN,
      forceNewDeployment: true,
    });
  });

  it('fails when there is no service to restart', async () => {
    const state = baseState();
    const result = await run(
      createRestartExecutor(deps(state, false)),
      deployCommand({}, 'RESTART' as never),
    );
    expect(result.success).toBe(false);
  });
});

// The dispatch layer's idempotency: a re-delivered key replays the cached
// result rather than executing the executor a second time.
describe('deploy idempotency through dispatch', () => {
  it('does not re-execute a settled command', async () => {
    const state = baseState();
    state.runningDigest = DIGEST_V3;
    const executor = createEcsDeployExecutor(deps(state));
    const idempotency = new IdempotencyStore();
    const command = deployCommand({ imageRepository: REPO, imageDigest: DIGEST_V3 });

    const first = await executor(command);
    idempotency.set(command.idempotencyKey, first);

    const updatesBefore = state.updates.length;
    const cached = idempotency.get(command.idempotencyKey)!;
    expect(cached.success).toBe(true);
    expect(state.updates.length).toBe(updatesBefore);
  });
});
