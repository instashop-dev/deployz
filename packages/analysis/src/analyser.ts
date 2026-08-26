/**
 * Repository analyser orchestrator — runs all §18 detectors and §10 rejection
 * checks against a file tree and produces a structured analysis result.
 *
 * This is a PURELY DETERMINISTIC analyser (§20): rule-based, no ML, no AI.
 * The output maps to the `detectedMetadata` JSONB column on the Application row.
 */

import type { FileTree } from './detectors.js';
import type { DetectorFinding } from './detectors.js';
import {
  detectDockerfile,
  detectFramework,
  detectPort,
  detectHealthEndpoint,
  detectEnvVars,
  detectPostgresql,
  detectLocalFilesystem,
  detectWorker,
  detectS3,
  detectMigrationCommand,
  detectStartupCommand,
  detectExternalServices,
} from './detectors.js';

import type { RejectionFinding } from './rejection.js';
import {
  checkRedisUnsupported,
  checkMysql,
  checkMongo,
  checkElasticsearch,
  checkOtherUnsupportedDatabases,
} from './rejection.js';

import type { RedisRequirement } from './redis.js';
import { assessRedis } from './redis.js';

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * The resolved database state of an analysed repository.
 *
 * - `postgres` — PostgreSQL detected; the app is provisioned a managed RDS
 *   instance and `DATABASE_*` env vars.
 * - `none` — No database detected; the app deploys without DB resources, DB
 *   env vars, or DB steps. Analysis succeeds.
 * - `unsupported` — A database Deployz does not support (MySQL/Mongo/etc.)
 *   was detected by the §10 rejection checks; verdict is NOT_COMPATIBLE.
 * - `unknown` — Reserved for future detectors that detect a database they
 *   cannot classify; not emitted by the current detectors. Non-fatal unless a
 *   later check proves deployment cannot proceed.
 */
export type DatabaseState = 'none' | 'postgres' | 'unsupported' | 'unknown';

/** Complete result from a repository analysis. */
export interface AnalysisResult {
  /** All §18 detector findings. */
  findings: DetectorFinding[];
  /** All §10 rejection check results. */
  rejections: RejectionFinding[];
  /** Flattened metadata suitable for the `detectedMetadata` JSONB column. */
  metadata: Record<string, unknown>;
}

// ── Orchestrator ────────────────────────────────────────────────────────────

/** All §18 detector functions, in order. */
const DETECTORS = [
  detectDockerfile,
  detectFramework,
  detectPort,
  detectHealthEndpoint,
  detectEnvVars,
  detectPostgresql,
  detectLocalFilesystem,
  detectWorker,
  detectS3,
  detectMigrationCommand,
  detectStartupCommand,
  detectExternalServices,
] as const;

/** All §10 rejection check functions, in order (redis is handled separately — see `analyseRepo`). */
const REJECTION_CHECKS = [
  checkMysql,
  checkMongo,
  checkElasticsearch,
  checkOtherUnsupportedDatabases,
] as const;

/**
 * Build the `redis` detector finding from a precomputed `RedisRequirement`.
 *
 * `detected` follows the §7 confidence policy nuance: true whenever real
 * Redis evidence exists (confidence 'high' or 'medium'), regardless of
 * whether that evidence is enough to *provision* Redis — the provisioning
 * decision lives in `metadata.redis.required`, not here.
 */
function buildRedisFinding(redis: RedisRequirement): DetectorFinding {
  const detected = redis.confidence !== 'low';
  return {
    detector: 'redis',
    detected,
    value: redis.purposes,
    details: detected
      ? `Redis detected (${redis.confidence} confidence): ${redis.evidence.join('; ')}`
      : 'No significant Redis usage detected',
  };
}

/**
 * Build a flat metadata record from findings.
 * Maps detector names to their detected values for easy JSONB storage and querying.
 */
function buildMetadata(findings: DetectorFinding[], redis: RedisRequirement): Record<string, unknown> {
  const meta: Record<string, unknown> = {};

  for (const f of findings) {
    const key = f.detector.replace(/-/g, '');

    // Map common detectors to friendly metadata keys
    switch (f.detector) {
      case 'dockerfile':
        meta['hasDockerfile'] = f.detected;
        if (f.detected && f.value) meta['dockerfilePath'] = f.value;
        break;
      case 'framework':
        meta['framework'] = f.detected ? f.value : null;
        break;
      case 'port':
        meta['port'] = f.detected ? f.value : null;
        break;
      case 'health-endpoint':
        meta['hasHealthEndpoint'] = f.detected;
        if (f.detected && f.value) meta['healthEndpointSources'] = f.value;
        break;
      case 'env-vars':
        meta['hasEnvVars'] = f.detected;
        if (f.detected && f.value) meta['envVars'] = f.value;
        break;
      case 'postgresql':
        meta['usesPostgresql'] = f.detected;
        if (f.detected && f.value) meta['postgresqlDrivers'] = f.value;
        break;
      case 'redis':
        meta['usesRedis'] = f.detected;
        meta['redis'] = redis;
        break;
      case 'local-filesystem':
        meta['usesLocalFilesystem'] = f.detected;
        if (f.detected && f.value) meta['localFilesystemOps'] = f.value;
        break;
      case 'worker':
        meta['hasWorkerProcesses'] = f.detected;
        if (f.detected && f.value) meta['workerPatterns'] = f.value;
        break;
      case 's3':
        meta['usesS3'] = f.detected;
        if (f.detected && f.value) meta['s3Indicators'] = f.value;
        break;
      case 'migration-command':
        meta['hasMigrationCommand'] = f.detected;
        if (f.detected && f.value) meta['migrationCommands'] = f.value;
        break;
      case 'startup-command':
        meta['hasStartupCommand'] = f.detected;
        if (f.detected && f.value) meta['startupCommands'] = f.value;
        break;
      case 'external-services':
        meta['hasExternalServices'] = f.detected;
        if (f.detected && f.value) meta['externalServices'] = f.value;
        break;
      default:
        meta[key] = f.detected ? f.value ?? true : false;
    }
  }

  return meta;
}

/**
 * Run the full deterministic analysis: all §18 detectors + all §10 rejection checks.
 *
 * Returns an `AnalysisResult` whose `metadata` field maps to the
 * `applications.detected_metadata` JSONB column.
 *
 * This function is PURE: same input → same output every time. No randomness, no
 * AI, no external calls. The §19 verdict engine (todo 23) consumes this output.
 */
export function analyseRepo(tree: FileTree): AnalysisResult {
  const findings: DetectorFinding[] = [];
  const rejections: RejectionFinding[] = [];

  for (const detector of DETECTORS) {
    findings.push(detector(tree));
  }

  // Redis is computed once here (not folded into DETECTORS/REJECTION_CHECKS,
  // which are uniform `(tree) => Finding` arrays) so the single `assessRedis`
  // call can be shared between the `redis` finding, the unsupported-Redis
  // rejection check, and `buildMetadata`'s full `metadata.redis` object.
  const redis = assessRedis(tree);
  findings.push(buildRedisFinding(redis));

  rejections.push(checkRedisUnsupported(tree, redis));
  for (const check of REJECTION_CHECKS) {
    rejections.push(check(tree));
  }

  const metadata = buildMetadata(findings, redis);
  metadata['databaseState'] = deriveDatabaseState(findings, rejections);

  return { findings, rejections, metadata };
}

/**
 * Derive the `databaseState` metadata value from the detector findings and
 * §10 rejections. PostgreSQL takes priority over an unsupported DB (a Postgres
 * app that also pulled in an unsupported Redis config is `postgres` for DB
 * purposes — the Redis rejection still drives the verdict). Redis-only
 * rejections are about the cache, not the database, so they do not count as an
 * unsupported DB state.
 */
function deriveDatabaseState(
  findings: DetectorFinding[],
  rejections: RejectionFinding[],
): DatabaseState {
  const postgres = findings.find((f) => f.detector === 'postgresql')?.detected === true;
  if (postgres) return 'postgres';

  const unsupportedDb = rejections.some(
    (r) => r.detected && r.dependency !== 'redis-unsupported',
  );
  if (unsupportedDb) return 'unsupported';

  return 'none';
}