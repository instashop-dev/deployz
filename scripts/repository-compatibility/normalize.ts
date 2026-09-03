/**
 * Normalized facts, comparison, and mismatch classification — pure functions
 * over the raw analysis so every result file is deterministic and every
 * mismatch is attributable to a registered finding or flagged as unexplained.
 */
import type { CompatibilityState, ExpectedFacts, FindingRef, FindingType } from './manifest.js';
import type { RawAnalysis } from './analyse.js';

/** The facts the audit compares when the manifest states an expectation for them. */
export const COMPARED_FACTS = [
  'compatibility',
  'postgres',
  'redis',
  'worker',
  'storage',
  'migration',
  'appRoot',
  'dockerfilePath',
  'port',
  'healthPath',
  'unsupported',
] as const;
export type ComparedFact = (typeof COMPARED_FACTS)[number];

/**
 * Rejection `dependency` ids collapsed into the families an expectation
 * names. Everything else (kafka, kubernetes, terraform, ...) is already its
 * own family id. Two blockers are not rejections: `local-filesystem` and
 * `background-worker` come from the manifest's `unsupported` derivation.
 */
const UNSUPPORTED_FAMILIES: Record<string, string> = {
  mysql: 'mysql',
  mysql2: 'mysql',
  mariadb: 'mysql',
  '@prisma/client': 'mysql',
  mongoose: 'mongodb',
  mongodb: 'mongodb',
  'mongodb-client': 'mongodb',
  '@elastic/elasticsearch': 'elasticsearch',
  '@opensearch-project/opensearch': 'elasticsearch',
  'cassandra-driver': 'other-database',
  'neo4j-driver': 'other-database',
};

export interface ActualFacts {
  compatibility: CompatibilityState;
  /** `applications.compatibility_status` — the analysis-time verdict. */
  analysisVerdict: string | null;
  readinessState: string | null;
  runtime: string;
  appRoot: string;
  dockerfilePath: string | null;
  port: number | null;
  startCommand: string | null;
  healthDetected: boolean;
  healthPath: string | null;
  postgres: boolean;
  postgresDetected: boolean;
  redis: boolean;
  redisDetected: boolean;
  redisConfidence: string | null;
  storage: boolean;
  worker: boolean;
  workerCommand: string | null;
  migration: boolean;
  migrationCommand: string | null;
  externalServices: string[];
  requiredEnvVars: string[];
  unsupported: string[];
  readinessFindings: string[];
  gateFindings: string[];
  unresolvedQuestions: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function normalizeActual(raw: RawAnalysis): ActualFacts {
  if (raw.status !== 'analysed' || !raw.analysis || !raw.manifest || !raw.gate) {
    throw new Error('cannot normalize a failed analysis');
  }
  const metadata = asRecord(raw.row.detectedMetadata);
  const readiness = asRecord(metadata['readiness']);
  const redis = asRecord(metadata['redis']);
  const aiAnalysis = asRecord(metadata['aiAnalysis']);

  const unsupported = new Set<string>();
  for (const rejection of raw.analysis.rejections) {
    if (rejection.detected) unsupported.add(UNSUPPORTED_FAMILIES[rejection.dependency] ?? rejection.dependency);
  }
  if (metadata['usesLocalFilesystem'] === true) unsupported.add('local-filesystem');
  if (metadata['hasWorkerProcesses'] === true && raw.manifest.worker.command !== null) unsupported.add('background-worker');

  return {
    compatibility: raw.gate.state,
    analysisVerdict: raw.row.compatibilityStatus,
    readinessState: typeof readiness['state'] === 'string' ? readiness['state'] : null,
    runtime: raw.manifest.application.runtime,
    appRoot: raw.manifest.application.root,
    dockerfilePath: raw.manifest.application.dockerfilePath,
    port: raw.manifest.web.port,
    startCommand: raw.manifest.web.command,
    healthDetected: metadata['hasHealthEndpoint'] === true,
    healthPath: raw.row.healthPath,
    postgres: raw.manifest.database.postgres,
    postgresDetected: metadata['usesPostgresql'] === true,
    redis: raw.manifest.redis.required,
    redisDetected: metadata['usesRedis'] === true,
    redisConfidence: typeof redis['confidence'] === 'string' ? redis['confidence'] : null,
    storage: raw.manifest.storage.required,
    worker: metadata['hasWorkerProcesses'] === true,
    workerCommand: raw.manifest.worker.command,
    migration: raw.manifest.migration.command !== null,
    migrationCommand: raw.manifest.migration.command,
    externalServices: [...raw.manifest.externalServices].sort(),
    requiredEnvVars: raw.manifest.environment.variables
      .filter((variable) => variable.required)
      .map((variable) => variable.key)
      .sort(),
    unsupported: [...unsupported].sort(),
    readinessFindings: stringList((readiness['findings'] as unknown[] | undefined)?.map((f) => asRecord(f)['id'])),
    gateFindings: raw.gate.findings.map((finding) => finding.id),
    unresolvedQuestions: stringList(aiAnalysis['unresolved']),
  };
}

// ── Comparison ──────────────────────────────────────────────────────────────

export type MismatchKind = 'false-acceptance' | 'false-rejection' | 'configuration-detection' | 'fact';

export interface Comparison {
  fact: ComparedFact;
  expected: unknown;
  actual: unknown;
  match: boolean;
  /** Set on a mismatch only. */
  kind?: MismatchKind;
}

const ACCEPTING_STATES = new Set<CompatibilityState>(['READY', 'NEEDS_CONFIGURATION']);

function verdictMismatchKind(expected: CompatibilityState, actual: CompatibilityState): MismatchKind {
  if (expected === 'NOT_COMPATIBLE' && ACCEPTING_STATES.has(actual)) return 'false-acceptance';
  if (ACCEPTING_STATES.has(expected) && actual === 'NOT_COMPATIBLE') return 'false-rejection';
  return 'configuration-detection';
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Compare every expected fact the manifest states against the normalized actual facts. */
export function compareFacts(expected: ExpectedFacts, actual: ActualFacts): Comparison[] {
  const comparisons: Comparison[] = [];
  const push = (fact: ComparedFact, expectedValue: unknown, actualValue: unknown, match: boolean, kind: MismatchKind = 'fact') => {
    comparisons.push(match ? { fact, expected: expectedValue, actual: actualValue, match } : { fact, expected: expectedValue, actual: actualValue, match, kind });
  };

  push(
    'compatibility',
    expected.compatibility,
    actual.compatibility,
    expected.compatibility === actual.compatibility,
    verdictMismatchKind(expected.compatibility, actual.compatibility),
  );
  push('postgres', expected.postgres, actual.postgres, expected.postgres === actual.postgres);
  push('redis', expected.redis, actual.redis, expected.redis === actual.redis);
  push('worker', expected.worker, actual.worker, expected.worker === actual.worker);
  if (expected.storage !== undefined) push('storage', expected.storage, actual.storage, expected.storage === actual.storage);
  if (expected.migration !== undefined) push('migration', expected.migration, actual.migration, expected.migration === actual.migration);
  if (expected.appRoot !== undefined) push('appRoot', expected.appRoot, actual.appRoot, expected.appRoot === actual.appRoot);
  if (expected.dockerfilePath !== undefined) {
    push('dockerfilePath', expected.dockerfilePath, actual.dockerfilePath, expected.dockerfilePath === actual.dockerfilePath);
  }
  if (expected.port !== undefined) push('port', expected.port, actual.port, expected.port === actual.port);
  if (expected.healthPath !== undefined) push('healthPath', expected.healthPath, actual.healthPath, expected.healthPath === actual.healthPath);
  if (expected.unsupported !== undefined) {
    push('unsupported', expected.unsupported, actual.unsupported, sameStringSet(expected.unsupported, actual.unsupported));
  }
  return comparisons;
}

// ── Classification ──────────────────────────────────────────────────────────

export interface ClassifiedMismatch {
  fact: ComparedFact;
  kind: MismatchKind;
  expected: unknown;
  actual: unknown;
  /** The registered finding that explains the mismatch, or null when none does. */
  finding: { id: string; type: FindingType } | null;
}

/**
 * Attribute each mismatch to the first finding the entry references whose
 * `facts` cover it. A mismatch nothing explains is the audit's work queue.
 */
export function classifyMismatches(
  comparisons: readonly Comparison[],
  entryFindings: readonly string[],
  registry: readonly FindingRef[],
): ClassifiedMismatch[] {
  const refs = entryFindings
    .map((id) => registry.find((finding) => finding.id === id))
    .filter((finding): finding is FindingRef => finding !== undefined);
  return comparisons
    .filter((comparison) => !comparison.match)
    .map((comparison) => {
      const finding = refs.find((ref) => ref.facts.includes(comparison.fact));
      return {
        fact: comparison.fact,
        kind: comparison.kind ?? 'fact',
        expected: comparison.expected,
        actual: comparison.actual,
        finding: finding ? { id: finding.id, type: finding.type } : null,
      };
    });
}
