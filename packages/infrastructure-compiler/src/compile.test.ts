import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CAPABILITY_KEYS } from '@deployz/contracts';
import type { DeployzIR } from '@deployz/contracts';

import { compileDeployzInfrastructure } from './index.js';

// dynamic-compiler-v2 parity, determinism, stable identity and stateful
// safety. The committed runtime-v1 templates are the reference: the compiler
// must reproduce their resource graph (types + retention + parameters +
// outputs) from an equivalent DeployzIR, with stable semantic logical ids
// (an intentional improvement over CDK's auto-hashed ids).

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

// ── Reference templates ──────────────────────────────────────────────────────

interface CfnResource {
  readonly Type: string;
  readonly DeletionPolicy?: string;
  readonly UpdateReplacePolicy?: string;
}
interface CfnTemplate {
  readonly Parameters: Record<string, { Type: string; NoEcho: boolean }>;
  readonly Resources: Record<string, CfnResource>;
  readonly Outputs: Record<string, unknown>;
}

const TEMPLATES = [
  { file: 'application-template-v1.json', postgres: true, redis: false },
  { file: 'application-template-redis-v1.json', postgres: true, redis: true },
  { file: 'application-template-stateless-v1.json', postgres: false, redis: false },
  { file: 'application-template-stateless-redis-v1.json', postgres: false, redis: true },
] as const;

function readTemplate(file: string): CfnTemplate {
  return JSON.parse(readFileSync(join(here, '..', '..', 'cdk', 'artifacts', file), 'utf8')) as CfnTemplate;
}

function typeMultiset(resources: Record<string, CfnResource>): string[] {
  return Object.values(resources).map((r) => r.Type).sort();
}

/** The compiler template's resources (plain object). */
function compiledResources(template: Record<string, unknown>): Record<string, CfnResource> {
  return template['Resources'] as Record<string, CfnResource>;
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

  it('the valkey cache is stateless (deleted on stack delete), matching runtime-v1', () => {
    const { resolvedGraph } = compileDeployzInfrastructure({ ir: makeIr({ postgres: false, redis: true }), region: null });
    const cache = resolvedGraph.resources.find((r) => r.logicalId === 'CacheReplicationGroup');
    expect(cache).toBeDefined();
    expect(cache!.stateful).toBe(false);
    expect(cache!.deletionPolicy).toBe('Delete');
  });
});

describe('v1 ↔ v2 semantic parity', () => {
  for (const { file, postgres, redis } of TEMPLATES) {
    it(`${file}: identical resource types, parameters, outputs and retention`, () => {
      const reference = readTemplate(file);
      const compiled = compileDeployzInfrastructure({ ir: makeIr({ postgres, redis }), region: null });
      const resources = compiledResources(compiled.template);

      // Resource type multiset parity.
      expect(typeMultiset(resources)).toEqual(typeMultiset(reference.Resources));

      // Parameter parity (the compiler omits the CDK BootstrapVersion param).
      const refParams = Object.keys(reference.Parameters).filter((p) => p !== 'BootstrapVersion').sort();
      const compiledParams = Object.keys(compiled.template['Parameters'] as Record<string, unknown>).sort();
      expect(compiledParams).toEqual(refParams);

      // Output parity.
      expect(Object.keys(compiled.template['Outputs'] as Record<string, unknown>).sort()).toEqual(
        Object.keys(reference.Outputs).sort(),
      );

      // Retention parity: the retained (Retain) resources must match exactly,
      // by type. DeletionPolicy is emitted only for retained resources, so
      // counting Retain per type is the retention guarantee that must hold.
      const retainedByType = (entries: Record<string, CfnResource>): Record<string, number> => {
        const acc: Record<string, number> = {};
        for (const r of Object.values(entries)) {
          if (r.DeletionPolicy === 'Retain') acc[r.Type] = (acc[r.Type] ?? 0) + 1;
        }
        return acc;
      };
      expect(retainedByType(resources)).toEqual(retainedByType(reference.Resources));
    });
  }
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
