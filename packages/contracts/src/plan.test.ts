import { describe, expect, it } from 'vitest';

import { buildDestroyPlan, buildInstallPlan, buildUpdatePlan, deploymentPlanSchema } from './plan.js';
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

const POSTGRES_ONLY = manifestWith(true, false);
const POSTGRES_REDIS = manifestWith(true, true);
const STATELESS = manifestWith(false, false);
const STATELESS_REDIS = manifestWith(false, true);

describe('buildInstallPlan', () => {
  it('v1 (postgres, no redis): CREATE application, endpoint, database, storage', () => {
    const plan = buildInstallPlan({ manifest: POSTGRES_ONLY, region: 'us-east-1' });
    expect(plan).toEqual({
      schemaVersion: 1,
      action: 'INSTALL',
      region: 'us-east-1',
      components: [
        { kind: 'application', name: 'Application', action: 'CREATE', lifecycle: 'delete' },
        { kind: 'endpoint', name: 'Secure endpoint', action: 'CREATE', lifecycle: 'delete' },
        { kind: 'database', name: 'Database', action: 'CREATE', lifecycle: 'retain' },
        { kind: 'storage', name: 'Storage', action: 'CREATE', lifecycle: 'retain' },
      ],
      requirementDrift: [],
    });
  });

  it('redis-v1 (postgres + redis): CREATE application, endpoint, database, storage, cache', () => {
    const plan = buildInstallPlan({ manifest: POSTGRES_REDIS, region: 'us-east-1' });
    expect(plan.components).toEqual([
      { kind: 'application', name: 'Application', action: 'CREATE', lifecycle: 'delete' },
      { kind: 'endpoint', name: 'Secure endpoint', action: 'CREATE', lifecycle: 'delete' },
      { kind: 'database', name: 'Database', action: 'CREATE', lifecycle: 'retain' },
      { kind: 'storage', name: 'Storage', action: 'CREATE', lifecycle: 'retain' },
      { kind: 'cache', name: 'Cache', action: 'CREATE', lifecycle: 'delete' },
    ]);
  });

  it('stateless-v1 (neither): CREATE application, endpoint, storage', () => {
    const plan = buildInstallPlan({ manifest: STATELESS, region: null });
    expect(plan.components).toEqual([
      { kind: 'application', name: 'Application', action: 'CREATE', lifecycle: 'delete' },
      { kind: 'endpoint', name: 'Secure endpoint', action: 'CREATE', lifecycle: 'delete' },
      { kind: 'storage', name: 'Storage', action: 'CREATE', lifecycle: 'retain' },
    ]);
    expect(plan.region).toBeNull();
  });

  it('stateless-redis-v1 (redis only): CREATE application, endpoint, storage, cache', () => {
    const plan = buildInstallPlan({ manifest: STATELESS_REDIS, region: 'eu-west-1' });
    expect(plan.components).toEqual([
      { kind: 'application', name: 'Application', action: 'CREATE', lifecycle: 'delete' },
      { kind: 'endpoint', name: 'Secure endpoint', action: 'CREATE', lifecycle: 'delete' },
      { kind: 'storage', name: 'Storage', action: 'CREATE', lifecycle: 'retain' },
      { kind: 'cache', name: 'Cache', action: 'CREATE', lifecycle: 'delete' },
    ]);
  });

  it('is deterministic: two calls deep-equal and stringify identically', () => {
    const a = buildInstallPlan({ manifest: POSTGRES_REDIS, region: 'us-east-1' });
    const b = buildInstallPlan({ manifest: POSTGRES_REDIS, region: 'us-east-1' });
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('buildDestroyPlan', () => {
  it('v1 (postgres, no redis): DELETE application/endpoint, RETAIN database/storage', () => {
    const plan = buildDestroyPlan({ manifest: POSTGRES_ONLY, region: 'us-east-1' });
    expect(plan).toEqual({
      schemaVersion: 1,
      action: 'DESTROY',
      region: 'us-east-1',
      components: [
        { kind: 'application', name: 'Application', action: 'DELETE', lifecycle: 'delete' },
        { kind: 'endpoint', name: 'Secure endpoint', action: 'DELETE', lifecycle: 'delete' },
        { kind: 'database', name: 'Database', action: 'RETAIN', lifecycle: 'retain' },
        { kind: 'storage', name: 'Storage', action: 'RETAIN', lifecycle: 'retain' },
      ],
      requirementDrift: [],
    });
  });

  it('redis-v1 (postgres + redis): DELETE application/endpoint/cache, RETAIN database/storage', () => {
    const plan = buildDestroyPlan({ manifest: POSTGRES_REDIS, region: 'us-east-1' });
    expect(plan.components).toEqual([
      { kind: 'application', name: 'Application', action: 'DELETE', lifecycle: 'delete' },
      { kind: 'endpoint', name: 'Secure endpoint', action: 'DELETE', lifecycle: 'delete' },
      { kind: 'database', name: 'Database', action: 'RETAIN', lifecycle: 'retain' },
      { kind: 'storage', name: 'Storage', action: 'RETAIN', lifecycle: 'retain' },
      { kind: 'cache', name: 'Cache', action: 'DELETE', lifecycle: 'delete' },
    ]);
  });

  it('stateless-v1: lists no database/cache and RETAINs only storage', () => {
    const plan = buildDestroyPlan({ manifest: STATELESS, region: 'us-east-1' });
    expect(plan.components.map((component) => component.kind)).not.toContain('database');
    expect(plan.components.map((component) => component.kind)).not.toContain('cache');
    expect(plan.components.filter((component) => component.action === 'RETAIN')).toEqual([
      { kind: 'storage', name: 'Storage', action: 'RETAIN', lifecycle: 'retain' },
    ]);
  });

  it('stateless-redis-v1: DELETE application/endpoint/cache, RETAIN storage', () => {
    const plan = buildDestroyPlan({ manifest: STATELESS_REDIS, region: 'us-east-1' });
    expect(plan.components).toEqual([
      { kind: 'application', name: 'Application', action: 'DELETE', lifecycle: 'delete' },
      { kind: 'endpoint', name: 'Secure endpoint', action: 'DELETE', lifecycle: 'delete' },
      { kind: 'storage', name: 'Storage', action: 'RETAIN', lifecycle: 'retain' },
      { kind: 'cache', name: 'Cache', action: 'DELETE', lifecycle: 'delete' },
    ]);
  });
});

describe('buildUpdatePlan', () => {
  it('application UNCHANGED, no drift, when profiles agree and there is no newer release', () => {
    const plan = buildUpdatePlan({
      deployedManifest: POSTGRES_ONLY,
      desiredManifest: POSTGRES_ONLY,
      region: 'us-east-1',
      newRelease: false,
    });
    expect(plan).toEqual({
      schemaVersion: 1,
      action: 'UPDATE',
      region: 'us-east-1',
      components: [
        { kind: 'application', name: 'Application', action: 'UNCHANGED', lifecycle: 'delete' },
        { kind: 'endpoint', name: 'Secure endpoint', action: 'UNCHANGED', lifecycle: 'delete' },
        { kind: 'database', name: 'Database', action: 'UNCHANGED', lifecycle: 'retain' },
        { kind: 'storage', name: 'Storage', action: 'UNCHANGED', lifecycle: 'retain' },
      ],
      requirementDrift: [],
    });
  });

  it('application UPDATE when a newer release exists; every other component still UNCHANGED', () => {
    const plan = buildUpdatePlan({
      deployedManifest: POSTGRES_REDIS,
      desiredManifest: POSTGRES_REDIS,
      region: 'us-east-1',
      newRelease: true,
    });
    expect(plan.components).toEqual([
      { kind: 'application', name: 'Application', action: 'UPDATE', lifecycle: 'delete' },
      { kind: 'endpoint', name: 'Secure endpoint', action: 'UNCHANGED', lifecycle: 'delete' },
      { kind: 'database', name: 'Database', action: 'UNCHANGED', lifecycle: 'retain' },
      { kind: 'storage', name: 'Storage', action: 'UNCHANGED', lifecycle: 'retain' },
      { kind: 'cache', name: 'Cache', action: 'UNCHANGED', lifecycle: 'delete' },
    ]);
    expect(plan.requirementDrift).toEqual([]);
  });

  it('reports drift, never a CREATE, when the desired profile gained redis', () => {
    const plan = buildUpdatePlan({
      deployedManifest: POSTGRES_ONLY,
      desiredManifest: POSTGRES_REDIS,
      region: 'us-east-1',
      newRelease: false,
    });
    // Deployed profile has no cache component — the plan never invents one.
    expect(plan.components.map((component) => component.kind)).not.toContain('cache');
    expect(plan.requirementDrift).toEqual([{ kind: 'cache', deployed: false, desired: true }]);
  });

  it('reports drift the other direction, when the desired profile lost redis', () => {
    const plan = buildUpdatePlan({
      deployedManifest: POSTGRES_REDIS,
      desiredManifest: POSTGRES_ONLY,
      region: 'us-east-1',
      newRelease: false,
    });
    expect(plan.components.map((component) => component.kind)).toContain('cache');
    expect(plan.requirementDrift).toEqual([{ kind: 'cache', deployed: true, desired: false }]);
  });

  it('is deterministic: two calls deep-equal and stringify identically', () => {
    const input = {
      deployedManifest: POSTGRES_ONLY,
      desiredManifest: POSTGRES_REDIS,
      region: 'us-east-1' as const,
      newRelease: true,
    };
    const a = buildUpdatePlan(input);
    const b = buildUpdatePlan(input);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('deploymentPlanSchema', () => {
  it('round-trips every plan shape unchanged', () => {
    const plans = [
      buildInstallPlan({ manifest: POSTGRES_REDIS, region: 'us-east-1' }),
      buildInstallPlan({ manifest: STATELESS, region: null }),
      buildDestroyPlan({ manifest: POSTGRES_ONLY, region: 'us-east-1' }),
      buildUpdatePlan({
        deployedManifest: POSTGRES_ONLY,
        desiredManifest: POSTGRES_REDIS,
        region: 'us-east-1',
        newRelease: true,
      }),
    ];
    for (const plan of plans) {
      expect(deploymentPlanSchema.parse(plan)).toEqual(plan);
    }
  });
});
