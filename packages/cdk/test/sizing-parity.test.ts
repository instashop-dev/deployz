import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CACHE_ENGINE,
  DATABASE_ENGINE,
  DATABASE_ENGINE_VERSION,
  defaultInfrastructureSizeProfile,
} from '@deployz/contracts';

/**
 * Guards the immutable size profile (`small-v1`) against the four committed
 * application templates: whatever the profile says the UI shows is exactly
 * what CloudFormation provisions. No CDK synth here — a plain read of the
 * committed JSON, kept in sync with a fresh synth by `artifacts.test.ts`.
 * Reads `@deployz/contracts` from its dist: run
 * `pnpm --filter @deployz/contracts run build` after editing the profile, or
 * this test checks stale code.
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

const PROFILE = defaultInfrastructureSizeProfile();

describe('sizing parity between the immutable size profile and the committed templates', () => {
  for (const file of TEMPLATES) {
    it(`${file}: web workload cpu/memory matches the profile`, () => {
      const task = taskDefinition(readTemplate(file));
      expect(task.Properties['Cpu']).toBe(String(PROFILE.workload.cpuUnits));
      expect(task.Properties['Memory']).toBe(String(PROFILE.workload.memoryMiB));
    });
  }

  for (const file of ['application-template-v1.json', 'application-template-redis-v1.json'] as const) {
    it(`${file}: database instance class, storage and engine version match the profile`, () => {
      const template = readTemplate(file);
      const db = Object.values(template.Resources).find((r) => r.Type === 'AWS::RDS::DBInstance');
      expect(db, 'a database instance is present').toBeDefined();
      expect(db!.Properties['DBInstanceClass']).toBe(PROFILE.database.instanceClass);
      expect(db!.Properties['AllocatedStorage']).toBe(String(PROFILE.database.storageGb));
      expect(String(db!.Properties['EngineVersion'])).toMatch(
        new RegExp(`^${DATABASE_ENGINE_VERSION}\\b`),
      );
      expect(db!.Properties['Engine']).toBe(DATABASE_ENGINE);
    });
  }

  for (const file of ['application-template-redis-v1.json', 'application-template-stateless-redis-v1.json'] as const) {
    it(`${file}: cache node type, count and engine match the profile`, () => {
      const template = readTemplate(file);
      const cache = Object.values(template.Resources).find((r) => r.Type === 'AWS::ElastiCache::ReplicationGroup');
      expect(cache, 'a cache replication group is present').toBeDefined();
      expect(cache!.Properties['CacheNodeType']).toBe(PROFILE.cache.nodeType);
      expect(cache!.Properties['Engine']).toBe(CACHE_ENGINE);
      expect(cache!.Properties['NumCacheClusters']).toBe(PROFILE.cache.nodeCount);
    });
  }

  it('the profile is the single published small-v1 and carries no engine', () => {
    expect(PROFILE.id).toBe('small');
    expect(PROFILE.version).toBe(1);
    expect(PROFILE.label).toBe('Small');
    expect(PROFILE.workload.desiredCount).toBe(1);
    expect(PROFILE.database.maxStorageGb).toBe(100);
    // Engines stay manifest-driven constants, not profile fields.
    expect(PROFILE).not.toHaveProperty('database.engine');
    expect(PROFILE).not.toHaveProperty('cache.engine');
  });
});
