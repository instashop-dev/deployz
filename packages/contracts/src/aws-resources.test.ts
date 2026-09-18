import { describe, expect, it } from 'vitest';

import { AWS_RESOURCES, AWS_RESOURCE_GROUP_ORDER, requiredAwsResources, toPlanAwsResource } from './aws-resources.js';
import { buildDestroyPlan, buildInstallPlan, deploymentPlanSchema } from './plan.js';
import type { InfrastructureProfile } from './index.js';
import type { DeploymentManifest } from './manifest.js';

function manifestWith(postgres: boolean, redisRequired: boolean): DeploymentManifest {
  return {
    schemaVersion: 1,
    application: { root: '.', runtime: 'node', framework: null, dockerfilePath: 'Dockerfile' },
    build: { command: 'npm run build', context: '.' },
    web: { command: 'npm start', port: 3000 },
    health: { path: '/health' },
    database: { postgres },
    redis: { required: redisRequired, envBindings: [] },
    storage: { required: false, envBindings: [] },
    migration: { command: null },
    worker: { command: null },
    environment: { variables: [] },
    externalServices: [],
    unsupported: [],
  };
}

const POSTGRES_ONLY: InfrastructureProfile = { postgres: true, redis: false };
const POSTGRES_REDIS: InfrastructureProfile = { postgres: true, redis: true };
const STATELESS: InfrastructureProfile = { postgres: false, redis: false };
const STATELESS_REDIS: InfrastructureProfile = { postgres: false, redis: true };

describe('requiredAwsResources', () => {
  it('postgres, no redis: every row except cache, in catalog order', () => {
    expect(requiredAwsResources(POSTGRES_ONLY).map((resource) => resource.id)).toEqual([
      'vpc',
      'nat_gateway',
      'ecs_cluster',
      'ecs_service',
      'load_balancer',
      'database',
      'storage_bucket',
      'app_config_secret',
      'database_secrets',
      'iam_roles',
      'security_groups',
      'log_group',
      'health_alarm',
    ]);
  });

  it('postgres + redis: every catalog row, in catalog order', () => {
    expect(requiredAwsResources(POSTGRES_REDIS).map((resource) => resource.id)).toEqual(
      AWS_RESOURCES.map((resource) => resource.id),
    );
  });

  it('stateless: no database, cache, or database_secrets', () => {
    expect(requiredAwsResources(STATELESS).map((resource) => resource.id)).toEqual([
      'vpc',
      'nat_gateway',
      'ecs_cluster',
      'ecs_service',
      'load_balancer',
      'storage_bucket',
      'app_config_secret',
      'iam_roles',
      'security_groups',
      'log_group',
      'health_alarm',
    ]);
  });

  it('stateless + redis: adds cache but still no database or database_secrets', () => {
    expect(requiredAwsResources(STATELESS_REDIS).map((resource) => resource.id)).toEqual([
      'vpc',
      'nat_gateway',
      'ecs_cluster',
      'ecs_service',
      'load_balancer',
      'cache',
      'storage_bucket',
      'app_config_secret',
      'iam_roles',
      'security_groups',
      'log_group',
      'health_alarm',
    ]);
  });
});

describe('AWS_RESOURCES catalog', () => {
  it('every row is grouped in AWS_RESOURCE_GROUP_ORDER order', () => {
    const orderIndex = new Map(AWS_RESOURCE_GROUP_ORDER.map((group, index) => [group, index]));
    let lastIndex = -1;
    for (const resource of AWS_RESOURCES) {
      const index = orderIndex.get(resource.group);
      expect(index, `${resource.id} has an unknown group ${resource.group}`).toBeDefined();
      expect(index!, `${resource.id} is out of group order`).toBeGreaterThanOrEqual(lastIndex);
      lastIndex = index!;
    }
  });
});

describe('plan awsResources', () => {
  it.each([
    ['postgres, no redis', POSTGRES_ONLY],
    ['postgres + redis', POSTGRES_REDIS],
    ['stateless', STATELESS],
    ['stateless + redis', STATELESS_REDIS],
  ] as const)('buildInstallPlan(%s).awsResources matches requiredAwsResources', (_label, profile) => {
    const plan = buildInstallPlan({ manifest: manifestWith(profile.postgres, profile.redis), region: 'us-east-1' });
    expect(plan.awsResources).toEqual(requiredAwsResources(profile).map(toPlanAwsResource));
  });

  it('buildDestroyPlan carries the same rows with lifecycle preserved', () => {
    const plan = buildDestroyPlan({ manifest: manifestWith(true, true), region: 'us-east-1' });
    const expected = requiredAwsResources(POSTGRES_REDIS).map(toPlanAwsResource);
    expect(plan.awsResources).toEqual(expected);
    for (const resource of plan.awsResources) {
      const catalogRow = AWS_RESOURCES.find((row) => row.id === resource.id)!;
      expect(resource.lifecycle).toBe(catalogRow.lifecycle);
    }
  });

  it('deploymentPlanSchema accepts a built plan', () => {
    const plan = buildInstallPlan({ manifest: manifestWith(true, true), region: 'us-east-1' });
    expect(deploymentPlanSchema.parse(plan)).toEqual(plan);
  });
});
