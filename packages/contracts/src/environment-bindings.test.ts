import { describe, expect, it } from 'vitest';

import {
  applyEnvironmentBindings,
  environmentSettingsSchema,
  provisionedResources,
  validateEnvironmentSettings,
  type EnvironmentSetting,
} from './environment-setup.js';
import { deploymentManifestSchema, type DeploymentManifest } from './manifest.js';

const MANIFEST: DeploymentManifest = deploymentManifestSchema.parse({
  schemaVersion: 1,
  application: { root: '.', runtime: 'node', framework: null, dockerfilePath: 'Dockerfile' },
  build: { command: null, context: '.' },
  web: { command: 'node server.js', port: 3000 },
  health: { path: '/health' },
  database: {
    postgres: true,
    envBindings: [{ name: 'DATABASE_URL', kind: 'url' }],
    connectionUnverified: true,
  },
  redis: { required: true, envBindings: [{ name: 'REDIS_URL', kind: 'url' }] },
  storage: { required: false, envBindings: [] },
  migration: { command: null },
  worker: { command: null },
  environment: { variables: [] },
  externalServices: [],
  unsupported: [],
});

function mapped(key: string, resource: 'database' | 'cache' | 'storage', kind: string): EnvironmentSetting {
  return {
    key,
    stage: 'runtime',
    required: false,
    secret: false,
    provider: 'deployz',
    binding: { resource, kind } as EnvironmentSetting['binding'],
  };
}

describe('environment setting binding', () => {
  it('accepts a managed value for any valid key', () => {
    expect(environmentSettingsSchema.safeParse([mapped('GF_DATABASE_URL', 'database', 'url')]).success).toBe(true);
  });

  it('rejects a kind the resource does not have', () => {
    expect(environmentSettingsSchema.safeParse([mapped('X_BUCKET', 'database', 'bucket')]).success).toBe(false);
    expect(environmentSettingsSchema.safeParse([mapped('X_USER', 'cache', 'username')]).success).toBe(false);
    expect(environmentSettingsSchema.safeParse([mapped('X_URL', 'storage', 'url')]).success).toBe(false);
  });

  it('rejects a managed value for a provider other than deployz', () => {
    const setting = { ...mapped('X_URL', 'database', 'url'), provider: 'vendor' as const };
    expect(environmentSettingsSchema.safeParse([setting]).success).toBe(false);
  });

  it('rejects a managed value at build stage', () => {
    const setting = { ...mapped('X_URL', 'database', 'url'), stage: 'build' as const };
    expect(environmentSettingsSchema.safeParse([setting]).success).toBe(false);
  });

  it('rejects a managed value for a resource the manifest does not provision', () => {
    const problems = validateEnvironmentSettings(
      [mapped('X_BUCKET', 'storage', 'bucket')],
      new Set(),
      provisionedResources(MANIFEST),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('X_BUCKET');
  });

  it('allows a managed value for a provisioned resource on an undetected key', () => {
    expect(
      validateEnvironmentSettings([mapped('GF_DATABASE_URL', 'database', 'url')], new Set(), provisionedResources(MANIFEST)),
    ).toEqual([]);
  });
});

describe('applyEnvironmentBindings', () => {
  it('returns the manifest unchanged without mapped settings', () => {
    expect(applyEnvironmentBindings(MANIFEST, null)).toBe(MANIFEST);
  });

  it('appends mapped keys, skips duplicates and clears connectionUnverified', () => {
    const result = applyEnvironmentBindings(MANIFEST, [
      mapped('GF_DATABASE_URL', 'database', 'url'),
      mapped('DATABASE_URL', 'database', 'url'),
      mapped('GF_REDIS_HOST', 'cache', 'host'),
    ]);
    expect(result.database.envBindings).toEqual([
      { name: 'DATABASE_URL', kind: 'url' },
      { name: 'GF_DATABASE_URL', kind: 'url' },
    ]);
    expect(result.database).not.toHaveProperty('connectionUnverified');
    expect(result.redis.envBindings).toEqual([
      { name: 'REDIS_URL', kind: 'url' },
      { name: 'GF_REDIS_HOST', kind: 'host' },
    ]);
    expect(MANIFEST.database.connectionUnverified).toBe(true);
  });

  it('keeps connectionUnverified when only a non-database value is mapped', () => {
    const result = applyEnvironmentBindings(MANIFEST, [mapped('GF_REDIS_HOST', 'cache', 'host')]);
    expect(result.database.connectionUnverified).toBe(true);
  });

  it('ignores a value for a resource the manifest does not provision', () => {
    const result = applyEnvironmentBindings(MANIFEST, [mapped('X_BUCKET', 'storage', 'bucket')]);
    expect(result.storage.envBindings).toEqual([]);
  });
});
