/**
 * Per-repository result of the local Docker mode (`pnpm benchmark:deploy --local`):
 * one `<id>.local.json` per Stage A id, written atomically each time a stage
 * starts and ends, so an interrupted run leaves an exact marker for `--resume`.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { BENCHMARK_SETS, COHORTS } from '../repository-compatibility/manifest.js';

export const LOCAL_STAGES = ['gate', 'source', 'build', 'run', 'probes', 'cleanup'] as const;
export type LocalStageName = (typeof LOCAL_STAGES)[number];

export const LOCAL_STAGE_STATUSES = ['NOT_ATTEMPTED', 'IN_PROGRESS', 'PASS', 'FAIL', 'SKIPPED'] as const;
export type LocalStageStatus = (typeof LOCAL_STAGE_STATUSES)[number];

const stageSchema = z
  .object({
    status: z.enum(LOCAL_STAGE_STATUSES),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    durationMs: z.number().nullable(),
    detail: z.string().nullable(),
    evidence: z.record(z.string(), z.unknown()),
  })
  .strict();
export type LocalStage = z.infer<typeof stageSchema>;

export const localResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^repo-\d{3}$/),
    repository: z.string(),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    set: z.enum(BENCHMARK_SETS),
    cohort: z.enum(COHORTS),
    deployzCommit: z.string(),
    analysisVersion: z.number().int(),
    ai: z.record(z.string(), z.unknown()).nullable(),
    inputsHash: z.string(),
    stages: z.object(Object.fromEntries(LOCAL_STAGES.map((name) => [name, stageSchema])) as Record<LocalStageName, typeof stageSchema>).strict(),
    classification: z.string().nullable(),
    remediation: z.object({ kind: z.string(), description: z.string() }).strict().nullable(),
  })
  .strict();
export type LocalResult = z.infer<typeof localResultSchema>;

export type LocalIdentity = Pick<LocalResult, 'id' | 'repository' | 'commit' | 'set' | 'cohort' | 'deployzCommit' | 'analysisVersion' | 'ai' | 'inputsHash'>;

export function emptyLocalResult(identity: LocalIdentity): LocalResult {
  const notAttempted = (): LocalStage => ({ status: 'NOT_ATTEMPTED', startedAt: null, finishedAt: null, durationMs: null, detail: null, evidence: {} });
  return {
    schemaVersion: 1,
    ...identity,
    stages: { gate: notAttempted(), source: notAttempted(), build: notAttempted(), run: notAttempted(), probes: notAttempted(), cleanup: notAttempted() },
    classification: null,
    remediation: null,
  };
}

/** sha256 over everything that decides a result; a changed hash makes `--resume` start again. */
export function inputsHash(parts: { deployzCommit: string; commit: string; aiMode: string; config: unknown }): string {
  return createHash('sha256').update(JSON.stringify([parts.deployzCommit, parts.commit, parts.aiMode, parts.config])).digest('hex');
}

/**
 * `local-success` needs every stage to pass and no unverified probe (UNVERIFIED never counts as success; it is
 * `local-unverified`); otherwise the first failing stage; null while stages are open.
 */
export function classifyLocal(result: LocalResult): string | null {
  const failed = LOCAL_STAGES.find((name) => result.stages[name].status === 'FAIL');
  if (failed) return failed;
  if (!LOCAL_STAGES.every((name) => result.stages[name].status === 'PASS')) return null;
  const probes = result.stages.probes.evidence['probes'] as Record<string, { status?: string }> | undefined;
  return probes && Object.values(probes).some((probe) => probe.status === 'UNVERIFIED') ? 'local-unverified' : 'local-success';
}

export function localResultPath(runsDir: string, id: string): string {
  return join(runsDir, `${id}.local.json`);
}

export function writeLocalResult(runsDir: string, result: LocalResult): void {
  mkdirSync(runsDir, { recursive: true });
  const path = localResultPath(runsDir, result.id);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(localResultSchema.parse(result), null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

export function readLocalResult(runsDir: string, id: string): LocalResult | null {
  const path = localResultPath(runsDir, id);
  return existsSync(path) ? localResultSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) : null;
}

/**
 * Removes generated secret values, bearer tokens, AWS key ids, private key
 * blocks and email addresses from text that goes into a result or a summary.
 */
export function sanitizeLocal(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) if (secret.length > 0) out = out.split(secret).join('***');
  return out
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '***')
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1***')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '***')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '***');
}

function sanitizeDeep(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return sanitizeLocal(value, secrets);
  if (Array.isArray(value)) return value.map((item) => sanitizeDeep(item, secrets));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeDeep(item, secrets)]));
  return value;
}

export interface StageOutcome {
  status: 'PASS' | 'FAIL' | 'SKIPPED';
  detail: string | null;
  evidence?: Record<string, unknown>;
}

/**
 * Runs one stage: IN_PROGRESS is on disk before the work starts and the
 * outcome after it ends. A thrown error leaves the stage IN_PROGRESS, so a
 * harness failure is never a sticky FAIL and `--resume` restarts the stage.
 */
export async function recordStage(
  runsDir: string,
  result: LocalResult,
  name: LocalStageName,
  work: () => Promise<StageOutcome>,
  secrets: readonly string[] = [],
  now: () => Date = () => new Date(),
): Promise<StageOutcome> {
  const started = now();
  result.stages[name] = { status: 'IN_PROGRESS', startedAt: started.toISOString(), finishedAt: null, durationMs: null, detail: null, evidence: {} };
  writeLocalResult(runsDir, result);
  const outcome = await work();
  const finished = now();
  result.stages[name] = {
    status: outcome.status,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: finished.getTime() - started.getTime(),
    detail: outcome.detail === null ? null : sanitizeLocal(outcome.detail, secrets),
    evidence: sanitizeDeep(outcome.evidence ?? {}, secrets) as Record<string, unknown>,
  };
  result.classification = classifyLocal(result);
  writeLocalResult(runsDir, result);
  return outcome;
}

// ── Summary ─────────────────────────────────────────────────────────────────

export const LOCAL_PROBES = ['start', 'health', 'migration', 'dbWrite', 'redis', 'storage'] as const;
const PROBE_STATUSES = ['PASS', 'FAIL', 'UNVERIFIED', 'NOT_APPLICABLE'] as const;

export function isOpenStage(stage: LocalStage): boolean {
  return stage.status === 'NOT_ATTEMPTED' || stage.status === 'IN_PROGRESS';
}

export function readAllLocalResults(runsDir: string): LocalResult[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .filter((name) => /^repo-\d{3}\.local\.json$/.test(name))
    .sort()
    .map((name) => localResultSchema.parse(JSON.parse(readFileSync(join(runsDir, name), 'utf8'))));
}

export interface LocalSummary {
  schemaVersion: 1;
  repositories: number;
  classifications: Record<string, number>;
  aiModes: Record<string, number>;
  /** Per stage: attempted (not NOT_ATTEMPTED) and the count of each status. */
  stages: Record<LocalStageName, { attempted: number } & Record<LocalStageStatus, number>>;
  /** Per probe: attempted (recorded) and the count of each status. */
  probes: Record<(typeof LOCAL_PROBES)[number], { attempted: number } & Record<(typeof PROBE_STATUSES)[number], number>>;
  durations: { id: string; repository: string; classification: string | null; totalMs: number; stages: Record<LocalStageName, number | null> }[];
}

export function buildLocalSummary(results: readonly LocalResult[]): LocalSummary {
  const stages = Object.fromEntries(
    LOCAL_STAGES.map((name) => [name, { attempted: 0, ...Object.fromEntries(LOCAL_STAGE_STATUSES.map((status) => [status, 0])) }]),
  ) as unknown as LocalSummary['stages'];
  const probes = Object.fromEntries(
    LOCAL_PROBES.map((name) => [name, { attempted: 0, ...Object.fromEntries(PROBE_STATUSES.map((status) => [status, 0])) }]),
  ) as unknown as LocalSummary['probes'];
  const classifications: Record<string, number> = {};
  const aiModes: Record<string, number> = {};
  for (const result of results) {
    const classification = result.classification ?? 'incomplete';
    classifications[classification] = (classifications[classification] ?? 0) + 1;
    const mode = String(result.ai?.['mode'] ?? 'none');
    aiModes[mode] = (aiModes[mode] ?? 0) + 1;
    for (const name of LOCAL_STAGES) {
      const status = result.stages[name].status;
      if (status !== 'NOT_ATTEMPTED') stages[name].attempted += 1;
      stages[name][status] += 1;
    }
    const recorded = (result.stages.probes.evidence['probes'] ?? {}) as Record<string, { status?: string }>;
    for (const name of LOCAL_PROBES) {
      const status = recorded[name]?.status;
      if (status === 'PASS' || status === 'FAIL' || status === 'UNVERIFIED' || status === 'NOT_APPLICABLE') {
        probes[name].attempted += 1;
        probes[name][status] += 1;
      }
    }
  }
  const durations = results.map((result) => {
    const perStage = Object.fromEntries(LOCAL_STAGES.map((name) => [name, result.stages[name].durationMs])) as Record<LocalStageName, number | null>;
    return {
      id: result.id,
      repository: result.repository,
      classification: result.classification,
      totalMs: Object.values(perStage).reduce<number>((sum, ms) => sum + (ms ?? 0), 0),
      stages: perStage,
    };
  });
  return { schemaVersion: 1, repositories: results.length, classifications, aiModes, stages, probes, durations };
}

export function renderLocalSummary(summary: LocalSummary): string {
  const lines = [
    '# Local Docker run summary',
    '',
    `Repositories: ${summary.repositories}`,
    '',
    '## Classification',
    '',
    ...Object.entries(summary.classifications).sort().map(([name, count]) => `- ${name}: ${count}`),
    '',
    '## Stages',
    '',
    '| Stage | Attempted | PASS | FAIL | SKIPPED | IN_PROGRESS |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...LOCAL_STAGES.map((name) => {
      const row = summary.stages[name];
      return `| ${name} | ${row.attempted} | ${row.PASS} | ${row.FAIL} | ${row.SKIPPED} | ${row.IN_PROGRESS} |`;
    }),
    '',
    '## Probes',
    '',
    '| Probe | Attempted | PASS | FAIL | UNVERIFIED | NOT_APPLICABLE |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...LOCAL_PROBES.map((name) => {
      const row = summary.probes[name];
      return `| ${name} | ${row.attempted} | ${row.PASS} | ${row.FAIL} | ${row.UNVERIFIED} | ${row.NOT_APPLICABLE} |`;
    }),
    '',
    '## Duration per repository',
    '',
    '| Id | Repository | Classification | Total seconds |',
    '| --- | --- | --- | ---: |',
    ...summary.durations.map((row) => `| ${row.id} | ${row.repository} | ${row.classification ?? 'incomplete'} | ${(row.totalMs / 1000).toFixed(1)} |`),
    '',
  ];
  return lines.join('\n');
}

/** Writes `local-summary.{json,md}` over every `*.local.json` in the runs dir. */
export function writeLocalSummary(runsDir: string): LocalSummary {
  const summary = buildLocalSummary(readAllLocalResults(runsDir));
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(join(runsDir, 'local-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(runsDir, 'local-summary.md'), renderLocalSummary(summary));
  return summary;
}
