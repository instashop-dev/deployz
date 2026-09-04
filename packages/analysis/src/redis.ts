/**
 * §6-10 Redis assessment — provider-neutral, deterministic detection of
 * Redis usage in a repository, plus a compatibility verdict against
 * Deployz's managed Redis profile (single-node, standalone, non-TLS).
 *
 * Pure function over a `FileTree`: no AI, no network, no side effects.
 * Deliberately provider-neutral — never mentions AWS, ElastiCache, or
 * Valkey; those live only in `@deployz/cdk`.
 */

import type { FileTree } from './detectors.js';
import {
  collectDependencyNames,
  isProductionComposeFile,
  listProductionComposeFiles,
  parsePackageJsons,
} from './detectors.js';

// ── Types ───────────────────────────────────────────────────────────────────

export type RedisConfidence = 'high' | 'medium' | 'low';

export type RedisPurpose =
  | 'cache'
  | 'queue'
  | 'background_jobs'
  | 'sessions'
  | 'rate_limiting'
  | 'locks'
  | 'broker'
  | 'unknown';

export interface RedisCompatibility {
  supported: boolean;
  reason?: string;
}

export interface RedisRequirement {
  required: boolean;
  confidence: RedisConfidence;
  purposes: RedisPurpose[];
  evidence: string[];
  connectionEnvVars: string[];
  compatibility: RedisCompatibility;
}

export type RedisEnvBindingKind = 'url' | 'host' | 'port';

export interface RedisEnvBinding {
  name: string;
  kind: RedisEnvBindingKind;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Canonical order — also the order `connectionEnvVars` is reported in. */
const KNOWN_REDIS_ENV_VARS = [
  'REDIS_URL',
  'REDIS_URI',
  'REDIS_HOST',
  'REDIS_PORT',
  'REDIS_PASSWORD',
  'CACHE_URL',
  'QUEUE_REDIS_URL',
  'CELERY_BROKER_URL',
  'CELERY_RESULT_BACKEND',
] as const;

/** Names that are unambiguous on their own — "REDIS" is literally in the name. */
const UNCONDITIONAL_ENV_VARS = new Set<string>([
  'REDIS_URL',
  'REDIS_URI',
  'REDIS_HOST',
  'REDIS_PORT',
  'REDIS_PASSWORD',
  'QUEUE_REDIS_URL',
]);

/** Ambiguous names (could back any cache/broker) — only count with corroboration. */
const CONDITIONAL_ENV_VARS = new Set<string>(['CACHE_URL', 'CELERY_BROKER_URL', 'CELERY_RESULT_BACKEND']);

const ENV_BINDING_KIND: Partial<Record<string, RedisEnvBindingKind>> = {
  REDIS_URL: 'url',
  REDIS_URI: 'url',
  CACHE_URL: 'url',
  QUEUE_REDIS_URL: 'url',
  CELERY_BROKER_URL: 'url',
  CELERY_RESULT_BACKEND: 'url',
  REDIS_HOST: 'host',
  REDIS_PORT: 'port',
  // REDIS_PASSWORD intentionally has no kind — no auth in MVP (spec §21).
};

const DEFAULT_ENV_BINDINGS: RedisEnvBinding[] = [
  { name: 'REDIS_URL', kind: 'url' },
  { name: 'REDIS_HOST', kind: 'host' },
  { name: 'REDIS_PORT', kind: 'port' },
];

const SOURCE_FILE_REGEX = /\.(ts|js|mjs|cjs|jsx|tsx|py|rb)$/;
const ENV_SAMPLE_FILE_REGEX = /(?:^|\/)\.env\.(?:example|template|sample)$/i;
const COMPOSE_FILE_REGEX = /(?:^|\/)(?:docker-)?compose(?:\.[\w.-]+)?\.ya?ml$/i;
const REQUIREMENTS_FILE_REGEX = /(?:^|\/)requirements(?:[\w.-]*)?\.txt$/i;
const PYPROJECT_FILE_REGEX = /(?:^|\/)pyproject\.toml$/i;
const GEMFILE_REGEX = /(?:^|\/)Gemfile$/;
const GOMOD_REGEX = /(?:^|\/)go\.mod$/;
const COMPOSER_JSON_REGEX = /(?:^|\/)composer\.json$/;
const README_REGEX = /(?:^|\/)README(?:\.[\w.-]+)?$/i;
const REDISS_SCHEME_REGEX = /rediss:\/\//i;

// ── package.json helpers (workspace-aware; dependencies vs devDependencies) ──

function fieldNames(pkg: Record<string, unknown>, field: string): string[] {
  const value = pkg[field];
  if (typeof value !== 'object' || value === null) return [];
  return Object.keys(value as Record<string, unknown>);
}

/**
 * npm dependency names split into "direct" (declared in `dependencies` of
 * any workspace package.json) and "dev-only" (declared in `devDependencies`
 * somewhere but never as a direct dependency anywhere).
 */
function collectNpmDependencies(tree: FileTree): { direct: Set<string>; devOnly: Set<string> } {
  const direct = new Set<string>();
  const dev = new Set<string>();
  for (const pkg of parsePackageJsons(tree)) {
    for (const name of fieldNames(pkg, 'dependencies')) direct.add(name);
    for (const name of fieldNames(pkg, 'devDependencies')) dev.add(name);
  }
  const devOnly = new Set<string>();
  for (const name of dev) {
    if (!direct.has(name)) devOnly.add(name);
  }
  return { direct, devOnly };
}

// ── Generic helpers ─────────────────────────────────────────────────────────

function findFiles(tree: FileTree, regex: RegExp): string[] {
  return Object.keys(tree).filter((p) => regex.test(p));
}

function isSourceFile(path: string): boolean {
  return SOURCE_FILE_REGEX.test(path);
}

/** Parse simple `KEY=VALUE` / `KEY: VALUE` lines from an env-sample file. */
function parseEnvLines(content: string): Map<string, string> {
  const vars = new Map<string, string>();
  const regex = /^\s*([A-Z_][A-Z0-9_]*)\s*[=:]\s*(.*)$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const name = match[1];
    const rawValue = match[2] ?? '';
    if (!name) continue;
    const value = rawValue.trim().replace(/^['"]|['"]$/g, '');
    vars.set(name, value);
  }
  return vars;
}

function isRedisScheme(value: string): boolean {
  return /^rediss?:\/\//i.test(value.trim());
}

/**
 * Whether a Python requirements.txt / pyproject.toml file declares `pkgName`
 * as a dependency. Requires a token boundary on both sides so `redis` does
 * not falsely match inside `django-redis` or `redisearch`.
 */
function hasPythonDependency(content: string, pkgName: string): boolean {
  const escaped = pkgName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(^|[\\s"'[,])${escaped}(?=[\\s"'=<>!~;,\\]]|$)`, 'im');
  return regex.test(content);
}

function hasRubyGem(content: string, gemName: string): boolean {
  const escaped = gemName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`gem\\s+['"]${escaped}['"]`, 'i');
  return regex.test(content);
}

// ── Signal collection ───────────────────────────────────────────────────────
//
// Every signal is tagged with a tier. For confidence purposes:
//   - any 'very-high' or 'high' signal, on its own, is enough for `high`;
//   - 'medium' signals need ≥2 DISTINCT types to reach `high` (a lone one
//     is `medium`) — `type` groups signals that shouldn't independently
//     corroborate each other (e.g. both `redis` and `ioredis` present are
//     still just "an npm Redis client dependency", not two signals);
//   - 'low' signals never affect confidence on their own.

type SignalTier = 'very-high' | 'high' | 'medium' | 'low';

interface Signal {
  tier: SignalTier;
  type: string;
  evidence: string;
  purpose?: RedisPurpose | undefined;
}

// -- Very-high: docker-compose Redis/Valkey image ----------------------------

const COMPOSE_IMAGE_REGEX = /^\s*image:\s*['"]?([^\s'"]+)['"]?/gim;

/** All `image:` values declared in compose-style files, paired with their path. */
function collectComposeImages(tree: FileTree): { path: string; image: string }[] {
  const results: { path: string; image: string }[] = [];
  for (const path of findFiles(tree, COMPOSE_FILE_REGEX)) {
    const content = tree[path];
    if (!content) continue;
    const regex = new RegExp(COMPOSE_IMAGE_REGEX.source, COMPOSE_IMAGE_REGEX.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const image = match[1];
      if (image) results.push({ path, image });
    }
  }
  return results;
}

/**
 * Only the app's PRIMARY production Compose file proves Redis is part of
 * its deployment shape. A root variant (`docker-compose.sqlite-redis.yml`)
 * shows Redis is an option, so it is recorded as evidence without weight;
 * a dev/test/example Compose file is not evidence at all (Stage A COMP-011).
 */
function collectComposeSignals(tree: FileTree, signals: Signal[]): void {
  const primary = listProductionComposeFiles(tree)[0];
  for (const { path, image } of collectComposeImages(tree)) {
    if (!/redis|valkey/i.test(image) || !isProductionComposeFile(path)) continue;
    if (path === primary) {
      signals.push({
        tier: 'very-high',
        type: 'compose-image',
        evidence: `docker-compose service using a Redis/Valkey image (${image}) in ${path}`,
      });
    } else {
      signals.push({
        tier: 'low',
        type: 'compose-variant-image',
        evidence: `docker-compose variant using a Redis/Valkey image (${image}) in ${path}`,
      });
    }
  }
}

// -- Very-high: source-code client initialization ----------------------------

const CLIENT_INIT_PATTERNS: { pattern: RegExp; name: string; purpose?: RedisPurpose }[] = [
  { pattern: /new\s+Redis\s*\(/, name: 'new Redis(' },
  { pattern: /Redis\.from_url\s*\(/, name: 'Redis.from_url(' },
  { pattern: /redis\.Redis\s*\(/, name: 'redis.Redis(' },
  { pattern: /Sidekiq\.configure\b/, name: 'Sidekiq.configure', purpose: 'background_jobs' },
];
const CREATE_CLIENT_REGEX = /createClient\s*\(/;
const REDIS_IMPORT_REGEX = /(?:from\s+['"]redis['"]|require\(\s*['"]redis['"]\s*\))/;

// A client built only when configuration says so — `if (env.REDIS_ENABLED) {
// client = new Redis(...) }`, `if (process.env.REDIS_URL) createClient(...)` —
// is an optional integration, not a requirement (Stage A COMP-011).
const GUARD_WINDOW_CHARS = 240;
const REDIS_GUARD_REGEX = /if\s*\([^)]*(?:REDIS|CACHE|ENABLED)[^)]*\)\s*\{?[^{}]*$/;

function isGuardedInit(content: string, index: number): boolean {
  return REDIS_GUARD_REGEX.test(content.slice(Math.max(0, index - GUARD_WINDOW_CHARS), index));
}

function collectSourceClientInitSignals(tree: FileTree, signals: Signal[]): void {
  for (const [path, content] of Object.entries(tree)) {
    if (!isSourceFile(path)) continue;

    for (const { pattern, name, purpose } of CLIENT_INIT_PATTERNS) {
      const index = content.search(pattern);
      if (index === -1) continue;
      const guarded = isGuardedInit(content, index);
      signals.push({
        tier: guarded ? 'low' : 'very-high',
        type: guarded ? 'source-client-init-guarded' : 'source-client-init',
        evidence: `Redis client initialization (${name}${guarded ? ', behind a configuration guard' : ''}) in ${path}`,
        purpose,
      });
    }

    const createIndex = content.search(CREATE_CLIENT_REGEX);
    if (createIndex !== -1 && REDIS_IMPORT_REGEX.test(content)) {
      const guarded = isGuardedInit(content, createIndex);
      signals.push({
        tier: guarded ? 'low' : 'very-high',
        type: guarded ? 'source-client-init-guarded' : 'source-client-init',
        evidence: `Redis client initialization (createClient() with a redis import${guarded ? ', behind a configuration guard' : ''}) in ${path}`,
      });
    }
  }
}

// -- High: known Redis env var referenced -------------------------------------

function collectEnvVarSignals(tree: FileTree, signals: Signal[], connectionEnvVars: Set<string>): void {
  // .env.example / .env.template / .env.sample (any depth).
  for (const path of findFiles(tree, ENV_SAMPLE_FILE_REGEX)) {
    const content = tree[path];
    if (!content) continue;
    const vars = parseEnvLines(content);

    const hasOtherRedisEvidenceInFile = [...UNCONDITIONAL_ENV_VARS].some((name) => vars.has(name));

    for (const [name, value] of vars) {
      if (UNCONDITIONAL_ENV_VARS.has(name)) {
        connectionEnvVars.add(name);
        signals.push({ tier: 'high', type: 'known-env-var', evidence: `${name} referenced in ${path}` });
      } else if (CONDITIONAL_ENV_VARS.has(name)) {
        if (isRedisScheme(value) || hasOtherRedisEvidenceInFile) {
          connectionEnvVars.add(name);
          signals.push({ tier: 'high', type: 'known-env-var', evidence: `${name} referenced in ${path}` });
        }
      }
    }
  }

  // process.env.X in source code.
  for (const [path, content] of Object.entries(tree)) {
    if (!isSourceFile(path)) continue;
    for (const name of KNOWN_REDIS_ENV_VARS) {
      if (!new RegExp(`process\\.env\\.${name}\\b`).test(content)) continue;

      if (CONDITIONAL_ENV_VARS.has(name)) {
        const hasOtherEvidence = [...UNCONDITIONAL_ENV_VARS].some((other) =>
          new RegExp(`process\\.env\\.${other}\\b`).test(content),
        );
        if (!hasOtherEvidence) continue;
      }

      connectionEnvVars.add(name);
      signals.push({ tier: 'high', type: 'known-env-var', evidence: `process.env.${name} referenced in ${path}` });
    }
  }
}

// -- High: npm Redis-backed job library direct dependency --------------------

const NPM_JOB_LIBRARY_PURPOSE: Record<string, RedisPurpose> = {
  bull: 'queue',
  bullmq: 'queue',
  '@nestjs/bull': 'queue',
  '@nestjs/bullmq': 'queue',
};

function collectNpmJobLibrarySignals(tree: FileTree, signals: Signal[]): void {
  const { direct } = collectNpmDependencies(tree);
  for (const [dep, purpose] of Object.entries(NPM_JOB_LIBRARY_PURPOSE)) {
    if (direct.has(dep)) {
      signals.push({
        tier: 'high',
        type: `npm-job-library:${dep}`,
        evidence: `${dep} dependency in package.json`,
        purpose,
      });
    }
  }
}

// -- High/Medium: Python (celery+broker, rq, django-redis, bare redis) -------

function collectPythonSignals(tree: FileTree, signals: Signal[], connectionEnvVars: Set<string>): void {
  const files = [...findFiles(tree, REQUIREMENTS_FILE_REGEX), ...findFiles(tree, PYPROJECT_FILE_REGEX)];

  let hasCelery = false;
  let hasRedisClient = false;

  for (const path of files) {
    const content = tree[path];
    if (!content) continue;

    if (hasPythonDependency(content, 'celery')) hasCelery = true;
    if (hasPythonDependency(content, 'redis')) hasRedisClient = true;

    if (hasPythonDependency(content, 'rq')) {
      signals.push({ tier: 'high', type: 'python-rq', evidence: `rq dependency in ${path}`, purpose: 'background_jobs' });
    }
    if (hasPythonDependency(content, 'django-redis')) {
      signals.push({ tier: 'high', type: 'python-django-redis', evidence: `django-redis dependency in ${path}`, purpose: 'cache' });
    }
  }

  // A redis-ish broker signal: a redis-scheme CELERY_BROKER_URL/CELERY_RESULT_BACKEND
  // (already resolved by collectEnvVarSignals into connectionEnvVars), or a bare
  // `redis` client dependency alongside celery.
  const hasBrokerSignal =
    connectionEnvVars.has('CELERY_BROKER_URL') || connectionEnvVars.has('CELERY_RESULT_BACKEND') || hasRedisClient;

  if (hasCelery && hasBrokerSignal) {
    signals.push({
      tier: 'high',
      type: 'python-celery-broker',
      evidence: 'celery with a Redis broker/result-backend signal',
      purpose: 'broker',
    });
  }

  if (hasRedisClient) {
    signals.push({ tier: 'medium', type: 'python-redis-client', evidence: `redis dependency (Python) in ${files.join(', ')}` });
  }
}

// -- High: Ruby sidekiq in Gemfile; Medium: bare redis gem -------------------

function collectRubySignals(tree: FileTree, signals: Signal[]): void {
  for (const path of findFiles(tree, GEMFILE_REGEX)) {
    const content = tree[path];
    if (!content) continue;

    if (hasRubyGem(content, 'sidekiq')) {
      signals.push({ tier: 'high', type: 'ruby-sidekiq', evidence: `sidekiq gem in ${path}`, purpose: 'background_jobs' });
    }
    if (hasRubyGem(content, 'redis')) {
      signals.push({ tier: 'medium', type: 'ruby-redis-client', evidence: `redis gem in ${path}` });
    }
  }
}

// -- Medium: Go go-redis in go.mod -------------------------------------------

const GO_REDIS_IMPORTS = ['github.com/redis/go-redis', 'github.com/go-redis/redis'];

function collectGoSignals(tree: FileTree, signals: Signal[]): void {
  for (const path of findFiles(tree, GOMOD_REGEX)) {
    const content = tree[path];
    if (!content) continue;
    for (const imp of GO_REDIS_IMPORTS) {
      if (content.includes(imp)) {
        signals.push({ tier: 'medium', type: 'go-redis-client', evidence: `${imp} in ${path}` });
        break;
      }
    }
  }
}

// -- Medium: PHP predis/predis in composer.json require ----------------------

function collectPhpSignals(tree: FileTree, signals: Signal[]): void {
  for (const path of findFiles(tree, COMPOSER_JSON_REGEX)) {
    const content = tree[path];
    if (!content) continue;
    try {
      const json = JSON.parse(content) as Record<string, unknown>;
      const require = json['require'];
      if (typeof require === 'object' && require !== null && 'predis/predis' in (require as Record<string, unknown>)) {
        signals.push({ tier: 'medium', type: 'php-redis-client', evidence: `predis/predis dependency in ${path}` });
      }
    } catch {
      // A malformed composer.json is "no manifest" — never a failed analysis.
    }
  }
}

// -- Medium: npm bare Redis client dependency; Low: devDependencies-only -----

/**
 * `connect-redis` is a Redis client too (used for Express/Connect session
 * stores) — it belongs in the same "direct Redis client dependency" bucket
 * as `redis`/`ioredis`/`@redis/client`, just with a `sessions` purpose
 * instead of no purpose.
 */
const NPM_CLIENT_DEPS: Record<string, RedisPurpose | undefined> = {
  redis: undefined,
  ioredis: undefined,
  '@redis/client': undefined,
  'connect-redis': 'sessions',
};

function collectNpmClientSignals(tree: FileTree, signals: Signal[]): void {
  const { direct, devOnly } = collectNpmDependencies(tree);

  let matchedDirect = false;
  for (const [dep, purpose] of Object.entries(NPM_CLIENT_DEPS)) {
    if (direct.has(dep)) {
      matchedDirect = true;
      signals.push({ tier: 'medium', type: 'npm-redis-client', evidence: `${dep} dependency in package.json`, purpose });
    }
  }
  if (matchedDirect) return;

  for (const dep of Object.keys(NPM_CLIENT_DEPS)) {
    if (devOnly.has(dep)) {
      signals.push({ tier: 'low', type: 'npm-redis-client-dev', evidence: `${dep} present only in devDependencies` });
      break;
    }
  }
}

// -- Low: README mention ------------------------------------------------------

function collectReadmeSignals(tree: FileTree, signals: Signal[]): void {
  for (const path of findFiles(tree, README_REGEX)) {
    const content = tree[path];
    if (content && /\bredis\b/i.test(content)) {
      signals.push({ tier: 'low', type: 'readme-mention', evidence: `Redis mentioned in ${path}` });
      break;
    }
  }
}

// ── Compatibility ────────────────────────────────────────────────────────────

const STACK_MODULE_DEPS = ['@redis/json', '@redis/search', 'redis-om'];
const STACK_MODULE_REASON = 'Requires Redis Stack modules (RedisJSON/RediSearch), which Deployz does not support.';
const CLUSTER_REASON = 'Requires Redis Cluster mode, which Deployz does not support.';
const TLS_REASON = "Requires TLS (rediss://) connections, which Deployz's managed Redis does not provide.";

const CLUSTER_PATTERNS = [
  /new\s+Redis\.Cluster\s*\(/,
  /createCluster\s*\(/,
  /RedisCluster\s*\(/,
  /CLUSTER\s+SLOTS/i,
];

/** True when the pattern matches on a line that starts at column 0 (module top level). */
function isTopLevelMatch(content: string, pattern: RegExp): boolean {
  const index = content.search(pattern);
  if (index === -1) return false;
  const lineStart = content.lastIndexOf('\n', index) + 1;
  return !/^\s/.test(content.slice(lineStart, index + 1));
}

function evaluateCompatibility(tree: FileTree): RedisCompatibility {
  // 1. Redis Stack modules — npm deps (dependencies + devDependencies).
  const npmDeps = collectDependencyNames(tree);
  if (STACK_MODULE_DEPS.some((dep) => npmDeps.includes(dep))) {
    return { supported: false, reason: STACK_MODULE_REASON };
  }

  // 1b. Redis Stack modules — Python (redisearch / rejson).
  const pythonFiles = [...findFiles(tree, REQUIREMENTS_FILE_REGEX), ...findFiles(tree, PYPROJECT_FILE_REGEX)];
  for (const path of pythonFiles) {
    const content = tree[path];
    if (!content) continue;
    if (hasPythonDependency(content, 'redisearch') || hasPythonDependency(content, 'rejson')) {
      return { supported: false, reason: STACK_MODULE_REASON };
    }
  }

  // 2. compose image containing `redis-stack`.
  for (const { image } of collectComposeImages(tree)) {
    if (/redis-stack/i.test(image)) {
      return { supported: false, reason: STACK_MODULE_REASON };
    }
  }

  // 3. Cluster usage — source files only, like every other text-pattern signal in
  // this module. Scanning every file (README/docs included) would flip a fully
  // compatible repo to unsupported over prose that merely mentions `createCluster()`.
  // Only an UNCONDITIONAL construction counts — one at the top level of a
  // module. A cluster client built inside a function or method is an option
  // the app offers next to its standalone client (Stage A COMP-019).
  for (const path of Object.keys(tree).filter(isSourceFile)) {
    const content = tree[path];
    if (content && CLUSTER_PATTERNS.some((pattern) => isTopLevelMatch(content, pattern))) {
      return { supported: false, reason: CLUSTER_REASON };
    }
  }

  // 4. `rediss://` anywhere in env samples or source.
  const candidatePaths = [...findFiles(tree, ENV_SAMPLE_FILE_REGEX), ...Object.keys(tree).filter(isSourceFile)];
  for (const path of candidatePaths) {
    const content = tree[path];
    if (content && REDISS_SCHEME_REGEX.test(content)) {
      return { supported: false, reason: TLS_REASON };
    }
  }

  return { supported: true };
}

// ── Orchestrator ────────────────────────────────────────────────────────────

/**
 * Assess a repository's Redis requirement: whether it needs Redis, how
 * confident that detection is, what it's used for, and whether the way it's
 * used is compatible with Deployz's managed Redis profile.
 *
 * Pure function: same input → same output every time. No AI, no network.
 */
export function assessRedis(tree: FileTree): RedisRequirement {
  const signals: Signal[] = [];
  const connectionEnvVars = new Set<string>();

  collectComposeSignals(tree, signals);
  collectSourceClientInitSignals(tree, signals);
  collectEnvVarSignals(tree, signals, connectionEnvVars);
  collectNpmJobLibrarySignals(tree, signals);
  collectPythonSignals(tree, signals, connectionEnvVars);
  collectRubySignals(tree, signals);
  collectGoSignals(tree, signals);
  collectPhpSignals(tree, signals);
  collectNpmClientSignals(tree, signals);
  collectReadmeSignals(tree, signals);

  const hasVeryHigh = signals.some((s) => s.tier === 'very-high');
  const hasHigh = signals.some((s) => s.tier === 'high');
  const mediumTypes = new Set(signals.filter((s) => s.tier === 'medium').map((s) => s.type));

  let confidence: RedisConfidence;
  if (hasVeryHigh || hasHigh || mediumTypes.size >= 2) {
    confidence = 'high';
  } else if (mediumTypes.size === 1) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  const purposes = [...new Set(signals.map((s) => s.purpose).filter((p): p is RedisPurpose => Boolean(p)))];
  if (purposes.length === 0) purposes.push('unknown');

  const evidence = [...new Set(signals.map((s) => s.evidence))];
  const orderedConnectionEnvVars = KNOWN_REDIS_ENV_VARS.filter((v) => connectionEnvVars.has(v));

  const compatibility = evaluateCompatibility(tree);
  const required = confidence === 'high' && compatibility.supported;

  return {
    required,
    confidence,
    purposes,
    evidence,
    connectionEnvVars: orderedConnectionEnvVars,
    compatibility,
  };
}

// ── Env var → binding resolution ────────────────────────────────────────────

/**
 * Resolve detected `connectionEnvVars` into the injectable bindings a
 * consumer (e.g. `@deployz/cdk`) should set on the container: which env var
 * names carry a full connection URL vs. just host/port. `REDIS_PASSWORD` is
 * never resolved — no auth in the MVP (spec §21).
 *
 * Empty or unrecognized input falls back to the three defaults Deployz
 * always injects: `REDIS_URL`, `REDIS_HOST`, `REDIS_PORT`.
 */
export function resolveRedisEnvBindings(connectionEnvVars: string[]): RedisEnvBinding[] {
  const present = new Set(connectionEnvVars);
  const bindings: RedisEnvBinding[] = [];

  for (const name of KNOWN_REDIS_ENV_VARS) {
    if (!present.has(name)) continue;
    const kind = ENV_BINDING_KIND[name];
    if (!kind) continue;
    bindings.push({ name, kind });
  }

  return bindings.length > 0 ? bindings : DEFAULT_ENV_BINDINGS;
}
