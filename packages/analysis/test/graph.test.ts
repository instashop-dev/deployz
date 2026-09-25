import { describe, expect, it } from 'vitest';

import type { DeploymentManifest } from '@deployz/contracts';

import { manifestToApplicationGraph } from '../src/graph.js';
import { normalizeDeploymentManifest } from '../src/manifest.js';
import { analyseRepo } from '../src/analyser.js';
import type { FileTree } from '../src/detectors.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function statelessTree(): FileTree {
  return {
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
      name: 'stateless-app',
      scripts: { start: 'node dist/index.js', build: 'tsc' },
      dependencies: { express: '^4.18.0' },
    }),
    'src/index.ts': [
      "import express from 'express';",
      "app.get('/health', (_req, res) => res.json({ ok: true }));",
      'app.listen(3000);',
    ].join('\n'),
  };
}

function postgresRedisTree(): FileTree {
  return {
    ...statelessTree(),
    'package.json': JSON.stringify({
      name: 'full-app',
      scripts: { start: 'node dist/index.js', build: 'tsc' },
      dependencies: { express: '^4.18.0', pg: '^8.12.0', ioredis: '^5.0.0' },
    }),
    '.env.example': 'PORT=3000\nDATABASE_URL=postgresql://localhost/shop\nREDIS_URL=redis://localhost:6379\n',
  };
}

function workerTree(): FileTree {
  return {
    ...postgresRedisTree(),
    'worker.ts': 'export function processJobs() { /* ... */ }',
  };
}

function externalServicesTree(): FileTree {
  return {
    ...statelessTree(),
    'src/stripe.ts': "import Stripe from 'stripe';",
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('manifestToApplicationGraph — stateless manifest', () => {
  it('produces one artifact, one workload, and the default resources', () => {
    const analysis = analyseRepo(statelessTree());
    const manifest = normalizeDeploymentManifest(analysis, {});
    const graph = manifestToApplicationGraph(manifest);

    expect(graph.schemaVersion).toBe(1);
    expect(graph.applicationRoot).toBe('.');

    // One build artifact.
    expect(graph.buildArtifacts).toHaveLength(1);
    expect(graph.buildArtifacts[0].id).toBe('app');
    expect(graph.buildArtifacts[0].dockerfilePath).toBe('Dockerfile');
    expect(graph.buildArtifacts[0].buildContext).toBe('.');

    // One workload (web only).
    expect(graph.workloads).toHaveLength(1);
    expect(graph.workloads[0].id).toBe('web');
    expect(graph.workloads[0].kind).toBe('web');
    expect(graph.workloads[0].public).toBe(true);
    expect(graph.workloads[0].port).toBe(3000);

    // Resources: storage + endpoint only (no postgres, no redis).
    const resourceIds = graph.resources.map((r) => r.id).sort();
    expect(resourceIds).toEqual(['endpoint', 'storage']);

    // Bindings: web → storage only.
    expect(graph.bindings.length).toBeGreaterThanOrEqual(1);
    const webBindings = graph.bindings.filter((b) => b.sourceId === 'web' && b.relationship === 'BINDING');
    expect(webBindings.map((b) => b.targetId).sort()).toEqual(['storage']);

    // No unresolved (stateless app with no unsupported reasons).
    expect(graph.unresolved).toEqual([]);
    expect(graph.externalServices).toEqual([]);
  });
});

describe('manifestToApplicationGraph — postgres + redis manifest', () => {
  it('includes primary-db, cache, storage, endpoint and bindings for all workloads', () => {
    const analysis = analyseRepo(postgresRedisTree());
    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.database.postgres).toBe(true);
    expect(manifest.redis.required).toBe(true);

    const graph = manifestToApplicationGraph(manifest);

    const resourceIds = graph.resources.map((r) => r.id).sort();
    expect(resourceIds).toEqual(['cache', 'endpoint', 'primary-db', 'storage']);

    // web binds to primary-db, cache, storage.
    const webBindings = graph.bindings.filter((b) => b.sourceId === 'web' && b.relationship === 'BINDING');
    expect(webBindings.map((b) => b.targetId).sort()).toEqual(['cache', 'primary-db', 'storage']);

    // No worker, no migration → no RUNTIME or STARTUP bindings.
    expect(graph.bindings.filter((b) => b.relationship === 'RUNTIME')).toHaveLength(0);
    expect(graph.bindings.filter((b) => b.relationship === 'STARTUP')).toHaveLength(0);
  });

  it('adds a non-blocking migration-strategy unresolved when mode is unknown', () => {
    const analysis = analyseRepo(postgresRedisTree());
    const manifest: DeploymentManifest = {
      ...normalizeDeploymentManifest(analysis, {}),
      migration: { command: null, mode: 'unknown' },
    };
    const graph = manifestToApplicationGraph(manifest);

    const migrationUnresolved = graph.unresolved.find((u) => u.id === 'migration-strategy');
    expect(migrationUnresolved).toBeDefined();
    expect(migrationUnresolved!.blocking).toBe(false);
    expect(migrationUnresolved!.field).toBe('migration_strategy');
  });
});

describe('manifestToApplicationGraph — worker manifest', () => {
  it('adds a worker workload and a RUNTIME binding between web and worker', () => {
    const analysis = analyseRepo(workerTree());
    const manifest = normalizeDeploymentManifest(analysis, {
      workerCommand: 'node dist/worker.js',
    });
    expect(manifest.worker.command).toBe('node dist/worker.js');

    const graph = manifestToApplicationGraph(manifest);

    const workloadIds = graph.workloads.map((w) => w.id).sort();
    expect(workloadIds).toEqual(['web', 'worker']);

    const worker = graph.workloads.find((w) => w.id === 'worker')!;
    expect(worker.kind).toBe('worker');
    expect(worker.public).toBe(false);
    expect(worker.command).toBe('node dist/worker.js');

    // Worker also binds to managed resources.
    const workerBindings = graph.bindings.filter((b) => b.sourceId === 'worker' && b.relationship === 'BINDING');
    expect(workerBindings.map((b) => b.targetId).sort()).toEqual(['cache', 'primary-db', 'storage']);

    // RUNTIME binding between web and worker.
    const runtimeBindings = graph.bindings.filter((b) => b.relationship === 'RUNTIME');
    expect(runtimeBindings).toHaveLength(1);
    expect(runtimeBindings[0].sourceId).toBe('web');
    expect(runtimeBindings[0].targetId).toBe('worker');
  });
});

describe('manifestToApplicationGraph — external services', () => {
  it('adds external_service resources and non-blocking unresolved items', () => {
    const analysis = analyseRepo(externalServicesTree());
    const manifest = normalizeDeploymentManifest(analysis, {});
    // Manually inject external services for deterministic testing.
    const manifestWithExternal: DeploymentManifest = {
      ...manifest,
      externalServices: ['Stripe', 'SendGrid'],
    };

    const graph = manifestToApplicationGraph(manifestWithExternal);

    // External services appear as resources.
    const extResources = graph.resources.filter((r) => r.kind === 'external_service');
    expect(extResources).toHaveLength(2);
    expect(extResources.map((r) => r.ownership)).toEqual(['EXTERNAL_SAAS', 'EXTERNAL_SAAS']);

    // External services also appear in the top-level list.
    expect(graph.externalServices).toHaveLength(2);
    expect(graph.externalServices.map((e) => e.name)).toEqual(['Stripe', 'SendGrid']);

    // Non-blocking unresolved for each external service.
    const extUnresolved = graph.unresolved.filter((u) => u.field === 'external_service_ownership');
    expect(extUnresolved).toHaveLength(2);
    expect(extUnresolved.every((u) => !u.blocking)).toBe(true);
  });
});

describe('manifestToApplicationGraph — migration with STARTUP binding', () => {
  it('adds a migration workload and a STARTUP binding to primary-db', () => {
    const analysis = analyseRepo(postgresRedisTree());
    const manifest = normalizeDeploymentManifest(analysis, {
      migrationCommand: 'npx prisma migrate deploy',
    });
    expect(manifest.migration.command).toBe('npx prisma migrate deploy');

    const graph = manifestToApplicationGraph(manifest);

    const migration = graph.workloads.find((w) => w.id === 'migration');
    expect(migration).toBeDefined();
    expect(migration!.kind).toBe('migration');
    expect(migration!.public).toBe(false);

    const startupBindings = graph.bindings.filter((b) => b.relationship === 'STARTUP');
    expect(startupBindings).toHaveLength(1);
    expect(startupBindings[0].sourceId).toBe('migration');
    expect(startupBindings[0].targetId).toBe('primary-db');
  });
});

describe('manifestToApplicationGraph — unsupported reasons are blocking unresolved', () => {
  it('surfaces each unsupported reason as a blocking unresolved item', () => {
    const analysis = analyseRepo(statelessTree());
    const manifest: DeploymentManifest = {
      ...normalizeDeploymentManifest(analysis, {}),
      unsupported: ['Local filesystem not supported', 'GPU workloads not supported'],
    };

    const graph = manifestToApplicationGraph(manifest);

    expect(graph.unresolved.length).toBe(2);
    expect(graph.unresolved.every((u) => u.blocking)).toBe(true);
    expect(graph.unresolved[0].field).toBe('compatibility');
  });
});
