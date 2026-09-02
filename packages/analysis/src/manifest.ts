/**
 * Phase 2 boundary — canonical deployment manifest.
 *
 * Pure, deterministic translation of detector output (+ vendor overrides) into
 * the typed `DeploymentManifest` contract, plus the server-side readiness gate
 * that evaluates the FINAL manifest before AWS provisioning.
 *
 * The analyzer's flat `metadata` record is the input on both paths: a live
 * `AnalysisResult.metadata` (tests, re-analysis) and the stored
 * `applications.detected_metadata` JSONB (deployment creation) are the same
 * shape, so both feed this module unchanged.
 */

import {
  deploymentManifestOverridesSchema,
  deploymentManifestSchema,
  type DeploymentManifest,
  type DeploymentManifestOverrides,
  type ManifestReadinessFinding,
  type ManifestReadinessResult,
} from '@deployz/contracts';

import type { AnalysisResult } from './analyser.js';
import { resolveRedisEnvBindings } from './redis.js';

/** Anything carrying the flat detector metadata record. */
export type ManifestSource = Pick<AnalysisResult, 'metadata'>;

// ── Small metadata readers ──────────────────────────────────────────────────

function firstString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The directory a Dockerfile lives in — the app root when nothing overrides it. */
function appRootFromDockerfile(dockerfilePath: string | null): string {
  if (!dockerfilePath) return '.';
  const index = dockerfilePath.lastIndexOf('/');
  return index <= 0 ? '.' : dockerfilePath.slice(0, index);
}

// ── Normalization ───────────────────────────────────────────────────────────

/**
 * Build the validated, authoritative `DeploymentManifest` from detector output
 * and vendor overrides. Overrides always win over detection; detection is the
 * fallback for anything the vendor has not corrected.
 *
 * OUTPUT IS VALIDATED (deploymentManifestSchema.parse) — this is a trust
 * boundary: detector metadata comes from arbitrary repositories, and the
 * result is persisted to `deployments.desired_state` and consumed by the
 * relay, so an invalid manifest must never be written.
 */
export function normalizeDeploymentManifest(
  analysisResult: ManifestSource,
  vendorOverrides: DeploymentManifestOverrides,
): DeploymentManifest {
  const overrides = deploymentManifestOverridesSchema.parse(vendorOverrides);
  const meta = analysisResult.metadata ?? {};

  const dockerfilePath = overrides.dockerfilePath ?? firstString(meta['dockerfilePath']);
  const appRoot = overrides.appRoot ?? appRootFromDockerfile(dockerfilePath);
  const framework = firstString(meta['framework']);
  const packageManager = firstString(meta['packageManager']);
  const redisMeta = asRecord(meta['redis']);
  const postgresMeta = asRecord(meta['postgres']);
  const redisCompatibility = asRecord(redisMeta['compatibility']);
  const redisRequired = overrides.redisRequired ?? redisMeta['required'] === true;
  const storageRequired = overrides.storageRequired ?? meta['usesS3'] === true;
  const postgresRequired = overrides.databaseRequired ?? postgresMeta['required'] === true;

  // Unsupported reasons — the blocking set. Everything here is a hard
  // incompatibility no override can fix.
  const unsupported: string[] = [];
  if (redisCompatibility['supported'] === false) {
    unsupported.push(
      firstString(redisCompatibility['reason']) ?? 'Redis setup is not supported by Deployz',
    );
  }
  if (meta['databaseState'] === 'unsupported') {
    unsupported.push('Unsupported database detected — Deployz hosts PostgreSQL only');
  }
  if (meta['usesLocalFilesystem'] === true) {
    unsupported.push('Persistent local filesystem storage is not supported');
  }

  const manifest: DeploymentManifest = {
    application: {
      root: appRoot,
      runtime: packageManager || framework ? 'node' : 'unknown',
      framework,
      dockerfilePath,
    },
    build: {
      command: overrides.buildCommand ?? stringArray(meta['buildCommands'])[0] ?? null,
      context: overrides.buildContext ?? appRoot,
    },
    web: {
      command: overrides.startCommand ?? stringArray(meta['startupCommands'])[0] ?? null,
      port:
        overrides.port ??
        (typeof meta['port'] === 'string' && meta['port'].length > 0
          ? Number.parseInt(meta['port'], 10) || null
          : null),
    },
    health: {
      path: overrides.healthPath ?? '/health',
    },
    database: { postgres: postgresRequired },
    redis: {
      required: redisRequired,
      // Deployz always injects the standard bindings for a required cache;
      // the detected connection env vars (if any) refine which names carry
      // a full URL vs host/port.
      envBindings: redisRequired
        ? resolveRedisEnvBindings(stringArray(redisMeta['connectionEnvVars']))
        : [],
    },
    storage: {
      required: storageRequired,
      envBindings: storageRequired ? [{ name: 'AWS_S3_BUCKET', kind: 'bucket' }] : [],
    },
    migration: {
      command: overrides.migrationCommand ?? stringArray(meta['migrationCommands'])[0] ?? null,
    },
    worker: { command: overrides.workerCommand ?? null },
    environment: { variables: stringArray(meta['envVars']) },
    externalServices: stringArray(meta['externalServices']),
    unsupported,
  };

  return deploymentManifestSchema.parse(manifest);
}

// ── Readiness gate ──────────────────────────────────────────────────────────

/**
 * Evaluate the FINAL manifest before AWS provisioning.
 *
 *   - NOT_COMPATIBLE  — `unsupported` is non-empty: the app needs code changes
 *     Deployz cannot provision around (unsupported DB, local disk, Redis
 *     features beyond the managed profile).
 *   - NEEDS_CONFIGURATION — not incompatible, but missing required config
 *     (no Dockerfile / port / start command), so provisioning would fail or
 *     boot a container that cannot start.
 *   - READY — deployable as-is; findings may still carry warnings (e.g. a
 *     PostgreSQL app without a migration command).
 */
export function evaluateManifestReadiness(manifest: DeploymentManifest): ManifestReadinessResult {
  const errors: ManifestReadinessFinding[] = [];
  const warnings: ManifestReadinessFinding[] = [];

  for (const reason of manifest.unsupported) {
    errors.push({
      id: 'unsupported',
      category: 'compatibility',
      severity: 'error',
      message: reason,
    });
  }
  if (!manifest.application.dockerfilePath) {
    errors.push({
      id: 'dockerfile-missing',
      category: 'container',
      severity: 'error',
      message: 'No Dockerfile was found; Deployz cannot build an image without container instructions.',
    });
  }
 if (!manifest.web.port) {
    errors.push({
      id: 'port-missing',
      category: 'application',
      severity: 'error',
      message: 'The application port is unknown; Deployz cannot route traffic to a container without it.',
    });
  }
  if (!manifest.web.command) {
    errors.push({
      id: 'start-command-missing',
      category: 'application',
      severity: 'error',
      message: 'No start command was found; the container would boot with nothing to run.',
    });
  }
  if (manifest.database.postgres && !manifest.migration.command) {
    warnings.push({
      id: 'migration-command-missing',
      category: 'database',
      severity: 'warning',
      message: 'This app uses PostgreSQL but has no migration command; schema updates will not run on deploy.',
    });
  }

  const state =
    manifest.unsupported.length > 0
      ? 'NOT_COMPATIBLE'
      : errors.length > 0
        ? 'NEEDS_CONFIGURATION'
        : 'READY';
  return { state, findings: [...errors, ...warnings] };
}