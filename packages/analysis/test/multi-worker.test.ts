import { describe, expect, it } from 'vitest';

import { analyseRepo, type FileTree } from '../src/analyser.js';
import { manifestToApplicationGraph } from '../src/graph.js';
import { normalizeDeploymentManifest, evaluateManifestReadiness } from '../src/manifest.js';
import { planApplicationGraph } from '../src/planner.js';
import { detectDeclaredWorkerCommands } from '../src/detectors.js';

// Phase 4A — workloads[] is first-class: one build artifact, a web process
// and N declared workers, each with its own frozen command. Weak evidence
// (a queue library with no declared process) never becomes a workload.

const BASE: FileTree = {
  'Dockerfile': [
    'FROM node:20-alpine',
    'WORKDIR /app',
    'COPY . .',
    'EXPOSE 3000',
    'HEALTHCHECK --interval=30s CMD curl -f http://localhost:3000/health || exit 1',
    'CMD ["node", "dist/index.js"]',
  ].join('\n'),
  'package.json': JSON.stringify({
    name: 'shop',
    scripts: { start: 'node dist/index.js', build: 'tsc' },
    dependencies: { express: '^4.18.0', bullmq: '^5.0.0' },
  }),
  'src/index.ts': [
    "import express from 'express';",
    "app.get('/health', (_req, res) => res.json({ ok: true }));",
    'app.listen(process.env.PORT ?? 3000);',
  ].join('\n'),
};

describe('detectDeclaredWorkerCommands — id derivation', () => {
  it('derives a stable kebab id per Procfile process, skipping web and one-shot hooks', () => {
    const tree: FileTree = {
      'Procfile': 'web: node dist/index.js\nrelease: npx prisma migrate deploy\nemail-worker: node dist/workers/email.js\nimport_worker: node dist/workers/import.js\n',
    };
    expect(detectDeclaredWorkerCommands(tree)).toEqual([
      { id: 'email-worker', command: 'node dist/workers/email.js', source: 'Procfile' },
      { id: 'import-worker', command: 'node dist/workers/import.js', source: 'Procfile' },
    ]);
  });

  it('never derives a worker from a `migration` process — the one-shot slot belongs to migration detection (gate B1)', () => {
    const tree: FileTree = {
      'Procfile': 'web: node dist/index.js\nmigration: node migrate.js\n',
    };
    expect(detectDeclaredWorkerCommands(tree)).toEqual([]);
  });
});

describe('multi-worker manifest — Procfile evidence', () => {
  it('a Procfile `migration:` process plus a migration command yields exactly ONE migration workload and no worker collision (gate B1)', () => {
    // Realistic repo: the migration process is declared in the Procfile AND
    // the migration command resolves through the migration path (the vendor
    // override the API feeds back from the analysed `migrate` script).
    const analysis = analyseRepo({
      ...BASE,
      'Procfile': 'web: node dist/index.js\nmigration: node migrate.js\n',
    });
    const manifest = normalizeDeploymentManifest(analysis, { migrationCommand: 'node migrate.js' });
    expect(manifest.workers).toBeUndefined();

    const graph = manifestToApplicationGraph(manifest);
    const migrationWorkloads = graph.workloads.filter((w) => w.id === 'migration');
    expect(migrationWorkloads).toHaveLength(1);
    expect(migrationWorkloads[0]!.kind).toBe('migration');
    expect(migrationWorkloads[0]!.command).toBe('node migrate.js');
    expect(graph.workloads.filter((w) => w.kind === 'worker')).toHaveLength(0);

    // The planner keeps one log group per workload — a duplicate id would
    // emit a duplicate MigrationLogGroup logical id and fail the compile.
    const ir = planApplicationGraph({ graph, region: null });
    expect(ir.workloads.filter((w) => w.componentId === 'migration')).toHaveLength(1);
  });
  it('turns two declared processes into two worker entries with stable ids and commands', () => {
    const analysis = analyseRepo({
      ...BASE,
      'Procfile': 'web: node dist/index.js\nemail-worker: node dist/workers/email.js\nimport-worker: node dist/workers/import.js\n',
    });
    const manifest = normalizeDeploymentManifest(analysis, {});

    expect(manifest.workers).toEqual([
      { id: 'email-worker', command: 'node dist/workers/email.js', source: 'Procfile' },
      { id: 'import-worker', command: 'node dist/workers/import.js', source: 'Procfile' },
    ]);
    // Legacy single slot carries the first worker for old consumers.
    expect(manifest.worker.command).toBe('node dist/workers/email.js');
    expect(manifest.worker.needsCommand).toBeUndefined();
    expect(manifest.unsupported).toEqual([]);
    expect(evaluateManifestReadiness(manifest).state).toBe('READY');
  });

  it('maps the workers into N workloads with per-workload commands, all on one artifact', () => {
    const analysis = analyseRepo({
      ...BASE,
      'Procfile': 'web: node dist/index.js\nemail-worker: node dist/workers/email.js\nimport-worker: node dist/workers/import.js\n',
    });
    const manifest = normalizeDeploymentManifest(analysis, {});
    const graph = manifestToApplicationGraph(manifest);

    expect(graph.buildArtifacts).toHaveLength(1);
    expect(graph.workloads.map((w) => w.id)).toEqual(['web', 'email-worker', 'import-worker']);

    const emailWorker = graph.workloads.find((w) => w.id === 'email-worker')!;
    expect(emailWorker.kind).toBe('worker');
    expect(emailWorker.command).toBe('node dist/workers/email.js');
    expect(emailWorker.public).toBe(false);
    expect(emailWorker.port).toBeNull();
    expect(emailWorker.healthCheck).toBeNull();
    expect(emailWorker.desiredCount).toBe(1);
    expect(emailWorker.buildArtifactId).toBe('app');
    // Provenance names the declaring file.
    expect(emailWorker.provenance.evidence[0]!.sourceType).toBe('procfile');
  });

  it('plans every worker as an ECS-service workload and keeps ingress on web only', () => {
    const analysis = analyseRepo({
      ...BASE,
      'Procfile': 'web: node dist/index.js\nemail-worker: node dist/workers/email.js\n',
    });
    const manifest = normalizeDeploymentManifest(analysis, {});
    const graph = manifestToApplicationGraph(manifest);
    const ir = planApplicationGraph({ graph, region: null });

    expect(ir.workloads).toHaveLength(2);
    expect(ir.ingress.targetWorkloadIds).toEqual(['web']);

    // One RUNTIME binding per worker, from web.
    const runtime = graph.bindings.filter((b) => b.relationship === 'RUNTIME');
    expect(runtime.map((b) => [b.sourceId, b.targetId])).toEqual([['web', 'email-worker']]);
  });
});

describe('multi-worker manifest — compose evidence', () => {
  it('derives a worker from a compose application service with an explicit worker command', () => {
    const analysis = analyseRepo({
      ...BASE,
      'docker-compose.yml': [
        'services:',
        '  app:',
        '    build: .',
        '  email-worker:',
        '    image: myapp',
        '    command: node dist/workers/email.js',
        '',
      ].join('\n'),
    });
    expect(
      analysis.rejections.some((r) => r.dependency === 'docker-compose-multi-service' && r.detected),
    ).toBe(false);

    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.workers).toEqual([
      { id: 'email-worker', command: 'node dist/workers/email.js', source: 'docker-compose.yml email-worker' },
    ]);
    expect(evaluateManifestReadiness(manifest).state).toBe('READY');
  });
});

describe('multi-worker manifest — weak evidence needs input, never auto-provisions', () => {
  it('a queue library with no declared process stays out of workloads and raises the question', () => {
    const analysis = analyseRepo(BASE);
    const manifest = normalizeDeploymentManifest(analysis, {});

    expect(manifest.workers).toBeUndefined();
    expect(manifest.worker.command).toBeNull();
    expect(manifest.worker.needsCommand).toBe(true);
    expect(manifest.unsupported).toEqual([]);

    const graph = manifestToApplicationGraph(manifest);
    expect(graph.workloads.map((w) => w.id)).toEqual(['web']);
    const unresolved = graph.unresolved.find((u) => u.id === 'worker-command');
    expect(unresolved).toBeDefined();
    expect(unresolved!.blocking).toBe(false);
    expect(unresolved!.field).toBe('worker_command');
  });
});

describe('multi-worker manifest — compose worker service without a command', () => {
  it('a worker-named compose service with no command needs input instead of blocking as multi-service (tech spec §25.2)', () => {
    const analysis = analyseRepo({
      ...BASE,
      'docker-compose.yml': [
        'services:',
        '  api:',
        '    build: .',
        '    environment:',
        '      ROLE: api',
        '  worker:',
        '    build: .',
        '    environment:',
        '      ROLE: worker',
        '',
      ].join('\n'),
    });
    expect(
      analysis.rejections.some((r) => r.dependency === 'docker-compose-multi-service' && r.detected),
    ).toBe(false);

    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.workers).toBeUndefined();
    expect(manifest.worker.command).toBeNull();
    expect(manifest.worker.needsCommand).toBe(true);

    const graph = manifestToApplicationGraph(manifest);
    expect(graph.workloads.map((w) => w.id)).toEqual(['web']);
    const unresolved = graph.unresolved.find((u) => u.id === 'worker-command');
    expect(unresolved).toBeDefined();
    expect(unresolved!.blocking).toBe(false);
    expect(unresolved!.field).toBe('worker_command');
  });

  it('never derives a declared worker command from the command-less worker service — it is never auto-provisioned', () => {
    const tree: FileTree = {
      'docker-compose.yml': ['services:', '  api:', '    build: .', '  worker:', '    build: .', ''].join('\n'),
    };
    expect(detectDeclaredWorkerCommands(tree)).toEqual([]);
  });

  it('two command-less NON-worker-named app services still reject as an unsupported multi-service compose', () => {
    const analysis = analyseRepo({
      ...BASE,
      'docker-compose.yml': ['services:', '  web:', '    build: ./web', '  admin:', '    build: ./admin', ''].join('\n'),
    });
    expect(
      analysis.rejections.some((r) => r.dependency === 'docker-compose-multi-service' && r.detected),
    ).toBe(true);
  });
});

describe('multi-worker manifest — dev utilities are not workloads', () => {
  it('dev/test/build scripts and nodemon never become workers', () => {
    const analysis = analyseRepo({
      ...BASE,
      'package.json': JSON.stringify({
        name: 'shop',
        scripts: {
          start: 'node dist/index.js',
          dev: 'nodemon src/index.ts',
          test: 'jest',
          build: 'tsc',
        },
        dependencies: { express: '^4.18.0' },
        devDependencies: { nodemon: '^3.0.0', jest: '^29.0.0' },
      }),
    });
    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.workers).toBeUndefined();
    expect(manifest.worker.needsCommand).toBeUndefined();

    const graph = manifestToApplicationGraph(manifest);
    expect(graph.workloads.map((w) => w.id)).toEqual(['web']);
  });
});
