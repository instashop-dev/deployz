import { describe, expect, it } from 'vitest';

import { analyseRepo, type FileTree } from '../src/analyser.js';
import { evaluateManifestReadiness, normalizeDeploymentManifest } from '../src/manifest.js';

// A ready Node/Express app: Dockerfile + port + health route + PostgreSQL.
const READY_TREE: FileTree = {
  'Dockerfile': [
    'FROM node:20-alpine',
    'WORKDIR /app',
    'COPY package*.json ./',
    'RUN npm ci --omit=dev',
    'COPY . .',
    'EXPOSE 3000',
    'HEALTHCHECK --interval=30s CMD curl -f http://localhost:3000/health || exit 1',
    'CMD ["node", "dist/index.js"]',
  ].join('\n'),
  'package.json': JSON.stringify({
    name: 'shop',
    scripts: {
      start: 'node dist/index.js',
      build: 'tsc -p tsconfig.json',
      'db:migrate': 'npx drizzle-kit push',
    },
    dependencies: { express: '^4.18.0', pg: '^8.12.0', 'drizzle-orm': '^0.36.0' },
  }),
  '.env.example': 'PORT=3000\nDATABASE_URL=postgresql://localhost:5432/shop\n',
  'src/index.ts': [
    "import express from 'express';",
    "app.get('/health', (_req, res) => res.json({ ok: true }));",
    'app.listen(process.env.PORT ?? 3000);',
  ].join('\n'),
};

describe('normalizeDeploymentManifest', () => {
  it('turns a ready analysis into a validated manifest', () => {
    const analysis = analyseRepo(READY_TREE);
    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.application).toEqual({
      root: '.',
      runtime: 'node',
      framework: 'express',
      dockerfilePath: 'Dockerfile',
    });
    expect(manifest.web).toEqual({ command: 'CMD: ["node", "dist/index.js"]', port: 3000 });
    expect(manifest.health.path).toBe('/health');
    expect(manifest.database.postgres).toBe(true);
    expect(manifest.migration.command).toBe('drizzle-kit');
    expect(manifest.build.command).toBe('tsc -p tsconfig.json');
    expect(manifest.build.context).toBe('.');
    expect(manifest.environment.variables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'PORT' }),
        expect.objectContaining({ key: 'DATABASE_URL' }),
      ]),
    );
    expect(manifest.unsupported).toEqual([]);
  });

  it('vendor overrides win over detection', () => {
    const analysis = analyseRepo(READY_TREE);
    const manifest = normalizeDeploymentManifest(analysis, {
      appRoot: 'apps/web',
      dockerfilePath: 'apps/web/Dockerfile.prod',
      buildContext: 'apps/web',
      buildCommand: 'pnpm build',
      startCommand: 'pnpm start',
      port: 8080,
      healthPath: '/api/health',
      migrationCommand: 'pnpm db:migrate',
      redisRequired: true,
    });
    expect(manifest.application).toEqual({
      root: 'apps/web',
      runtime: 'node',
      framework: 'express',
      dockerfilePath: 'apps/web/Dockerfile.prod',
    });
    expect(manifest.build).toEqual({ command: 'pnpm build', context: 'apps/web' });
    expect(manifest.web).toEqual({ command: 'pnpm start', port: 8080 });
    expect(manifest.health.path).toBe('/api/health');
    expect(manifest.migration.command).toBe('pnpm db:migrate');
    expect(manifest.redis.required).toBe(true);
  });

  it('derives the app root from a nested Dockerfile path, defaulting the build context to the repo root', () => {
    const analysis = analyseRepo({
      'apps/web/Dockerfile': 'FROM node:20-alpine\nCMD ["node", "index.js"]\n',
      'apps/web/package.json': JSON.stringify({ scripts: { start: 'node index.js' } }),
    });
    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.application.root).toBe('apps/web');
    expect(manifest.application.dockerfilePath).toBe('apps/web/Dockerfile');
    expect(manifest.build.context).toBe('.');
  });

  it('flags unsupported databases and local filesystem', () => {
    const analysis = analyseRepo({
      'package.json': JSON.stringify({ dependencies: { mysql2: '^3.0.0' } }),
      'src/index.js': 'const db = require("mysql2");\nfs.writeFileSync("/tmp/x", "y");\n',
    });
    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.unsupported.some((r) => r.includes('PostgreSQL'))).toBe(true);
    expect(manifest.unsupported.some((r) => r.includes('local filesystem'))).toBe(true);
  });

  it('flags a declared background worker process as needs-adaptation (Phase 8)', () => {
    const analysis = analyseRepo({
      ...READY_TREE,
      'package.json': JSON.stringify({
        name: 'shop',
        scripts: { start: 'node dist/index.js', worker: 'node dist/worker.js' },
        dependencies: { express: '^4.18.0', pg: '^8.12.0', bullmq: '^5.0.0' },
      }),
    });
    // The API resolves the command from package.json scripts and persists it
    // in metadata; overrides carry it for rows analysed before Phase 8.
    const manifest = normalizeDeploymentManifest(analysis, {
      workerCommand: 'node dist/worker.js',
    });
    expect(manifest.worker.command).toBe('node dist/worker.js');
    expect(manifest.unsupported.some((r) => r.includes('Background worker process'))).toBe(true);
    expect(evaluateManifestReadiness(manifest).state).toBe('NOT_COMPATIBLE');
  });

  it('worker-like code WITHOUT a start command stays deployable (no unsupported reason)', () => {
    const analysis = analyseRepo({
      ...READY_TREE,
      'package.json': JSON.stringify({
        name: 'shop',
        scripts: { start: 'node dist/index.js' },
        dependencies: { express: '^4.18.0', pg: '^8.12.0', bullmq: '^5.0.0' },
      }),
    });
    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.worker.command).toBeNull();
    expect(manifest.unsupported).toEqual([]);
    expect(evaluateManifestReadiness(manifest).state).toBe('READY');
  });

  it('resolves Redis bindings from detected connection env vars', () => {
    const analysis = analyseRepo({
      'Dockerfile': 'FROM node:20-alpine\nCMD ["node", "index.js"]\n',
      '.env.example': 'REDIS_URL=redis://localhost:6379\n',
      'src/index.js': 'import { createClient } from "redis";\ncreateClient();\n',
      'package.json': JSON.stringify({ dependencies: { redis: '^4.0.0' } }),
    });
    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.redis.required).toBe(true);
    expect(manifest.redis.envBindings).toEqual([{ name: 'REDIS_URL', kind: 'url' }]);
  });
});

describe('evaluateManifestReadiness', () => {
  it('returns READY for a deployable manifest', () => {
    const manifest = normalizeDeploymentManifest(analyseRepo(READY_TREE), {});
    expect(evaluateManifestReadiness(manifest).state).toBe('READY');
  });

  it('returns NOT_COMPATIBLE for an unsupported app, and blocks regardless of other fields', () => {
    const analysis = analyseRepo({
      'package.json': JSON.stringify({
        scripts: { start: 'node index.js' },
        dependencies: { mongoose: '^7.0.0' },
      }),
      'Dockerfile': 'FROM node:20-alpine\nCMD ["node", "index.js"]\n',
      'src/index.js': 'const mongoose = require("mongoose");\n',
    });
    const manifest = normalizeDeploymentManifest(analysis, { port: 3000 });
    const result = evaluateManifestReadiness(manifest);
    expect(result.state).toBe('NOT_COMPATIBLE');
    expect(result.findings.filter((f) => f.severity === 'error')).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ id: 'unsupported', category: 'compatibility' });
  });

  it('returns NEEDS_CONFIGURATION when Dockerfile or port or start command is missing', () => {
    const manifest = normalizeDeploymentManifest({ metadata: { hasDockerfile: false } }, {});
    const result = evaluateManifestReadiness(manifest);
    expect(result.state).toBe('NEEDS_CONFIGURATION');
    const ids = result.findings.filter((f) => f.severity === 'error').map((f) => f.id);
    expect(ids).toEqual(
      expect.arrayContaining(['dockerfile-missing', 'port-missing', 'start-command-missing']),
    );
  });

  it('READY carries a warning when PostgreSQL is required but no migration command exists', () => {
    const manifest = normalizeDeploymentManifest(
      {
        metadata: {
          hasDockerfile: true,
          dockerfilePath: 'Dockerfile',
          startupCommands: ['node index.js'],
          port: '3000',
          postgres: { required: true },
        },
      },
      {},
    );
    const result = evaluateManifestReadiness(manifest);
    expect(result.state).toBe('READY');
    expect(result.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'migration-command-missing' })]),
    );
  });
});