import { describe, expect, it } from 'vitest';

import {
  deploymentManifestOverridesSchema,
  deploymentManifestSchema,
  manifestEnvBindingSchema,
  manifestReadinessResultSchema,
} from './manifest.js';

const READY_MANIFEST = {
  application: {
    root: '.',
    runtime: 'node',
    framework: 'express',
    dockerfilePath: 'Dockerfile',
  },
  build: { command: 'npm run build', context: '.' },
  web: { command: 'npm start', port: 3000 },
  health: { path: '/health' },
  database: { postgres: true },
  redis: { required: true, envBindings: [{ name: 'REDIS_URL', kind: 'url' }] },
  storage: { required: false, envBindings: [] },
  migration: { command: 'npm run db:migrate' },
  worker: { command: null },
  environment: { variables: ['DATABASE_URL'] },
  externalServices: ['stripe'],
  unsupported: [],
} as const;

describe('deploymentManifestSchema', () => {
  it('parses a complete manifest and round-trips its wire form', () => {
    const parsed = deploymentManifestSchema.parse(READY_MANIFEST);
    expect(parsed).toEqual(READY_MANIFEST);
  });

  it('accepts the config-incomplete shape (nulls the detector can honestly miss)', () => {
    const parsed = deploymentManifestSchema.parse({
      ...READY_MANIFEST,
      application: { root: '.', runtime: 'unknown', framework: null, dockerfilePath: null },
      build: { command: null, context: '.' },
      web: { command: null, port: null },
      redis: { required: false, envBindings: [] },
    });
    expect(parsed.application.dockerfilePath).toBeNull();
    expect(parsed.web.port).toBeNull();
  });

  it('rejects unknown top-level keys', () => {
    expect(() =>
      deploymentManifestSchema.parse({ ...READY_MANIFEST, surprise: true }),
    ).toThrow();
  });

  it('rejects unknown keys inside a section (strict shape per section)', () => {
    expect(() =>
      deploymentManifestSchema.parse({
        ...READY_MANIFEST,
        redis: { required: true, envBindings: [], extra: 1 },
      }),
    ).toThrow();
  });

  it('rejects a non-integer port', () => {
    expect(() =>
      deploymentManifestSchema.parse({
        ...READY_MANIFEST,
        web: { command: 'npm start', port: 3000.5 },
      }),
    ).toThrow();
  });
});

describe('manifestEnvBindingSchema', () => {
  it('accepts a bucket binding for storage', () => {
    expect(manifestEnvBindingSchema.parse({ name: 'AWS_S3_BUCKET', kind: 'bucket' })).toEqual({
      name: 'AWS_S3_BUCKET',
      kind: 'bucket',
    });
  });

  it('rejects an unknown binding kind', () => {
    expect(() => manifestEnvBindingSchema.parse({ name: 'X', kind: 'secret' })).toThrow();
  });
});

describe('deploymentManifestOverridesSchema', () => {
  it('parses a full override set', () => {
    const overrides = deploymentManifestOverridesSchema.parse({
      appRoot: 'apps/web',
      dockerfilePath: 'apps/web/Dockerfile',
      buildContext: 'apps/web',
      buildCommand: 'pnpm build',
      startCommand: 'pnpm start',
      port: 8080,
      healthPath: '/api/health',
      migrationCommand: 'pnpm db:migrate',
      workerCommand: 'pnpm worker',
      databaseRequired: true,
      storageRequired: false,
      redisRequired: true,
    });
    expect(overrides.port).toBe(8080);
  });

  it('accepts an empty (absence-only) override set', () => {
    expect(deploymentManifestOverridesSchema.parse({})).toEqual({});
  });

  it('rejects an unknown override key', () => {
    expect(() => deploymentManifestOverridesSchema.parse({ surprise: 1 })).toThrow();
  });
});

describe('manifestReadinessResultSchema', () => {
  it('parses a READY result with a warning', () => {
    const result = manifestReadinessResultSchema.parse({
      state: 'READY',
      findings: [
        {
          id: 'migration-command-missing',
          category: 'database',
          severity: 'warning',
          message: 'no migration command',
        },
      ],
    });
    expect(result.state).toBe('READY');
  });

  it('rejects a state outside the enum', () => {
    expect(() => manifestReadinessResultSchema.parse({ state: 'MAYBE', findings: [] })).toThrow();
  });
});