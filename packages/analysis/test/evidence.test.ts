import { describe, expect, it } from 'vitest';

import type { AnalysisResult } from '../src/analyser.js';
import { analyseRepo } from '../src/analyser.js';
import type { FileTree } from '../src/detectors.js';
import {
  collectRepositoryEvidence,
  deriveAmbiguities,
  legacyQuestionString,
  type AnalysisAmbiguity,
} from '../src/evidence.js';
import { collectUnresolvedQuestions } from '../src/repository-ai.js';

// ==========================================================================
// Fixtures (inline file trees — no real files on disk)
// ==========================================================================

/** Fully-resolved Express app: Dockerfile, port, /health, Postgres + migration — no ambiguity should fire. */
const expressFixture: FileTree = {
  'Dockerfile': [
    'FROM node:20-alpine',
    'EXPOSE 3000',
    'HEALTHCHECK CMD curl -f http://localhost:3000/health || exit 1',
    'CMD ["node", "dist/index.js"]',
  ].join('\n'),
  'package.json': JSON.stringify({
    name: 'my-app',
    scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
    dependencies: { express: '^4.18.0', pg: '^8.12.0', 'drizzle-orm': '^0.36.0' },
  }),
  '.env.example': 'PORT=3000\nDATABASE_URL=postgresql://localhost:5432/mydb\n',
  'src/index.ts': [
    "import express from 'express';",
    'const app = express();',
    "app.get('/health', (_req, res) => res.json({ ok: true }));",
    'app.listen(process.env.PORT || 3000);',
    '',
  ].join('\n'),
};

/** Express app needing Postgres (pg + DATABASE_URL) but with NO migration script. */
const noMigrationFixture: FileTree = {
  ...expressFixture,
  'package.json': JSON.stringify({
    name: 'my-app',
    scripts: { start: 'node dist/index.js' },
    dependencies: { express: '^4.18.0', pg: '^8.12.0', 'drizzle-orm': '^0.36.0' },
  }),
};

/** Express app with zero health evidence — no HEALTHCHECK, no /health route. */
const noHealthFixture: FileTree = {
  'Dockerfile': 'FROM node:20-alpine\nEXPOSE 3000\nCMD ["node", "index.js"]\n',
  'package.json': JSON.stringify({
    name: 'my-app',
    scripts: { start: 'node index.js' },
    dependencies: { express: '^4.18.0' },
  }),
  'src/index.ts': [
    "import express from 'express';",
    'const app = express();',
    "app.get('/', (_req, res) => res.send('ok'));",
    'app.listen(3000);',
    '',
  ].join('\n'),
};

/** Express + S3 SDK with no bucket env var anywhere. */
const s3NoBucketFixture: FileTree = {
  ...expressFixture,
  'package.json': JSON.stringify({
    name: 'my-app',
    scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
    dependencies: {
      express: '^4.18.0',
      pg: '^8.12.0',
      'drizzle-orm': '^0.36.0',
      '@aws-sdk/client-s3': '^3.500.0',
    },
  }),
};

/** Express + S3 SDK with the bucket var declared in the env sample — binding resolved. */
const s3WithBucketFixture: FileTree = {
  ...s3NoBucketFixture,
  '.env.example': 'PORT=3000\nDATABASE_URL=postgresql://localhost:5432/mydb\nAWS_S3_BUCKET=my-bucket\n',
};

/** Express + a worker library (bull) with no declared worker command. */
const workerNoCommandFixture: FileTree = {
  ...expressFixture,
  'package.json': JSON.stringify({
    name: 'my-app',
    scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
    dependencies: { express: '^4.18.0', pg: '^8.12.0', 'drizzle-orm': '^0.36.0', bull: '^4.12.0' },
  }),
};

/** Express + a worker library (bull) with a declared Procfile worker command. */
const workerDeclaredFixture: FileTree = {
  ...workerNoCommandFixture,
  'Procfile': 'web: node dist/index.js\nworker: node worker.js\n',
};

/** Rich fixture exercising every evidence section: Postgres, S3, Redis. */
const richFixture: FileTree = {
  ...s3WithBucketFixture,
  'package.json': JSON.stringify({
    name: 'my-app',
    scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
    dependencies: {
      express: '^4.18.0',
      pg: '^8.12.0',
      'drizzle-orm': '^0.36.0',
      '@aws-sdk/client-s3': '^3.500.0',
      ioredis: '^5.4.0',
    },
  }),
};

function analyse(tree: FileTree): AnalysisResult {
  return analyseRepo(tree);
}

/** True when some ambiguity maps to the given legacy question string. */
function mapsToQuestion(tree: FileTree, analysis: AnalysisResult, question: string): boolean {
  return deriveAmbiguities(tree, analysis).some((a) => legacyQuestionString(a) === question);
}

// ==========================================================================
// Legacy question-string parity (each old collectUnresolvedQuestions case)
// ==========================================================================

describe('ambiguity mapping parity with the legacy question strings', () => {
  it('maps multiple-dockerfiles to DOCKERFILE_TARGET', () => {
    const tree: FileTree = {
      ...expressFixture,
      'services/worker/Dockerfile': 'FROM node:20-alpine\nCMD ["node", "worker.js"]\n',
    };
    const analysis = analyse(tree);
    const ambiguities = deriveAmbiguities(tree, analysis);
    expect(ambiguities).toEqual([{ kind: 'DOCKERFILE_TARGET', detail: expect.any(String) }]);
    expect(mapsToQuestion(tree, analysis, 'multiple-dockerfiles')).toBe(true);
    expect(collectUnresolvedQuestions(tree, analysis)).toEqual(['multiple-dockerfiles']);
  });

  it('maps monorepo-target to DOCKERFILE_TARGET', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({ name: 'root', private: true }),
      'apps/a/package.json': JSON.stringify({ name: 'a', scripts: { start: 'node a.js' } }),
      'apps/b/package.json': JSON.stringify({ name: 'b', scripts: { start: 'node b.js' } }),
      'apps/c/package.json': JSON.stringify({ name: 'c', scripts: { start: 'node c.js' } }),
    };
    const analysis = analyse(tree);
    expect(mapsToQuestion(tree, analysis, 'monorepo-target')).toBe(true);
    expect(collectUnresolvedQuestions(tree, analysis)).toContain('monorepo-target');
  });

  it('maps start-command-unknown to START_COMMAND', () => {
    const tree: FileTree = { 'package.json': JSON.stringify({ name: 'x', dependencies: {} }) };
    const analysis = analyse(tree);
    expect(mapsToQuestion(tree, analysis, 'start-command-unknown')).toBe(true);
    expect(collectUnresolvedQuestions(tree, analysis)).toContain('start-command-unknown');
  });

  it('maps build-command-unknown to BUILD_COMMAND', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({
        name: 'x',
        packageManager: 'pnpm@9.0.0',
        scripts: { start: 'node index.js' },
      }),
    };
    const analysis = analyse(tree);
    expect(mapsToQuestion(tree, analysis, 'build-command-unknown')).toBe(true);
    expect(collectUnresolvedQuestions(tree, analysis)).toContain('build-command-unknown');
  });

  it('maps port-unknown to PORT', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({ name: 'x', scripts: { start: 'node index.js' } }),
    };
    const analysis = analyse(tree);
    expect(mapsToQuestion(tree, analysis, 'port-unknown')).toBe(true);
    expect(collectUnresolvedQuestions(tree, analysis)).toContain('port-unknown');
  });

  it('maps database-requirement-unclear to DATABASE_BINDING', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({
        name: 'x',
        scripts: { start: 'node index.js' },
        dependencies: { pg: '^8.12.0' },
      }),
    };
    const analysis = analyse(tree);
    expect(mapsToQuestion(tree, analysis, 'database-requirement-unclear')).toBe(true);
    expect(collectUnresolvedQuestions(tree, analysis)).toContain('database-requirement-unclear');
  });

  it('maps redis-requirement-unclear to REDIS_BINDING', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({
        name: 'x',
        scripts: { start: 'node index.js' },
        dependencies: { redis: '^4.6.0' },
      }),
    };
    const analysis = analyse(tree);
    expect(analysis.metadata['redis']).toMatchObject({ confidence: 'medium' });
    expect(mapsToQuestion(tree, analysis, 'redis-requirement-unclear')).toBe(true);
    expect(collectUnresolvedQuestions(tree, analysis)).toContain('redis-requirement-unclear');
  });

  it('never maps the newer kinds to a legacy question string', () => {
    const tree = noMigrationFixture;
    const analysis = analyse(tree);
    const kinds = deriveAmbiguities(tree, analysis).map((a) => a.kind);
    expect(kinds).toEqual(['MIGRATION_STRATEGY']);
    expect(collectUnresolvedQuestions(tree, analysis)).toEqual([]);
  });
});

// ==========================================================================
// New producers fire only when genuinely unresolved
// ==========================================================================

describe('deriveAmbiguities — new producers', () => {
  it('produces zero ambiguities for a fully-resolved express app', () => {
    const analysis = analyse(expressFixture);
    expect(deriveAmbiguities(expressFixture, analysis)).toEqual([]);
    expect(collectUnresolvedQuestions(expressFixture, analysis)).toEqual([]);
  });

  it('fires MIGRATION_STRATEGY when Postgres is required but no migration command resolved', () => {
    const analysis = analyse(noMigrationFixture);
    expect((analysis.metadata['postgres'] as { required: boolean }).required).toBe(true);
    expect(analysis.metadata['hasMigrationCommand']).toBe(false);
    const ambiguities = deriveAmbiguities(noMigrationFixture, analysis);
    expect(ambiguities).toEqual([{ kind: 'MIGRATION_STRATEGY', detail: expect.any(String) }]);
  });

  it('does not fire MIGRATION_STRATEGY when a migration command exists', () => {
    const analysis = analyse(expressFixture);
    expect(deriveAmbiguities(expressFixture, analysis).some((a) => a.kind === 'MIGRATION_STRATEGY')).toBe(false);
  });

  it('fires HEALTH_PATH when no health path evidence exists (default /health assumed)', () => {
    const analysis = analyse(noHealthFixture);
    expect(analysis.metadata['hasHealthEndpoint']).toBe(false);
    const ambiguities = deriveAmbiguities(noHealthFixture, analysis);
    expect(ambiguities).toEqual([{ kind: 'HEALTH_PATH', detail: expect.any(String) }]);
  });

  it('does not fire HEALTH_PATH when a health check was found', () => {
    const analysis = analyse(expressFixture);
    expect(deriveAmbiguities(expressFixture, analysis).some((a) => a.kind === 'HEALTH_PATH')).toBe(false);
  });

  it('fires STORAGE_BINDING when storage is required but no bucket var evidence exists', () => {
    const analysis = analyse(s3NoBucketFixture);
    expect(analysis.metadata['usesS3']).toBe(true);
    const ambiguities = deriveAmbiguities(s3NoBucketFixture, analysis);
    expect(ambiguities).toEqual([{ kind: 'STORAGE_BINDING', detail: expect.any(String) }]);
  });

  it('does not fire STORAGE_BINDING when a bucket var is declared', () => {
    const analysis = analyse(s3WithBucketFixture);
    expect(deriveAmbiguities(s3WithBucketFixture, analysis).some((a) => a.kind === 'STORAGE_BINDING')).toBe(false);
  });

  it('fires ARCHITECTURE_REQUIREMENT when worker code is detected but no command resolves it', () => {
    const analysis = analyse(workerNoCommandFixture);
    expect(analysis.metadata['hasWorkerProcesses']).toBe(true);
    const ambiguities = deriveAmbiguities(workerNoCommandFixture, analysis);
    expect(ambiguities).toEqual([{ kind: 'ARCHITECTURE_REQUIREMENT', detail: expect.any(String) }]);
  });

  it('does not fire ARCHITECTURE_REQUIREMENT when a worker command is declared', () => {
    const analysis = analyse(workerDeclaredFixture);
    expect(
      deriveAmbiguities(workerDeclaredFixture, analysis).some((a) => a.kind === 'ARCHITECTURE_REQUIREMENT'),
    ).toBe(false);
  });
});

// ==========================================================================
// analyseRepo wiring + determinism
// ==========================================================================

describe('analyseRepo ambiguity wiring', () => {
  it('stores metadata.ambiguities equal to a fresh deriveAmbiguities call', () => {
    const analysis = analyse(noMigrationFixture);
    const expected = deriveAmbiguities(noMigrationFixture, analysis);
    expect(analysis.metadata['ambiguities']).toEqual(expected);
  });

  it('stores an empty ambiguity list on a fully-resolved repo', () => {
    const analysis = analyse(expressFixture);
    expect(analysis.metadata['ambiguities']).toEqual([]);
  });

  it('is deterministic: same tree yields the same ambiguity list', () => {
    for (const tree of [expressFixture, noMigrationFixture, noHealthFixture, richFixture]) {
      const first: AnalysisAmbiguity[] = analyse(tree).metadata['ambiguities'] as AnalysisAmbiguity[];
      const second: AnalysisAmbiguity[] = analyse(tree).metadata['ambiguities'] as AnalysisAmbiguity[];
      expect(first).toEqual(second);
      expect(deriveAmbiguities(tree, analyse(tree))).toEqual(first);
    }
  });
});

// ==========================================================================
// collectRepositoryEvidence shape
// ==========================================================================

describe('collectRepositoryEvidence', () => {
  it('maps the rich fixture into the expected read-model shape', () => {
    const analysis = analyse(richFixture);
    const evidence = collectRepositoryEvidence(richFixture, analysis);

    expect(evidence.application).toEqual({
      name: 'my-app',
      framework: 'express',
      packageManager: null,
      dockerfilePath: 'Dockerfile',
      port: '3000',
      healthPath: '/health',
    });

    expect(evidence.environment).toEqual(
      expect.arrayContaining([
        { sourcePath: '.env.example', type: 'env', value: 'DATABASE_URL', confidence: 'high' },
        { sourcePath: '.env.example', type: 'env', value: 'PORT', confidence: 'high' },
        { sourcePath: '.env.example', type: 'env', value: 'AWS_S3_BUCKET', confidence: 'high' },
      ]),
    );

    // Postgres is required here, so every database item carries high confidence.
    expect(evidence.database.length).toBeGreaterThan(0);
    for (const item of evidence.database) {
      expect(item.type).toBe('postgres');
      expect(item.confidence).toBe('high');
      expect(Object.keys(richFixture)).toContain(item.sourcePath);
    }
    expect(evidence.database).toEqual(
      expect.arrayContaining([
        { sourcePath: 'package.json', type: 'postgres', value: expect.stringContaining('pg dependency'), confidence: 'high' },
        { sourcePath: '.env.example', type: 'postgres', value: expect.stringContaining('DATABASE_URL'), confidence: 'high' },
      ]),
    );

    // ioredis alone is a medium-confidence signal.
    expect(evidence.redis).toEqual([
      { sourcePath: 'package.json', type: 'redis', value: 'ioredis dependency in package.json', confidence: 'medium' },
    ]);

    // The declared bucket var maps into the storage section.
    expect(evidence.storage).toEqual([
      { sourcePath: '.env.example', type: 'bucket-var', value: 'AWS_S3_BUCKET', confidence: 'high' },
    ]);
  });

  it('leaves storage empty when S3 is not in play, and healthPath null when no health evidence exists', () => {
    const noHealth = analyse(noHealthFixture);
    expect(collectRepositoryEvidence(noHealthFixture, noHealth).storage).toEqual([]);
    expect(collectRepositoryEvidence(noHealthFixture, noHealth).application.healthPath).toBeNull();
  });

  it('is deterministic: same tree yields the same evidence read-model', () => {
    const first = collectRepositoryEvidence(richFixture, analyse(richFixture));
    const second = collectRepositoryEvidence(richFixture, analyse(richFixture));
    expect(first).toEqual(second);
  });
});
