/**
 * Per-repository result of the local Docker mode (`pnpm benchmark:deploy --local`):
 * one `<id>.local.json` per Stage A id, written atomically each time a stage
 * starts and ends, so an interrupted run leaves an exact marker for `--resume`.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

/** `local-success` needs every stage to pass; otherwise the first failing stage; null while stages are open. */
export function classifyLocal(result: LocalResult): string | null {
  const failed = LOCAL_STAGES.find((name) => result.stages[name].status === 'FAIL');
  if (failed) return failed;
  return LOCAL_STAGES.every((name) => result.stages[name].status === 'PASS') ? 'local-success' : null;
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
