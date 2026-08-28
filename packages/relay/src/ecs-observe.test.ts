import { describe, expect, it } from 'vitest';

import { observeRunningImageDigest, type EcsTaskReader } from './ecs-observe.js';
import type { CloudFormationReader, StackResource } from './verify.js';

const DIGEST = 'sha256:' + 'a'.repeat(64);

function cfnWith(resources: StackResource[]): CloudFormationReader {
  return {
    async describeStack() {
      return { found: true, stack: { stackName: 'deployz-app', status: 'CREATE_COMPLETE', tags: {} } };
    },
    async describeStackResources() {
      return resources;
    },
  };
}

function ecsWith(options: {
  taskArns?: string[];
  tasks?: { lastStatus?: string; containers?: { imageDigest?: string }[] }[];
  failAt?: 'list' | 'describe';
}): EcsTaskReader {
  return {
    async listTasks() {
      if (options.failAt === 'list') throw new Error('AccessDenied');
      return { taskArns: options.taskArns ?? ['task-1'] };
    },
    async describeTasks() {
      if (options.failAt === 'describe') throw new Error('AccessDenied');
      return { tasks: options.tasks ?? [{ containers: [{ imageDigest: DIGEST }] }] };
    },
  };
}

const SERVICE_ARN = 'arn:aws:ecs:us-east-1:151955775369:service/deployz-cluster/deployz-app-service';

function serviceStack(): StackResource[] {
  return [
    { logicalId: 'Service', type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE', physicalId: SERVICE_ARN },
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
        ecs: ecsWith({ tasks: [{ containers: [{ imageDigest: undefined }] }] }),
        installationId: 'inst-1',
      },
      'deployz-app',
    );
    expect(digest).toBeNull();
  });

  it('propagates lookup failures as errors, not fake digests', async () => {
    await expect(
      observeRunningImageDigest(
        { cfn: cfnWith(serviceStack()), ecs: ecsWith({ failAt: 'list' }), installationId: 'inst-1' },
        'deployz-app',
      ),
    ).rejects.toThrow('AccessDenied');
  });
});
