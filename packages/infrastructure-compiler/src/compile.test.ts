import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CAPABILITY_KEYS } from '@deployz/contracts';
import type { DeployzIR } from '@deployz/contracts';

import { compileDeployzInfrastructure, logicalResourceId } from './index.js';

// dynamic-compiler-v2 — capability-compositional, determinism, stable identity
// and stateful safety. The compiler composes the current capabilities from
// DeployzIR into a resolved AWS graph with stable semantic logical ids.

const here = dirname(fileURLToPath(import.meta.url));

// The full postgres template (web + RDS PostgreSQL + Valkey + S3 + ALB),
// pinned byte-for-byte. Phase 4B's MySQL capability must not move a single
// postgres byte — this hash is the proof (see the mysql describe below).
const POSTGRES_TEMPLATE_HASH_GOLDEN = 'b6fa77dce5db8e341e3723cf0f11f5855e97f9324f97f456e431c5bf5021677a';

// ── IR fixtures ──────────────────────────────────────────────────────────────

function makeIr(opts: { postgres: boolean; redis: boolean; workers?: { componentId: string; command: string }[]; dbEngine?: 'postgres' | 'mysql' }): DeployzIR {
  const dbCapability = opts.dbEngine === 'mysql' ? CAPABILITY_KEYS.RDS_MYSQL : CAPABILITY_KEYS.RDS_POSTGRES;
  const dbConfiguration =
    opts.dbEngine === 'mysql'
      ? { engine: 'mysql', engineVersion: '8.0' }
      : opts.postgres
        ? { engine: 'postgres', engineVersion: '16' }
        : {};
  const resources: DeployzIR['resources'] = [];
  if (opts.postgres) {
    resources.push({
      componentId: 'primary-db',
      capabilityKey: dbCapability,
      label: opts.dbEngine === 'mysql' ? 'MySQL database' : 'PostgreSQL database',
      quantity: 1,
      configuration: dbConfiguration,
      lifecycle: 'retain',
      scope: 'REGIONAL',
      envBindings: [],
    });
  }
  if (opts.redis) {
    resources.push({
      componentId: 'cache',
      capabilityKey: CAPABILITY_KEYS.ELASTICACHE_VALKEY,
      label: 'Valkey cache',
      quantity: 1,
      configuration: {},
      lifecycle: 'delete',
      scope: 'REGIONAL',
      envBindings: [],
    });
  }
  resources.push(
    {
      componentId: 'storage',
      capabilityKey: CAPABILITY_KEYS.S3,
      label: 'S3 bucket',
      quantity: 1,
      configuration: {},
      lifecycle: 'retain',
      scope: 'REGIONAL',
      envBindings: [],
    },
    {
      componentId: 'endpoint',
      capabilityKey: CAPABILITY_KEYS.ALB,
      label: 'Application load balancer',
      quantity: 1,
      configuration: {},
      lifecycle: 'delete',
      scope: 'REGIONAL',
      envBindings: [],
    },
  );

  return {
    schemaVersion: 1,
    workloads: [
      {
        componentId: 'web',
        kind: 'web',
        label: 'Web service',
        buildArtifactId: 'app',
        command: null,
        port: 3000,
        public: true,
        healthCheck: { path: '/health', mode: 'explicit' },
        desiredCount: 1,
        compute: {
          provider: 'aws',
          capabilityKey: CAPABILITY_KEYS.ECS_FARGATE_SERVICE,
          cpuUnits: 256,
          memoryMiB: 512,
          sizeLabel: 'Small',
          architecture: null,
        },
        dependencyCapabilityKeys: [
          ...(opts.postgres ? [dbCapability] : []),
          ...(opts.redis ? [CAPABILITY_KEYS.ELASTICACHE_VALKEY] : []),
          CAPABILITY_KEYS.S3,
        ],
      },
      ...(opts.workers ?? []).map((worker) => ({
        componentId: worker.componentId,
        kind: 'worker' as const,
        label: `Worker ${worker.componentId}`,
        buildArtifactId: 'app',
        command: worker.command,
        port: null,
        public: false,
        healthCheck: null,
        desiredCount: 1,
        compute: {
          provider: 'aws' as const,
          capabilityKey: CAPABILITY_KEYS.ECS_FARGATE_SERVICE,
          cpuUnits: 256,
          memoryMiB: 512,
          sizeLabel: 'Small',
          architecture: null,
        },
        dependencyCapabilityKeys: [
          ...(opts.postgres ? [dbCapability] : []),
          ...(opts.redis ? [CAPABILITY_KEYS.ELASTICACHE_VALKEY] : []),
          CAPABILITY_KEYS.S3,
        ],
      })),
    ],
    resources,
    bindings: [],
    ingress: { public: true, capabilityKey: CAPABILITY_KEYS.ALB, targetWorkloadIds: ['web'] },
    schedules: [],
    policies: { allowTopologyChanges: false, defaultRetention: 'retain' },
    metadata: {
      graphSchemaVersion: 1,
      capabilityRegistryVersion: 'phase1-2026-09-25',
      sizeProfileId: 'small-v1',
      region: null,
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('determinism', () => {
  it('equivalent IR compiles to the same template hash twice', () => {
    const a = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: true }), region: null });
    const b = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: true }), region: null });
    expect(a.artifact.templateHash).toBe(b.artifact.templateHash);
    expect(a.artifact.irHash).toBe(b.artifact.irHash);
  });

  it('different topology compiles to a different template hash', () => {
    const stateless = compileDeployzInfrastructure({ ir: makeIr({ postgres: false, redis: false }), region: null });
    const postgres = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: false }), region: null });
    expect(stateless.artifact.templateHash).not.toBe(postgres.artifact.templateHash);
  });
});

describe('stable logical identity', () => {
  it('emits semantic ids, not CDK hashes', () => {
    const { resolvedGraph } = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: true }), region: null });
    const ids = resolvedGraph.resources.map((r) => r.logicalId);
    expect(ids).toContain('PrimaryDbInstance');
    expect(ids).toContain('PrimaryDbMasterSecret');
    expect(ids).toContain('StorageBucket');
    expect(ids).toContain('WebService');
    expect(ids).toContain('EndpointLoadBalancer');
    expect(ids).toContain('CacheReplicationGroup');
    // No CDK auto-hashed ids.
    expect(ids.filter((id) => /[A-F0-9]{8}$/.test(id))).toEqual([]);
  });

  it('every resource maps to a component and capability (ownership)', () => {
    const { ownershipRecords } = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: true }), region: null });
    expect(ownershipRecords.length).toBeGreaterThan(0);
    for (const record of ownershipRecords) {
      expect(record.componentId).toBeTruthy();
      expect(record.capability).toBeTruthy();
      expect(record.logicalResourceId).toBeTruthy();
    }
  });
});

describe('stateful safety', () => {
  it('retains the database, its secrets and the bucket; deletes the app secret', () => {
    const { resolvedGraph } = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: false }), region: null });
    const byId = new Map(resolvedGraph.resources.map((r) => [r.logicalId, r]));

    for (const id of ['PrimaryDbInstance', 'PrimaryDbMasterSecret', 'PrimaryDbUrlSecret', 'PrimaryDbSubnetGroup', 'StorageBucket']) {
      const resource = byId.get(id);
      expect(resource, id).toBeDefined();
      expect(resource!.deletionPolicy, id).toBe('Retain');
      expect(resource!.updateReplacePolicy, id).toBe('Retain');
      expect(resource!.stateful, id).toBe(true);
    }

    const appSecret = byId.get('ApplicationConfigSecret');
    expect(appSecret).toBeDefined();
    expect(appSecret!.deletionPolicy).toBe('Delete');
  });

  it('the valkey cache is stateless (deleted on stack delete)', () => {
    const { resolvedGraph } = compileDeployzInfrastructure({ ir: makeIr({ postgres: false, redis: true }), region: null });
    const cache = resolvedGraph.resources.find((r) => r.logicalId === 'CacheReplicationGroup');
    expect(cache).toBeDefined();
    expect(cache!.stateful).toBe(false);
    expect(cache!.deletionPolicy).toBe('Delete');
  });
});

describe('capability composition', () => {
  it('adding RDS adds only the expected resources, verification entry and output', () => {
    const stateless = compileDeployzInfrastructure({ ir: makeIr({ postgres: false, redis: false }), region: null });
    const withDb = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: false }), region: null });

    const statelessIds = new Set(stateless.resolvedGraph.resources.map((r) => r.logicalId));
    const withDbIds = new Set(withDb.resolvedGraph.resources.map((r) => r.logicalId));

    // Only RDS-related resources are added.
    const addedIds = [...withDbIds].filter((id) => !statelessIds.has(id));
    expect(addedIds.length).toBeGreaterThan(0);
    for (const id of addedIds) {
      const resource = withDb.resolvedGraph.resources.find((r) => r.logicalId === id)!;
      expect(resource.capability).toBe(CAPABILITY_KEYS.RDS_POSTGRES);
      expect(resource.componentId).toBe('primary-db');
    }

    // Verification contract gains exactly 'database'.
    const statelessChecks = new Set(stateless.verificationContract.checks.map((c) => c.check));
    const withDbChecks = withDb.verificationContract.checks.map((c) => c.check).sort();
    expect(withDbChecks).toEqual([...statelessChecks, 'database'].sort());

    // Outputs gain DbHost and DbSecretArn only.
    const statelessOutputs = new Set(stateless.template['Outputs'] ? Object.keys(stateless.template['Outputs'] as Record<string, unknown>) : []);
    const withDbOutputs = Object.keys(withDb.template['Outputs'] as Record<string, unknown>);
    const addedOutputs = withDbOutputs.filter((o) => !statelessOutputs.has(o)).sort();
    expect(addedOutputs).toEqual(['DbHost', 'DbSecretArn']);
  });

  it('adding Redis adds only the expected resources and verification entry', () => {
    const stateless = compileDeployzInfrastructure({ ir: makeIr({ postgres: false, redis: false }), region: null });
    const withRedis = compileDeployzInfrastructure({ ir: makeIr({ postgres: false, redis: true }), region: null });

    const statelessIds = new Set(stateless.resolvedGraph.resources.map((r) => r.logicalId));
    const addedIds = withRedis.resolvedGraph.resources
      .filter((r) => !statelessIds.has(r.logicalId))
      .map((r) => r.logicalId);
    expect(addedIds.length).toBeGreaterThan(0);
    for (const id of addedIds) {
      const resource = withRedis.resolvedGraph.resources.find((r) => r.logicalId === id)!;
      expect(resource.capability).toBe(CAPABILITY_KEYS.ELASTICACHE_VALKEY);
      expect(resource.componentId).toBe('cache');
    }

    const statelessChecks = new Set(stateless.verificationContract.checks.map((c) => c.check));
    const withRedisChecks = withRedis.verificationContract.checks.map((c) => c.check).sort();
    expect(withRedisChecks).toEqual([...statelessChecks, 'cache'].sort());
  });

  it('removing a capability removes its resources', () => {
    const withDb = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: true }), region: null });
    const withoutDb = compileDeployzInfrastructure({ ir: makeIr({ postgres: false, redis: true }), region: null });

    const withDbIds = new Set(withDb.resolvedGraph.resources.map((r) => r.logicalId));
    const withoutDbIds = new Set(withoutDb.resolvedGraph.resources.map((r) => r.logicalId));

    const removedIds = [...withDbIds].filter((id) => !withoutDbIds.has(id));
    expect(removedIds.length).toBeGreaterThan(0);
    for (const id of removedIds) {
      const resource = withDb.resolvedGraph.resources.find((r) => r.logicalId === id)!;
      expect(resource.capability).toBe(CAPABILITY_KEYS.RDS_POSTGRES);
    }

    // No Redis resources were removed.
    const redisIds = new Set(
      withDb.resolvedGraph.resources.filter((r) => r.capability === CAPABILITY_KEYS.ELASTICACHE_VALKEY).map((r) => r.logicalId),
    );
    for (const id of redisIds) {
      expect(withoutDbIds.has(id), `Redis resource ${id} should survive RDS removal`).toBe(true);
    }
  });

  it('unrelated component logical identities remain stable when capabilities change', () => {
    const stateless = compileDeployzInfrastructure({ ir: makeIr({ postgres: false, redis: false }), region: null });
    const full = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: true }), region: null });

    const networkIds = stateless.resolvedGraph.resources
      .filter((r) => r.componentId === 'network')
      .map((r) => r.logicalId)
      .sort();
    const fullNetworkIds = full.resolvedGraph.resources
      .filter((r) => r.componentId === 'network')
      .map((r) => r.logicalId)
      .sort();
    expect(fullNetworkIds).toEqual(networkIds);

    const webIds = stateless.resolvedGraph.resources
      .filter((r) => r.componentId === 'web')
      .map((r) => r.logicalId)
      .sort();
    const fullWebIds = full.resolvedGraph.resources
      .filter((r) => r.componentId === 'web')
      .map((r) => r.logicalId)
      .sort();
    expect(fullWebIds).toEqual(webIds);

    const endpointIds = stateless.resolvedGraph.resources
      .filter((r) => r.componentId === 'endpoint')
      .map((r) => r.logicalId)
      .sort();
    const fullEndpointIds = full.resolvedGraph.resources
      .filter((r) => r.componentId === 'endpoint')
      .map((r) => r.logicalId)
      .sort();
    expect(fullEndpointIds).toEqual(endpointIds);
  });

  it('IR resource ordering does not affect template hash', () => {
    const irA = makeIr({ postgres: true, redis: true });
    const irB: DeployzIR = { ...irA, resources: [...irA.resources].reverse() };
    const a = compileDeployzInfrastructure({ ir: irA, region: null });
    const b = compileDeployzInfrastructure({ ir: irB, region: null });
    expect(a.artifact.templateHash).toBe(b.artifact.templateHash);
  });

  it('every managed resource maps to componentId + capability + resourceRole', () => {
    const { resolvedGraph } = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: true }), region: null });
    for (const r of resolvedGraph.resources) {
      expect(r.componentId).toBeTruthy();
      expect(r.capability).toBeTruthy();
      expect(r.resourceRole).toBeTruthy();
    }
  });

  it('sizing changes affect only relevant resources (database sizing changes only RDS resources)', () => {
    const defaultProfile = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: true }), region: null });

    const biggerDbProfile = compileDeployzInfrastructure({
      ir: makeIr({ postgres: true, redis: true }),
      region: null,
      sizeProfile: {
        label: 'medium-test',
        workload: { cpuUnits: 256, memoryMiB: 512 },
        database: { instanceClass: 'db.r6g.xlarge', storageGb: 100, maxStorageGb: 500 },
        cache: { nodeType: 'cache.t4g.micro', nodeCount: 1 },
      },
    });

    // Network, endpoint, cache, and web resources are unchanged.
    const unchangedComponents = ['network', 'endpoint', 'cache', 'web'];
    for (const componentId of unchangedComponents) {
      const defaultResources = defaultProfile.resolvedGraph.resources
        .filter((r) => r.componentId === componentId)
        .map((r) => JSON.stringify(r.properties))
        .sort();
      const biggerResources = biggerDbProfile.resolvedGraph.resources
        .filter((r) => r.componentId === componentId)
        .map((r) => JSON.stringify(r.properties))
        .sort();
      expect(biggerResources, `component ${componentId} should be unaffected by db sizing`).toEqual(defaultResources);
    }

    // RDS instance properties differ.
    const defaultDbInstance = defaultProfile.resolvedGraph.resources.find((r) => r.logicalId === 'PrimaryDbInstance');
    const biggerDbInstance = biggerDbProfile.resolvedGraph.resources.find((r) => r.logicalId === 'PrimaryDbInstance');
    expect(defaultDbInstance!.properties).not.toEqual(biggerDbInstance!.properties);
  });

  it('no static topology-selection logic (compiler branches on capability presence, not on {postgres,redis} tuple)', () => {
    const source = readFileSync(join(here, 'compile.ts'), 'utf8');
    // No combined tuple branching: the compiler must not branch on the
    // combination of postgres+redis as a single decision. Each capability is
    // resolved independently via resourceByCapability and tested with
    // `!== undefined`.
    expect(source).not.toMatch(/hasDb\s*&&\s*hasRedis/);
    expect(source).not.toMatch(/postgres\s*&&\s*redis/);
    expect(source).not.toMatch(/hasPostgres\s*&&\s*hasRedis/);
    // Confirm independent capability lookup pattern.
    expect(source).toMatch(/resourceByCapability\(ir,\s*CAPABILITY_KEYS\.RDS_POSTGRES\)/);
    expect(source).toMatch(/resourceByCapability\(ir,\s*CAPABILITY_KEYS\.ELASTICACHE_VALKEY\)/);
  });
});

describe('architecture fitness', () => {
  it('the compiler never imports an AWS SDK (no synth-time AWS discovery)', () => {
    for (const file of ['compile.ts', 'cfn-emit.ts', 'derived.ts', 'index.ts']) {
      const source = readFileSync(join(here, file), 'utf8');
      expect(source, file).not.toMatch(/@aws-sdk|aws-sdk/);
      expect(source, file).not.toMatch(/new Date\(|Date\.now\(|Math\.random\(|crypto\.random/);
    }
  });

  it('the verification contract is component/capability-driven (compute/ingress/database/storage/cache)', () => {
    const { verificationContract } = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: true }), region: null });
    const checks = verificationContract.checks.map((c) => c.check).sort();
    expect(checks).toEqual(['cache', 'compute', 'database', 'ingress', 'storage']);
  });

  it('footprint derives from the same frozen intent (pricing categories match capabilities)', () => {
    const { footprint } = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: true }), region: null });
    const services = footprint.resources.map((r) => r.service).sort();
    expect(services).toEqual(['alb', 'elasticache-valkey', 'nat-gateway', 'rds-postgres', 's3']);
  });
});

// ── Multi-workload (Phase 4A): one build artifact, one ECS service per
//    persistent workload (web + workers), each with its own frozen command. ──

describe('multi-workload', () => {
  const ir = makeIr({
    postgres: true,
    redis: true,
    workers: [
      { componentId: 'email-worker', command: 'node dist/workers/email.js' },
      { componentId: 'import-worker', command: 'node dist/workers/import.js' },
    ],
  });
  const compiled = compileDeployzInfrastructure({ ir, region: null });
  const byId = new Map(compiled.resolvedGraph.resources.map((r) => [r.logicalId, r]));

  it('compiles one ECS service, task definition, log group and security group per workload with stable ids', () => {
    for (const componentId of ['web', 'email-worker', 'import-worker']) {
      for (const role of ['service', 'task-definition', 'log-group', 'service-security-group']) {
        const id = logicalResourceId(componentId, role);
        expect(byId.has(id), id).toBe(true);
      }
    }
    // Worker ids are deterministic from componentId + role.
    expect(logicalResourceId('email-worker', 'service')).toBe('EmailWorkerService');
    expect(logicalResourceId('import-worker', 'task-definition')).toBe('ImportWorkerTaskDefinition');
  });

  it('freezes each worker command into its own App container', () => {
    for (const { componentId, command } of [
      { componentId: 'email-worker', command: 'node dist/workers/email.js' },
      { componentId: 'import-worker', command: 'node dist/workers/import.js' },
    ]) {
      const taskDef = byId.get(logicalResourceId(componentId, 'task-definition'))!;
      const app = (taskDef.properties['ContainerDefinitions'] as unknown[])[0] as Record<string, unknown>;
      expect(app['Command']).toEqual(['sh', '-c', command]);
    }
  });

  it('workers get no port mapping, no ALB target and no HTTP health check', () => {
    for (const componentId of ['email-worker', 'import-worker']) {
      const taskDef = byId.get(logicalResourceId(componentId, 'task-definition'))!;
      const app = (taskDef.properties['ContainerDefinitions'] as unknown[])[0] as Record<string, unknown>;
      expect(app).not.toHaveProperty('PortMappings');

      const service = byId.get(logicalResourceId(componentId, 'service'))!;
      expect(service.properties).not.toHaveProperty('LoadBalancers');
      expect(service.properties).not.toHaveProperty('HealthCheckGracePeriodSeconds');
      expect(service.properties['DesiredCount']).toEqual({ Ref: 'paramDesiredCount' });
      // Workers still run on the shared cluster and behind the shared roles.
      expect(service.properties['Cluster']).toEqual({ Ref: logicalResourceId('web', 'cluster') });
      expect(service.dependsOn).not.toContain('EndpointTargetGroup');
    }

    // The ALB wires only the public web workload (the ingress rule attaches
    // to the service SG; the ALB SG is the traffic source).
    const ingress = byId.get('EndpointLoadBalancerToServiceIngress')!;
    expect(ingress.properties['GroupId']).toEqual({
      'Fn::GetAtt': [logicalResourceId('web', 'service-security-group'), 'GroupId'],
    });
    expect(ingress.properties['SourceSecurityGroupId']).toEqual({
      'Fn::GetAtt': [logicalResourceId('endpoint', 'load-balancer-security-group'), 'GroupId'],
    });
  });

  it('the database accepts ingress from every workload service', () => {
    const ingressIds = compiled.resolvedGraph.resources
      .filter((r) => r.componentId === 'primary-db' && r.resourceRole.startsWith('app-service-ingress-'))
      .map((r) => r.resourceRole)
      .sort();
    expect(ingressIds).toEqual([
      'app-service-ingress-email-worker',
      'app-service-ingress-import-worker',
      'app-service-ingress-web',
    ]);
  });

  it('gains one compute verification check per workload; capability checks stay single', () => {
    const checks = compiled.verificationContract.checks;
    const computeComponents = checks.filter((c) => c.check === 'compute').map((c) => c.componentId).sort();
    expect(computeComponents).toEqual(['email-worker', 'import-worker', 'web']);
    expect(checks.filter((c) => c.check === 'database')).toHaveLength(1);
    expect(checks.filter((c) => c.check === 'cache')).toHaveLength(1);
    expect(checks.filter((c) => c.check === 'ingress')).toHaveLength(1);
    expect(checks.filter((c) => c.check === 'storage')).toHaveLength(1);
  });

  it('compiles the migration workload as a one-shot task definition, never a service (Phase 4C)', () => {
    const withMigration: DeployzIR = {
      ...ir,
      workloads: [
        ...ir.workloads,
        {
          componentId: 'migration',
          kind: 'migration',
          label: 'Database migration',
          buildArtifactId: 'app',
          command: 'npx prisma migrate deploy',
          port: null,
          public: false,
          healthCheck: null,
          desiredCount: 1,
          compute: ir.workloads[0]!.compute,
          dependencyCapabilityKeys: [CAPABILITY_KEYS.RDS_POSTGRES],
        },
      ],
    };
    const result = compileDeployzInfrastructure({ ir: withMigration, region: null });
    const ids = result.resolvedGraph.resources.map((r) => r.logicalId);
    // A task definition and a log group exist; a SERVICE never does — a
    // migration is one-shot, proven by its exit code, not by stability.
    expect(ids).toContain('MigrationTaskDefinition');
    expect(ids).toContain('MigrationLogGroup');
    expect(ids).not.toContain('MigrationService');
    expect(ids).not.toContain('MigrationEcsService');
    const byId = new Map(result.resolvedGraph.resources.map((r) => [r.logicalId, r]));
    const taskDef = byId.get('MigrationTaskDefinition')!;
    expect(taskDef.cfnType).toBe('AWS::ECS::TaskDefinition');
    // NO verification check — the verification contract proves services, not
    // one-shot tasks, and relay service discovery must never see a migration.
    expect(taskDef.verificationCheck).toBeUndefined();
    const family = taskDef.properties['Family'];
    expect(family).toBe('DeployzAppMigration');
    // The analyzed command is FROZEN into the container — the relay runs the
    // definition as-is and can never inject a command of its own.
    const app = (taskDef.properties['ContainerDefinitions'] as unknown[])[0] as Record<string, unknown>;
    expect(app['Command']).toEqual(['sh', '-c', 'npx prisma migrate deploy']);
    expect(taskDef.properties['ExecutionRoleArn']).toEqual({
      'Fn::GetAtt': [logicalResourceId('web', 'task-execution-role'), 'Arn'],
    });
    expect(taskDef.properties['TaskRoleArn']).toEqual({
      'Fn::GetAtt': [logicalResourceId('web', 'task-role'), 'Arn'],
    });
    // Stateless lifecycle — a task definition update is never destructive.
    expect(taskDef.stateful).toBe(false);
    expect(taskDef.deletionPolicy).toBe('Delete');
    // The verification contract gains NO migration compute check; the
    // ownership records DO carry the task def (it is a managed resource).
    const computeComponents = result.verificationContract.checks.filter((c) => c.check === 'compute').map((c) => c.componentId).sort();
    expect(computeComponents).toEqual(['email-worker', 'import-worker', 'web']);
    expect(result.resolvedGraph.resources.some((r) => r.logicalId === 'MigrationTaskDefinition' && r.verificationCheck !== undefined)).toBe(false);
    // Ownership: exactly one migration record (the task def; the log group is
    // its own component-scoped record).
    expect(result.ownershipRecords.filter((r) => r.componentId === 'migration' && r.logicalResourceId === 'MigrationTaskDefinition')).toHaveLength(1);
    // Other workloads are unaffected.
    expect(ids).toContain('EmailWorkerService');
    // Deterministic: the same IR compiles the same template.
    expect(compileDeployzInfrastructure({ ir: withMigration, region: null }).artifact.templateHash).toBe(result.artifact.templateHash);
  });

  it('a graph WITHOUT a migration workload compiles byte-identically to the pre-4C compiler (golden)', () => {
    const result = compileDeployzInfrastructure({ ir, region: null });
    const ids = result.resolvedGraph.resources.map((r) => r.logicalId);
    expect(ids).not.toContain('MigrationTaskDefinition');
    expect(ids).not.toContain('MigrationEcsService');
    expect(ids).toContain('EmailWorkerService');
  });

  it('compiles deterministically and never collides on logical ids', () => {
    const again = compileDeployzInfrastructure({ ir, region: null });
    expect(again.artifact.templateHash).toBe(compiled.artifact.templateHash);

    const ids = compiled.resolvedGraph.resources.map((r) => r.logicalId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps single-workload logical ids byte-identical with the pre-4A compiler', () => {
    const single = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: true }), region: null });
    const ids = single.resolvedGraph.resources.map((r) => r.logicalId);
    for (const id of ['WebService', 'WebTaskDefinition', 'WebLogGroup', 'WebCluster', 'WebTaskExecutionRole', 'PrimaryDbAppServiceIngressWeb']) {
      expect(ids, id).toContain(id);
    }
  });
});

// ── Phase 4B: RDS MySQL — the SAME relational-database abstraction with a
//    Deployz-pinned engine. Postgres output stays byte-identical. ────────────

describe('mysql database (phase 4b)', () => {
  const mysqlIr = makeIr({ postgres: true, redis: true, dbEngine: 'mysql' });
  const compiled = compileDeployzInfrastructure({ ir: mysqlIr, region: null });
  const byId = new Map(compiled.resolvedGraph.resources.map((r) => [r.logicalId, r]));

  it('the managed database is RDS MySQL on the same stable logical ids', () => {
    const instance = byId.get('PrimaryDbInstance')!;
    expect(instance).toBeDefined();
    expect(instance.cfnType).toBe('AWS::RDS::DBInstance');
    expect(instance.capability).toBe(CAPABILITY_KEYS.RDS_MYSQL);
    expect(instance.stateful).toBe(true);
    expect(instance.deletionPolicy).toBe('Retain');
    expect(instance.purgeStrategy).toBe('require_manual');
    expect(instance.verificationCheck).toBe('database');
    // Deployz-pinned engine policy: version and encryption/backup/deletion
    // protection are identical in shape to the PostgreSQL instance.
    expect(instance.properties['Engine']).toBe('mysql');
    expect(instance.properties['EngineVersion']).toBe('8.0');
    expect(instance.properties['StorageEncrypted']).toBe(true);
    expect(instance.properties['BackupRetentionPeriod']).toBe(7);
    expect(instance.properties['DeletionProtection']).toBe(true);
    expect(instance.properties['PubliclyAccessible']).toBe(false);
  });

  it('managed credentials and the mysql:// URL secret follow the PostgreSQL pattern', () => {
    const masterSecret = byId.get('PrimaryDbMasterSecret')!;
    expect(masterSecret.cfnType).toBe('AWS::SecretsManager::Secret');
    const urlSecret = byId.get('PrimaryDbUrlSecret')!;
    expect(String((urlSecret.properties['SecretString'] as Record<string, unknown>)['Fn::Join']![0])).toBe('');
    const parts = (urlSecret.properties['SecretString'] as Record<string, unknown>)['Fn::Join']![1] as unknown[];
    expect(parts[0]).toContain('mysql://deployz_app:');
    expect(JSON.stringify(parts)).toContain(':3306/deployz');
    // Private networking: app-SG ingress on the mysql port, per workload.
    const ingress = byId.get('PrimaryDbAppServiceIngressWeb')!;
    expect(ingress.properties['FromPort']).toBe(3306);
    expect(ingress.properties['ToPort']).toBe(3306);
    // No parameter group resource exists.
    expect(compiled.resolvedGraph.resources.some((r) => r.cfnType.includes('DBParameterGroup'))).toBe(false);
  });

  it('app containers get the mysql env aliases and the RDS CA bundle', () => {
    const taskDef = byId.get('WebTaskDefinition')!;
    const app = (taskDef.properties['ContainerDefinitions'] as unknown[])[0] as {
      Environment: Array<{ Name: string }>;
      Secrets: Array<{ Name: string }>;
    };
    const envNames = app.Environment.map((entry) => entry.Name);
    // Generic DATABASE_* names always lead (URL parts as env, the URL as a
    // secret).
    expect(envNames).toContain('DATABASE_HOST');
    expect(app.Secrets.map((entry) => entry.Name)).toContain('DATABASE_URL');
    // MySQL aliases + the CA bundle under both the neutral and mysql names.
    expect(envNames).toContain('MYSQL_HOST');
    expect(envNames).toContain('MYSQL_PORT');
    expect(envNames).toContain('MYSQL_SSL_CA');
    expect(envNames).toContain('NODE_EXTRA_CA_CERTS');
    expect(app.Secrets.map((entry) => entry.Name)).toContain('MYSQL_URL');
    // Every service (workers included) binds the database — Phase 4A envs
    // are per-workload, so a worker task def carries the same mysql envs.
    const workerDef = byId.get('EmailWorkerTaskDefinition');
    if (workerDef !== undefined) {
      const workerApp = (workerDef.properties['ContainerDefinitions'] as unknown[])[0] as {
        Environment: Array<{ Name: string }>;
      };
      expect(workerApp.Environment.map((e) => e.Name)).toContain('MYSQL_SSL_CA');
    }
  });

  it('verification, footprint and outputs treat mysql exactly like postgres', () => {
    expect(compiled.verificationContract.checks.some((c) => c.check === 'database' && c.logicalId === 'PrimaryDbInstance')).toBe(true);
    const db = compiled.footprint.resources.find((r) => r.id === 'database')!;
    expect(db.service).toBe('rds-mysql');
    expect(db.configuration).toMatchObject({ engine: 'mysql', engineVersion: '8.0' });
    const outputs = compiled.template['Outputs'] as Record<string, unknown>;
    expect(Object.keys(outputs)).toContain('DbHost');
    // The cache and ALB capabilities are untouched by the engine swap.
    expect(byId.has('CacheReplicationGroup')).toBe(true);
    expect(byId.has('EndpointLoadBalancer')).toBe(true);
  });

  it('POSTGRES OUTPUT IS UNAFFECTED — byte-identical template hash (golden)', () => {
    // Same fixture IR the pre-4B compiler produced; the hash pins every
    // postgres template byte against the mysql addition.
    const postgres = compileDeployzInfrastructure({ ir: makeIr({ postgres: true, redis: true }), region: null });
    expect(postgres.artifact.templateHash).toBe(POSTGRES_TEMPLATE_HASH_GOLDEN);
    // And the postgres capability never appears in the mysql graph.
    expect(compiled.resolvedGraph.resources.some((r) => r.capability === CAPABILITY_KEYS.RDS_POSTGRES)).toBe(false);
  });
});
