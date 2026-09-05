/**
 * AI MVP Phase 1 — the canonical application analysis and the two detectors
 * it introduced (runtime, bind address).
 *
 * Fixtures cover the archetypes the projection must explain: Next.js,
 * Express, Python, PostgreSQL, Redis, declared local filesystem state, a
 * missing health endpoint, and an ambiguous repository the AI fallback
 * resolves. Assertions are on structure, sources, confidence and evidence —
 * never on prose.
 */

import { describe, expect, it } from 'vitest';

import { applicationAnalysisSchema } from '@deployz/contracts';

import { analyseRepo } from '../src/analyser.js';
import { buildApplicationAnalysis, readApplicationAnalysis } from '../src/application-analysis.js';
import { detectBindAddress, detectRuntime, type FileTree } from '../src/detectors.js';
import { mergeAiAnalysis } from '../src/repository-ai.js';

const CONTEXT = { analysisVersion: 13, aiResolved: [], resolvedMigrationCommand: null };

const expressPostgresTree: FileTree = {
  Dockerfile: [
    'FROM node:20-alpine',
    'WORKDIR /app',
    'COPY . .',
    'EXPOSE 3000',
    'HEALTHCHECK CMD curl -f http://localhost:3000/health || exit 1',
    'CMD ["node", "dist/index.js"]',
  ].join('\n'),
  'package.json': JSON.stringify({
    name: 'api',
    scripts: { start: 'node dist/index.js', build: 'tsc', 'db:migrate': 'npx drizzle-kit push' },
    dependencies: { express: '^4', pg: '^8', 'drizzle-orm': '^0.36' },
  }),
  'src/index.ts': [
    "import express from 'express';",
    'const app = express();',
    "app.get('/health', (_req, res) => res.json({ ok: true }));",
    'app.listen(process.env.PORT || 3000);',
  ].join('\n'),
  '.env.example': 'DATABASE_URL=\nSTRIPE_SECRET_KEY=\n',
};

const nextjsTree: FileTree = {
  Dockerfile: ['FROM node:20-alpine AS deps', 'FROM node:20-alpine AS runner', 'EXPOSE 3000', 'CMD ["node", "server.js"]'].join(
    '\n',
  ),
  'package.json': JSON.stringify({
    name: 'web',
    scripts: { build: 'next build', start: 'next start' },
    dependencies: { next: '^15', react: '^19', '@prisma/client': '^6' },
  }),
  'prisma/schema.prisma': 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
  'app/api/health/route.ts': "export function GET() { return Response.json({ ok: true }); }\n",
};

const pythonTree: FileTree = {
  Dockerfile: ['FROM python:3.12-slim', 'WORKDIR /app', 'COPY . .', 'EXPOSE 8000', 'CMD ["uvicorn", "main:app"]'].join('\n'),
  'requirements.txt': 'fastapi\nuvicorn\n',
  'main.py': "from fastapi import FastAPI\napp = FastAPI()\n@app.get('/healthz')\ndef healthz():\n    return {'ok': True}\n",
};

const redisTree: FileTree = {
  ...expressPostgresTree,
  'package.json': JSON.stringify({
    name: 'api',
    scripts: { start: 'node dist/index.js' },
    dependencies: { express: '^4', pg: '^8', bullmq: '^5' },
  }),
  'src/queue.ts': "import { Queue } from 'bullmq';\nexport const queue = new Queue('jobs', { connection: { url: process.env.REDIS_URL } });\n",
};

const localFsTree: FileTree = {
  ...expressPostgresTree,
  Dockerfile: `${expressPostgresTree['Dockerfile']}\nVOLUME /app/uploads`,
};

const noHealthTree: FileTree = {
  Dockerfile: ['FROM node:20-alpine', 'EXPOSE 3000', 'CMD ["node", "server.js"]'].join('\n'),
  'package.json': JSON.stringify({ name: 'api', scripts: { start: 'node server.js' }, dependencies: { express: '^4' } }),
  'server.js': "require('express')().listen(3000);\n",
};

const ambiguousTree: FileTree = {
  'package.json': JSON.stringify({ name: 'mystery', dependencies: { koa: '^2' } }),
  'src/app.ts': "import Koa from 'koa';\nexport const app = new Koa();\n",
};

describe('detectRuntime', () => {
  it('reads the runtime family from the selected Dockerfile base image', () => {
    const finding = detectRuntime(pythonTree);
    expect(finding).toMatchObject({ detected: true, value: 'python', source: 'dockerfile' });
    expect(finding.details).toContain('python:3.12-slim');
  });

  it('uses the last recognizable stage of a multi-stage build, skipping a bare final image', () => {
    const tree: FileTree = {
      Dockerfile: ['FROM golang:1.22 AS build', 'RUN go build -o app', 'FROM gcr.io/distroless/static', 'COPY --from=build /app /app'].join('\n'),
      'go.mod': 'module example.com/app\n',
    };
    expect(detectRuntime(tree)).toMatchObject({ detected: true, value: 'go', source: 'dockerfile' });
  });

  it('strips a registry host and tag before matching the image name', () => {
    const tree: FileTree = { Dockerfile: 'FROM public.ecr.aws/docker/library/node:22-alpine\nCMD ["node", "x.js"]' };
    expect(detectRuntime(tree)).toMatchObject({ value: 'node', source: 'dockerfile' });
  });

  it('falls back to the shallowest dependency manifest without a Dockerfile', () => {
    const tree: FileTree = { 'Gemfile': "source 'https://rubygems.org'\ngem 'rails'\n", 'client/package.json': '{}' };
    expect(detectRuntime(tree)).toMatchObject({ detected: true, value: 'ruby', source: 'package-manifest' });
  });

  it('is not detected for a repository with no runtime evidence', () => {
    expect(detectRuntime({ 'README.md': '# docs' })).toEqual({ detector: 'runtime', detected: false });
  });
});

describe('detectBindAddress', () => {
  it('flags a Node server that listens on 127.0.0.1', () => {
    const tree: FileTree = { ...noHealthTree, 'server.js': "app.listen(3000, '127.0.0.1');\n" };
    const finding = detectBindAddress(tree);
    expect(finding).toMatchObject({ detected: true, value: 'localhost' });
    expect(finding.details).toContain('server.js');
  });

  it('flags a start command that pins a loopback host', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({ scripts: { start: 'next start -H localhost', dev: 'next dev -H 127.0.0.1' } }),
    };
    expect(detectBindAddress(tree)).toMatchObject({ detected: true, value: 'localhost' });
  });

  it('ignores a dev script that pins localhost', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({ scripts: { start: 'next start', dev: 'next dev -H 127.0.0.1' } }),
    };
    expect(detectBindAddress(tree)).toEqual({ detector: 'bind-address', detected: false });
  });

  it('flags uvicorn without --host because it binds 127.0.0.1 by default', () => {
    expect(detectBindAddress(pythonTree)).toMatchObject({ detected: true, value: 'localhost' });
  });

  it('accepts uvicorn --host 0.0.0.0 as all interfaces', () => {
    const tree: FileTree = { ...pythonTree, Dockerfile: 'FROM python:3.12\nCMD ["uvicorn", "main:app", "--host", "0.0.0.0"]' };
    expect(detectBindAddress(tree)).toMatchObject({ detected: false, value: 'all-interfaces' });
  });

  it('ignores loopback literals in test files', () => {
    const tree: FileTree = { ...noHealthTree, 'test/server.test.js': "app.listen(0, '127.0.0.1');\n" };
    expect(detectBindAddress(tree)).toEqual({ detector: 'bind-address', detected: false });
  });

  it('flags a Dockerfile ENV HOST on a loopback address and a Go ListenAndServe on localhost', () => {
    expect(detectBindAddress({ Dockerfile: 'FROM node:20\nENV HOST=127.0.0.1\nCMD ["node", "x"]' })).toMatchObject({ detected: true });
    expect(detectBindAddress({ 'main.go': 'http.ListenAndServe("localhost:8080", nil)\n' })).toMatchObject({ detected: true });
    expect(detectBindAddress({ 'main.go': 'http.ListenAndServe(":8080", nil)\n' })).toEqual({ detector: 'bind-address', detected: false });
  });
});

describe('buildApplicationAnalysis', () => {
  it('projects an Express + PostgreSQL app with sources, confidence and evidence on every fact', () => {
    const result = buildApplicationAnalysis(analyseRepo(expressPostgresTree), {
      ...CONTEXT,
      resolvedMigrationCommand: 'npx drizzle-kit push',
    });

    expect(applicationAnalysisSchema.safeParse(result).success).toBe(true);
    expect(result.analysisVersion).toBe(13);
    expect(result.runtime).toMatchObject({ value: 'node', source: 'dockerfile', confidence: 'confirmed' });
    expect(result.runtime.evidence[0]).toEqual({ file: 'Dockerfile', reason: 'Base image node:20-alpine in Dockerfile' });
    expect(result.framework).toMatchObject({ value: 'express', source: 'package-manifest', confidence: 'confirmed' });
    expect(result.build).toMatchObject({ value: 'tsc', source: 'package-manifest', confidence: 'confirmed' });
    expect(result.start).toMatchObject({ value: '["node", "dist/index.js"]', source: 'dockerfile', confidence: 'confirmed' });
    expect(result.network.port).toMatchObject({ value: 3000, source: 'dockerfile', confidence: 'confirmed' });
    expect(result.network.port.evidence[0]?.reason).toContain('EXPOSE');
    expect(result.network.bindAddress).toMatchObject({ value: null, source: 'none' });
    expect(result.database).toMatchObject({ required: true, type: 'postgres', confidence: 'confirmed' });
    expect(result.database.evidence.length).toBeGreaterThan(0);
    expect(result.redis).toMatchObject({ required: false, detected: false, supported: true, confidence: 'needs_confirmation' });
    expect(result.storage).toEqual({ persistentLocalRequired: false, objectStorageDetected: false, evidence: [] });
    expect(result.healthCheck).toMatchObject({ detected: true, path: '/health', confidence: 'confirmed' });
    expect(result.migrations).toMatchObject({ detected: true, command: 'npx drizzle-kit push', tools: ['drizzle-kit'] });
    expect(result.environmentVariables.map((v) => v.key)).toEqual(expect.arrayContaining(['DATABASE_URL', 'STRIPE_SECRET_KEY']));
  });

  it('projects a Next.js + Prisma app: file-route health path and a required database from the Prisma provider', () => {
    const result = buildApplicationAnalysis(analyseRepo(nextjsTree), CONTEXT);
    expect(result.runtime.value).toBe('node');
    expect(result.framework.value).toBe('next');
    expect(result.build).toMatchObject({ value: 'next build', source: 'package-manifest' });
    expect(result.healthCheck).toMatchObject({ detected: true, path: '/api/health', confidence: 'confirmed' });
    expect(result.healthCheck.evidence[0]?.reason).toContain('app/api/health/route.ts');
    expect(result.database).toMatchObject({ required: true, type: 'postgres' });
  });

  it('projects a Python app: runtime from the image, no database, a loopback bind address', () => {
    const result = buildApplicationAnalysis(analyseRepo(pythonTree), CONTEXT);
    expect(result.runtime).toMatchObject({ value: 'python', source: 'dockerfile' });
    expect(result.framework.value).toBeNull();
    expect(result.start).toMatchObject({ value: '["uvicorn", "main:app"]', source: 'dockerfile' });
    expect(result.network.port).toMatchObject({ value: 8000, source: 'dockerfile' });
    expect(result.network.bindAddress).toMatchObject({ value: 'localhost', source: 'source', confidence: 'likely' });
    expect(result.database).toMatchObject({ required: false, type: 'none' });
    expect(result.healthCheck).toMatchObject({ detected: true, path: '/healthz' });
  });

  it('projects a Redis app with the assessment confidence, purposes and evidence', () => {
    const result = buildApplicationAnalysis(analyseRepo(redisTree), CONTEXT);
    expect(result.redis).toMatchObject({ required: true, detected: true, supported: true, confidence: 'confirmed' });
    expect(result.redis.purposes).toContain('queue');
    expect(result.redis.evidence.length).toBeGreaterThan(0);
  });

  it('projects declared local filesystem state as persistent local storage with evidence', () => {
    const result = buildApplicationAnalysis(analyseRepo(localFsTree), CONTEXT);
    expect(result.storage.persistentLocalRequired).toBe(true);
    expect(result.storage.evidence[0]?.reason).toContain('/app/uploads');
  });

  it('projects a missing health endpoint honestly', () => {
    const result = buildApplicationAnalysis(analyseRepo(noHealthTree), CONTEXT);
    expect(result.healthCheck).toEqual({ detected: false, path: null, confidence: 'confirmed', evidence: [] });
  });

  it('reports AI-resolved facts as AI-sourced with likely confidence and never displaces a detector value', () => {
    const analysis = analyseRepo(ambiguousTree);
    expect(analysis.metadata['port']).toBeNull();
    // The merged repository-ai schema carries per-field confidence and
    // evidence; high-confidence answered fields are auto-used.
    const field = (value: string | number | null, confidence = 0.95) => ({
      value,
      confidence,
      evidencePaths: ['Dockerfile'],
      explanation: 'fixture answer',
    });
    const merged = mergeAiAnalysis(analysis.metadata, {
      dockerfile: field(null),
      workingDirectory: field('.'),
      buildCommand: field(null),
      startCommand: field('node dist/server.js'),
      port: field(8080),
      postgresRequired: field(false),
      redisRequired: field(false),
      healthPath: field(null),
      migrationMode: field(null),
      storageRequired: field(null),
      warnings: [],
    });

    const result = buildApplicationAnalysis(
      { findings: analysis.findings, metadata: merged.metadata },
      { ...CONTEXT, aiResolved: merged.aiResolved },
    );
    expect(result.runtime).toMatchObject({ value: 'node', source: 'package-manifest', confidence: 'likely' });
    expect(result.start).toEqual({
      value: 'node dist/server.js',
      source: 'ai',
      confidence: 'likely',
      evidence: [{ reason: 'Resolved by AI analysis' }],
    });
    expect(result.network.port).toMatchObject({ value: 8080, source: 'ai', confidence: 'likely' });
    expect(result.build).toMatchObject({ value: null, source: 'none', confidence: 'needs_confirmation' });
    expect(result.healthCheck.detected).toBe(false);
  });

  it('is deterministic', () => {
    const a = buildApplicationAnalysis(analyseRepo(expressPostgresTree), CONTEXT);
    const b = buildApplicationAnalysis(analyseRepo(expressPostgresTree), CONTEXT);
    expect(a).toEqual(b);
  });
});

describe('readApplicationAnalysis', () => {
  it('reads a stored projection back and rejects a malformed or missing one as null', () => {
    const projection = buildApplicationAnalysis(analyseRepo(expressPostgresTree), CONTEXT);
    expect(readApplicationAnalysis({ application: projection })).toEqual(projection);
    expect(readApplicationAnalysis({ application: { ...projection, runtime: 'node' } })).toBeNull();
    expect(readApplicationAnalysis({ readiness: {} })).toBeNull();
    expect(readApplicationAnalysis(null)).toBeNull();
  });
});
