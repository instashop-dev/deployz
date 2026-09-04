/**
 * §18/§20 typed evidence and ambiguity model.
 *
 * A thin read-model over `AnalysisResult` — it never re-scans the tree and
 * never re-runs a detector. `deriveAmbiguities` names every fact the
 * deterministic pipeline left genuinely unresolved as one typed
 * `AnalysisAmbiguity`; `collectRepositoryEvidence` re-shapes already-detected
 * findings and the §11.2 env-var model into `EvidenceItem`s carrying a source
 * path and a confidence.
 *
 * The ambiguity kinds are the contract the §15 AI fallback (repository-ai.ts)
 * and any future consumer read. Kinds that map to a legacy
 * unresolved-question string keep that mapping (`legacyQuestionString`) so the
 * AI gate and prompt vocabulary are byte-for-byte unchanged; the newer kinds
 * have no question string and surface only on `metadata.ambiguities`.
 */

import type { ManifestEnvVariable } from '@deployz/contracts';

import type { AnalysisResult } from './analyser.js';
import { listDockerfileCandidates, type FileTree } from './detectors.js';

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * One unresolved repository fact. `REQUIRED_ENV` is deliberately absent: the
 * §11.2 model only marks a variable required when a code read exists, and that
 * read always populates the variable's `source` — so a required variable with
 * no detection source at all can never occur, and the kind would be dead
 * weight.
 */
export type AnalysisAmbiguityKind =
  | 'DATABASE_BINDING'
  | 'REDIS_BINDING'
  | 'STORAGE_BINDING'
  | 'HEALTH_PATH'
  | 'MIGRATION_STRATEGY'
  | 'PORT'
  | 'ARCHITECTURE_REQUIREMENT'
  | 'DOCKERFILE_TARGET'
  | 'START_COMMAND'
  | 'BUILD_COMMAND';

/** One unresolved repository fact. */
export interface AnalysisAmbiguity {
  kind: AnalysisAmbiguityKind;
  /** A short factual sentence stating what is unresolved — never a chain of thought. */
  detail: string;
}

/** One normalized piece of detected evidence. */
export interface EvidenceItem {
  /** Repository path whose contents produced the evidence. */
  sourcePath: string;
  /** What the item claims (e.g. 'required-env', 'redis', 'bucket-var'). */
  type: string;
  /** The detected value, when the claim carries one (an env key, an evidence sentence). */
  value?: string;
  /** How sure the underlying detection is — mirrors the redis confidence tiers. */
  confidence: 'high' | 'medium' | 'low';
}

/** The normalized evidence read-model for one analysis. */
export interface RepositoryEvidence {
  /** Resolved application facts (healthPath comes from the finding, not metadata). */
  application: {
    name: string | null;
    framework: string | null;
    packageManager: string | null;
    dockerfilePath: string | null;
    port: string | null;
    healthPath: string | null;
  };
  /** Every env var the app declares or reads, with its declaring/reading file. */
  environment: EvidenceItem[];
  /** PostgreSQL requirement evidence (driver/connection-var file hits). */
  database: EvidenceItem[];
  /** Redis usage evidence, at the redis assessment's confidence. */
  redis: EvidenceItem[];
  /** Bucket-binding evidence when object storage is required. */
  storage: EvidenceItem[];
}

// ── Detail sentences (stable — `legacyQuestionString` matches on them) ──────

// Legacy producers — parity with the pre-evidence `collectUnresolvedQuestions`.
const DOCKERFILE_TARGET_MULTIPLE_DETAIL =
  'The repository contains more than one Dockerfile candidate; which one builds the application image is unresolved.';
const DOCKERFILE_TARGET_MONOREPO_DETAIL =
  'No root Dockerfile or start script identifies which workspace package to deploy.';
const START_COMMAND_DETAIL = 'No start command was detected in a Dockerfile or a package.json start script.';
const BUILD_COMMAND_DETAIL = 'A package manager is pinned but no build command was detected.';
const PORT_DETAIL = 'No application port was detected.';
const DATABASE_BINDING_DETAIL =
  'PostgreSQL usage was detected but no connection binding was confirmed as required.';
const REDIS_BINDING_DETAIL =
  'Redis usage was detected at medium confidence; whether the cache is required is unresolved.';
// New producers — no legacy question string, surfaced on metadata.ambiguities only.
const HEALTH_PATH_DETAIL =
  'No health check route or container health check was found; a default /health path would be assumed.';
const MIGRATION_STRATEGY_DETAIL = 'PostgreSQL is required but no migration command was detected.';
const STORAGE_BINDING_DETAIL =
  'Object storage usage was detected but no bucket environment variable is declared or read.';
const ARCHITECTURE_REQUIREMENT_DETAIL =
  'Worker code was detected but no command resolves how a worker process starts.';

// ── Metadata readers ─────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(meta: Record<string, unknown>, key: string): string | null {
  const value = meta[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asStringArray(meta: Record<string, unknown>, key: string): string[] {
  const value = meta[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

/** True for a confidence value within the EvidenceItem vocabulary. */
function toConfidence(value: unknown, fallback: EvidenceItem['confidence']): EvidenceItem['confidence'] {
  return value === 'high' || value === 'medium' || value === 'low' ? value : fallback;
}

// ── Legacy question-string mapping ───────────────────────────────────────────

/**
 * Map an ambiguity back to the §15 unresolved-question string it historically
 * produced. The two `DOCKERFILE_TARGET` producers (`multiple-dockerfiles` and
 * `monorepo-target`) map to different strings, so the mapping matches on the
 * producer's stable detail sentence. New kinds return null — they have no
 * question string and never reach the AI prompt.
 */
export function legacyQuestionString(ambiguity: AnalysisAmbiguity): string | null {
  if (ambiguity.kind === 'DOCKERFILE_TARGET') {
    if (ambiguity.detail === DOCKERFILE_TARGET_MULTIPLE_DETAIL) return 'multiple-dockerfiles';
    if (ambiguity.detail === DOCKERFILE_TARGET_MONOREPO_DETAIL) return 'monorepo-target';
    return null;
  }
  switch (ambiguity.kind) {
    case 'START_COMMAND':
      return 'start-command-unknown';
    case 'BUILD_COMMAND':
      return 'build-command-unknown';
    case 'PORT':
      return 'port-unknown';
    case 'DATABASE_BINDING':
      return 'database-requirement-unclear';
    case 'REDIS_BINDING':
      return 'redis-requirement-unclear';
    default:
      return null;
  }
}

// ── Ambiguity derivation ─────────────────────────────────────────────────────

const PACKAGE_JSON_REGEX = /(?:^|\/)package\.json$/;
const ROOT_DOCKERFILE_REGEX = /^dockerfile(?:\.[\w.-]+)?$/i;

/** Whether the root package.json declares a `scripts.start` entry. */
function hasRootStartScript(tree: FileTree): boolean {
  const raw = tree['package.json'];
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { scripts?: unknown };
    const scripts = parsed.scripts;
    if (typeof scripts !== 'object' || scripts === null) return false;
    return typeof (scripts as Record<string, unknown>)['start'] === 'string';
  } catch {
    return false;
  }
}

/**
 * Every fact the deterministic analyser left genuinely unresolved, derived
 * purely from the file tree and its own analysis output. Exactly mirrors the
 * legacy `collectUnresolvedQuestions` question set (mapped one-for-one onto
 * kinds) plus the producers whose evidence is genuinely missing: a health
 * path, a migration strategy for a required database, a bucket binding for
 * object storage, and the worker gate's borderline (worker code with no
 * resolvable start command). A fully-resolved repository yields `[]`.
 */
export function deriveAmbiguities(tree: FileTree, analysis: AnalysisResult): AnalysisAmbiguity[] {
  const meta = analysis.metadata;
  const ambiguities: AnalysisAmbiguity[] = [];

  // ── DOCKERFILE_TARGET: which image/package Deployz builds. ───────────────
  if (listDockerfileCandidates(tree).length > 1) {
    ambiguities.push({ kind: 'DOCKERFILE_TARGET', detail: DOCKERFILE_TARGET_MULTIPLE_DETAIL });
  }
  const packageJsonCount = Object.keys(tree).filter((path) => PACKAGE_JSON_REGEX.test(path)).length;
  const rootHasDockerfile = Object.keys(tree).some((path) => !path.includes('/') && ROOT_DOCKERFILE_REGEX.test(path));
  if (packageJsonCount >= 3 && !hasRootStartScript(tree) && !rootHasDockerfile) {
    ambiguities.push({ kind: 'DOCKERFILE_TARGET', detail: DOCKERFILE_TARGET_MONOREPO_DETAIL });
  }

  // ── START_COMMAND / BUILD_COMMAND / PORT ─────────────────────────────────
  if (meta['hasStartupCommand'] !== true) {
    ambiguities.push({ kind: 'START_COMMAND', detail: START_COMMAND_DETAIL });
  }
  if (meta['hasBuildCommand'] !== true && meta['packageManager'] != null) {
    ambiguities.push({ kind: 'BUILD_COMMAND', detail: BUILD_COMMAND_DETAIL });
  }
  if (meta['port'] == null && meta['hasDockerfile'] !== true) {
    ambiguities.push({ kind: 'PORT', detail: PORT_DETAIL });
  }

  // ── DATABASE_BINDING / REDIS_BINDING (legacy requirement-unclear pair) ───
  const postgres = asRecord(meta['postgres']);
  if (meta['usesPostgresql'] === true && postgres['required'] !== true) {
    ambiguities.push({ kind: 'DATABASE_BINDING', detail: DATABASE_BINDING_DETAIL });
  }
  if (asRecord(meta['redis'])['confidence'] === 'medium') {
    ambiguities.push({ kind: 'REDIS_BINDING', detail: REDIS_BINDING_DETAIL });
  }

  // ── HEALTH_PATH: the manifest silently defaults to /health. ──────────────
  if (meta['hasHealthEndpoint'] !== true) {
    ambiguities.push({ kind: 'HEALTH_PATH', detail: HEALTH_PATH_DETAIL });
  }

  // ── MIGRATION_STRATEGY: a required database with no schema-update step. ──
  if (postgres['required'] === true && meta['hasMigrationCommand'] !== true) {
    ambiguities.push({ kind: 'MIGRATION_STRATEGY', detail: MIGRATION_STRATEGY_DETAIL });
  }

  // ── STORAGE_BINDING: object storage with no bucket env var to wire up. ───
  if (meta['usesS3'] === true) {
    const envVars = asStringArray(meta, 'envVars');
    if (!envVars.includes('AWS_S3_BUCKET') && !envVars.includes('S3_BUCKET')) {
      ambiguities.push({ kind: 'STORAGE_BINDING', detail: STORAGE_BINDING_DETAIL });
    }
  }

  // ── ARCHITECTURE_REQUIREMENT: worker gate borderline (code, no command). ──
  if (meta['hasWorkerProcesses'] === true) {
    const patterns = asStringArray(meta, 'workerPatterns');
    const commandResolved = patterns.some(
      (pattern) => pattern.includes('declared worker process') || pattern.startsWith('queue worker command'),
    );
    if (!commandResolved) {
      ambiguities.push({ kind: 'ARCHITECTURE_REQUIREMENT', detail: ARCHITECTURE_REQUIREMENT_DETAIL });
    }
  }

  // Phase 10: a docker-compose-multi-service rejection whose second service
  // carries NO deterministic optional signal (profiles / replicas: 0 would
  // already have filtered it) is genuinely contested — the AI may help decide
  // whether it is truly required or only an optional/reference service.
  const composeRejection = analysis.rejections?.find(
    (rejection) => rejection.dependency === 'docker-compose-multi-service' && rejection.detected,
  );
  if (composeRejection !== undefined) {
    ambiguities.push({
      kind: 'ARCHITECTURE_REQUIREMENT',
      detail:
        'A production Compose file declares multiple application services with no deterministic optional signal; which ones the deployment truly requires is contested.',
    });
  }

  return ambiguities;
}

// ── Evidence read-model ──────────────────────────────────────────────────────

/** File paths named by an envVarModel entry's `source` strings. */
function envSourcePaths(source: readonly string[]): string[] {
  const paths: string[] = [];
  for (const text of source) {
    const read = /^read in (.+)$/.exec(text);
    if (read?.[1] !== undefined) {
      paths.push(read[1]);
      continue;
    }
    const declared = /^(.+?) declares /.exec(text);
    if (declared?.[1] !== undefined) paths.push(declared[1]);
  }
  return [...new Set(paths)];
}

/** The repository file a requirement-evidence sentence names, when it names one. */
function evidenceSourcePath(text: string, tree: FileTree): string | null {
  const match = / in ([\w./-]+)$/.exec(text);
  const path = match?.[1];
  if (path === undefined) return null;
  return Object.prototype.hasOwnProperty.call(tree, path) ? path : null;
}

/** Turn requirement-evidence sentences into items, dropping the ones without a file. */
function itemsFromEvidence(
  evidence: readonly string[],
  tree: FileTree,
  type: string,
  confidence: EvidenceItem['confidence'],
): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  for (const text of evidence) {
    const sourcePath = evidenceSourcePath(text, tree);
    if (sourcePath === null) continue;
    items.push({ sourcePath, type, value: text, confidence });
  }
  return items;
}

/**
 * The normalized evidence view over one analysis result. Pure read-model:
 * every item is mapped from existing detector findings, the §11.2 env-var
 * model, or the postgres/redis requirement objects — nothing is re-scanned.
 * Sections that would merely repeat `metadata` are omitted, so an empty
 * section means the repository carries no evidence of that kind.
 */
export function collectRepositoryEvidence(tree: FileTree, analysis: AnalysisResult): RepositoryEvidence {
  const meta = analysis.metadata;
  const healthFinding = analysis.findings.find((f) => f.detector === 'health-endpoint');

  // ── application ──
  let name: string | null = null;
  const rootRaw = tree['package.json'];
  if (rootRaw) {
    try {
      const parsed = JSON.parse(rootRaw) as { name?: unknown };
      if (typeof parsed.name === 'string' && parsed.name.length > 0) name = parsed.name;
    } catch {
      // A malformed root manifest is "no name" — never a failed read-model.
    }
  }
  const application: RepositoryEvidence['application'] = {
    name,
    framework: asString(meta, 'framework'),
    packageManager: asString(meta, 'packageManager'),
    dockerfilePath: asString(meta, 'dockerfilePath'),
    port: asString(meta, 'port'),
    healthPath: healthFinding?.path ?? null,
  };

  // ── environment: one item per env var that names a declaring/reading file ──
  const rawModel = meta['envVarModel'];
  const envVarModel: ManifestEnvVariable[] = Array.isArray(rawModel)
    ? rawModel.filter((entry): entry is ManifestEnvVariable => {
        return typeof entry === 'object' && entry !== null && typeof (entry as { key?: unknown }).key === 'string';
      })
    : [];
  const environment: EvidenceItem[] = [];
  const bucketVars: EvidenceItem[] = [];
  for (const entry of envVarModel) {
    const sourcePath = envSourcePaths(entry.source)[0];
    if (sourcePath === undefined) continue;
    const type = entry.secret ? 'secret-env' : entry.required ? 'required-env' : 'env';
    environment.push({ sourcePath, type, value: entry.key, confidence: 'high' });
    if (meta['usesS3'] === true && (entry.key === 'AWS_S3_BUCKET' || entry.key === 'S3_BUCKET')) {
      bucketVars.push({ sourcePath, type: 'bucket-var', value: entry.key, confidence: 'high' });
    }
  }

  // ── database / redis: requirement evidence sentences that name a file ─────
  const postgres = asRecord(meta['postgres']);
  const redis = asRecord(meta['redis']);
  const database = itemsFromEvidence(
    asStringArray(postgres, 'evidence'),
    tree,
    'postgres',
    postgres['required'] === true ? 'high' : 'low',
  );
  const redisItems = itemsFromEvidence(
    asStringArray(redis, 'evidence'),
    tree,
    'redis',
    toConfidence(redis['confidence'], 'low'),
  );

  return {
    application,
    environment,
    database,
    redis: redisItems,
    storage: bucketVars,
  };
}
