import { describe, expect, it } from 'vitest';

import { analyseRepo } from '../src/analyser.js';
import type { AnalysisResult } from '../src/analyser.js';
import type { FileTree } from '../src/detectors.js';
import { buildReadinessReport, verdictFromReadiness, type ReadinessReport } from '../src/readiness-report.js';

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

/** No health endpoint. */
const noHealthTree: FileTree = {
  ...readyTree,
  'Dockerfile': 'FROM node:20-alpine\nEXPOSE 3000\nCMD ["node", "dist/index.js"]\n',
  'src/index.ts':
    "import express from 'express';\nconst app = express();\napp.get('/', (_req, res) => res.send('ok'));\napp.listen(3000);\n",
};

/** PostgreSQL detected, but no migration command — a bare driver only (no
 *  independent evidence), so `postgres.required` is false → confidence
 *  'needs_confirmation'. */
const noMigrationTree: FileTree = {
  ...readyTree,
  'package.json': JSON.stringify({
    name: 'ready-app',
    scripts: { start: 'node dist/index.js' },
    dependencies: { express: '^4.18.0', pg: '^8.12.0' },
  }),
};

/** PostgreSQL detected with independent evidence (a DATABASE_URL env var), no
 *  migration command → `postgres.required` true → confidence 'likely'. */
const noMigrationRequiredPostgresTree: FileTree = {
  ...readyTree,
  '.env.example': 'DATABASE_URL=postgresql://localhost:5432/mydb\n',
  'package.json': JSON.stringify({
    name: 'ready-app',
    scripts: { start: 'node dist/index.js' },
    dependencies: { express: '^4.18.0', pg: '^8.12.0' },
  }),
};

/** No database at all — the missing-migration finding must never fire. */
const noPostgresTree: FileTree = {
  ...readyTree,
  'package.json': JSON.stringify({
    name: 'ready-app',
    scripts: { start: 'node dist/index.js' },
    dependencies: { express: '^4.18.0' },
  }),
};

/** Worker-like code (bullmq) with a resolved "worker" start script. */
const workerWithCommandTree: FileTree = {
  ...readyTree,
  'package.json': JSON.stringify({
    name: 'ready-app',
    scripts: {
      start: 'node dist/index.js',
      'db:migrate': 'npx drizzle-kit push',
      worker: 'node dist/worker.js',
    },
    dependencies: { express: '^4.18.0', pg: '^8.12.0', bullmq: '^5.0.0' },
  }),
};

/** Worker-like code with NO resolved start command. */
const workerWithoutCommandTree: FileTree = {
  ...readyTree,
  'package.json': JSON.stringify({
    name: 'ready-app',
    scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
    dependencies: { express: '^4.18.0', pg: '^8.12.0', bullmq: '^5.0.0' },
  }),
};

/** Persistent local filesystem usage — blocking, and must be excluded from passed checks. */
const localFsTree: FileTree = {
  ...readyTree,
  'src/uploader.ts':
    "import fs from 'fs';\nexport function save(path: string, data: string) { fs.writeFileSync(path, data); }\n",
};

/** MySQL dependency — a §10 rejection. */
const mysqlTree: FileTree = {
  ...readyTree,
  'package.json': JSON.stringify({
    name: 'ready-app',
    scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
    dependencies: { express: '^4.18.0', pg: '^8.12.0', mysql2: '^3.9.0' },
  }),
};

const JARGON_REGEX = /\b(CloudFormation|IAM|ECS|ALB|Lambda|VPC|CFN|RDS)\b/i;

// ==========================================================================
// State calculation
// ==========================================================================

describe('buildReadinessReport — state calculation', () => {
  it('READY: no required findings at all', () => {
    const report = buildReadinessReport(analyseRepo(readyTree));
    expect(report.state).toBe('READY');
    expect(report.requiredCount).toBe(0);
  });

  it('ALMOST_READY: a fixable-required finding (container-setup), no blocking finding', () => {
    const report = buildReadinessReport(analyseRepo(noDockerfileTree));
    expect(report.state).toBe('ALMOST_READY');
    expect(report.requiredCount).toBe(1);
    expect(report.findings.some((f) => f.id === 'container-setup')).toBe(true);
  });

  it('ALMOST_READY: a fixable-required finding (health-check), no blocking finding', () => {
    const report = buildReadinessReport(analyseRepo(noHealthTree));
    expect(report.state).toBe('ALMOST_READY');
    expect(report.findings.some((f) => f.id === 'health-check')).toBe(true);
  });

  it('NEEDS_CHANGES: any blocking required finding (§10 rejection)', () => {
    const report = buildReadinessReport(analyseRepo(mysqlTree));
    expect(report.state).toBe('NEEDS_CHANGES');
  });

  it('NEEDS_CHANGES: local filesystem persistence is blocking', () => {
    const report = buildReadinessReport(analyseRepo(localFsTree));
    expect(report.state).toBe('NEEDS_CHANGES');
    expect(report.findings.find((f) => f.id === 'local-file-storage')?.blocking).toBe(true);
  });

  it('NEEDS_CHANGES wins over a simultaneous fixable-required finding', () => {
    const tree: FileTree = { ...mysqlTree };
    delete tree['Dockerfile'];
    const report = buildReadinessReport(analyseRepo(tree));
    expect(report.state).toBe('NEEDS_CHANGES');
    // Both findings are still present — NEEDS_CHANGES just outranks ALMOST_READY.
    expect(report.findings.some((f) => f.id === 'container-setup')).toBe(true);
  });

  it('RECOMMENDED findings never block READY', () => {
    // Postgres detected, no migration command (recommended) — still READY.
    const report = buildReadinessReport(analyseRepo(noMigrationTree));
    expect(report.state).toBe('READY');
    expect(report.recommendedCount).toBeGreaterThan(0);
  });
});

// ==========================================================================
// Required vs recommended classification, blocking vs fixable
// ==========================================================================

describe('buildReadinessReport — finding classification', () => {
  it('§10 rejections are required + blocking', () => {
    const report = buildReadinessReport(analyseRepo(mysqlTree));
    const finding = report.findings.find((f) => f.id === 'unsupported-database-mysql');
    expect(finding?.severity).toBe('required');
    expect(finding?.blocking).toBe(true);
    expect(finding?.confidence).toBe('confirmed');
  });

  it('local filesystem persistence is required + blocking + confirmed', () => {
    const report = buildReadinessReport(analyseRepo(localFsTree));
    const finding = report.findings.find((f) => f.id === 'local-file-storage');
    expect(finding?.severity).toBe('required');
    expect(finding?.blocking).toBe(true);
    expect(finding?.confidence).toBe('confirmed');
  });

  it('container-setup is required + fixable (not blocking) + confirmed', () => {
    const report = buildReadinessReport(analyseRepo(noDockerfileTree));
    const finding = report.findings.find((f) => f.id === 'container-setup');
    expect(finding?.severity).toBe('required');
    expect(finding?.blocking).toBe(false);
    expect(finding?.confidence).toBe('confirmed');
  });

  it('health-check is required + fixable (not blocking) + likely', () => {
    const report = buildReadinessReport(analyseRepo(noHealthTree));
    const finding = report.findings.find((f) => f.id === 'health-check');
    expect(finding?.severity).toBe('required');
    expect(finding?.blocking).toBe(false);
    expect(finding?.confidence).toBe('likely');
  });

  it('database-migrations is recommended, never blocking', () => {
    const report = buildReadinessReport(analyseRepo(noMigrationTree));
    const finding = report.findings.find((f) => f.id === 'database-migrations');
    expect(finding?.severity).toBe('recommended');
    expect(finding?.blocking).toBe(false);
  });

  it('worker-command is recommended, never blocking', () => {
    const report = buildReadinessReport(analyseRepo(workerWithoutCommandTree), {
      workerCommandResolved: false,
    });
    const finding = report.findings.find((f) => f.id === 'worker-command');
    expect(finding?.severity).toBe('recommended');
    expect(finding?.blocking).toBe(false);
  });
});

// ==========================================================================
// Migration finding — only with postgres, confidence variants
// ==========================================================================

describe('buildReadinessReport — database-migrations finding', () => {
  it('never fires for a repository with no database', () => {
    const report = buildReadinessReport(analyseRepo(noPostgresTree));
    expect(report.findings.some((f) => f.id === 'database-migrations')).toBe(false);
  });

  it('never fires when a migration command is present', () => {
    const report = buildReadinessReport(analyseRepo(readyTree));
    expect(report.findings.some((f) => f.id === 'database-migrations')).toBe(false);
  });

  it('fires with confidence "needs_confirmation" when postgres.required is false', () => {
    const analysis = analyseRepo(noMigrationTree);
    expect((analysis.metadata['postgres'] as { required: boolean }).required).toBe(false);
    const report = buildReadinessReport(analysis);
    const finding = report.findings.find((f) => f.id === 'database-migrations');
    expect(finding).toBeDefined();
    expect(finding?.confidence).toBe('needs_confirmation');
  });

  it('fires with confidence "likely" when postgres.required is true', () => {
    const analysis = analyseRepo(noMigrationRequiredPostgresTree);
    expect((analysis.metadata['postgres'] as { required: boolean }).required).toBe(true);
    const report = buildReadinessReport(analysis);
    const finding = report.findings.find((f) => f.id === 'database-migrations');
    expect(finding).toBeDefined();
    expect(finding?.confidence).toBe('likely');
  });
});

// ==========================================================================
// Worker finding — gated on workerCommandResolved
// ==========================================================================

describe('buildReadinessReport — worker-command finding', () => {
  it('never fires when no worker-like code is detected', () => {
    const report = buildReadinessReport(analyseRepo(readyTree), { workerCommandResolved: false });
    expect(report.findings.some((f) => f.id === 'worker-command')).toBe(false);
  });

  it('fires when worker-like code is detected and no start command resolved', () => {
    const report = buildReadinessReport(analyseRepo(workerWithoutCommandTree), {
      workerCommandResolved: false,
    });
    expect(report.findings.some((f) => f.id === 'worker-command')).toBe(true);
  });

  it('fires when worker-like code is detected and context is omitted entirely', () => {
    const report = buildReadinessReport(analyseRepo(workerWithoutCommandTree));
    expect(report.findings.some((f) => f.id === 'worker-command')).toBe(true);
  });

  it('does not fire when worker-like code is detected AND a start command resolved', () => {
    const report = buildReadinessReport(analyseRepo(workerWithCommandTree), {
      workerCommandResolved: true,
    });
    expect(report.findings.some((f) => f.id === 'worker-command')).toBe(false);
  });
});

// ==========================================================================
// Passed-check collection
// ==========================================================================

describe('buildReadinessReport — passed checks', () => {
  it('excludes local-filesystem even when detected (it is a negative signal)', () => {
    const report = buildReadinessReport(analyseRepo(localFsTree));
    expect(report.passed.some((p) => p.id === 'local-filesystem')).toBe(false);
  });

  it('includes worker only when a start command resolved (workerCommandResolved: true)', () => {
    const report = buildReadinessReport(analyseRepo(workerWithCommandTree), {
      workerCommandResolved: true,
    });
    expect(report.passed.some((p) => p.id === 'worker')).toBe(true);
  });

  it('excludes worker from passed checks when no start command resolved', () => {
    const report = buildReadinessReport(analyseRepo(workerWithoutCommandTree), {
      workerCommandResolved: false,
    });
    expect(report.passed.some((p) => p.id === 'worker')).toBe(false);
  });

  it('includes detected positive-signal checks (dockerfile, framework, health-endpoint)', () => {
    const report = buildReadinessReport(analyseRepo(readyTree));
    expect(report.passed.some((p) => p.id === 'dockerfile')).toBe(true);
    expect(report.passed.some((p) => p.id === 'framework')).toBe(true);
    expect(report.passed.some((p) => p.id === 'health-endpoint')).toBe(true);
  });
});

// ==========================================================================
// Counts and summary strings
// ==========================================================================

describe('buildReadinessReport — counts and summary', () => {
  it('requiredCount/recommendedCount match the findings actually present', () => {
    const report = buildReadinessReport(analyseRepo(noMigrationTree));
    const required = report.findings.filter((f) => f.severity === 'required').length;
    const recommended = report.findings.filter((f) => f.severity === 'recommended').length;
    expect(report.requiredCount).toBe(required);
    expect(report.recommendedCount).toBe(recommended);
  });

  it('required findings sort before recommended findings', () => {
    const tree: FileTree = { ...noMigrationTree };
    delete tree['Dockerfile'];
    const report = buildReadinessReport(analyseRepo(tree));
    const severities = report.findings.map((f) => f.severity);
    expect(severities).toContain('required');
    expect(severities).toContain('recommended');
    const firstRecommendedIndex = severities.indexOf('recommended');
    expect(severities.slice(0, firstRecommendedIndex).every((s) => s === 'required')).toBe(true);
  });

  it('summary strings are exactly the three documented state summaries', () => {
    expect(buildReadinessReport(analyseRepo(readyTree)).summary).toBe(
      'This app can be deployed through Deployz.',
    );
    expect(buildReadinessReport(analyseRepo(noDockerfileTree)).summary).toBe(
      'Deployz found a few things to address before this app can be deployed reliably.',
    );
    expect(buildReadinessReport(analyseRepo(mysqlTree)).summary).toBe(
      'This app needs changes before Deployz can deploy it.',
    );
  });
});

// ==========================================================================
// Finding copy is jargon-free
// ==========================================================================

describe('buildReadinessReport — jargon-free copy', () => {
  it('no finding exposes CloudFormation/IAM/ECS/ALB/Lambda/VPC/CFN/RDS terms', () => {
    // Exercise every finding this module can produce in one pass.
    const trees = [
      mysqlTree,
      localFsTree,
      noDockerfileTree,
      noHealthTree,
      noMigrationTree,
      noMigrationRequiredPostgresTree,
      workerWithoutCommandTree,
    ];
    const allFindings = trees.flatMap((tree) => buildReadinessReport(analyseRepo(tree)).findings);
    expect(allFindings.length).toBeGreaterThan(0);
    for (const finding of allFindings) {
      expect(finding.plainEnglishExplanation).not.toMatch(JARGON_REGEX);
      expect(finding.title).not.toMatch(JARGON_REGEX);
      expect(finding.whyItMatters).not.toMatch(JARGON_REGEX);
    }
  });
});

// ==========================================================================
// verdictFromReadiness mapping
// ==========================================================================

describe('verdictFromReadiness', () => {
  it('maps READY → READY', () => {
    expect(verdictFromReadiness('READY')).toBe('READY');
  });

  it('maps ALMOST_READY → NEEDS_ATTENTION', () => {
    expect(verdictFromReadiness('ALMOST_READY')).toBe('NEEDS_ATTENTION');
  });

  it('maps NEEDS_CHANGES → NOT_COMPATIBLE', () => {
    expect(verdictFromReadiness('NEEDS_CHANGES')).toBe('NOT_COMPATIBLE');
  });
});

// ==========================================================================
// Determinism
// ==========================================================================

describe('buildReadinessReport — determinism', () => {
  it('same input twice → deep-equal output', () => {
    const analysis = analyseRepo(mysqlTree);
    const first = buildReadinessReport(analysis);
    const second = buildReadinessReport(analysis);
    expect(second).toEqual(first);
  });

  it('same input twice with context → deep-equal output', () => {
    const analysis = analyseRepo(workerWithoutCommandTree);
    const context = { workerCommandResolved: false };
    const first: ReadinessReport = buildReadinessReport(analysis, context);
    const second: ReadinessReport = buildReadinessReport(analysis, context);
    expect(second).toEqual(first);
  });
});
