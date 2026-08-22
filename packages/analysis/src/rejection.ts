/**
 * §10 rejection classes — detect UNSUPPORTED dependencies that make an app
 * "Not currently compatible" with Deployz.
 *
 * Each rejection check is a pure function: `(tree: FileTree) => RejectionFinding`.
 * No AI, no network, no side effects.
 */

import type { FileTree } from './detectors.js';

// ── Types ───────────────────────────────────────────────────────────────────

/** Result from a single rejection check. */
export interface RejectionFinding {
  /** Whether the unsupported dependency was detected. */
  detected: boolean;
  /** The specific dependency that triggered the rejection. */
  dependency: string;
  /** Human-readable reason for the rejection. */
  reason: string;
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

/** Check if a Prisma schema uses a specific provider. */
function prismaUsesProvider(tree: FileTree, provider: string): boolean {
  const content = Object.entries(tree).find(([p]) => /schema\.prisma$/i.test(p))?.[1];
  if (!content) return false;
  const regex = new RegExp(`provider\\s*=\\s*"${provider}"`, 'i');
  return regex.test(content);
}

// ── Rejection checks ────────────────────────────────────────────────────────

/** Redis: ioredis, redis, @redis/client */
const REDIS_DEPS = ['ioredis', 'redis', '@redis/client'] as const;

/**
 * Check for Redis dependencies (unsupported — Deployz uses ElastiCache PostgreSQL compatible only).
 */
export function checkRedis(tree: FileTree): RejectionFinding {
  const pkg = parsePackageJson(tree);
  const deps = getDependencyNames(pkg);
  for (const dep of REDIS_DEPS) {
    if (deps.includes(dep)) {
      return {
        detected: true,
        dependency: dep,
        reason: `Unsupported database dependency: ${dep}. Deployz does not support Redis.`,
      };
    }
  }
  return { detected: false, dependency: 'none', reason: 'No Redis dependency detected' };
}

/** MySQL: mysql2, mysql, @prisma/client with mysql provider */
const MYSQL_DEPS = ['mysql2', 'mysql'] as const;

/**
 * Check for MySQL dependencies (unsupported — Deployz uses PostgreSQL only).
 */
export function checkMysql(tree: FileTree): RejectionFinding {
  const pkg = parsePackageJson(tree);
  const deps = getDependencyNames(pkg);

  for (const dep of MYSQL_DEPS) {
    if (deps.includes(dep)) {
      return {
        detected: true,
        dependency: dep,
        reason: `Unsupported database dependency: ${dep}. Deployz does not support MySQL. Use PostgreSQL.`,
      };
    }
  }

  // Prisma with mysql provider
  if (deps.includes('@prisma/client') && prismaUsesProvider(tree, 'mysql')) {
    return {
      detected: true,
      dependency: '@prisma/client',
      reason: 'Unsupported database: Prisma configured with MySQL provider. Deployz requires PostgreSQL.',
    };
  }

  return { detected: false, dependency: 'none', reason: 'No MySQL dependency detected' };
}

/** MongoDB: mongoose, mongodb, mongodb-client */
const MONGO_DEPS = ['mongoose', 'mongodb', 'mongodb-client'] as const;

/**
 * Check for MongoDB dependencies (unsupported — Deployz uses PostgreSQL only).
 */
export function checkMongo(tree: FileTree): RejectionFinding {
  const pkg = parsePackageJson(tree);
  const deps = getDependencyNames(pkg);
  for (const dep of MONGO_DEPS) {
    if (deps.includes(dep)) {
      return {
        detected: true,
        dependency: dep,
        reason: `Unsupported database dependency: ${dep}. Deployz does not support MongoDB. Use PostgreSQL.`,
      };
    }
  }
  return { detected: false, dependency: 'none', reason: 'No MongoDB dependency detected' };
}

/** Elasticsearch / OpenSearch: @elastic/elasticsearch, @opensearch-project/opensearch */
const ES_DEPS = ['@elastic/elasticsearch', '@opensearch-project/opensearch'] as const;

/**
 * Check for Elasticsearch or OpenSearch dependencies (unsupported).
 */
export function checkElasticsearch(tree: FileTree): RejectionFinding {
  const pkg = parsePackageJson(tree);
  const deps = getDependencyNames(pkg);
  for (const dep of ES_DEPS) {
    if (deps.includes(dep)) {
      return {
        detected: true,
        dependency: dep,
        reason: `Unsupported search engine: ${dep}. Deployz does not support Elasticsearch/OpenSearch.`,
      };
    }
  }
  return {
    detected: false,
    dependency: 'none',
    reason: 'No Elasticsearch/OpenSearch dependency detected',
  };
}

/** Other unsupported databases: cassandra-driver, neo4j-driver */
const OTHER_UNSUPPORTED_DB_DEPS = ['cassandra-driver', 'neo4j-driver'] as const;

/**
 * Check for other unsupported database drivers (Cassandra, Neo4j, etc.).
 */
export function checkOtherUnsupportedDatabases(tree: FileTree): RejectionFinding {
  const pkg = parsePackageJson(tree);
  const deps = getDependencyNames(pkg);
  for (const dep of OTHER_UNSUPPORTED_DB_DEPS) {
    if (deps.includes(dep)) {
      return {
        detected: true,
        dependency: dep,
        reason: `Unsupported database driver: ${dep}. Deployz does not support this database.`,
      };
    }
  }
  return {
    detected: false,
    dependency: 'none',
    reason: 'No unsupported database driver detected',
  };
}