import { describe, expect, it } from 'vitest';

import {
  computeEnvChanges,
  createConfigUpdateExecutor,
  type EffectiveConfigEntry,
} from './config-update.js';
import type { EcsDeployClient, EcsTaskDefinition } from './deploy.js';
import type { CloudFormationReader } from './verify.js';

const SERVICE_ARN = 'arn:aws:ecs:us-east-1:151955775369:service/app-cluster/app-service';

function cfnWithService(): CloudFormationReader {
  return {
    async describeStack() {
      return { found: true, stack: { stackName: 'deployz-app', status: 'CREATE_COMPLETE', tags: {} } };
    },
    async describeStackResources() {
      return [
        {
          logicalId: 'Service',
          type: 'AWS::ECS::Service',
          status: 'CREATE_COMPLETE',
          physicalId: SERVICE_ARN,
        },
      ];
    },
  };
}

function ecsWith(options: {
  taskDefinition?: EcsTaskDefinition;
  registered?: unknown[];
  updates?: unknown[];
}): EcsDeployClient {
  return {
    async describeServices() {
      return {
        services: [
          {
            desiredCount: 1,
            runningCount: 1,
            taskDefinition: 'arn:aws:ecs:us-east-1:151955775369:task-definition/app:7',
            deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED' }],
          },
        ],
      };
    },
    async describeTaskDefinition() {
      return {
        taskDefinition:
          options.taskDefinition ?? {
            family: 'app',
            cpu: '256',
            memory: '512',
            networkMode: 'awsvpc',
            requiresCompatibilities: ['FARGATE'],
            containerDefinitions: [
              {
                name: 'app',
                image: 'repo@sha256:aaa',
                environment: [{ name: 'LOG_LEVEL', value: 'info' }],
              },
            ],
          },
      };
    },
    async registerTaskDefinition(input) {
      options.registered?.push(input);
      return { taskDefinitionArn: 'arn:aws:ecs:us-east-1:151955775369:task-definition/app:8' };
    },
    async updateService(input) {
      options.updates?.push(input);
    },
    async listTasks() {
      return { taskArns: [] };
    },
    async describeTasks() {
      return { tasks: [] };
    },
  };
}

describe('computeEnvChanges', () => {
  const desired: EffectiveConfigEntry[] = [
    { key: 'LOG_LEVEL', isSecret: false, value: 'debug', source: 'vendor' },
    { key: 'FEATURE_FLAG', isSecret: false, value: 'on', source: 'vendor' },
    { key: 'API_KEY', isSecret: true, source: 'customer' },
  ];

  it('returns null when every plain value already matches', () => {
    const current = [
      { name: 'LOG_LEVEL', value: 'debug' },
      { name: 'FEATURE_FLAG', value: 'on' },
    ];
    expect(computeEnvChanges(desired, current)).toBeNull();
  });

  it('returns only changed entries, ignoring secrets', () => {
    const current = [
      { name: 'LOG_LEVEL', value: 'info' },
      { name: 'FEATURE_FLAG', value: 'on' },
    ];
    const changes = computeEnvChanges(desired, current);
    expect(changes).toEqual([{ name: 'LOG_LEVEL', value: 'debug' }]);
  });

  it('returns new entries the task definition does not have yet', () => {
    const current = [{ name: 'LOG_LEVEL', value: 'info' }];
    const changes = computeEnvChanges(desired, current);
    expect(changes).toEqual([
      { name: 'LOG_LEVEL', value: 'debug' },
      { name: 'FEATURE_FLAG', value: 'on' },
    ]);
  });

  it('ignores secret entries entirely — they are not environment variables', () => {
    const secretsOnly: EffectiveConfigEntry[] = [
      { key: 'DB_PASSWORD', isSecret: true, source: 'vendor' },
    ];
    expect(computeEnvChanges(secretsOnly, [])).toBeNull();
  });
});

describe('createConfigUpdateExecutor', () => {
  function configCommand() {
    return {
      id: 'job-config',
      deploymentId: 'dep-1',
      type: 'CONFIG_UPDATE' as const,
      idempotencyKey: 'dep-1:CONFIG_UPDATE:msg-1',
      payload: { changedKeys: ['LOG_LEVEL'] },
    };
  }

  function deps(
    entries: EffectiveConfigEntry[],
    ecsOptions: Parameters<typeof ecsWith>[0] = {},
  ) {
    return {
      cfn: cfnWithService(),
      ecs: ecsWith(ecsOptions),
      fetchEffectiveConfig: async () => entries,
      stackName: 'deployz-app',
      installationId: 'inst-test',
    };
  }

  it('reports success without registering when the config already matches', async () => {
    const registered: unknown[] = [];
    const entries: EffectiveConfigEntry[] = [
      { key: 'LOG_LEVEL', isSecret: false, value: 'info', source: 'vendor' },
    ];
    const result = await createConfigUpdateExecutor(deps(entries, { registered }))(configCommand());
    expect(result.success).toBe(true);
    expect((result.output as { alreadyApplied: boolean }).alreadyApplied).toBe(true);
    expect(registered).toHaveLength(0);
  });

  it('registers a new task definition with the changed environment', async () => {
    const registered: unknown[] = [];
    const updates: unknown[] = [];
    const entries: EffectiveConfigEntry[] = [
      { key: 'LOG_LEVEL', isSecret: false, value: 'debug', source: 'vendor' },
    ];
    const result = await createConfigUpdateExecutor(
      deps(entries, { registered, updates }),
    )(configCommand());
    expect(result.success).toBe(true);
    expect(registered).toHaveLength(1);
    expect(updates).toHaveLength(1);
    const input = registered[0] as {
      containerDefinitions: { environment: { name: string; value: string }[] }[];
    };
    expect(input.containerDefinitions[0]!.environment).toContainEqual({
      name: 'LOG_LEVEL',
      value: 'debug',
    });
  });

  it('fails when the fetch itself errors', async () => {
    const d = {
      cfn: cfnWithService(),
      ecs: ecsWith({}),
      fetchEffectiveConfig: async () => {
        throw new Error('HTTP 502');
      },
      stackName: 'deployz-app',
      installationId: 'inst-test',
    };
    const result = await createConfigUpdateExecutor(d)(configCommand());
    expect(result.success).toBe(false);
    expect(result.error).toContain('HTTP 502');
  });
});
