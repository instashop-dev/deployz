/**
 * §18/§20 infrastructure-binding detection.
 *
 * Phase 2 of the configuration hardening plan: the provisioned values Deployz
 * creates (RDS connection URL + parts, the Valkey cache, the S3 bucket) must
 * reach the container under the environment variable names the application
 * actually reads — MEMOS_DSN, PAPERLESS_DBHOST, SQLALCHEMY_DATABASE_URI,
 * CELERY_BROKER_URL, S3_ATTACHMENTS_BUCKET — not just the standard
 * DATABASE_URL / REDIS_URL / AWS_S3_BUCKET names.
 *
 * `deriveInfrastructureBindings` is a pure, deterministic read over the tree
 * and `AnalysisResult`: for each provisioned resource it names the variables
 * the app uses to reach it. Evidence-first — a name that appears nowhere in
 * the tree is never inferred as a detected alias; only the standard names
 * Deployz always injects are listed without app evidence.
 */

import type { ManifestEnvVariable } from '@deployz/contracts';

import type { AnalysisResult } from './analyser.js';
import { resolveRedisEnvBindings } from './redis.js';
import type { FileTree } from './detectors.js';

// ── Types ───────────────────────────────────────────────────────────────────

export type BindingResource = 'postgres' | 'redis' | 's3';

/** What the provisioned value is: an URL or one of its parts. */
export type BindingSemantic =
  | 'url'
  | 'host'
  | 'port'
  | 'database'
  | 'username'
  | 'password'
  | 'bucket'
  | 'region'
  | 'endpoint';

/** One place a provisioned value must also be injected. */
export interface InfrastructureBinding {
  resource: BindingResource;
  semantic: BindingSemantic;
  /** The environment variable the application reads this value from. */
  applicationVariable: string;
  /**
   * `explicit` — the app's own config/code names this variable (a code read,
   * or a Deployz standard name it is documented to receive); `detected` — the
   * name was only seen in env/sample files; `ai` — an AI-suggested alias
   * (Phase 9), never a deterministic detection.
   */
  source: 'explicit' | 'detected' | 'ai';
  /** How sure the detection is. Standard/explicit names are always high. */
  confidence: 'high' | 'medium' | 'low';
}

// ── Metadata readers ────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asRecordValue(meta: Record<string, unknown>, key: string): Record<string, unknown> {
  return asRecord(meta[key]);
}

function asStringArray(meta: Record<string, unknown>, key: string): string[] {
  const value = meta[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

/** The §11.2 env-var model as a key → entry map (absent when legacy metadata). */
function envVarModelByKey(meta: Record<string, unknown>): Map<string, ManifestEnvVariable> {
  const raw = meta['envVarModel'];
  const entries: ManifestEnvVariable[] = Array.isArray(raw)
    ? raw.filter((entry): entry is ManifestEnvVariable => {
        const record = entry as { key?: unknown };
        return typeof entry === 'object' && entry !== null && typeof record.key === 'string';
      })
    : [];
  return new Map(entries.map((entry) => [entry.key, entry]));
}

// ── Root env-file value reader (only for placeholder-vs-real classification) ─

const ENV_FILE_REGEX = /^\.env(\.\w+)?$/i;
const ENV_LINE_REGEX = /^[ \t]*([A-Z_][A-Z0-9_]*)[ \t]*=[ \t]*(.*)$/gm;

/** A sample value that documents "fill me in" rather than a real default. */
function isPlaceholderValue(value: string): boolean {
  const trimmed = value.trim().replace(/\s+#.*$/, '').trim();
  if (trimmed.length === 0) return true;
  return /^<[^>]*>$|^(?:your|your[-_ ]+|xxx+|changeme|change[-_ ]me|example|placeholder|\.\.\.)$/i.test(
    trimmed,
  );
}

/** Whether any root env file declares `key` with a real (non-placeholder) value. */
function hasRealEnvFileValue(tree: FileTree, key: string): boolean {
  for (const [path, content] of Object.entries(tree)) {
    if (!content || !ENV_FILE_REGEX.test(path)) continue;
    const regex = new RegExp(ENV_LINE_REGEX.source, ENV_LINE_REGEX.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      if (match[1] !== key) continue;
      if (!isPlaceholderValue(match[2] ?? '')) return true;
    }
  }
  return false;
}

// ── Evidence classification ─────────────────────────────────────────────────

interface VarEvidence {
  source: 'explicit' | 'detected';
  confidence: 'high' | 'medium';
}

/**
 * Classify one candidate variable name by where it was seen.
 *
 * - A code read (an envVarModel `read in <path>` source) is an explicit
 *   configuration reference — the deployment must satisfy it → high.
 * - A name seen only in env/sample files is a detected convention; real
 *   values (`.env.example: MEMOS_DSN=postgresql://…`) are high, placeholder
 *   values (`.env.example: PAPERLESS_DBHOST=`) are medium.
 * - A name that appears nowhere in the tree has no evidence → null (the
 *   caller only keeps it when it is a standard name Deployz always injects).
 */
function evidenceForVar(model: Map<string, ManifestEnvVariable>, tree: FileTree, key: string): VarEvidence | null {
  const entry = model.get(key);
  if (!entry) return null;
  if (entry.source.some((text) => text.startsWith('read in '))) {
    return { source: 'explicit', confidence: 'high' };
  }
  if (!entry.source.some((text) => text.includes(' declares '))) return null;
  return hasRealEnvFileValue(tree, key)
    ? { source: 'detected', confidence: 'high' }
    : { source: 'detected', confidence: 'medium' };
}

// ── Candidate name classification per resource ──────────────────────────────

const URL_SUFFIX_REGEX =
  /(?:_DSN|_DATABASE_URL|_DATABASE_URI|_DB_URL|_DB_URI|_POSTGRES_URL|_POSTGRESQL_URL|_SQLALCHEMY_DATABASE_URI)$/i;
const EXACT_URL_NAMES = new Set(['DATABASE_URL', 'DATABASE_URI', 'DB_URL', 'DB_URI', 'POSTGRES_URL', 'POSTGRESQL_URL']);

const HOST_SUFFIX_REGEX = /(?:_DBHOST|_DATABASE_HOST|_PGHOST)$/i;
const PORT_SUFFIX_REGEX = /(?:_DBPORT|_DATABASE_PORT|_PGPORT)$/i;
const DATABASE_SUFFIX_REGEX = /(?:_DBNAME|_DATABASE_NAME)$/i;
const USER_SUFFIX_REGEX = /(?:_DBUSER|_DATABASE_USER)$/i;
const PASSWORD_SUFFIX_REGEX = /(?:_DBPASS|_DBPASSWORD|_DATABASE_PASSWORD)$/i;

const EXACT_HOST_NAMES = new Set(['PGHOST', 'DATABASE_HOST', 'POSTGRES_HOST', 'DBHOST']);
const EXACT_PORT_NAMES = new Set(['PGPORT', 'DATABASE_PORT', 'POSTGRES_PORT', 'DBPORT']);
const EXACT_DATABASE_NAMES = new Set(['PGDATABASE', 'DATABASE_NAME', 'POSTGRES_DB', 'DBNAME']);
const EXACT_USER_NAMES = new Set(['PGUSER', 'DATABASE_USER', 'POSTGRES_USER', 'DBUSER']);
const EXACT_PASSWORD_NAMES = new Set(['PGPASSWORD', 'DATABASE_PASSWORD', 'POSTGRES_PASSWORD', 'DBPASSWORD', 'DBPASS']);

/** The postgres semantic a variable name carries, when the name is a known convention. */
function postgresSemantic(name: string): BindingSemantic | null {
  const upper = name.toUpperCase();
  if (EXACT_URL_NAMES.has(upper) || URL_SUFFIX_REGEX.test(upper)) return 'url';
  if (EXACT_HOST_NAMES.has(upper) || HOST_SUFFIX_REGEX.test(upper)) return 'host';
  if (EXACT_PORT_NAMES.has(upper) || PORT_SUFFIX_REGEX.test(upper)) return 'port';
  if (EXACT_DATABASE_NAMES.has(upper) || DATABASE_SUFFIX_REGEX.test(upper)) return 'database';
  if (EXACT_USER_NAMES.has(upper) || USER_SUFFIX_REGEX.test(upper)) return 'username';
  if (EXACT_PASSWORD_NAMES.has(upper) || PASSWORD_SUFFIX_REGEX.test(upper)) return 'password';
  return null;
}

/** Standard postgres bindings Deployz always injects for a provisioned RDS instance. */
const POSTGRES_STANDARD_BINDINGS: readonly [string, BindingSemantic][] = [
  ['DATABASE_URL', 'url'],
  ['DATABASE_HOST', 'host'],
  ['DATABASE_PORT', 'port'],
  ['DATABASE_NAME', 'database'],
  ['DATABASE_USER', 'username'],
  ['DATABASE_PASSWORD', 'password'],
];

const BUCKET_NAME_REGEX = /(?:^|_)(?:AWS_)?S3_BUCKET(?:_NAME)?$|_BUCKET_NAME$|_BUCKET$/i;
const BUCKET_STANDARD_NAMES = new Set(['STORAGE_BUCKET', 'S3_BUCKET', 'AWS_S3_BUCKET']);

const REGION_NAME_REGEX = /^AWS_REGION$|^S3_REGION$|_S3_REGION$/i;
const ENDPOINT_NAME_REGEX = /^S3_ENDPOINT$|^S3_ENDPOINT_URL$|^AWS_S3_ENDPOINT$/i;

/** The s3 semantic a variable name carries, when the name is a known convention. */
function s3Semantic(name: string): BindingSemantic | null {
  const upper = name.toUpperCase();
  if (BUCKET_NAME_REGEX.test(upper)) return 'bucket';
  if (REGION_NAME_REGEX.test(upper)) return 'region';
  if (ENDPOINT_NAME_REGEX.test(upper)) return 'endpoint';
  return null;
}

// ── Derivation ──────────────────────────────────────────────────────────────

/**
 * The per-resource binding candidates for one analysis, keyed by what the app
 * actually reads. Only bindings for provisioned resources are returned:
 * postgres when `postgres.required` is true, redis when `redis.required` is
 * true, storage when the app uses S3. Standard names Deployz always injects
 * are listed first, then every convention-matching name the repository shows
 * evidence for. Deterministic: same tree → same list.
 */
export function deriveInfrastructureBindings(tree: FileTree, analysis: AnalysisResult): InfrastructureBinding[] {
  const meta = analysis.metadata;
  const model = envVarModelByKey(meta);
  const bindings: InfrastructureBinding[] = [];

  // ── Postgres (only when the manifest provisions RDS) ─────────────────────
  const postgres = asRecordValue(meta, 'postgres');
  if (postgres['required'] === true) {
    for (const [name, semantic] of POSTGRES_STANDARD_BINDINGS) {
      bindings.push({ resource: 'postgres', semantic, applicationVariable: name, source: 'explicit', confidence: 'high' });
    }
    const seen = new Set(POSTGRES_STANDARD_BINDINGS.map(([name]) => name));
    for (const key of model.keys()) {
      if (seen.has(key)) continue;
      const semantic = postgresSemantic(key);
      if (semantic === null) continue;
      const evidence = evidenceForVar(model, tree, key);
      if (evidence === null) continue;
      seen.add(key);
      bindings.push({
        resource: 'postgres',
        semantic,
        applicationVariable: key,
        source: evidence.source,
        confidence: evidence.confidence,
      });
    }
  }

  // ── Redis (only when the manifest provisions the cache) ──────────────────
  // Reuses resolveRedisEnvBindings: the detected (corroborated) connection
  // env vars — REDIS_URL/REDIS_HOST/REDIS_PORT or CELERY_BROKER_URL /
  // QUEUE_REDIS_URL / CACHE_URL — become the injected binding names; an app
  // with no detected names still receives the three standard ones.
  const redis = asRecordValue(meta, 'redis');
  if (redis['required'] === true) {
    const connectionEnvVars = asStringArray(redis, 'connectionEnvVars');
    const present = new Set(connectionEnvVars);
    for (const binding of resolveRedisEnvBindings(connectionEnvVars)) {
      bindings.push({
        resource: 'redis',
        semantic: binding.kind,
        applicationVariable: binding.name,
        source: present.has(binding.name) ? 'detected' : 'explicit',
        confidence: 'high',
      });
    }
  }

  // ── S3 (only when the app uses object storage) ───────────────────────────
  if (meta['usesS3'] === true) {
    const seen = new Set<string>();
    for (const name of [...BUCKET_STANDARD_NAMES].sort()) {
      seen.add(name);
      bindings.push({ resource: 's3', semantic: 'bucket', applicationVariable: name, source: 'explicit', confidence: 'high' });
    }
    for (const key of model.keys()) {
      if (seen.has(key)) continue;
      const semantic = s3Semantic(key);
      if (semantic === null) continue;
      const evidence = evidenceForVar(model, tree, key);
      if (evidence === null) continue;
      seen.add(key);
      bindings.push({
        resource: 's3',
        semantic,
        applicationVariable: key,
        source: evidence.source,
        confidence: evidence.confidence,
      });
    }
  }

  return bindings;
}
