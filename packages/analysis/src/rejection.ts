/**
 * §10 rejection classes — detect UNSUPPORTED dependencies that make an app
 * "Not currently compatible" with Deployz.
 *
 * Each rejection check is a pure function: `(tree: FileTree) => RejectionFinding`.
 * No AI, no network, no side effects.
 */

import type { FileTree } from './detectors.js';
import { collectDependencyNames } from './detectors.js';

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
  const deps = collectDependencyNames(tree);
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
  const deps = collectDependencyNames(tree);

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
  const deps = collectDependencyNames(tree);
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
  const deps = collectDependencyNames(tree);
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
  const deps = collectDependencyNames(tree);
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