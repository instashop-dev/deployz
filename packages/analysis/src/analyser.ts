/**
 * Repository analyser orchestrator — runs all §18 detectors and §10 rejection
 * checks against a file tree and produces a structured analysis result.
 *
 * This is a PURELY DETERMINISTIC analyser (§20): rule-based, no ML, no AI.
 * The output maps to the `detectedMetadata` JSONB column on the Application row.
 */

import type { FileTree } from './detectors.js';
import type { DetectorFinding, PostgresRequirement } from './detectors.js';
import {
  detectDockerfile,
  detectFramework,
  detectPort,
  detectHealthEndpoint,
  detectEnvVars,
  detectEnvVarModel,
  detectPostgresql,
  assessPostgres,
  detectLocalFilesystem,
  detectWorker,
  detectS3,
  detectMigrationCommand,
  detectStartupCommand,
  detectExternalServices,
  detectExternalServiceRequirements,
  detectPackageManager,
  detectBuildCommand,
  detectRuntime,
  detectBindAddress,
  detectStartupMigrationEvidence,
  hasPreDeployMigration,
} from './detectors.js';

import type { RejectionFinding } from './rejection.js';
import {
  DATABASE_REJECTION_TOKENS,
  checkRedisUnsupported,
  checkMysql,
  checkMongo,
  checkElasticsearch,
  checkOtherUnsupportedDatabases,
  checkSqlite,
  checkKafka,
  checkRabbitMq,
  checkSqsEventArchitecture,
  checkKubernetes,
  checkServerless,
  checkDockerComposeMultiService,
  checkPersistentVolumes,
  checkTerraform,
  checkPulumi,
  checkCloudFormation,
  checkAzure,
  checkGcp,
  checkGpu,
  checkExplicitPersistentDataDir,
  checkRequiredThirdPartyService,
} from './rejection.js';

import { classifyEnvVariables } from './env-classification.js';
import type { RedisRequirement } from './redis.js';
import { assessRedis, resolveRedisEnvBindings } from './redis.js';
import { deriveAmbiguities } from './evidence.js';
import { deriveInfrastructureBindings } from './bindings.js';

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
  detectPackageManager,
  detectBuildCommand,
  detectRuntime,
  detectBindAddress,
] as const;

/** All §10 rejection check functions, in order (redis is handled separately — see `analyseRepo`). */
const REJECTION_CHECKS = [
  checkMysql,
  checkMongo,
  checkElasticsearch,
  checkOtherUnsupportedDatabases,
  checkSqlite,
  checkKafka,
  checkRabbitMq,
  checkSqsEventArchitecture,
  checkKubernetes,
  checkServerless,
  checkDockerComposeMultiService,
  checkPersistentVolumes,
  checkTerraform,
  checkPulumi,
  checkCloudFormation,
  checkAzure,
  checkGcp,
  checkGpu,
  checkExplicitPersistentDataDir,
  checkRequiredThirdPartyService,
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
function buildMetadata(
  findings: DetectorFinding[],
  redis: RedisRequirement,
  postgres: PostgresRequirement,
): Record<string, unknown> {
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
        meta['postgres'] = postgres;
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
      case 'package-manager':
        meta['packageManager'] = f.detected ? f.value : null;
        break;
      case 'build-command':
        meta['hasBuildCommand'] = f.detected;
        if (f.detected && f.value) meta['buildCommands'] = f.value;
        break;
      case 'runtime':
        meta['runtime'] = f.detected ? f.value : null;
        break;
      case 'bind-address':
        meta['bindsLocalhost'] = f.detected;
        meta['bindAddress'] = f.value ?? null;
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

  // Postgres is computed once here for the same reason as `redis` above —
  // `metadata.postgres` needs the full required-vs-present assessment, not
  // just the `postgresql` finding's `detected` (library presence) flag.
  const postgres = assessPostgres(tree);

  rejections.push(checkRedisUnsupported(tree, redis));
  for (const check of REJECTION_CHECKS) {
    rejections.push(check(tree));
  }

  const metadata = buildMetadata(findings, redis, postgres);

  // Stage B phase 5: surface the health endpoint's resolved path and MODE so
  // manifest normalization never silently assumes `/health`. `vendor_required`
  // means no health evidence exists — the deployment gate must ask the vendor.
  const healthFinding = findings.find((f) => f.detector === 'health-endpoint');
  if (healthFinding?.detected) {
    metadata['healthPath'] = healthFinding.path ?? null;
    metadata['healthMode'] = healthFinding.mode ?? 'explicit';
  } else {
    metadata['healthPath'] = null;
    metadata['healthMode'] = 'vendor_required';
  }

  // Stage B phase 7 (COMP-030): the port's provenance, so the deployment gate
  // can prefill a framework default without ever auto-deploying on a guess.
  const portFinding = findings.find((f) => f.detector === 'port');
  if (portFinding?.detected && typeof portFinding.value === 'string') {
    metadata['portSource'] = portFinding.portSource;
    metadata['portConfidence'] = portFinding.portConfidence;
  }

  // Stage B phase 6 (COMP-014): migration MODE — how the database schema is
  // updated. `pre_deploy` (a deploy-safe migration script), `startup` (the
  // app runs migrations when it starts — evidence recorded, command never
  // invented), `unknown` (required database, no migration evidence anywhere),
  // or `none` (no database, so no migrations to run).
  const postgresMeta = metadata['postgres'] as { required?: unknown } | undefined;
  if (metadata['usesPostgresql'] !== true) {
    metadata['migrationMode'] = 'none';
  } else if (postgresMeta?.required !== true) {
    // A detected-but-unconfirmed database: keep the gentle recommendation.
    metadata['migrationMode'] = 'unknown';
  } else if (hasPreDeployMigration(tree)) {
    metadata['migrationMode'] = 'pre_deploy';
  } else {
    const startupEvidence = detectStartupMigrationEvidence(tree);
    metadata['migrationMode'] = startupEvidence.length > 0 ? 'startup' : 'unknown';
    if (startupEvidence.length > 0) {
      metadata['migrationStartupEvidence'] = startupEvidence;
    }
  }

  // §11.4 — the full unsupported-reason list the manifest gate turns into
  // NOT_COMPATIBLE. Kept as plain strings on the metadata so a deployment
  // created from STORED detected_metadata blocks exactly like one created
  // straight after analysis.
  const detectedRejections = rejections.filter((r) => r.detected);
  metadata['unsupportedReasons'] = detectedRejections.map((r) => r.reason);

  // §11.3 / §11.2 — structured service requirements and the env-var model.
  const serviceRequirements = detectExternalServiceRequirements(tree);
  metadata['externalServiceRequirements'] = serviceRequirements;
  // Phase 4 — who supplies each value, decided from the requirements above.
  metadata['envVarModel'] = classifyEnvVariables(
    detectEnvVarModel(
      tree,
      serviceRequirements.map((r) => r.service),
    ),
    {
      postgresRequired: postgres.required,
      redisRequired: redis.required,
      redisBindingNames: resolveRedisEnvBindings(redis.connectionEnvVars).map((binding) => binding.name),
      storageRequired: findings.find((f) => f.detector === 's3')?.detected === true,
      externalServices: serviceRequirements.map((r) => r.service),
    },
  );

  metadata['databaseState'] = deriveDatabaseState(findings, rejections);

  const result: AnalysisResult = { findings, rejections, metadata };
  // §15 typed evidence surface: the facts the deterministic pipeline left
  // unresolved (build target, start/build/port, DB/cache/storage bindings,
  // health path, migration strategy, worker gate). Purely derived — it never
  // feeds back into a finding, rejection, or verdict.
  metadata['ambiguities'] = deriveAmbiguities(tree, result);
  // Stage B phase 2: the env var names each provisioned value must be injected
  // under (MEMOS_DSN, PAPERLESS_DBHOST, CELERY_BROKER_URL, …). Purely derived
  // read-model over the env-var model — never feeds back into a verdict.
  metadata['infrastructureBindings'] = deriveInfrastructureBindings(tree, result);
  return result;
}

/**
 * Derive the `databaseState` metadata value from the detector findings and
 * §10 rejections. PostgreSQL takes priority over an unsupported DB (a Postgres
 * app that also pulled in an unsupported Redis config is `postgres` for DB
 * purposes — the Redis rejection still drives the verdict). Only a rejection
 * whose dependency is an actual DATABASE token (§10) counts here — an
 * architecture/cloud/cache rejection (§11.4) means the app is unsupported but
 * is not a "database" verdict, and Redis-only rejections are about the cache,
 * not the database.
 */
function deriveDatabaseState(
  findings: DetectorFinding[],
  rejections: RejectionFinding[],
): DatabaseState {
  const postgres = findings.find((f) => f.detector === 'postgresql')?.detected === true;
  if (postgres) return 'postgres';

  const unsupportedDb = rejections.some(
    (r) => r.detected && r.dependency !== 'redis-unsupported' && DATABASE_REJECTION_TOKENS.has(r.dependency),
  );
  if (unsupportedDb) return 'unsupported';

  return 'none';
}