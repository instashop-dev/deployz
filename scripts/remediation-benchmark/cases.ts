/**
 * The remediation benchmark's inputs: pinned analysis snapshots of real
 * repositories (`snapshots/<id>.json`, written by capture.ts) and the
 * labelled cases in `cases.yaml`. A case is a snapshot, optionally changed by
 * a targeted synthetic mutation, plus the expected outcome.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import type { FixInstructionsSource } from '@deployz/api/fix-instructions';
import type { ReadinessFinding, RemediationClass } from '@deployz/analysis';

const here = dirname(fileURLToPath(import.meta.url));
export const BENCHMARK_DIR = resolve(here, '..', '..', 'docs', 'testing', 'remediation-benchmark');
export const CASES_PATH = join(BENCHMARK_DIR, 'cases.yaml');
export const SNAPSHOT_DIR = join(BENCHMARK_DIR, 'snapshots');
export const RUNS_DIR = join(BENCHMARK_DIR, 'runs');

export const REMEDIATION_CLASSES: readonly RemediationClass[] = [
  'APPLICATION_FIX',
  'CONFIGURATION_FIX',
  'ALREADY_SUPPORTED',
  'DEPLOYZ_LIMITATION',
  'NEEDS_INPUT',
  'UNSUPPORTED',
];

export interface Snapshot {
  id: string;
  repository: string;
  commit: string;
  analysisVersion: number;
  source: FixInstructionsSource & { workerCommand?: string | null };
}

/** A finding a mutation adds; omitted copy fields get neutral text. */
export interface AddedFinding {
  id: string;
  severity?: ReadinessFinding['severity'];
  blocking?: boolean;
  confidence?: ReadinessFinding['confidence'];
  evidence: string;
  outcome?: string;
  question?: string;
}

export interface Mutation {
  removeFindings?: string[];
  addFindings?: AddedFinding[];
  row?: Partial<Pick<FixInstructionsSource, 'containerPort' | 'healthPath' | 'migrationCommand' | 'redisRequired'>>;
  metadata?: Record<string, unknown>;
}

export interface CaseExpectation {
  /** Expected class per finding id (every unresolved finding). */
  classes: Record<string, RemediationClass>;
  /**
   * The class after inspecting the repository at the pinned commit, when a
   * labeller did. Reported as analysis accuracy, never gated: a difference
   * from `classes` is a false positive in the analysis, not the generator.
   */
  truth?: Record<string, RemediationClass>;
  /** Strings the document must contain. */
  include?: string[];
  /** Strings the document must not contain. */
  exclude?: string[];
  /** A correctly configured app: the document asks for no change. */
  noFixes?: boolean;
}

export interface BenchmarkCase {
  id: string;
  snapshot: string;
  title: string;
  /** What the case exercises (valid config, genuine blocker, false positive, trap, …). */
  tags: string[];
  mutation?: Mutation;
  expect: CaseExpectation;
}

export interface BenchmarkFile {
  version: 1;
  repositories: { id: string; role: 'primary' | 'holdout' | 'support' }[];
  cases: BenchmarkCase[];
}

export function loadBenchmark(path = CASES_PATH): BenchmarkFile {
  const parsed = parse(readFileSync(path, 'utf8')) as BenchmarkFile;
  const ids = new Set<string>();
  for (const entry of parsed.cases) {
    if (ids.has(entry.id)) throw new Error(`duplicate case id ${entry.id}`);
    ids.add(entry.id);
    for (const [findingId, label] of [...Object.entries(entry.expect.classes), ...Object.entries(entry.expect.truth ?? {})]) {
      if (!REMEDIATION_CLASSES.includes(label)) throw new Error(`${entry.id}: ${findingId} has unknown class ${label}`);
    }
  }
  return parsed;
}

export function loadSnapshot(id: string, dir = SNAPSHOT_DIR): Snapshot {
  return JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as Snapshot;
}

function addedFinding(entry: AddedFinding): ReadinessFinding {
  return {
    id: entry.id,
    category: 'benchmark',
    title: entry.id,
    severity: entry.severity ?? 'required',
    blocking: entry.blocking ?? entry.id.startsWith('unsupported-'),
    plainEnglishExplanation: entry.question ?? `Synthetic finding ${entry.id}.`,
    whyItMatters: 'Synthetic benchmark mutation.',
    technicalEvidence: entry.evidence,
    suggestedOutcome: entry.outcome ?? `Resolve ${entry.id}.`,
    confidence: entry.confidence ?? 'confirmed',
  };
}

/** The application row the case describes: the snapshot with its mutation applied. */
export function caseSource(entry: BenchmarkCase, snapshot: Snapshot): FixInstructionsSource {
  const mutation = entry.mutation ?? {};
  const metadata = structuredClone(snapshot.source.detectedMetadata ?? {}) as Record<string, unknown>;
  const readiness = metadata['readiness'] as { findings: ReadinessFinding[]; passed: unknown[] } | undefined;
  if (readiness) {
    const removed = new Set(mutation.removeFindings ?? []);
    readiness.findings = [
      ...readiness.findings.filter((finding) => !removed.has(finding.id)),
      ...(mutation.addFindings ?? []).map(addedFinding),
    ];
  }
  return {
    repoFullName: snapshot.source.repoFullName,
    containerPort: snapshot.source.containerPort,
    healthPath: snapshot.source.healthPath,
    migrationCommand: snapshot.source.migrationCommand,
    redisRequired: snapshot.source.redisRequired,
    ...mutation.row,
    detectedMetadata: { ...metadata, ...mutation.metadata },
  };
}
