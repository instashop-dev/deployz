/**
 * The Stage A benchmark manifest — `docs/testing/repository-compatibility/
 * benchmark.yaml`. One entry per pinned repository snapshot with the minimal
 * expected facts the audit compares the analyser against, plus the finding
 * registry that explains every known mismatch (`COMP-xxx`).
 *
 * The schema is deliberately small: it is a list of validated expectations,
 * not an oracle framework. Facts the analyser has no model for (`runtime`,
 * `monorepo`) are recorded for corpus distribution only — see
 * `COMPARED_FACTS` in normalize.ts for what is actually compared.
 */
import { readFileSync } from 'node:fs';

import { parse } from 'yaml';
import { z } from 'zod';

/** The deployment-gate vocabulary (`evaluateManifestReadiness`). */
export const COMPATIBILITY_STATES = ['READY', 'NEEDS_CONFIGURATION', 'NOT_COMPATIBLE'] as const;
export type CompatibilityState = (typeof COMPATIBILITY_STATES)[number];

export const FINDING_TYPES = [
  'ANALYSIS_BUG',
  'ANALYSIS_MISSING_SIGNAL',
  'MVP_CAPABILITY_GAP',
  'CORRECTLY_UNSUPPORTED',
  'REPO_INVALID',
] as const;
export type FindingType = (typeof FINDING_TYPES)[number];

export const COHORTS = ['realistic', 'messy', 'boundary'] as const;
export const BENCHMARK_SETS = ['improvement', 'unseen'] as const;
export const REALISM_LEVELS = ['high', 'medium', 'low'] as const;

const FINDING_ID_REGEX = /^COMP-\d{3}$/;
const ENTRY_ID_REGEX = /^repo-\d{3}$/;
const COMMIT_SHA_REGEX = /^[0-9a-f]{40}$/;
const REPOSITORY_REGEX = /^[\w.-]+\/[\w.-]+$/;

export const expectedFactsSchema = z
  .object({
    compatibility: z.enum(COMPATIBILITY_STATES),
    runtime: z.array(z.string().min(1)).min(1),
    monorepo: z.boolean(),
    postgres: z.boolean(),
    redis: z.boolean(),
    worker: z.boolean(),
    storage: z.boolean().optional(),
    migration: z.boolean().optional(),
    appRoot: z.string().min(1).optional(),
    dockerfilePath: z.string().min(1).optional(),
    port: z.number().int().positive().optional(),
    healthPath: z.string().min(1).optional(),
    /** Unsupported families that must reject (see UNSUPPORTED_FAMILIES in normalize.ts). */
    unsupported: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type ExpectedFacts = z.infer<typeof expectedFactsSchema>;

export const benchmarkEntrySchema = z
  .object({
    id: z.string().regex(ENTRY_ID_REGEX),
    repository: z.string().regex(REPOSITORY_REGEX),
    commit: z.string().regex(COMMIT_SHA_REGEX),
    cohort: z.enum(COHORTS),
    set: z.enum(BENCHMARK_SETS),
    expected: expectedFactsSchema,
    customer_realism: z.enum(REALISM_LEVELS),
    difficulty: z.number().int().min(1).max(5),
    findings: z.array(z.string().regex(FINDING_ID_REGEX)).default([]),
    notes: z.array(z.string()).default([]),
  })
  .strict();
export type BenchmarkEntry = z.infer<typeof benchmarkEntrySchema>;

/** The machine index of a `findings.md` entry: which facts it explains. */
export const findingRefSchema = z
  .object({
    id: z.string().regex(FINDING_ID_REGEX),
    type: z.enum(FINDING_TYPES),
    facts: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type FindingRef = z.infer<typeof findingRefSchema>;

export const benchmarkSchema = z
  .object({
    version: z.literal(1),
    findings: z.array(findingRefSchema).default([]),
    repositories: z.array(benchmarkEntrySchema).default([]),
  })
  .strict();
export type Benchmark = z.infer<typeof benchmarkSchema>;

/**
 * Parse and cross-validate a benchmark document: unique entry ids, unique
 * repository pins, unique finding ids, and every entry finding reference
 * resolving to a registry entry.
 */
export function parseBenchmark(text: string): Benchmark {
  const benchmark = benchmarkSchema.parse(parse(text));

  const findingIds = new Set<string>();
  for (const finding of benchmark.findings) {
    if (findingIds.has(finding.id)) throw new Error(`duplicate finding id ${finding.id}`);
    findingIds.add(finding.id);
  }

  const ids = new Set<string>();
  const pins = new Set<string>();
  for (const entry of benchmark.repositories) {
    if (ids.has(entry.id)) throw new Error(`duplicate repository id ${entry.id}`);
    ids.add(entry.id);
    const pin = `${entry.repository}@${entry.commit}`;
    if (pins.has(pin)) throw new Error(`duplicate repository pin ${pin}`);
    pins.add(pin);
    for (const ref of entry.findings) {
      if (!findingIds.has(ref)) throw new Error(`${entry.id} references unknown finding ${ref}`);
    }
  }
  return benchmark;
}

export function loadBenchmark(path: string): Benchmark {
  return parseBenchmark(readFileSync(path, 'utf8'));
}

/** Entries selected by id and/or set; an unknown id is an error, not silence. */
export function selectEntries(
  benchmark: Benchmark,
  filter: { ids?: readonly string[] | undefined; set?: string | undefined } = {},
): BenchmarkEntry[] {
  let entries = benchmark.repositories;
  if (filter.set !== undefined) entries = entries.filter((entry) => entry.set === filter.set);
  if (filter.ids !== undefined && filter.ids.length > 0) {
    const wanted = new Set(filter.ids);
    for (const id of wanted) {
      if (!benchmark.repositories.some((entry) => entry.id === id)) throw new Error(`unknown repository id ${id}`);
    }
    entries = entries.filter((entry) => wanted.has(entry.id));
  }
  return entries;
}
