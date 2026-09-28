import { describe, expect, it } from 'vitest';

import { analyseRepo, type FileTree } from '../src/analyser.js';
import { manifestToApplicationGraph } from '../src/graph.js';
import { normalizeDeploymentManifest, evaluateManifestReadiness } from '../src/manifest.js';
import { planApplicationGraph } from '../src/planner.js';

// Phase 4D — the representative composition, proven from REAL evidence
// patterns only: web(public) + two Procfile workers + a migration workload;
// a managed MySQL database and a Redis cache, each corroborated by driver +
// an independent signal; a compose file carrying infra services AND a
// worker-declared application service. Nothing here is hand-set.

const COMPOSED: FileTree = {
  'Dockerfile': [
    'FROM node:20-alpine',
    'WORKDIR /app',
    'COPY . .',
    'EXPOSE 3000',
    'HEALTHCHECK --interval=30s CMD curl -f http://localhost:3000/health || exit 1',
    'CMD ["node", "dist/index.js"]',
  ].join('\n'),
  'Procfile': 'web: node dist/index.js\nemail-worker: node dist/workers/email.js\nimport-worker: node dist/workers/import.js\n',
  'docker-compose.yml': [
    'services:',
    '  app:',
    '    build: .',
    '  email-worker:',
    '    image: composed-app',
    '    command: node dist/workers/email.js',
    '  db:',
    '    image: mysql:8.0',
    '  redis:',
    '    image: redis:7-alpine',
    '',
  ].join('\n'),
  'package.json': JSON.stringify({
    name: 'composed-app',
    scripts: { start: 'node dist/index.js', build: 'tsc', migrate: 'node migrate.js' },
    dependencies: {
      express: '^4.18.0',
      mysql2: '^3.9.0',
      ioredis: '^5.4.0',
      '@prisma/client': '^5.14.0',
    },
    devDependencies: { prisma: '^5.14.0' },
  }),
  'prisma/schema.prisma': 'datasource db {\n  provider = "mysql"\n  url = env("DATABASE_URL")\n}\n',
  'migrate.js': 'async function main() { await applyPending(); process.exit(0); }\nmain();\n',
  'src/index.ts': [
    "import express from 'express';",
    "import mysql from 'mysql2/promise';",
    "import Redis from 'ioredis';",
    "app.get('/health', async (_req, res) => res.json({ ok: true }));",
    'app.listen(process.env.PORT ?? 3000);',
  ].join('\n'),
  '.env.example': 'DATABASE_URL=mysql://localhost:3306/composed\nREDIS_URL=redis://localhost:6379\n',
};

/** The composed graph, with the migration command resolved the way the
 *  API feeds the analysed `migrate` script back as a vendor override. */
function composedGraph() {
  const analysis = analyseRepo(COMPOSED);
  const manifest = normalizeDeploymentManifest(analysis, { migrationCommand: 'node migrate.js' });
  return { analysis, manifest, graph: manifestToApplicationGraph(manifest) };
}

describe('phase 4 composition — the full topology from real evidence', () => {
  it('resolves MySQL and Redis requirements from corroborated signals', () => {
    const { analysis } = composedGraph();
    expect(analysis.metadata.mysql).toMatchObject({ required: true });
    expect(analysis.metadata.redis).toMatchObject({ required: true, confidence: 'high' });
    expect(analysis.metadata.databaseState).toBe('mysql');
  });

  it('builds web(public) + two workers + migration on ONE build artifact', () => {
    const { manifest, graph } = composedGraph();
    expect(manifest.unsupported).toEqual([]);
    expect(evaluateManifestReadiness(manifest).state).toBe('READY');

    expect(graph.buildArtifacts).toHaveLength(1);
    expect(graph.workloads.map((w) => w.id)).toEqual(['web', 'email-worker', 'import-worker', 'migration']);

    const web = graph.workloads[0]!;
    expect(web.kind).toBe('web');
    expect(web.public).toBe(true);
    expect(web.port).toBe(3000);
    expect(web.buildArtifactId).toBe('app');

    for (const id of ['email-worker', 'import-worker']) {
      const worker = graph.workloads.find((w) => w.id === id)!;
      expect(worker.kind).toBe('worker');
      expect(worker.public).toBe(false);
      expect(worker.port).toBeNull();
      expect(worker.buildArtifactId).toBe('app');
      expect(worker.provenance.evidence[0]!.sourceType).toBe('procfile');
    }
    const migration = graph.workloads.find((w) => w.id === 'migration')!;
    expect(migration.kind).toBe('migration');
    expect(migration.command).toBe('node migrate.js');
    expect(migration.public).toBe(false);
  });

  it('resolves a mysql relational database and a redis cache resource', () => {
    const { graph } = composedGraph();
    const db = graph.resources.find((r) => r.id === 'primary-db')!;
    expect(db.kind).toBe('relational_database');
    expect(db.engine).toBe('mysql');
    const cache = graph.resources.find((r) => r.id === 'cache')!;
    expect(cache.kind).toBe('cache');
    expect(cache.engine).toBe('valkey');
  });

  it('binds every workload to the managed resources, web → workers at runtime, migration → db at startup', () => {
    const { graph } = composedGraph();
    const bindings = graph.bindings.map((b) => [b.sourceId, b.targetId, b.relationship]);

    // BINDING: every workload × {primary-db, cache}.
    for (const workloadId of ['web', 'email-worker', 'import-worker', 'migration']) {
      expect(bindings).toContainEqual([workloadId, 'primary-db', 'BINDING']);
      expect(bindings).toContainEqual([workloadId, 'cache', 'BINDING']);
    }
    // RUNTIME: web → each worker.
    expect(bindings).toContainEqual(['web', 'email-worker', 'RUNTIME']);
    expect(bindings).toContainEqual(['web', 'import-worker', 'RUNTIME']);
    // STARTUP: migration → primary-db.
    expect(bindings).toContainEqual(['migration', 'primary-db', 'STARTUP']);

    expect(bindings.filter(([, , relationship]) => relationship === 'RUNTIME')).toHaveLength(2);
    expect(bindings.filter(([, , relationship]) => relationship === 'STARTUP')).toHaveLength(1);
  });

  it('plans aws.rds-mysql + elasticache-valkey with ingress on web only', () => {
    const { graph } = composedGraph();
    const ir = planApplicationGraph({ graph, region: null });
    expect(ir.resources.find((r) => r.componentId === 'primary-db')!.capabilityKey).toBe('aws.rds-mysql');
    expect(ir.resources.find((r) => r.componentId === 'cache')!.capabilityKey).toBe('aws.elasticache-valkey');
    expect(ir.ingress.targetWorkloadIds).toEqual(['web']);
    expect(ir.workloads.map((w) => w.kind)).toEqual(['web', 'worker', 'worker', 'migration']);
  });
});

describe('phase 4 composition — ambiguity and false positives stay inert', () => {
  it('a bullmq dependency with no declared process raises needs-input and provisions NO worker', () => {
    const analysis = analyseRepo({
      ...COMPOSED,
      'Procfile': 'web: node dist/index.js\n',
      'docker-compose.yml': [
        'services:',
        '  app:',
        '    build: .',
        '  db:',
        '    image: mysql:8.0',
        '  redis:',
        '    image: redis:7-alpine',
        '',
      ].join('\n'),
      'package.json': JSON.stringify({
        name: 'composed-app',
        scripts: { start: 'node dist/index.js', migrate: 'node migrate.js' },
        dependencies: { express: '^4.18.0', mysql2: '^3.9.0', bullmq: '^5.0.0' },
      }),
    });
    const manifest = normalizeDeploymentManifest(analysis, { migrationCommand: 'node migrate.js' });
    expect(manifest.workers).toBeUndefined();
    expect(manifest.worker.command).toBeNull();
    expect(manifest.worker.needsCommand).toBe(true);

    const graph = manifestToApplicationGraph(manifest);
    expect(graph.workloads.map((w) => w.id)).toEqual(['web', 'migration']);
    const unresolved = graph.unresolved.find((u) => u.id === 'worker-command');
    expect(unresolved).toBeDefined();
    expect(unresolved!.blocking).toBe(false);
  });

  it('ioredis alone is cache evidence, not worker evidence — no worker, no question', () => {
    const analysis = analyseRepo({
      ...COMPOSED,
      'Procfile': 'web: node dist/index.js\n',
      'docker-compose.yml': [
        'services:',
        '  app:',
        '    build: .',
        '  db:',
        '    image: mysql:8.0',
        '  redis:',
        '    image: redis:7-alpine',
        '',
      ].join('\n'),
      'package.json': JSON.stringify({
        name: 'composed-app',
        scripts: { start: 'node dist/index.js' },
        dependencies: { express: '^4.18.0', mysql2: '^3.9.0', ioredis: '^5.4.0' },
      }),
    });
    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.workers).toBeUndefined();
    expect(manifest.worker.needsCommand).toBeUndefined();
    expect(manifestToApplicationGraph(manifest).workloads.map((w) => w.id)).toEqual(['web']);
  });

  it('a mysql devDependency with no production evidence provisions NO database', () => {
    const analysis = analyseRepo({
      ...COMPOSED,
      'docker-compose.yml': [
        'services:',
        '  app:',
        '    build: .',
        '  redis:',
        '    image: redis:7-alpine',
        '',
      ].join('\n'),
      'package.json': JSON.stringify({
        name: 'composed-app',
        scripts: { start: 'node dist/index.js' },
        dependencies: { express: '^4.18.0', ioredis: '^5.4.0' },
        devDependencies: { mysql2: '^3.9.0', prisma: '^5.14.0' },
      }),
      '.env.example': 'REDIS_URL=redis://localhost:6379\n',
    });
    expect((analysis.metadata.mysql as { required: boolean }).required).toBe(false);
    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.database.postgres).toBe(false);
    expect(manifest.database.engine).toBeUndefined();
    expect(manifestToApplicationGraph(manifest).resources.some((r) => r.id === 'primary-db')).toBe(false);
  });
});
