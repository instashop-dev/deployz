import {
  JEV_DECISION_SET_VERSION,
  JEV_EVIDENCE_SCHEMA_VERSION,
  JevError,
  buildJevEvidence,
  collectDependencyNames,
  collectRepositoryEvidence,
  createJevCircuitBreaker,
  createJevClient,
  fingerprintJevEvidence,
  normalizeDeploymentManifest,
  runJevRequirementsShadow,
  type AnalysisAmbiguity,
  type AnalysisResult,
  type FileTree,
  type InfrastructureBinding,
  type JevClient,
  type JevRequirementsShadowInput,
} from '@deployz/analysis';
import { buildInstallPlan, type ManifestEnvVariable } from '@deployz/contracts';
import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import type { JevConfig } from './ai-config.js';
import { applicationToManifestOverrides, type ManifestApplicationRow } from './manifest.js';

// Jev requirements/plan shadow runner — PR 2 wiring beside the analysis flow.
//
// Shadow-only by contract: `run` is fired detached from `runApplicationAnalysis`
// after the analysis succeeded, appends at most ONE telemetry row
// (`jev_shadow_verifications`), and NEVER throws — a Jev failure, a derivation
// failure, or a failed telemetry insert is swallowed here and leaves every
// piece of production state (analysisStatus, compatibilityStatus,
// detectedMetadata, manifest, plan, event_logs) untouched.

/** What the analysis hook point has in hand when the shadow fires. */
export interface JevShadowParams {
  applicationId: string;
  /** The head commit the analysis ran against ('unknown' in fixture mode). */
  commitSha: string;
  /** The application row as loaded, before this run's §35 backfill lands. */
  application: ManifestApplicationRow;
  /** The §35 contract fields this run persists (merged over `application`). */
  contractFieldUpdates: {
    containerPort?: number;
    healthPath?: string;
    migrationCommand?: string | null;
    workerCommand?: string;
    databaseRequired?: boolean;
    storageRequired?: boolean;
    redisRequired?: boolean;
  };
  /** The detected_metadata record this run persists. */
  detectedMetadata: Record<string, unknown>;
  /** The merged (post-AI-fallback) analysis the run produced. */
  analysis: AnalysisResult;
  tree: FileTree;
}

export interface JevShadowDeps {
  /** Insert access for the telemetry row. */
  db: Pick<RuntimeDb, 'insert'>;
  /** The Jev client. Absent (Jev disabled/unconfigured) makes `run` a noop. */
  client?: JevClient | undefined;
  /** Injectable clock for `created_at`. Defaults to `Date.now`. */
  now?: (() => number) | undefined;
}

export interface JevShadowRunner {
  run(params: JevShadowParams): Promise<void>;
}

let sharedBreaker: ReturnType<typeof createJevCircuitBreaker> | undefined;

/** One breaker per process, shared by the server and the worker Lambda. */
export function sharedJevCircuitBreaker(): ReturnType<typeof createJevCircuitBreaker> {
  return (sharedBreaker ??= createJevCircuitBreaker());
}

/**
 * Build the runner. Without a client (Jev disabled or unconfigured) the
 * returned runner is a noop, so callers stay clean of the enablement check.
 */
export function createJevShadowRunner(deps: JevShadowDeps): JevShadowRunner {
  const client = deps.client;
  if (!client) return { run: async () => {} };
  return { run: (params) => runShadow(deps, client, params) };
}

/**
 * From the resolved env config — a disabled or partial configuration yields
 * the noop runner (`resolveJevConfig` guarantees the URL/key pair whenever
 * `enabled` is true, so the guard only defends the type).
 */
export function createJevShadowRunnerFromEnv(deps: { db: Pick<RuntimeDb, 'insert'> }, config: JevConfig): JevShadowRunner {
  if (!config.enabled || config.baseUrl === undefined || config.apiKey === undefined) {
    return createJevShadowRunner({ db: deps.db });
  }
  return createJevShadowRunner({
    db: deps.db,
    client: createJevClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      gatewayToken: config.gatewayToken,
      timeoutMs: config.timeoutMs,
      breaker: sharedJevCircuitBreaker(),
    }),
  });
}

// ── Derivation ──────────────────────────────────────────────────────────────

/** The metadata key read as one of the shapes `analyseRepo` wrote. */
function typedArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** The raw detection requirement booleans, for the row derivation cannot build. */
function detectedRequirements(
  metadata: Record<string, unknown>,
): JevRequirementsShadowInput['deployzRequirements'] {
  const postgres = metadata['postgres'] as { required?: unknown } | undefined;
  const redis = metadata['redis'] as { required?: unknown } | undefined;
  return {
    postgres: postgres?.required === true,
    redisRequired: redis?.required === true,
    storageRequired: metadata['usesS3'] === true,
  };
}

/** The post-run application row the next manifest build would read. */
function effectiveRow(params: JevShadowParams): ManifestApplicationRow {
  const updates = params.contractFieldUpdates;
  return {
    // An explicit null `migrationCommand` (DEPLOY-029 startup-mode clear) must
    // win over the loaded column, so it is checked for undefined, not nullish.
    migrationCommand:
      updates.migrationCommand !== undefined ? updates.migrationCommand : params.application.migrationCommand,
    containerPort: updates.containerPort ?? params.application.containerPort,
    healthPath: updates.healthPath ?? params.application.healthPath,
    workerCommand: updates.workerCommand ?? params.application.workerCommand,
    databaseRequired: updates.databaseRequired ?? params.application.databaseRequired,
    storageRequired: updates.storageRequired ?? params.application.storageRequired,
    redisRequired: updates.redisRequired ?? params.application.redisRequired,
    detectedMetadata: params.detectedMetadata,
  };
}

interface ShadowInputs {
  readonly evidence: ReturnType<typeof buildJevEvidence>;
  readonly fingerprint: string;
  readonly deployzRequirements: JevRequirementsShadowInput['deployzRequirements'];
  readonly planSummary: JevRequirementsShadowInput['planSummary'];
}

/**
 * Everything the verifier needs, derived with the production builders only:
 * the manifest through the exact chain `effectiveApplicationManifest`
 * (server.ts) uses — `normalizeDeploymentManifest` over the fresh metadata and
 * the effective post-run overrides — then `buildInstallPlan` (region null:
 * components and resources are region-independent) and the PR 1 evidence
 * model with dependency names from `collectDependencyNames`.
 */
function deriveShadowInputs(params: JevShadowParams): ShadowInputs {
  const manifest = normalizeDeploymentManifest(
    { metadata: params.detectedMetadata },
    applicationToManifestOverrides(effectiveRow(params)),
  );
  const deployzRequirements = {
    postgres: manifest.database.postgres,
    redisRequired: manifest.redis.required,
    storageRequired: manifest.storage.required,
  };
  const plan = buildInstallPlan({ manifest, region: null });
  const metadata = params.analysis.metadata;
  const evidence = buildJevEvidence({
    findings: params.analysis.findings,
    evidence: collectRepositoryEvidence(params.tree, params.analysis),
    ambiguities: typedArray<AnalysisAmbiguity>(metadata['ambiguities']),
    dependencies: collectDependencyNames(params.tree),
    envVariables: typedArray<ManifestEnvVariable>(metadata['envVarModel']),
    requirements: deployzRequirements,
    bindings: typedArray<InfrastructureBinding>(metadata['infrastructureBindings']),
    rejections: params.analysis.rejections,
  });
  return {
    evidence,
    fingerprint: fingerprintJevEvidence(evidence),
    deployzRequirements,
    planSummary: {
      components: plan.components.map((component) => `${component.kind}:${component.name}`),
      awsResources: plan.awsResources.map((resource) => resource.id),
    },
  };
}

// ── Runner ───────────────────────────────────────────────────────────────────

type ShadowRow = typeof schema.jevShadowVerifications.$inferInsert;

/** Append one telemetry row; a failed append is dropped — shadow-only. */
async function record(deps: JevShadowDeps, row: ShadowRow): Promise<void> {
  try {
    await deps.db.insert(schema.jevShadowVerifications).values(row);
  } catch {
    // Telemetry must never fail the analysis flow (ai-explanation.ts style).
  }
}

async function runShadow(deps: JevShadowDeps, client: JevClient, params: JevShadowParams): Promise<void> {
  const base = {
    applicationId: params.applicationId,
    analysisCommitSha: params.commitSha,
    evidenceSchemaVersion: JEV_EVIDENCE_SCHEMA_VERSION,
    decisionSetVersion: JEV_DECISION_SET_VERSION,
    createdAt: new Date(deps.now?.() ?? Date.now()),
  };

  let derived: ShadowInputs;
  try {
    derived = deriveShadowInputs(params);
  } catch {
    // Derivation failed before anything identifiable existed — the raw
    // detection booleans are the best the row can carry.
    await record(deps, {
      ...base,
      evidenceFingerprint: '',
      deployzRequirements: detectedRequirements(params.analysis.metadata),
      ok: false,
      errorKind: 'internal',
    });
    return;
  }

  try {
    const result = await runJevRequirementsShadow(client, {
      evidence: derived.evidence,
      fingerprint: derived.fingerprint,
      deployzRequirements: derived.deployzRequirements,
      planSummary: derived.planSummary,
    });
    await record(deps, {
      ...base,
      evidenceFingerprint: derived.fingerprint,
      deployzRequirements: derived.deployzRequirements,
      jevResult: { ...result },
      ok: true,
      latencyMs: result.latencyMs,
      model: result.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    });
  } catch (error) {
    await record(deps, {
      ...base,
      evidenceFingerprint: derived.fingerprint,
      deployzRequirements: derived.deployzRequirements,
      ok: false,
      errorKind: error instanceof JevError ? error.kind : 'internal',
    });
  }
}
