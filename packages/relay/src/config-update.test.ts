import { describe, expect, it } from 'vitest';

import {
  computeEnvChanges,
  computeSecretChanges,
  createConfigUpdateExecutor,
  type ConfigSecretsWriter,
  type EffectiveConfigEntry,
} from './config-update.js';
import type { EcsDeployClient, EcsTaskDefinition } from './deploy.js';
import type { CloudFormationReader } from './verify.js';

const SERVICE_ARN = 'arn:aws:ecs:us-east-1:151955775369:service/app-cluster/app-service';
const CONFIG_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:151955775369:secret:AppConfigSecret-abc123';

function cfnWithService(options: { withConfigSecret?: boolean } = {}): CloudFormationReader {
  const resources = [
    {
      logicalId: 'Service',
      type: 'AWS::ECS::Service',
      status: 'CREATE_COMPLETE',
      physicalId: SERVICE_ARN,
    },
  ];
  if (options.withConfigSecret) {
    resources.push({
      logicalId: 'AppConfigSecret',
      type: 'AWS::SecretsManager::Secret',
      status: 'CREATE_COMPLETE',
      physicalId: CONFIG_SECRET_ARN,
    });
  }
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

/** In-memory Secrets Manager fake over a single JSON secret. */
function fakeSecretsWriter(initial: Record<string, unknown> = {}): ConfigSecretsWriter & {
  current(): Record<string, unknown>;
  puts(): number;
} {
  let json: Record<string, unknown> = { ...initial };
  let puts = 0;
  return {
    current: () => json,
    puts: () => puts,
    async getSecretValue({ SecretId }) {
      if (SecretId !== CONFIG_SECRET_ARN) {
        throw new Error(`Unexpected secret id ${SecretId}`);
      }
      return { arn: CONFIG_SECRET_ARN, secretString: JSON.stringify(json) };
    },
    async putSecretValue({ secretString }) {
      puts += 1;
      json = JSON.parse(secretString) as Record<string, unknown>;
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
    const delta = computeEnvChanges(desired, current);
    expect(delta).toEqual({ changes: [{ name: 'LOG_LEVEL', value: 'debug' }], removals: [] });
  });

  it('returns new entries the task definition does not have yet', () => {
    const current = [{ name: 'LOG_LEVEL', value: 'info' }];
    const delta = computeEnvChanges(desired, current);
    expect(delta).toEqual({
      changes: [
        { name: 'LOG_LEVEL', value: 'debug' },
        { name: 'FEATURE_FLAG', value: 'on' },
      ],
      removals: [],
    });
  });

  it('ignores secret entries entirely — they are not environment variables', () => {
    const secretsOnly: EffectiveConfigEntry[] = [
      { key: 'DB_PASSWORD', isSecret: true, source: 'vendor' },
    ];
    expect(computeEnvChanges(secretsOnly, [])).toBeNull();
  });

  it('strips only the explicitly removed keys, never install-time values', () => {
    const current = [
      { name: 'LOG_LEVEL', value: 'debug' },
      { name: 'FEATURE_FLAG', value: 'on' },
      { name: 'NODE_ENV', value: 'production' },
    ];
    const delta = computeEnvChanges(desired, current, ['FEATURE_FLAG', 'NEVER_EXISTED']);
    expect(delta).toEqual({ changes: [], removals: ['FEATURE_FLAG'] });
  });
});

describe('computeSecretChanges', () => {
  const desired: EffectiveConfigEntry[] = [
    { key: 'API_KEY', isSecret: true, source: 'customer' },
    { key: 'DATABASE_URL', isSecret: true, source: 'vendor' },
    { key: 'LOG_LEVEL', isSecret: false, value: 'info', source: 'vendor' },
  ];

  it('returns null when every secret is already bound to the config secret', () => {
    const current = [
      { name: 'API_KEY', valueFrom: `${CONFIG_SECRET_ARN}:API_KEY::` },
      { name: 'DATABASE_URL', valueFrom: `${CONFIG_SECRET_ARN}:DATABASE_URL::` },
    ];
    expect(computeSecretChanges(desired, current, CONFIG_SECRET_ARN)).toBeNull();
  });

  it('returns bindings for secrets missing from the task definition, ignoring plain entries', () => {
    const current = [{ name: 'API_KEY', valueFrom: `${CONFIG_SECRET_ARN}:API_KEY::` }];
    const delta = computeSecretChanges(desired, current, CONFIG_SECRET_ARN);
    expect(delta).toEqual({
      bindings: [{ name: 'DATABASE_URL', valueFrom: `${CONFIG_SECRET_ARN}:DATABASE_URL::` }],
      removals: [],
    });
  });

  it('re-binds when the secret ARN changed (secret re-created)', () => {
    const current = [{ name: 'API_KEY', valueFrom: `${CONFIG_SECRET_ARN}OLD:API_KEY::` }];
    const delta = computeSecretChanges(desired, current, CONFIG_SECRET_ARN);
    expect(delta).toEqual({
      bindings: [
        { name: 'API_KEY', valueFrom: `${CONFIG_SECRET_ARN}:API_KEY::` },
        { name: 'DATABASE_URL', valueFrom: `${CONFIG_SECRET_ARN}:DATABASE_URL::` },
      ],
      removals: [],
    });
  });

  it('strips only the explicitly removed keys that are actually bound', () => {
    const current = [
      { name: 'API_KEY', valueFrom: `${CONFIG_SECRET_ARN}:API_KEY::` },
      { name: 'NODE_ENV', valueFrom: 'arn:aws:secretsmanager:other' },
    ];
    const delta = computeSecretChanges(desired, current, CONFIG_SECRET_ARN, ['API_KEY', 'NEVER_EXISTED']);
    expect(delta).toEqual({
      bindings: [{ name: 'DATABASE_URL', valueFrom: `${CONFIG_SECRET_ARN}:DATABASE_URL::` }],
      removals: ['API_KEY'],
    });
  });
});

describe('createConfigUpdateExecutor', () => {
  function configCommand(payload: Record<string, unknown> = { changedKeys: ['LOG_LEVEL'] }) {
    return {
      id: 'job-config',
      deploymentId: 'dep-1',
      type: 'CONFIG_UPDATE' as const,
      idempotencyKey: 'dep-1:CONFIG_UPDATE:msg-1',
      payload,
    };
  }

  function deps(
    entries: EffectiveConfigEntry[],
    ecsOptions: Parameters<typeof ecsWith>[0] = {},
    secrets: ConfigSecretsWriter = fakeSecretsWriter(),
  ) {
    return {
      cfn: cfnWithService({ withConfigSecret: true }),
      ecs: ecsWith(ecsOptions),
      secrets,
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
    // The relay's register grant is request-tag scoped — an untagged
    // register is AccessDenied (verified live).
    expect((registered[0] as { tags?: unknown }).tags).toEqual([
      { key: 'deployz:installation', value: 'inst-test' },
    ]);
  });

  it('fails when the fetch itself errors', async () => {
    const d = {
      cfn: cfnWithService(),
      ecs: ecsWith({}),
      secrets: fakeSecretsWriter(),
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

  // ── Real secret delivery (#10 phase 1.2): entry → customer Secrets
  // ── Manager → task-definition binding → running application.

  it('persists the entered secret into customer Secrets Manager and binds it in the task definition', async () => {
    const registered: unknown[] = [];
    const secrets = fakeSecretsWriter();
    const entries: EffectiveConfigEntry[] = [
      { key: 'API_KEY', isSecret: true, source: 'customer' },
      { key: 'LOG_LEVEL', isSecret: false, value: 'info', source: 'vendor' },
    ];
    const result = await createConfigUpdateExecutor(deps(entries, { registered }, secrets))(
      configCommand({ changedKeys: ['API_KEY'], secrets: [{ key: 'API_KEY', value: 'v-12345' }] }),
    );
    expect(result.success).toBe(true);
    // The value landed in the customer's secret store.
    expect(secrets.current()).toEqual({ API_KEY: 'v-12345' });
    // The task definition now carries the secret as an ECS secret reference.
    const input = registered[0] as {
      containerDefinitions: { secrets: { name: string; valueFrom: string }[] }[];
    };
    expect(input.containerDefinitions[0]!.secrets).toContainEqual({
      name: 'API_KEY',
      valueFrom: `${CONFIG_SECRET_ARN}:API_KEY::`,
    });
  });

  it('merges a new key without clobbering an earlier one, and stays idempotent on re-run', async () => {
    const registered: unknown[] = [];
    const secrets = fakeSecretsWriter({ API_KEY: 'v-12345' });
    const entries: EffectiveConfigEntry[] = [
      { key: 'API_KEY', isSecret: true, source: 'customer' },
      { key: 'DATABASE_URL', isSecret: true, source: 'vendor' },
    ];

    const first = await createConfigUpdateExecutor(deps(entries, { registered }, secrets))(
      configCommand({ changedKeys: ['DATABASE_URL'], secrets: [{ key: 'DATABASE_URL', value: 'postgres://x' }] }),
    );
    expect(first.success).toBe(true);
    expect(secrets.current()).toEqual({ API_KEY: 'v-12345', DATABASE_URL: 'postgres://x' });

    // A re-run against the definition the first run registered changes
    // nothing and registers nothing: both secrets are already bound.
    const boundDefinition: EcsTaskDefinition = {
      family: 'app',
      cpu: '256',
      memory: '512',
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      containerDefinitions: [
        {
          name: 'app',
          image: 'repo@sha256:aaa',
          environment: [],
          secrets: [
            { name: 'API_KEY', valueFrom: `${CONFIG_SECRET_ARN}:API_KEY::` },
            { name: 'DATABASE_URL', valueFrom: `${CONFIG_SECRET_ARN}:DATABASE_URL::` },
          ],
        },
      ],
    };
    const beforePuts = secrets.puts();
    const second = await createConfigUpdateExecutor(
      deps(entries, { registered, taskDefinition: boundDefinition }, secrets),
    )(configCommand({ changedKeys: [] }));
    expect(second.success).toBe(true);
    expect((second.output as { alreadyApplied: boolean }).alreadyApplied).toBe(true);
    expect(secrets.puts()).toBe(beforePuts);
    expect(registered).toHaveLength(1);
  });

  it('removes a deleted secret key from both the customer store and the task definition', async () => {
    const registered: unknown[] = [];
    const boundedTaskDefinition: EcsTaskDefinition = {
      family: 'app',
      cpu: '256',
      memory: '512',
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      containerDefinitions: [
        {
          name: 'app',
          image: 'repo@sha256:aaa',
          environment: [],
          secrets: [{ name: 'API_KEY', valueFrom: `${CONFIG_SECRET_ARN}:API_KEY::` }],
        },
      ],
    };
    const secrets = fakeSecretsWriter({ API_KEY: 'v-12345' });
    const noDesiredSecrets: EffectiveConfigEntry[] = [
      { key: 'LOG_LEVEL', isSecret: false, value: 'info', source: 'vendor' },
    ];
    const result = await createConfigUpdateExecutor(
      deps(noDesiredSecrets, { registered, taskDefinition: boundedTaskDefinition }, secrets),
    )(configCommand({ changedKeys: [], removedKeys: ['API_KEY'] }));
    expect(result.success).toBe(true);
    expect(secrets.current()).toEqual({});
    const input = registered[0] as {
      containerDefinitions: { secrets?: { name: string }[] }[];
    };
    expect(input.containerDefinitions[0]!.secrets).not.toContainEqual({ name: 'API_KEY' });
  });

  it('makes no Secrets Manager call when the config has no secrets at all', async () => {
    const secrets = fakeSecretsWriter();
    const putsBefore = secrets.puts();
    const entries: EffectiveConfigEntry[] = [
      { key: 'LOG_LEVEL', isSecret: false, value: 'info', source: 'vendor' },
    ];
    const result = await createConfigUpdateExecutor(deps(entries, {}, secrets))(
      configCommand({ changedKeys: ['LOG_LEVEL'] }),
    );
    expect(result.success).toBe(true);
    expect(secrets.puts()).toBe(putsBefore);
  });

  it('fails honestly when the stack has no AppConfigSecret resource', async () => {
    // `cfn` variant without the secret resource is built in-line: the
    // executor must not silently report a secret as persisted.
    const noSecretCfn: CloudFormationReader = {
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
    const result = await createConfigUpdateExecutor({
      cfn: noSecretCfn,
      ecs: ecsWith({}),
      secrets: fakeSecretsWriter(),
      fetchEffectiveConfig: async () =>
        [{ key: 'API_KEY', isSecret: true, source: 'customer' } satisfies EffectiveConfigEntry],
      stackName: 'deployz-app',
      installationId: 'inst-test',
    })(configCommand({ changedKeys: ['API_KEY'], secrets: [{ key: 'API_KEY', value: 'v' }] }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('AppConfigSecret');
  });

  it('keeps Stage B binding-alias entries across a later config update (stack-managed, never removed or duplicated)', async () => {
    // The running definition carries the alias entries the install registered:
    // S3_ATTACHMENTS_BUCKET as plain env, MEMOS_DSN as a DB-url secret.
    const aliasTaskDefinition: EcsTaskDefinition = {
      family: 'app',
      cpu: '256',
      memory: '512',
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      containerDefinitions: [
        {
          name: 'app',
          image: 'repo@sha256:aaa',
          environment: [
            { name: 'LOG_LEVEL', value: 'info' },
            { name: 'S3_ATTACHMENTS_BUCKET', value: 'deployz-app-storage' },
          ],
          secrets: [
            { name: 'MEMOS_DSN', valueFrom: 'arn:aws:secretsmanager:us-east-1:1:secret:DatabaseUrl-XYZ' },
          ],
        },
      ],
    };
    const registered: unknown[] = [];
    const entries: EffectiveConfigEntry[] = [
      { key: 'LOG_LEVEL', isSecret: false, value: 'debug', source: 'vendor' },
    ];

    const result = await createConfigUpdateExecutor(
      deps(entries, { taskDefinition: aliasTaskDefinition, registered }),
    )(configCommand({ changedKeys: ['LOG_LEVEL'] }));
    expect(result.success).toBe(true);

    const input = registered[0] as {
      containerDefinitions: {
        environment: { name: string; value: string }[];
        secrets: { name: string; valueFrom: string }[];
      }[];
    };
    const env = input.containerDefinitions[0]!.environment;
    const secrets = input.containerDefinitions[0]!.secrets;
    expect(env).toContainEqual({ name: 'S3_ATTACHMENTS_BUCKET', value: 'deployz-app-storage' });
    expect(secrets).toContainEqual({
      name: 'MEMOS_DSN',
      valueFrom: 'arn:aws:secretsmanager:us-east-1:1:secret:DatabaseUrl-XYZ',
    });
    // Exactly one of each — the config delta never duplicates stack-managed entries.
    expect(env.filter((entry) => entry.name === 'S3_ATTACHMENTS_BUCKET')).toHaveLength(1);
    expect(secrets.filter((entry) => entry.name === 'MEMOS_DSN')).toHaveLength(1);
  });
});