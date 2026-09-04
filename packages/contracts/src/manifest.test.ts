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
  environment: { variables: [{ key: 'DATABASE_URL', required: false, secret: false, source: [] }] },
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

  it('accepts the postgres binding kinds (url + discrete parts)', () => {
    for (const kind of ['url', 'host', 'port', 'database', 'username', 'password']) {
      expect(manifestEnvBindingSchema.parse({ name: 'MEMOS_DSN', kind }).kind).toBe(kind);
    }
  });

  it('rejects an unknown binding kind', () => {
    expect(() => manifestEnvBindingSchema.parse({ name: 'X', kind: 'secret' })).toThrow();
  });
});

describe('database.envBindings (Stage B phase 2)', () => {
  it('accepts a manifest whose database section carries envBindings', () => {
    const parsed = deploymentManifestSchema.parse({
      ...READY_MANIFEST,
      database: {
        postgres: true,
        envBindings: [
          { name: 'DATABASE_URL', kind: 'url' },
          { name: 'DATABASE_HOST', kind: 'host' },
          { name: 'PAPERLESS_DBUSER', kind: 'username' },
          { name: 'PAPERLESS_DBPASS', kind: 'password' },
        ],
      },
    });
    expect(parsed.database.envBindings).toHaveLength(4);
  });

  it('still validates an OLD stored manifest that has no database.envBindings', () => {
    const parsed = deploymentManifestSchema.parse(READY_MANIFEST);
    // database.envBindings is optional: an old stored manifest round-trips
    // with exactly the database section it was written with.
    expect(parsed.database).toEqual({ postgres: true });
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