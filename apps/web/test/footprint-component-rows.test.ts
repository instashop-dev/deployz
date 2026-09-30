import { describe, expect, it } from 'vitest';

import { resolveDeploymentFootprint } from '@deployz/contracts';
import type { DeploymentFootprint, DeploymentManifest, FootprintResource, FootprintWorkload } from '@deployz/contracts';

import { footprintComponentRows } from '../src/lib/footprint';

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

const STANDARD_MANIFEST = manifestWith({
  database: { postgres: true },
  redis: { required: true, envBindings: [] },
});
const MINIMAL_MANIFEST = manifestWith();

function footprintFor(manifest: DeploymentManifest): DeploymentFootprint {
  return resolveDeploymentFootprint({ manifest, region: 'us-east-1' });
}

describe('footprintComponentRows', () => {
  it('renders the standard plan (web + database + cache + storage + endpoint + nat gateway)', () => {
    const rows = footprintComponentRows(footprintFor(STANDARD_MANIFEST));
    expect(rows.map((row) => row.id)).toEqual(['web', 'database', 'cache', 'storage', 'endpoint', 'nat-gateway']);

    const web = rows.find((row) => row.id === 'web')!;
    expect(web).toEqual({
      id: 'web',
      component: 'Web application',
      provisionedAs: 'AWS Fargate',
      configuration: '0.25 vCPU · 0.5 GB memory',
      retention: 'Removed',
    });

    const database = rows.find((row) => row.id === 'database')!;
    expect(database).toEqual({
      id: 'database',
      component: 'Database',
      provisionedAs: 'PostgreSQL 16',
      configuration: 'db.t4g.micro · 20 GB storage',
      retention: 'Retained',
    });

    const cache = rows.find((row) => row.id === 'cache')!;
    expect(cache).toEqual({
      id: 'cache',
      component: 'Cache',
      provisionedAs: 'Redis (Valkey)',
      configuration: 'cache.t4g.micro · 1 node',
      retention: 'Removed',
    });

    const storage = rows.find((row) => row.id === 'storage')!;
    expect(storage.configuration).toBeNull();
    expect(storage.retention).toBe('Retained');

    const endpoint = rows.find((row) => row.id === 'endpoint')!;
    expect(endpoint.configuration).toBeNull();
    expect(endpoint.retention).toBe('Removed');

    const natGateway = rows.find((row) => row.id === 'nat-gateway')!;
    expect(natGateway.provisionedAs).toBe('NAT gateway');
    expect(natGateway.retention).toBe('Removed');
  });

  it('shows no database or cache rows for the minimal plan (web + storage + network only)', () => {
    const rows = footprintComponentRows(footprintFor(MINIMAL_MANIFEST));
    const ids = rows.map((row) => row.id);
    expect(ids).not.toContain('database');
    expect(ids).not.toContain('cache');
    expect(ids).toEqual(['web', 'storage', 'endpoint', 'nat-gateway']);
  });

  it('renders a future MySQL database through the generic path', () => {
    const base = footprintFor(MINIMAL_MANIFEST);
    const mysql: FootprintResource = {
      id: 'database',
      category: 'database',
      provider: 'aws',
      service: 'rds-mysql',
      role: 'database',
      label: 'Database',
      quantity: 1,
      configuration: { engine: 'mysql', instanceType: 'db.t4g.small', storageGb: 50 },
      lifecycle: { persistent: true, retainOnDelete: true },
    };
    const footprint: DeploymentFootprint = { ...base, resources: [...base.resources, mysql] };
    const row = footprintComponentRows(footprint).find((entry) => entry.id === 'database')!;
    expect(row).toEqual({
      id: 'database',
      component: 'Database',
      provisionedAs: 'MySQL',
      configuration: 'db.t4g.small · 50 GB storage',
      retention: 'Retained',
    });
  });

  it('renders two worker workloads, one with quantity, through the generic path', () => {
    const base = footprintFor(MINIMAL_MANIFEST);
    const worker: FootprintWorkload = {
      id: 'worker',
      role: 'worker',
      label: 'Background worker',
      quantity: 1,
      compute: { provider: 'aws', service: 'ecs-fargate', cpuUnits: 256, memoryMiB: 512, sizeLabel: 'Small' },
      lifecycle: { persistent: false },
    };
    const bulkWorker: FootprintWorkload = {
      id: 'worker-bulk',
      role: 'worker',
      label: 'Bulk import worker',
      quantity: 3,
      compute: { provider: 'aws', service: 'ecs-fargate', cpuUnits: 512, memoryMiB: 1024, sizeLabel: 'Medium' },
      lifecycle: { persistent: false },
    };
    const footprint: DeploymentFootprint = { ...base, workloads: [...base.workloads, worker, bulkWorker] };
    const rows = footprintComponentRows(footprint);

    const singleWorker = rows.find((row) => row.id === 'worker')!;
    expect(singleWorker.component).toBe('Background worker');
    expect(singleWorker.configuration).toBe('0.25 vCPU · 0.5 GB memory');
    expect(singleWorker.retention).toBe('Removed');

    const bulk = rows.find((row) => row.id === 'worker-bulk')!;
    expect(bulk.component).toBe('3 × Bulk import worker');
    expect(bulk.configuration).toBe('0.5 vCPU · 1 GB memory');
    expect(bulk.retention).toBe('Removed');
  });

  it('renders an unknown future resource (a queue) through the generic path', () => {
    const base = footprintFor(MINIMAL_MANIFEST);
    const queue: FootprintResource = {
      id: 'queue',
      category: 'queue',
      provider: 'aws',
      service: 'sqs',
      role: 'queue',
      label: 'Task queue',
      quantity: 1,
      configuration: {},
      lifecycle: { persistent: false, retainOnDelete: false },
    };
    const footprint: DeploymentFootprint = { ...base, resources: [...base.resources, queue] };
    const row = footprintComponentRows(footprint).find((entry) => entry.id === 'queue')!;
    expect(row).toEqual({
      id: 'queue',
      component: 'Task queue',
      provisionedAs: 'sqs',
      configuration: null,
      retention: 'Removed',
    });
  });

  it('never produces an empty string or an em dash for any field', () => {
    const rows = [
      ...footprintComponentRows(footprintFor(STANDARD_MANIFEST)),
      ...footprintComponentRows(footprintFor(MINIMAL_MANIFEST)),
    ];
    for (const row of rows) {
      expect(row.component).not.toBe('');
      expect(row.provisionedAs).not.toBe('');
      expect(row.component).not.toContain('—');
      expect(row.provisionedAs).not.toContain('—');
      if (row.configuration !== null) {
        expect(row.configuration).not.toBe('');
        expect(row.configuration).not.toContain('—');
      }
    }
  });
});
