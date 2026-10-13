/**
 * Captures immutable fix-instructions input snapshots for pinned benchmark
 * repositories, using the production analysis path.
 *
 *   tsx scripts/remediation-benchmark/capture.ts                 every repository cases.yaml lists
 *   tsx scripts/remediation-benchmark/capture.ts --repo repo-003 one (or several --repo) entries
 *
 * Writes docs/testing/remediation-benchmark/snapshots/<id>.json.
 * A failed analysis, or a value that looks like a secret, is reported and
 * not written. Exit code 1 when any entry was not written.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { ANALYSIS_VERSION } from '@deployz/api/analysis';

import { openAnalysisSession } from '../repository-compatibility/analyse.js';
import { loadBenchmark, selectEntries } from '../repository-compatibility/manifest.js';
import { createSnapshotFetch, resolveGithubToken } from '../repository-compatibility/snapshot.js';

import { SNAPSHOT_DIR, loadBenchmark as loadCases } from './cases.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..', '..');
const BENCHMARK_PATH = join(REPO_ROOT, 'docs', 'testing', 'repository-compatibility', 'benchmark.yaml');
const CACHE_DIR = join(REPO_ROOT, 'docs', 'testing', 'repository-compatibility', '.cache');

const EXCLUDED_METADATA_KEYS = new Set(['application', 'fixInstructions']);

function sortedTopLevel(metadata: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(metadata).sort()) {
    if (!EXCLUDED_METADATA_KEYS.has(key)) sorted[key] = metadata[key];
  }
  return sorted;
}

/** Strings that look like a secret value: a long run of token characters with mixed character classes. */
function findSecretLikeStrings(value: unknown, path = '$'): string[] {
  if (typeof value === 'string') {
    const tokenLike = /^[A-Za-z0-9+/_=-]{32,}$/.test(value);
    const mixed = /[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value);
    return tokenLike && mixed ? [path] : [];
  }
  if (Array.isArray(value)) return value.flatMap((item, index) => findSecretLikeStrings(item, `${path}[${index}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => findSecretLikeStrings(item, `${path}.${key}`));
  }
  return [];
}

async function main(): Promise<number> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { repo: { type: 'string', multiple: true } }, strict: true });
  const ids = values.repo && values.repo.length > 0 ? values.repo : loadCases().repositories.map((repo) => repo.id);
  const entries = selectEntries(loadBenchmark(BENCHMARK_PATH), { ids });

  const fetchFn = createSnapshotFetch({ cacheDir: CACHE_DIR, token: resolveGithubToken(), offline: false });
  const session = await openAnalysisSession(fetchFn);
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  let unwritten = 0;
  try {
    for (const entry of entries) {
      let raw = await session.analyse(entry);
      if (raw.status !== 'analysed') raw = await session.analyse(entry);
      if (raw.status !== 'analysed') {
        console.log(`${entry.id} ${entry.repository} FAILED: ${raw.failure ?? 'unknown'}`);
        unwritten += 1;
        continue;
      }
      const { row } = raw;
      const detectedMetadata = sortedTopLevel(row.detectedMetadata ?? {});
      const suspicious = findSecretLikeStrings(detectedMetadata);
      if (suspicious.length > 0) {
        console.log(`${entry.id} ${entry.repository} NOT WRITTEN, secret-like strings at: ${suspicious.join(', ')}`);
        unwritten += 1;
        continue;
      }
      const snapshot = {
        id: entry.id,
        repository: entry.repository,
        commit: entry.commit,
        analysisVersion: ANALYSIS_VERSION,
        source: {
          repoFullName: row.repoFullName,
          containerPort: row.containerPort,
          healthPath: row.healthPath,
          migrationCommand: row.migrationCommand,
          redisRequired: row.redisRequired,
          workerCommand: row.workerCommand,
          detectedMetadata,
        },
      };
      writeFileSync(join(SNAPSHOT_DIR, `${entry.id}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
      console.log(`${entry.id} ${entry.repository} written`);
    }
  } finally {
    await session.close();
  }
  return unwritten > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
