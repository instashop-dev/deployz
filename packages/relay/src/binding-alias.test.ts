import { describe, expect, it, vi } from 'vitest';

import type { DeploymentManifest } from '@deployz/contracts';

import {
  bindingAliasesFromPayload,
  computeAliasAdditions,
  createBindingAliasApplier,
  manifestBindingAliases,
  type BindingAlias,
} from '../src/binding-alias.js';
import type { CloudFormationReader } from '../src/verify.js';
import type { EcsDeployClient, EcsTaskDefinition } from '../src/deploy.js';

// ==========================================================================
// Fixtures
// ==========================================================================

/** A Stage B phase 2 manifest: standard + alias DB bindings, redis, S3. */
const ALIAS_MANIFEST: DeploymentManifest = {
  application: { root: '.', runtime: 'node', framework: 'express', dockerfilePath: 'Dockerfile' },
  build: { command: 'npm run build', context: '.' },
  web: { command: 'npm start', port: 3000 },
  health: { path: '/health' },
  database: {
    postgres: true,
    envBindings: [
      { name: 'DATABASE_URL', kind: 'url' },
      { name: 'MEMOS_DSN', kind: 'url' },
      { name: 'PAPERLESS_DBHOST', kind: 'host' },
      { name: 'PAPERLESS_DBPORT', kind: 'port' },
      { name: 'PAPERLESS_DBNAME', kind: 'database' },
      { name: 'PAPERLESS_DBUSER', kind: 'username' },
      { name: 'PAPERLESS_DBPASS', kind: 'password' },
    ],
  },
  redis: { required: true, envBindings: [{ name: 'CELERY_BROKER_URL', kind: 'url' }] },
  storage: {
    required: true,
    envBindings: [
      { name: 'AWS_S3_BUCKET', kind: 'bucket' },
      { name: 'S3_ATTACHMENTS_BUCKET', kind: 'bucket' },
    ],
  },
  migration: { command: null },
  worker: { command: null },
  environment: { variables: [] },
  externalServices: [],
  unsupported: [],
};

/** The standard entries the pre-published template bakes into the app container. */
const STANDARD_ENV = [
  { name: 'DATABASE_HOST', value: 'db.internal.example.com' },
  { name: 'DATABASE_PORT', value: '5432' },
  { name: 'DATABASE_NAME', value: 'deployz' },
  { name: 'DATABASE_USER', value: 'deployz_app' },
  { name: 'REDIS_URL', value: 'redis://cache.internal.example.com:6379' },
  { name: 'REDIS_HOST', value: 'cache.internal.example.com' },
  { name: 'REDIS_PORT', value: '6379' },
  { name: 'AWS_S3_BUCKET', value: 'deployz-app-storage' },
  { name: 'STORAGE_BUCKET', value: 'deployz-app-storage' },
];
const STANDARD_SECRETS = [
  { name: 'DATABASE_URL', valueFrom: 'arn:aws:secretsmanager:us-east-1:1:secret:DatabaseUrl-XYZ' },
  { name: 'DATABASE_PASSWORD', valueFrom: 'arn:aws:secretsmanager:us-east-1:1:secret:Database-Abc:password::' },
];

const EXPECTED_ALIASES: BindingAlias[] = [
  { resource: 'postgres', name: 'DATABASE_URL', kind: 'url' },
  { resource: 'postgres', name: 'MEMOS_DSN', kind: 'url' },
  { resource: 'postgres', name: 'PAPERLESS_DBHOST', kind: 'host' },
  { resource: 'postgres', name: 'PAPERLESS_DBPORT', kind: 'port' },
  { resource: 'postgres', name: 'PAPERLESS_DBNAME', kind: 'database' },
  { resource: 'postgres', name: 'PAPERLESS_DBUSER', kind: 'username' },
  { resource: 'postgres', name: 'PAPERLESS_DBPASS', kind: 'password' },
  { resource: 'redis', name: 'CELERY_BROKER_URL', kind: 'url' },
  { resource: 's3', name: 'AWS_S3_BUCKET', kind: 'bucket' },
  { resource: 's3', name: 'S3_ATTACHMENTS_BUCKET', kind: 'bucket' },
];

// ==========================================================================
// manifestBindingAliases / bindingAliasesFromPayload
// ==========================================================================

describe('manifestBindingAliases', () => {
  it('collects postgres + redis + s3 bindings into alias entries', () => {
    expect(manifestBindingAliases(ALIAS_MANIFEST)).toEqual(EXPECTED_ALIASES);
  });

  it('skips the resources the manifest does not provision', () => {
    const manifest: DeploymentManifest = {
      ...ALIAS_MANIFEST,
      database: { postgres: false, envBindings: [{ name: 'DATABASE_URL', kind: 'url' }] },
      redis: { required: false, envBindings: [] },
      storage: { required: false, envBindings: [{ name: 'S3_ATTACHMENTS_BUCKET', kind: 'bucket' }] },
    };
    expect(manifestBindingAliases(manifest)).toEqual([]);
  });

  it('round-trips through the compacted payload shape', () => {
    const compacted = { bindingAliases: manifestBindingAliases(ALIAS_MANIFEST) };
    expect(bindingAliasesFromPayload(compacted)).toEqual(EXPECTED_ALIASES);
    expect(bindingAliasesFromPayload({})).toEqual([]);
    expect(bindingAliasesFromPayload({ bindingAliases: 'nope' })).toEqual([]);
  });
});

// ==========================================================================
// computeAliasAdditions
// ==========================================================================

describe('computeAliasAdditions', () => {
  it('copies standard values/ARNs onto the alias names', () => {
    const { env, secrets } = computeAliasAdditions(EXPECTED_ALIASES, STANDARD_ENV, STANDARD_SECRETS);
    expect(secrets).toEqual(
      expect.arrayContaining([
        { name: 'MEMOS_DSN', valueFrom: STANDARD_SECRETS[0]!.valueFrom },
        { name: 'PAPERLESS_DBPASS', valueFrom: STANDARD_SECRETS[1]!.valueFrom },
      ]),
    );
    expect(env).toEqual(
      expect.arrayContaining([
        { name: 'PAPERLESS_DBHOST', value: 'db.internal.example.com' },
        { name: 'PAPERLESS_DBPORT', value: '5432' },
        { name: 'PAPERLESS_DBNAME', value: 'deployz' },
        { name: 'PAPERLESS_DBUSER', value: 'deployz_app' },
        { name: 'CELERY_BROKER_URL', value: 'redis://cache.internal.example.com:6379' },
        { name: 'S3_ATTACHMENTS_BUCKET', value: 'deployz-app-storage' },
      ]),
    );
  });

  it('never duplicates a name already carrying the same value, and is idempotent', () => {
    const first = computeAliasAdditions(EXPECTED_ALIASES, STANDARD_ENV, STANDARD_SECRETS);
    const mergedEnv = [...STANDARD_ENV, ...first.env];
    const mergedSecrets = [...STANDARD_SECRETS, ...first.secrets];
    const second = computeAliasAdditions(EXPECTED_ALIASES, mergedEnv, mergedSecrets);
    expect(second.env).toEqual([]);
    expect(second.secrets).toEqual([]);
  });

  it('skips aliases whose canonical source the template does not bake', () => {
    const additions = computeAliasAdditions(
      EXPECTED_ALIASES,
      [{ name: 'DATABASE_HOST', value: 'db.internal.example.com' }],
      [],
    );
    // Only host has a source; url/password (secret) and redis/s3 (missing
    // canonical env) are skipped rather than invented.
    expect(additions.env).toEqual([{ name: 'PAPERLESS_DBHOST', value: 'db.internal.example.com' }]);
    expect(additions.secrets).toEqual([]);
  });
});

// ==========================================================================
// createBindingAliasApplier
// ==========================================================================

function fakeApplierDeps(overrides: {
  taskDefinition?: EcsTaskDefinition;
  registerError?: Error;
} = {}) {
  const registered = vi.fn(async () => ({ taskDefinitionArn: 'arn:aws:ecs:us-east-1:1:task-definition/deployz-app:2' }));
  const updateService = vi.fn(async () => {});
  const ecs = {
    describeServices: vi.fn(async () => ({
      services: [
        {
          taskDefinition: 'arn:aws:ecs:us-east-1:1:task-definition/deployz-app:1',
          desiredCount: 1,
          runningCount: 1,
        },
      ],
    })),
    describeTaskDefinition: vi.fn(async () => ({
      taskDefinition: overrides.taskDefinition ?? taskDefinitionFixture(),
    })),
    registerTaskDefinition: overrides.registerError
      ? vi.fn(async () => {
          throw overrides.registerError;
        })
      : registered,
    updateService,
  } as unknown as EcsDeployClient;
  const cfn = {
    describeStackResources: vi.fn(async () => [
      { logicalId: 'Service', type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE', physicalId: 'arn:aws:ecs:us-east-1:1:service/cluster/deployz-app' },
    ]),
  } as unknown as CloudFormationReader;
  return { ecs, cfn, registered, updateService };
}

function taskDefinitionFixture(): EcsTaskDefinition {
  return {
    family: 'deployz-app',
    cpu: '256',
    memory: '512',
    networkMode: 'awsvpc',
    requiresCompatibilities: ['FARGATE'],
    executionRoleArn: 'exec-role',
    taskRoleArn: 'task-role',
    containerDefinitions: [
      {
        name: 'App',
        image: 'public.ecr.aws/deployz/fixture@sha256:000',
        environment: STANDARD_ENV,
        secrets: STANDARD_SECRETS,
      },
    ],
  };
}

describe('createBindingAliasApplier', () => {
  it('registers one revision carrying the alias entries and updates the service', async () => {
    const { ecs, cfn, registered, updateService } = fakeApplierDeps();
    const applier = createBindingAliasApplier({
      cfn,
      ecs,
      installationId: 'inst-1',
    });

    const outcome = await applier({
      stackName: 'deployz-app',
      aliases: manifestBindingAliases(ALIAS_MANIFEST),
    });

    expect(outcome).toEqual({ state: 'applied' });
    expect(registered).toHaveBeenCalledOnce();
    const [input] = registered.mock.calls[0]!;
    const container = input['containerDefinitions'][0] as {
      environment: { name: string; value: string }[];
      secrets: { name: string; valueFrom: string }[];
    };
    const envByName = Object.fromEntries(container.environment.map((entry) => [entry.name, entry.value]));
    const secretsByName = Object.fromEntries(
      container.secrets.map((entry) => [entry.name, entry.valueFrom]),
    );
    // URL + password aliases are secrets from the same ARNs as the standards.
    expect(secretsByName['MEMOS_DSN']).toBe('arn:aws:secretsmanager:us-east-1:1:secret:DatabaseUrl-XYZ');
    expect(secretsByName['PAPERLESS_DBPASS']).toBe(
      'arn:aws:secretsmanager:us-east-1:1:secret:Database-Abc:password::',
    );
    // Part aliases are plain env with the standard values.
    expect(envByName['PAPERLESS_DBHOST']).toBe('db.internal.example.com');
    expect(envByName['PAPERLESS_DBPORT']).toBe('5432');
    expect(envByName['PAPERLESS_DBNAME']).toBe('deployz');
    expect(envByName['PAPERLESS_DBUSER']).toBe('deployz_app');
    // Redis + bucket aliases copy their standard env values.
    expect(envByName['CELERY_BROKER_URL']).toBe('redis://cache.internal.example.com:6379');
    expect(envByName['S3_ATTACHMENTS_BUCKET']).toBe('deployz-app-storage');
    expect(input['tags']).toEqual([{ key: 'deployz:installation', value: 'inst-1' }]);

    expect(updateService).toHaveBeenCalledWith({
      cluster: 'cluster',
      service: 'arn:aws:ecs:us-east-1:1:service/cluster/deployz-app',
      taskDefinition: 'arn:aws:ecs:us-east-1:1:task-definition/deployz-app:2',
    });
  });

  it('is a no-op when the aliases already match the running definition (idempotent re-install)', async () => {
    const alreadyApplied = computeAliasAdditions(EXPECTED_ALIASES, STANDARD_ENV, STANDARD_SECRETS);
    const current: EcsTaskDefinition = {
      ...taskDefinitionFixture(),
      containerDefinitions: [
        {
          ...taskDefinitionFixture().containerDefinitions[0]!,
          environment: [...STANDARD_ENV, ...alreadyApplied.env],
          secrets: [...STANDARD_SECRETS, ...alreadyApplied.secrets],
        },
      ],
    };
    const { ecs, cfn, registered } = fakeApplierDeps({ taskDefinition: current });
    const applier = createBindingAliasApplier({ cfn, ecs, installationId: 'inst-1' });

    const outcome = await applier({ stackName: 'deployz-app', aliases: EXPECTED_ALIASES });

    expect(outcome).toEqual({ state: 'already-applied' });
    expect(registered).not.toHaveBeenCalled();
  });

  it('reports a failed registration honestly', async () => {
    const { ecs, cfn } = fakeApplierDeps({
      registerError: new Error('AccessDenied: register'),
    });
    const applier = createBindingAliasApplier({ cfn, ecs, installationId: 'inst-1' });
    const outcome = await applier({ stackName: 'deployz-app', aliases: EXPECTED_ALIASES });
    expect(outcome.state).toBe('failed');
  });

  it('returns already-applied without calling ECS when there are no aliases', async () => {
    const { ecs, cfn } = fakeApplierDeps();
    const applier = createBindingAliasApplier({ cfn, ecs, installationId: 'inst-1' });
    expect(await applier({ stackName: 'deployz-app', aliases: [] })).toEqual({
      state: 'already-applied',
    });
    expect(ecs.describeServices).not.toHaveBeenCalled();
  });
});
