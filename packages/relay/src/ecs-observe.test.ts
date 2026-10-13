import { describe, expect, it } from 'vitest';

import { observeRunningImageDigest, observeServiceDigests, type EcsTaskReader } from './ecs-observe.js';
import type { CloudFormationReader, StackResource } from './verify.js';

const DIGEST = 'sha256:' + 'a'.repeat(64);

function cfnWith(resources: StackResource[]): CloudFormationReader {
  return {
    async describeStack() {
      return { found: true, stack: { stackName: 'deployz-app', status: 'CREATE_COMPLETE', tags: {}, stackId: 'stack-id-deployz-app' } };
    },
    async describeStackResources() {
      return resources;
    },
    async listStackResources() {
      return { resources };
    },
  };
}

function ecsWith(options: {
  taskArns?: string[];
  /** Per-service answers, keyed by the service name in the ARN. */
  byService?: Record<string, { taskArns: string[]; digest: string }>;
  tasks?: {
    lastStatus?: string;
    taskDefinitionArn?: string;
    containers?: { name?: string; imageDigest?: string }[];
  }[];
  containerDefinitions?: { name: string; essential?: boolean }[];
  failAt?: 'list' | 'describe';
}): EcsTaskReader {
  return {
    async listTasks(input) {
      if (options.failAt === 'list') throw new Error('AccessDenied');
      const perService = options.byService?.[input.serviceName];
      return { taskArns: perService?.taskArns ?? options.taskArns ?? ['task-1'] };
    },
    async describeTasks(input) {
      if (options.failAt === 'describe') throw new Error('AccessDenied');
      const perService = Object.values(options.byService ?? {}).find((entry) => entry.taskArns[0] === input.tasks[0]);
      if (perService) return { tasks: [{ lastStatus: 'RUNNING', containers: [{ imageDigest: perService.digest }] }] };
      return { tasks: options.tasks ?? [{ lastStatus: 'RUNNING', containers: [{ imageDigest: DIGEST }] }] };
    },
    async describeTaskDefinition() {
      return { taskDefinition: { containerDefinitions: options.containerDefinitions ?? [] } };
    },
  };
}

const SERVICE_ARN = 'arn:aws:ecs:us-east-1:151955775369:service/deployz-cluster/deployz-app-service';

function serviceStack(): StackResource[] {
  return [
    { logicalId: 'Service', type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE', physicalId: SERVICE_ARN },
  ];
}

const WORKER_ARN = 'arn:aws:ecs:us-east-1:151955775369:service/deployz-cluster/deployz-worker-service';
const OLD_DIGEST = 'sha256:' + 'c'.repeat(64);

function twoServiceStack(): StackResource[] {
  return [
    ...serviceStack(),
    { logicalId: 'WorkerService', type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE', physicalId: WORKER_ARN },
  ];
}

describe('observeRunningImageDigest', () => {
  it('reads the digest from the running task', async () => {
    const digest = await observeRunningImageDigest(
      { cfn: cfnWith(serviceStack()), ecs: ecsWith({}), installationId: 'inst-1' },
      'deployz-app',
    );
    expect(digest).toBe(DIGEST);
  });

  it('reads the digest from the essential container when an init container ran first (DEPLOY-014)', async () => {
    const initDigest = 'sha256:' + 'b'.repeat(64);
    const digest = await observeRunningImageDigest(
      {
        cfn: cfnWith(serviceStack()),
        ecs: ecsWith({
          tasks: [
            {
              lastStatus: 'RUNNING',
              taskDefinitionArn: 'arn:aws:ecs:us-east-1:151955775369:task-definition/app:66',
              containers: [
                { name: 'RdsCaBundle', imageDigest: initDigest },
                { name: 'App', imageDigest: DIGEST },
              ],
            },
          ],
          containerDefinitions: [
            { name: 'App' },
            { name: 'RdsCaBundle', essential: false },
          ],
        }),
        installationId: 'inst-1',
      },
      'deployz-app',
    );
    expect(digest).toBe(DIGEST);
  });

  it('returns null when the stack has no ECS service', async () => {
    const digest = await observeRunningImageDigest(
      {
        cfn: cfnWith([{ logicalId: 'Bucket', type: 'AWS::S3::Bucket', status: 'CREATE_COMPLETE' }]),
        ecs: ecsWith({}),
        installationId: 'inst-1',
      },
      'deployz-app',
    );
    expect(digest).toBeNull();
  });

  it('returns null when no tasks are running', async () => {
    const digest = await observeRunningImageDigest(
      { cfn: cfnWith(serviceStack()), ecs: ecsWith({ taskArns: [] }), installationId: 'inst-1' },
      'deployz-app',
    );
    expect(digest).toBeNull();
  });

  it('returns null when the task reports no digest', async () => {
    const digest = await observeRunningImageDigest(
      {
        cfn: cfnWith(serviceStack()),
        ecs: ecsWith({ tasks: [{ lastStatus: 'RUNNING', containers: [{ imageDigest: undefined }] }] }),
        installationId: 'inst-1',
      },
      'deployz-app',
    );
    expect(digest).toBeNull();
  });

  it('returns null, not a fake digest, when the lookup fails', async () => {
    const deps = { cfn: cfnWith(serviceStack()), ecs: ecsWith({ failAt: 'list' }), installationId: 'inst-1' };
    expect(await observeRunningImageDigest(deps, 'deployz-app')).toBeNull();
    expect(await observeServiceDigests(deps, 'deployz-app')).toEqual([
      { serviceLogicalId: 'Service', digests: null },
    ]);
  });

  it('returns the digest when every service runs it', async () => {
    const digest = await observeRunningImageDigest(
      {
        cfn: cfnWith(twoServiceStack()),
        ecs: ecsWith({
          byService: {
            'deployz-app-service': { taskArns: ['web-1'], digest: DIGEST },
            'deployz-worker-service': { taskArns: ['worker-1'], digest: DIGEST },
          },
        }),
        installationId: 'inst-1',
      },
      'deployz-app',
    );
    expect(digest).toBe(DIGEST);
  });

  it('returns null when a worker was rolled back to another digest', async () => {
    const digest = await observeRunningImageDigest(
      {
        cfn: cfnWith(twoServiceStack()),
        ecs: ecsWith({
          byService: {
            'deployz-app-service': { taskArns: ['web-1'], digest: DIGEST },
            'deployz-worker-service': { taskArns: ['worker-1'], digest: OLD_DIGEST },
          },
        }),
        installationId: 'inst-1',
      },
      'deployz-app',
    );
    expect(digest).toBeNull();
  });

  it('returns null when one service has no running task, and reports it as an empty digest list', async () => {
    const deps = {
      cfn: cfnWith(twoServiceStack()),
      ecs: ecsWith({
        byService: {
          'deployz-app-service': { taskArns: ['web-1'], digest: DIGEST },
          'deployz-worker-service': { taskArns: [], digest: OLD_DIGEST },
        },
      }),
      installationId: 'inst-1',
    };
    expect(await observeRunningImageDigest(deps, 'deployz-app')).toBeNull();
    expect(await observeServiceDigests(deps, 'deployz-app')).toEqual([
      { serviceLogicalId: 'Service', digests: [DIGEST] },
      { serviceLogicalId: 'WorkerService', digests: [] },
    ]);
  });

  it('returns null when the tasks of one service run different digests', async () => {
    const deps = {
      cfn: cfnWith(serviceStack()),
      ecs: ecsWith({
        taskArns: ['t1', 't2'],
        tasks: [
          { lastStatus: 'RUNNING', containers: [{ imageDigest: DIGEST }] },
          { lastStatus: 'RUNNING', containers: [{ imageDigest: OLD_DIGEST }] },
        ],
      }),
      installationId: 'inst-1',
    };
    expect(await observeRunningImageDigest(deps, 'deployz-app')).toBeNull();
    expect(await observeServiceDigests(deps, 'deployz-app')).toEqual([
      { serviceLogicalId: 'Service', digests: [DIGEST, OLD_DIGEST] },
    ]);
  });

  it('ignores tasks that are not RUNNING', async () => {
    const deps = {
      cfn: cfnWith(serviceStack()),
      ecs: ecsWith({
        taskArns: ['t1', 't2'],
        tasks: [
          { lastStatus: 'RUNNING', containers: [{ imageDigest: DIGEST }] },
          { lastStatus: 'PENDING', containers: [{ imageDigest: OLD_DIGEST }] },
        ],
      }),
      installationId: 'inst-1',
    };
    expect(await observeRunningImageDigest(deps, 'deployz-app')).toBe(DIGEST);
  });

  it('returns null when a RUNNING task has no application digest', async () => {
    const deps = {
      cfn: cfnWith(serviceStack()),
      ecs: ecsWith({
        taskArns: ['t1', 't2'],
        tasks: [
          { lastStatus: 'RUNNING', containers: [{ imageDigest: DIGEST }] },
          { lastStatus: 'RUNNING', containers: [{}] },
        ],
      }),
      installationId: 'inst-1',
    };
    expect(await observeRunningImageDigest(deps, 'deployz-app')).toBeNull();
  });

  it('reads every page of ListTasks and every batch of DescribeTasks', async () => {
    const taskArns = Array.from({ length: 150 }, (_, i) => `task-${i}`);
    const described: number[] = [];
    const ecs: EcsTaskReader = {
      async listTasks(input) {
        return input.nextToken === undefined
          ? { taskArns: taskArns.slice(0, 100), nextToken: 'page-2' }
          : { taskArns: taskArns.slice(100) };
      },
      async describeTasks(input) {
        described.push(input.tasks.length);
        return {
          tasks: input.tasks.map((arn) => ({
            lastStatus: 'RUNNING',
            containers: [{ imageDigest: arn === 'task-149' ? OLD_DIGEST : DIGEST }],
          })),
        };
      },
      async describeTaskDefinition() {
        return { taskDefinition: { containerDefinitions: [] } };
      },
    };
    const digests = await observeServiceDigests({ cfn: cfnWith(serviceStack()), ecs, installationId: 'inst-1' }, 'deployz-app');
    expect(described).toEqual([100, 50]);
    expect(digests).toEqual([{ serviceLogicalId: 'Service', digests: [DIGEST, OLD_DIGEST] }]);
  });

  it('returns null when the stack resources cannot be read', async () => {
    const digest = await observeRunningImageDigest(
      {
        cfn: { ...cfnWith(serviceStack()), listStackResources: async () => null },
        ecs: ecsWith({}),
        installationId: 'inst-1',
      },
      'deployz-app',
    );
    expect(digest).toBeNull();
  });
});
