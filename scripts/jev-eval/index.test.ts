import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFixtureJevClient, type JevClient } from '@deployz/analysis';

import { openAnalysisSession, type AnalysisSession } from '../repository-compatibility/analyse.js';
import { createSnapshotFetch } from '../repository-compatibility/snapshot.js';
import type { BenchmarkEntry } from '../repository-compatibility/manifest.js';

import {
  buildFailureSummary,
  createFixtureClientFor,
  loadFailureCases,
  parseEvalArgs,
  renderFailureSummary,
  renderSummary,
  runFailureEval,
  runRequirementsEval,
  writeFailureRunFiles,
  writeRunFiles,
  writeSummaryFiles,
  type EvalRunContext,
  type FailureRunRecord,
} from './index.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const SHA_D = 'd'.repeat(40);
const SHA_E = 'e'.repeat(40);

// ── Synthetic corpus: hand-built FileTrees served by an in-memory snapshot ──

const PG_APP: Record<string, string> = {
  Dockerfile: 'FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nEXPOSE 3000\nCMD ["node", "server.js"]\n',
  'package.json': JSON.stringify({
    name: 'pg-app',
    scripts: { start: 'node server.js' },
    dependencies: { express: '^4.18.0', pg: '^8.12.0' },
  }),
  'server.js': [
    "const { Pool } = require('pg');",
    'const pool = new Pool({ connectionString: process.env.DATABASE_URL });',
    "const app = require('express')();",
    "app.get('/health', (_req, res) => res.send('ok'));",
    'app.listen(process.env.PORT || 3000);',
    '',
  ].join('\n'),
  '.env.example': 'DATABASE_URL=\n',
};

const PLAIN_APP: Record<string, string> = {
  Dockerfile: 'FROM node:20-alpine\nCOPY . .\nEXPOSE 3000\nCMD ["node", "server.js"]\n',
  'package.json': JSON.stringify({ name: 'plain-app', scripts: { start: 'node server.js' }, dependencies: { express: '^4.18.0' } }),
  'server.js': "const app = require('express')();\napp.get('/health', (_q, r) => r.send('ok'));\napp.listen(process.env.PORT || 3000);\n",
};

const PG_REDIS_APP: Record<string, string> = {
  Dockerfile: 'FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nEXPOSE 3000\nCMD ["node", "server.js"]\n',
  'package.json': JSON.stringify({
    name: 'worker-app',
    scripts: { start: 'node server.js' },
    dependencies: { express: '^4.18.0', pg: '^8.12.0', bullmq: '^5.0.0' },
  }),
  'server.js': "const app = require('express')();\napp.get('/health', (_q, r) => r.send('ok'));\napp.listen(process.env.PORT || 3000);\n",
  'queue.js': "const { Queue } = require('bullmq');\nmodule.exports = new Queue('jobs', { connection: { url: process.env.REDIS_URL } });\n",
  '.env.example': 'DATABASE_URL=\nREDIS_URL=\n',
};

/** One in-memory snapshot serving several repositories, keyed by owner/repo in the URL. */
function multiRepoSnapshot(repos: Record<string, Record<string, string>>): typeof fetch {
  return (async (url: string) => {
    const match = /\/repos\/([^/]+)\/([^/]+)\/git\/(trees|blobs)\/([^/?]+)/.exec(new URL(url).pathname)!;
    const owner = match[1]!;
    const repo = match[2]!;
    const files = repos[`${owner}/${repo}`]!;
    const paths = Object.keys(files);
    if (match[3] === 'trees') {
      return new Response(
        JSON.stringify({
          tree: paths.map((path, index) => ({ path, type: 'blob', sha: `blob-${index}`, size: files[path]!.length })),
          truncated: false,
        }),
        { status: 200 },
      );
    }
    const content = files[paths[Number(match[4]!.replace('blob-', ''))]!];
    return new Response(JSON.stringify({ content: Buffer.from(content!).toString('base64'), encoding: 'base64' }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
}

function entry(
  id: string,
  repository: string,
  commit: string,
  expected: Partial<BenchmarkEntry['expected']> & { postgres: boolean; redis: boolean },
  findings: string[] = [],
): BenchmarkEntry {
  return {
    id,
    repository,
    commit,
    cohort: 'realistic',
    set: 'improvement',
    expected: { compatibility: 'READY', runtime: ['node'], monorepo: false, worker: false, ...expected },
    customer_realism: 'high',
    difficulty: 2,
    findings,
    notes: [],
  };
}

/**
 * Repositories with hand-set labels and per-repo canned Jev answers:
 *   repo-001 pg app, label pg true,  jev agrees everywhere        → bucket A
 *   repo-002 plain,   label pg false, jev uncertain on postgres    → bucket C
 *   repo-003 pg+redis, labels true,   jev agrees everywhere        → bucket E
 *   repo-004 pg app,  label pg FALSE (wrong on purpose), jev disagrees → bucket B
 *   repo-005 plain,   label pg false, jev agrees, has a finding    → bucket D
 */
const ENTRIES: BenchmarkEntry[] = [
  entry('repo-001', 'acme/api', SHA_A, { postgres: true, redis: false }),
  entry('repo-002', 'acme/plain', SHA_B, { postgres: false, redis: false }),
  entry('repo-003', 'acme/worker', SHA_C, { postgres: true, redis: true }),
  entry('repo-004', 'acme/diff', SHA_D, { postgres: false, redis: false }),
  entry('repo-005', 'acme/hist', SHA_E, { postgres: false, redis: false }, ['COMP-001']),
];

const TREES: Record<string, Record<string, string>> = {
  'acme/api': PG_APP,
  'acme/plain': PLAIN_APP,
  'acme/worker': PG_REDIS_APP,
  'acme/diff': PG_APP,
  'acme/hist': PLAIN_APP,
};

/** Answers keyed by which repo the seed names — fixed probabilities, fully controlled. */
function answersFor(seed: string): { postgres: number; redis: number } {
  if (seed.includes('repo-002')) return { postgres: 0.4, redis: 0.05 };
  if (seed.includes('repo-004')) return { postgres: 0.05, redis: 0.05 };
  if (seed.includes('repo-005')) return { postgres: 0.05, redis: 0.05 };
  if (seed.includes('repo-003')) return { postgres: 0.9, redis: 0.9 };
  return { postgres: 0.9, redis: 0.05 };
}

/** A stub client factory: counts creations and serves per-repo fixed answers. */
function countingStubFactory(counter: { created: number }): (seed: string) => JevClient {
  return (seed: string) => {
    counter.created += 1;
    const { postgres, redis } = answersFor(seed);
    return createFixtureJevClient({
      'requirements-shadow': {
        model: 'jev-test',
        usage: { input_tokens: 10, output_tokens: 3 },
        answers: {
          postgres: { type: 'noul', noul: postgres },
          redis: { type: 'noul', noul: redis },
          storage: { type: 'noul', noul: 0.05 },
          publicHttp: { type: 'noul', noul: 0.95 },
          worker: { type: 'noul', noul: 0.05 },
          missingDependency: { type: 'choice', choice: 'none', probabilities: { none: 1 }, confidence: 0.9 },
          evidenceConflict: { type: 'choice', choice: 'none', probabilities: { none: 1 }, confidence: 0.9 },
          internalConsistency: { type: 'choice', choice: 'consistent', probabilities: { consistent: 1 }, confidence: 0.9 },
          planConsistency: { type: 'choice', choice: 'consistent', probabilities: { consistent: 1 }, confidence: 0.9 },
          deeperReview: {
            type: 'score',
            score: 0.1,
            legend: { '0': 'not-needed', '1': 'worth-review', '2': 'needed' },
            probabilities: { '0': 0.9, '1': 0.08, '2': 0.02 },
            confidence: 0.9,
          },
        },
      },
      'failure-shadow': {
        model: 'jev-test',
        usage: { input_tokens: 5, output_tokens: 2 },
        answers: {
          failureDomain: {
            type: 'choice',
            choice: 'AWS',
            probabilities: { APPLICATION: 0.1, CUSTOMER_CONFIGURATION: 0.1, AWS: 0.7, DEPLOYZ: 0.1 },
            confidence: 0.8,
          },
          likelyTransient: { type: 'noul', noul: 0.3 },
          recommendedAction: { type: 'choice', choice: 'none', probabilities: { none: 1 }, confidence: 0.7 },
        },
      },
    });
  };
}

function context(overrides: Partial<EvalRunContext> = {}): EvalRunContext {
  return {
    deployzSha: 'f'.repeat(40),
    analysisVersion: 24,
    runsDir: join(tmpdir(), `jev-eval-runs-${Math.random().toString(36).slice(2)}`),
    maxCalls: 150,
    delayMs: 0,
    write: true,
    plan: false,
    sleep: async () => {},
    ...overrides,
  };
}

describe('CLI arguments', () => {
  it('parses every flag', () => {
    const options = parseEvalArgs([
      '--repo', 'repo-001', '--set', 'unseen', '--offline', '--no-write',
      '--failures', '--fixture', '--plan', '--max-calls', '5', '--delay-ms', '10',
    ]);
    expect(options).toMatchObject({
      ids: ['repo-001'], set: 'unseen', offline: true, write: false,
      failures: true, fixture: true, plan: true, maxCalls: 5, delayMs: 10,
    });
  });

  it('applies the call-guard defaults and refuses an unknown flag', () => {
    expect(parseEvalArgs([])).toMatchObject({ maxCalls: 150, delayMs: 250 });
    expect(() => parseEvalArgs(['--fast'])).toThrow();
  });
});

describe('requirements eval (synthetic corpus, fixture client)', () => {
  let cacheDir: string;
  let session: AnalysisSession;

  beforeAll(async () => {
    cacheDir = mkdtempSync(join(tmpdir(), 'jev-eval-cache-'));
    session = await openAnalysisSession(
      createSnapshotFetch({ cacheDir, token: null, fetchImpl: multiRepoSnapshot(TREES) }),
    );
  }, 60_000);

  afterAll(async () => {
    await session.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('runs end to end: correct buckets, confusion counts, and output files', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'jev-eval-out-'));
    const counter = { created: 0 };
    const runContext = context({ runsDir });
    const { records, summary } = await runRequirementsEval(ENTRIES, session, createSnapshotFetch({ cacheDir, token: null, fetchImpl: multiRepoSnapshot(TREES) }), countingStubFactory(counter), runContext);

    // Every bucket is occupied by exactly its designed repository.
    const byId = new Map(records.map((record) => [record.id, record]));
    expect(byId.get('repo-001')?.bucket).toBe('A');
    expect(byId.get('repo-002')?.bucket).toBe('C');
    expect(byId.get('repo-003')?.bucket).toBe('E');
    expect(byId.get('repo-004')?.bucket).toBe('B');
    expect(byId.get('repo-005')?.bucket).toBe('D');
    for (const bucket of ['A', 'B', 'C', 'D', 'E'] as const) {
      expect(summary.buckets[bucket]).toMatchObject({ count: 1 });
    }

    // Deployz provisioned Postgres for api/worker/diff, the labels say diff is wrong.
    expect(byId.get('repo-004')?.deployzRequirements).toMatchObject({ postgres: true, redisRequired: false, storageRequired: false });
    expect(byId.get('repo-003')?.deployzRequirements).toMatchObject({ postgres: true, redisRequired: true });
    expect(byId.get('repo-003')?.signals).toMatchObject({ postgresAndRedis: true });

    // postgres: deployz TP/FP/FN/TN = 2/1/0/2; jev = 2/0/0/3; one disagree, one uncertain.
    expect(summary.decisions.postgres.deployz).toEqual({ TP: 2, FP: 1, FN: 0, TN: 2 });
    expect(summary.decisions.postgres.jev).toEqual({ TP: 2, FP: 0, FN: 0, TN: 3 });
    expect(summary.decisions.postgres.agreement).toEqual({ agree: 3, disagree: 1, uncertain: 1 });

    // redis: every labelled case agrees (worker is the only true label).
    expect(summary.decisions.redis.deployz).toEqual({ TP: 1, FP: 0, FN: 0, TN: 4 });
    expect(summary.decisions.redis.agreement).toEqual({ agree: 5, disagree: 0, uncertain: 0 });

    // No corpus label states storage — excluded from the confusion counts.
    expect(summary.decisions.storage).toMatchObject({ labelled: 0, unlabelled: 5 });

    expect(summary.calls).toEqual({ made: 5, maxCalls: 150, hitCap: false });
    expect(summary.jev).toMatchObject({ ok: 5, inputTokens: 50, outputTokens: 15 });
    expect(counter.created).toBe(5);

    writeRunFiles(runsDir, records);
    writeSummaryFiles(runsDir, summary, renderSummary(records, summary));
    expect(existsSync(join(runsDir, 'repo-001.json'))).toBe(true);
    expect(existsSync(join(runsDir, 'summary.json'))).toBe(true);
    const markdown = readFileSync(join(runsDir, 'summary.md'), 'utf8');
    expect(markdown).toContain('| repo-004 | acme/diff@ddddddd | B | analysed |');
    expect(markdown).toContain('| postgres | 5 | 0 | 0 | 2/1/0/2 | 2/0/0/3 | 3/1/1 |');
    rmSync(runsDir, { recursive: true, force: true });
  }, 120_000);

  it('resumes unchanged repositories without new Jev calls', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'jev-eval-resume-'));
    const counter = { created: 0 };
    const factory = countingStubFactory(counter);
    const fetchFn = createSnapshotFetch({ cacheDir, token: null, fetchImpl: multiRepoSnapshot(TREES) });
    const first = await runRequirementsEval(ENTRIES.slice(0, 2), session, fetchFn, factory, context({ runsDir }));
    writeRunFiles(runsDir, first.records);

    const second = await runRequirementsEval(ENTRIES.slice(0, 2), session, fetchFn, factory, context({ runsDir }));
    expect(second.records.every((record) => record.status === 'skipped')).toBe(true);
    expect(counter.created).toBe(2);
    expect(second.summary.calls.made).toBe(0);
    expect(second.summary.skipped).toBe(2);
    rmSync(runsDir, { recursive: true, force: true });
  }, 120_000);

  it('aborts safely at the --max-calls cap', async () => {
    const counter = { created: 0 };
    const { records, summary } = await runRequirementsEval(
      ENTRIES,
      session,
      createSnapshotFetch({ cacheDir, token: null, fetchImpl: multiRepoSnapshot(TREES) }),
      countingStubFactory(counter),
      context({ maxCalls: 2 }),
    );
    expect(records.filter((record) => record.status === 'analysed')).toHaveLength(2);
    expect(records.filter((record) => record.status === 'capped')).toHaveLength(3);
    expect(summary.calls).toEqual({ made: 2, maxCalls: 2, hitCap: true });
    expect(counter.created).toBe(2);
  }, 120_000);

  it('makes zero calls under --plan and reports estimated state sizes', async () => {
    const counter = { created: 0 };
    const { records, summary } = await runRequirementsEval(
      ENTRIES,
      session,
      createSnapshotFetch({ cacheDir, token: null, fetchImpl: multiRepoSnapshot(TREES) }),
      countingStubFactory(counter),
      context({ plan: true }),
    );
    expect(counter.created).toBe(0);
    expect(records.every((record) => record.status === 'planned')).toBe(true);
    expect(records.every((record) => (record.stateChars ?? 0) > 0)).toBe(true);
    expect(summary.planned).toBe(5);
    expect(summary.jev.ok).toBe(0);
  }, 120_000);
});

describe('fixture client determinism', () => {
  it('derives identical answers from the same seed', async () => {
    const state = { evidenceSchemaVersion: 1, deployzFailureCode: 'UNKNOWN' } as never;
    const questions = { q: { type: 'noul', instructions: 'x', criteria: { true: 'a', false: 'b' } } } as never;
    const first = createFixtureClientFor('requirements:repo-001:fixed');
    const second = createFixtureClientFor('requirements:repo-001:fixed');
    const a = await first.evaluate(state, questions, { label: 'requirements-shadow' });
    const b = await second.evaluate(state, questions, { label: 'requirements-shadow' });
    expect(JSON.stringify(b.answers)).toBe(JSON.stringify(a.answers));
  });
});

// ── Failure replay ───────────────────────────────────────────────────────────

/** A minimal Stage B run record with exactly the fields the loader reads. */
function stageBRecord(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'repo-001',
    repository: 'acme/api',
    runId: 'stage-b-run-1',
    set: 'improvement',
    failureStage: 'CONTAINER_START_ERROR',
    rootCause: null,
    timing: { totalMs: 123_456 },
    deployment: { status: 'FAIL', failureCode: null, stackStatus: 'ROLLBACK_FAILED', detail: 'install stack ROLLBACK_FAILED' },
    evidence: {
      failure: {
        point: 'install',
        message: 'install stack ROLLBACK_FAILED: no reason',
        stoppedTasks: [{ stoppedReason: 'Essential container in task exited' }],
      },
    },
    ...overrides,
  };
}

describe('failure replay', () => {
  let runsDir: string;

  beforeAll(() => {
    runsDir = mkdtempSync(join(tmpdir(), 'jev-eval-failures-'));
    writeFileSync(join(runsDir, 'repo-001.json'), JSON.stringify(stageBRecord({})));
    // Known deterministic code — replays as reference-only.
    writeFileSync(
      join(runsDir, 'repo-002.json'),
      JSON.stringify(
        stageBRecord({
          id: 'repo-002',
          deployment: { status: 'FAIL', failureCode: 'CONTAINER_START_FAILED', stackStatus: null, detail: 'task exited' },
          evidence: {
            failure: {
              point: 'deploy',
              message: 'task exited',
              diagnostics: { failureCode: 'CONTAINER_START_FAILED', technicalDetail: 'Essential container in task exited (code 1)' },
            },
          },
        }),
      ),
    );
    // History case whose refined code is explicitly UNKNOWN — the interesting subset.
    mkdirSync(join(runsDir, 'history'));
    writeFileSync(
      join(runsDir, 'history', 'repo-003.abc1234.1.json'),
      JSON.stringify(
        stageBRecord({
          id: 'repo-003',
          runId: 'stage-b-run-3',
          failureStage: 'TIMEOUT',
          evidence: {
            failure: {
              point: 'deploy',
              message: 'deployment timed out',
              diagnostics: {
                failureCode: 'UNKNOWN',
                technicalDetail: 'service never became stable',
                context: { phase: 'DEPLOY_RELEASE', failureCode: 'UNKNOWN', resourceType: 'AWS::ECS::Service' },
              },
            },
          },
        }),
      ),
    );
    // A passing run — no failureStage, never replayed.
    writeFileSync(join(runsDir, 'repo-004.json'), JSON.stringify(stageBRecord({ failureStage: null, deployment: { status: 'PASS' } })));
    writeFileSync(join(runsDir, 'summary.json'), '{}');
  }, 60_000);

  afterAll(() => {
    rmSync(runsDir, { recursive: true, force: true });
  });

  it('loads only failed records and marks the known-code subset reference-only', () => {
    const cases = loadFailureCases(runsDir, { ids: [], set: undefined });
    expect(cases.map((failureCase) => failureCase.caseId)).toEqual([
      'history/repo-003.abc1234.1',
      'repo-001',
      'repo-002',
    ]);
    expect(cases.map((failureCase) => failureCase.referenceOnly)).toEqual([false, false, true]);
    expect(cases[1]?.evidenceInput).toMatchObject({
      deploymentStage: 'INSTALL',
      deployzFailureCode: 'UNKNOWN',
      stackStatus: 'ROLLBACK_FAILED',
      ecsStoppedReason: 'Essential container in task exited',
      elapsedMs: 123_456,
    });
    expect(cases[0]?.evidenceInput).toMatchObject({ deploymentStage: 'DEPLOY_RELEASE', deployzFailureCode: 'UNKNOWN' });
    expect(cases[2]?.evidenceInput.deployzFailureCode).toBe('CONTAINER_START_FAILED');
  });

  it('replays every case through the classifier and writes records plus summary', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'jev-eval-failure-out-'));
    const counter = { created: 0 };
    const runContext = context({ runsDir: outDir });
    const { records, summary } = await runFailureEval(loadFailureCases(runsDir, { ids: [], set: undefined }), countingStubFactory(counter), runContext);

    expect(records).toHaveLength(3);
    expect(records.every((record) => record.status === 'analysed')).toBe(true);
    expect(summary).toMatchObject({ mode: 'failures', total: 3, interesting: 2, referenceOnly: 1, analysed: 3 });
    expect(summary.domains).toEqual({ AWS: 3 });
    expect(summary.calls).toEqual({ made: 3, maxCalls: 150, hitCap: false });
    const classified = records[0]?.classification;
    expect(classified).toMatchObject({ failureDomain: 'AWS', likelyTransient: false, classificationUnclear: false });
    expect(records[0]?.evidenceHash).toBeTruthy();

    writeFailureRunFiles(outDir, records);
    writeSummaryFiles(outDir, summary, renderFailureSummary(records, summary));
    expect(existsSync(join(outDir, 'failures', 'repo-001.json'))).toBe(true);
    expect(existsSync(join(outDir, 'failures', 'history', 'repo-003.abc1234.1.json'))).toBe(true);
    const markdown = readFileSync(join(outDir, 'summary.md'), 'utf8');
    expect(markdown).toContain('| repo-002 | CONTAINER_START_ERROR | CONTAINER_START_FAILED | reference | analysed | AWS |');

    // Resume: a second pass over the same output directory makes no calls.
    const resumed = await runFailureEval(loadFailureCases(runsDir, { ids: [], set: undefined }), countingStubFactory(counter), runContext);
    expect(resumed.records.every((record) => record.status === 'skipped')).toBe(true);
    expect(resumed.summary.skipped).toBe(3);

    const empty: FailureRunRecord[] = [];
    expect(buildFailureSummary(empty, runContext)).toMatchObject({ total: 0, jev: { ok: 0, latency: { p50: null } } });
    rmSync(outDir, { recursive: true, force: true });
  }, 120_000);
});
