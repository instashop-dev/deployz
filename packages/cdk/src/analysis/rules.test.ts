import { describe, expect, it, vi } from 'vitest';

import { compatibilityStatusEnum } from '@deployz/db';

import { analyseRepo } from './analyser.js';
import type { AnalysisResult } from './analyser.js';
import type { FileTree } from './detectors.js';
import {
  evaluateCompatibility,
  persistVerdict,
  type CompatibilityResult,
  type CompatibilityVerdict,
  type VerdictStore,
} from './rules.js';

// ==========================================================================
// Corpus fixtures (inline file trees — no real files on disk)
// ==========================================================================

/** A fully-compatible app: Dockerfile + HEALTHCHECK + /health + PostgreSQL + migration. */
const readyTree: FileTree = {
  'Dockerfile':
    'FROM node:20-alpine\nEXPOSE 3000\nHEALTHCHECK --interval=30s CMD curl -f http://localhost:3000/health || exit 1\nCMD ["node", "dist/index.js"]\n',
  'package.json': JSON.stringify({
    name: 'ready-app',
    scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
    dependencies: { express: '^4.18.0', pg: '^8.12.0' },
  }),
  'src/index.ts':
    "import express from 'express';\nconst app = express();\napp.get('/health', (_req, res) => res.json({ ok: true }));\napp.listen(3000);\n",
};

/** No Dockerfile. */
const noDockerfileTree: FileTree = { ...readyTree };
delete noDockerfileTree['Dockerfile'];

/** No health endpoint (no HEALTHCHECK, no /health route). */
const noHealthTree: FileTree = {
  ...readyTree,
  'Dockerfile': 'FROM node:20-alpine\nEXPOSE 3000\nCMD ["node", "dist/index.js"]\n',
  'src/index.ts':
    "import express from 'express';\nconst app = express();\napp.get('/', (_req, res) => res.send('ok'));\napp.listen(3000);\n",
};

/** No migration command. */
const noMigrationTree: FileTree = {
  ...readyTree,
  'package.json': JSON.stringify({
    name: 'ready-app',
    scripts: { start: 'node dist/index.js' },
    dependencies: { express: '^4.18.0', pg: '^8.12.0' },
  }),
};

/** No PostgreSQL driver. */
const noPostgresTree: FileTree = {
  ...readyTree,
  'package.json': JSON.stringify({
    name: 'ready-app',
    scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
    dependencies: { express: '^4.18.0' },
  }),
};

/** Redis dependency. */
const redisTree: FileTree = {
  ...readyTree,
  'package.json': JSON.stringify({
    name: 'ready-app',
    scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
    dependencies: { express: '^4.18.0', pg: '^8.12.0', ioredis: '^5.4.0' },
  }),
};

/** MySQL dependency. */
const mysqlTree: FileTree = {
  ...readyTree,
  'package.json': JSON.stringify({
    name: 'ready-app',
    scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
    dependencies: { express: '^4.18.0', pg: '^8.12.0', mysql2: '^3.9.0' },
  }),
};

/** MongoDB dependency. */
const mongoTree: FileTree = {
  ...readyTree,
  'package.json': JSON.stringify({
    name: 'ready-app',
    scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
    dependencies: { express: '^4.18.0', pg: '^8.12.0', mongoose: '^8.0.0' },
  }),
};

/** Elasticsearch dependency. */
const elasticsearchTree: FileTree = {
  ...readyTree,
  'package.json': JSON.stringify({
    name: 'ready-app',
    scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
    dependencies: {
      express: '^4.18.0',
      pg: '^8.12.0',
      '@elastic/elasticsearch': '^8.0.0',
    },
  }),
};

/** Other unsupported database driver. */
const otherDbTree: FileTree = {
  ...readyTree,
  'package.json': JSON.stringify({
    name: 'ready-app',
    scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
    dependencies: { express: '^4.18.0', pg: '^8.12.0', 'cassandra-driver': '^4.7.0' },
  }),
};

/** Persistent local filesystem usage. */
const localFsTree: FileTree = {
  ...readyTree,
  'src/uploader.ts':
    "import fs from 'fs';\nexport function save(path: string, data: string) { fs.writeFileSync(path, data); }\n",
};

/** A rejection AND an attention issue both present (reject must win). */
const rejectPlusAttentionTree: FileTree = { ...redisTree };
delete rejectPlusAttentionTree['Dockerfile'];

/** Multiple §10 rejections plus missing PostgreSQL — all must be listed. */
const multiRejectTree: FileTree = {
  ...readyTree,
  'package.json': JSON.stringify({
    name: 'ready-app',
    scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
    dependencies: { express: '^4.18.0', ioredis: '^5.4.0', mongoose: '^8.0.0' },
  }),
};

/** Multiple attention issues — all must be listed. */
const multiAttentionTree: FileTree = {
  'package.json': JSON.stringify({
    scripts: { start: 'node dist/index.js' },
    dependencies: { express: '^4.18.0', pg: '^8.12.0' },
  }),
  'src/index.ts':
    "import express from 'express';\nconst app = express();\napp.get('/', (_req, res) => res.send('ok'));\napp.listen(3000);\n",
};

/** Extract stable issue codes from a result. */
function codes(result: CompatibilityResult): string[] {
  return result.issues.map((i) => i.code);
}

// ==========================================================================
// §19 verdict engine — REJECT rules
// ==========================================================================

describe('evaluateCompatibility — REJECT rules (→ NOT_COMPATIBLE)', () => {
  it('Redis dependency → NOT_COMPATIBLE (REDIS_DEPENDENCY)', () => {
    const result = evaluateCompatibility(analyseRepo(redisTree));
    expect(result.verdict).toBe('NOT_COMPATIBLE');
    expect(codes(result)).toEqual(['REDIS_DEPENDENCY']);
    expect(result.issues[0]?.severity).toBe('reject');
    expect(result.reason).toContain('Redis');
  });

  it('MySQL dependency → NOT_COMPATIBLE (MYSQL_DEPENDENCY)', () => {
    const result = evaluateCompatibility(analyseRepo(mysqlTree));
    expect(result.verdict).toBe('NOT_COMPATIBLE');
    expect(codes(result)).toContain('MYSQL_DEPENDENCY');
    expect(result.reason).toContain('MySQL');
  });

  it('MongoDB dependency → NOT_COMPATIBLE (MONGO_DEPENDENCY)', () => {
    const result = evaluateCompatibility(analyseRepo(mongoTree));
    expect(result.verdict).toBe('NOT_COMPATIBLE');
    expect(codes(result)).toContain('MONGO_DEPENDENCY');
    expect(result.reason).toContain('MongoDB');
  });

  it('Elasticsearch dependency → NOT_COMPATIBLE (ELASTICSEARCH_DEPENDENCY)', () => {
    const result = evaluateCompatibility(analyseRepo(elasticsearchTree));
    expect(result.verdict).toBe('NOT_COMPATIBLE');
    expect(codes(result)).toContain('ELASTICSEARCH_DEPENDENCY');
  });

  it('other unsupported database → NOT_COMPATIBLE (UNSUPPORTED_DATABASE)', () => {
    const result = evaluateCompatibility(analyseRepo(otherDbTree));
    expect(result.verdict).toBe('NOT_COMPATIBLE');
    expect(codes(result)).toContain('UNSUPPORTED_DATABASE');
  });

  it('no PostgreSQL → NOT_COMPATIBLE (MISSING_POSTGRESQL)', () => {
    const result = evaluateCompatibility(analyseRepo(noPostgresTree));
    expect(result.verdict).toBe('NOT_COMPATIBLE');
    expect(codes(result)).toEqual(['MISSING_POSTGRESQL']);
    expect(result.reason).toContain('PostgreSQL');
  });

  it('local filesystem usage → NOT_COMPATIBLE (LOCAL_FILESYSTEM_USAGE)', () => {
    const result = evaluateCompatibility(analyseRepo(localFsTree));
    expect(result.verdict).toBe('NOT_COMPATIBLE');
    expect(codes(result)).toEqual(['LOCAL_FILESYSTEM_USAGE']);
    expect(result.reason).toContain('filesystem');
  });

  it('lists ALL reject issues when multiple fire (§10 rejections + missing PostgreSQL)', () => {
    const result = evaluateCompatibility(analyseRepo(multiRejectTree));
    expect(result.verdict).toBe('NOT_COMPATIBLE');
    const cs = codes(result);
    expect(cs).toContain('REDIS_DEPENDENCY');
    expect(cs).toContain('MONGO_DEPENDENCY');
    expect(cs).toContain('MISSING_POSTGRESQL');
    // Reason lists every reject issue.
    expect(result.reason).toContain('Redis');
    expect(result.reason).toContain('MongoDB');
    expect(result.reason).toContain('PostgreSQL');
  });
});

// ==========================================================================
// §19 verdict engine — ATTENTION rules
// ==========================================================================

describe('evaluateCompatibility — ATTENTION rules (→ NEEDS_ATTENTION)', () => {
  it('missing Dockerfile → NEEDS_ATTENTION (MISSING_DOCKERFILE)', () => {
    const result = evaluateCompatibility(analyseRepo(noDockerfileTree));
    expect(result.verdict).toBe('NEEDS_ATTENTION');
    expect(codes(result)).toEqual(['MISSING_DOCKERFILE']);
    expect(result.issues[0]?.severity).toBe('attention');
    expect(result.reason).toBe('Missing Dockerfile');
  });

  it('missing health endpoint → NEEDS_ATTENTION (MISSING_HEALTH_ENDPOINT)', () => {
    const result = evaluateCompatibility(analyseRepo(noHealthTree));
    expect(result.verdict).toBe('NEEDS_ATTENTION');
    expect(codes(result)).toEqual(['MISSING_HEALTH_ENDPOINT']);
    expect(result.reason).toBe('Missing health endpoint');
  });

  it('missing migration command → NEEDS_ATTENTION (MISSING_MIGRATION_COMMAND)', () => {
    const result = evaluateCompatibility(analyseRepo(noMigrationTree));
    expect(result.verdict).toBe('NEEDS_ATTENTION');
    expect(codes(result)).toEqual(['MISSING_MIGRATION_COMMAND']);
    expect(result.reason).toBe('Missing migration command');
  });

  it('lists ALL attention issues when multiple are missing', () => {
    const result = evaluateCompatibility(analyseRepo(multiAttentionTree));
    expect(result.verdict).toBe('NEEDS_ATTENTION');
    expect(codes(result).sort()).toEqual(
      ['MISSING_DOCKERFILE', 'MISSING_HEALTH_ENDPOINT', 'MISSING_MIGRATION_COMMAND'].sort(),
    );
    expect(result.reason).toContain('Dockerfile');
    expect(result.reason).toContain('health endpoint');
    expect(result.reason).toContain('migration command');
  });
});

// ==========================================================================
// §19 verdict engine — READY + precedence
// ==========================================================================

describe('evaluateCompatibility — READY + verdict precedence', () => {
  it('compatible repo → READY with no issues', () => {
    const result = evaluateCompatibility(analyseRepo(readyTree));
    expect(result.verdict).toBe('READY');
    expect(result.issues).toEqual([]);
    expect(result.reason).toBe('Compatible with Deployz');
  });

  it('REJECT wins over ATTENTION (Redis + missing Dockerfile → NOT_COMPATIBLE)', () => {
    const result = evaluateCompatibility(analyseRepo(rejectPlusAttentionTree));
    expect(result.verdict).toBe('NOT_COMPATIBLE');
    // The attention issue must NOT leak into a NOT_COMPATIBLE result.
    expect(codes(result)).not.toContain('MISSING_DOCKERFILE');
    expect(codes(result)).toContain('REDIS_DEPENDENCY');
  });
});

// ==========================================================================
// §20 guard — purity invariant (AI can NEVER flip a deterministic verdict)
// ==========================================================================

describe('evaluateCompatibility — purity invariant (§20)', () => {
  it('same input → same verdict, synchronously (no AI, no randomness)', () => {
    const analysis = analyseRepo(multiRejectTree);
    const first = evaluateCompatibility(analysis);
    const second = evaluateCompatibility(analysis);
    // Deep-equal: verdict, reason, and issues are identical across calls.
    expect(second).toEqual(first);
    // The verdict is a plain value, not a Promise — nothing async (no AI call).
    expect(first).not.toBeInstanceOf(Promise);
  });

  it('deterministic across every verdict class', () => {
    for (const tree of [readyTree, noMigrationTree, redisTree]) {
      const a = evaluateCompatibility(analyseRepo(tree));
      const b = evaluateCompatibility(analyseRepo(tree));
      expect(b).toEqual(a);
    }
  });

  it('falls back to UNSUPPORTED_DEPENDENCY for unknown rejection dependencies', () => {
    const result: AnalysisResult = {
      findings: [
        { detector: 'dockerfile', detected: true },
        { detector: 'health-endpoint', detected: true },
        { detector: 'migration-command', detected: true },
        { detector: 'postgresql', detected: true },
        { detector: 'local-filesystem', detected: false },
      ],
      rejections: [
        {
          detected: true,
          dependency: 'some-unknown-db',
          reason:
            'Unsupported database driver: some-unknown-db. Deployz does not support this database.',
        },
      ],
      metadata: {},
    };
    const out = evaluateCompatibility(result);
    expect(out.verdict).toBe('NOT_COMPATIBLE');
    expect(codes(out)).toContain('UNSUPPORTED_DEPENDENCY');
  });
});

// ==========================================================================
// Verdict persistence → applications columns
// ==========================================================================

describe('persistVerdict — DB persistence', () => {
  it('writes analysisStatus=COMPLETE + READY verdict + reason + metadata', async () => {
    const update = vi.fn<VerdictStore['update']>();
    const analysis = analyseRepo(readyTree);

    await persistVerdict('app-123', analysis, { update });

    expect(update).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith('app-123', {
      analysisStatus: 'COMPLETE',
      compatibilityStatus: 'READY',
      compatibilityReason: 'Compatible with Deployz',
      detectedMetadata: analysis.metadata,
    });
  });

  it('writes NOT_COMPATIBLE verdict with the rejection reason', async () => {
    const update = vi.fn<VerdictStore['update']>();
    const analysis = analyseRepo(redisTree);

    await persistVerdict('app-456', analysis, { update });

    const [applicationId, values] = update.mock.calls[0] ?? [];
    expect(applicationId).toBe('app-456');
    expect(values?.analysisStatus).toBe('COMPLETE');
    expect(values?.compatibilityStatus).toBe('NOT_COMPATIBLE');
    expect(values?.compatibilityReason).toContain('Redis');
    expect(values?.detectedMetadata).toEqual(analysis.metadata);
  });

  it('writes NEEDS_ATTENTION verdict with the attention reason', async () => {
    const update = vi.fn<VerdictStore['update']>();
    const analysis = analyseRepo(noMigrationTree);

    await persistVerdict('app-789', analysis, { update });

    const [, values] = update.mock.calls[0] ?? [];
    expect(values?.compatibilityStatus).toBe('NEEDS_ATTENTION');
    expect(values?.compatibilityReason).toBe('Missing migration command');
  });
});

// ==========================================================================
// Enum parity with @deployz/db
// ==========================================================================

describe('CompatibilityVerdict parity with @deployz/db', () => {
  it('verdict vocabulary === compatibilityStatusEnum (no drift)', () => {
    const verdicts: CompatibilityVerdict[] = ['READY', 'NEEDS_ATTENTION', 'NOT_COMPATIBLE'];
    expect([...verdicts].sort()).toEqual([...compatibilityStatusEnum.enumValues].sort());
  });
});
