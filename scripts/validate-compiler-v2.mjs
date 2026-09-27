// Validate the four dynamic-compiler-v2 topologies against real CloudFormation.
// Usage: node scripts/validate-compiler-v2.mjs
// Requires the compiler package to be built (pnpm --filter @deployz/infrastructure-compiler run build)
// and AWS credentials in the active profile.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compileDeployzInfrastructure } from '../packages/infrastructure-compiler/dist/index.js';
import { CAPABILITY_KEYS } from '../packages/contracts/dist/index.js';

function makeIr({ postgres, redis }) {
  const resources = [];
  if (postgres) {
    resources.push({
      componentId: 'primary-db', capabilityKey: CAPABILITY_KEYS.RDS_POSTGRES, label: 'PostgreSQL database',
      quantity: 1, configuration: {}, lifecycle: 'retain', scope: 'REGIONAL', envBindings: [],
    });
  }
  if (redis) {
    resources.push({
      componentId: 'cache', capabilityKey: CAPABILITY_KEYS.ELASTICACHE_VALKEY, label: 'Valkey cache',
      quantity: 1, configuration: {}, lifecycle: 'delete', scope: 'REGIONAL', envBindings: [],
    });
  }
  resources.push(
    { componentId: 'storage', capabilityKey: CAPABILITY_KEYS.S3, label: 'S3 bucket', quantity: 1, configuration: {}, lifecycle: 'retain', scope: 'REGIONAL', envBindings: [] },
    { componentId: 'endpoint', capabilityKey: CAPABILITY_KEYS.ALB, label: 'Application load balancer', quantity: 1, configuration: {}, lifecycle: 'delete', scope: 'REGIONAL', envBindings: [] },
  );
  return {
    schemaVersion: 1,
    workloads: [{
      componentId: 'web', kind: 'web', label: 'Web service', buildArtifactId: 'app', command: null, port: 3000,
      public: true, healthCheck: { path: '/health', mode: 'explicit' }, desiredCount: 1,
      compute: { provider: 'aws', capabilityKey: CAPABILITY_KEYS.ECS_FARGATE_SERVICE, cpuUnits: 256, memoryMiB: 512, sizeLabel: 'Small', architecture: null },
      dependencyCapabilityKeys: [...(postgres ? [CAPABILITY_KEYS.RDS_POSTGRES] : []), ...(redis ? [CAPABILITY_KEYS.ELASTICACHE_VALKEY] : []), CAPABILITY_KEYS.S3],
    }],
    resources,
    bindings: [],
    ingress: { public: true, capabilityKey: CAPABILITY_KEYS.ALB, targetWorkloadIds: ['web'] },
    schedules: [],
    policies: { allowTopologyChanges: false, defaultRetention: 'retain' },
    metadata: { graphSchemaVersion: 1, capabilityRegistryVersion: 'phase1-2026-09-25', sizeProfileId: 'small-v1', region: 'us-east-1' },
  };
}

const topologies = [
  { name: 'postgres', postgres: true, redis: false },
  { name: 'postgres-redis', postgres: true, redis: true },
  { name: 'stateless', postgres: false, redis: false },
  { name: 'stateless-redis', postgres: false, redis: true },
];

const dir = mkdtempSync(join(tmpdir(), 'deployz-v2-validate-'));
let failed = 0;

for (const t of topologies) {
  const { template } = compileDeployzInfrastructure({ ir: makeIr(t), region: 'us-east-1' });
  const file = join(dir, `${t.name}.json`);
  // Minified: validate-template's inline TemplateBody cap is 51,200 bytes
  // (production deploys the pretty template via S3 TemplateURL, which allows
  // ~460 KB). Structural validation does not need whitespace.
  writeFileSync(file, JSON.stringify(template));
  try {
    const out = execFileSync('aws', ['cloudformation', 'validate-template', '--template-body', `file://${file}`, '--region', 'us-east-1'], { encoding: 'utf8' });
    console.log(`PASS  ${t.name}: ${out.trim()}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  ${t.name}: ${e.stdout || ''} ${e.stderr || ''}`);
  }
}

rmSync(dir, { recursive: true, force: true });
if (failed > 0) {
  console.error(`${failed} topology(ies) failed validation`);
  process.exit(1);
}
console.log('All four topologies validate against CloudFormation.');
