import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CAPABILITY_KEYS } from '@deployz/contracts';
import type { DeployzIR } from '@deployz/contracts';

import { compileDeployzInfrastructure } from './index.js';

// dynamic-compiler-v2 — capability-compositional, determinism, stable identity
// and stateful safety. The compiler composes the current capabilities from
// DeployzIR into a resolved AWS graph with stable semantic logical ids.

const here = dirname(fileURLToPath(import.meta.url));

// ── IR fixtures ──────────────────────────────────────────────────────────────

function makeIr(opts: { postgres: boolean; redis: boolean }): DeployzIR {
  const resources: DeployzIR['resources'] = [];
  if (opts.postgres) {
    resources.push({
      componentId: 'primary-db',
      capabilityKey: CAPABILITY_KEYS.RDS_POSTGRES,
      label: 'PostgreSQL database',
      quantity: 1,
      configuration: {},
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
          ...(opts.postgres ? [CAPABILITY_KEYS.RDS_POSTGRES] : []),
          ...(opts.redis ? [CAPABILITY_KEYS.ELASTICACHE_VALKEY] : []),
          CAPABILITY_KEYS.S3,
        ],
      },
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
