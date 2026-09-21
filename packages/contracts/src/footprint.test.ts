import { describe, expect, it } from 'vitest';

import { estimateFootprintCost } from './pricing.js';
import {
  DEPLOYMENT_SIZING,
  deploymentFootprintSchema,
  resolveDeploymentFootprint,
} from './footprint.js';
import type { DeploymentFootprint, FootprintResource, FootprintWorkload } from './footprint.js';
import type { DeploymentManifest } from './manifest.js';

function manifestWith(overrides: Partial<DeploymentManifest> = {}): DeploymentManifest {
  return {
    schemaVersion: 1,
    application: { root: '.', runtime: 'node', framework: null, dockerfilePath: 'Dockerfile' },
    build: { command: 'npm run build', context: '.' },
    web: { command: 'npm start', port: 3000 },
    health: { path: '/health' },
    database: { postgres: false },
    redis: { required: false, envBindings: [] },
    storage: { required: false, envBindings: [] },
    migration: { command: null },
    worker: { command: null },
    environment: { variables: [] },
    externalServices: [],
    unsupported: [],
    ...overrides,
  };
}

const STATELESS = manifestWith();
const WITH_POSTGRES = manifestWith({ database: { postgres: true } });
const WITH_POSTGRES_REDIS = manifestWith({ database: { postgres: true }, redis: { required: true, envBindings: [] } });
const WITH_WORKER = manifestWith({ worker: { command: 'npm run worker' } });

describe('resolveDeploymentFootprint', () => {
  it('web workload only: exact resolved compute, no database/cache, always-on resources', () => {
    const footprint = resolveDeploymentFootprint({ manifest: STATELESS, region: 'us-east-1' });
    expect(footprint.version).toBe(1);
    expect(footprint.workloads).toHaveLength(1);
    const web = footprint.workloads[0]!;
    expect(web.id).toBe('web');
    expect(web.role).toBe('web');
    expect(web.quantity).toBe(DEPLOYMENT_SIZING.workload.web.quantity);
    expect(web.compute).toEqual({
      provider: 'aws',
      service: 'ecs-fargate',
      cpuUnits: 256,
      memoryMiB: 512,
      sizeLabel: 'Small',
    });
    expect(web.lifecycle).toEqual({ persistent: false });
    expect(footprint.resources.map((resource) => resource.id)).toEqual(['storage', 'endpoint', 'nat-gateway']);
    expect(footprint.region).toBe('us-east-1');
  });

  it('compute + PostgreSQL: resolved database sizing and retained lifecycle', () => {
    const footprint = resolveDeploymentFootprint({ manifest: WITH_POSTGRES, region: 'eu-west-1' });
    const database = footprint.resources.find((resource) => resource.id === 'database')!;
    expect(database.category).toBe('database');
    expect(database.service).toBe('rds-postgres');
    expect(database.quantity).toBe(1);
    expect(database.configuration).toEqual({
      engine: 'postgres',
      engineVersion: '16',
      instanceType: 'db.t4g.micro',
      storageGb: 20,
    });
    expect(database.lifecycle).toEqual({ persistent: true, retainOnDelete: true });
  });

  it('compute + PostgreSQL + Redis: cache resource with resolved node type, removed on delete', () => {
    const footprint = resolveDeploymentFootprint({ manifest: WITH_POSTGRES_REDIS, region: null });
    expect(footprint.resources.map((resource) => resource.id)).toEqual([
      'database',
      'cache',
      'storage',
      'endpoint',
      'nat-gateway',
    ]);
    const cache = footprint.resources.find((resource) => resource.id === 'cache')!;
    expect(cache.service).toBe('elasticache-valkey');
    expect(cache.configuration).toEqual({ engine: 'valkey', nodeType: 'cache.t4g.micro', nodes: 1 });
    expect(cache.lifecycle).toEqual({ persistent: false, retainOnDelete: false });
    expect(footprint.region).toBeNull();
  });

  it('no database: no database resource, no engine assumptions in common resources', () => {
    const footprint = resolveDeploymentFootprint({ manifest: STATELESS, region: null });
    expect(footprint.resources.some((resource) => resource.category === 'database')).toBe(false);
  });

  it('a manifest worker command resolves a second workload from the sizing table', () => {
    const footprint = resolveDeploymentFootprint({ manifest: WITH_WORKER, region: null });
    const worker = footprint.workloads.find((workload) => workload.id === 'worker');
    expect(worker).toEqual({
      id: 'worker',
      role: 'worker',
      label: 'Background worker',
      quantity: DEPLOYMENT_SIZING.workload.worker.quantity,
      compute: {
        provider: 'aws',
        service: 'ecs-fargate',
        cpuUnits: DEPLOYMENT_SIZING.workload.worker.cpuUnits,
        memoryMiB: DEPLOYMENT_SIZING.workload.worker.memoryMiB,
        sizeLabel: DEPLOYMENT_SIZING.workload.worker.sizeLabel,
      },
      lifecycle: { persistent: false },
    });
  });

  it('generatedFrom records the template generation; ids and order are stable', () => {
    const a = resolveDeploymentFootprint({ manifest: WITH_POSTGRES, region: 'us-east-1', infraVersion: 'runtime-v1' });
    const b = resolveDeploymentFootprint({ manifest: WITH_POSTGRES, region: 'us-east-1', infraVersion: 'runtime-v1' });
    expect(a).toEqual(b);
    expect(a.generatedFrom).toEqual({ infraVersion: 'runtime-v1' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('round-trips through the zod schema; infraVersion defaults to null', () => {
    const footprint = resolveDeploymentFootprint({ manifest: WITH_POSTGRES_REDIS, region: 'us-east-1' });
    expect(deploymentFootprintSchema.parse(footprint)).toEqual(footprint);
    expect(resolveDeploymentFootprint({ manifest: WITH_POSTGRES, region: null }).generatedFrom).toEqual({
      infraVersion: null,
    });
  });
});

// Extensibility: a synthetic fixture with a MySQL database, a scheduler
// workload and a queue — resource types Deployz does not provision yet —
// must validate against the generic schema and degrade in pricing without
// any PostgreSQL-specific code path. This proves the model (not rendering)
// accepts future engines and roles.
describe('generic model accepts future resource types', () => {
  const mysqlResource: FootprintResource = {
    id: 'database',
    category: 'database',
    provider: 'aws',
    service: 'rds-mysql',
    role: 'database',
    label: 'Database',
    quantity: 1,
    configuration: { engine: 'mysql', engineVersion: '8', instanceType: 'db.t4g.micro', storageGb: 20 },
    lifecycle: { persistent: true, retainOnDelete: true },
  };
  const schedulerWorkload: FootprintWorkload = {
    id: 'scheduler',
    role: 'scheduler',
    label: 'Scheduler',
    quantity: 1,
    compute: {
      provider: 'aws',
      service: 'ecs-fargate',
      cpuUnits: 256,
      memoryMiB: 512,
      sizeLabel: 'Small',
    },
    lifecycle: { persistent: false },
  };
  const FUTURE: DeploymentFootprint = {
    version: 1,
    region: 'us-east-1',
    workloads: [
      resolveDeploymentFootprint({ manifest: STATELESS, region: 'us-east-1' }).workloads[0]!,
      schedulerWorkload,
    ],
    resources: [
      mysqlResource,
      ...resolveDeploymentFootprint({ manifest: STATELESS, region: 'us-east-1' }).resources,
    ],
    generatedFrom: { infraVersion: null },
  };

  it('validates a synthetic MySQL + scheduler footprint against the generic schema', () => {
    expect(deploymentFootprintSchema.parse(FUTURE)).toEqual(FUTURE);
  });

  it('pricing the synthetic footprint: unknown engine degrades to unavailable, never dropped', () => {
    const estimate = estimateFootprintCost(FUTURE);
    const database = estimate.items.find((item) => item.resourceId === 'database')!;
    expect(database.pricingStatus).toBe('unavailable');
    expect(estimate.complete).toBe(false);
    expect(estimate.items.some((item) => item.resourceId === 'scheduler' && item.pricingStatus === 'estimated')).toBe(
      true,
    );
  });
});
