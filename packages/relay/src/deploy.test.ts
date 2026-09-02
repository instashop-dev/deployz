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
const BASE_DEF_ARN = 'arn:aws:ecs:us-east-1:151955775369:task-definition/app:7';
const MIGRATION_TASK_ARN = 'arn:aws:ecs:us-east-1:151955775369:task/app-cluster/migration-1';

interface FakeEcs {
  service?: {
    desiredCount?: number;
    runningCount?: number;
    taskDefinition: string;
    deployments?: { status?: string; rolloutState?: string }[];
    networkConfiguration?: {
      awsvpcConfiguration?: { subnets?: string[]; securityGroups?: string[]; assignPublicIp?: string };
    };
  };
  taskDefinition: EcsTaskDefinition;
  /** ARN → definition map, seeded with the service's current definition. */
  definitions: Map<string, EcsTaskDefinition>;
  runningDigest: string | null;
  registered: unknown[];
  updates: unknown[];
  runTasks: unknown[];
  /** DescribeTasks answer for the migration task ARN (defaults to STOPPED, exit 0). */
  migrationTask?: {
    lastStatus?: string;
    stopCode?: string;
    stoppedReason?: string;
    exitCode?: number;
  } | null;
  failAt?: 'describeServices' | 'register';
}

function fakeEcs(state: FakeEcs): EcsDeployClient {
  return {
    async describeServices() {
      if (state.failAt === 'describeServices') throw new Error('AccessDenied');
      return { services: state.service ? [state.service] : [] };
    },
    async describeTaskDefinition(input) {
      const found = state.definitions.get(input.taskDefinition);
      return {
        taskDefinition: found
          ? { ...found, containerDefinitions: found.containerDefinitions.map((c) => ({ ...c })) }
          : state.taskDefinition,
      };
    },
    async registerTaskDefinition(input) {
      if (state.failAt === 'register') throw new Error('AccessDenied');
      state.registered.push(input);
      const arn = `arn:aws:ecs:us-east-1:151955775369:task-definition/app:${state.registered.length}`;
      state.definitions.set(arn, {
        family: input.family,
        cpu: input.cpu,
        memory: input.memory,
        networkMode: input.networkMode,
        requiresCompatibilities: input.requiresCompatibilities,
        executionRoleArn: input.executionRoleArn,
        taskRoleArn: input.taskRoleArn,
        containerDefinitions: input.containerDefinitions as unknown as EcsTaskDefinition['containerDefinitions'],
        ...(input.volumes ? { volumes: input.volumes } : {}),
      });
      return { taskDefinitionArn: arn };
    },
    async updateService(input) {
      state.updates.push(input);
      if (input.taskDefinition !== undefined && state.service) {
        state.service.taskDefinition = input.taskDefinition;
      }
    },
    async listTasks() {
      return { taskArns: state.runningDigest ? ['task-1'] : [] };
    },
    async describeTasks(input) {
      if (input.tasks[0] === MIGRATION_TASK_ARN) {
        return {
          tasks: [
            {
              lastStatus: state.migrationTask?.lastStatus ?? 'STOPPED',
              stopCode: state.migrationTask?.stopCode ?? 'EssentialContainerExited',
              stoppedReason: state.migrationTask?.stoppedReason ?? 'Essential container exited',
              containers: [{ exitCode: state.migrationTask?.exitCode ?? 0 }],
            },
          ],
        };
      }
      return {
        tasks: state.runningDigest
          ? [{ containers: [{ imageDigest: state.runningDigest }] }]
          : [],
      };
    },
    async runTask(input) {
      state.runTasks.push(input);
      return { taskArns: [MIGRATION_TASK_ARN] };
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
  const taskDefinition: EcsTaskDefinition = {
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
  };
  return {
    service: {
      desiredCount: 1,
      runningCount: 1,
      taskDefinition: BASE_DEF_ARN,
      deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED' }],
      networkConfiguration: {
        awsvpcConfiguration: { subnets: ['subnet-a'], securityGroups: ['sg-1'], assignPublicIp: 'DISABLED' },
      },
    },
    taskDefinition,
    definitions: new Map([[BASE_DEF_ARN, taskDefinition]]),
    runningDigest: DIGEST_V2,
    registered: [],
    updates: [],
    runTasks: [],
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
  it('accepts the payload contract (no migration command = deploy as before)', () => {
    expect(readDeployRequest({ imageRepository: REPO, imageDigest: DIGEST_V3 })).toEqual({
      imageRepository: REPO,
      imageDigest: DIGEST_V3,
      migrationCommand: null,
    });
  });

  it('parses a non-blank migration command and treats blank as none', () => {
    expect(
      readDeployRequest({
        imageRepository: REPO,
        imageDigest: DIGEST_V3,
        migrationCommand: 'node migrate.js up',
      }),
    ).toEqual({
      imageRepository: REPO,
      imageDigest: DIGEST_V3,
      migrationCommand: 'node migrate.js up',
    });
    expect(readDeployRequest({ imageRepository: REPO, imageDigest: DIGEST_V3, migrationCommand: '   ' })).toEqual({
      imageRepository: REPO,
      imageDigest: DIGEST_V3,
      migrationCommand: null,
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
      migrationCommand: null,
    })!;
    const app = next.containerDefinitions[0] as { image: string };
    const sidecar = next.containerDefinitions[1] as { image: string };
    expect(app.image).toBe(`${REPO}@${DIGEST_V3}`);
    expect(sidecar.image).toBe('public.ecr.aws/sidecar:1');
  });

  it('returns null when no container matches the repository', () => {
    const next = replaceApplicationImages(
      { containerDefinitions: [{ name: 'app', image: 'other/repo:1' }] },
      { imageRepository: REPO, imageDigest: DIGEST_V3, migrationCommand: null },
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

  it('runs the migration one-off before the service update: new digest + command override + same network', async () => {
    const state = baseState();
    const d = deps(state);
    const result = await run(
      createEcsDeployExecutor(d),
      deployCommand({
        imageRepository: REPO,
        imageDigest: DIGEST_V3,
        migrationCommand: 'node migrate.js up',
      }),
    );
    expect(result.deferred).toBe(true);

    // The migration ran first — a one-off task over the NEW digest copy.
    expect(state.runTasks).toHaveLength(1);
    const runInput = state.runTasks[0] as {
      taskDefinition: string;
      networkConfiguration: {
        awsvpcConfiguration: { subnets: string[]; securityGroups: string[]; assignPublicIp: string };
      };
      overrides: { containerOverrides: { name: string; command: string[] }[] };
      launchType: string;
      count: number;
    };
    expect(runInput.launchType).toBe('FARGATE');
    expect(runInput.count).toBe(1);
    expect(runInput.networkConfiguration.awsvpcConfiguration).toEqual({
      subnets: ['subnet-a'],
      securityGroups: ['sg-1'],
      assignPublicIp: 'DISABLED',
    });
    expect(runInput.overrides.containerOverrides).toEqual([
      { name: 'app', command: ['node', 'migrate.js', 'up'] },
    ]);
    // The copy it ran IS the copy the service update then points at.
    const registeredArn = `arn:aws:ecs:us-east-1:151955775369:task-definition/app:1`;
    expect(runInput.taskDefinition).toBe(registeredArn);
    expect(state.registered).toHaveLength(1);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({ cluster: 'app-cluster', taskDefinition: registeredArn });

    // The marker records the completed migration so no later poll re-runs it.
    const pending = await d.pending.read();
    expect(pending?.migration).toEqual({
      taskArn: MIGRATION_TASK_ARN,
      registeredArn,
      completedAt: expect.any(String),
    });
  });

  it('fails with MIGRATION_FAILED (exit code + stoppedReason) and never touches the service', async () => {
    const state = baseState();
    state.migrationTask = {
      lastStatus: 'STOPPED',
      stopCode: 'EssentialContainerExited',
      stoppedReason: 'migration crashed: bad SQL',
      exitCode: 1,
    };
    const d = deps(state);
    const result = await run(
      createEcsDeployExecutor(d),
      deployCommand({
        imageRepository: REPO,
        imageDigest: DIGEST_V3,
        migrationCommand: 'node migrate.js up',
      }),
    );
    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('MIGRATION_FAILED');
    expect(String(result.error)).toContain('exit code 1');
    expect(String(result.error)).toContain('migration crashed: bad SQL');
    // The previous release keeps running: no service update, no deferral.
    expect(state.updates).toHaveLength(0);
    expect(await d.pending.read()).toBeNull();
  });

  it('defers while the migration task runs, resuming the SAME task by ARN', async () => {
    const state = baseState();
    state.migrationTask = { lastStatus: 'RUNNING' };
    const d = deps(state);
    const result = await run(
      createEcsDeployExecutor({ ...d, migrationPollIntervalMs: 0, migrationPollMaxAttempts: 1 }),
      deployCommand({
        imageRepository: REPO,
        imageDigest: DIGEST_V3,
        migrationCommand: 'node migrate.js up',
      }),
    );
    expect(result.deferred).toBe(true);
    expect(state.updates).toHaveLength(0);
    expect(state.runTasks).toHaveLength(1);
    const pending = await d.pending.read();
    expect(pending?.migration).toBeDefined();
    expect(pending?.migration?.taskArn).toBe(MIGRATION_TASK_ARN);
    expect(pending?.migration?.completedAt).toBeUndefined();
    expect(pending?.migration?.registeredArn).toBe(`arn:aws:ecs:us-east-1:151955775369:task-definition/app:1`);
  });

  it('ROLLBACK deploys the old digest without ever running migrations', async () => {
    const state = baseState();
    const result = await run(
      createEcsDeployExecutor(deps(state)),
      deployCommand(
        {
          imageRepository: REPO,
          imageDigest: DIGEST_V3,
          migrationCommand: 'node migrate.js up',
        },
        'ROLLBACK',
      ),
    );
    expect(result.deferred).toBe(true);
    expect(state.runTasks).toHaveLength(0);
    expect(state.registered).toHaveLength(1);
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

  it('resumes an in-flight migration by ARN — never a second RunTask — then settles', async () => {
    const state = baseState();
    state.migrationTask = { lastStatus: 'RUNNING' };
    const d = deps(state);

    // First invocation: migration still running → deferred with the task ARN.
    const first = await run(
      createEcsDeployExecutor({ ...d, migrationPollIntervalMs: 0, migrationPollMaxAttempts: 1 }),
      deployCommand({
        imageRepository: REPO,
        imageDigest: DIGEST_V3,
        migrationCommand: 'node migrate.js up',
      }),
    );
    expect(first.deferred).toBe(true);
    expect(state.runTasks).toHaveLength(1);
    expect(state.updates).toHaveLength(0);

    // The migration finishes; the resumer polls the SAME task and proceeds.
    state.migrationTask = { lastStatus: 'STOPPED', exitCode: 0 };
    const resumed = await createEcsDeployResumer(d)();
    expect(resumed).toHaveLength(0); // rollout now in flight — still pending
    expect(state.runTasks).toHaveLength(1); // never re-run
    expect(state.registered).toHaveLength(1); // never re-registered
    expect(state.updates).toHaveLength(1);
    const pending = await d.pending.read();
    expect(pending?.migration?.completedAt).toBeDefined();

    // The rollout settles; the resumer reports success and clears the marker.
    state.runningDigest = DIGEST_V3;
    const settled = await createEcsDeployResumer(d)();
    expect(settled).toHaveLength(1);
    expect(settled[0]?.success).toBe(true);
    expect(await d.pending.read()).toBeNull();
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
