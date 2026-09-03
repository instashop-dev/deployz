import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openAnalysisSession, type AnalysisSession } from './analyse.js';
import { AUDIT_DIR, BENCHMARK_PATH, parseRunArgs, runEntry } from './index.js';
import { loadBenchmark, parseBenchmark, selectEntries, type BenchmarkEntry, type FindingRef } from './manifest.js';
import { classifyMismatches, compareFacts, normalizeActual, type ActualFacts } from './normalize.js';
import { buildSummary, renderSummary } from './report.js';
import {
  BENCHMARK_INSTALLATION_TOKEN,
  classifyGithubUrl,
  createSnapshotFetch,
  readCachedTree,
  snapshotCachePath,
} from './snapshot.js';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

const VALID_MANIFEST = `
version: 1
findings:
  - id: COMP-001
    type: MVP_CAPABILITY_GAP
    facts: [postgres]
repositories:
  - id: repo-001
    repository: acme/api
    commit: ${SHA}
    cohort: realistic
    set: improvement
    expected:
      compatibility: READY
      runtime: [node]
      monorepo: false
      postgres: true
      redis: false
      worker: false
    customer_realism: high
    difficulty: 2
    findings: [COMP-001]
  - id: repo-002
    repository: acme/worker
    commit: ${OTHER_SHA}
    cohort: boundary
    set: unseen
    expected:
      compatibility: NOT_COMPATIBLE
      runtime: [python]
      monorepo: false
      postgres: false
      redis: true
      worker: true
      unsupported: [kafka]
    customer_realism: medium
    difficulty: 3
`;

describe('benchmark manifest', () => {
  it('parses a valid document and applies defaults', () => {
    const benchmark = parseBenchmark(VALID_MANIFEST);
    expect(benchmark.repositories).toHaveLength(2);
    expect(benchmark.repositories[1]?.findings).toEqual([]);
    expect(benchmark.repositories[1]?.notes).toEqual([]);
    expect(benchmark.findings[0]).toEqual({ id: 'COMP-001', type: 'MVP_CAPABILITY_GAP', facts: ['postgres'] });
  });

  it('rejects a duplicate repository id', () => {
    const text = VALID_MANIFEST.replace('id: repo-002', 'id: repo-001');
    expect(() => parseBenchmark(text)).toThrow('duplicate repository id repo-001');
  });

  it('rejects a duplicate pin, a mutable ref, and an unknown finding reference', () => {
    expect(() => parseBenchmark(VALID_MANIFEST.replace(OTHER_SHA, SHA).replace('acme/worker', 'acme/api'))).toThrow(
      'duplicate repository pin',
    );
    expect(() => parseBenchmark(VALID_MANIFEST.replace(SHA, 'main'))).toThrow();
    expect(() => parseBenchmark(VALID_MANIFEST.replace('findings: [COMP-001]', 'findings: [COMP-999]'))).toThrow(
      'references unknown finding COMP-999',
    );
  });

  it('rejects an unknown finding type and an unknown expected fact', () => {
    expect(() => parseBenchmark(VALID_MANIFEST.replace('MVP_CAPABILITY_GAP', 'BUG'))).toThrow();
    expect(() => parseBenchmark(VALID_MANIFEST.replace('worker: false', 'worker: false\n      mysql: true'))).toThrow();
  });

  it('selects entries by id and set, and refuses an unknown id', () => {
    const benchmark = parseBenchmark(VALID_MANIFEST);
    expect(selectEntries(benchmark, { set: 'unseen' }).map((e) => e.id)).toEqual(['repo-002']);
    expect(selectEntries(benchmark, { ids: ['repo-001'] }).map((e) => e.id)).toEqual(['repo-001']);
    expect(selectEntries(benchmark, { ids: ['repo-001'], set: 'unseen' })).toEqual([]);
    expect(() => selectEntries(benchmark, { ids: ['repo-042'] })).toThrow('unknown repository id repo-042');
  });

  it('parses the committed benchmark and keeps its finding registry in step with findings.md', () => {
    const benchmark = loadBenchmark(BENCHMARK_PATH);
    const findingsDoc = readFileSync(join(AUDIT_DIR, 'findings.md'), 'utf8');
    const documented = new Set(findingsDoc.match(/COMP-\d{3}/g) ?? []);
    for (const finding of benchmark.findings) {
      expect(documented, `${finding.id} is in benchmark.yaml but not findings.md`).toContain(finding.id);
    }
    for (const id of documented) {
      expect(benchmark.findings.map((f) => f.id), `${id} is in findings.md but not benchmark.yaml`).toContain(id);
    }
  });
});

describe('CLI arguments', () => {
  it('parses repo, set, offline and no-write', () => {
    const options = parseRunArgs(['--repo', 'repo-001', '--repo', 'repo-002', '--set', 'unseen', '--offline', '--no-write']);
    expect(options.ids).toEqual(['repo-001', 'repo-002']);
    expect(options.set).toBe('unseen');
    expect(options.offline).toBe(true);
    expect(options.write).toBe(false);
  });

  it('refuses an unknown flag', () => {
    expect(() => parseRunArgs(['--fast'])).toThrow();
  });
});

describe('snapshot fetch', () => {
  let cacheDir: string;
  beforeAll(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'compat-cache-'));
  });
  afterAll(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('classifies the requests the analysis path makes', () => {
    expect(classifyGithubUrl('https://api.github.com/app/installations/42/access_tokens')).toEqual({ kind: 'token' });
    expect(classifyGithubUrl(`https://api.github.com/repos/acme/api/commits/${SHA}`)).toEqual({
      kind: 'head',
      owner: 'acme',
      repo: 'api',
      ref: SHA,
    });
    expect(classifyGithubUrl(`https://api.github.com/repos/acme/api/git/trees/${SHA}?recursive=1`)).toEqual({
      kind: 'tree',
      owner: 'acme',
      repo: 'api',
      ref: SHA,
    });
    expect(classifyGithubUrl('https://api.github.com/repos/acme/api/git/blobs/deadbeef')).toEqual({
      kind: 'blob',
      owner: 'acme',
      repo: 'api',
      ref: 'deadbeef',
    });
    expect(classifyGithubUrl('https://api.github.com/installation/repositories')).toEqual({ kind: 'other' });
    expect(snapshotCachePath('/c', { kind: 'blob', owner: 'acme', repo: 'api', ref: 'deadbeef' })).toBe(
      join('/c', 'acme__api', 'blobs', 'deadbeef.json'),
    );
  });

  it('answers the token and head-commit lookups locally', async () => {
    const fetchFn = createSnapshotFetch({ cacheDir, token: null, offline: true });
    const token = await fetchFn('https://api.github.com/app/installations/1/access_tokens', { method: 'POST' });
    expect(token.status).toBe(201);
    expect(await token.json()).toMatchObject({ token: BENCHMARK_INSTALLATION_TOKEN });
    const head = await fetchFn(`https://api.github.com/repos/acme/api/commits/${SHA}`);
    expect(await head.json()).toEqual({ sha: SHA });
  });

  it('fetches a tree once, caches it by sha, and serves it offline afterwards', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ tree: [{ path: 'package.json', type: 'blob', sha: 'x', size: 2 }], truncated: false }), {
        status: 200,
        headers: { 'x-ratelimit-remaining': '4999' },
      });
    }) as unknown as typeof fetch;
    const url = `https://api.github.com/repos/acme/api/git/trees/${SHA}?recursive=1`;

    const online = createSnapshotFetch({ cacheDir, token: 'secret', fetchImpl });
    expect((await online.call(null, url)).status).toBe(200);
    expect((await online.call(null, url)).status).toBe(200);
    expect(calls).toHaveLength(1);

    const offline = createSnapshotFetch({ cacheDir, token: null, offline: true });
    expect(await (await offline(url)).json()).toMatchObject({ truncated: false });
    expect(readCachedTree(cacheDir, 'acme/api', SHA)).toEqual({ entries: 1, truncated: false });
    await expect(offline(`https://api.github.com/repos/acme/api/git/blobs/missing`)).rejects.toThrow('cache miss');
  });

  it('sends the token to GitHub, never the placeholder, and does not cache failures', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: (init?.headers as Record<string, string>)['Authorization'] ?? null });
      return new Response('{"message":"Not Found"}', { status: 404 });
    }) as unknown as typeof fetch;
    const fetchFn = createSnapshotFetch({ cacheDir, token: 'ghp_real', fetchImpl });
    const url = 'https://api.github.com/repos/acme/api/git/blobs/nope';
    expect((await fetchFn(url)).status).toBe(404);
    expect((await fetchFn(url)).status).toBe(404);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.auth).toBe('Bearer ghp_real');
  });

  it('waits for the rate-limit window to reset and retries', async () => {
    const waits: number[] = [];
    let attempt = 0;
    const fetchImpl = (async () => {
      attempt += 1;
      if (attempt === 1) {
        return new Response('{"message":"rate limited"}', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1000' },
        });
      }
      return new Response('{"content":"aGk=","encoding":"base64"}', { status: 200 });
    }) as unknown as typeof fetch;
    const fetchFn = createSnapshotFetch({
      cacheDir,
      token: 't',
      fetchImpl,
      sleep: async (ms) => {
        waits.push(ms);
      },
      now: () => 990_000,
    });
    const response = await fetchFn('https://api.github.com/repos/acme/api/git/blobs/ratelimited');
    expect(response.status).toBe(200);
    expect(waits).toEqual([11_000]);
  });
});

// ── The production analysis path over an in-memory snapshot ────────────────

/** A snapshot fetch serving a fixed file tree — the same shape GitHub returns, no network. */
function inMemorySnapshot(files: Record<string, string>): typeof fetch {
  const paths = Object.keys(files);
  return (async (url: string) => {
    if (url.includes('/git/trees/')) {
      return new Response(
        JSON.stringify({
          tree: paths.map((path, index) => ({ path, type: 'blob', sha: `blob-${index}`, size: files[path]!.length })),
          truncated: false,
        }),
        { status: 200 },
      );
    }
    const index = Number(url.split('/').pop()!.replace('blob-', ''));
    const content = files[paths[index]!]!;
    return new Response(JSON.stringify({ content: Buffer.from(content).toString('base64'), encoding: 'base64' }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
}

const EXPRESS_POSTGRES_APP: Record<string, string> = {
  Dockerfile: 'FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nEXPOSE 3000\nCMD ["node", "dist/index.js"]\n',
  'package.json': JSON.stringify({
    name: 'acme-api',
    scripts: { start: 'node dist/index.js', build: 'tsc', 'db:migrate': 'prisma migrate deploy' },
    dependencies: { express: '^4.19.0', pg: '^8.12.0', '@prisma/client': '^5.0.0' },
  }),
  'prisma/schema.prisma': 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
  '.env.example': 'PORT=3000\nDATABASE_URL=postgresql://localhost:5432/app\n',
  'src/index.ts': [
    "import express from 'express';",
    'const app = express();',
    "app.get('/healthz', (_req, res) => res.json({ ok: true }));",
    'app.listen(process.env.PORT || 3000);',
  ].join('\n'),
  'package-lock.json': '{}',
};

const SQLITE_APP: Record<string, string> = {
  Dockerfile: 'FROM node:20-alpine\nCMD ["node", "server.js"]\n',
  'package.json': JSON.stringify({
    name: 'notes',
    scripts: { start: 'node server.js' },
    dependencies: { express: '^4.19.0', 'better-sqlite3': '^11.0.0' },
  }),
  'server.js': "const express = require('express');\nconst app = express();\napp.get('/health', (q, r) => r.send('ok'));\napp.listen(process.env.PORT || 8080);\n",
};

function entry(overrides: Partial<BenchmarkEntry> & { expected: BenchmarkEntry['expected'] }): BenchmarkEntry {
  return {
    id: 'repo-001',
    repository: 'acme/api',
    commit: SHA,
    cohort: 'realistic',
    set: 'improvement',
    customer_realism: 'high',
    difficulty: 1,
    findings: [],
    notes: [],
    ...overrides,
  };
}

describe('production analysis path over a snapshot', () => {
  let cacheDir: string;
  let session: AnalysisSession;
  let sqliteSession: AnalysisSession;
  let expressFacts: ActualFacts;
  let sqliteFacts: ActualFacts;

  beforeAll(async () => {
    cacheDir = mkdtempSync(join(tmpdir(), 'compat-e2e-'));
    session = await openAnalysisSession(
      createSnapshotFetch({ cacheDir, token: null, fetchImpl: inMemorySnapshot(EXPRESS_POSTGRES_APP) }),
    );
    sqliteSession = await openAnalysisSession(
      createSnapshotFetch({ cacheDir: join(cacheDir, 'sqlite'), token: null, fetchImpl: inMemorySnapshot(SQLITE_APP) }),
    );
    expressFacts = normalizeActual(
      await session.analyse(
        entry({ expected: { compatibility: 'READY', runtime: ['node'], monorepo: false, postgres: true, redis: false, worker: false } }),
      ),
    );
    sqliteFacts = normalizeActual(
      await sqliteSession.analyse(
        entry({
          id: 'repo-002',
          repository: 'acme/notes',
          commit: OTHER_SHA,
          expected: { compatibility: 'NOT_COMPATIBLE', runtime: ['node'], monorepo: false, postgres: false, redis: false, worker: false },
        }),
      ),
    );
  });

  afterAll(async () => {
    await session.close();
    await sqliteSession.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('normalizes what the real pipeline persisted and what the deployment gate says', () => {
    expect(expressFacts).toMatchObject({
      compatibility: 'READY',
      analysisVerdict: 'READY',
      readinessState: 'READY',
      runtime: 'node',
      appRoot: '.',
      dockerfilePath: 'Dockerfile',
      port: 3000,
      startCommand: 'CMD: ["node", "dist/index.js"]',
      healthDetected: true,
      healthPath: '/healthz',
      postgres: true,
      postgresDetected: true,
      redis: false,
      storage: false,
      worker: false,
      migration: true,
      migrationCommand: 'prisma migrate deploy',
      unsupported: [],
      gateFindings: [],
    });
    expect(expressFacts.unresolvedQuestions).toEqual([]);
  });

  it('collapses a rejection into its family and reports the gate verdict', () => {
    expect(sqliteFacts.compatibility).toBe('NOT_COMPATIBLE');
    expect(sqliteFacts.analysisVerdict).toBe('NOT_COMPATIBLE');
    expect(sqliteFacts.unsupported).toEqual(['sqlite']);
    expect(sqliteFacts.readinessFindings).toContain('unsupported-database-sqlite');
    expect(sqliteFacts.gateFindings).toContain('unsupported');
  });

  it('compares only the facts the expectation states, and labels verdict mismatches', () => {
    const matched = compareFacts(
      { compatibility: 'READY', runtime: ['node'], monorepo: false, postgres: true, redis: false, worker: false, healthPath: '/healthz', port: 3000 },
      expressFacts,
    );
    expect(matched.every((c) => c.match)).toBe(true);
    expect(matched.map((c) => c.fact)).toEqual(['compatibility', 'postgres', 'redis', 'worker', 'port', 'healthPath']);

    const falseRejection = compareFacts(
      { compatibility: 'READY', runtime: ['node'], monorepo: false, postgres: false, redis: false, worker: false, unsupported: [] },
      sqliteFacts,
    );
    expect(falseRejection.find((c) => c.fact === 'compatibility')).toMatchObject({ match: false, kind: 'false-rejection' });
    expect(falseRejection.find((c) => c.fact === 'unsupported')).toMatchObject({ match: false, kind: 'fact' });

    const falseAcceptance = compareFacts(
      { compatibility: 'NOT_COMPATIBLE', runtime: ['node'], monorepo: false, postgres: true, redis: false, worker: false },
      expressFacts,
    );
    expect(falseAcceptance.find((c) => c.fact === 'compatibility')).toMatchObject({ match: false, kind: 'false-acceptance' });

    const configuration = compareFacts(
      { compatibility: 'NEEDS_CONFIGURATION', runtime: ['node'], monorepo: false, postgres: true, redis: false, worker: false },
      expressFacts,
    );
    expect(configuration.find((c) => c.fact === 'compatibility')).toMatchObject({ match: false, kind: 'configuration-detection' });
  });

  it('attributes a mismatch to a registered finding, or flags it unexplained', () => {
    const registry: FindingRef[] = [{ id: 'COMP-007', type: 'CORRECTLY_UNSUPPORTED', facts: ['compatibility', 'unsupported'] }];
    const comparisons = compareFacts(
      { compatibility: 'READY', runtime: ['node'], monorepo: false, postgres: true, redis: false, worker: false },
      sqliteFacts,
    );
    const explained = classifyMismatches(comparisons, ['COMP-007'], registry);
    expect(explained.map((m) => [m.fact, m.finding?.id ?? null])).toEqual([
      ['compatibility', 'COMP-007'],
      ['postgres', null],
    ]);
    expect(explained[0]?.finding?.type).toBe('CORRECTLY_UNSUPPORTED');
    expect(classifyMismatches(comparisons, [], registry).every((m) => m.finding === null)).toBe(true);
  });

  it('produces byte-identical result records across reruns and a deterministic summary', async () => {
    const registry: FindingRef[] = [{ id: 'COMP-001', type: 'ANALYSIS_BUG', facts: ['redis'] }];
    const target = entry({
      expected: { compatibility: 'READY', runtime: ['node'], monorepo: false, postgres: true, redis: true, worker: false },
      findings: ['COMP-001'],
    });
    const context = { deployzSha: 'f'.repeat(40), analysisVersion: 6, cacheDir };
    const first = await runEntry(target, registry, session, context);
    const second = await runEntry(target, registry, session, context);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.match).toBe(false);
    expect(first.mismatches).toEqual([
      { fact: 'redis', kind: 'fact', expected: true, actual: false, finding: { id: 'COMP-001', type: 'ANALYSIS_BUG' } },
    ]);
    expect(first.tree).toEqual({ files: 6, entries: 6, truncated: false });

    const summary = buildSummary([first], context.deployzSha, 6);
    expect(summary).toMatchObject({
      total: 1,
      analysed: 1,
      failed: 0,
      verdictMatch: 1,
      verdictAccuracy: 100,
      fullMatch: 0,
      falseAcceptances: 0,
      falseRejections: 0,
      factMismatches: { redis: 1 },
      byFindingType: { ANALYSIS_BUG: 1, ANALYSIS_MISSING_SIGNAL: 0, MVP_CAPABILITY_GAP: 0, CORRECTLY_UNSUPPORTED: 0, REPO_INVALID: 0 },
      unexplained: [],
      bySet: { improvement: { total: 1, analysed: 1, verdictMatch: 1, fullMatch: 0 } },
    });
    const markdown = renderSummary([first], summary);
    expect(markdown).toBe(renderSummary([first], buildSummary([first], context.deployzSha, 6)));
    expect(markdown).toContain('| repo-001 | acme/api@aaaaaaa | realistic | READY | READY | redis (expected true, actual false) → COMP-001 ANALYSIS_BUG |');
  });

  it('records a repository the pipeline could not analyse as failed, never as a verdict', async () => {
    const empty = await openAnalysisSession(
      createSnapshotFetch({
        cacheDir: join(cacheDir, 'empty'),
        token: null,
        fetchImpl: (async () => new Response('{"message":"Git Repository is empty."}', { status: 404 })) as unknown as typeof fetch,
      }),
    );
    try {
      const result = await runEntry(
        entry({ id: 'repo-003', repository: 'acme/empty', commit: 'c'.repeat(40), expected: { compatibility: 'READY', runtime: ['node'], monorepo: false, postgres: false, redis: false, worker: false } }),
        [],
        empty,
        { deployzSha: 'f'.repeat(40), analysisVersion: 6, cacheDir },
      );
      expect(result.status).toBe('failed');
      expect(result.failure).toBe('Repository has no commits to analyze');
      expect(result.actual).toBeNull();
      expect(buildSummary([result], 'f'.repeat(40), 6)).toMatchObject({ failed: 1, analysed: 0, verdictAccuracy: 0 });
    } finally {
      await empty.close();
    }
  });
});
