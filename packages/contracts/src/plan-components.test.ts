import { describe, expect, it } from 'vitest';

import { CAPABILITY_KEYS } from './capability-registry.js';
import { APPLICATION_GRAPH_SCHEMA_VERSION } from './application-graph.js';
import { DEPLOYMENT_SPEC_V2_SCHEMA_VERSION, INFRA_VERSION_DYNAMIC_COMPILER_V2, deploymentSpecV2Schema } from './deployment-spec-v2.js';
import { DEPLOYZ_IR_SCHEMA_VERSION } from './deployz-ir.js';
import type { DeployzIR } from './deployz-ir.js';
import { DEFAULT_CAPABILITY_REGISTRY_VERSION } from './capability-registry.js';
import { buildInstallPlan, deploymentPlanComponentSchema } from './plan.js';
import { UNKNOWN_PLAN_COMPONENT_KIND, derivePlanComponentsFromSpec } from './plan-components.js';
import type { DeploymentPlanComponent } from './plan.js';
import type { DeploymentManifest } from './manifest.js';
import type { DeploymentSpecV2 } from './deployment-spec-v2.js';

// ---------------------------------------------------------------------------
// Fixtures — inline DeploymentSpecV2 constructions matching the schemas. The
// real planner lives in @deployz/analysis, which depends on this package, so
// the fixtures here are hand-built to the same shapes.
// ---------------------------------------------------------------------------

const WORKLOAD = {
  componentId: 'web',
  kind: 'web' as const,
  label: 'Web',
  buildArtifactId: 'app',
  command: null,
  port: 3000,
  public: true,
  healthCheck: { path: '/health' },
  desiredCount: 1,
  compute: {
    provider: 'aws' as const,
    capabilityKey: CAPABILITY_KEYS.ECS_FARGATE_SERVICE,
    cpuUnits: 256,
    memoryMiB: 512,
    sizeLabel: 'Small',
    architecture: null,
  },
  dependencyCapabilityKeys: [],
};

function irResource(componentId: string, capabilityKey: string, label: string, lifecycle: 'delete' | 'retain') {
  return {
    componentId,
    capabilityKey,
    label,
    quantity: 1,
    configuration: {},
    lifecycle,
    scope: 'REGIONAL' as const,
    envBindings: [],
  };
}

/** postgres + storage + cache — the same shape the manifest plans cover. */
function baseIr(): DeployzIR {
  return {
    schemaVersion: DEPLOYZ_IR_SCHEMA_VERSION,
    workloads: [{ ...WORKLOAD }],
    resources: [
      irResource('primary-db', CAPABILITY_KEYS.RDS_POSTGRES, 'Primary DB', 'retain'),
      irResource('uploads', CAPABILITY_KEYS.S3, 'Uploads', 'retain'),
      irResource('redis-cache', CAPABILITY_KEYS.ELASTICACHE_VALKEY, 'Redis Cache', 'delete'),
    ],
    bindings: [],
    ingress: { public: true, capabilityKey: CAPABILITY_KEYS.ALB, targetWorkloadIds: ['web'] },
    schedules: [],
    policies: { allowTopologyChanges: false, defaultRetention: 'retain' },
    metadata: {
      graphSchemaVersion: 1,
      capabilityRegistryVersion: DEFAULT_CAPABILITY_REGISTRY_VERSION,
      sizeProfileId: 'standard',
      region: 'us-east-1',
    },
  };
}

function specFromIr(ir: DeployzIR): DeploymentSpecV2 {
  return deploymentSpecV2Schema.parse({
    schemaVersion: DEPLOYMENT_SPEC_V2_SCHEMA_VERSION,
    infraVersion: INFRA_VERSION_DYNAMIC_COMPILER_V2,
    graph: {
      schemaVersion: APPLICATION_GRAPH_SCHEMA_VERSION,
      applicationRoot: '.',
      buildArtifacts: [],
      workloads: [],
      resources: [],
      bindings: [],
      externalServices: [],
      unresolved: [],
    },
    ir,
    graphHash: 'graph-hash',
    irHash: 'ir-hash',
    capabilityRegistryVersion: DEFAULT_CAPABILITY_REGISTRY_VERSION,
    sizeProfileId: 'standard',
    compilerVersion: null,
    templateHash: null,
    artifactLocation: null,
    verificationContract: null,
    ownershipRecords: null,
    footprint: null,
    frozenAt: '2026-09-27T00:00:00.000Z',
  });
}

/** Same manifest shape plan.test.ts uses, for the parity assertion. */
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

describe('derivePlanComponentsFromSpec', () => {
  it('matches the manifest plan component kinds for postgres+redis+storage (shape parity)', () => {
    const spec = specFromIr(baseIr());
    const derived = derivePlanComponentsFromSpec(spec);
    const plan = buildInstallPlan({ manifest: manifestWith(true, true), region: 'us-east-1' });

    expect(derived.map((component) => component.kind)).toEqual(plan.components.map((component) => component.kind));
  });

  it('keeps IR component ids, labels and groups, and validates against the component schema', () => {
    const spec = specFromIr(baseIr());
    const derived = derivePlanComponentsFromSpec(spec);

    expect(derived.map((component) => component.componentId)).toEqual([
      'web',
      'endpoint',
      'primary-db',
      'uploads',
      'redis-cache',
    ]);
    expect(derived.map((component) => component.group)).toEqual([
      'application',
      'edge',
      'data',
      'storage',
      'cache',
    ]);
    expect(derived.map((component) => component.name)).toEqual([
      'Web',
      'Secure endpoint',
      'Primary DB',
      'Uploads',
      'Redis Cache',
    ]);
    expect(derived.map((component) => component.lifecycle)).toEqual([
      'delete',
      'delete',
      'retain',
      'retain',
      'delete',
    ]);
    for (const component of derived) {
      expect(deploymentPlanComponentSchema.parse(component)).toEqual(
        component as DeploymentPlanComponent,
      );
    }
  });

  it('is deterministic: two calls deep-equal', () => {
    const spec = specFromIr(baseIr());
    expect(derivePlanComponentsFromSpec(spec)).toEqual(derivePlanComponentsFromSpec(spec));
  });

  it('presents a MySQL database as a database in the data group, like PostgreSQL', () => {
    const ir = baseIr();
    ir.resources = [irResource('primary-db', CAPABILITY_KEYS.RDS_MYSQL, 'Primary DB', 'retain')];

    const db = derivePlanComponentsFromSpec(specFromIr(ir)).find((component) => component.componentId === 'primary-db');
    expect(db).toMatchObject({ kind: 'database', group: 'data', lifecycle: 'retain' });
  });

  it('never drops a resource with an unknown capability key — placeholder kind instead', () => {
    const ir = baseIr();
    ir.workloads = [];
    ir.ingress = { public: false, capabilityKey: null, targetWorkloadIds: [] };
    ir.resources = [irResource('jobs-queue', 'aws.sqs', 'Email queue', 'delete')];

    const derived = derivePlanComponentsFromSpec(specFromIr(ir));
    expect(derived).toHaveLength(1);
    expect(derived[0]).toMatchObject({
      componentId: 'jobs-queue',
      kind: UNKNOWN_PLAN_COMPONENT_KIND,
      name: 'Email queue',
      group: 'application',
    });
  });

  it('falls back to the IR workload kind when valid and the capability is unknown', () => {
    const ir = baseIr();
    ir.workloads = [
      {
        ...WORKLOAD,
        componentId: 'email-worker',
        kind: 'worker',
        label: 'Email Worker',
        compute: { ...WORKLOAD.compute, capabilityKey: 'aws.some-future-compute' },
      },
    ];
    ir.resources = [];
    ir.ingress = { public: false, capabilityKey: null, targetWorkloadIds: [] };

    const derived = derivePlanComponentsFromSpec(specFromIr(ir));
    expect(derived).toHaveLength(1);
    expect(derived[0].kind).toBe('worker');
    expect(derived[0].group).toBe('application');
  });
});
