import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEPLOYMENT_SIZING } from '@deployz/contracts';

/**
 * Guards the Deployment Footprint sizing table against the four committed
 * application templates: whatever `DEPLOYMENT_SIZING` says the UI shows is
 * exactly what CloudFormation provisions. No CDK synth here — a plain read
 * of the committed JSON, kept in sync with a fresh synth by
 * `artifacts.test.ts`. Reads `@deployz/contracts` from its dist: run
 * `pnpm --filter @deployz/contracts run build` after editing the sizing
 * table, or this test checks stale code.
 */

const here = dirname(fileURLToPath(import.meta.url));

interface CfnResource {
  readonly Type: string;
  readonly Properties: Readonly<Record<string, unknown>>;
}

interface CfnTemplate {
  readonly Resources: Readonly<Record<string, CfnResource>>;
}

function readTemplate(name: string): CfnTemplate {
  return JSON.parse(readFileSync(join(here, '..', 'artifacts', name), 'utf8')) as CfnTemplate;
}

const TEMPLATES = [
  'application-template-v1.json',
  'application-template-redis-v1.json',
  'application-template-stateless-v1.json',
  'application-template-stateless-redis-v1.json',
] as const;

/** The single ECS Fargate task definition in each committed template. */
function taskDefinition(template: CfnTemplate): CfnResource {
  const entries = Object.entries(template.Resources).filter(([, r]) => r.Type === 'AWS::ECS::TaskDefinition');
  expect(entries.length, 'exactly one task definition per committed template').toBe(1);
  return entries[0]![1];
}

describe('sizing parity between DEPLOYMENT_SIZING and the committed templates', () => {
  for (const file of TEMPLATES) {
    it(`${file}: web workload cpu/memory matches the sizing table`, () => {
      const task = taskDefinition(readTemplate(file));
      expect(task.Properties['Cpu']).toBe(String(DEPLOYMENT_SIZING.workload.web.cpuUnits));
      expect(task.Properties['Memory']).toBe(String(DEPLOYMENT_SIZING.workload.web.memoryMiB));
    });
  }

  for (const file of ['application-template-v1.json', 'application-template-redis-v1.json'] as const) {
    it(`${file}: database instance class, storage and engine version match the sizing table`, () => {
      const template = readTemplate(file);
      const db = Object.values(template.Resources).find((r) => r.Type === 'AWS::RDS::DBInstance');
      expect(db, 'a database instance is present').toBeDefined();
      expect(db!.Properties['DBInstanceClass']).toBe(DEPLOYMENT_SIZING.database.instanceType);
      expect(db!.Properties['AllocatedStorage']).toBe(String(DEPLOYMENT_SIZING.database.storageGb));
      expect(String(db!.Properties['EngineVersion'])).toMatch(
        new RegExp(`^${DEPLOYMENT_SIZING.database.engineVersion}\\b`),
      );
      expect(db!.Properties['Engine']).toBe(DEPLOYMENT_SIZING.database.engine);
    });
  }

  for (const file of ['application-template-redis-v1.json', 'application-template-stateless-redis-v1.json'] as const) {
    it(`${file}: cache node type and engine match the sizing table`, () => {
      const template = readTemplate(file);
      const cache = Object.values(template.Resources).find((r) => r.Type === 'AWS::ElastiCache::ReplicationGroup');
      expect(cache, 'a cache replication group is present').toBeDefined();
      expect(cache!.Properties['CacheNodeType']).toBe(DEPLOYMENT_SIZING.cache.nodeType);
      expect(cache!.Properties['Engine']).toBe(DEPLOYMENT_SIZING.cache.engine);
      expect(cache!.Properties['NumCacheClusters']).toBe(1);
    });
  }

  it('worker sizing matches the web tier the stack pins for the worker service', () => {
    // The committed generic templates carry no worker; the stack's worker
    // branch (application-stack.ts) builds its task definition from
    // DEPLOYMENT_SIZING.workload.worker. Pin that table entry to the same
    // tier the web workload uses so the two can never silently diverge.
    expect(DEPLOYMENT_SIZING.workload.worker).toEqual(DEPLOYMENT_SIZING.workload.web);
  });
});
