import { describe, expect, it } from 'vitest';

import type { EcsDeployClient } from './deploy.js';
import { pruneSupersededRevisions } from './task-revisions.js';
import type { CloudFormationReader, StackResource } from './verify.js';

const PREFIX = 'arn:aws:ecs:us-east-1:151955775369:task-definition';
const FAMILY = 'DeployzAppWebinsttest';
const SERVICE_ARN = 'arn:aws:ecs:us-east-1:151955775369:service/app-cluster/web';
const rev = (n: number, family = FAMILY) => `${PREFIX}/${family}:${n}`;

function setup(
  options: {
    tags?: Record<string, string>;
    family?: string;
    active?: number[];
    servicePrimary?: number;
    serviceDrain?: number;
    failDeregister?: boolean;
  } = {},
) {
  const family = options.family ?? FAMILY;
  const resources: StackResource[] = [
    { logicalId: 'Svc', type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE', physicalId: SERVICE_ARN },
    { logicalId: 'Td', type: 'AWS::ECS::TaskDefinition', status: 'CREATE_COMPLETE', physicalId: rev(1, family) },
  ];
  const cfn: CloudFormationReader = {
    async describeStack() {
      return {
        found: true,
        stack: {
          stackName: 's',
          status: 'UPDATE_COMPLETE',
          stackId: 'id',
          tags: options.tags ?? { 'deployz:installation': 'inst-test' },
        },
      };
    },
    async describeStackResources() {
      return resources;
    },
    async listStackResources() {
      return { resources };
    },
  };
  const deregistered: string[] = [];
  const ecs = {
    async describeServices() {
      return {
        services: [
          {
            taskDefinition: rev(options.servicePrimary ?? 20, family),
            deployments: [
              { status: 'PRIMARY', taskDefinition: rev(options.servicePrimary ?? 20, family) },
              ...(options.serviceDrain !== undefined
                ? [{ status: 'ACTIVE', taskDefinition: rev(options.serviceDrain, family) }]
                : []),
            ],
          },
        ],
      };
    },
    async listTaskDefinitions() {
      return { taskDefinitionArns: (options.active ?? []).map((n) => rev(n, family)) };
    },
    async deregisterTaskDefinition(input: { taskDefinition: string }) {
      if (options.failDeregister) throw new Error('AccessDenied');
      deregistered.push(input.taskDefinition);
    },
  } as unknown as EcsDeployClient;
  return { deps: { cfn, ecs, stackName: 's' }, deregistered };
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('pruneSupersededRevisions', () => {
  it('deregisters only old inactive relay revisions, keeping the newest 3, the in-use, the stack-created and the protected', async () => {
    const { deps, deregistered } = setup({ active: range(1, 20), servicePrimary: 20, serviceDrain: 6 });

    await pruneSupersededRevisions(deps, [rev(4)]);

    // Newest 3 (18-20), stack-created (1), draining (6) and protected (4) stay.
    expect([...deregistered].sort()).toEqual([2, 3, 5, 7, 8, 9, 10, 11, 12, 13].map((n) => rev(n)).sort());
  });

  it('does nothing when a family has no more than the headroom', async () => {
    const { deps, deregistered } = setup({ active: [1, 2, 3], servicePrimary: 3 });
    await pruneSupersededRevisions(deps);
    expect(deregistered).toEqual([]);
  });

  it('is bounded to 10 deregistrations per invocation', async () => {
    const { deps, deregistered } = setup({ active: range(1, 60), servicePrimary: 60 });
    await pruneSupersededRevisions(deps);
    expect(deregistered).toHaveLength(10);
  });

  it('skips a shared family (no installation suffix)', async () => {
    const { deps, deregistered } = setup({ family: 'DeployzAppWeb', active: range(1, 20) });
    await pruneSupersededRevisions(deps);
    expect(deregistered).toEqual([]);
  });

  it('skips a stack with no installation tag', async () => {
    const { deps, deregistered } = setup({ tags: {}, active: range(1, 20) });
    await pruneSupersededRevisions(deps);
    expect(deregistered).toEqual([]);
  });

  it('never throws when a deregistration fails', async () => {
    const { deps } = setup({ active: range(1, 20), failDeregister: true });
    await expect(pruneSupersededRevisions(deps)).resolves.toBeUndefined();
  });

  it('does nothing when the ECS client cannot list or deregister', async () => {
    const { deps } = setup({ active: range(1, 20) });
    const { listTaskDefinitions: _list, deregisterTaskDefinition: _dereg, ...rest } = deps.ecs;
    await expect(pruneSupersededRevisions({ ...deps, ecs: rest })).resolves.toBeUndefined();
  });
});
