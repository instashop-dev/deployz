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
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Safely parse a package.json file from the file tree. Returns null on parse failure or missing file. */
function parsePackageJson(tree: FileTree): Record<string, unknown> | null {
  const raw = tree['package.json'];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
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

const DOCKERFILE_REGEX = /^dockerfile$/i;

/**
 * Detect a Dockerfile (case-insensitive: `Dockerfile`, `dockerfile`, `Dockerfile.prod`, etc.).
 */
export function detectDockerfile(tree: FileTree): DetectorFinding {
  const match = findFiles(tree, DOCKERFILE_REGEX);
  if (match.length === 0) {
    return { detector: 'dockerfile', detected: false };
  }
  return {
    detector: 'dockerfile',
    detected: true,
    value: match[0],
    details: `Found ${match.length} Dockerfile(s): ${match.join(', ')}`,
  };
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
  const pkg = parsePackageJson(tree);
  if (!pkg) {
    return { detector: 'framework', detected: false };
  }
  const deps = getDependencyNames(pkg);
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
const HEALTH_ROUTE_REGEX = /(?:get|post|put|all|route)\s*\(.*['"`]\/health['"`]/i;
const HEALTH_HTTP_ADAPTER_REGEX = /\.getHttpAdapter\(\)\..*?['"`]\/health['"`]/;
const HEALTH_SCRIPT_REGEX = /^healthcheck$/i;

/**
 * Detect a health check endpoint from Dockerfile HEALTHCHECK, package.json scripts,
 * or route patterns in source code.
 */
export function detectHealthEndpoint(tree: FileTree): DetectorFinding {
  const sources: string[] = [];

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
  const pkg = parsePackageJson(tree);
  if (pkg) {
    const scripts = getScripts(pkg);
    for (const name of Object.keys(scripts)) {
      if (HEALTH_SCRIPT_REGEX.test(name)) {
        sources.push(`healthcheck (package.json script "${name}")`);
      }
    }
  }

  // 3. Route patterns in source code
  for (const [path, content] of Object.entries(tree)) {
    if (/\.(ts|js|mjs|cjs|jsx|tsx)$/.test(path)) {
      if (HEALTH_ROUTE_REGEX.test(content)) {
        sources.push(`/health route (${path})`);
      }
      if (HEALTH_HTTP_ADAPTER_REGEX.test(content)) {
        sources.push(`/health adapter (${path})`);
      }
    }
  }

  if (sources.length === 0) {
    return { detector: 'health-endpoint', detected: false };
  }

  return {
    detector: 'health-endpoint',
    detected: true,
    value: sources,
    details: `Health endpoint detected via: ${sources.join('; ')}`,
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
  const pkg = parsePackageJson(tree);
  const deps = getDependencyNames(pkg);

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

// 7. Local filesystem usage
// ---------------------------------------------------------------------------

const FS_PATTERNS: { pattern: RegExp; name: string }[] = [
  { pattern: /fs\.writeFileSync\b/, name: 'fs.writeFileSync' },
  { pattern: /fs\.writeFile\b/, name: 'fs.writeFile' },
  { pattern: /fs\.readFileSync\b/, name: 'fs.readFileSync' },
  { pattern: /fs\.readFile\b/, name: 'fs.readFile' },
  { pattern: /fs\.mkdirSync\b/, name: 'fs.mkdirSync' },
  { pattern: /fs\.mkdir\b/, name: 'fs.mkdir' },
  { pattern: /fs\.appendFileSync\b/, name: 'fs.appendFileSync' },
  { pattern: /fs\.appendFile\b/, name: 'fs.appendFile' },
];

/**
 * Detect local filesystem usage (fs.writeFile, fs.readFileSync, mkdirSync, etc.).
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
  const pkg = parsePackageJson(tree);
  const deps = getDependencyNames(pkg);
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
  const pkg = parsePackageJson(tree);
  const deps = getDependencyNames(pkg);
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
  const pkg = parsePackageJson(tree);
  if (!pkg) {
    return { detector: 'migration-command', detected: false };
  }

  const scripts = getScripts(pkg);
  const detected: string[] = [];

  for (const [, command] of Object.entries(scripts)) {
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
  const pkg = parsePackageJson(tree);
  if (pkg) {
    const scripts = getScripts(pkg);
    const startScript = scripts['start'];
    if (startScript) {
      sources.push(`start: ${startScript}`);
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
  const pkg = parsePackageJson(tree);
  const deps = getDependencyNames(pkg);
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