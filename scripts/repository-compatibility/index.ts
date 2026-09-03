/**
 * Stage A repository-compatibility audit runner.
 *
 *   pnpm benchmark:compat                       every repository in benchmark.yaml
 *   pnpm benchmark:compat --repo repo-001       one (or several --repo) entries
 *   pnpm benchmark:compat --set unseen          one benchmark set
 *   pnpm benchmark:compat --offline             cached snapshots only, no GitHub
 *   pnpm benchmark:compat --no-write            print the summary, write nothing
 *
 * Reads docs/testing/repository-compatibility/benchmark.yaml, runs each
 * pinned snapshot through the production analysis path, compares the
 * result with the expected facts, and writes runs/<id>.json plus
 * runs/summary.{json,md}. Exit code 1 when a repository could not be
 * analysed at all; a mismatch is the audit's subject, not a failure.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { ANALYSIS_VERSION } from '@deployz/api/analysis';

import { openAnalysisSession } from './analyse.js';
import { loadBenchmark, selectEntries, type BenchmarkEntry, type FindingRef } from './manifest.js';
import { classifyMismatches, compareFacts, normalizeActual } from './normalize.js';
import { buildSummary, renderSummary, writeRunFiles, writeSummaryFiles, type RunResult } from './report.js';
import { createSnapshotFetch, readCachedTree, resolveGithubToken } from './snapshot.js';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..', '..');
export const AUDIT_DIR = join(REPO_ROOT, 'docs', 'testing', 'repository-compatibility');
export const BENCHMARK_PATH = join(AUDIT_DIR, 'benchmark.yaml');
export const RUNS_DIR = join(AUDIT_DIR, 'runs');
export const CACHE_DIR = join(AUDIT_DIR, '.cache');

export interface RunOptions {
  ids: string[];
  set: string | undefined;
  offline: boolean;
  write: boolean;
  cacheDir: string;
}

export function parseRunArgs(argv: readonly string[]): RunOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      repo: { type: 'string', multiple: true },
      set: { type: 'string' },
      offline: { type: 'boolean', default: false },
      'no-write': { type: 'boolean', default: false },
      cache: { type: 'string' },
    },
    strict: true,
  });
  return {
    ids: values.repo ?? [],
    set: values.set,
    offline: values.offline ?? false,
    write: !(values['no-write'] ?? false),
    cacheDir: values.cache ? resolve(values.cache) : CACHE_DIR,
  };
}

function deployzSha(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

/** Build the result record for one entry — the shape written to runs/<id>.json. */
export async function runEntry(
  entry: BenchmarkEntry,
  registry: readonly FindingRef[],
  session: Awaited<ReturnType<typeof openAnalysisSession>>,
  context: { deployzSha: string; analysisVersion: number; cacheDir: string },
): Promise<RunResult> {
  const raw = await session.analyse(entry);
  const cachedTree = readCachedTree(context.cacheDir, entry.repository, entry.commit);
  const base = {
    id: entry.id,
    repository: entry.repository,
    commit: entry.commit,
    set: entry.set,
    cohort: entry.cohort,
    customerRealism: entry.customer_realism,
    difficulty: entry.difficulty,
    deployzSha: context.deployzSha,
    analysisVersion: context.analysisVersion,
    tree: { files: raw.treeFiles, entries: cachedTree?.entries ?? null, truncated: cachedTree?.truncated ?? null },
    expected: entry.expected,
  };
  if (raw.status !== 'analysed') {
    return { ...base, status: 'failed', failure: raw.failure, actual: null, comparisons: [], mismatches: [], match: false };
  }
  const actual = normalizeActual(raw);
  const comparisons = compareFacts(entry.expected, actual);
  const mismatches = classifyMismatches(comparisons, entry.findings, registry);
  return { ...base, status: 'analysed', failure: null, actual, comparisons, mismatches, match: mismatches.length === 0 };
}

async function main(): Promise<number> {
  const options = parseRunArgs(process.argv.slice(2));
  const benchmark = loadBenchmark(BENCHMARK_PATH);
  const entries = selectEntries(benchmark, { ids: options.ids, set: options.set });
  if (entries.length === 0) {
    console.error('No repositories selected.');
    return 1;
  }

  const token = options.offline ? null : resolveGithubToken();
  if (!options.offline && !token) {
    console.warn('No GitHub token (GITHUB_TOKEN or gh auth) — unauthenticated requests are limited to 60/hour.');
  }
  const fetchFn = createSnapshotFetch({ cacheDir: options.cacheDir, token, offline: options.offline });
  const context = { deployzSha: deployzSha(), analysisVersion: ANALYSIS_VERSION, cacheDir: options.cacheDir };

  const session = await openAnalysisSession(fetchFn);
  const results: RunResult[] = [];
  try {
    for (const entry of entries) {
      process.stdout.write(`${entry.id} ${entry.repository}@${entry.commit.slice(0, 7)} … `);
      const result = await runEntry(entry, benchmark.findings, session, context);
      results.push(result);
      if (result.status !== 'analysed') console.log(`FAILED: ${result.failure ?? 'unknown'}`);
      else console.log(`${result.actual?.compatibility} ${result.match ? 'match' : `${result.mismatches.length} mismatch(es)`}`);
    }
  } finally {
    await session.close();
  }

  const summary = buildSummary(results, context.deployzSha, context.analysisVersion);
  console.log(`\n${renderSummary(results, summary)}`);
  if (options.write) {
    writeRunFiles(RUNS_DIR, results);
    // A partial run must not overwrite the corpus-wide summary.
    if (options.ids.length === 0 && options.set === undefined) writeSummaryFiles(RUNS_DIR, results, summary);
    console.log(`Wrote ${results.length} result file(s) to ${RUNS_DIR}`);
  }
  return summary.failed > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
