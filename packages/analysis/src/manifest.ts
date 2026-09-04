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
  type ManifestEnvBinding,
  type ManifestEnvVariable,
  type ManifestReadinessFinding,
  type ManifestReadinessResult,
} from '@deployz/contracts';

import type { AnalysisResult } from './analyser.js';
import type { BindingSemantic, InfrastructureBinding } from './bindings.js';
import { resolveRedisEnvBindings } from './redis.js';

/** Anything carrying the flat detector metadata record. */
export type ManifestSource = Pick<AnalysisResult, 'metadata'>;

/** Context a manifest-readiness caller can supply that the manifest alone cannot know. */
export interface ManifestReadinessContext {
  /**
   * Env var keys the operator ALREADY supplies values for (the application's
   * configured defaults/overrides). Absent = the caller has no config
   * knowledge, so required-env findings are not evaluated (§11.2 — the
   * deployment-creation boundary is where the keys are known).
   */
  providedEnvKeys?: readonly string[] | undefined;
}

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

/** A binding semantic expressible in the manifest vocabulary, or null for the read-model-only ones. */
function toManifestKind(semantic: BindingSemantic): ManifestEnvBinding['kind'] | null {
  switch (semantic) {
    case 'url':
    case 'host':
    case 'port':
    case 'bucket':
    case 'database':
    case 'username':
    case 'password':
      return semantic;
    case 'region':
    case 'endpoint':
      return null;
  }
}

/**
 * The env vars (with their semantics) each provisioned value is injected
 * under. Standard injected names always lead (compat); detected aliases follow
 * in deterministic order.
 */
function toEnvBindings(
  bindings: readonly InfrastructureBinding[],
  standard: readonly { name: string; kind: ManifestEnvBinding['kind'] }[],
): ManifestEnvBinding[] {
  const seen = new Set<string>(standard.map((entry) => entry.name));
  const entries: ManifestEnvBinding[] = [...standard];
  const sorted = [...bindings].sort((a, b) => a.applicationVariable.localeCompare(b.applicationVariable));
  for (const binding of sorted) {
    if (seen.has(binding.applicationVariable)) continue;
    const kind = toManifestKind(binding.semantic);
    if (kind === null) continue;
    seen.add(binding.applicationVariable);
    entries.push({ name: binding.applicationVariable, kind });
  }
  return entries;
}

/** Stage B phase 2 postgres bindings — standard injected names first, then detected aliases. */
const STANDARD_DATABASE_BINDINGS: readonly { name: string; kind: ManifestEnvBinding['kind'] }[] = [
  { name: 'DATABASE_URL', kind: 'url' },
  { name: 'DATABASE_HOST', kind: 'host' },
  { name: 'DATABASE_PORT', kind: 'port' },
  { name: 'DATABASE_NAME', kind: 'database' },
  { name: 'DATABASE_USER', kind: 'username' },
  { name: 'DATABASE_PASSWORD', kind: 'password' },
];

/** The canonical storage binding plus detected alias bucket names. */
const STANDARD_STORAGE_BINDINGS: readonly { name: string; kind: ManifestEnvBinding['kind'] }[] = [
  { name: 'AWS_S3_BUCKET', kind: 'bucket' },
];
/** Bucket names the stack already injects — never repeated as detected aliases. */
const INJECTED_BUCKET_NAMES = new Set(['STORAGE_BUCKET', 'S3_BUCKET', 'AWS_S3_BUCKET']);

/**
 * Env var names (with semantics) that each provisioned value is injected
 * under — read off `metadata.infrastructureBindings` (Stage B phase 2). A
 * row analysed before the field existed carries none, so the caller falls
 * back to the standard injected names only.
 */
function readInfrastructureBindings(meta: Record<string, unknown>): InfrastructureBinding[] {
  const raw = meta['infrastructureBindings'];
  if (!Array.isArray(raw)) return [];
  const bindings: InfrastructureBinding[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Partial<InfrastructureBinding>;
    if (
      (record.resource === 'postgres' || record.resource === 'redis' || record.resource === 's3') &&
      typeof record.applicationVariable === 'string' &&
      typeof record.semantic === 'string'
    ) {
      bindings.push(record as InfrastructureBinding);
    }
  }
  return bindings;
}

// Directories that hold container/packaging tooling, not application code:
// a Dockerfile under `docker/` or `packaging/…` is written to build the app
// from the repository root (Stage A COMP-020).
const TOOLING_DIR_REGEX =
  /(?:^|\/)(?:[\w.-]*docker[\w.-]*|dockerfiles|\.devcontainer|packaging|deploy|deployment|build|ci|infra|scripts|container)(?:\/|$)/i;

/** The directory a Dockerfile lives in — the app root when nothing overrides it. */
function appRootFromDockerfile(dockerfilePath: string | null): string {
  if (!dockerfilePath) return '.';
  const index = dockerfilePath.lastIndexOf('/');
  if (index <= 0) return '.';
  const dir = dockerfilePath.slice(0, index);
  return TOOLING_DIR_REGEX.test(dir) ? '.' : dir;
}

/**
 * Env-var model → manifest entries. Structured `metadata.envVarModel` (the
 * §11.2 Phase 7 shape) is authoritative; a legacy row analysed before the
 * model existed carries only a name list, so it degrades to name entries with
 * no required/secret claim (fail-open — an unknown requirement never blocks).
 */
function toEnvVariables(model: unknown, names: unknown): ManifestEnvVariable[] {
  if (Array.isArray(model)) {
    const entries: ManifestEnvVariable[] = [];
    for (const raw of model) {
      if (typeof raw !== 'object' || raw === null) continue;
      const record = raw as Record<string, unknown>;
      if (typeof record['key'] !== 'string' || record['key'].length === 0) continue;
      const purpose =
        record['purpose'] === 'internal_secret' ||
        record['purpose'] === 'external_credential' ||
        record['purpose'] === 'infrastructure_binding' ||
        record['purpose'] === 'optional_configuration' ||
        record['purpose'] === 'unknown'
          ? record['purpose']
          : undefined;
      const confidence =
        record['confidence'] === 'high' || record['confidence'] === 'medium' || record['confidence'] === 'low'
          ? record['confidence']
          : undefined;
      entries.push({
        key: record['key'],
        required: record['required'] === true,
        secret: record['secret'] === true,
        source: Array.isArray(record['source'])
          ? record['source'].filter((s): s is string => typeof s === 'string' && s.length > 0)
          : [],
        ...(purpose !== undefined ? { purpose } : {}),
        ...(confidence !== undefined ? { confidence } : {}),
      });
    }
    return entries;
  }
  return stringArray(names).map((key) => ({ key, required: false, secret: false, source: [] }));
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
  // incompatibility no override can fix. New analyses carry the full §11.4
  // reason list (`unsupportedReasons`); rows analysed before it fall back to
  // the legacy three sources so nothing silently unblocks.
  const unsupported: string[] = [];
  const detectedUnsupported = stringArray(meta['unsupportedReasons']);
  if (detectedUnsupported.length > 0) {
    unsupported.push(...detectedUnsupported);
  } else {
    if (redisCompatibility['supported'] === false) {
      unsupported.push(
        firstString(redisCompatibility['reason']) ?? 'Redis setup is not supported by Deployz',
      );
    }
    if (meta['databaseState'] === 'unsupported') {
      unsupported.push('Unsupported database detected — Deployz hosts PostgreSQL only');
    }
  }
  if (meta['usesLocalFilesystem'] === true) {
    unsupported.push('Persistent local filesystem storage is not supported');
  }
  // Phase 8 boundary — background worker processes are deferred. The worker
  // start command is resolved per analysis (`resolvedWorkerCommand`, current
  // metadata) with the sticky column as the legacy fallback. An app that has
  // worker-like code AND a declared worker start command needs a second
  // process Deployz will not run, so it is needs-adaptation (NOT_COMPATIBLE);
  // worker-like code without a start command stays deployable (the manifest
  // gate only fires on the declared command).
  const workerCommand =
    typeof meta['resolvedWorkerCommand'] === 'string' && meta['resolvedWorkerCommand'].length > 0
      ? meta['resolvedWorkerCommand']
      : overrides.workerCommand ?? null;
  if (meta['hasWorkerProcesses'] === true && workerCommand !== null) {
    unsupported.push(
      'Background worker process not supported — Deployz runs one web process per application. ' +
        'Remove the separate worker process or process background jobs inside the web process.',
    );
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
      // §11.1: the build context defaults to the repository ROOT. A Dockerfile
      // is addressed by its own path (`docker build -f path`), and a nested
      // Dockerfile that does `COPY apps/api/package.json` needs the root.
      context: overrides.buildContext ?? '.',
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
    database: {
      postgres: postgresRequired,
      // Stage B phase 2: the names the RDS URL/parts are injected under —
      // the standard DATABASE_* names always, plus the aliases the app reads
      // (MEMOS_DSN, PAPERLESS_DBHOST, …). Absent when no DB is provisioned.
      ...(postgresRequired
        ? {
            envBindings: toEnvBindings(
              readInfrastructureBindings(meta).filter((b) => b.resource === 'postgres'),
              STANDARD_DATABASE_BINDINGS,
            ),
          }
        : {}),
    },
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
      // The canonical AWS_S3_BUCKET always first (compat), then the alias
      // bucket names the app reads (S3_ATTACHMENTS_BUCKET, …) — names the
      // stack already injects are never repeated.
      envBindings: storageRequired
        ? toEnvBindings(
            readInfrastructureBindings(meta).filter(
              (b) =>
                b.resource === 's3' &&
                b.semantic === 'bucket' &&
                !INJECTED_BUCKET_NAMES.has(b.applicationVariable),
            ),
            STANDARD_STORAGE_BINDINGS,
          )
        : [],
    },
    migration: {
      // `metadata.migrationCommands` holds the detector's PATTERN LABELS
      // ("prisma migrate", "drizzle-kit"), never a runnable command — the
      // deploy-safe command is resolved per analysis into the application
      // column that arrives as the override (Stage A COMP-006).
      command: overrides.migrationCommand ?? null,
    },
    worker: { command: workerCommand },
    environment: {
      variables: toEnvVariables(meta['envVarModel'], meta['envVars']),
    },
    externalServices: stringArray(meta['externalServices']),
    unsupported,
  };

  return deploymentManifestSchema.parse(manifest);
}

// ── Readiness gate ──────────────────────────────────────────────────────────

const PROVISIONED_DATABASE_ENV_VARS = [
  'DATABASE_URL',
  'DATABASE_HOST',
  'DATABASE_PORT',
  'DATABASE_NAME',
  'DATABASE_USER',
  'DATABASE_PASSWORD',
] as const;

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
export function evaluateManifestReadiness(
  manifest: DeploymentManifest,
  context: ManifestReadinessContext = {},
): ManifestReadinessResult {
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

  // §11.2 required env vars — a required value Deployz does not inject and
  // the operator has not supplied is a configuration gap. Evaluated only
  // when the caller knows the provided keys (deployment creation); without
  // that knowledge the finding cannot be answered honestly.
  if (context.providedEnvKeys !== undefined) {
    const autoProvided = new Set<string>();
    // The application stack injects the URL and the discrete connection
    // parts alike (packages/cdk application-stack: DATABASE_HOST/PORT/NAME/
    // USER plus the password secret). Stage B phase 2: the manifest's own
    // binding names (an app that reads only MEMOS_DSN or PAPERLESS_DBHOST
    // must not be blocked as missing required env) are auto-provided too.
    if (manifest.database.postgres) {
      for (const name of PROVISIONED_DATABASE_ENV_VARS) autoProvided.add(name);
      for (const binding of manifest.database.envBindings ?? []) autoProvided.add(binding.name);
    }
    if (manifest.redis.required) {
      for (const binding of manifest.redis.envBindings) autoProvided.add(binding.name);
    }
    if (manifest.storage.required) {
      for (const binding of manifest.storage.envBindings) autoProvided.add(binding.name);
    }
    for (const key of context.providedEnvKeys) autoProvided.add(key);

    const missing = manifest.environment.variables
      .filter((variable) => variable.required && !autoProvided.has(variable.key))
      .map((variable) => variable.key);
    if (missing.length > 0) {
      errors.push({
        id: 'required-env-vars-missing',
        category: 'configuration',
        severity: 'error',
        message: `This app requires environment variables that have no value yet: ${missing.join(', ')}. Set them in the application's Configuration screen before deploying.`,
      });
    }
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