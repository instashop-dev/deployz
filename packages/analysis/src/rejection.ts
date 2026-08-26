/**
 * §10 rejection classes — detect UNSUPPORTED dependencies that make an app
 * "Not currently compatible" with Deployz.
 *
 * Each rejection check is a pure function: `(tree: FileTree) => RejectionFinding`.
 * No AI, no network, no side effects.
 */

import type { FileTree } from './detectors.js';
import { collectDependencyNames } from './detectors.js';
import type { RedisRequirement } from './redis.js';
import { assessRedis } from './redis.js';

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

/**
 * Redis: standard, standalone Redis usage is a SUPPORTED managed dependency
 * (see `assessRedis` in ./redis.ts) and never rejects. Only Redis setups that
 * fall outside Deployz's managed profile — Redis Stack modules, cluster mode,
 * TLS (`rediss://`) — reject.
 *
 * `precomputed` lets `analyseRepo` share a single `assessRedis(tree)` call
 * with the `redis` detector finding and `buildMetadata`, instead of every
 * consumer re-running the (more expensive) full assessment. Direct callers
 * (e.g. tests) can simply omit it.
 */
export function checkRedisUnsupported(tree: FileTree, precomputed?: RedisRequirement): RejectionFinding {
  const assessment = precomputed ?? assessRedis(tree);
  const detected = assessment.evidence.length > 0 && !assessment.compatibility.supported;
  return {
    detected,
    dependency: 'redis-unsupported',
    reason: detected
      ? (assessment.compatibility.reason ?? 'Unsupported Redis configuration detected.')
      : 'No unsupported Redis configuration detected',
  };
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