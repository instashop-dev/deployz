/**
 * §19 compatibility rules engine — the deterministic readiness verdict.
 *
 * Consumes the todo-22 analyser output (`AnalysisResult` from `analyseRepo`)
 * and produces the §19 verdict: Ready / Needs attention / Not currently
 * compatible. Purely deterministic (§20): same input → same verdict, no AI,
 * no ML, no randomness, no external calls.
 *
 * The verdict is the SINGLE SOURCE OF TRUTH. The AI layer (todo 24) only adds
 * human-language explanation and can NEVER flip a deterministic verdict —
 * `evaluateCompatibility` is a pure function, so no downstream caller can
 * change what it returns for a given input.
 */

import type { AnalysisResult } from './analyser.js';

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * §19 verdict vocabulary. Mirrors `compatibilityStatusEnum` in packages/db
 * (READY / NEEDS_ATTENTION / NOT_COMPATIBLE) — do not reorder or rename
 * without updating that enum.
 */
export type CompatibilityVerdict = 'READY' | 'NEEDS_ATTENTION' | 'NOT_COMPATIBLE';

/** Severity of a single compatibility issue. */
export type IssueSeverity = 'reject' | 'attention';

/** A single deterministic issue found by the rules engine. */
export interface CompatibilityIssue {
  /** `reject` issues force NOT_COMPATIBLE; `attention` issues force NEEDS_ATTENTION. */
  severity: IssueSeverity;
  /** Stable machine-readable code (e.g. 'REDIS_UNSUPPORTED', 'MISSING_DOCKERFILE'). */
  code: string;
  /** Human-readable, §65 jargon-free description. */
  message: string;
}

/** The §19 verdict plus the issues that produced it. */
export interface CompatibilityResult {
  verdict: CompatibilityVerdict;
  /** Human-readable, §65 jargon-free summary of why this verdict was reached. */
  reason: string;
  /** The issues that contributed to the verdict (reject OR attention, never both). */
  issues: CompatibilityIssue[];
  /** Compatibility score (0-100): (passed_checks / total_checks) * 100, rounded. */
  score: number;
  /** Positive detection results — populated only on READY verdict. */
  readyList?: readonly string[] | undefined;
}

// ── Stable issue codes ──────────────────────────────────────────────────────

/**
 * Maps a §10 rejection `dependency` (the specific package name from todo 22's
 * `RejectionFinding`) to a stable, category-level issue code. The fallback
 * covers any future dependency added to the rejection checks before this map
 * is updated.
 */
const REJECTION_CODE_BY_DEPENDENCY: Readonly<Record<string, string>> = {
  // Redis — only unsupported Redis setups reject (Redis Stack modules, cluster
  // mode, TLS). Plain standalone Redis is a supported managed dependency.
  'redis-unsupported': 'REDIS_UNSUPPORTED',
  // MySQL family (note: `@prisma/client` only reaches a rejection finding when
  // todo 22's checkMysql found a Prisma schema with the mysql provider).
  mysql2: 'MYSQL_DEPENDENCY',
  mysql: 'MYSQL_DEPENDENCY',
  '@prisma/client': 'MYSQL_DEPENDENCY',
  // MongoDB family
  mongoose: 'MONGO_DEPENDENCY',
  mongodb: 'MONGO_DEPENDENCY',
  'mongodb-client': 'MONGO_DEPENDENCY',
  // Elasticsearch / OpenSearch
  '@elastic/elasticsearch': 'ELASTICSEARCH_DEPENDENCY',
  '@opensearch-project/opensearch': 'ELASTICSEARCH_DEPENDENCY',
  // Other unsupported databases
  'cassandra-driver': 'UNSUPPORTED_DATABASE',
  'neo4j-driver': 'UNSUPPORTED_DATABASE',
};

const FALLBACK_REJECTION_CODE = 'UNSUPPORTED_DEPENDENCY';

/** Resolve a stable issue code for a §10 rejection dependency. */
function rejectionCode(dependency: string): string {
  return REJECTION_CODE_BY_DEPENDENCY[dependency] ?? FALLBACK_REJECTION_CODE;
}

// ── Rules engine ────────────────────────────────────────────────────────────

/**
 * Compute the compatibility score from an analysis result.
 *
 * Score = (passed_checks / total_checks) * 100, rounded to the nearest integer.
 * A "passed" check is a detector that found what it was looking for, or a
 * rejection check that found nothing to reject.
 */
function computeScore(result: AnalysisResult): number {
  const totalChecks = result.findings.length + result.rejections.length;
  if (totalChecks === 0) return 100;

  const passedFindings = result.findings.filter((f) => f.detected).length;
  const passedRejections = result.rejections.filter((r) => !r.detected).length;
  const passedChecks = passedFindings + passedRejections;

  return Math.round((passedChecks / totalChecks) * 100);
}

/**
 * Collect positive detection results for the readyList.
 * Returns the detector names that had a positive detection.
 */
function collectReadyList(result: AnalysisResult): string[] {
  return result.findings.filter((f) => f.detected).map((f) => f.detector);
}

/**
 * Evaluate the §19 readiness verdict from an analysis result.
 *
 * Deterministic, ordered rules (REJECT > ATTENTION > READY):
 *
 * REJECT (any one → NOT_COMPATIBLE):
 *   1. Any §10 unsupported-dependency rejection (Redis/MySQL/Mongo/ES/other).
 *   2. No PostgreSQL detected (Deployz requires PostgreSQL).
 *   3. Persistent local filesystem usage detected.
 *
 * ATTENTION (if no reject, any one → NEEDS_ATTENTION):
 *   1. No Dockerfile.
 *   2. No health endpoint.
 *   3. No migration command.
 *
 * READY: no reject and no attention issues.
 *
 * This function is PURE — same input → same output, synchronously, with no AI.
 */
export function evaluateCompatibility(result: AnalysisResult): CompatibilityResult {
  // ── REJECT rules ──────────────────────────────────────────────────────────
  const rejects: CompatibilityIssue[] = [];

  // 1. §10 unsupported-dependency rejections.
  for (const rejection of result.rejections) {
    if (rejection.detected) {
      rejects.push({
        severity: 'reject',
        code: rejectionCode(rejection.dependency),
        message: rejection.reason,
      });
    }
  }

  // 2. No PostgreSQL detected.
  const postgresql = result.findings.find((f) => f.detector === 'postgresql');
  if (!postgresql?.detected) {
    rejects.push({
      severity: 'reject',
      code: 'MISSING_POSTGRESQL',
      message: 'No PostgreSQL database detected. Deployz requires PostgreSQL.',
    });
  }

  // 3. Persistent local filesystem usage.
  const localFs = result.findings.find((f) => f.detector === 'local-filesystem');
  if (localFs?.detected) {
    rejects.push({
      severity: 'reject',
      code: 'LOCAL_FILESYSTEM_USAGE',
      message:
        'Persistent local filesystem usage detected. Deployz runs apps in ephemeral containers with no persistent local storage.',
    });
  }

  if (rejects.length > 0) {
    return {
      verdict: 'NOT_COMPATIBLE',
      reason: rejects.map((i) => i.message).join(' '),
      issues: rejects,
      score: computeScore(result),
    };
  }

  // ── ATTENTION rules ───────────────────────────────────────────────────────
  const attention: CompatibilityIssue[] = [];

  const dockerfile = result.findings.find((f) => f.detector === 'dockerfile');
  if (!dockerfile?.detected) {
    attention.push({
      severity: 'attention',
      code: 'MISSING_DOCKERFILE',
      message: 'Missing Dockerfile',
    });
  }

  const health = result.findings.find((f) => f.detector === 'health-endpoint');
  if (!health?.detected) {
    attention.push({
      severity: 'attention',
      code: 'MISSING_HEALTH_ENDPOINT',
      message: 'Missing health endpoint',
    });
  }

  const migration = result.findings.find((f) => f.detector === 'migration-command');
  if (!migration?.detected) {
    attention.push({
      severity: 'attention',
      code: 'MISSING_MIGRATION_COMMAND',
      message: 'Missing migration command',
    });
  }

  if (attention.length > 0) {
    return {
      verdict: 'NEEDS_ATTENTION',
      reason: attention.map((i) => i.message).join(' '),
      issues: attention,
      score: computeScore(result),
    };
  }

  // ── READY ─────────────────────────────────────────────────────────────────
  return {
    verdict: 'READY',
    reason: 'Compatible with Deployz',
    issues: [],
    score: computeScore(result),
    readyList: collectReadyList(result),
  };
}

// ── Verdict persistence ─────────────────────────────────────────────────────

/**
 * The four `applications` columns written by the verdict. Mirrors the
 * packages/db schema (read-only — this module never mutates the schema).
 */
export interface PersistedVerdict {
  /** Analysis ran successfully. */
  analysisStatus: 'COMPLETE';
  /** The deterministic §19 verdict. */
  compatibilityStatus: CompatibilityVerdict;
  /** Human-readable reason for the verdict. */
  compatibilityReason: string;
  /** The flattened detector metadata from `analyseRepo`. */
  detectedMetadata: Record<string, unknown>;
}

/**
 * Injectable DB seam for writing the verdict. The API layer supplies a
 * drizzle-backed implementation; tests supply a mock. Keeps the rules engine
 * framework-agnostic.
 */
export interface VerdictStore {
  update(applicationId: string, values: PersistedVerdict): Promise<void>;
}

/**
 * Compute the §19 verdict and persist it to the `applications` row.
 *
 * The verdict is computed by `evaluateCompatibility` and written verbatim —
 * no layer (including the AI layer) may alter the values between computation
 * and persistence.
 */
export async function persistVerdict(
  applicationId: string,
  result: AnalysisResult,
  db: VerdictStore,
): Promise<void> {
  const verdict = evaluateCompatibility(result);
  await db.update(applicationId, {
    analysisStatus: 'COMPLETE',
    compatibilityStatus: verdict.verdict,
    compatibilityReason: verdict.reason,
    detectedMetadata: result.metadata,
  });
}
