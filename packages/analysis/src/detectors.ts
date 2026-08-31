/**
 * §18 detectors — pure deterministic functions that examine a file tree
 * and return findings about the repository's structure and dependencies.
 *
 * Each detector is a standalone pure function: `(tree: FileTree) => DetectorFinding`.
 * No AI, no network, no side effects.
 */

// ── Types ───────────────────────────────────────────────────────────────────

/** A file tree: path → file contents (strings only; directories are implicit via path keys). */
export interface FileTree {
  [path: string]: string;
}

/** Result from a single detector. */
export interface DetectorFinding {
  /** The detector name (e.g. "dockerfile", "framework"). */
  detector: string;
  /** Whether the pattern was detected. */
  detected: boolean;
  /** The detected value(s) — a string, array of strings, or undefined if not detected. */
  value?: string | string[] | undefined;
  /** Additional context (e.g. "detected via HEALTHCHECK instruction"). */
  details?: string | undefined;
  /**
   * A single normalized URL path, when the detector's evidence names one.
   * Only `health-endpoint` sets this today (the literal path a health check
   * targets, e.g. "/api/health") — every other detector leaves it undefined.
   */
  path?: string | undefined;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Matches a package.json at the repository root or in any workspace package. */
const PACKAGE_JSON_REGEX = /(?:^|\/)package\.json$/;

/**
 * Parse every package.json in the tree, repository root first.
 *
 * A monorepo keeps its dependencies and scripts in the workspace packages,
 * not in the root manifest — reading only the root manifest makes a
 * workspace repository look dependency-free, so every detector that asks
 * about dependencies or scripts asks about ALL of them.
 */
export function parsePackageJsons(tree: FileTree): Record<string, unknown>[] {
  const paths = Object.keys(tree)
    .filter((path) => PACKAGE_JSON_REGEX.test(path))
    .sort((a, b) => a.split('/').length - b.split('/').length);

  const parsed: Record<string, unknown>[] = [];
  for (const path of paths) {
    const raw = tree[path];
    if (!raw) continue;
    try {
      const value = JSON.parse(raw);
      if (typeof value === 'object' && value !== null) {
        parsed.push(value as Record<string, unknown>);
      }
    } catch {
      // A malformed manifest is "no manifest" — never a failed analysis.
    }
  }
  return parsed;
}

/** Get all keys from the package.json "scripts" field, or empty object. */
function getScripts(pkg: Record<string, unknown> | null): Record<string, string> {
  if (!pkg) return {};
  const scripts = pkg['scripts'];
  if (typeof scripts !== 'object' || scripts === null) return {};
  return scripts as Record<string, string>;
}

/** Get all dependency names from dependencies + devDependencies combined. */
function getDependencyNames(pkg: Record<string, unknown> | null): string[] {
  if (!pkg) return [];
  const names = new Set<string>();
  for (const field of ['dependencies', 'devDependencies']) {
    const deps = pkg[field];
    if (typeof deps === 'object' && deps !== null) {
      for (const name of Object.keys(deps as Record<string, unknown>)) {
        names.add(name);
      }
    }
  }
  return [...names];
}

/**
 * Every dependency declared anywhere in the repository — the root manifest
 * plus every workspace package manifest. Shared with the §10 rejection
 * checks so both sides of the verdict read the same dependency set.
 */
export function collectDependencyNames(tree: FileTree): string[] {
  const names = new Set<string>();
  for (const pkg of parsePackageJsons(tree)) {
    for (const name of getDependencyNames(pkg)) {
      names.add(name);
    }
  }
  return [...names];
}

/**
 * Every script entry declared anywhere in the repository — the root
 * manifest plus every workspace package manifest, same reasoning as
 * `collectDependencyNames`. Shared with the §35 contract-field backfill
 * (apps/api/src/analysis.ts) so migration/worker command resolution sees
 * workspace-package scripts too, not just the root manifest's.
 */
export function collectScripts(tree: FileTree): [string, string][] {
  const entries: [string, string][] = [];
  for (const pkg of parsePackageJsons(tree)) {
    for (const [name, command] of Object.entries(getScripts(pkg))) {
      if (typeof command === 'string') {
        entries.push([name, command]);
      }
    }
  }
  return entries;
}

/** Find all files whose path matches a regex and return their paths. */
function findFiles(tree: FileTree, pathRegex: RegExp): string[] {
  return Object.keys(tree).filter((p) => pathRegex.test(p));
}

/** Get content of the first file matching a path regex, or null. */
function findFileContent(tree: FileTree, pathRegex: RegExp): string | null {
  const match = Object.keys(tree).find((p) => pathRegex.test(p));
  if (!match) return null;
  return tree[match] ?? null;
}

// ── Detectors ───────────────────────────────────────────────────────────────

// 1. Dockerfile
// ---------------------------------------------------------------------------

// Matches a Dockerfile in ANY directory, with or without a suffix:
// `Dockerfile`, `dockerfile`, `docker/Dockerfile`, `apps/web/Dockerfile.prod`.
// A repository that keeps its Dockerfile out of the root is the common case,
// not the exception.
const DOCKERFILE_REGEX = /(?:^|\/)dockerfile(?:\.[\w.-]+)?$/i;

// Exact `Dockerfile`/`dockerfile` basename, no suffix — used to rank an
// unsuffixed Dockerfile above a suffixed variant at the same depth.
const EXACT_DOCKERFILE_NAME_REGEX = /(?:^|\/)dockerfile$/i;

/**
 * Rank two candidate Dockerfile paths so the more likely "real" build
 * Dockerfile sorts first: shallower paths win, then an exact `Dockerfile`
 * name over a suffixed variant (`Dockerfile.gotenberg`), then lexicographic
 * order for remaining ties. A repository can ship several Dockerfiles for
 * auxiliary services (e.g. a dev-only PDF service); picking the first one
 * `Object.keys` happens to return risks building the wrong image.
 */
function compareDockerfileCandidates(a: string, b: string): number {
  const depthDiff = a.split('/').length - b.split('/').length;
  if (depthDiff !== 0) return depthDiff;

  const aExact = EXACT_DOCKERFILE_NAME_REGEX.test(a);
  const bExact = EXACT_DOCKERFILE_NAME_REGEX.test(b);
  if (aExact !== bExact) return aExact ? -1 : 1;

  return a.localeCompare(b);
}

/**
 * Detect a Dockerfile (case-insensitive: `Dockerfile`, `dockerfile`, `Dockerfile.prod`, etc.).
 */
export function detectDockerfile(tree: FileTree): DetectorFinding {
  const match = findFiles(tree, DOCKERFILE_REGEX);
  if (match.length === 0) {
    return { detector: 'dockerfile', detected: false };
  }
  const ranked = [...match].sort(compareDockerfileCandidates);
  return {
    detector: 'dockerfile',
    detected: true,
    value: ranked[0],
    details: `Found ${match.length} Dockerfile(s): ${match.join(', ')}`,
  };
}

/**
 * All Dockerfile candidates in the tree, ranked the same way `detectDockerfile`
 * picks its single best guess. Used by the AI repository-analysis fallback to
 * detect a genuinely ambiguous multi-Dockerfile repository (the
 * `multiple-dockerfiles` unresolved question), distinct from
 * `detectDockerfile`'s "pick the most likely one" behavior.
 */
export function listDockerfileCandidates(tree: FileTree): string[] {
  return findFiles(tree, DOCKERFILE_REGEX).sort(compareDockerfileCandidates);
}

// 2. Framework
// ---------------------------------------------------------------------------

const KNOWN_FRAMEWORKS = [
  'express',
  'fastify',
  'next',
  'nuxt',
  'nest',
  '@nestjs/core',
  'koa',
  'hapi',
  '@hapi/hapi',
  'restify',
] as const;

/**
 * Detect the application framework from package.json dependencies.
 * Returns the first matching framework name.
 */
export function detectFramework(tree: FileTree): DetectorFinding {
  const deps = collectDependencyNames(tree);
  for (const framework of KNOWN_FRAMEWORKS) {
    if (deps.includes(framework)) {
      return {
        detector: 'framework',
        detected: true,
        value: framework,
        details: `Framework detected: ${framework}`,
      };
    }
  }
  return { detector: 'framework', detected: false };
}

// 3. Port
// ---------------------------------------------------------------------------

/** Pattern: PORT=1234 in env files or process.env.PORT || fallback in source. */
const PORT_ENV_REGEX = /^PORT\s*=\s*(\d+)/m;
const PORT_PROCESS_REGEX = /process\.env\.PORT\s*\|\|\s*(\d+)/;
const PORT_DOCKER_COMPOSE_REGEX = /\$\{?PORT[:-](\d+)/;

/**
 * Detect the application port from env files, docker-compose, or source code.
 */
export function detectPort(tree: FileTree): DetectorFinding {
  // 1. Check env files (.env, .env.example)
  for (const path of Object.keys(tree)) {
    if (/^\.env(\.\w+)?$/i.test(path)) {
      const content = tree[path];
      if (!content) continue;
      const match = PORT_ENV_REGEX.exec(content);
      if (match && match[1]) {
        return {
          detector: 'port',
          detected: true,
          value: match[1],
          details: `Port ${match[1]} detected in ${path}`,
        };
      }
    }
  }

  // 2. Check docker-compose.yml
  const dcContent = findFileContent(tree, /^docker-compose\.ya?ml$/i);
  if (dcContent) {
    const match = PORT_DOCKER_COMPOSE_REGEX.exec(dcContent);
    if (match && match[1]) {
      return {
        detector: 'port',
        detected: true,
        value: match[1],
        details: `Port ${match[1]} detected in docker-compose`,
      };
    }
  }

  // 3. Check source code for process.env.PORT || fallback
  for (const [path, content] of Object.entries(tree)) {
    if (/\.(ts|js|mjs|cjs|jsx|tsx)$/.test(path)) {
      const match = PORT_PROCESS_REGEX.exec(content);
      if (match && match[1]) {
        return {
          detector: 'port',
          detected: true,
          value: match[1],
          details: `Default port ${match[1]} detected in ${path}`,
        };
      }
    }
  }

  return { detector: 'port', detected: false };
}

// 4. Health endpoint
// ---------------------------------------------------------------------------

const HEALTHCHECK_REGEX = /HEALTHCHECK\b/i;
// Route registrations, including the prefixed forms a real application uses:
// `/health`, `/healthz`, `/api/health`, `/api/v1/healthcheck`. The receiver
// group (what precedes `.get(`) feeds mount composition; the path group is
// the detector's normalized `path`. Neither group changes which strings
// match — `get(` with no receiver still matches.
const HEALTH_ROUTE_REGEX =
  /([A-Za-z_$][\w$]*)?\s*\.?\s*(?:get|post|put|all|route)\s*\(.*['"`]([\w/-]*\/(?:health|healthz|healthcheck|heartbeat))\b/i;
const HEALTH_HTTP_ADAPTER_REGEX =
  /\.getHttpAdapter\(\)\..*?['"`]([\w/-]*\/(?:health|healthz|healthcheck|heartbeat))\b/;
const HEALTH_SCRIPT_REGEX = /^healthcheck$/i;
// File-based routing (Next.js, Remix, Nuxt, SvelteKit) declares the path in
// the FILE NAME, so there is no route string to match: `api/health.ts`,
// `app/api/health/route.ts`, `pages/api/healthz.js`.
const HEALTH_ROUTE_FILE_REGEX =
  /(?:^|\/)(?:health|healthz|healthcheck|heartbeat)(?:\.[jt]sx?|\/(?:route|index|\+server)\.[jt]sx?)$/i;
// Router mounts: `app.use('/api', router)` / `apiRouter.use('/v1', v1Router)`.
// The prefix is as literal as a route string, so composing mount prefix +
// route path yields the path the app actually serves.
const ROUTER_MOUNT_REGEX =
  /([A-Za-z_$][\w$]*)\s*\.\s*use\s*\(\s*['"`](\/[\w/-]*)['"`]\s*,\s*([A-Za-z_$][\w$]*)/g;

// Priority for resolving a single normalized `path` when more than one
// signal names one: an exact route registration (or NestJS adapter call) in
// source code names the literal path the app actually serves, so it
// outranks a path only INFERRED from a file-based router convention
// (Next.js/Remix/SvelteKit). A Dockerfile HEALTHCHECK / package.json
// "healthcheck" script only prove a check exists — the CMD text can be
// stale (the audited repo's Dockerfile still curled /health after the app
// moved its route to /api/health), so they never produce a path candidate.
const HEALTH_PATH_PRIORITY = {
  ROUTE_REGISTRATION: 0,
  FILE_ROUTE: 1,
} as const;

/** Ensure a captured/derived health path starts with a leading slash. */
function normalizeHealthPath(raw: string): string {
  return raw.startsWith('/') ? raw : `/${raw}`;
}

/**
 * Derive the URL path a file-based health-check ROUTE FILE implies, mirroring
 * how a file location maps to a URL for Next.js (app-router
 * `app/api/health/route.ts`, pages-router `pages/api/health.ts`) and similar
 * file-based routers. `app`, `pages`, and `src` are router-root directories
 * that never appear in the URL; once an `api` segment is seen, everything
 * from there on is literal.
 */
function deriveHealthPathFromFile(filePath: string): string {
  const trimmed = filePath.replace(/\.[jt]sx?$/, '').replace(/\/(?:route|index|\+server)$/, '');
  const segments = trimmed.split('/').filter(Boolean);
  const apiIndex = segments.indexOf('api');
  const relevant =
    apiIndex === -1 ? segments.filter((s) => s !== 'app' && s !== 'pages' && s !== 'src') : segments.slice(apiIndex);
  return `/${relevant.join('/')}`;
}

/**
 * Compose the mount chain a router route hangs from: `router.get('/health')`
 * mounted by `app.use('/api', router)` serves `/api/health`. Walks mounts by
 * variable identity until a receiver nothing mounts (typically `app`), with a
 * cycle guard. Returns undefined when the receiver sits on no mount — the
 * route string is then already the full path (`app.get('/health')`), or its
 * mount simply was not found and the raw path is the honest fallback.
 */
function composeMountedPath(
  receiver: string | undefined,
  routePath: string,
  mounts: { mounter: string; prefix: string; router: string }[],
): string | undefined {
  if (receiver === undefined) return undefined;
  let path = routePath;
  let current: string | undefined = receiver;
  const seen = new Set<string>();
  let composed = false;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const mount = mounts.find((candidate) => candidate.router === current);
    if (!mount) break;
    path = `${mount.prefix}${path}`;
    composed = true;
    current = mount.mounter;
  }
  return composed ? path : undefined;
}

/**
 * Detect a health check endpoint from Dockerfile HEALTHCHECK, package.json scripts,
 * route patterns in source code, or a file-based route path.
 */
export function detectHealthEndpoint(tree: FileTree): DetectorFinding {
  const sources: string[] = [];
  const pathCandidates: { path: string; priority: number }[] = [];

  // 0. Router mounts, collected first because a mount and the routes it
  // carries usually live in different files.
  const mounts: { mounter: string; prefix: string; router: string }[] = [];
  for (const [path, content] of Object.entries(tree)) {
    if (!/\.(ts|js|mjs|cjs|jsx|tsx)$/.test(path) || !content) continue;
    for (const match of content.matchAll(ROUTER_MOUNT_REGEX)) {
      if (match[1] && match[2] && match[3]) {
        mounts.push({ mounter: match[1], prefix: match[2], router: match[3] });
      }
    }
  }

  // 1. Dockerfile HEALTHCHECK instruction
  for (const path of Object.keys(tree)) {
    if (DOCKERFILE_REGEX.test(path)) {
      const content = tree[path];
      if (content && HEALTHCHECK_REGEX.test(content)) {
        sources.push('HEALTHCHECK (Dockerfile)');
      }
    }
  }

  // 2. package.json "healthcheck" script
  for (const [name] of collectScripts(tree)) {
    if (HEALTH_SCRIPT_REGEX.test(name)) {
      sources.push(`healthcheck (package.json script "${name}")`);
    }
  }

  // 3. Route patterns in source code, or a file-based route path
  for (const [path, content] of Object.entries(tree)) {
    if (/\.(ts|js|mjs|cjs|jsx|tsx)$/.test(path)) {
      if (HEALTH_ROUTE_FILE_REGEX.test(path)) {
        sources.push(`health route file (${path})`);
        pathCandidates.push({ path: deriveHealthPathFromFile(path), priority: HEALTH_PATH_PRIORITY.FILE_ROUTE });
      }
      const routeMatch = HEALTH_ROUTE_REGEX.exec(content);
      if (routeMatch) {
        sources.push(`/health route (${path})`);
        if (routeMatch[2]) {
          pathCandidates.push({
            path:
              composeMountedPath(routeMatch[1], normalizeHealthPath(routeMatch[2]), mounts) ??
              normalizeHealthPath(routeMatch[2]),
            priority: HEALTH_PATH_PRIORITY.ROUTE_REGISTRATION,
          });
        }
      }
      const adapterMatch = HEALTH_HTTP_ADAPTER_REGEX.exec(content);
      if (adapterMatch) {
        sources.push(`/health adapter (${path})`);
        if (adapterMatch[1]) {
          pathCandidates.push({
            path: normalizeHealthPath(adapterMatch[1]),
            priority: HEALTH_PATH_PRIORITY.ROUTE_REGISTRATION,
          });
        }
      }
    }
  }

  if (sources.length === 0) {
    return { detector: 'health-endpoint', detected: false };
  }

  // The most specific candidate wins (lowest priority number); on an equal
  // priority the longer path wins — when a repo both registers `/health`
  // directly and mounts a health router under `/api`, the longer mounted
  // path is the one the app actually serves at that URL. When no source
  // named a literal path (Dockerfile HEALTHCHECK / healthcheck script only),
  // "/health" remains the faithful default — that IS the conventional path
  // those two sources check.
  const bestCandidate = pathCandidates.reduce<{ path: string; priority: number } | undefined>(
    (best, candidate) => {
      if (best === undefined || candidate.priority < best.priority) return candidate;
      if (candidate.priority === best.priority && candidate.path.length > best.path.length) return candidate;
      return best;
    },
    undefined,
  );
  const path = bestCandidate?.path ?? '/health';

  return {
    detector: 'health-endpoint',
    detected: true,
    value: sources,
    details: `Health endpoint detected via: ${sources.join('; ')}`,
    path,
  };
}

// 5. Env vars
// ---------------------------------------------------------------------------

const ENV_VAR_REGEX = /^([A-Z_][A-Z0-9_]*)\s*[=:]/gm;
const PROCESS_ENV_REGEX = /process\.env\.(\w+)/g;

/**
 * Detect environment variables from .env files, docker-compose, and source code.
 * Returns deduplicated list of env var names.
 */
export function detectEnvVars(tree: FileTree): DetectorFinding {
  const vars = new Set<string>();

  // 1. .env / .env.example files (KEY=VALUE or KEY: VALUE)
  for (const path of Object.keys(tree)) {
    if (/^\.env(\.\w+)?$/i.test(path)) {
      const content = tree[path];
      if (!content) continue;
      let match: RegExpExecArray | null;
      while ((match = ENV_VAR_REGEX.exec(content)) !== null) {
        if (match[1]) vars.add(match[1]);
      }
    }
  }

  // 2. docker-compose.yml environment section
  const dcContent = findFileContent(tree, /^docker-compose\.ya?ml$/i);
  if (dcContent) {
    let match: RegExpExecArray | null;
    while ((match = ENV_VAR_REGEX.exec(dcContent)) !== null) {
      if (match[1]) vars.add(match[1]);
    }
  }

  // 3. Source code: process.env.X references
  for (const [path, content] of Object.entries(tree)) {
    if (/\.(ts|js|mjs|cjs|jsx|tsx)$/.test(path)) {
      let match: RegExpExecArray | null;
      // Reset lastIndex by creating a new regex each time
      const regex = new RegExp(PROCESS_ENV_REGEX.source, 'g');
      while ((match = regex.exec(content)) !== null) {
        if (match[1]) vars.add(match[1]);
      }
    }
  }

  const varlist = [...vars].sort();
  if (varlist.length === 0) {
    return { detector: 'env-vars', detected: false };
  }

  return {
    detector: 'env-vars',
    detected: true,
    value: varlist,
    details: `${varlist.length} environment variable(s) detected`,
  };
}

// 6. PostgreSQL usage
// ---------------------------------------------------------------------------

const PG_DRIVERS = ['pg', 'postgres', 'drizzle-orm', 'knex'] as const;

/**
 * Detect PostgreSQL usage from package.json dependencies or Prisma schema.
 */
export function detectPostgresql(tree: FileTree): DetectorFinding {
  const detected: string[] = [];
  const deps = collectDependencyNames(tree);

  // Check for postgres-specific drivers
  for (const driver of PG_DRIVERS) {
    if (deps.includes(driver)) {
      detected.push(driver);
    }
  }

  // Check @prisma/client with postgresql provider
  if (deps.includes('@prisma/client')) {
    const schemaContent = findFileContent(tree, /schema\.prisma$/i);
    if (schemaContent && /provider\s*=\s*"postgresql"/i.test(schemaContent)) {
      detected.push('@prisma/client');
    }
  }

  if (detected.length === 0) {
    return { detector: 'postgresql', detected: false };
  }

  return {
    detector: 'postgresql',
    detected: true,
    value: detected,
    details: `PostgreSQL drivers detected: ${detected.join(', ')}`,
  };
}

/** Required-vs-present evidence for PostgreSQL: mirrors `RedisRequirement`, minus the confidence enum. */
export interface PostgresRequirement {
  required: boolean;
  evidence: string[];
}

const PG_CONNECTION_ENV_VARS = [
  'DATABASE_URL',
  'POSTGRES_URL',
  'POSTGRESQL_URL',
  'POSTGRES_HOST',
  'POSTGRES_DB',
] as const;

const COMPOSE_IMAGE_REGEX = /^\s*image:\s*['"]?([^\s'"]+)['"]?/gim;

/**
 * Assess whether a repository's PostgreSQL usage is backed by more than a
 * bare dependency. A driver/ORM library sitting unused in package.json is
 * not enough evidence to provision a managed database — `required` is only
 * true when a driver/ORM dependency AND at least one independent signal
 * (a Prisma postgresql provider, a known connection env var, or a
 * postgres/postgis docker-compose image) are both present.
 *
 * `detectPostgresql`'s `detected` (library presence) is unaffected by this
 * function and keeps driving verdicts/§20 checks — only RDS provisioning
 * (`metadata.postgres.required`) is gated here.
 */
export function assessPostgres(tree: FileTree): PostgresRequirement {
  const evidence: string[] = [];
  const deps = collectDependencyNames(tree);

  let hasDependency = false;
  for (const driver of PG_DRIVERS) {
    if (deps.includes(driver)) {
      hasDependency = true;
      evidence.push(`${driver} dependency in package.json`);
    }
  }

  let hasIndependentEvidence = false;

  // Prisma schema declaring a postgresql provider.
  if (deps.includes('@prisma/client')) {
    for (const path of findFiles(tree, /schema\.prisma$/i)) {
      const content = tree[path];
      if (content && /provider\s*=\s*"postgresql"/i.test(content)) {
        hasDependency = true;
        hasIndependentEvidence = true;
        evidence.push('@prisma/client dependency in package.json');
        evidence.push(`provider = "postgresql" in ${path}`);
      }
    }
  }

  // A known connection env var referenced in an env file, docker-compose, or source.
  for (const name of PG_CONNECTION_ENV_VARS) {
    const envFileRegex = new RegExp(`^${name}\\s*[=:]`, 'm');
    const composeRegex = new RegExp(`\\b${name}\\s*[=:]`);
    const processEnvRegex = new RegExp(`process\\.env\\.${name}\\b`);

    for (const [path, content] of Object.entries(tree)) {
      if (!content) continue;
      if (/^\.env(\.\w+)?$/i.test(path) && envFileRegex.test(content)) {
        hasIndependentEvidence = true;
        evidence.push(`${name} referenced in ${path}`);
      } else if (/^docker-compose\.ya?ml$/i.test(path) && composeRegex.test(content)) {
        hasIndependentEvidence = true;
        evidence.push(`${name} referenced in ${path}`);
      } else if (/\.(ts|js|mjs|cjs|jsx|tsx)$/.test(path) && processEnvRegex.test(content)) {
        hasIndependentEvidence = true;
        evidence.push(`process.env.${name} referenced in ${path}`);
      }
    }
  }

  // A postgres/postgis image in docker-compose.
  const dcContent = findFileContent(tree, /^docker-compose\.ya?ml$/i);
  if (dcContent) {
    const regex = new RegExp(COMPOSE_IMAGE_REGEX.source, COMPOSE_IMAGE_REGEX.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(dcContent)) !== null) {
      const image = match[1];
      if (image && /postgres|postgis/i.test(image)) {
        hasIndependentEvidence = true;
        evidence.push(`docker-compose service using a PostgreSQL/PostGIS image (${image})`);
      }
    }
  }

  return {
    required: hasDependency && hasIndependentEvidence,
    evidence: [...new Set(evidence)],
  };
}

// 7. Local filesystem usage
// ---------------------------------------------------------------------------

// WRITES only. A read (`fs.readFileSync` of a bundled template, a certificate,
// a migration file) is not persistent local storage — every container image
// ships files its own code reads back, so rejecting on a read rejects almost
// every real application. What breaks in an ephemeral container is state
// WRITTEN to local disk and expected to still be there on the next request.
const FS_PATTERNS: { pattern: RegExp; name: string }[] = [
  { pattern: /fs\.writeFileSync\b/, name: 'fs.writeFileSync' },
  { pattern: /fs\.writeFile\b/, name: 'fs.writeFile' },
  { pattern: /fs\.mkdirSync\b/, name: 'fs.mkdirSync' },
  { pattern: /fs\.mkdir\b/, name: 'fs.mkdir' },
  { pattern: /fs\.appendFileSync\b/, name: 'fs.appendFileSync' },
  { pattern: /fs\.appendFile\b/, name: 'fs.appendFile' },
  { pattern: /fs\.createWriteStream\b/, name: 'fs.createWriteStream' },
];

/**
 * Detect persistent local filesystem usage (fs.writeFile, mkdirSync, etc.).
 * Signals persistent local storage — unsupported in Deployz's ephemeral container model.
 */
export function detectLocalFilesystem(tree: FileTree): DetectorFinding {
  const detected: string[] = [];

  for (const [path, content] of Object.entries(tree)) {
    if (/\.(ts|js|mjs|cjs|jsx|tsx)$/.test(path)) {
      for (const { pattern, name } of FS_PATTERNS) {
        if (pattern.test(content) && !detected.includes(name)) {
          detected.push(name);
        }
      }
    }
  }

  if (detected.length === 0) {
    return { detector: 'local-filesystem', detected: false };
  }

  return {
    detector: 'local-filesystem',
    detected: true,
    value: detected,
    details: `Local filesystem usage detected: ${detected.join(', ')}`,
  };
}

// 8. Worker
// ---------------------------------------------------------------------------

const WORKER_DEPS = ['bull', 'agenda', 'bullmq'] as const;
const WORKER_CODE_REGEX = /(?:require|import)\s*(?:\(|.*from\s*)['"]node:worker_threads['"]/;

/**
 * Detect worker processes (Bull, Agenda, worker_threads, background job patterns).
 */
export function detectWorker(tree: FileTree): DetectorFinding {
  const detected: string[] = [];

  // Check package.json dependencies
  const deps = collectDependencyNames(tree);
  for (const dep of WORKER_DEPS) {
    if (deps.includes(dep)) {
      detected.push(dep);
    }
  }

  // Check source code for worker_threads
  for (const [path, content] of Object.entries(tree)) {
    if (/\.(ts|js|mjs|cjs|jsx|tsx)$/.test(path)) {
      if (WORKER_CODE_REGEX.test(content)) {
        if (!detected.includes('worker_threads')) {
          detected.push('worker_threads');
        }
      }
    }
  }

  if (detected.length === 0) {
    return { detector: 'worker', detected: false };
  }

  return {
    detector: 'worker',
    detected: true,
    value: detected,
    details: `Worker patterns detected: ${detected.join(', ')}`,
  };
}

// 9. S3 usage
// ---------------------------------------------------------------------------

const S3_DEPS = ['@aws-sdk/client-s3', 'aws-sdk'] as const;
const S3_ENV_REGEX = /^(?:AWS_)?S3_BUCKET\s*=/m;

/**
 * Detect S3 usage from package.json dependencies or S3-specific env vars.
 */
export function detectS3(tree: FileTree): DetectorFinding {
  const detected: string[] = [];

  // Check package.json dependencies
  const deps = collectDependencyNames(tree);
  for (const dep of S3_DEPS) {
    if (deps.includes(dep)) {
      detected.push(dep);
    }
  }

  // Check env files for S3_BUCKET / AWS_S3_BUCKET
  for (const path of Object.keys(tree)) {
    if (/^\.env(\.\w+)?$/i.test(path)) {
      const content = tree[path];
      if (content && S3_ENV_REGEX.test(content)) {
        if (!detected.includes('AWS_S3_BUCKET')) {
          detected.push('AWS_S3_BUCKET');
        }
      }
    }
  }

  if (detected.length === 0) {
    return { detector: 's3', detected: false };
  }

  return {
    detector: 's3',
    detected: true,
    value: detected,
    details: `S3 usage detected: ${detected.join(', ')}`,
  };
}

// 10. Migration command
// ---------------------------------------------------------------------------

const MIGRATION_PATTERNS: { pattern: RegExp; name: string }[] = [
  { pattern: /drizzle-kit\s+(push|migrate|generate)/, name: 'drizzle-kit' },
  { pattern: /prisma\s+migrate/, name: 'prisma migrate' },
  { pattern: /knex\s+migrate:(?:latest|up|rollback|make)/, name: 'knex migrate:latest' },
  { pattern: /sequelize\s+db:migrate/, name: 'sequelize db:migrate' },
  { pattern: /typeorm\s+migration:(?:run|revert|generate)/, name: 'typeorm migration:run' },
  { pattern: /npx\s+migrate/, name: 'npx migrate' },
  { pattern: /node-pg-migrate/, name: 'node-pg-migrate' },
];

/**
 * Detect migration commands from package.json scripts.
 */
export function detectMigrationCommand(tree: FileTree): DetectorFinding {
  const detected: string[] = [];

  for (const [, command] of collectScripts(tree)) {
    for (const { pattern, name } of MIGRATION_PATTERNS) {
      if (pattern.test(command) && !detected.includes(name)) {
        detected.push(name);
      }
    }
  }

  if (detected.length === 0) {
    return { detector: 'migration-command', detected: false };
  }

  return {
    detector: 'migration-command',
    detected: true,
    value: detected,
    details: `Migration commands detected: ${detected.join(', ')}`,
  };
}

// 11. Startup command
// ---------------------------------------------------------------------------

const CMD_REGEX = /^CMD\s+(.+)$/m;
const ENTRYPOINT_REGEX = /^ENTRYPOINT\s+(.+)$/m;

/**
 * Detect the application startup command from Dockerfile CMD/ENTRYPOINT
 * instructions and package.json "start" script.
 */
export function detectStartupCommand(tree: FileTree): DetectorFinding {
  const sources: string[] = [];

  // 1. Dockerfile CMD instruction
  for (const path of Object.keys(tree)) {
    if (DOCKERFILE_REGEX.test(path)) {
      const content = tree[path];
      if (!content) continue;
      const cmdMatch = CMD_REGEX.exec(content);
      if (cmdMatch && cmdMatch[1]) {
        sources.push(`CMD: ${cmdMatch[1].trim()}`);
      }
      const entryMatch = ENTRYPOINT_REGEX.exec(content);
      if (entryMatch && entryMatch[1]) {
        sources.push(`ENTRYPOINT: ${entryMatch[1].trim()}`);
      }
    }
  }

  // 2. package.json "start" script
  for (const [name, command] of collectScripts(tree)) {
    if (name === 'start') {
      sources.push(`start: ${command}`);
    }
  }

  if (sources.length === 0) {
    return { detector: 'startup-command', detected: false };
  }

  return {
    detector: 'startup-command',
    detected: true,
    value: sources,
    details: `Startup commands detected: ${sources.join('; ')}`,
  };
}

// 12. External services
// ---------------------------------------------------------------------------

const EXTERNAL_SERVICE_SDKS = [
  'stripe',
  'twilio',
  'sendgrid',
  '@sendgrid/mail',
  'plaid',
  'auth0',
  'firebase-admin',
  'firebase',
  'algoliasearch',
  'contentful',
  'sanity',
  '@sanity/client',
] as const;

const EXTERNAL_URL_REGEX = /https?:\/\/(?!.*\.amazonaws\.com)(?!.*\.aws\.)([a-zA-Z0-9.-]+)/g;

/**
 * Detect external (non-AWS) service dependencies from package.json SDK imports
 * and hardcoded external HTTP API URLs in source code.
 */
export function detectExternalServices(tree: FileTree): DetectorFinding {
  const detected: string[] = [];

  // 1. Check package.json for known external service SDKs
  const deps = collectDependencyNames(tree);
  for (const sdk of EXTERNAL_SERVICE_SDKS) {
    if (deps.includes(sdk) && !detected.includes(sdk)) {
      detected.push(sdk);
    }
  }

  // 2. Scan source code for external HTTP API URLs (non-AWS)
  const seenDomains = new Set<string>();
  for (const [path, content] of Object.entries(tree)) {
    if (/\.(ts|js|mjs|cjs|jsx|tsx)$/.test(path)) {
      let match: RegExpExecArray | null;
      const regex = new RegExp(EXTERNAL_URL_REGEX.source, 'g');
      while ((match = regex.exec(content)) !== null) {
        const domain = match[1];
        if (domain && !seenDomains.has(domain)) {
          seenDomains.add(domain);
          detected.push(domain);
        }
      }
    }
  }

  if (detected.length === 0) {
    return { detector: 'external-services', detected: false };
  }

  return {
    detector: 'external-services',
    detected: true,
    value: detected,
    details: `External services detected: ${detected.join(', ')}`,
  };
}

// 13. Package manager
// ---------------------------------------------------------------------------

// Checked in priority order: a lockfile can only belong to one of these, but
// a repository is only ever expected to carry one at a time.
const LOCKFILE_MANAGERS: { pattern: RegExp; name: string }[] = [
  { pattern: /(?:^|\/)pnpm-lock\.yaml$/, name: 'pnpm' },
  { pattern: /(?:^|\/)yarn\.lock$/, name: 'yarn' },
  { pattern: /(?:^|\/)bun\.lockb?$/, name: 'bun' },
  { pattern: /(?:^|\/)package-lock\.json$/, name: 'npm' },
];

/**
 * Detect the package manager from the root package.json "packageManager"
 * field (a Corepack pin, e.g. "pnpm@9.0.0") or, failing that, a lockfile
 * present anywhere in the tree. The packageManager field wins when both are
 * present — it is an explicit pin, a lockfile is only circumstantial evidence.
 */
export function detectPackageManager(tree: FileTree): DetectorFinding {
  const rootRaw = tree['package.json'];
  if (rootRaw) {
    try {
      const rootPkg = JSON.parse(rootRaw) as Record<string, unknown>;
      const pin = rootPkg['packageManager'];
      if (typeof pin === 'string' && pin.trim()) {
        const name = pin.split('@')[0];
        if (name) {
          return {
            detector: 'package-manager',
            detected: true,
            value: name,
            details: `Package manager pinned via package.json "packageManager": ${pin}`,
          };
        }
      }
    } catch {
      // A malformed root manifest is "no pin" — fall through to lockfile detection.
    }
  }

  for (const { pattern, name } of LOCKFILE_MANAGERS) {
    if (Object.keys(tree).some((path) => pattern.test(path))) {
      return {
        detector: 'package-manager',
        detected: true,
        value: name,
        details: `Package manager detected via lockfile (${name})`,
      };
    }
  }

  return { detector: 'package-manager', detected: false };
}

// 14. Build command
// ---------------------------------------------------------------------------

/**
 * Detect the application build command from package.json "build" scripts,
 * repository root first, same ordering as `parsePackageJsons`.
 */
export function detectBuildCommand(tree: FileTree): DetectorFinding {
  const commands: string[] = [];

  for (const [name, command] of collectScripts(tree)) {
    if (name === 'build') {
      commands.push(command);
    }
  }

  if (commands.length === 0) {
    return { detector: 'build-command', detected: false };
  }

  return {
    detector: 'build-command',
    detected: true,
    value: commands,
    details: `Build commands detected: ${commands.join('; ')}`,
  };
}