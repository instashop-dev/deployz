/**
 * §18 detectors — pure deterministic functions that examine a file tree
 * and return findings about the repository's structure and dependencies.
 *
 * Each detector is a standalone pure function: `(tree: FileTree) => DetectorFinding`.
 * No AI, no network, no side effects.
 */

import type { ManifestEnvVariable } from '@deployz/contracts';

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
  /**
   * Stage B phase 5 — how the health endpoint is known, set only by the
   * `health-endpoint` detector: `explicit` (a declared route or HEALTHCHECK
   * URL names the path), `root` (the app's own HEALTHCHECK probes `/`), or
   * `vendor_required` (no evidence at all — Deployz must not guess).
   */
  mode?: 'explicit' | 'root' | 'vendor_required' | undefined;
  /**
   * Stage B phase 7 (COMP-030) — where a `port` finding came from:
   * `dockerfile-expose` | `compose` | `env` | `runtime-literal` |
   * `framework-default`. Set only by the `port` detector.
   */
  portSource?: string | undefined;
  /** Stage B phase 7 — how confident the port detection is. */
  portConfidence?: 'high' | 'medium' | 'low' | undefined;
  /**
   * Where the winning value was read from, for the detectors whose value
   * the canonical application analysis reports as a fact (framework, port,
   * health endpoint, start/build/migration commands, runtime, bind address).
   */
  source?: DetectorSource | undefined;
}

/** The evidence families a detector value can come from. */
export type DetectorSource = 'dockerfile' | 'package-manifest' | 'compose' | 'env-file' | 'procfile' | 'source';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Matches a package.json at the repository root or in any workspace package. */
const PACKAGE_JSON_REGEX = /(?:^|\/)package\.json$/;

/**
 * Parse every package.json in the tree, alongside the path it came from,
 * repository root first. Shared by `parsePackageJsons` (path discarded) and
 * `collectScriptsWithDir` (path kept, as the originating package's directory).
 */
function parsePackageJsonsWithPath(tree: FileTree): { path: string; pkg: Record<string, unknown> }[] {
  const paths = Object.keys(tree)
    .filter((path) => PACKAGE_JSON_REGEX.test(path))
    .sort((a, b) => a.split('/').length - b.split('/').length);

  const parsed: { path: string; pkg: Record<string, unknown> }[] = [];
  for (const path of paths) {
    const raw = tree[path];
    if (!raw) continue;
    try {
      const value = JSON.parse(raw);
      if (typeof value === 'object' && value !== null) {
        parsed.push({ path, pkg: value as Record<string, unknown> });
      }
    } catch {
      // A malformed manifest is "no manifest" — never a failed analysis.
    }
  }
  return parsed;
}

/**
 * Parse every package.json in the tree, repository root first.
 *
 * A monorepo keeps its dependencies and scripts in the workspace packages,
 * not in the root manifest — reading only the root manifest makes a
 * workspace repository look dependency-free, so every detector that asks
 * about dependencies or scripts asks about ALL of them.
 */
export function parsePackageJsons(tree: FileTree): Record<string, unknown>[] {
  return parsePackageJsonsWithPath(tree).map(({ pkg }) => pkg);
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

/**
 * Same data as `collectScripts`, plus the directory of the package.json each
 * script came from (posix path relative to the repo root, "" for the root
 * manifest itself). Needed by the §35 migration-command resolver
 * (apps/api/src/analysis.ts) to locate the schema.prisma belonging to the
 * same workspace package as the matched script, not just anywhere in the tree.
 */
export function collectScriptsWithDir(tree: FileTree): [string, string, string][] {
  const entries: [string, string, string][] = [];
  for (const { path, pkg } of parsePackageJsonsWithPath(tree)) {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    for (const [name, command] of Object.entries(getScripts(pkg))) {
      if (typeof command === 'string') {
        entries.push([name, command, dir]);
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

// Paths that never run inside the deployed container: tests and fixtures,
// build/release scripts, documentation generators, tool configuration. A
// disk write or an environment read there says nothing about the app at
// runtime (Stage A COMP-003, COMP-016).
const NON_RUNTIME_SEGMENT_REGEX =
  /(?:^|\/)(?:__tests__|__mocks__|__fixtures__|(?:[\w.-]*[-_])?tests?|testdata|specs?|(?:[\w.-]*[-_])?e2e|cypress|fixtures?|stories|scripts?|tools?|bin|docs?|extra|examples?|benchmarks?|\.github|\.husky|\.devcontainer|\.vscode)(?:\/|$)/i;
const NON_RUNTIME_FILE_REGEX =
  /(?:\.(?:test|spec|stories|e2e|cy)\.[cm]?[jt]sx?$|(?:^|\/)(?:[\w.-]+\.config\.[cm]?[jt]s|\.(?:eslintrc|prettierrc|babelrc)(?:\.[cm]?js)?|conftest\.py|test_[\w-]+\.py|[\w-]+_test\.(?:py|go|rb))$)/i;

/** True for source the deployed container actually runs. */
export function isRuntimeSourcePath(path: string): boolean {
  return !NON_RUNTIME_SEGMENT_REGEX.test(path) && !NON_RUNTIME_FILE_REGEX.test(path);
}

// Compose files that describe dev/test/example tooling rather than the app's
// own production deployment shape — by path segment or by filename flavour.
const NON_PRODUCTION_COMPOSE_SEGMENT_REGEX =
  /(?:^|\/)(?:development|dev|test|testing|tests|suites?|e2e|ci|[\w.-]*examples?|[\w.-]*samples?|local|\.devcontainer|playwright|benchmarks?|devenv)(?:\/|$)/i;
const NON_PRODUCTION_COMPOSE_FILENAME_REGEX =
  /(?:docker-compose|compose)\.(?:dev|development|test|testing|override|local|example|sample|ci)\.ya?ml$/i;
const COMPOSE_FILE_REGEX = /(?:^|\/)(?:docker-compose|compose)\.ya?ml$/i;

export function isProductionComposeFile(path: string): boolean {
  return !NON_PRODUCTION_COMPOSE_SEGMENT_REGEX.test(path) && !NON_PRODUCTION_COMPOSE_FILENAME_REGEX.test(path);
}

/**
 * Every Compose file that describes the app's own production shape, the
 * repository-root file first. Variant files at the root
 * (`docker-compose.postgres.yml`) are not matched — they are alternatives,
 * not the default shape — except through `listProductionComposeVariants`.
 */
export function listProductionComposeFiles(tree: FileTree): string[] {
  return Object.keys(tree)
    .filter((path) => COMPOSE_FILE_REGEX.test(path) && isProductionComposeFile(path))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

/**
 * Compose services of the production Compose file: name, image, whether the
 * service only starts under a profile, and its volume mounts. Null when no
 * compose file describes the app's own production deployment — dev/test/
 * example compose files (e.g. `docker/development/compose.yml`, a mail
 * sandbox or PDF renderer for local tooling) are not evidence of the app's
 * architecture (`isProductionComposeFile`). Prefers a repository-root file.
 * A service another service waits on with `service_completed_successfully`
 * is a one-shot job (a migration runner), not an application container
 * (Stage A COMP-009).
 */
export interface ComposeService {
  name: string;
  image: string | null;
  /** `profiles:` set — the service does not start with the default stack (Stage A COMP-026). */
  optional: boolean;
  volumes: string[];
  /** The service's `command:` override, flattened to one line (Stage A COMP-015). */
  command: string | null;
}

export function composeServices(tree: FileTree): { file: string; services: ComposeService[] } | null {
  const candidates = Object.keys(tree).filter((p) => COMPOSE_FILE_REGEX.test(p) && isProductionComposeFile(p));
  if (candidates.length === 0) return null;
  const path = candidates.find((p) => !p.includes('/')) ?? candidates[0]!;
  const content = tree[path] ?? '';
  const oneShot = new Set<string>();
  for (const match of content.matchAll(/^\s+([a-zA-Z0-9_-]+):\s*\r?\n\s+condition:\s*service_completed_successfully/gm)) {
    if (match[1]) oneShot.add(match[1]);
  }
  const services: ComposeService[] = [];
  let inServices = false;
  let current: ComposeService | null = null;
  let inVolumes = false;
  let inCommand = false;
  // The file's own indentation: a service header sits one level under
  // `services:`, its keys one level deeper (two or four spaces alike).
  let serviceIndent = -1;
  for (const raw of content.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!inServices) {
      if (/^services:\s*$/.test(line)) inServices = true;
      continue;
    }
    if (/^\s*(?:#|$)/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    // Back to a top-level section ends the services block.
    if (indent === 0) {
      inServices = false;
      current = null;
      continue;
    }
    if (serviceIndent === -1) serviceIndent = indent;
    const serviceHeader = indent === serviceIndent ? /^\s*([a-zA-Z0-9_.-]+):\s*$/.exec(line) : null;
    if (serviceHeader) {
      current = { name: serviceHeader[1]!, image: null, optional: false, volumes: [], command: null };
      inVolumes = false;
      inCommand = false;
      if (!oneShot.has(current.name)) services.push(current);
      continue;
    }
    if (!current) continue;
    const keyLine = /^\s*([a-zA-Z_]+):\s*(.*)$/.exec(line);
    const isServiceKey = keyLine !== null && indent > serviceIndent && !line.trimStart().startsWith('-');
    if (isServiceKey) {
      inVolumes = false;
      inCommand = false;
    }
    if (isServiceKey && keyLine[1] === 'image') current.image = /^["']?([^\s"']+)/.exec(keyLine[2] ?? '')?.[1] ?? null;
    if (isServiceKey && keyLine[1] === 'profiles') current.optional = true;
    // COMP-010: `deploy.replicas: 0` declares an OPTIONAL service (a worker
    // kept for reference but never scaled by the default stack).
    if (isServiceKey && keyLine[1] === 'replicas' && (keyLine[2] ?? '').trim() === '0') {
      current.optional = true;
    }
    if (isServiceKey && keyLine[1] === 'volumes' && (keyLine[2] ?? '') === '') inVolumes = true;
    if (isServiceKey && keyLine[1] === 'command') {
      const value = (keyLine[2] ?? '').trim();
      if (value === '') inCommand = true;
      else current.command = value.replace(/^\[|\]$/g, '').replace(/["',]/g, ' ').replace(/\s+/g, ' ').trim();
    }
    const listItem = /^\s*-\s*["']?([^"']*?)["']?\s*$/.exec(line);
    if (inVolumes && listItem?.[1]) current.volumes.push(listItem[1]);
    if (inCommand && listItem?.[1] !== undefined) current.command = `${current.command ?? ''} ${listItem[1]}`.trim();
  }
  return { file: path, services };
}

/**
 * Container images a Compose service runs that are infrastructure or a
 * sidecar next to the app — a database, cache, broker, search engine, mail
 * sandbox, reverse proxy, headless browser — never the application itself
 * (Stage A COMP-026).
 */
export const INFRA_COMPOSE_IMAGE_REGEX =
  /postgres|postgis|pgvector|pgadmin|adminer|mysql|mariadb|mssql|sqlserver|sql-edge|oracle|cockroach|mongo|redis|valkey|keydb|elasticsearch|opensearch|rabbitmq|kafka|zookeeper|nats|minio|seaweedfs|garage|memcached|localstack|azurite|mailhog|mailpit|maildev|mailcatcher|smtp|postfix|clickhouse|dynamodb|meilisearch|typesense|qdrant|weaviate|milvus|chroma|nginx|caddy|traefik|haproxy|httpd|keycloak|gotenberg|tika|browserless|chrome|chromium|playwright|searxng|rustfs|ollama|vllm|prometheus|grafana|loki|jaeger|tempo|otel|temporalio|getsentry\/spotlight|pictrs|spicedb|authzed|cubejs|hashicorp\/vault/i;

/** Compose services that run the application itself: not infrastructure, not profile-gated. */
export function composeApplicationServices(tree: FileTree): { file: string; services: ComposeService[] } | null {
  const compose = composeServices(tree);
  if (!compose) return null;
  return {
    file: compose.file,
    services: compose.services.filter((s) => !s.optional && (!s.image || !INFRA_COMPOSE_IMAGE_REGEX.test(s.image))),
  };
}

/** Dependency-bearing manifests for the non-Node languages §11.5 reads. */
const PY_DEPENDENCY_FILES = /(?:^|\/)(?:requirements[^/]*\.txt|Pipfile|pyproject\.toml|setup\.py|environment\.ya?ml)$/;
const RB_DEPENDENCY_FILES = /(?:^|\/)Gemfile(?:\.lock)?$/;
const GO_DEPENDENCY_FILES = /(?:^|\/)go\.mod$/;
// PHP, JVM, .NET, Rust and Elixir manifests (Stage A COMP-029).
const OTHER_DEPENDENCY_FILES =
  /(?:^|\/)(?:composer\.json|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|libs\.versions\.toml|[\w.-]+\.csproj|Directory\.Packages\.props|Cargo\.toml|mix\.exs)$/;

/** Source-code extensions the §11.5 language detectors scan. */
const PY_SOURCE = /\.py$/;
const RB_SOURCE = /\.rb$/;
const GO_SOURCE = /\.go$/;
const JS_SOURCE = /\.(ts|js|mjs|cjs|jsx|tsx)$/;

/** Every file that can declare a dependency, for language-breadth scans. */
function isDependencyManifest(path: string): boolean {
  return (
    PY_DEPENDENCY_FILES.test(path) ||
    RB_DEPENDENCY_FILES.test(path) ||
    GO_DEPENDENCY_FILES.test(path) ||
    OTHER_DEPENDENCY_FILES.test(path) ||
    /(?:^|\/)package\.json$/.test(path)
  );
}

/** Escape a dependency token so it can match as an identifier-ish literal. */
function tokenPattern(token: string): string {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `(?<![A-Za-z0-9_@/.-])${escaped}(?![A-Za-z0-9_])`;
}

/**
 * Files where a dependency token appears in a DEPENDENCY position: a declared
 * dependency in a package manifest, a `require('x')`/`import x from 'x'`
 * specifier, or a Python `import x` statement. Prose (READMEs, comments that
 * merely mention a product name) never counts — an undeclared mention is not
 * a dependency the app runs on.
 */
export function findDependencyEvidence(tree: FileTree, token: string): string[] {
  const evidence: string[] = [];
  for (const [path, content] of Object.entries(tree)) {
    if (!content) continue;
    if (/(?:^|\/)package\.json$/.test(path)) {
      // package.json content is free-form (name, description, scripts) — only
      // an EXACT declared dependency counts, never a prose mention.
      if (collectDependencyNames({ [path]: content }).includes(token)) {
        evidence.push(path);
      }
      continue;
    }
    if (isDependencyManifest(path) && new RegExp(tokenPattern(token)).test(content)) {
      evidence.push(path);
      continue;
    }
    if (PY_SOURCE.test(path) && new RegExp(`import\\s+${tokenPattern(token)}`).test(content)) {
      evidence.push(path);
      continue;
    }
    if (
      JS_SOURCE.test(path) &&
      new RegExp(`(?:require\\s*\\(|from\\s+)[\\s'"]*${tokenPattern(token)}`).test(content)
    ) {
      evidence.push(path);
      continue;
    }
  }
  return evidence;
}

// ── Detectors ───────────────────────────────────────────────────────────────

// 1. Dockerfile
// ---------------------------------------------------------------------------

// Matches a Dockerfile in ANY directory, with or without a suffix, in either
// naming order: `Dockerfile`, `dockerfile`, `docker/Dockerfile`,
// `apps/web/Dockerfile.prod`, `.docker/Dockerfile-build`,
// `docker/ce-production.Dockerfile`. A repository that keeps its Dockerfile
// out of the root is the common case, not the exception. A `.dockerignore`,
// a template (`Dockerfile.j2`) or source code named after the format
// (`dockerfile.js`) is not one (Stage A COMP-027).
const DOCKERFILE_REGEX = /(?:^|\/)(?:dockerfile(?:[.-][\w.-]+)?|[\w.-]+\.dockerfile)$/i;
const NOT_A_DOCKERFILE_REGEX = /\.(?:dockerignore|j2|jinja2?|tpl|tmpl|template|md|txt|[cm]?[jt]sx?|ex|py|rb|go|json|ya?ml|lock)$/i;

function isDockerfilePath(path: string): boolean {
  return DOCKERFILE_REGEX.test(path) && !NOT_A_DOCKERFILE_REGEX.test(path);
}

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
// A Dockerfile that builds a dev container, a test image, an example, an OS
// package (Debian/RPM), an operator, a tool image, a sidecar image named
// after the infrastructure it runs (`twenty-postgres-spilo/`, `chrome/`),
// or a hardware/base-image variant (`Dockerfile.fips.*`, `Dockerfile.gpu`)
// is never the image Deployz should build — it ranks below every other
// candidate regardless of depth (Stage A COMP-007, COMP-027).
const DEV_DOCKERFILE_REGEX =
  /(?:^|\/)(?:\.devcontainer|\.cursor|\.github|\.vscode|\.idea|\.gitpod|dev|development|[\w-]*tests?|e2e|ci|cypress|examples?|samples?|debian|rpm|operator|hack|tools?|scaletest|dogfood|docs?|benchmarks?|playwright)(?:\/|$)|(?:^|\/)[\w.-]*(?:postgres|spilo|redis|nginx|caddy|proxy|chrome|chromium|keycloak|elasticsearch|meilisearch|mysql|mariadb|minio|gotenberg)[\w.-]*\/|(?:^|\/)[\w-]*(?:gitpod|dev|test|ci|preview|staging)[\w-]*\.dockerfile$|(?:^|\/)dockerfile(?:[.-]\w+)*[.-](?:dev|development|test|e2e|ci|compose|fips|coverage|integration|tilt|gitpod|alpine|debian|ubuntu|cpu|gpu|cuda|rocm|arm|arm64|ppc64le|rock|rock_base|deb|rpm)(?:[.-]\w+)*$/i;

function compareDockerfileCandidates(a: string, b: string): number {
  const aDev = DEV_DOCKERFILE_REGEX.test(a);
  const bDev = DEV_DOCKERFILE_REGEX.test(b);
  if (aDev !== bDev) return aDev ? 1 : -1;

  const depthDiff = a.split('/').length - b.split('/').length;
  if (depthDiff !== 0) return depthDiff;

  const aExact = EXACT_DOCKERFILE_NAME_REGEX.test(a);
  const bExact = EXACT_DOCKERFILE_NAME_REGEX.test(b);
  if (aExact !== bExact) return aExact ? -1 : 1;

  // Fewer name segments first: `Dockerfile.server` over `Dockerfile.server.gpu`.
  const segmentDiff = (a.split('/').pop() ?? '').split('.').length - (b.split('/').pop() ?? '').split('.').length;
  if (segmentDiff !== 0) return segmentDiff;

  return a.localeCompare(b);
}

/**
 * Detect a Dockerfile (case-insensitive: `Dockerfile`, `dockerfile`, `Dockerfile.prod`, etc.).
 */
export function detectDockerfile(tree: FileTree): DetectorFinding {
  const match = Object.keys(tree).filter(isDockerfilePath);
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
  return Object.keys(tree).filter(isDockerfilePath).sort(compareDockerfileCandidates);
}

/** The Dockerfile Deployz would build — the top-ranked candidate — with its content. */
function selectedDockerfile(tree: FileTree): { path: string; content: string } | null {
  const path = listDockerfileCandidates(tree)[0];
  if (path === undefined) return null;
  return { path, content: tree[path] ?? '' };
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
        source: 'package-manifest',
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
// The container's own documentation of its port (Stage A COMP-001): an
// explicit `ENV PORT=3000`, an `EXPOSE 3000` / `EXPOSE ${PORT:-3333}`
// instruction, or a Compose port mapping whose CONTAINER side is the port.
const DOCKERFILE_ENV_PORT_REGEX = /^\s*ENV\s+PORT[=\s]+["']?(\d{2,5})\b/m;
const DOCKERFILE_EXPOSE_REGEX = /^\s*EXPOSE\s+([^\n#]+)/gm;
const COMPOSE_PORT_MAPPING_REGEX = /^\s*-\s*["']?(?:[\d.]+:)?\d{2,5}:(\d{2,5})(?:\/tcp)?["']?\s*$/m;
// Ports an image exposes for something other than its HTTP listener — SSH,
// mail, DNS, a bundled database — never the port Deployz routes to when the
// image exposes another one (Stage A COMP-028).
const NON_HTTP_PORTS = new Set(['22', '25', '53', '465', '587', '3306', '5432', '6379', '27017']);

/**
 * The HTTP port the selected Dockerfile exposes: the first `EXPOSE` value
 * that is a literal, a `${PORT:-n}` default, or a variable the same
 * Dockerfile sets with `ENV`/`ARG` (`EXPOSE ${APP_PORT}` after
 * `ENV APP_PORT=9000`), skipping non-HTTP ports (Stage A COMP-028).
 */
function exposedPort(dockerfile: string): string | null {
  const values: string[] = [];
  for (const match of dockerfile.matchAll(DOCKERFILE_EXPOSE_REGEX)) {
    for (const token of (match[1] ?? '').trim().split(/\s+/)) {
      const literal = /^(\d{2,5})(?:\/tcp)?$/.exec(token);
      const withDefault = /^\$\{(\w+):-(\d{2,5})\}(?:\/tcp)?$/.exec(token);
      const variable = /^\$\{?(\w+)\}?(?:\/tcp)?$/.exec(token);
      if (literal?.[1]) values.push(literal[1]);
      else if (withDefault?.[2]) values.push(withDefault[2]);
      else if (variable?.[1]) {
        const assignment = new RegExp(`^\\s*(?:ENV|ARG)\\s+${variable[1]}[=\\s]+["']?(\\d{2,5})\\b`, 'm').exec(dockerfile);
        if (assignment?.[1]) values.push(assignment[1]);
      }
    }
  }
  return values.find((value) => !NON_HTTP_PORTS.has(value)) ?? values[0] ?? null;
}

/**
 * The candidate port + its provenance. Explicit sources always outrank the
 * framework default, which is stored separately (low confidence, prefill only).
 */
interface PortCandidate {
  value: string;
  source: 'dockerfile-expose' | 'compose' | 'env' | 'runtime-literal' | 'framework-default';
  confidence: 'high' | 'medium' | 'low';
  details: string;
}

/** A literal numeric port (2-5 digits). */
const LITERAL_PORT = /^(\d{2,5})$/;

/**
 * Runtime literals that name the port the app listens on — static, easy
 * patterns only. Placeholder/env-dependent values are never a candidate.
 */
function runtimeLiteralPort(tree: FileTree): { value: string; details: string } | null {
  for (const [path, content] of Object.entries(tree)) {
    if (!content || !isRuntimeSourcePath(path)) continue;
    // Go: http.ListenAndServe(":8080", nil) / Addr: ":8080"
    if (/\.go$/.test(path)) {
      const go = /(?:http\.ListenAndServe\(\s*"|Addr\s*:\s*"):(\d{2,5})"/.exec(content);
      if (go?.[1]) return { value: go[1], details: `Go ListenAndServe port ${go[1]} (${path})` };
    }
    // Python: app.run(port=8000) / uvicorn.run(app, port=8000) / --port 8000
    if (/\.py$/.test(path)) {
      const py = /\b(?:app\.run|uvicorn\.run)\([^)]*port\s*=\s*(\d{2,5})/.exec(content);
      if (py?.[1]) return { value: py[1], details: `Python run(port=...) ${py[1]} (${path})` };
    }
    // Java: server.port=8080 / server: { port: 8080 } (non-placeholder)
    if (/\.(?:properties|ya?ml)$/.test(path) && /(?:^|\/)application\./.test(path)) {
      const java = /^\s*server\s*[:.]\s*port\s*[:=]\s*(\d{2,5})\s*$/m.exec(content);
      if (java?.[1]) return { value: java[1], details: `server.port ${java[1]} (${path})` };
    }
  }
  // uvicorn --port in a start command / rails server -p / artisan serve --port.
  for (const [, command] of collectScripts(tree)) {
    const uv = /uvicorn[^\n]*--port\s+(\d{2,5})/.exec(command);
    if (uv?.[1]) return { value: uv[1], details: `uvicorn --port ${uv[1]} (start script)` };
    const rails = /rails\s+server\s+-p\s+(\d{2,5})/.exec(command);
    if (rails?.[1]) return { value: rails[1], details: `rails server -p ${rails[1]} (start script)` };
    const artisan = /artisan\s+serve[^\n]*--port\s*=?\s*(\d{2,5})/.exec(command);
    if (artisan?.[1]) return { value: artisan[1], details: `artisan serve --port ${artisan[1]} (start script)` };
  }
  return null;
}

/** True when the runtime is detected with existing high-confidence evidence. */
function hasFrameworkMarker(tree: FileTree): boolean {
  const names = collectDependencyNames(tree);
  const raw = [...Object.values(tree)].join('\n');
  if (names.includes('next')) return true;
  if (names.includes('@nestjs/core') || names.includes('express') || names.includes('fastify')) return true;
  if (/django|manage\.py|flask|uvicorn|fastapi|requirements\.txt/.test(raw)) return true;
  if (names.includes('rails') || /Gemfile/.test(raw)) return true;
  if (/spring-boot|spring\.framework/.test(raw)) return true;
  if (/phoenix|mix\.exs/.test(raw)) return true;
  if (/laravel|artisan/.test(raw)) return true;
  return false;
}

/** The framework's conventional default port, when the runtime is present. */
function frameworkDefaultPort(tree: FileTree): string | null {
  if (!hasFrameworkMarker(tree)) return null;
  const names = collectDependencyNames(tree);
  if (names.includes('next') || names.includes('express') || names.includes('fastify') || names.includes('@nestjs/core')) {
    return '3000';
  }
  const raw = [...Object.values(tree)].join('\n');
  if (/manage\.py/.test(raw) || /uvicorn|fastapi/.test(raw)) return '8000';
  if (/flask/.test(raw)) return '5000';
  if (/Gemfile/.test(raw)) return '3000';
  if (/spring-boot|spring\.framework/.test(raw)) return '8080';
  if (/phoenix|mix\.exs/.test(raw)) return '4000';
  if (/laravel|artisan/.test(raw)) return '8000';
  return null;
}

/**
 * Detect the application port from env files, docker-compose, the selected
 * Dockerfile, runtime literals, or — as a LAST-RESORT prefill — the detected
 * framework's conventional default. Explicit evidence always outranks the
 * default; the default is returned as `framework-default` / low confidence so
 * the deployment gate can keep refusing to auto-deploy on a guessed port.
 */
export function detectPort(tree: FileTree): DetectorFinding {
  const result = (candidate: PortCandidate, source: DetectorSource): DetectorFinding => ({
    detector: 'port',
    detected: true,
    value: candidate.value,
    details: candidate.details,
    source,
    portSource: candidate.source,
    portConfidence: candidate.confidence,
  });

  // 1. Env files (.env, .env.example) — explicit env config.
  for (const path of Object.keys(tree)) {
    if (/^\.env(\.\w+)?$/i.test(path)) {
      const match = PORT_ENV_REGEX.exec(tree[path] ?? '');
      if (match?.[1]) {
        return result(
          { value: match[1], source: 'env', confidence: 'high', details: `Port ${match[1]} detected in ${path}` },
          'env-file',
        );
      }
    }
  }

  // 2. docker-compose ${PORT:-NNNN} default.
  const dcContent = findFileContent(tree, /^docker-compose\.ya?ml$/i);
  if (dcContent) {
    const match = PORT_DOCKER_COMPOSE_REGEX.exec(dcContent);
    if (match?.[1]) {
      return result(
        { value: match[1], source: 'compose', confidence: 'high', details: `Port ${match[1]} detected in docker-compose` },
        'compose',
      );
    }
  }

  // 3. The selected Dockerfile's explicit ENV PORT.
  const dockerfile = selectedDockerfile(tree);
  const envPort = dockerfile ? DOCKERFILE_ENV_PORT_REGEX.exec(dockerfile.content) : null;
  if (dockerfile && envPort?.[1]) {
    return result(
      { value: envPort[1], source: 'env', confidence: 'high', details: `Port ${envPort[1]} detected in ${dockerfile.path} (ENV PORT)` },
      'dockerfile',
    );
  }

  // 4. The selected Dockerfile's EXPOSE instruction.
  const exposed = dockerfile ? exposedPort(dockerfile.content) : null;
  if (dockerfile && exposed) {
    return result(
      { value: exposed, source: 'dockerfile-expose', confidence: 'high', details: `Port ${exposed} detected in ${dockerfile.path} (EXPOSE)` },
      'dockerfile',
    );
  }

  // 5. Source code: process.env.PORT || fallback.
  for (const [path, content] of Object.entries(tree)) {
    if (/\.(ts|js|mjs|cjs|jsx|tsx)$/.test(path)) {
      const match = PORT_PROCESS_REGEX.exec(content);
      if (match?.[1]) {
        return result(
          { value: match[1], source: 'runtime-literal', confidence: 'high', details: `Default port ${match[1]} detected in ${path}` },
          'source',
        );
      }
    }
  }

  // 6. A production Compose port mapping (host:container — the container side).
  for (const path of listProductionComposeFiles(tree)) {
    const match = COMPOSE_PORT_MAPPING_REGEX.exec(tree[path] ?? '');
    if (match?.[1]) {
      return result(
        { value: match[1], source: 'compose', confidence: 'high', details: `Port ${match[1]} detected in ${path} (ports mapping)` },
        'compose',
      );
    }
  }

  // 7. Runtime literals (Go/Python/Java/Ruby/PHP start commands).
  const literal = runtimeLiteralPort(tree);
  if (literal) {
    return result(
      { value: literal.value, source: 'runtime-literal', confidence: 'high', details: literal.details },
      'source',
    );
  }

  // 8. Framework default — prefill only, never silently deployable.
  const frameworkDefault = frameworkDefaultPort(tree);
  if (frameworkDefault && LITERAL_PORT.test(frameworkDefault)) {
    return result(
      {
        value: frameworkDefault,
        source: 'framework-default',
        confidence: 'low',
        details: `Framework default port ${frameworkDefault}`,
      },
      'source',
    );
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
  /([A-Za-z_$][\w$]*)?\s*\.?\s*(?:get|post|put|all|route)\s*\(.*['"`]([\w/-]*\/(?:health|healthz|healthcheck|heartbeat|readyz|livez|up|status|ping|alive|_health))\b/i;
const HEALTH_HTTP_ADAPTER_REGEX =
  /\.getHttpAdapter\(\)\..*?['"`]([\w/-]*\/(?:health|healthz|healthcheck|heartbeat|readyz|livez|up|status|ping|alive|_health))\b/;
const HEALTH_SCRIPT_REGEX = /^healthcheck$/i;
// File-based routing (Next.js, Remix, Nuxt, SvelteKit) declares the path in
// the FILE NAME, so there is no route string to match: `api/health.ts`,
// `app/api/health/route.ts`, `pages/api/healthz.js`, Remix v2 dot routes
// (`api.health.ts`), where `.` rather than `/` separates segments.
const HEALTH_ROUTE_FILE_REGEX =
  /(?:^|[/.])(?:health|healthz|healthcheck|heartbeat)(?:\.[jt]sx?|\/(?:route|index|\+server)\.[jt]sx?)$/i;
// Router-root directories: the file-based routers above never let these
// appear in the served URL. Keeping only the segments after the LAST one
// drops monorepo prefixes (`apps/remix/app/routes/...` -> `...`).
const ROUTER_ROOT_DIRS = new Set(['routes', 'pages', 'app']);
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
  // A URL inside a Dockerfile HEALTHCHECK / Compose healthcheck names the
  // path the image's own check probes — real evidence, but it can lag a
  // moved route, so it ranks below anything found in code (Stage A COMP-005).
  HEALTHCHECK_URL: 2,
} as const;
const HEALTH_PATH_SEGMENT_REGEX = /(?:^|\/)(?:health|healthz|healthcheck|heartbeat|readyz|livez|up|status|ping|alive|_health)$/i;
// A health URL in a container/compose health check: `curl -f http://localhost:3000/api/heartbeat`.
// The host is the container itself (localhost, a loopback/any address, or a
// `$VAR`), never a documentation link that happens to sit on the same line.
const HEALTHCHECK_URL_REGEX =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\$\{?[\w:-]+\}?)(?::\$?\{?[\w:-]+\}?)?(\/[\w./-]*)?(?=["'\s]|$)/;
// A HEALTHCHECK that runs a script shipped in the image (`CMD node
// healthcheck.js`) names its URL inside that script (Stage A COMP-034).
const HEALTHCHECK_SCRIPT_REGEX = /[\w./-]+\.(?:[cm]?js|sh|py|rb)\b/g;
// Route registrations in Go, Python, Ruby, PHP, .NET, Elixir, Rails and JVM
// name their path as a plain string literal on the registering call:
// `HandleFunc("GET /healthcheck", …)`, `app.Get("/health", …)`,
// `@app.route('/health')`, `path('health/', …)`, `get '/up'`,
// `Route::get('/up')`, `MapGet("/health", …)`, `@GetMapping("/x")`.
// Only literals whose LAST segment is a well-known health name count.
const HEALTH_ROUTE_LITERAL_REGEX =
  /(?:HandleFunc|Handle|GET|Get|get|Post|post|Put|put|Route|Map|path|add_url_rule|url|GetMapping|RequestMapping|value)\s*(?:\(|::)?\s*["'](?:(?:GET|HEAD|POST)\s+)?(\/?(?:[\w.-]+\/)*(?:health|healthz|healthcheck|heartbeat|readyz|livez|up|status|ping|alive|_health))\/?["']/gi;
const LANGUAGE_SOURCE_REGEX = /\.(?:go|py|rb|php|cs|java|kt|kts|scala|ex|exs)$/i;

/** Ensure a captured/derived health path starts with a leading slash. */
function normalizeHealthPath(raw: string): string {
  return raw.startsWith('/') ? raw : `/${raw}`;
}

/**
 * Derive the URL path a file-based health-check ROUTE FILE implies, mirroring
 * how a file location maps to a URL for Next.js (app-router
 * `app/api/health/route.ts`, pages-router `pages/api/health.ts`), Remix flat
 * routes (`api+/health.ts`, dot routes `api.health.ts`), and SvelteKit
 * (`routes/api/health/+server.ts`). `routes`, `pages`, and `app` are
 * router-root directories: only the segments AFTER the LAST one survive, so a
 * monorepo prefix like `apps/remix/app/` never leaks into the path. Once an
 * `api` segment is seen, everything from there on is literal.
 */
function deriveHealthPathFromFile(filePath: string): string {
  const trimmed = filePath.replace(/\.[jt]sx?$/, '').replace(/\/(?:route|index|\+server)$/, '');
  let segments = trimmed.split('/').filter(Boolean);

  let rootIndex = -1;
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (segment !== undefined && ROUTER_ROOT_DIRS.has(segment)) {
      rootIndex = i;
      break;
    }
  }
  segments =
    rootIndex === -1 ? segments.filter((s) => !ROUTER_ROOT_DIRS.has(s) && s !== 'src') : segments.slice(rootIndex + 1);

  // Normalise framework segment conventions: drop the remix-flat-routes `+`
  // folder marker, split dot-delimited segments (Remix v2 flat files), and
  // drop pathless layout/group segments.
  segments = segments
    .flatMap((s) => s.replace(/\+$/, '').split('.'))
    .filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith('_'));

  const apiIndex = segments.indexOf('api');
  const relevant = apiIndex === -1 ? segments : segments.slice(apiIndex);
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
    // `app.use('/', router)` is a root mount — joining must not double the slash.
    path = `${mount.prefix.replace(/\/+$/, '')}${path}`;
    composed = true;
    current = mount.mounter;
  }
  return composed ? path : undefined;
}

// ── Stage B phase 5 (COMP-005): Spring Boot helpers ─────────────────────────

/** `server.servlet.context-path` from application.properties/yml, when literal. */
function findSpringContextPath(tree: FileTree): string {
  for (const [path, content] of Object.entries(tree)) {
    if (!content || !/(?:^|\/)application\.(?:properties|ya?ml)$/i.test(path)) continue;
    const flat = /server\.servlet\.context-path\s*[:=]\s*"?(\/[^\s"#]*)["]?/.exec(content);
    if (flat?.[1]) return flat[1];
    // application.yml nests the key: `context-path: /svc` under `servlet:`.
    const nested = /^\s*context-path\s*:\s*"?(\/[^\s"#]*)["]?/m.exec(content);
    if (nested?.[1]) return nested[1];
  }
  return '';
}

/**
 * Whether Spring Actuator's web exposure still serves health. Only an
 * EXPLICIT configuration that excludes health disables it — the default
 * (health exposed) stays enabled.
 */
function findActuatorExposure(tree: FileTree): 'enabled' | 'excluded' {
  for (const [path, content] of Object.entries(tree)) {
    if (!content || !/(?:^|\/)application\.(?:properties|ya?ml)$/i.test(path)) continue;
    const includeMatch = /management\.endpoints\.web\.exposure\.include\s*[:=]\s*"?([^"\s#]*)["]?/.exec(content);
    const excludeMatch = /management\.endpoints\.web\.exposure\.exclude\s*[:=]\s*"?([^"\s#]*)["]?/.exec(content);
    const included = includeMatch?.[1] ?? '';
    const excluded = excludeMatch?.[1] ?? '';
    if (excluded.includes('health')) return 'excluded';
    if (included.length > 0 && !included.includes('health') && !included.includes('*')) return 'excluded';
  }
  return 'enabled';
}

/**
 * Detect a health check endpoint from Dockerfile HEALTHCHECK, package.json scripts,
 * route patterns in source code, or a file-based route path.
 */
export function detectHealthEndpoint(tree: FileTree): DetectorFinding {
  const sources: string[] = [];
  const pathCandidates: { path: string; priority: number; source: DetectorSource }[] = [];

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

  // 0b. A router mounted at a health prefix (`apiRouter.use('/health', router)`)
  //     registers that path whatever the inner routes are called.
  for (const mount of mounts) {
    if (HEALTH_PATH_SEGMENT_REGEX.test(mount.prefix)) {
      sources.push(`health router mount (${mount.prefix})`);
      pathCandidates.push({
        path: composeMountedPath(mount.mounter, mount.prefix, mounts) ?? mount.prefix,
        priority: HEALTH_PATH_PRIORITY.ROUTE_REGISTRATION,
        source: 'source',
      });
    }
  }

  // 1. The selected Dockerfile's HEALTHCHECK instruction — the image Deployz
  //    builds, not a sibling dev/packaging image.
  const dockerfile = selectedDockerfile(tree);
  if (dockerfile && HEALTHCHECK_REGEX.test(dockerfile.content)) {
    sources.push('HEALTHCHECK (Dockerfile)');
    const healthcheckLine = /HEALTHCHECK\b[^\n]*/i.exec(dockerfile.content)?.[0] ?? '';
    let url = HEALTHCHECK_URL_REGEX.exec(healthcheckLine);
    for (const script of healthcheckLine.match(HEALTHCHECK_SCRIPT_REGEX) ?? []) {
      if (url) break;
      const basename = script.split('/').pop() ?? script;
      const file = Object.keys(tree).find((path) => path === script || path.endsWith(`/${basename}`) || path === basename);
      if (file) url = HEALTHCHECK_URL_REGEX.exec(tree[file] ?? '');
    }
    if (url) {
      pathCandidates.push({ path: url[1] ?? '/', priority: HEALTH_PATH_PRIORITY.HEALTHCHECK_URL, source: 'dockerfile' });
    }
  }

  // 1b. A production Compose healthcheck that probes a URL.
  for (const path of listProductionComposeFiles(tree)) {
    const healthcheck = /healthcheck:[\s\S]*?test:[^\n]*/.exec(tree[path] ?? '')?.[0] ?? '';
    const url = HEALTHCHECK_URL_REGEX.exec(healthcheck);
    if (url) {
      sources.push(`healthcheck (${path})`);
      pathCandidates.push({ path: url[1] ?? '/', priority: HEALTH_PATH_PRIORITY.HEALTHCHECK_URL, source: 'compose' });
      break;
    }
  }

  // 1c. Route registrations across frameworks (Go/Python/Ruby/PHP/.NET/JVM/
  //     Elixir/Rails) name their health route as a plain string literal.
  //     Stage B phase 5 (COMP-005): health-ish names now include the common
  //     non-standard routes (/up, /status, /ping, /alive, /_health, …) — a
  //     declaration must exist; a name is never assumed on its own.
  const actuatorDependency = Object.entries(tree).some(
    ([path, content]) =>
      content &&
      /(?:^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?)$/.test(path) &&
      /spring-boot(?:-starter)?-actuator/.test(content),
  );
  for (const [path, content] of Object.entries(tree)) {
    if (!LANGUAGE_SOURCE_REGEX.test(path) || !content || !isRuntimeSourcePath(path)) continue;

    // ── Spring Boot Actuator: /actuator/health when the dependency exists and
    //    the exposure config does not exclude health. ──
    if (actuatorDependency && /\.(?:java|kt|kts|scala)$/.test(path)) {
      const contextPath = findSpringContextPath(tree);
      const exposure = findActuatorExposure(tree);
      if (exposure !== 'excluded') {
        sources.push(`actuator health (${path})`);
        pathCandidates.push({
          path: `${contextPath}/actuator/health`,
          // The actuator default ranks BELOW an explicit route declaration in
          // code — a controller that maps its own health path wins.
          priority: HEALTH_PATH_PRIORITY.HEALTHCHECK_URL,
          source: 'source',
        });
      }
    }

    // Class-level @RequestMapping("/api/v1") prefixes a controller's methods.
    const javaPrefixes: string[] = [];
    if (/\.(?:java|kt)$/.test(path)) {
      for (const m of content.matchAll(/@RequestMapping\(\s*["'](\/[^"']+)["']/g)) {
        if (m[1] && !HEALTH_PATH_SEGMENT_REGEX.test(m[1])) javaPrefixes.push(m[1]);
      }
    }

    for (const match of content.matchAll(HEALTH_ROUTE_LITERAL_REGEX)) {
      const raw = match[1];
      if (!raw) continue;
      let routePath = raw.startsWith('/') ? raw : `/${raw}`;
      // Laravel API routes are served under /api; the file says so.
      if (/(?:^|\/)routes\/api\.php$/i.test(path) && !routePath.startsWith('/api')) {
        routePath = `/api${routePath}`;
      }
      if (javaPrefixes.length > 0 && !routePath.startsWith(javaPrefixes[0]!)) {
        routePath = `${javaPrefixes[0]!.replace(/\/+$/, '')}${routePath}`;
      }
      sources.push(`health route (${path})`);
      pathCandidates.push({
        path: routePath,
        priority: HEALTH_PATH_PRIORITY.ROUTE_REGISTRATION,
        source: 'source',
      });
    }
  }

  // ── Phoenix (Elixir): routes are declared inside `scope "/api/v1" do` ────
  for (const [path, content] of Object.entries(tree)) {
    if (!/\.(?:ex|exs)$/.test(path) || !content || !isRuntimeSourcePath(path)) continue;
    const scopes = [...content.matchAll(/scope\s+["'](\/[^"']*)["']/g)].map((m) => m[1] ?? '');
    for (const match of content.matchAll(/\b(?:get|post)\s+["'](\/[^"']*)["']/g)) {
      const raw = match[1]!;
      if (!HEALTH_PATH_SEGMENT_REGEX.test(raw)) continue;
      const routePath = scopes.length > 0 ? `${scopes[0]!.replace(/\/+$/, '')}${raw}` : raw;
      sources.push(`health route (${path})`);
      pathCandidates.push({
        path: routePath,
        priority: HEALTH_PATH_PRIORITY.ROUTE_REGISTRATION,
        source: 'source',
      });
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
      // Only a file inside a file-based router (`routes`, `pages`, `app`, or
      // an `api` segment) declares a URL by its name; a model or controller
      // called `heartbeat.js` does not (Stage A COMP-004).
      if (
        HEALTH_ROUTE_FILE_REGEX.test(path) &&
        path.split('/').some((segment) => ROUTER_ROOT_DIRS.has(segment) || segment === 'api')
      ) {
        sources.push(`health route file (${path})`);
        pathCandidates.push({ path: deriveHealthPathFromFile(path), priority: HEALTH_PATH_PRIORITY.FILE_ROUTE, source: 'source' });
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
            source: 'source',
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
            source: 'source',
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
  const bestCandidate = pathCandidates.reduce<(typeof pathCandidates)[number] | undefined>(
    (best, candidate) => {
      if (best === undefined || candidate.priority < best.priority) return candidate;
      if (candidate.priority === best.priority && candidate.path.length > best.path.length) return candidate;
      return best;
    },
    undefined,
  );
  const path = bestCandidate?.path ?? '/health';
  // Stage B phase 5: `/` is a ROOT check (the app's own HEALTHCHECK probes the
  // home page) — never treated as an explicit health route.
  const mode = path === '/' ? 'root' : 'explicit';

  return {
    detector: 'health-endpoint',
    detected: true,
    value: sources,
    details: `Health endpoint detected via: ${sources.join('; ')}`,
    path,
    // Without a literal path the evidence is the image's own HEALTHCHECK or
    // a package.json script — never a route Deployz read from source.
    mode,
    source: bestCandidate?.source ?? (dockerfile && HEALTHCHECK_REGEX.test(dockerfile.content) ? 'dockerfile' : 'package-manifest'),
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

/** §11.5 — per-language PostgreSQL driver tokens matched against dependency manifests and imports. */
const LANGUAGE_PG_SIGNALS: { token: string; name: string }[] = [
  { token: 'psycopg2', name: 'psycopg2' },
  { token: 'psycopg', name: 'psycopg' },
  { token: 'asyncpg', name: 'asyncpg' },
  { token: 'pg8000', name: 'pg8000' },
  { token: 'github.com/jackc/pgx', name: 'jackc/pgx' },
  { token: 'github.com/lib/pq', name: 'lib/pq' },
  { token: 'pg', name: 'pg (Ruby)' },
  // PHP, JVM, .NET, Rust and Elixir drivers (Stage A COMP-029).
  { token: 'ext-pdo_pgsql', name: 'pdo_pgsql (PHP)' },
  { token: 'org.postgresql', name: 'org.postgresql (JVM)' },
  { token: 'r2dbc-postgresql', name: 'r2dbc-postgresql (JVM)' },
  { token: 'quarkus-jdbc-postgresql', name: 'quarkus-jdbc-postgresql (JVM)' },
  { token: 'Npgsql', name: 'Npgsql (.NET)' },
  { token: 'tokio-postgres', name: 'tokio-postgres (Rust)' },
  { token: 'postgrex', name: 'postgrex (Elixir)' },
];
// A Rust ORM compiled with its PostgreSQL feature (`diesel = { features =
// ["postgres"] }`, `sqlx … "postgres"`), or a PHP image that installs the
// PostgreSQL PDO extension (`docker-php-ext-install pdo_pgsql`).
const RUST_PG_FEATURE_REGEX = /(?:diesel|sqlx|sea-orm)[^\n]*\bpostgres(?:ql)?\b|features\s*=\s*\[[^\]]*"postgres(?:ql)?"|diesel\/postgres/;
const PHP_PG_EXTENSION_REGEX = /(?:docker-php-ext-install|install-php-extensions)\b[^\n]*\bpdo_pgsql\b/;

/**
 * Language-level PostgreSQL evidence (drivers declared in Python/Ruby/Go
 * manifests, imports, and postgres:// connection URLs in code). Returns the
 * matched signal names — NOT raw file paths, keeping the finding value a
 * plain string list like every other driver entry.
 */
function detectLanguagePostgres(tree: FileTree): string[] {
  const detected: string[] = [];
  for (const { token, name } of LANGUAGE_PG_SIGNALS) {
    // The bare `pg` token is deliberately ambiguous (node pg, ruby pg) — only
    // accept it from a Ruby manifest line (`gem 'pg'`) to avoid false hits on
    // any file containing the word "pg".
    const paths = findDependencyEvidence(tree, token);
    if (paths.length === 0) continue;
    if (token === 'pg') {
      const rubyHit = paths.some((p) => RB_DEPENDENCY_FILES.test(p));
      if (!rubyHit) continue;
    }
    if (!detected.includes(name)) detected.push(name);
  }
  for (const [path, content] of Object.entries(tree)) {
    if (!content) continue;
    if (/(?:^|\/)Cargo\.toml$/.test(path) && RUST_PG_FEATURE_REGEX.test(content) && !detected.includes('postgres feature (Rust)')) {
      detected.push('postgres feature (Rust)');
    }
    // A `RUN … \` continuation is one instruction.
    if (isDockerfilePath(path) && PHP_PG_EXTENSION_REGEX.test(content.replace(/\\\r?\n/g, ' ')) && !detected.includes('pdo_pgsql (PHP)')) {
      detected.push('pdo_pgsql (PHP)');
    }
  }
  // A postgresql:// connection URL in code is driver-independent evidence
  // (Python's sqlalchemy engine URL, Django settings, Go config strings).
  for (const [path, content] of Object.entries(tree)) {
    if (
      content &&
      (PY_SOURCE.test(path) || GO_SOURCE.test(path) || RB_SOURCE.test(path)) &&
      /(?:postgres|postgresql):\/\//.test(content) &&
      !detected.includes('postgres connection URL')
    ) {
      detected.push('postgres connection URL');
    }
  }
  return detected;
}

/**
 * True when a language-level driver signal comes from a manifest the
 * deployed app is built from (not a tool, test or docs manifest) and, for
 * Go, is a direct requirement rather than an `// indirect` one.
 */
function languageDriverDeclaredAtRuntime(tree: FileTree, signal: string): boolean {
  if (signal === 'postgres feature (Rust)' || signal === 'pdo_pgsql (PHP)') return true;
  const token = LANGUAGE_PG_SIGNALS.find((candidate) => candidate.name === signal)?.token;
  if (!token) return false;
  return findDependencyEvidence(tree, token).some((path) => {
    if (!isDependencyManifest(path) || !isRuntimeSourcePath(path)) return false;
    if (!GO_DEPENDENCY_FILES.test(path)) return true;
    const line = new RegExp(`^[^\\n]*${tokenPattern(token)}[^\\n]*$`, 'm').exec(tree[path] ?? '')?.[0] ?? '';
    return !/\/\/\s*indirect/.test(line);
  });
}

/**
 * Detect PostgreSQL usage from package.json dependencies, Python/Ruby/Go
 * driver signals (§11.5), or Prisma schema.
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

  // §11.5 language breadth
  for (const signal of detectLanguagePostgres(tree)) {
    if (!detected.includes(signal)) detected.push(signal);
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
  let hasIndependentEvidence = false;

  for (const driver of PG_DRIVERS) {
    if (deps.includes(driver)) {
      hasDependency = true;
      evidence.push(`${driver} dependency in package.json`);
    }
  }

  // §11.5 language breadth — a Python/Ruby/Go driver is the same "driver
  // present" signal as a Node one; a postgres:// URL in code counts as
  // INDEPENDENT evidence (it proves a connection is actually configured).
  // Outside Node a driver is compiled or installed on purpose — a Go module,
  // a Python package, a gem, a Maven artifact, a Cargo feature is never a
  // transitive extra sitting unused in the manifest — so its declaration in
  // a runtime manifest is evidence of a configured engine in itself; the
  // app names its connection through its own settings (`MEMOS_DSN`, a YAML
  // storage block), not a variable this function knows (Stage A COMP-029).
  const languageSignals = detectLanguagePostgres(tree);
  for (const signal of languageSignals) {
    if (signal === 'postgres connection URL') {
      hasIndependentEvidence = true;
      evidence.push(`${signal} in source`);
    } else {
      hasDependency = true;
      evidence.push(`${signal} driver declared`);
      if (languageDriverDeclaredAtRuntime(tree, signal)) hasIndependentEvidence = true;
    }
  }

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

  // A known connection env var referenced in an env file, docker-compose, or
  // source — a JS `process.env` read, or the name as a string literal in Go,
  // Python or Ruby configuration (Stage A COMP-013).
  for (const name of PG_CONNECTION_ENV_VARS) {
    const envFileRegex = new RegExp(`^${name}\\s*[=:]`, 'm');
    const composeRegex = new RegExp(`\\b${name}\\s*[=:]`);
    const processEnvRegex = new RegExp(`process\\.env\\.${name}\\b`);
    const literalRegex = new RegExp(`["']${name}["']`);

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
      } else if (LANGUAGE_SOURCE_REGEX.test(path) && isRuntimeSourcePath(path) && literalRegex.test(content)) {
        hasIndependentEvidence = true;
        evidence.push(`${name} referenced in ${path}`);
      }
    }
  }

  // A postgres/postgis image in any production Compose file — the root file,
  // a nested `docker/docker-compose.yml`, or a root variant such as
  // `docker-compose.postgres.yml` (an app that ships one supports PostgreSQL).
  for (const path of Object.keys(tree)) {
    if (!/(?:^|\/)(?:docker-)?compose(?:\.[\w.-]+)?\.ya?ml$/i.test(path) || !isProductionComposeFile(path)) continue;
    const dcContent = tree[path];
    if (!dcContent) continue;
    const regex = new RegExp(COMPOSE_IMAGE_REGEX.source, COMPOSE_IMAGE_REGEX.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(dcContent)) !== null) {
      const image = match[1];
      if (image && /postgres|postgis/i.test(image)) {
        hasIndependentEvidence = true;
        evidence.push(`docker-compose service using a PostgreSQL/PostGIS image (${image}) in ${path}`);
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

// DECLARED durable state only. A write call in source (`fs.writeFile`, a
// Python `open(…, "w")`) proves nothing: caches, temp files, generated
// assets and log files are written by almost every real application and
// are lost harmlessly with the container. What breaks in an ephemeral
// container is state the image itself declares it keeps on disk — a
// Dockerfile `VOLUME`, or a volume the production Compose file mounts into
// the application service — with no object-storage alternative the vendor
// can configure instead (Stage A COMP-024).
const DOCKERFILE_VOLUME_REGEX = /^\s*VOLUME\s+(.+)$/gm;
// A volume that backs the default embedded database (`VOLUME /database`,
// `/var/lib/mysql`) is replaced by the PostgreSQL Deployz provisions when
// the app ships a PostgreSQL driver.
const DATABASE_VOLUME_REGEX = /(?:database|\bdb\b|sqlite|postgres|pgdata|mysql|mariadb)/i;
// Read-only mounts, the Docker socket, single-file mounts (a config file)
// and customisation directories the operator fills before start (themes,
// plugins, certificates) carry no state the app writes at runtime.
const NON_STATE_MOUNT_REGEX =
  /:ro$|\.sock(?::|$)|[^/]\.[a-z]{2,5}(?::[a-z]+)?$|\.env(?::[a-z]+)?$|\/(?:custom|config|conf|plugins?|themes?|certs?|ssl|secrets?|extensions?|addons?)\/?(?::[a-z]+)?$/i;
// Container-side paths that hold only transient state — logs, caches, search
// indexes and temp dirs. A volume mounted there is a log/cache volume, not
// durable application data: a cache write, a temp file, a generated asset and
// a log line are all lost harmlessly (the same boundary the write-call rule
// draws above). Named volumes whose container path is `/tmp/…`, `…/logs`,
// `…/cache`, `…/.cache` or a search/index dir are not durable app state.
const EPHEMERAL_CONTAINER_PATH_REGEX =
  /^\/(?:tmp|var\/tmp)\b|\/(?:logs?|log|cache|\.cache|search|indexes?|sessions?|run|var\/run)(?:\/|$)/i;

/**
 * Detect durable local-disk state the image declares (Dockerfile VOLUME, a
 * Compose volume on the application service) with no object-storage
 * alternative — unsupported in Deployz's ephemeral container model.
 */
export function detectLocalFilesystem(tree: FileTree): DetectorFinding {
  const detected: string[] = [];
  const hasPostgresDriver = detectPostgresql(tree).detected;

  const dockerfile = selectedDockerfile(tree);
  for (const match of dockerfile?.content.matchAll(DOCKERFILE_VOLUME_REGEX) ?? []) {
    const raw = match[1]?.trim() ?? '';
    const paths = raw.startsWith('[') ? raw.match(/"([^"]+)"/g)?.map((p) => p.slice(1, -1)) ?? [] : raw.split(/\s+/);
    for (const volume of paths) {
      if (hasPostgresDriver && DATABASE_VOLUME_REGEX.test(volume)) continue;
      // A VOLUME for logs/caches/tmp (`VOLUME /tmp/…`, `VOLUME /…/cache`) is
      // transient state, not durable application data.
      if (EPHEMERAL_CONTAINER_PATH_REGEX.test(volume)) continue;
      detected.push(`VOLUME ${volume} (${dockerfile?.path})`);
    }
  }

  const compose = composeApplicationServices(tree);
  for (const service of compose?.services ?? []) {
    for (const volume of service.volumes) {
      if (NON_STATE_MOUNT_REGEX.test(volume)) continue;
      if (hasPostgresDriver && DATABASE_VOLUME_REGEX.test(volume)) continue;
      // A bind mount of a directory the repository ships (`./custom:/app/custom`)
      // carries project files, not state written at runtime.
      const source = volume.includes(':') ? volume.slice(0, volume.indexOf(':')).replace(/^\.\//, '') : null;
      if (source && !source.startsWith('/') && Object.keys(tree).some((path) => path.startsWith(`${source}/`))) continue;
      // The container-side mount target decides what the volume holds — a
      // named volume at `/tmp/…`, `…/logs`, `…/cache` or `…/.cache` is a
      // log/cache volume (transient), not durable app data.
      const target = volume.includes(':') ? volume.slice(volume.indexOf(':') + 1).replace(/:(?:rw|ro|z|Z)+$/, '') : volume;
      if (EPHEMERAL_CONTAINER_PATH_REGEX.test(target)) continue;
      detected.push(`volume ${volume} (${compose?.file} ${service.name})`);
    }
  }

  if (detected.length === 0 || detectS3(tree).detected) {
    return { detector: 'local-filesystem', detected: false };
  }

  return {
    detector: 'local-filesystem',
    detected: true,
    value: detected,
    details: `Durable local filesystem state declared: ${detected.join(', ')}`,
  };
}

// 8. Worker
// ---------------------------------------------------------------------------

const WORKER_DEPS = ['bull', 'agenda', 'bullmq'] as const;
// Job-queue libraries per language (Stage A COMP-015). In-process cron
// schedulers (node-cron, croner, robfig/cron, gocron, APScheduler) are not
// listed: they run inside the web process by construction and never imply
// a worker.
const WORKER_LANGUAGE_TOKENS: { token: string; name: string }[] = [
  { token: 'pg-boss', name: 'pg-boss' },
  { token: 'graphile-worker', name: 'graphile-worker' },
  { token: 'bree', name: 'bree' },
  { token: '@temporalio/worker', name: '@temporalio/worker' },
  { token: 'sidekiq', name: 'sidekiq' },
  { token: 'good_job', name: 'good_job' },
  { token: 'delayed_job', name: 'delayed_job' },
  { token: 'resque', name: 'resque' },
  { token: 'solid_queue', name: 'solid_queue' },
  { token: 'sneakers', name: 'sneakers' },
  { token: 'celery', name: 'celery' },
  { token: 'rq', name: 'rq' },
  { token: 'django-rq', name: 'django-rq' },
  { token: 'dramatiq', name: 'dramatiq' },
  { token: 'huey', name: 'huey' },
  { token: 'django-q', name: 'django-q' },
  { token: 'arq', name: 'arq' },
  { token: 'procrastinate', name: 'procrastinate' },
  { token: 'github.com/hibiken/asynq', name: 'asynq' },
  { token: 'github.com/RichardKnop/machinery', name: 'machinery' },
  { token: 'github.com/riverqueue/river', name: 'river' },
  { token: 'github.com/gocraft/work', name: 'gocraft/work' },
  { token: 'org.quartz-scheduler', name: 'quartz (JVM)' },
  { token: 'spring-boot-starter-quartz', name: 'quartz (JVM)' },
  { token: 'jobrunr', name: 'jobrunr (JVM)' },
  { token: 'Hangfire', name: 'Hangfire (.NET)' },
  { token: 'oban', name: 'oban (Elixir)' },
  { token: 'laravel/horizon', name: 'laravel/horizon' },
  { token: 'apalis', name: 'apalis (Rust)' },
];
const WORKER_COMMAND_FILE_REGEX = /(?:^|\/)(?:Procfile|[\w.-]*\.sh|supervisord?\.conf|[\w.-]*\.ini)$|(?:^|\/)(?:docker-compose|compose)\.ya?ml$|dockerfile/i;
const WORKER_COMMAND_REGEX =
  /\b(?:bundle exec )?(?:sidekiq|good_job start|rake (?:jobs|resque):work)\b|\bcelery\b[^\n]*\bworker\b|\brq\s+worker\b|\bdramatiq\s+[\w.]+|\bhuey_consumer(?:\.py)?\b|\b(?:arq|procrastinate)\b[^\n]*\bworker\b|artisan\s+(?:queue:work|queue:listen|horizon)\b|\bmanage\.py\s+(?:rqworker|qcluster|procrastinate)\b/;
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

  // Job queues and schedulers outside Node, and a queue-worker command in a
  // Procfile, Dockerfile, Compose file or shell script (Stage A COMP-015).
  for (const { token, name } of WORKER_LANGUAGE_TOKENS) {
    if (findDependencyEvidence(tree, token).length > 0 && !detected.includes(name)) detected.push(name);
  }
  for (const [path, content] of Object.entries(tree)) {
    if (!content || !isRuntimeSourcePath(path) || !WORKER_COMMAND_FILE_REGEX.test(path)) continue;
    if (WORKER_COMMAND_REGEX.test(content) && !detected.includes('queue worker command')) detected.push('queue worker command');
  }
  // A declared worker process is worker code by definition, whatever library runs it.
  const declared = detectDeclaredWorkerCommand(tree);
  if (declared) detected.push(`declared worker process (${declared.source})`);

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

/**
 * A worker process the repository DECLARES outside a root package.json
 * script (which apps/api resolves itself): a Procfile `worker:` line, or a
 * production Compose application service whose `command:` runs a queue
 * worker. The Phase 8 boundary fires on a declared process, so the
 * declaration must be as explicit as the root script it stands in for — a
 * workspace package merely named `worker` is not one (linkwarden runs its
 * `apps/worker` inside the web container) (Stage A COMP-015).
 */
export function detectDeclaredWorkerCommand(tree: FileTree): { command: string; source: string } | null {
  for (const [path, content] of Object.entries(tree)) {
    if (!/(?:^|\/)Procfile$/.test(path) || !content || !isRuntimeSourcePath(path)) continue;
    const line = /^worker:\s*(.+)$/m.exec(content);
    if (line?.[1]) return { command: line[1].trim(), source: path };
  }
  const compose = composeApplicationServices(tree);
  for (const service of compose?.services ?? []) {
    if (service.command && WORKER_COMMAND_REGEX.test(service.command)) {
      return { command: service.command, source: `${compose?.file} ${service.name}` };
    }
  }
  return null;
}

// 9. S3 usage
// ---------------------------------------------------------------------------

// S3-SPECIFIC packages only. The umbrella SDKs (`aws-sdk`, `boto3`,
// `github.com/aws/aws-sdk-go`) also serve SES, SQS and friends, so on their
// own they prove nothing about object storage — they count only through an
// S3 client construction in source (Stage A COMP-012).
const S3_DEPS = ['@aws-sdk/client-s3'] as const;
const S3_ENV_REGEX = /^(?:AWS_)?S3_BUCKET\s*=/m;

/**
 * Detect S3 usage from S3-specific packages (npm, Ruby `aws-sdk-s3`, the Go
 * v2 `service/s3` module, CDK), source-code S3 client usage, or S3-specific
 * env vars.
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

  // §11.5 language breadth: Ruby aws-sdk-s3, Go AWS SDK S3 module.
  const LANGUAGE_S3_TOKENS = [
    { token: 'aws-sdk-s3', name: 'aws-sdk-s3' },
    { token: 'github.com/aws/aws-sdk-go-v2/service/s3', name: 'aws-sdk-go-v2 service/s3' },
    { token: 'aws_cdk.aws_s3', name: 'aws_cdk aws_s3' },
    // JVM, PHP, .NET and Elixir S3-specific artifacts (Stage A COMP-029).
    { token: 'software.amazon.awssdk:s3', name: 'awssdk s3 (JVM)' },
    { token: 'aws-java-sdk-s3', name: 'aws-java-sdk-s3 (JVM)' },
    { token: 'league/flysystem-aws-s3-v3', name: 'flysystem-aws-s3-v3 (PHP)' },
    { token: 'AWSSDK.S3', name: 'AWSSDK.S3 (.NET)' },
    { token: 'ex_aws_s3', name: 'ex_aws_s3 (Elixir)' },
  ] as const;
  for (const { token, name } of LANGUAGE_S3_TOKENS) {
    if (findDependencyEvidence(tree, token).length > 0 && !detected.includes(name)) {
      detected.push(name);
    }
  }

  // Source-code client usage is independent of the manifest (a vendored SDK,
  // or a dependency pinned outside the manifests we read).
  for (const [path, content] of Object.entries(tree)) {
    if (PY_SOURCE.test(path) && /boto3\.(?:client|resource)\s*\(\s*["']s3["']/.test(content)) {
      if (!detected.includes('boto3')) detected.push('boto3');
    }
    if (JS_SOURCE.test(path) && /\bAWS\.S3\s*\(/.test(content) && !detected.includes('aws-sdk')) {
      detected.push('aws-sdk');
    }
    if (
      GO_SOURCE.test(path) &&
      /(?:s3\.NewFromConfig|s3\.New\s*\()/.test(content) &&
      !detected.includes('aws-sdk-go-v2 service/s3')
    ) {
      detected.push('aws-sdk-go-v2 service/s3');
    }
    if (JS_SOURCE.test(path) && /new\s+S3Client\s*\(|S3Client\.from/.test(content)) {
      if (!detected.includes('@aws-sdk/client-s3')) detected.push('@aws-sdk/client-s3');
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

// ── Stage B phase 6 (COMP-014): migrations that run OUTSIDE package.json ───

/** A dev-mode migration command — never deploy/startup evidence. */
const MIGRATION_DEV_REGEX = /migrate[\s:-]dev\b/i;

/** Migration commands an application can legitimately run at STARTUP. */
const STARTUP_MIGRATION_PATTERNS: { pattern: RegExp; name: string }[] = [
  { pattern: /python\s+manage\.py\s+migrate\b/, name: 'python manage.py migrate' },
  { pattern: /prisma\s+migrate\s+deploy\b/, name: 'prisma migrate deploy' },
  { pattern: /rails\s+db:(?:prepare|migrate)\b/, name: 'rails db:prepare/db:migrate' },
  { pattern: /flask\s+db\s+upgrade\b/, name: 'flask db upgrade' },
  { pattern: /alembic\s+upgrade\s+head\b/, name: 'alembic upgrade head' },
  { pattern: /php\s+artisan\s+migrate\s+--force/, name: 'php artisan migrate --force' },
  { pattern: /knex\s+migrate:(?:latest|up)\b/, name: 'knex migrate:latest' },
  { pattern: /typeorm\s+migration:run\b/, name: 'typeorm migration:run' },
  { pattern: /\bflyway\s+migrate\b/, name: 'flyway migrate' },
  { pattern: /\bliquibase\s+(?:update|migrate)\b/, name: 'liquibase update/migrate' },
];

/** A deploy-safe migration command text (the same family apps/api resolves). */
const DEPLOY_MIGRATION_COMMAND_REGEX =
  /prisma\s+migrate\s+deploy\b|drizzle-kit\s+(?:push|migrate)\b|knex\s+migrate:(?:latest|up)\b|sequelize\s+db:migrate\b|typeorm\s+migration:run\b|node-pg-migrate\b|npx\s+migrate\b/;

/** One piece of startup-migration evidence. */
export interface MigrationStartupEvidence {
  /** Where the command lives: a script name, Dockerfile CMD/ENTRYPOINT, or a shell script path. */
  readonly source: string;
  readonly pattern: string;
}

/** True when the command text is deploy-shaped and not dev-mode. */
export function isDeploySafeMigrationCommand(command: string): boolean {
  return !MIGRATION_DEV_REGEX.test(command) && DEPLOY_MIGRATION_COMMAND_REGEX.test(command);
}

/**
 * A deploy-safe migration script exists in any package.json (script key or a
 * deploy-shaped command value), mirroring apps/api's resolveMigrationCommand
 * convention — this is the mode='pre_deploy' signal.
 */
export function hasPreDeployMigration(tree: FileTree): boolean {
  for (const [key, command] of collectScripts(tree)) {
    // A migration chained into the app's own start/dev command runs at
    // STARTUP, not as a pre-deploy step — never pre_deploy evidence.
    if (key === 'start' || key === 'dev') continue;
    if (isDeploySafeMigrationCommand(command)) return true;
    if (/migrat/i.test(key) && !MIGRATION_DEV_REGEX.test(command)) return true;
  }
  return false;
}

/**
 * Migrations that run when the APPLICATION STARTS: the app's own start
 * script, the selected Dockerfile's CMD/ENTRYPOINT, or an entrypoint/start/
 * boot shell script next to the Dockerfile (or at the app root). Evidence
 * only — the command is never invented into the manifest.
 */
export function detectStartupMigrationEvidence(tree: FileTree): MigrationStartupEvidence[] {
  const evidence: MigrationStartupEvidence[] = [];
  const consider = (command: string, source: string): void => {
    if (MIGRATION_DEV_REGEX.test(command)) return;
    for (const { pattern, name } of STARTUP_MIGRATION_PATTERNS) {
      if (pattern.test(command)) {
        evidence.push({ source, pattern: name });
        return;
      }
    }
  };

  for (const [name, command] of collectScripts(tree)) {
    if (name === 'start' || name === 'dev') consider(command, `package.json script "${name}"`);
  }

  const dockerfile = selectedDockerfile(tree);
  if (dockerfile) {
    const cmd = CMD_REGEX.exec(dockerfile.content)?.[1];
    if (cmd) consider(cmd, `CMD (${dockerfile.path})`);
    const entry = ENTRYPOINT_REGEX.exec(dockerfile.content)?.[1];
    if (entry) consider(entry, `ENTRYPOINT (${dockerfile.path})`);
  }

  const dockerDir = dockerfile?.path?.includes('/') ? (dockerfile.path.split('/').slice(0, -1).join('/') ?? '') : '';
  for (const [path, content] of Object.entries(tree)) {
    if (!content || !isRuntimeSourcePath(path)) continue;
    const basename = (path.split('/').pop() ?? '').toLowerCase();
    const isBootScript = /^entrypoint(?:\.|$)|^start\.sh$|^boot\.sh$|^startup\.sh$/.test(basename);
    const nearRoot =
      !path.includes('/') || (dockerDir.length > 0 && path.startsWith(`${dockerDir}/`));
    if (!isBootScript || !nearRoot) continue;
    consider(content, path);
  }

  return evidence;
}

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
    source: 'package-manifest',
  };
}

// 11. Startup command
// ---------------------------------------------------------------------------

const CMD_REGEX = /^CMD\s+(.+)$/m;
const ENTRYPOINT_REGEX = /^ENTRYPOINT\s+(.+)$/m;

/**
 * Detect the application startup command from the selected Dockerfile's
 * CMD/ENTRYPOINT instructions and package.json "start" script.
 */
export function detectStartupCommand(tree: FileTree): DetectorFinding {
  const sources: string[] = [];
  let source: DetectorSource | undefined;

  // 1. The selected Dockerfile's CMD/ENTRYPOINT — the image Deployz builds,
  //    not every scaffold or sibling image in the repository.
  const dockerfile = selectedDockerfile(tree);
  if (dockerfile) {
    const cmdMatch = CMD_REGEX.exec(dockerfile.content);
    if (cmdMatch && cmdMatch[1]) {
      sources.push(`CMD: ${cmdMatch[1].trim()}`);
    }
    const entryMatch = ENTRYPOINT_REGEX.exec(dockerfile.content);
    if (entryMatch && entryMatch[1]) {
      sources.push(`ENTRYPOINT: ${entryMatch[1].trim()}`);
    }
    if (sources.length > 0) source = 'dockerfile';
  }

  // 2. package.json "start" script
  for (const [name, command] of collectScripts(tree)) {
    if (name === 'start') {
      sources.push(`start: ${command}`);
      source ??= 'package-manifest';
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
    source,
  };
}

// 12. External services
// ---------------------------------------------------------------------------

/**
 * §11.3 catalog — the external services Deployz detects deterministically and
 * the well-known configuration keys each maps to. Deployz only ever COLLECTS
 * configuration for these; it never provisions the service itself. `packages`
 * are dependency tokens matched in dependency manifests/imports; `urlDomains`
 * are a secondary signal (an API host configured in code with no SDK dep).
 */
export interface ExternalServiceDefinition {
  /** Stable canonical id, also used as the manifest.externalServices entry. */
  id: string;
  /** Dependency/import tokens that prove the service SDK is used. */
  packages: string[];
  /** The service's own API hosts, matched only inside URL literals. */
  urlDomains: string[];
  /** Well-known env keys the service configures, most-required first. */
  keys: string[];
}

export const EXTERNAL_SERVICE_CATALOG: ExternalServiceDefinition[] = [
  { id: 'stripe', packages: ['stripe'], urlDomains: ['api.stripe.com'], keys: ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET'] },
  { id: 'clerk', packages: ['@clerk/clerk-sdk-node', '@clerk/clerk-js', '@clerk/nextjs', '@clerk/clerk-react', '@clerk/backend'], urlDomains: ['clerk.com'], keys: ['CLERK_SECRET_KEY', 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY'] },
  { id: 'auth0', packages: ['auth0', '@auth0/auth0-react', '@auth0/nextjs-auth0', '@auth0/auth0-spa-js', 'auth0-js'], urlDomains: ['auth0.com'], keys: ['AUTH0_DOMAIN', 'AUTH0_CLIENT_ID', 'AUTH0_CLIENT_SECRET'] },
  { id: 'resend', packages: ['resend'], urlDomains: ['api.resend.com'], keys: ['RESEND_API_KEY'] },
  { id: 'sendgrid', packages: ['@sendgrid/mail', '@sendgrid/client', 'sendgrid'], urlDomains: ['api.sendgrid.com'], keys: ['SENDGRID_API_KEY'] },
  { id: 'smtp', packages: ['nodemailer', 'nodemailer-smtp-transport', 'nodemailer-smtp-pool'], urlDomains: [], keys: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'] },
  { id: 'sentry', packages: ['@sentry/node', '@sentry/nextjs', '@sentry/browser', '@sentry/react', '@sentry/serverless'], urlDomains: ['sentry.io'], keys: ['SENTRY_DSN'] },
  { id: 'openai', packages: ['openai', 'openai-node'], urlDomains: ['api.openai.com'], keys: ['OPENAI_API_KEY'] },
  { id: 'anthropic', packages: ['@anthropic-ai/sdk'], urlDomains: ['api.anthropic.com'], keys: ['ANTHROPIC_API_KEY'] },
  { id: 'twilio', packages: ['twilio'], urlDomains: ['api.twilio.com'], keys: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'] },
  { id: 'shopify', packages: ['@shopify/shopify-api', 'shopify-api-node'], urlDomains: ['myshopify.com', 'shopify.com'], keys: ['SHOPIFY_API_KEY', 'SHOPIFY_API_SECRET'] },
];

/** A single detected §11.3 integration, with its env-key mapping. */
export interface ExternalServiceRequirement {
  service: string;
  /** Evidence the vendor can read (file paths / declared packages). */
  evidence: string[];
}

/** True when a code/import scan or dependency manifest proves the token is used. */
function dependencyOrImportHit(tree: FileTree, token: string): string[] {
  if (collectDependencyNames(tree).includes(token)) return ['package.json dependency'];
  // SMTP is often used through Python's stdlib (no dependency to declare).
  if (token === 'nodemailer') {
    for (const [path, content] of Object.entries(tree)) {
      if (content && /import\s+smtplib/.test(content)) return [path];
    }
  }
  return findDependencyEvidence(tree, token);
}

/** Match a URL literal against the domains of a catalog entry. */
function urlHitsDomain(content: string, domains: string[]): boolean {
  if (domains.length === 0) return false;
  for (const domain of domains) {
    const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`https?:\\/\\/[^'"\\s]*${escaped}`).test(content)) return true;
  }
  return false;
}

/** Match a service's keys anywhere they are read or declared (env files, code, Prisma). */
function envKeyEvidence(tree: FileTree, key: string): boolean {
  const envRe = new RegExp(`^${key}\\s*[=:]`, 'm');
  for (const [path, content] of Object.entries(tree)) {
    if (!content) continue;
    if (/^\.env(\.\w+)?$/i.test(path) && envRe.test(content)) return true;
    if (JS_SOURCE.test(path) && new RegExp(`process\\.env\\.${key}\\b`).test(content)) return true;
    if (PY_SOURCE.test(path) && (new RegExp(`os\\.environ(?:\\[|\\s*\\.\\s*get\\s*\\().{0,3}['"]${key}['"]`).test(content) || new RegExp(`os\\.getenv\\s*\\(\\s*['"]${key}['"]`).test(content))) return true;
  }
  return false;
}

/**
 * Detect external (non-Deployz) service integrations (§11.3). Deterministic:
 * a canonical service is recorded only when its SDK package or API host is
 * actually present. The old generic "any external HTTP URL is a service"
 * scan is gone — it turned documentation links and CDN hosts into bogus
 * integrations.
 */
export function detectExternalServices(tree: FileTree): DetectorFinding {
  const requirements = collectExternalServices(tree);

  if (requirements.length === 0) {
    return { detector: 'external-services', detected: false };
  }

  return {
    detector: 'external-services',
    detected: true,
    value: requirements.map((r) => r.service),
    details: `External services detected: ${requirements.map((r) => r.service).join(', ')}`,
  };
}

/**
 * The §11.3 service requirements as structured metadata — the manifest
 * external-services surface and the env-model enrichment both read from it.
 */
export function detectExternalServiceRequirements(tree: FileTree): ExternalServiceRequirement[] {
  return collectExternalServices(tree);
}

/** Shared §11.3 collector used by both public entry points. */
function collectExternalServices(tree: FileTree): ExternalServiceRequirement[] {
  const requirements: ExternalServiceRequirement[] = [];
  for (const def of EXTERNAL_SERVICE_CATALOG) {
    const evidence: string[] = [];
    for (const pkg of def.packages) {
      for (const hit of dependencyOrImportHit(tree, pkg)) {
        const text = `${pkg} (${hit})`;
        if (!evidence.includes(text)) evidence.push(text);
      }
    }
    // URL evidence only counts when no package evidence exists (a host alone
    // is weaker than a declared SDK, but still a real integration when the
    // code points at the service's API).
    if (evidence.length === 0 && def.urlDomains.length > 0) {
      for (const [path, content] of Object.entries(tree)) {
        if (content && urlHitsDomain(content, def.urlDomains)) {
          evidence.push(`${def.urlDomains[0]} URL in ${path}`);
        }
      }
    }
    if (evidence.length > 0) {
      requirements.push({ service: def.id, evidence });
    }
  }
  return requirements;
}

/**
 * Map a §11.3 catalog key onto a detected integration. Returns the catalog
 * definition plus whether the repository itself evidences the key (an env
 * sample line or a code read) — only evidenced keys become REQUIRED manifest
 * variables, so a vendor that wires a different key name is never blocked on
 * a canonical one it does not use.
 */
export function findExternalServiceForEnvKey(
  tree: FileTree,
  services: string[],
  key: string,
): { service: string; key: string; evidenced: boolean } | null {
  const def = EXTERNAL_SERVICE_CATALOG.find(
    (candidate) => candidate.keys.includes(key) && services.includes(candidate.id),
  );
  if (!def) return null;
  return { service: def.id, key, evidenced: envKeyEvidence(tree, key) };
}

// 12b. Env-var model (§11.2)
// ---------------------------------------------------------------------------

const SECRET_NAME_REGEX =
  /SECRET|TOKEN|PASSWORD|PASS(?!WORD|ENGER|AGE|IVE)|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|_KEY\b|_PASS\b/i;

/** Sample files the env model treats as documentation of the app's config. */
const ENV_SAMPLE_FILE_REGEX = /(?:^|\/)(?:\.env(?:\.example|\.sample|\.template)|\.env)$/i;

// Helpers that parse an environment value and take a default as a later
// argument: `parseEnvVarNumber(process.env.X, 10)`, `getEnv(process.env.X, 'a')`,
// `envBool(process.env.X, false)`.
const DEFAULTING_HELPER_REGEX = /^(?:parse|read|get|load|resolve|env|to)\w*$|(?:Number|Boolean|Bool|String|Int|Float|List|Env)$/;

/** A value that documents "no usable default" (blank or a named placeholder). */
function isPlaceholderValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  return /^<[^>]*>$|^(?:your|your[-_ ]|xxx+|changeme|change[-_ ]me|example|placeholder|\.\.\.)$/i.test(trimmed);
}

// ── Stage B phase 3 (COMP-017): schema-library / helper-form env reads ──────
// Narrow, evidence-backed recognition of the common "required config behind an
// abstraction" shapes: zod object schemas, envalid validators, throwing
// `env('KEY')` helpers, pydantic BaseSettings, JVM @Value, Go os.Getenv,
// .NET GetConnectionString. No general program interpretation.

const JAVA_SOURCE_REGEX = /\.(?:java|kt|kts|scala)$/;
const DOTNET_SOURCE_REGEX = /\.cs$/;
const ENV_KEY_LITERAL = /[A-Z][A-Z0-9_]*/;

/** A key literal `[A-Z][A-Z0-9_]*`, or null when the placeholder is not env-shaped. */
function envKeyLiteral(raw: string): string | null {
  return ENV_KEY_LITERAL.test(raw) ? raw : null;
}

/** The characters of a member/chain expression up to its closing delimiter (comma or brace). */
function sliceToChainEnd(content: string, start: number, limit = 240): string {
  let depth = 0;
  for (let i = start; i < content.length && i - start < limit; i += 1) {
    const ch = content[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === ',' || ch === '}')) return content.slice(start, i);
  }
  return content.slice(start, Math.min(content.length, start + limit));
}

/** zod object schemas used with process.env (`CORE_SECRET: z.string().min(1)`). */
function scanZodEnvReads(content: string): { key: string; needsValue: boolean }[] {
  const isZod = /(?:from\s+['"]zod['"]|require\(\s*['"]zod['"]\s*\))/.test(content);
  if (!isZod || !content.includes('.object(') || !content.includes('process.env')) return [];
  const found: { key: string; needsValue: boolean }[] = [];
  const memberRegex = /^\s*([A-Z][A-Z0-9_]*)\s*:\s*z\./gm;
  let match: RegExpExecArray | null;
  while ((match = memberRegex.exec(content)) !== null) {
    const chain = sliceToChainEnd(content, memberRegex.lastIndex);
    const optional = /(?:\.default\s*\(|\.optional\s*\(|\.nullish\s*\(|\.catch\s*\()/.test(chain);
    found.push({ key: match[1]!, needsValue: !optional });
  }
  return found;
}

/** envalid validator objects fed to `cleanEnv` (`KEY: str()` vs `str({ default })`). */
function scanEnvalidReads(content: string): { key: string; needsValue: boolean }[] {
  if (!content.includes('cleanEnv(') && !content.includes('envalid')) return [];
  const found: { key: string; needsValue: boolean }[] = [];
  const memberRegex =
    /^\s*([A-Z][A-Z0-9_]*)\s*:\s*\b(?:str|num|bool|json|url|email|host|port|makeValidator)\s*\(/gm;
  let match: RegExpExecArray | null;
  while ((match = memberRegex.exec(content)) !== null) {
    const args = sliceToChainEnd(content, memberRegex.lastIndex);
    const optional = /(?:default|devDefault)\s*:|\.optional\s*\(/.test(args);
    found.push({ key: match[1]!, needsValue: !optional });
  }
  return found;
}

/** A file-local `env('KEY')` helper that throws when the variable is missing. */
function hasThrowingEnvHelper(content: string): boolean {
  const helperMatch = /(?:function\s+env\b[^{]*\{|=\s*\(\s*[^)]*\)\s*=>\s*\{)/.exec(content);
  if (!helperMatch) return false;
  const body = content.slice(helperMatch.index, Math.min(content.length, helperMatch.index + 600));
  return body.includes('process.env') && /throw\b/.test(body);
}

/** Calls of a throwing `env('KEY')` helper. */
function scanEnvHelperReads(content: string): { key: string; needsValue: boolean }[] {
  const found: { key: string; needsValue: boolean }[] = [];
  const callRegex = /\benv\(\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = callRegex.exec(content)) !== null) {
    found.push({ key: match[1]!, needsValue: true });
  }
  return found;
}

/** pydantic v2 BaseSettings class fields (required unless defaulted/optional). */
function scanPydanticSettingsReads(content: string): { key: string; needsValue: boolean }[] {
  if (!content.includes('BaseSettings') || !/(?:from\s+pydantic|pydantic_settings)\s*import|import\s+pydantic/.test(content)) {
    return [];
  }
  const found: { key: string; needsValue: boolean }[] = [];
  const classRegex = /^\s*class\s+\w+\s*\(\s*BaseSettings\s*\)\s*:/gm;
  let _classMatch: RegExpExecArray | null;
  while ((_classMatch = classRegex.exec(content)) !== null) {
    const blockStart = content.indexOf('\n', classRegex.lastIndex) + 1;
    const nextTopLevel = content.search(/\n\s*(?:class|def|@)\s/g);
    const blockEnd = nextTopLevel > blockStart ? nextTopLevel : content.length;
    const block = content.slice(blockStart, blockEnd);
    const fieldRegex = /^\s*([A-Za-z_]\w*)\s*:\s*([^=\n#]+?)(?:\s*=\s*([^\n#]+))?(?:\s*#.*)?$/gm;
    let fieldMatch: RegExpExecArray | null;
    while ((fieldMatch = fieldRegex.exec(block)) !== null) {
      const name = fieldMatch[1]!;
      if (name.startsWith('_')) continue;
      const annotation = fieldMatch[2] ?? '';
      const assignment = (fieldMatch[3] ?? '').trim();
      const optionalAnnotation = /\bOptional\b|\bNone\b|\|?\s*None\s*(?:$|,)|=\s*None/.test(annotation);
      let needsValue: boolean;
      if (assignment.length === 0) {
        needsValue = !optionalAnnotation;
      } else if (assignment.startsWith('Field(')) {
        // `Field(...)` / `Field(alias=...)` with no default ⇒ required; any
        // `default=`, `= None`, or `optional` ⇒ not.
        needsValue = !/default\s*=|optional\s*=|=\s*None\b/.test(assignment);
      } else {
        needsValue = false; // a literal default or `= None`
      }
      // The env var Pydantic reads: the field's own uppercase name, or an
      // explicit Field(alias=...) when present.
      const alias = /alias\s*=\s*['"]([A-Z_][A-Z0-9_]*)['"]/.exec(assignment)?.[1];
      const key = alias ?? name.toUpperCase();
      found.push({ key, needsValue });
    }
  }
  return found;
}

/** JVM `@Value("${KEY}")` (required unless `:default`) and `System.getenv("KEY")`. */
function scanJvmEnvReads(content: string): { key: string; needsValue: boolean }[] {
  const found: { key: string; needsValue: boolean }[] = [];
  const valueRegex = /@Value\s*\(\s*"\$\{\s*([^}]+)\}\s*"/g;
  let match: RegExpExecArray | null;
  while ((match = valueRegex.exec(content)) !== null) {
    const placeholder = match[1]!;
    const hasDefault = placeholder.includes(':');
    const key = envKeyLiteral(hasDefault ? placeholder.slice(0, placeholder.indexOf(':')) : placeholder);
    if (key !== null && !placeholder.includes('.')) {
      found.push({ key, needsValue: !hasDefault });
    }
  }
  const getenvRegex = /System\.getenv\(\s*"([A-Z][A-Z0-9_]*)"\s*\)/g;
  while ((match = getenvRegex.exec(content)) !== null) {
    found.push({ key: match[1]!, needsValue: false });
  }
  return found;
}

/** Go `os.Getenv` / `os.LookupEnv`, required only with an adjacent missing-check or a required struct tag. */
function scanGoEnvReads(content: string): { key: string; needsValue: boolean }[] {
  const found: { key: string; needsValue: boolean }[] = [];
  const readRegex = /os\.(?:Getenv|LookupEnv)\(\s*"([A-Z][A-Z0-9_]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = readRegex.exec(content)) !== null) {
    const key = match[1]!;
    // `if os.Getenv("KEY") == "" { log.Fatal/panic… }` — the app refuses to
    // boot without the value. The window starts before the call so the
    // enclosing `if` is visible.
    const from = Math.max(0, match.index - 60);
    const vicinity = content.slice(from, Math.min(content.length, match.index + 240));
    const missingCheck = new RegExp(
      `if\\s+os\\.(?:Getenv|LookupEnv)\\(\\s*"${key}"[^)]*\\)\\s*==\\s*""\\s*\\{`,
    ).test(vicinity);
    const refuses = missingCheck && /log\.Fatal|panic\s*\(|log\.Panic/.test(vicinity);
    found.push({ key, needsValue: refuses });
  }
  // envconfig struct tags: `envconfig:"KEY,required"` (inline option) or a
  // tag carrying both the env name and a required/validate marker.
  const tagRegex = /envconfig:"([A-Z][A-Z0-9_]*)(?:,([^"]*))?"/g;
  while ((match = tagRegex.exec(content)) !== null) {
    const key = match[1]!;
    const options = match[2] ?? '';
    // A single backtick-delimited struct tag that also declares
    // required:"true" / validate:"required" for this key.
    const combined = new RegExp(
      'envconfig:"' + key + '"[^`]*(?:required:"true"|validate:"required")',
    ).test(content);
    found.push({ key, needsValue: options.includes('required') || combined });
  }
  return found;
}

/** .NET `GetConnectionString`/`GetRequiredSection`, required only behind a `?? throw`. */
function scanDotnetEnvReads(content: string): { key: string; needsValue: boolean }[] {
  const found: { key: string; needsValue: boolean }[] = [];
  const readRegex = /(GetRequiredSection|GetConnectionString)\(\s*"([A-Z][A-Z0-9_]*)"\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = readRegex.exec(content)) !== null) {
    const method = match[1]!;
    const tail = content.slice(match.index + match[0].length, match.index + match[0].length + 120);
    const throwGuarded = /\?\?\s*(?:throw\b|new\b)/.test(tail);
    found.push({ key: match[2]!, needsValue: method === 'GetRequiredSection' || throwGuarded });
  }
  return found;
}

// ── Stage B phase 3 (COMP-017): env-var purpose classification ──────────────

/** Standard provisioned env names the manifest/cdk always inject. */
const INFRA_BINDING_NAMES = new Set<string>([
  'DATABASE_URL',
  'DATABASE_HOST',
  'DATABASE_PORT',
  'DATABASE_NAME',
  'DATABASE_USER',
  'DATABASE_PASSWORD',
  'POSTGRES_URL',
  'POSTGRESQL_URL',
  'REDIS_URL',
  'REDIS_HOST',
  'REDIS_PORT',
  'CELERY_BROKER_URL',
  'CELERY_RESULT_BACKEND',
  'QUEUE_REDIS_URL',
  'CACHE_URL',
  'STORAGE_BUCKET',
  'S3_BUCKET',
  'AWS_S3_BUCKET',
  'AWS_REGION',
  'S3_REGION',
  'S3_ENDPOINT',
]);

/** Alias shapes the infrastructure-binding phase can inject (MEMOS_DSN, PAPERLESS_DBHOST…). */
const INFRA_BINDING_ALIAS_REGEX =
  /(?:_DSN|_DATABASE_URL|_DATABASE_URI|_DB_URL|_DB_URI|_POSTGRES_URL|_POSTGRESQL_URL|_DBHOST|_DBPORT|_DBNAME|_DBUSER|_DBPASS|_BUCKET(?:_NAME)?|_S3_REGION)$/i;

/** Every §11.3 external-service catalog key (a vendor credential name). */
function externalServiceCatalogKeys(): Set<string> {
  const keys = new Set<string>();
  for (const def of EXTERNAL_SERVICE_CATALOG) {
    for (const key of def.keys) keys.add(key);
  }
  return keys;
}

export type EnvVarPurpose =
  | 'internal_secret'
  | 'external_credential'
  | 'infrastructure_binding'
  | 'optional_configuration'
  | 'unknown';

/**
 * Stage B phase 4 — whether a variable is a Deployz-GENERATABLE application
 * INTERNAL secret (never an external vendor credential, never a provisioned
 * binding). The eligible class: secret-shaped names like AUTH_SECRET /
 * SESSION_SECRET / JWT_SECRET / SECRET_KEY / ENCRYPTION_KEY /
 * NEXTAUTH_SECRET / COOKIE_SECRET / APP_SECRET — they all fall out of the
 * purpose rule below; no name list is the source of truth.
 */
const GENERIC_VENDOR_CREDENTIAL_SHAPE =
  /_(?:API_KEY|API_SECRET|CLIENT_SECRET|CLIENT_ID|ACCESS_KEY|ACCESS_TOKEN|SECRET_KEY|PRIVATE_KEY|PUBLIC_KEY)$/i;

/** External-credential double-guard: catalog keys or a generic vendor-credential name shape. */
export function isExternalCredentialShape(key: string): boolean {
  return externalServiceCatalogKeys().has(key) || GENERIC_VENDOR_CREDENTIAL_SHAPE.test(key);
}

/** Deterministic purpose for one env var key. */
export function classifyEnvVarPurpose(key: string): { purpose: EnvVarPurpose; confidence: 'high' | 'medium' | 'low' } {
  if (isExternalCredentialShape(key)) {
    return { purpose: 'external_credential', confidence: 'high' };
  }
  if (INFRA_BINDING_NAMES.has(key)) {
    return { purpose: 'infrastructure_binding', confidence: 'high' };
  }
  if (INFRA_BINDING_ALIAS_REGEX.test(key)) {
    return { purpose: 'infrastructure_binding', confidence: 'medium' };
  }
  if (isSecretName(key)) {
    return { purpose: 'internal_secret', confidence: 'medium' };
  }
  return { purpose: 'optional_configuration', confidence: 'medium' };
}

/**
 * The §11.2 env-var model — every environment variable the app reads or
 * declares, with honest required/secret/source attributes.
 *
 * `required` is deliberately narrow (high precision over recall). A variable
 * is REQUIRED only when ALL of these hold:
 *   - the app READS it somewhere and the read NEEDS a value — no inline
 *     `??`/`||` fallback, and not a pure presence guard (`=== 'x'` checks,
 *     `if (process.env.X)`), and not a defaulted read (Python
 *     `os.getenv('X', d)`, Ruby `ENV.fetch('X', d)`);
 *   - nothing in the repository supplies a usable default value (a real env
 *     sample value, or a read with an inline fallback).
 *
 * A sample entry the app never reads (NEXTAUTH_SECRET in a repo with no auth
 * code) is NOT required. §11.3 well-known service keys that the repository
 * evidences (read or declared) are upgraded to required+secret — an SDK
 * dependency without its credential cannot function.
 *
 * A read chained straight into further use (`process.env.X.split(',')`,
 * never stored raw) is also NOT required when the same file early-returns on
 * that key's absence (`if (!process.env.X) return …`) — only an early
 * **throw** for that key still means required (Documenso's
 * NEXT_PRIVATE_DATABASE_REPLICA_URLS, COMP false-positive fix).
 */
/** Engine-selector variables that decide which database engine the app uses. */
const ENGINE_SELECTOR_NAMES = ['DB', 'DB_ENGINE', 'DATABASE_ENGINE', 'DB_CLIENT', 'DB_BACKEND'];

/**
 * COMP-022 — engine selectors defaulting to a non-PostgreSQL engine while a
 * PostgreSQL driver is also present. The selector read must then be REQUIRED:
 * without a value the app boots on SQLite inside the container and silently
 * drops data instead of using the provisioned database.
 */
function unresolvedEngineSelectors(tree: FileTree): Set<string> {
  const selectors = new Set<string>();
  for (const [path, content] of Object.entries(tree)) {
    if (!content || !isRuntimeSourcePath(path)) continue;
    for (const name of ENGINE_SELECTOR_NAMES) {
      const defaulted = new RegExp(
        `(?:["']${name}["']\\s*[,)]\\s*["']?(?:sqlite|sqlite3)|process\\.env\\.${name}\\s*\\|\\|\\s*["'](?:sqlite|sqlite3)|os\\.getenv\\s*\\(\\s*["']${name}["'][^)]*["'](?:sqlite|sqlite3))`,
      ).test(content);
      if (defaulted) selectors.add(name);
    }
  }
  if (selectors.size === 0) return selectors;
  return detectPostgresql(tree).detected ? selectors : new Set<string>();
}

export function detectEnvVarModel(tree: FileTree, externalServices: string[] = []): ManifestEnvVariable[] {
  // ── 1. Declarations: every KEY=VALUE line in any env file we ship with. ──
  const declarations = new Map<string, { realValue: boolean; sampleEmpty: boolean; files: string[] }>();
  for (const [path, content] of Object.entries(tree)) {
    if (!content || !/^\.env(\.\w+)?$/i.test(path)) continue;
    const isSample = ENV_SAMPLE_FILE_REGEX.test(path);
    // `\s` includes the newline, so a `\s*` after `=` would swallow the rest
    // of the file — use space/tab-only gaps so each KEY=VALUE line parses on
    // its own line.
    const regex = /^[ \t]*([A-Z_][A-Z0-9_]*)[ \t]*=[ \t]*(.*)$/gm;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const key = match[1];
      if (!key) continue;
      const value = (match[2] ?? '').replace(/\s+#.*$/, '').trim();
      const current = declarations.get(key) ?? { realValue: false, sampleEmpty: false, files: [] };
      if (!isPlaceholderValue(value)) current.realValue = true;
      if (isSample && isPlaceholderValue(value)) current.sampleEmpty = true;
      if (!current.files.includes(path)) current.files.push(path);
      declarations.set(key, current);
    }
  }

  // ── 2. Reads: which variables the app actually reads, and whether a read
  //      NEEDS a value vs. tolerates absence (fallback or presence guard). ──
  const reads = new Map<string, { needsValue: boolean; files: string[] }>();
  const recordRead = (key: string, needsValue: boolean, file: string): void => {
    const current = reads.get(key) ?? { needsValue: false, files: [] };
    if (needsValue) current.needsValue = true;
    if (!current.files.includes(file)) current.files.push(file);
    reads.set(key, current);
  };

  for (const [path, content] of Object.entries(tree)) {
    if (!content || !isRuntimeSourcePath(path)) continue;
    if (JS_SOURCE.test(path)) {
      const readRegex =
        /process\.env\s*\.\s*([A-Z_][A-Z0-9_]*)|process\.env\[["']([A-Z_][A-Z0-9_]*)["']\]/g;
      let match: RegExpExecArray | null;
      while ((match = readRegex.exec(content)) !== null) {
        const key = match[1] ?? match[2];
        if (!key) continue;
        // Statement-bound tail: a `??`/`||` on a LATER statement must not look
        // like a fallback for this read.
        const rawTail = content.slice(match.index + match[0].length, match.index + match[0].length + 160);
        const statementEnd = rawTail.search(/[\n;]/);
        const tail = statementEnd === -1 ? rawTail : rawTail.slice(0, statementEnd);
        const head = content.slice(Math.max(0, match.index - 60), match.index);
        // A read only TOLERATES an absent variable (never REQUIRES it) when it
        // is a presence GUARD: an equality/ternary test, a negation, a boolean
        // chain, or the direct condition of if/while/catch. A read inside an
        // ordinary function call (`new Stripe(process.env.KEY)`) is NOT a
        // guard — it is a required value.
        const lastOpen = head.lastIndexOf('(');
        const inConditional =
          lastOpen >= 0 && /(?:if|while|catch)\s*$/.test(head.slice(0, lastOpen).replace(/\s+$/, ''));
        // A read that is itself the alternative of a `??`/`||` chain
        // (`process.env.A ?? process.env.B`) is a fallback, not a
        // requirement; and a read handed to a parsing helper alongside a
        // default argument (`parseEnvVarNumber(process.env.PORT, 4242)`)
        // carries that default (Stage A COMP-017).
        const isAlternative = /(?:\?\?|\|\|)\s*$/.test(head);
        const callee = /([A-Za-z_$][\w$]*)\s*\(\s*(?:[^()]*,\s*)?$/.exec(head)?.[1] ?? '';
        // The default must be a literal (a string, number, boolean, null or a
        // CONSTANT) — `axios.get(process.env.URL, { headers })` carries none.
        const helperWithDefault =
          DEFAULTING_HELPER_REGEX.test(callee) &&
          /^\s*(?:\|\|[^,;\n]*)?,\s*(?:['"`][^'"`]*['"`]|-?\d[\d._]*|true|false|null|undefined|[A-Z][A-Z0-9_]*)\s*[,)]/.test(tail);
        const hasFallback =
          /(?:\?\?|\|\|)\s*\S/.test(tail) || /(?:\?\?=|\|\|=)/.test(tail) || isAlternative || helperWithDefault;
        const isGuard =
          /^\s*(?:===|!==|==|!=)/.test(tail) ||
          /^\s*\?/.test(tail) ||
          /!\s*[A-Za-z_$][\w$.:]*$/.test(head) ||
          /(?:&&|\|\|)\s*[A-Za-z_$][\w$.:]*$/.test(head) ||
          // A boolean chain or coercion tests presence: `Boolean(process.env.A
          // && process.env.B)`, `!!process.env.A`, `enabled = process.env.A && …`.
          /^\s*&&/.test(tail) ||
          /&&\s*$/.test(head) ||
          /(?:Boolean\s*\(|!!)\s*$/.test(head) ||
          inConditional;
        // A non-secret read stored as-is (`const url = process.env.X;`,
        // `host: process.env.X,`) proves nothing about need — the consumer
        // decides later. It is required only when the code then refuses to
        // run without it: `if (!url) throw …`. A secret-named variable stays
        // required on a bare read: a missing credential is a boot failure,
        // an unset option is a default (Stage A COMP-023).
        const assignedName = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(head)?.[1];
        const isBareAssignment = /[=:]\s*$/.test(head) && /^\s*(?:[;,)}\]]|$)/.test(tail) && !isSecretName(key);
        // A read chained straight into further use before storage
        // (`process.env.X.split(',')`) is bare in the same sense — the
        // consumer decides what the transformed value means, not this read.
        const isBareChainAccess = !isSecretName(key) && /^\.[A-Za-z_$]/.test(tail);
        let throwGuarded = false;
        let returnGuarded = false;
        if (isBareAssignment || isBareChainAccess) {
          const guardTargets = [
            `process\\.env\\.${key}\\b`,
            `process\\.env\\[["']${key}["']\\]`,
            assignedName ? `${assignedName}\\b` : null,
          ]
            .filter(Boolean)
            .join('|');
          const exitGuard = new RegExp(
            `if\\s*\\(\\s*!\\s*(?:${guardTargets})[^)]*\\)\\s*\\{?\\s*(throw|return)\\b`,
          ).exec(content);
          throwGuarded = exitGuard?.[1] === 'throw';
          returnGuarded = exitGuard?.[1] === 'return';
        }
        // A bare assignment needs a throw to become required (existing
        // behaviour); a bare chain access is required by default and only
        // an early RETURN (not throw) on the same key clears it.
        const bareNeedsValue = isBareAssignment ? throwGuarded : isBareChainAccess ? !returnGuarded : true;
        recordRead(key, !hasFallback && !isGuard && bareNeedsValue, path);
      }
      // Stage B phase 3 (COMP-017): schema-library and helper-form reads —
      // zod object schemas parsed against process.env, envalid validator
      // objects, and a file-local throwing `env('KEY')` helper.
      for (const entry of [
        ...scanZodEnvReads(content),
        ...scanEnvalidReads(content),
        ...(hasThrowingEnvHelper(content) ? scanEnvHelperReads(content) : []),
      ]) {
        recordRead(entry.key, entry.needsValue, path);
      }
    } else if (/schema\.prisma$/i.test(path)) {
      const envRegex = /env\(\s*["']([A-Z_][A-Z0-9_]*)["']\s*\)/g;
      let match: RegExpExecArray | null;
      while ((match = envRegex.exec(content)) !== null) {
        if (match[1]) recordRead(match[1], true, path);
      }
    } else if (PY_SOURCE.test(path)) {
      const indexRegex = /os\.environ\[["']([A-Z_][A-Z0-9_]*)["']\]/g;
      let match: RegExpExecArray | null;
      while ((match = indexRegex.exec(content)) !== null) {
        if (match[1]) recordRead(match[1], true, path);
      }
      const defaultedRegex = /os\.(?:environ\.get|getenv)\(\s*["']([A-Z_][A-Z0-9_]*)["']/g;
      while ((match = defaultedRegex.exec(content)) !== null) {
        // `os.getenv('X')` returns None when absent (app decides); only the
        // index form `os.environ['X']` REQUIRES the variable.
        if (match[1]) recordRead(match[1], false, path);
      }
      // Stage B phase 3 (COMP-017): pydantic v2 BaseSettings class fields.
      for (const entry of scanPydanticSettingsReads(content)) {
        recordRead(entry.key, entry.needsValue, path);
      }
    } else if (RB_SOURCE.test(path)) {
      const fetchRegex = /ENV\.fetch\(\s*["']([A-Z_][A-Z0-9_]*)["']/g;
      let match: RegExpExecArray | null;
      while ((match = fetchRegex.exec(content)) !== null) {
        const hasDefault = content.slice(match.index, match.index + 80).includes(',');
        if (match[1]) recordRead(match[1], !hasDefault, path);
      }
    } else if (JAVA_SOURCE_REGEX.test(path)) {
      for (const entry of scanJvmEnvReads(content)) {
        recordRead(entry.key, entry.needsValue, path);
      }
    } else if (GO_SOURCE.test(path)) {
      for (const entry of scanGoEnvReads(content)) {
        recordRead(entry.key, entry.needsValue, path);
      }
    } else if (DOTNET_SOURCE_REGEX.test(path)) {
      for (const entry of scanDotnetEnvReads(content)) {
        recordRead(entry.key, entry.needsValue, path);
      }
    }
  }

  // ── 3. Combine into the model. ──
  const keys = new Set<string>([...declarations.keys(), ...reads.keys()]);
  const entries: ManifestEnvVariable[] = [];

  for (const key of [...keys].sort()) {
    const declared = declarations.get(key);
    const read = reads.get(key);
    const needsValue = read?.needsValue === true;
    const hasDefault = declared?.realValue === true;
    const source: string[] = [];

    if (declared) {
      for (const file of declared.files) source.push(`${file} declares ${key}`);
    }
    if (read) {
      for (const file of read.files) source.push(`read in ${file}`);
    }

    // A defaulted/guarded read that never NEEDS the value is never required,
    // even when a sample line is empty — and a platform-provided variable is
    // never the vendor's to configure. COMP-022: an engine selector defaulting
    // to SQLite next to a PostgreSQL driver is the one exception — it must be
    // set for the provisioned database to be used.
    const required =
      (needsValue || unresolvedEngineSelectors(tree).has(key)) && !hasDefault && !isPlatformEnvVar(key);

    let secret = isSecretName(key);
    // §11.3 upgrade: an evidenced well-known service credential is a secret
    // and is required — the SDK cannot operate without it.
    const serviceKey = findExternalServiceForEnvKey(tree, externalServices, key);
    if (serviceKey?.evidenced) {
      secret = true;
      source.push(`${serviceKey.service} requires ${key}`);
    }
    // Stage B phase 3: deterministic purpose/confidence for every variable —
    // infra binding name or alias, external-service credential, internal
    // secret, or plain configuration.
    const classification = classifyEnvVarPurpose(key);
    // Stage B phase 4: application-INTERNAL required secrets Deployz can
    // generate (never external vendor credentials, never provisioned
    // bindings). `generatable` is set only when true — absence reads as "not
    // generatable", keeping old data valid.
    const generatable =
      classification.purpose === 'internal_secret' && required && !isExternalCredentialShape(key);
    // Never drop a var the app declares-and-reads from the config surface —
    // but drop nothing: a sample-only var is still worth listing as optional.
    entries.push({
      key,
      required,
      secret,
      source,
      purpose: classification.purpose,
      confidence: classification.confidence,
      ...(generatable ? { generatable: true } : {}),
    });
  }

  return entries;
}

/** Name-based credential heuristic — value-free, so it can never leak anything. */
function isSecretName(key: string): boolean {
  return SECRET_NAME_REGEX.test(key);
}

// Variables the runtime, the container platform or a CI/hosting provider
// supplies (Deployz itself injects PORT and HOSTNAME); an app reading one
// without a fallback is not asking the vendor for a value (Stage A COMP-016).
const PLATFORM_ENV_VARS = new Set<string>([
  'NODE_ENV',
  'NODE_OPTIONS',
  'PORT',
  'HOST',
  'HOSTNAME',
  'HOME',
  'PATH',
  'LD_LIBRARY_PATH',
  'PWD',
  'TZ',
  'LANG',
  'CI',
  'DEBUG',
  'VERCEL',
  'VERCEL_ENV',
  'VERCEL_URL',
  'NETLIFY',
  'GITHUB_ACTIONS',
  'NEXT_RUNTIME',
  'NEXT_PHASE',
  'NEXT_TELEMETRY_DISABLED',
]);

function isPlatformEnvVar(key: string): boolean {
  return PLATFORM_ENV_VARS.has(key) || key.startsWith('npm_');
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
    source: 'package-manifest',
  };
}

// 15. Runtime
// ---------------------------------------------------------------------------

/** The runtime family a base image or dependency manifest belongs to. */
export type RuntimeFamily = 'node' | 'python' | 'ruby' | 'go' | 'jvm' | 'dotnet' | 'php' | 'elixir' | 'rust';

const DOCKERFILE_FROM_REGEX = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/gim;

/** Base-image name → runtime family, matched on the image path without registry or tag. */
const RUNTIME_IMAGES: { pattern: RegExp; runtime: RuntimeFamily }[] = [
  { pattern: /(?:^|\/)(?:node|bun|denoland\/deno|deno)$/i, runtime: 'node' },
  { pattern: /(?:^|\/)(?:python|pypy)$/i, runtime: 'python' },
  { pattern: /(?:^|\/)(?:ruby|jruby)$/i, runtime: 'ruby' },
  { pattern: /(?:^|\/)golang$/i, runtime: 'go' },
  { pattern: /(?:^|\/)(?:eclipse-temurin|openjdk|amazoncorretto|maven|gradle|jetty|tomcat)$/i, runtime: 'jvm' },
  { pattern: /(?:^|\/)dotnet\/(?:sdk|aspnet|runtime)$/i, runtime: 'dotnet' },
  { pattern: /(?:^|\/)(?:php|composer)$/i, runtime: 'php' },
  { pattern: /(?:^|\/)(?:elixir|hexpm\/elixir|erlang)$/i, runtime: 'elixir' },
  { pattern: /(?:^|\/)rust$/i, runtime: 'rust' },
];

/** Dependency manifest → runtime family, when no Dockerfile base image decides. */
const RUNTIME_MANIFESTS: { pattern: RegExp; runtime: RuntimeFamily }[] = [
  { pattern: PACKAGE_JSON_REGEX, runtime: 'node' },
  { pattern: PY_DEPENDENCY_FILES, runtime: 'python' },
  { pattern: /(?:^|\/)Gemfile$/, runtime: 'ruby' },
  { pattern: GO_DEPENDENCY_FILES, runtime: 'go' },
  { pattern: /(?:^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?)$/, runtime: 'jvm' },
  { pattern: /(?:^|\/)(?:[\w.-]+\.csproj|[\w.-]+\.sln|global\.json)$/, runtime: 'dotnet' },
  { pattern: /(?:^|\/)composer\.json$/, runtime: 'php' },
  { pattern: /(?:^|\/)mix\.exs$/, runtime: 'elixir' },
  { pattern: /(?:^|\/)Cargo\.toml$/, runtime: 'rust' },
];

function runtimeFromImage(image: string): RuntimeFamily | null {
  // Strip a digest, a tag and a registry host (`public.ecr.aws/docker/
  // library/node:22`) down to the image name before matching.
  const withoutDigest = image.split('@')[0] ?? image;
  const tagIndex = withoutDigest.lastIndexOf(':');
  const path = tagIndex > withoutDigest.lastIndexOf('/') ? withoutDigest.slice(0, tagIndex) : withoutDigest;
  const name = path.replace(/^[^/]+\.[^/]+\//, '').replace(/^library\//, '');
  return RUNTIME_IMAGES.find(({ pattern }) => pattern.test(name))?.runtime ?? null;
}

/**
 * Detect the runtime family the deployed container runs. The selected
 * Dockerfile decides first: its LAST recognizable base image (the final
 * stage of a multi-stage build, or the build stage when the final stage is
 * a bare distroless/alpine image). Without one, the shallowest dependency
 * manifest decides — a root `package.json` outranks a nested
 * `requirements.txt`.
 */
export function detectRuntime(tree: FileTree): DetectorFinding {
  const dockerfile = selectedDockerfile(tree);
  if (dockerfile) {
    const images = [...dockerfile.content.matchAll(DOCKERFILE_FROM_REGEX)]
      .map((match) => match[1] ?? '')
      .filter((image) => image.length > 0);
    for (const image of [...images].reverse()) {
      const runtime = runtimeFromImage(image);
      if (runtime) {
        return {
          detector: 'runtime',
          detected: true,
          value: runtime,
          details: `Base image ${image} in ${dockerfile.path}`,
          source: 'dockerfile',
        };
      }
    }
  }

  const manifests = Object.keys(tree)
    .filter((path) => RUNTIME_MANIFESTS.some(({ pattern }) => pattern.test(path)))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  for (const path of manifests) {
    const runtime = RUNTIME_MANIFESTS.find(({ pattern }) => pattern.test(path))?.runtime;
    if (runtime) {
      return {
        detector: 'runtime',
        detected: true,
        value: runtime,
        details: `Dependency manifest ${path}`,
        source: 'package-manifest',
      };
    }
  }

  return { detector: 'runtime', detected: false };
}

// 16. Bind address
// ---------------------------------------------------------------------------

const LOOPBACK_LITERAL = /['"](?:127\.0\.0\.1|localhost|::1)['"]/;
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|::1)$/;
const ALL_INTERFACES_LITERAL = /['"](?:0\.0\.0\.0|::)['"]/;
const LISTEN_CALL_REGEX = /\.listen\s*\(([^)]*)\)/g;
const LISTEN_AND_SERVE_REGEX = /ListenAndServe(?:TLS)?\s*\(\s*['"`]([^'"`:]*):/g;
const PY_RUN_HOST_REGEX = /\.run\s*\([^)]*host\s*=\s*['"](?:127\.0\.0\.1|localhost)['"]/;
const GUNICORN_CONF_BIND_REGEX = /^\s*bind\s*=\s*['"](?:127\.0\.0\.1|localhost):/m;
const COMMAND_HOST_FLAG_REGEX = /(?:--host(?:name)?[=\s]+|-H\s+|-b\s+|--bind[=\s]+)['"]?(127\.0\.0\.1|localhost|0\.0\.0\.0|::)(?=[\s:'"]|$)/;
const DOCKERFILE_ENV_HOST_REGEX = /^\s*ENV\s+(?:HOST|HOSTNAME|BIND_ADDRESS)[=\s]+["']?(127\.0\.0\.1|localhost|0\.0\.0\.0)\b/m;
const LOOPBACK_BY_DEFAULT_REGEX = /(?:^|\s)(?:uvicorn|flask\s+run)(?:\s|$)(?![^\n]*(?:--host|-h\s))/;
const PROCFILE_REGEX = /(?:^|\/)Procfile$/;

/** `["uvicorn", "main:app"]` (Dockerfile exec form) → `uvicorn main:app`. */
function execFormToShell(command: string): string {
  const trimmed = command.trim();
  if (!trimmed.startsWith('[')) return trimmed;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) && parsed.every((part) => typeof part === 'string') ? parsed.join(' ') : trimmed;
  } catch {
    return trimmed;
  }
}

/** The commands the container starts with, from the sources that decide production. */
function startCommandTexts(tree: FileTree): { file: string; text: string }[] {
  const texts: { file: string; text: string }[] = [];
  const dockerfile = selectedDockerfile(tree);
  if (dockerfile) {
    for (const regex of [CMD_REGEX, ENTRYPOINT_REGEX]) {
      const match = regex.exec(dockerfile.content);
      if (match?.[1]) texts.push({ file: dockerfile.path, text: execFormToShell(match[1]) });
    }
  }
  for (const [path, content] of Object.entries(tree)) {
    if (!PROCFILE_REGEX.test(path) || !content || !isRuntimeSourcePath(path)) continue;
    const web = /^web:\s*(.+)$/m.exec(content);
    if (web?.[1]) texts.push({ file: path, text: web[1] });
  }
  for (const [name, command, dir] of collectScriptsWithDir(tree)) {
    if (name === 'start') texts.push({ file: dir === '.' ? 'package.json' : `${dir}/package.json`, text: command });
  }
  return texts;
}

/**
 * Detect whether the server binds only to a loopback address. A container
 * that listens on 127.0.0.1/localhost never receives load-balancer traffic,
 * so the health check fails and the deployment never becomes healthy. Only
 * evidence that decides production counts: the selected Dockerfile's
 * CMD/ENTRYPOINT/ENV, a Procfile `web:` line, the `start` script, and
 * runtime source — never a dev script or a sample env file.
 */
export function detectBindAddress(tree: FileTree): DetectorFinding {
  const loopback: string[] = [];
  const allInterfaces: string[] = [];

  const dockerfile = selectedDockerfile(tree);
  const envHost = dockerfile ? DOCKERFILE_ENV_HOST_REGEX.exec(dockerfile.content) : null;
  if (dockerfile && envHost?.[1]) {
    (LOOPBACK_HOST.test(envHost[1]) ? loopback : allInterfaces).push(`${envHost[0].trim()} (${dockerfile.path})`);
  }

  for (const { file, text } of startCommandTexts(tree)) {
    const flag = COMMAND_HOST_FLAG_REGEX.exec(text);
    if (flag?.[1]) {
      (LOOPBACK_HOST.test(flag[1]) ? loopback : allInterfaces).push(`${text.trim()} (${file})`);
    } else if (LOOPBACK_BY_DEFAULT_REGEX.test(text)) {
      // uvicorn and `flask run` bind 127.0.0.1 when no host is given.
      loopback.push(`${text.trim()} binds 127.0.0.1 by default (${file})`);
    }
  }

  for (const [path, content] of Object.entries(tree)) {
    if (!content || !isRuntimeSourcePath(path)) continue;
    if (JS_SOURCE.test(path)) {
      for (const match of content.matchAll(LISTEN_CALL_REGEX)) {
        const args = match[1] ?? '';
        if (LOOPBACK_LITERAL.test(args)) loopback.push(`listen(${args.trim()}) (${path})`);
        else if (ALL_INTERFACES_LITERAL.test(args)) allInterfaces.push(`listen(${args.trim()}) (${path})`);
      }
    } else if (PY_SOURCE.test(path)) {
      if (PY_RUN_HOST_REGEX.test(content)) loopback.push(`server host set to a loopback address (${path})`);
      if (/gunicorn/i.test(path) && GUNICORN_CONF_BIND_REGEX.test(content)) {
        loopback.push(`gunicorn bind on a loopback address (${path})`);
      }
    } else if (GO_SOURCE.test(path)) {
      for (const match of content.matchAll(LISTEN_AND_SERVE_REGEX)) {
        const host = match[1] ?? '';
        if (LOOPBACK_HOST.test(host)) loopback.push(`ListenAndServe("${host}:…") (${path})`);
      }
    }
  }

  if (loopback.length > 0) {
    return {
      detector: 'bind-address',
      detected: true,
      value: 'localhost',
      details: `Server binds only to a loopback address: ${loopback.join('; ')}`,
      source: 'source',
    };
  }
  if (allInterfaces.length > 0) {
    return {
      detector: 'bind-address',
      detected: false,
      value: 'all-interfaces',
      details: `Server binds to all interfaces: ${allInterfaces.join('; ')}`,
      source: 'source',
    };
  }
  return { detector: 'bind-address', detected: false };
}
