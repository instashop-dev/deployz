import { describe, expect, it } from 'vitest';

import {
  type ApplicationGraph,
  type CapabilityRegistry,
  type InfrastructureSizeProfile,
  type Region,
  APPLICATION_GRAPH_SCHEMA_VERSION,
  defaultCapabilityRegistry,
  defaultInfrastructureSizeProfile,
} from '@deployz/contracts';

import {
  buildDeploymentSpecV2,
  planApplicationGraph,
  planApplicationGraphWithSpec,
} from '../src/planner.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REGION: Region = 'us-east-1';
const PROFILE: InfrastructureSizeProfile = defaultInfrastructureSizeProfile();
const REGISTRY: CapabilityRegistry = defaultCapabilityRegistry();

const PROVENANCE = { detected: true, overridden: false, evidence: [] };

function baseGraph(overrides: Partial<ApplicationGraph> = {}): ApplicationGraph {
  return {
    schemaVersion: APPLICATION_GRAPH_SCHEMA_VERSION,
    applicationRoot: '.',
    buildArtifacts: [
      {
        id: 'app',
        sourceRoot: '.',
        dockerfilePath: 'Dockerfile',
        buildContext: '.',
        architecture: null,
        target: null,
        buildCommand: null,
        provenance: PROVENANCE,
      },
    ],
    workloads: [],
    resources: [],
    bindings: [],
    externalServices: [],
    unresolved: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const statelessGraph = baseGraph({
  workloads: [
    {
      id: 'web',
      kind: 'web',
      label: 'Web',
      sourceRoot: '.',
      buildArtifactId: 'app',
      command: 'node dist/index.js',
      port: 3000,
      public: true,
      healthCheck: { path: '/health' },
      desiredCount: 2,
      runtime: 'node',
      framework: 'express',
      provenance: PROVENANCE,
    },
  ],
});

const postgresRedisGraph = baseGraph({
  workloads: [
    {
      id: 'web',
      kind: 'web',
      label: 'Web',
      sourceRoot: '.',
      buildArtifactId: 'app',
      command: null,
      port: 3000,
      public: true,
      healthCheck: { path: '/health' },
      desiredCount: 1,
      runtime: 'node',
      framework: null,
      provenance: PROVENANCE,
    },
  ],
  resources: [
    {
      id: 'primary-db',
      kind: 'relational_database',
      label: 'Primary DB',
      ownership: 'DEPLOYZ_MANAGED',
      capabilityKey: 'aws.rds-postgres',
      quantity: 1,
      envBindings: [{ name: 'DATABASE_URL', kind: 'url' }],
      engine: 'postgres',
      provenance: PROVENANCE,
    },
    {
      id: 'redis-cache',
      kind: 'cache',
      label: 'Redis Cache',
      ownership: 'DEPLOYZ_MANAGED',
      capabilityKey: 'aws.elasticache-valkey',
      quantity: 1,
      envBindings: [{ name: 'REDIS_URL', kind: 'url' }],
      engine: 'valkey',
      provenance: PROVENANCE,
    },
  ],
  bindings: [
    {
      id: 'web-to-db',
      sourceId: 'web',
      targetId: 'primary-db',
      relationship: 'BINDING',
      envBindings: [{ name: 'DATABASE_URL', kind: 'url' }],
      provenance: PROVENANCE,
    },
    {
      id: 'web-to-redis',
      sourceId: 'web',
      targetId: 'redis-cache',
      relationship: 'BINDING',
      envBindings: [{ name: 'REDIS_URL', kind: 'url' }],
      provenance: PROVENANCE,
    },
  ],
});

const workerGraph = baseGraph({
  workloads: [
    {
      id: 'email-worker',
      kind: 'worker',
      label: 'Email Worker',
      sourceRoot: '.',
      buildArtifactId: 'app',
      command: 'node dist/worker.js',
      port: null,
      public: false,
      healthCheck: null,
      desiredCount: 1,
      runtime: 'node',
      framework: null,
      provenance: PROVENANCE,
    },
    {
      id: 'migration',
      kind: 'migration',
      label: 'Migration',
      sourceRoot: '.',
      buildArtifactId: 'app',
      command: 'node dist/migrate.js',
      port: null,
      public: false,
      healthCheck: null,
      desiredCount: 1,
      runtime: 'node',
      framework: null,
      provenance: PROVENANCE,
    },
  ],
  resources: [
    {
      id: 'primary-db',
      kind: 'relational_database',
      label: 'Primary DB',
      ownership: 'DEPLOYZ_MANAGED',
      capabilityKey: 'aws.rds-postgres',
      quantity: 1,
      envBindings: [{ name: 'DATABASE_URL', kind: 'url' }],
      engine: 'postgres',
      provenance: PROVENANCE,
    },
  ],
  bindings: [
    {
      id: 'worker-to-db',
      sourceId: 'email-worker',
      targetId: 'primary-db',
      relationship: 'BINDING',
      envBindings: [{ name: 'DATABASE_URL', kind: 'url' }],
      provenance: PROVENANCE,
    },
    {
      id: 'migration-to-db',
      sourceId: 'migration',
      targetId: 'primary-db',
      relationship: 'BINDING',
      envBindings: [{ name: 'DATABASE_URL', kind: 'url' }],
      provenance: PROVENANCE,
    },
  ],
});

// ---------------------------------------------------------------------------
// Tests — stateless graph
// ---------------------------------------------------------------------------

describe('planApplicationGraph — stateless graph', () => {
  const ir = planApplicationGraph({ graph: statelessGraph, region: REGION });

  it('produces one workload with correct compute', () => {
    expect(ir.workloads).toHaveLength(1);
    const w = ir.workloads[0];
    expect(w.componentId).toBe('web');
    expect(w.kind).toBe('web');
    expect(w.compute.provider).toBe('aws');
    expect(w.compute.capabilityKey).toBe('aws.ecs-service');
    expect(w.compute.cpuUnits).toBe(PROFILE.workload.cpuUnits);
    expect(w.compute.memoryMiB).toBe(PROFILE.workload.memoryMiB);
    expect(w.compute.sizeLabel).toBe(PROFILE.label);
    expect(w.desiredCount).toBe(2);
  });

  it('has no resources', () => {
    expect(ir.resources).toHaveLength(0);
  });

  it('sets public ingress with ALB capability', () => {
    expect(ir.ingress.public).toBe(true);
    expect(ir.ingress.capabilityKey).toBe('aws.alb');
    expect(ir.ingress.targetWorkloadIds).toEqual(['web']);
  });

  it('sets metadata', () => {
    expect(ir.metadata.region).toBe(REGION);
    expect(ir.metadata.sizeProfileId).toBe(PROFILE.id);
    expect(ir.metadata.capabilityRegistryVersion).toBe(REGISTRY.version);
    expect(ir.metadata.graphSchemaVersion).toBe(APPLICATION_GRAPH_SCHEMA_VERSION);
  });

  it('sets policies', () => {
    expect(ir.policies.allowTopologyChanges).toBe(false);
    expect(ir.policies.defaultRetention).toBe('retain');
  });

  it('has empty schedules', () => {
    expect(ir.schedules).toEqual([]);
  });

  it('has no bindings', () => {
    expect(ir.bindings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests — postgres + redis graph
// ---------------------------------------------------------------------------

describe('planApplicationGraph — postgres+redis graph', () => {
  const ir = planApplicationGraph({ graph: postgresRedisGraph, region: REGION });

  it('maps managed resources with correct configuration', () => {
    expect(ir.resources).toHaveLength(2);

    const db = ir.resources.find((r) => r.componentId === 'primary-db');
    expect(db).toBeDefined();
    expect(db!.capabilityKey).toBe('aws.rds-postgres');
    expect(db!.lifecycle).toBe('retain');
    expect(db!.scope).toBe('REGIONAL');
    expect(db!.configuration).toEqual({
      engine: 'postgres',
      engineVersion: '16',
      instanceType: PROFILE.database.instanceClass,
      storageGb: PROFILE.database.storageGb,
      maxStorageGb: PROFILE.database.maxStorageGb,
    });

    const cache = ir.resources.find((r) => r.componentId === 'redis-cache');
    expect(cache).toBeDefined();
    expect(cache!.capabilityKey).toBe('aws.elasticache-valkey');
    expect(cache!.lifecycle).toBe('delete');
    expect(cache!.configuration).toEqual({
      engine: 'valkey',
      nodeType: PROFILE.cache.nodeType,
      nodes: PROFILE.cache.nodeCount,
    });
  });

  it('maps bindings with IAM actions from capability registry', () => {
    expect(ir.bindings).toHaveLength(2);
    // RDS has no IAM actions in the default registry
    const dbBinding = ir.bindings.find((b) => b.id === 'web-to-db');
    expect(dbBinding!.iamActions).toEqual([]);
    // Valkey has no IAM actions in the default registry
    const redisBinding = ir.bindings.find((b) => b.id === 'web-to-redis');
    expect(redisBinding!.iamActions).toEqual([]);
  });

  it('sets workload dependency capability keys', () => {
    const w = ir.workloads[0];
    expect(w.dependencyCapabilityKeys).toContain('aws.rds-postgres');
    expect(w.dependencyCapabilityKeys).toContain('aws.elasticache-valkey');
  });

  it('excludes non-managed resources', () => {
    const graphWithExternal = baseGraph({
      ...postgresRedisGraph,
      resources: [
        ...postgresRedisGraph.resources,
        {
          id: 'external-db',
          kind: 'relational_database' as const,
          label: 'External DB',
          ownership: 'CUSTOMER_EXISTING' as const,
          capabilityKey: 'aws.rds-postgres',
          quantity: 1,
          envBindings: [],
          engine: 'postgres',
          provenance: PROVENANCE,
        },
      ],
    });
    const ir2 = planApplicationGraph({ graph: graphWithExternal, region: REGION });
    expect(ir2.resources).toHaveLength(2);
    expect(ir2.resources.find((r) => r.componentId === 'external-db')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests — worker graph
// ---------------------------------------------------------------------------

describe('planApplicationGraph — worker graph', () => {
  const ir = planApplicationGraph({ graph: workerGraph, region: REGION });

  it('assigns ecs-service for worker, ecs-task for migration', () => {
    const worker = ir.workloads.find((w) => w.componentId === 'email-worker');
    expect(worker!.compute.capabilityKey).toBe('aws.ecs-service');

    const migration = ir.workloads.find((w) => w.componentId === 'migration');
    expect(migration!.compute.capabilityKey).toBe('aws.ecs-task');
  });

  it('sets ingress to private (no public workloads)', () => {
    expect(ir.ingress.public).toBe(false);
    expect(ir.ingress.capabilityKey).toBeNull();
    expect(ir.ingress.targetWorkloadIds).toEqual([]);
  });

  it('maps bindings for both workloads', () => {
    expect(ir.bindings).toHaveLength(2);
    expect(ir.bindings.map((b) => b.sourceId).sort()).toEqual(['email-worker', 'migration']);
  });
});

// ---------------------------------------------------------------------------
// Tests — S3 IAM actions
// ---------------------------------------------------------------------------

describe('planApplicationGraph — S3 binding IAM actions', () => {
  it('copies IAM actions from the target capability', () => {
    const graph = baseGraph({
      workloads: [
        {
          id: 'web',
          kind: 'web',
          label: 'Web',
          sourceRoot: '.',
          buildArtifactId: 'app',
          command: null,
          port: 3000,
          public: true,
          healthCheck: null,
          desiredCount: 1,
          runtime: null,
          framework: null,
          provenance: PROVENANCE,
        },
      ],
      resources: [
        {
          id: 'uploads',
          kind: 'object_storage',
          label: 'Uploads',
          ownership: 'DEPLOYZ_MANAGED',
          capabilityKey: 'aws.s3',
          quantity: 1,
          envBindings: [{ name: 'S3_BUCKET', kind: 'bucket' }],
          engine: null,
          provenance: PROVENANCE,
        },
      ],
      bindings: [
        {
          id: 'web-to-s3',
          sourceId: 'web',
          targetId: 'uploads',
          relationship: 'BINDING',
          envBindings: [{ name: 'S3_BUCKET', kind: 'bucket' }],
          provenance: PROVENANCE,
        },
      ],
    });

    const ir = planApplicationGraph({ graph, region: REGION });
    const binding = ir.bindings[0];
    expect(binding.iamActions).toEqual([
      's3:GetObject',
      's3:PutObject',
      's3:DeleteObject',
      's3:ListBucket',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Tests — DeploymentSpecV2
// ---------------------------------------------------------------------------

describe('buildDeploymentSpecV2', () => {
  it('produces a valid spec with hashes', () => {
    const ir = planApplicationGraph({ graph: statelessGraph, region: REGION });
    const spec = buildDeploymentSpecV2({
      graph: statelessGraph,
      ir,
      sizeProfileId: PROFILE.id,
      capabilityRegistryVersion: REGISTRY.version,
    });

    expect(spec.infraVersion).toBe('dynamic-compiler-v2');
    expect(spec.graphHash).toMatch(/^[a-f0-9]{64}$/);
    expect(spec.irHash).toMatch(/^[a-f0-9]{64}$/);
    expect(spec.compilerVersion).toBeNull();
    expect(spec.templateHash).toBeNull();
    expect(spec.artifactLocation).toBeNull();
    expect(spec.frozenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(spec.capabilityRegistryVersion).toBe(REGISTRY.version);
    expect(spec.sizeProfileId).toBe(PROFILE.id);
  });

  it('produces stable hashes for the same input', () => {
    const ir1 = planApplicationGraph({ graph: statelessGraph, region: REGION });
    const ir2 = planApplicationGraph({ graph: statelessGraph, region: REGION });
    const spec1 = buildDeploymentSpecV2({
      graph: statelessGraph,
      ir: ir1,
      sizeProfileId: PROFILE.id,
      capabilityRegistryVersion: REGISTRY.version,
    });
    const spec2 = buildDeploymentSpecV2({
      graph: statelessGraph,
      ir: ir2,
      sizeProfileId: PROFILE.id,
      capabilityRegistryVersion: REGISTRY.version,
    });

    expect(spec1.graphHash).toBe(spec2.graphHash);
    expect(spec1.irHash).toBe(spec2.irHash);
  });
});

// ---------------------------------------------------------------------------
// Tests — planApplicationGraphWithSpec
// ---------------------------------------------------------------------------

describe('planApplicationGraphWithSpec', () => {
  it('returns both IR and spec', () => {
    const { ir, spec } = planApplicationGraphWithSpec({
      graph: postgresRedisGraph,
      region: REGION,
    });

    expect(ir.workloads).toHaveLength(1);
    expect(ir.resources).toHaveLength(2);
    expect(spec.graphHash).toMatch(/^[a-f0-9]{64}$/);
    expect(spec.irHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
