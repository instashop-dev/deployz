/**
 * Jev offline evaluation harness — runs the requirements shadow verifier and
 * the UNKNOWN-failure classifier across the Stage A compatibility corpus and
 * the Stage B failure records, offline, with stratified summaries.
 *
 *   pnpm jev:eval                                every corpus repository
 *   pnpm jev:eval --repo repo-001                one (or several --repo) entries
 *   pnpm jev:eval --set unseen                   one benchmark set
 *   pnpm jev:eval --offline                      cached snapshots only, no GitHub
 *   pnpm jev:eval --fixture                      deterministic canned answers, no Jev
 *   pnpm jev:eval --failures                     replay the Stage B failure records
 *   pnpm jev:eval --plan                         dry-run: selection, sizes, call count
 *   pnpm jev:eval --no-write                     print the summary, write nothing
 *
 * Labels come ONLY from benchmark.yaml `expected` facts — never from the
 * analyser. A real client needs JEV_ENABLED/JEV_GATEWAY_URL/JEV_API_KEY;
 * without them the default mode fails fast (--fixture and --plan need no
 * credentials). Cost guards: --max-calls (default 150) caps the Jev calls per
 * invocation, --delay-ms (default 250) spaces them, and a repository whose
 * run file already carries the same evidence fingerprint and both schema
 * versions is resumed, not re-asked.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  JEV_DECISION_SET_VERSION,
  JEV_EVIDENCE_SCHEMA_VERSION,
  JEV_FAILURE_DECISION_SET_VERSION,
  JEV_FAILURE_EVIDENCE_SCHEMA_VERSION,
  buildJevFailureEvidence,
  createFixtureJevClient,
  createJevClient,
  runJevFailureClassification,
  runJevRequirementsShadow,
  type JevClient,
  type JevFailureEvidenceInput,
} from '@deployz/analysis';
import { ANALYSIS_VERSION } from '@deployz/api/analysis';
import { resolveJevConfig } from '@deployz/api/ai-config';
import { buildFileTreeForAnalysis, parseRepoFullName, type FetchFn } from '@deployz/api/github';
import { deriveJevShadowInputs, sharedJevCircuitBreaker } from '@deployz/api/jev-shadow';

import { openAnalysisSession, type AnalysisSession, type ApplicationRow } from '../repository-compatibility/analyse.js';
import { loadBenchmark, selectEntries, type BenchmarkEntry } from '../repository-compatibility/manifest.js';
import { BENCHMARK_PATH } from '../repository-compatibility/index.js';
import { BENCHMARK_INSTALLATION_TOKEN, createSnapshotFetch, resolveGithubToken } from '../repository-compatibility/snapshot.js';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..', '..');
export const EVAL_DIR = join(REPO_ROOT, 'docs', 'testing', 'jev-shadow');
export const RUNS_DIR = join(EVAL_DIR, 'runs');
export const FAILURE_RUNS_DIR = join(RUNS_DIR, 'failures');
export const DEPLOYMENT_RUNS_DIR = join(REPO_ROOT, 'docs', 'testing', 'repository-deployment', 'runs');
export const DEFAULT_CACHE_DIR = join(REPO_ROOT, 'docs', 'testing', 'repository-compatibility', '.cache');

export const DEFAULT_MAX_CALLS = 150;
export const DEFAULT_DELAY_MS = 250;

/** The decisions the corpus carries labels for. */
const LABELLED_DECISIONS = ['postgres', 'redis', 'storage'] as const;
type LabelledDecision = (typeof LABELLED_DECISIONS)[number];
type Bucket = 'A' | 'B' | 'C' | 'D' | 'E';

export interface EvalOptions {
  ids: string[];
  set: string | undefined;
  offline: boolean;
  write: boolean;
  cacheDir: string;
  failures: boolean;
  fixture: boolean;
  plan: boolean;
  maxCalls: number;
  delayMs: number;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseEvalArgs(argv: readonly string[]): EvalOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      repo: { type: 'string', multiple: true },
      set: { type: 'string' },
      offline: { type: 'boolean', default: false },
      'no-write': { type: 'boolean', default: false },
      cache: { type: 'string' },
      failures: { type: 'boolean', default: false },
      fixture: { type: 'boolean', default: false },
      plan: { type: 'boolean', default: false },
      'max-calls': { type: 'string' },
      'delay-ms': { type: 'string' },
    },
    strict: true,
  });
  return {
    ids: values.repo ?? [],
    set: values.set,
    offline: values.offline ?? false,
    write: !(values['no-write'] ?? false),
    cacheDir: values.cache ? resolve(values.cache) : DEFAULT_CACHE_DIR,
    failures: values.failures ?? false,
    fixture: values.fixture ?? false,
    plan: values.plan ?? false,
    maxCalls: parsePositiveInt(values['max-calls'], DEFAULT_MAX_CALLS),
    delayMs: parsePositiveInt(values['delay-ms'], DEFAULT_DELAY_MS),
  };
}

function deployzSha(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

// ── Client selection ─────────────────────────────────────────────────────────

/** The real client from the environment; a clear error when unconfigured. */
function createRealClient(): JevClient {
  const config = resolveJevConfig(process.env);
  if (!config.enabled || config.baseUrl === undefined || config.apiKey === undefined) {
    throw new Error(
      'Jev is not configured: set JEV_ENABLED=true, JEV_GATEWAY_URL and JEV_API_KEY in .env, or pass --fixture / --plan.',
    );
  }
  return createJevClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    gatewayToken: config.gatewayToken,
    timeoutMs: config.timeoutMs,
    breaker: sharedJevCircuitBreaker(),
  });
}

/** A deterministic 0–1 stream seeded by a string (dry-run plumbing only). */
function seededRandom(seed: string): () => number {
  const digest = createHash('sha256').update(seed).digest();
  let state = digest.readUInt32BE(0) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const rounded = (rand: () => number): number => Math.round(rand() * 100) / 100;

function choiceAnswer(rand: () => number, options: readonly string[]): { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number } {
  const probabilities = Object.fromEntries(options.map((option) => [option, rounded(rand)]));
  const choice = options.reduce((best, option) => (probabilities[option]! > probabilities[best]! ? option : best), options[0]!);
  return { type: 'choice', choice, probabilities, confidence: rounded(rand) };
}

/**
 * The per-case fixture client: canned answers derived from the case's seed
 * (the repo's expected-facts hash), so a --fixture run is deterministic and
 * exercises the full plumbing without a live model.
 */
export function createFixtureClientFor(seed: string): JevClient {
  const rand = seededRandom(seed);
  return createFixtureJevClient({
    'requirements-shadow': {
      model: 'jev-fixture',
      usage: { input_tokens: 0, output_tokens: 0 },
      answers: {
        postgres: { type: 'noul', noul: rounded(rand) },
        redis: { type: 'noul', noul: rounded(rand) },
        storage: { type: 'noul', noul: rounded(rand) },
        publicHttp: { type: 'noul', noul: rounded(rand) },
        worker: { type: 'noul', noul: rounded(rand) },
        missingDependency: choiceAnswer(rand, ['none', 'database', 'cache', 'storage', 'other']),
        evidenceConflict: choiceAnswer(rand, ['none', 'possible', 'clear']),
        internalConsistency: choiceAnswer(rand, ['consistent', 'contradictory']),
        planConsistency: choiceAnswer(rand, ['consistent', 'contradictory', 'unclear']),
        deeperReview: {
          type: 'score',
          score: rounded(rand),
          legend: { '0': 'not-needed', '1': 'worth-review', '2': 'needed' },
          probabilities: { '0': rounded(rand), '1': rounded(rand), '2': rounded(rand) },
          confidence: rounded(rand),
        },
      },
    },
    'failure-shadow': {
      model: 'jev-fixture',
      usage: { input_tokens: 0, output_tokens: 0 },
      answers: {
        failureDomain: choiceAnswer(rand, [
          'APPLICATION',
          'CUSTOMER_CONFIGURATION',
          'AWS',
          'DEPLOYZ',
          'DEPENDENCY',
          'REGISTRY',
          'NETWORK',
          'UNKNOWN',
        ]),
        likelyTransient: { type: 'noul', noul: rounded(rand) },
        recommendedAction: choiceAnswer(rand, ['none', 'customer', 'vendor', 'deployz']),
      },
    },
  });
}

// ── Shared run context ───────────────────────────────────────────────────────

export interface EvalRunContext {
  deployzSha: string;
  analysisVersion: number;
  runsDir: string;
  maxCalls: number;
  delayMs: number;
  write: boolean;
  plan: boolean;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

interface JevCallOutcome {
  ok: boolean;
  errorKind: string | null;
  latencyMs: number | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * (sorted.length - 1)))] ?? null;
}

function confusionOutcome(saysYes: boolean, label: boolean): 'TP' | 'FP' | 'FN' | 'TN' {
  if (saysYes && label) return 'TP';
  if (saysYes) return 'FP';
  return label ? 'FN' : 'TN';
}

// ── Requirements mode (corpus) ───────────────────────────────────────────────

export interface RepoRunRecord {
  id: string;
  repository: string;
  commit: string;
  set: string;
  cohort: string;
  customerRealism: string;
  difficulty: number;
  findings: string[];
  deployzSha: string;
  analysisVersion: number;
  status: 'analysed' | 'failed' | 'skipped' | 'capped' | 'planned';
  failure: string | null;
  fingerprint: string | null;
  evidenceSchemaVersion: number | null;
  decisionSetVersion: number | null;
  deployzRequirements: { postgres: boolean; redisRequired: boolean; storageRequired: boolean } | null;
  signals: { postgresAndRedis: boolean; storage: boolean; worker: boolean } | null;
  stateChars: number | null;
  decisions: Record<string, { deployz: boolean | null; jevProbability: number; agreement: string | null }> | null;
  consistency: {
    possibleMissingRequirements: string[];
    evidenceConflict: string;
    requirementsConsistency: string;
    planConsistency: string;
    reviewSignal: { level: string; score: number; confidence: number };
    conflicts: string[];
  } | null;
  jev: JevCallOutcome | null;
  labels: Record<LabelledDecision, boolean | null>;
  labelComparison: {
    id: LabelledDecision;
    label: boolean;
    deployz: boolean;
    jevSaysYes: boolean;
    deployzOutcome: 'TP' | 'FP' | 'FN' | 'TN';
    jevOutcome: 'TP' | 'FP' | 'FN' | 'TN';
    agreement: string;
  }[] | null;
  bucket: Bucket | null;
}

/** The effective manifest-override fields of a persisted (post-backfill) application row. */
function rowOverrides(row: ApplicationRow) {
  return {
    containerPort: row.containerPort,
    healthPath: row.healthPath,
    migrationCommand: row.migrationCommand,
    workerCommand: row.workerCommand,
    databaseRequired: row.databaseRequired,
    storageRequired: row.storageRequired,
    redisRequired: row.redisRequired,
  };
}

/** A repo lands in its most significant bucket: B > C > D > E > A. */
function bucketFor(record: Pick<RepoRunRecord, 'decisions' | 'findings' | 'signals'>): Bucket | null {
  if (!record.decisions) return null;
  if (LABELLED_DECISIONS.some((id) => record.decisions?.[id]?.agreement === 'disagree')) return 'B';
  if (Object.values(record.decisions).some((decision) => decision.agreement === 'uncertain')) return 'C';
  if (record.findings.length > 0) return 'D';
  if (record.signals && (record.signals.postgresAndRedis || record.signals.storage || record.signals.worker)) return 'E';
  return 'A';
}

function emptyConfusion() {
  return { TP: 0, FP: 0, FN: 0, TN: 0 } as Record<'TP' | 'FP' | 'FN' | 'TN', number>;
}

export interface EvalSummary {
  deployzSha: string;
  analysisVersion: number;
  mode: 'requirements';
  total: number;
  analysed: number;
  failed: number;
  skipped: number;
  capped: number;
  planned: number;
  calls: { made: number; maxCalls: number; hitCap: boolean };
  buckets: Record<Bucket, { count: number; repos: string[] }>;
  decisions: Record<
    LabelledDecision,
    {
      labelled: number;
      unlabelled: number;
      unresolved: number;
      deployz: ReturnType<typeof emptyConfusion>;
      jev: ReturnType<typeof emptyConfusion>;
      agreement: { agree: number; disagree: number; uncertain: number };
    }
  >;
  byBucketDecisions: Record<Bucket, Partial<Record<LabelledDecision, { deployz: ReturnType<typeof emptyConfusion>; jev: ReturnType<typeof emptyConfusion> }>>>;
  jev: {
    ok: number;
    errors: Record<string, number>;
    latency: { p50: number | null; p90: number | null; p99: number | null };
    inputTokens: number;
    outputTokens: number;
  };
}

function decisionSummarySlot(): EvalSummary['decisions'][LabelledDecision] {
  return {
    labelled: 0,
    unlabelled: 0,
    unresolved: 0,
    deployz: emptyConfusion(),
    jev: emptyConfusion(),
    agreement: { agree: 0, disagree: 0, uncertain: 0 },
  };
}

export function buildSummary(records: readonly RepoRunRecord[], context: EvalRunContext): EvalSummary {
  const buckets = Object.fromEntries(
    (['A', 'B', 'C', 'D', 'E'] as const).map((bucket) => [bucket, { count: 0, repos: [] as string[] }]),
  ) as EvalSummary['buckets'];
  const decisions = Object.fromEntries(LABELLED_DECISIONS.map((id) => [id, decisionSummarySlot()])) as EvalSummary['decisions'];
  const byBucketDecisions = Object.fromEntries(
    (['A', 'B', 'C', 'D', 'E'] as const).map((bucket) => [bucket, {}]),
  ) as EvalSummary['byBucketDecisions'];
  const errors: Record<string, number> = {};
  const latencies: number[] = [];
  let made = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const record of records) {
    if (record.bucket !== null) {
      buckets[record.bucket].count += 1;
      buckets[record.bucket].repos.push(record.id);
    }
    if (record.jev) {
      // Only a fresh analysis spent a call; a resumed record replays its file.
      if (record.status === 'analysed') {
        made += 1;
        if (record.jev.ok) {
          latencies.push(record.jev.latencyMs ?? 0);
          inputTokens += record.jev.inputTokens ?? 0;
          outputTokens += record.jev.outputTokens ?? 0;
        } else if (record.jev.errorKind !== null) {
          errors[record.jev.errorKind] = (errors[record.jev.errorKind] ?? 0) + 1;
        }
      }
    }
    for (const id of LABELLED_DECISIONS) {
      const label = record.labels[id];
      if (label === null) {
        decisions[id].unlabelled += 1;
        continue;
      }
      const comparison = record.labelComparison?.find((entry) => entry.id === id);
      if (comparison === undefined) {
        decisions[id].unresolved += 1;
        continue;
      }
      decisions[id].labelled += 1;
      decisions[id].deployz[comparison.deployzOutcome] += 1;
      decisions[id].jev[comparison.jevOutcome] += 1;
      if (comparison.agreement === 'agree' || comparison.agreement === 'disagree' || comparison.agreement === 'uncertain') {
        decisions[id].agreement[comparison.agreement] += 1;
      }
      if (record.bucket !== null) {
        const slot = (byBucketDecisions[record.bucket][id] ??= { deployz: emptyConfusion(), jev: emptyConfusion() });
        slot.deployz[comparison.deployzOutcome] += 1;
        slot.jev[comparison.jevOutcome] += 1;
      }
    }
  }

  return {
    deployzSha: context.deployzSha,
    analysisVersion: context.analysisVersion,
    mode: 'requirements',
    total: records.length,
    analysed: records.filter((record) => record.status === 'analysed').length,
    failed: records.filter((record) => record.status === 'failed').length,
    skipped: records.filter((record) => record.status === 'skipped').length,
    capped: records.filter((record) => record.status === 'capped').length,
    planned: records.filter((record) => record.status === 'planned').length,
    calls: { made, maxCalls: context.maxCalls, hitCap: made >= context.maxCalls },
    buckets,
    decisions,
    byBucketDecisions,
    jev: {
      ok: latencies.length,
      errors,
      latency: { p50: percentile(latencies, 0.5), p90: percentile(latencies, 0.9), p99: percentile(latencies, 0.99) },
      inputTokens,
      outputTokens,
    },
  };
}

export function renderSummary(records: readonly RepoRunRecord[], summary: EvalSummary): string {
  const lines: string[] = [
    '# Jev shadow evaluation — run summary',
    '',
    `Deployz commit: \`${summary.deployzSha}\` · analysis version: ${summary.analysisVersion} · mode: ${summary.mode}`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Repositories | ${summary.total} |`,
    `| Analysed | ${summary.analysed} |`,
    `| Failed to analyse | ${summary.failed} |`,
    `| Resumed (skipped) | ${summary.skipped} |`,
    `| Capped by --max-calls | ${summary.capped} |`,
    `| Planned (--plan) | ${summary.planned} |`,
    `| Jev calls | ${summary.calls.made} / ${summary.calls.maxCalls}${summary.calls.hitCap ? ' (cap hit)' : ''} |`,
    '',
    '## Stratification',
    '',
    '| Bucket | Repositories | Members |',
    '| --- | --- | --- |',
    ...(['A', 'B', 'C', 'D', 'E'] as const).map(
      (bucket) => `| ${bucket} | ${summary.buckets[bucket].count} | ${summary.buckets[bucket].repos.join(', ') || '—'} |`,
    ),
    '',
    '## Per-decision confusion (labels from benchmark.yaml expected facts)',
    '',
    '| Decision | Labelled | Unlabelled | Unresolved | Deployz TP/FP/FN/TN | Jev TP/FP/FN/TN | Agree/Disagree/Uncertain |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...LABELLED_DECISIONS.map((id) => {
      const slot = summary.decisions[id];
      const counts = (confusion: ReturnType<typeof emptyConfusion>): string =>
        `${confusion.TP}/${confusion.FP}/${confusion.FN}/${confusion.TN}`;
      return `| ${id} | ${slot.labelled} | ${slot.unlabelled} | ${slot.unresolved} | ${counts(slot.deployz)} | ${counts(slot.jev)} | ${slot.agreement.agree}/${slot.agreement.disagree}/${slot.agreement.uncertain} |`;
    }),
    '',
    '## Jev availability and cost',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Successful calls | ${summary.jev.ok} |`,
    `| Errors | ${Object.entries(summary.jev.errors).map(([kind, count]) => `${kind}: ${count}`).join(', ') || '—'} |`,
    `| Latency p50/p90/p99 (ms) | ${summary.jev.latency.p50 ?? '—'} / ${summary.jev.latency.p90 ?? '—'} / ${summary.jev.latency.p99 ?? '—'} |`,
    `| Tokens (input/output) | ${summary.jev.inputTokens} / ${summary.jev.outputTokens} |`,
    '',
    '## Repositories',
    '',
    '| Id | Repository | Bucket | Status | Deployz (pg/redis/storage) | Labels (pg/redis/storage) |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const record of records) {
    const requirements = record.deployzRequirements
      ? `${record.deployzRequirements.postgres}/${record.deployzRequirements.redisRequired}/${record.deployzRequirements.storageRequired}`
      : '—';
    const labels = `${record.labels.postgres ?? '—'}/${record.labels.redis ?? '—'}/${record.labels.storage ?? '—'}`;
    lines.push(
      `| ${record.id} | ${record.repository}@${record.commit.slice(0, 7)} | ${record.bucket ?? '—'} | ${record.status} | ${requirements} | ${labels} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** An existing run record, when one carries the same fingerprint and versions. */
function readResumableRecord(path: string, fingerprint: string): RepoRunRecord | null {
  if (!existsSync(path)) return null;
  const existing = JSON.parse(readFileSync(path, 'utf8')) as RepoRunRecord;
  if (
    existing.fingerprint === fingerprint &&
    existing.evidenceSchemaVersion === JEV_EVIDENCE_SCHEMA_VERSION &&
    existing.decisionSetVersion === JEV_DECISION_SET_VERSION
  ) {
    return existing;
  }
  return null;
}

/**
 * Evaluate one corpus entry end to end: production analysis path → pure
 * derivation → (resume check) → one Jev call through the per-case client
 * factory. `clientFor` receives the fixture seed; tests inject a stub.
 */
export async function runRequirementEntry(
  entry: BenchmarkEntry,
  session: AnalysisSession,
  fetchFn: FetchFn,
  clientFor: (seed: string) => JevClient,
  context: EvalRunContext,
  state: { calls: number },
): Promise<RepoRunRecord> {
  const base = {
    id: entry.id,
    repository: entry.repository,
    commit: entry.commit,
    set: entry.set,
    cohort: entry.cohort,
    customerRealism: entry.customer_realism,
    difficulty: entry.difficulty,
    findings: entry.findings,
    deployzSha: context.deployzSha,
    analysisVersion: context.analysisVersion,
  };
  const labels: Record<LabelledDecision, boolean | null> = {
    postgres: entry.expected.postgres,
    redis: entry.expected.redis,
    storage: entry.expected.storage ?? null,
  };

  const raw = await session.analyse(entry);
  if (raw.status !== 'analysed') {
    return { ...base, status: 'failed', failure: raw.failure, fingerprint: null, evidenceSchemaVersion: null, decisionSetVersion: null, deployzRequirements: null, signals: null, stateChars: null, decisions: null, consistency: null, jev: null, labels, labelComparison: null, bucket: null };
  }

  const tree = await buildFileTreeForAnalysis(
    { ...parseRepoFullName(entry.repository), branch: entry.commit },
    BENCHMARK_INSTALLATION_TOKEN,
    fetchFn,
  );
  const derived = deriveJevShadowInputs({
    detectedMetadata: raw.row.detectedMetadata ?? {},
    overrides: rowOverrides(raw.row),
    analysis: raw.analysis!,
    tree,
  });
  const signals = {
    postgresAndRedis: derived.deployzRequirements.postgres && derived.deployzRequirements.redisRequired,
    storage: derived.deployzRequirements.storageRequired,
    worker: derived.evidence.workers.workerDetected,
  };
  const stateChars = JSON.stringify({
    evidence: derived.evidence,
    deployzRequirements: derived.deployzRequirements,
    planSummary: derived.planSummary,
  }).length;
  const fingerprinted = {
    ...base,
    failure: null,
    fingerprint: derived.fingerprint,
    evidenceSchemaVersion: JEV_EVIDENCE_SCHEMA_VERSION,
    decisionSetVersion: JEV_DECISION_SET_VERSION,
    deployzRequirements: derived.deployzRequirements,
    signals,
    stateChars,
    labels,
    jev: null as JevCallOutcome | null,
    decisions: null as RepoRunRecord['decisions'],
    consistency: null as RepoRunRecord['consistency'],
    labelComparison: null as RepoRunRecord['labelComparison'],
    bucket: null as Bucket | null,
  };

  const resumable = readResumableRecord(join(context.runsDir, `${entry.id}.json`), derived.fingerprint);
  if (resumable !== null && !context.plan) {
    return { ...resumable, status: 'skipped', deployzSha: context.deployzSha, analysisVersion: context.analysisVersion };
  }

  if (context.plan) {
    return { ...fingerprinted, status: 'planned' };
  }
  if (state.calls >= context.maxCalls) {
    return { ...fingerprinted, status: 'capped' };
  }

  let jev: JevCallOutcome | null = null;
  let decisions: RepoRunRecord['decisions'] = null;
  let consistency: RepoRunRecord['consistency'] = null;
  try {
    const result = await runJevRequirementsShadow(clientFor(`requirements:${entry.id}:${JSON.stringify(entry.expected)}`), {
      evidence: derived.evidence,
      fingerprint: derived.fingerprint,
      deployzRequirements: derived.deployzRequirements,
      planSummary: derived.planSummary,
    });
    state.calls += 1;
    jev = {
      ok: true,
      errorKind: null,
      latencyMs: result.latencyMs,
      model: result.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    };
    decisions = Object.fromEntries(
      Object.entries(result.decisions).map(([id, decision]) => [
        id,
        { deployz: decision.deployz, jevProbability: decision.jevProbability, agreement: decision.agreement },
      ]),
    );
    consistency = {
      possibleMissingRequirements: result.possibleMissingRequirements,
      evidenceConflict: result.evidenceConflict,
      requirementsConsistency: result.requirementsConsistency,
      planConsistency: result.planConsistency,
      reviewSignal: result.reviewSignal,
      conflicts: result.conflicts,
    };
  } catch (error) {
    state.calls += 1;
    jev = {
      ok: false,
      errorKind: (error as { kind?: string }).kind ?? 'internal',
      latencyMs: null,
      model: null,
      inputTokens: null,
      outputTokens: null,
    };
  }

  const labelComparison = LABELLED_DECISIONS.flatMap((id) => {
    const label = labels[id];
    const decision = decisions?.[id];
    if (label === null || decision === undefined || decision.deployz === null) return [];
    const jevSaysYes = decision.jevProbability >= 0.5;
    return [
      {
        id,
        label,
        deployz: decision.deployz,
        jevSaysYes,
        deployzOutcome: confusionOutcome(decision.deployz, label),
        jevOutcome: confusionOutcome(jevSaysYes, label),
        agreement: decision.agreement ?? 'unresolved',
      },
    ];
  });

  const record: RepoRunRecord = { ...fingerprinted, status: 'analysed', decisions, consistency, jev, labelComparison };
  return { ...record, bucket: bucketFor(record) };
}

export interface RequirementsRunOutput {
  records: RepoRunRecord[];
  summary: EvalSummary;
}

export async function runRequirementsEval(
  entries: readonly BenchmarkEntry[],
  session: AnalysisSession,
  fetchFn: FetchFn,
  clientFor: (seed: string) => JevClient,
  context: EvalRunContext,
): Promise<RequirementsRunOutput> {
  const state = { calls: 0 };
  const records: RepoRunRecord[] = [];
  const sleep = context.sleep ?? ((ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)));
  for (const entry of entries) {
    process.stdout.write(`${entry.id} ${entry.repository}@${entry.commit.slice(0, 7)} … `);
    const record = await runRequirementEntry(entry, session, fetchFn, clientFor, context, state);
    records.push(record);
    if (record.status === 'failed') console.log(`FAILED: ${record.failure ?? 'unknown'}`);
    else if (record.status === 'skipped') console.log('resumed');
    else if (record.status === 'capped') console.log('capped (--max-calls)');
    else if (record.status === 'planned') console.log(`planned (state ${record.stateChars} chars)`);
    else console.log(`${record.jev?.ok === true ? 'ok' : `error: ${record.jev?.errorKind}`} bucket ${record.bucket}`);
    if (record.jev !== null && state.calls < context.maxCalls && records.length < entries.length) {
      await sleep(context.delayMs);
    }
  }
  return { records, summary: buildSummary(records, context) };
}

// ── Failure replay mode ──────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export interface FailureCase {
  caseId: string;
  sourceFile: string;
  repository: string | null;
  runId: string | null;
  failureStage: string | null;
  rootCause: string | null;
  /** The record's deterministic code, when one exists — known codes replay as reference-only. */
  deterministicCode: string | null;
  referenceOnly: boolean;
  evidenceInput: JevFailureEvidenceInput;
}

/** One replayable failure case from a Stage B run record. */
function failureCaseFromFile(path: string, relativeName: string): FailureCase | null {
  const record = asRecord(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  if (asString(record['failureStage']) === undefined) return null;
  const failure = asRecord(asRecord(record['evidence'])['failure']);
  const diagnostics = asRecord(failure['diagnostics']);
  const context = asRecord(diagnostics['context']);
  const deployment = asRecord(record['deployment']);
  const timing = asRecord(record['timing']);
  const deterministicCode =
    asString(context['failureCode']) ?? asString(diagnostics['failureCode']) ?? asString(deployment['failureCode']) ?? null;

  const stage = asString(context['phase']) ?? asString(failure['point'])?.toUpperCase() ?? asString(record['failureStage'])!;
  const reason =
    asString(diagnostics['technicalDetail']) ??
    asString(context['message']) ??
    asString(failure['message']) ??
    asString(deployment['detail']) ??
    asString(record['rootCauseEvidence']) ??
    stage;
  const stoppedTasks = Array.isArray(failure['stoppedTasks']) ? failure['stoppedTasks'] : [];

  return {
    caseId: relativeName.replace(/\.json$/, ''),
    sourceFile: relativeName,
    repository: asString(record['repository']) ?? null,
    runId: asString(record['runId']) ?? null,
    failureStage: asString(record['failureStage']) ?? null,
    rootCause: asString(record['rootCause']) ?? null,
    deterministicCode,
    referenceOnly: deterministicCode !== null && deterministicCode !== 'UNKNOWN',
    evidenceInput: {
      deploymentStage: stage,
      ...(asString(deployment['stackStatus']) !== undefined ? { stackStatus: asString(deployment['stackStatus']) } : {}),
      ...(asString(context['resourceType']) !== undefined ? { failedResourceType: asString(context['resourceType']) } : {}),
      failureReason: reason,
      ...(asString(asRecord(stoppedTasks[0])['stoppedReason']) !== undefined
        ? { ecsStoppedReason: asString(asRecord(stoppedTasks[0])['stoppedReason']) }
        : {}),
      ...(asNumber(timing['totalMs']) !== undefined ? { elapsedMs: asNumber(timing['totalMs']) } : {}),
      deployzFailureCode: deterministicCode ?? 'UNKNOWN',
    },
  };
}

export function loadFailureCases(runsDir: string, filter: { ids: readonly string[]; set: string | undefined }): FailureCase[] {
  const selected = new Set(filter.ids);
  const files = [
    ...readdirSync(runsDir, { withFileTypes: true })
      .filter((dirent) => dirent.isFile() && dirent.name.endsWith('.json') && dirent.name !== 'summary.json')
      .map((dirent) => dirent.name),
    ...readdirSync(join(runsDir, 'history'), { withFileTypes: true })
      .filter((dirent) => dirent.isFile() && dirent.name.endsWith('.json'))
      .map((dirent) => `history/${dirent.name}`),
  ].sort();
  const cases: FailureCase[] = [];
  for (const relative of files) {
    const failureCase = failureCaseFromFile(join(runsDir, relative), relative);
    if (failureCase === null) continue;
    if (selected.size > 0 && !selected.has(failureCase.caseId.split('.')[0]!)) continue;
    if (filter.set !== undefined) {
      const record = asRecord(JSON.parse(readFileSync(join(runsDir, relative), 'utf8')) as unknown);
      if (record['set'] !== filter.set) continue;
    }
    cases.push(failureCase);
  }
  return cases;
}

export interface FailureRunRecord {
  caseId: string;
  sourceFile: string;
  repository: string | null;
  failureStage: string | null;
  rootCause: string | null;
  deterministicCode: string | null;
  referenceOnly: boolean;
  deployzSha: string;
  status: 'analysed' | 'skipped' | 'capped' | 'planned';
  evidenceHash: string | null;
  evidenceSchemaVersion: number | null;
  decisionSetVersion: number | null;
  stateChars: number | null;
  classification: {
    failureDomain: string;
    domainConfidence: number;
    likelyTransient: boolean;
    likelyTransientProbability: number;
    recommendedAction: string;
    actionConfidence: number;
    classificationUnclear: boolean;
  } | null;
  jev: JevCallOutcome | null;
}

export interface FailureEvalSummary {
  deployzSha: string;
  mode: 'failures';
  total: number;
  analysed: number;
  skipped: number;
  capped: number;
  planned: number;
  interesting: number;
  referenceOnly: number;
  calls: { made: number; maxCalls: number; hitCap: boolean };
  domains: Record<string, number>;
  actions: Record<string, number>;
  unclear: number;
  transient: number;
  jev: {
    ok: number;
    errors: Record<string, number>;
    latency: { p50: number | null; p90: number | null; p99: number | null };
    inputTokens: number;
    outputTokens: number;
  };
}

export function buildFailureSummary(records: readonly FailureRunRecord[], context: EvalRunContext): FailureEvalSummary {
  const errors: Record<string, number> = {};
  const domains: Record<string, number> = {};
  const actions: Record<string, number> = {};
  const latencies: number[] = [];
  let made = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let unclear = 0;
  let transient = 0;

  for (const record of records) {
    if (record.jev) {
      // Only a fresh analysis spent a call; a resumed record replays its file.
      if (record.status === 'analysed') {
        made += 1;
        if (record.jev.ok) {
          latencies.push(record.jev.latencyMs ?? 0);
          inputTokens += record.jev.inputTokens ?? 0;
          outputTokens += record.jev.outputTokens ?? 0;
        } else if (record.jev.errorKind !== null) {
          errors[record.jev.errorKind] = (errors[record.jev.errorKind] ?? 0) + 1;
        }
      }
    }
    if (record.classification) {
      domains[record.classification.failureDomain] = (domains[record.classification.failureDomain] ?? 0) + 1;
      actions[record.classification.recommendedAction] = (actions[record.classification.recommendedAction] ?? 0) + 1;
      if (record.classification.classificationUnclear) unclear += 1;
      if (record.classification.likelyTransient) transient += 1;
    }
  }

  return {
    deployzSha: context.deployzSha,
    mode: 'failures',
    total: records.length,
    analysed: records.filter((record) => record.status === 'analysed').length,
    skipped: records.filter((record) => record.status === 'skipped').length,
    capped: records.filter((record) => record.status === 'capped').length,
    planned: records.filter((record) => record.status === 'planned').length,
    interesting: records.filter((record) => !record.referenceOnly).length,
    referenceOnly: records.filter((record) => record.referenceOnly).length,
    calls: { made, maxCalls: context.maxCalls, hitCap: made >= context.maxCalls },
    domains,
    actions,
    unclear,
    transient,
    jev: {
      ok: latencies.length,
      errors,
      latency: { p50: percentile(latencies, 0.5), p90: percentile(latencies, 0.9), p99: percentile(latencies, 0.99) },
      inputTokens,
      outputTokens,
    },
  };
}

export function renderFailureSummary(records: readonly FailureRunRecord[], summary: FailureEvalSummary): string {
  const lines: string[] = [
    '# Jev failure replay — run summary',
    '',
    `Deployz commit: \`${summary.deployzSha}\` · mode: ${summary.mode}`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Cases | ${summary.total} |`,
    `| Interesting (code UNKNOWN or missing) | ${summary.interesting} |`,
    `| Reference-only (known code) | ${summary.referenceOnly} |`,
    `| Analysed | ${summary.analysed} |`,
    `| Resumed (skipped) | ${summary.skipped} |`,
    `| Capped by --max-calls | ${summary.capped} |`,
    `| Planned (--plan) | ${summary.planned} |`,
    `| Jev calls | ${summary.calls.made} / ${summary.calls.maxCalls}${summary.calls.hitCap ? ' (cap hit)' : ''} |`,
    `| Classification unclear | ${summary.unclear} |`,
    `| Likely transient | ${summary.transient} |`,
    `| Domains | ${Object.entries(summary.domains).map(([domain, count]) => `${domain}: ${count}`).join(', ') || '—'} |`,
    `| Actions | ${Object.entries(summary.actions).map(([action, count]) => `${action}: ${count}`).join(', ') || '—'} |`,
    `| Errors | ${Object.entries(summary.jev.errors).map(([kind, count]) => `${kind}: ${count}`).join(', ') || '—'} |`,
    `| Latency p50/p90/p99 (ms) | ${summary.jev.latency.p50 ?? '—'} / ${summary.jev.latency.p90 ?? '—'} / ${summary.jev.latency.p99 ?? '—'} |`,
    `| Tokens (input/output) | ${summary.jev.inputTokens} / ${summary.jev.outputTokens} |`,
    '',
    '## Cases',
    '',
    '| Case | Stage | Code | Subset | Status | Domain | Transient |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const record of records) {
    lines.push(
      `| ${record.caseId} | ${record.failureStage ?? '—'} | ${record.deterministicCode ?? '—'} | ${record.referenceOnly ? 'reference' : 'interesting'} | ${record.status} | ${record.classification?.failureDomain ?? '—'} | ${record.classification ? (record.classification.likelyTransient ? 'yes' : 'no') : '—'} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

export async function runFailureEval(
  cases: readonly FailureCase[],
  clientFor: (seed: string) => JevClient,
  context: EvalRunContext,
): Promise<{ records: FailureRunRecord[]; summary: FailureEvalSummary }> {
  const state = { calls: 0 };
  const sleep = context.sleep ?? ((ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)));
  const records: FailureRunRecord[] = [];
  for (const failureCase of cases) {
    process.stdout.write(`${failureCase.caseId} … `);
    const evidence = buildJevFailureEvidence(failureCase.evidenceInput);
    const evidenceHash = createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
    const base = {
      caseId: failureCase.caseId,
      sourceFile: failureCase.sourceFile,
      repository: failureCase.repository,
      failureStage: failureCase.failureStage,
      rootCause: failureCase.rootCause,
      deterministicCode: failureCase.deterministicCode,
      referenceOnly: failureCase.referenceOnly,
      deployzSha: context.deployzSha,
      evidenceHash,
      evidenceSchemaVersion: JEV_FAILURE_EVIDENCE_SCHEMA_VERSION,
      decisionSetVersion: JEV_FAILURE_DECISION_SET_VERSION,
      stateChars: JSON.stringify(evidence).length,
    };

    const existingPath = join(context.runsDir, 'failures', `${failureCase.caseId}.json`);
    if (!context.plan && existsSync(existingPath)) {
      const existing = JSON.parse(readFileSync(existingPath, 'utf8')) as FailureRunRecord;
      if (
        existing.evidenceHash === evidenceHash &&
        existing.evidenceSchemaVersion === JEV_FAILURE_EVIDENCE_SCHEMA_VERSION &&
        existing.decisionSetVersion === JEV_FAILURE_DECISION_SET_VERSION
      ) {
        records.push({ ...existing, status: 'skipped', deployzSha: context.deployzSha });
        console.log('resumed');
        continue;
      }
    }

    if (context.plan) {
      records.push({ ...base, status: 'planned', classification: null, jev: null });
      console.log(`planned (state ${base.stateChars} chars)`);
      continue;
    }
    if (state.calls >= context.maxCalls) {
      records.push({ ...base, status: 'capped', classification: null, jev: null });
      console.log('capped (--max-calls)');
      continue;
    }

    let jev: JevCallOutcome;
    let classification: FailureRunRecord['classification'];
    try {
      const result = await runJevFailureClassification(clientFor(`failure:${failureCase.caseId}`), { failureEvidence: evidence });
      state.calls += 1;
      jev = { ok: true, errorKind: null, latencyMs: result.latencyMs, model: result.model, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens };
      classification = {
        failureDomain: result.failureDomain,
        domainConfidence: result.domainConfidence,
        likelyTransient: result.likelyTransient,
        likelyTransientProbability: result.likelyTransientProbability,
        recommendedAction: result.recommendedAction,
        actionConfidence: result.actionConfidence,
        classificationUnclear: result.classificationUnclear,
      };
    } catch (error) {
      state.calls += 1;
      jev = { ok: false, errorKind: (error as { kind?: string }).kind ?? 'internal', latencyMs: null, model: null, inputTokens: null, outputTokens: null };
      classification = null;
    }
    records.push({ ...base, status: 'analysed', classification, jev });
    console.log(`${jev.ok ? (classification?.failureDomain ?? 'ok') : `error: ${jev.errorKind}`} (${failureCase.referenceOnly ? 'reference' : 'interesting'})`);
    if (state.calls < context.maxCalls) await sleep(context.delayMs);
  }
  return { records, summary: buildFailureSummary(records, context) };
}

// ── Output and entry point ───────────────────────────────────────────────────

export function writeRunFiles(runsDir: string, records: readonly RepoRunRecord[]): void {
  mkdirSync(runsDir, { recursive: true });
  for (const record of records) {
    writeFileSync(join(runsDir, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
  }
}

export function writeFailureRunFiles(runsDir: string, records: readonly FailureRunRecord[]): void {
  const dir = join(runsDir, 'failures');
  for (const record of records) {
    // A history case id carries its subdirectory ("history/repo-001.abc.1").
    const path = join(dir, `${record.caseId}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  }
}

export function writeSummaryFiles(runsDir: string, summaryJson: unknown, markdown: string): void {
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(join(runsDir, 'summary.json'), `${JSON.stringify(summaryJson, null, 2)}\n`);
  writeFileSync(join(runsDir, 'summary.md'), markdown);
}

async function requirementsMain(options: EvalOptions): Promise<number> {
  const benchmark = loadBenchmark(BENCHMARK_PATH);
  const entries = selectEntries(benchmark, { ids: options.ids, set: options.set });
  if (entries.length === 0) {
    console.error('No repositories selected.');
    return 1;
  }
  const realClient = options.plan ? null : options.fixture ? null : createRealClient();
  const token = options.offline ? null : resolveGithubToken();
  if (!options.offline && !token) {
    console.warn('No GitHub token (GITHUB_TOKEN or gh auth) — unauthenticated requests are limited to 60/hour.');
  }
  const fetchFn = createSnapshotFetch({ cacheDir: options.cacheDir, token, offline: options.offline });
  const context: EvalRunContext = {
    deployzSha: deployzSha(),
    analysisVersion: ANALYSIS_VERSION,
    runsDir: RUNS_DIR,
    maxCalls: options.maxCalls,
    delayMs: options.delayMs,
    write: options.write,
    plan: options.plan,
  };
  const clientFor = options.fixture ? (seed: string) => createFixtureClientFor(seed) : () => realClient!;

  const session = await openAnalysisSession(fetchFn);
  let output: RequirementsRunOutput;
  try {
    output = await runRequirementsEval(entries, session, fetchFn, clientFor, context);
  } finally {
    await session.close();
  }

  console.log(`\n${renderSummary(output.records, output.summary)}`);
  if (options.write) {
    writeRunFiles(RUNS_DIR, output.records);
    // A partial run must not overwrite the corpus-wide summary.
    if (options.ids.length === 0 && options.set === undefined) {
      writeSummaryFiles(RUNS_DIR, output.summary, renderSummary(output.records, output.summary));
    }
    console.log(`Wrote ${output.records.length} result file(s) to ${RUNS_DIR}`);
  }
  return 0;
}

async function failuresMain(options: EvalOptions): Promise<number> {
  const cases = loadFailureCases(DEPLOYMENT_RUNS_DIR, { ids: options.ids, set: options.set });
  if (cases.length === 0) {
    console.error('No failure cases selected.');
    return 1;
  }
  const realClient = options.plan ? null : options.fixture ? null : createRealClient();
  const context: EvalRunContext = {
    deployzSha: deployzSha(),
    analysisVersion: ANALYSIS_VERSION,
    runsDir: RUNS_DIR,
    maxCalls: options.maxCalls,
    delayMs: options.delayMs,
    write: options.write,
    plan: options.plan,
  };
  const clientFor = options.fixture ? (seed: string) => createFixtureClientFor(seed) : () => realClient!;

  const output = await runFailureEval(cases, clientFor, context);
  console.log(`\n${renderFailureSummary(output.records, output.summary)}`);
  if (options.write) {
    writeFailureRunFiles(RUNS_DIR, output.records);
    if (options.ids.length === 0 && options.set === undefined) {
      writeSummaryFiles(RUNS_DIR, output.summary, renderFailureSummary(output.records, output.summary));
    }
    console.log(`Wrote ${output.records.length} result file(s) to ${FAILURE_RUNS_DIR}`);
  }
  return 0;
}

async function main(): Promise<number> {
  try {
    process.loadEnvFile();
  } catch {
    // No .env in the working directory — CI and inline env vars still work.
  }
  const options = parseEvalArgs(process.argv.slice(2));
  return options.failures ? failuresMain(options) : requirementsMain(options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      // exitCode (not exit) lets fetch keep-alive sockets drain — process.exit
      // on Windows trips a libuv teardown assertion while handles are open.
      process.exitCode = code;
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
