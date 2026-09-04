/**
 * §10 rejection classes — detect UNSUPPORTED dependencies that make an app
 * "Not currently compatible" with Deployz.
 *
 * Each rejection check is a pure function: `(tree: FileTree) => RejectionFinding`.
 * No AI, no network, no side effects.
 */

import type { FileTree } from './detectors.js';
import {
  collectDependencyNames,
  composeApplicationServices,
  composeServices,
  detectEnvVarModel,
  detectPostgresql,
  isRuntimeSourcePath,
  listDockerfileCandidates,
} from './detectors.js';
import type { RedisRequirement } from './redis.js';
import { assessRedis } from './redis.js';

/**
 * The §10 database rejection tokens — a rejection with one of these
 * dependencies is an UNSUPPORTED DATABASE (drives `databaseState`), as
 * opposed to an unsupported architecture/cache/cloud (§11.4) which drives the
 * verdict through the architecture findings instead.
 */
export const DATABASE_REJECTION_TOKENS = new Set<string>([
  'mysql',
  'mysql2',
  'mariadb',
  'mongoose',
  'mongodb',
  'mongodb-client',
  '@elastic/elasticsearch',
  '@opensearch-project/opensearch',
  'cassandra-driver',
  'neo4j-driver',
  'sqlite',
]);

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
 * A SQL-engine driver next to a PostgreSQL driver means the engine is a
 * configuration choice (kutt's `DB_CLIENT`, gatus' storage type), not an
 * architectural requirement — the app runs on the PostgreSQL Deployz
 * provisions. Only a lone driver, or an explicit non-PostgreSQL Prisma
 * provider / connection URL, proves the unsupported engine is the one in
 * use (Stage A COMP-002).
 */
function engineIsConfigurable(tree: FileTree): boolean {
  // Only a PostgreSQL-specific driver counts: `knex`/`drizzle-orm` are
  // dialect-agnostic and prove nothing about which engine is wired up.
  const drivers = detectPostgresql(tree).value;
  return Array.isArray(drivers) && drivers.some((driver) => !DIALECT_AGNOSTIC_DRIVERS.has(driver));
}

const DIALECT_AGNOSTIC_DRIVERS = new Set(['knex', 'drizzle-orm']);

/**
 * Check for MySQL dependencies (unsupported — Deployz uses PostgreSQL only).
 */
export function checkMysql(tree: FileTree): RejectionFinding {
  const deps = collectDependencyNames(tree);

  for (const dep of MYSQL_DEPS) {
    if (deps.includes(dep) && !engineIsConfigurable(tree)) {
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

/**
 * A database CLIENT dependency proves the app can talk to that database, not
 * that it stores its own data there — an automation platform, a secrets
 * manager or a BI tool ships the MongoDB, Elasticsearch and Cassandra
 * clients it connects customers' databases with. The rejection needs the
 * same corroboration a broker client needs (Stage A COMP-002, COMP-032):
 * a service running that database in the production Compose file, a
 * connection variable the app reads without a fallback, or (MongoDB) the
 * app's own data model on it.
 */
function databaseCorroboration(
  tree: FileTree,
  imageRegex: RegExp,
  envRegex: RegExp,
  modelRegex: RegExp | null,
): string | null {
  const compose = composeServices(tree);
  const service = compose?.services.find((s) => !s.optional && s.image && imageRegex.test(s.image));
  if (compose && service) return `a ${service.name} service is defined in ${compose.file}`;
  const key = brokerConnectionRequired(tree, envRegex);
  if (key) return `${key} is required`;
  if (modelRegex) {
    const model = Object.entries(tree).find(
      ([path, content]) => /\.(?:ts|js|mjs|cjs)$/.test(path) && isRuntimeSourcePath(path) && !!content && modelRegex.test(content),
    );
    if (model) return `the app defines its data model on it in ${model[0]}`;
  }
  return null;
}

/** MongoDB: mongoose, mongodb, mongodb-client */
const MONGO_DEPS = ['mongoose', 'mongodb', 'mongodb-client'] as const;
const MONGO_ENV_REGEX = /^MONGO(?:DB)?_(?:URI|URL|HOST|CONNECTION_STRING)$/;
const MONGOOSE_MODEL_REGEX = /mongoose\.model\s*\(|new\s+(?:mongoose\.)?Schema\s*\(/;

/**
 * Check for a MongoDB dependency the app stores its data in (unsupported —
 * Deployz uses PostgreSQL only).
 */
export function checkMongo(tree: FileTree): RejectionFinding {
  const deps = collectDependencyNames(tree);
  for (const dep of MONGO_DEPS) {
    if (!deps.includes(dep)) continue;
    const prisma = Object.entries(tree).find(([p]) => /schema\.prisma$/i.test(p))?.[1];
    const corroboration =
      prisma && /provider\s*=\s*"mongodb"/i.test(prisma)
        ? 'Prisma is configured with the MongoDB provider'
        : databaseCorroboration(tree, /mongo/i, MONGO_ENV_REGEX, dep === 'mongoose' ? MONGOOSE_MODEL_REGEX : null);
    if (corroboration) {
      return {
        detected: true,
        dependency: dep,
        reason: `Unsupported database dependency: ${dep}, and ${corroboration}. Deployz does not support MongoDB. Use PostgreSQL.`,
      };
    }
  }
  return { detected: false, dependency: 'none', reason: 'No MongoDB dependency detected' };
}

/** Elasticsearch / OpenSearch: @elastic/elasticsearch, @opensearch-project/opensearch */
const ES_DEPS = ['@elastic/elasticsearch', '@opensearch-project/opensearch'] as const;
const ES_ENV_REGEX = /^(?:ELASTIC(?:SEARCH)?_(?:URL|URI|HOSTS?|NODE|NODES)|ES_(?:URL|HOSTS?|NODE)|OPENSEARCH_(?:URL|HOSTS?|NODE))$/;

/**
 * Check for an Elasticsearch or OpenSearch dependency the app requires (unsupported).
 */
export function checkElasticsearch(tree: FileTree): RejectionFinding {
  const deps = collectDependencyNames(tree);
  for (const dep of ES_DEPS) {
    if (!deps.includes(dep)) continue;
    const corroboration = databaseCorroboration(tree, /elasticsearch|opensearch/i, ES_ENV_REGEX, null);
    if (corroboration) {
      return {
        detected: true,
        dependency: dep,
        reason: `Unsupported search engine: ${dep}, and ${corroboration}. Deployz does not support Elasticsearch/OpenSearch.`,
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
const OTHER_DB_ENV_REGEX = /^(?:CASSANDRA_(?:HOSTS?|CONTACT_POINTS|URL)|NEO4J_(?:URI|URL|HOST))$/;

/**
 * Check for other unsupported database drivers (Cassandra, Neo4j, etc.) the app requires.
 */
export function checkOtherUnsupportedDatabases(tree: FileTree): RejectionFinding {
  const deps = collectDependencyNames(tree);
  for (const dep of OTHER_UNSUPPORTED_DB_DEPS) {
    if (!deps.includes(dep)) continue;
    const corroboration = databaseCorroboration(tree, /cassandra|scylla|neo4j/i, OTHER_DB_ENV_REGEX, null);
    if (corroboration) {
      return {
        detected: true,
        dependency: dep,
        reason: `Unsupported database driver: ${dep}, and ${corroboration}. Deployz does not support this database.`,
      };
    }
  }
  return {
    detected: false,
    dependency: 'none',
    reason: 'No unsupported database driver detected',
  };
}

// ── §11.4 architecture rejection checks ─────────────────────────────────────
// Each check detects one class of infrastructure Deployz does NOT host or
// manage. Every check is deliberately narrow (files/dependencies that can
// ONLY mean that infrastructure), so a passing repository is never blocked by
// a README mention or a dev-only helper.

function filePathsMatching(tree: FileTree, pathRegex: RegExp): string[] {
  return Object.keys(tree).filter((p) => pathRegex.test(p));
}

function contentMatches(tree: FileTree, pathRegex: RegExp, contentRegex: RegExp): string[] {
  return Object.keys(tree).filter((p) => pathRegex.test(p) && !!tree[p] && contentRegex.test(tree[p]));
}

/** Production SQLite (embedded file DB): Node drivers, Prisma provider, Go driver, sqlite:// URLs. */
export function checkSqlite(tree: FileTree): RejectionFinding {
  const deps = collectDependencyNames(tree);
  const configurable = engineIsConfigurable(tree);
  for (const dep of ['better-sqlite3', 'sqlite3'] as const) {
    if (deps.includes(dep) && !configurable) {
      return {
        detected: true,
        dependency: 'sqlite',
        reason: `Unsupported database: SQLite driver ${dep}. Deployz hosts PostgreSQL only; an embedded file database does not survive in the container model.`,
      };
    }
  }
  const prisma = Object.entries(tree).find(([p]) => /schema\.prisma$/i.test(p))?.[1];
  if (prisma && /provider\s*=\s*"sqlite"/i.test(prisma)) {
    return {
      detected: true,
      dependency: 'sqlite',
      reason: 'Unsupported database: Prisma configured with the SQLite provider. Deployz hosts PostgreSQL only.',
    };
  }
  if (!configurable && contentMatches(tree, /(?:^|\/)go\.mod$/, /modernc\.org\/sqlite|mattn\/go-sqlite3/).length > 0) {
    return {
      detected: true,
      dependency: 'sqlite',
      reason: 'Unsupported database: a Go SQLite driver is declared in go.mod. Deployz hosts PostgreSQL only.',
    };
  }
  // A SQLite connection URL next to a PostgreSQL driver is the default of a
  // configurable engine (wallabag's `DATABASE_URL=sqlite://…` sample).
  for (const [path, content] of Object.entries(tree)) {
    if (!configurable && content && /sqlite3?:\/\/|\.db\s*=|\.sqlite\b/.test(content)) {
      const envPath = /^\.env(\.\w+)?$/i.test(path);
      const codePath = /\.(py|rb|ts|js|go)$/.test(path);
      if ((envPath || codePath) && /DATABASE_URL\s*[=:]\s*["']?sqlite/.test(content)) {
        return {
          detected: true,
          dependency: 'sqlite',
          reason: `Unsupported database: a SQLite database URL is configured in ${path}. Deployz hosts PostgreSQL only.`,
        };
      }
    }
  }
  return { detected: false, dependency: 'none', reason: 'No SQLite database detected' };
}

/**
 * A message-broker client dependency proves the app CAN talk to a broker,
 * not that it needs one — umami ships kafkajs behind `KAFKA_URL`, uptime-kuma
 * ships it as a monitor target. The rejection needs corroboration: a broker
 * service in the production Compose file, or a connection variable the app
 * reads without a fallback (Stage A COMP-002).
 */
function brokerConnectionRequired(tree: FileTree, keyPattern: RegExp): string | null {
  const required = detectEnvVarModel(tree).filter((variable) => variable.required && keyPattern.test(variable.key));
  // A presence test (`if (process.env.KAFKA_URL)`, `Boolean(process.env.
  // KAFKA_URL && …)`, `enabled = process.env.KAFKA_URL && …`) makes the
  // broker a feature the app switches on, whatever the reads inside the
  // enabled path look like — but only when EVERY file that reads the
  // variable tests it; an unconditional consumer elsewhere still requires it.
  return required.find((variable) => !readsArePresenceGuarded(tree, variable.key, variable.source))?.key ?? null;
}

function readsArePresenceGuarded(tree: FileTree, key: string, source: readonly string[]): boolean {
  const read = `(?:process\\.env\\.|env\\.|os\\.environ\\.get\\(["'])?${key}\\b`;
  const guard = new RegExp(`if\\s*\\(\\s*!?\\s*${read}|(?:Boolean\\s*\\(|!!)\\s*${read}|${read}\\s*&&|&&\\s*${read}`);
  const readFiles = source.filter((entry) => entry.startsWith('read in ')).map((entry) => entry.slice('read in '.length));
  return readFiles.length > 0 && readFiles.every((path) => guard.test(tree[path] ?? ''));
}

// Connection variables only — a tuning knob such as KAFKA_MAX_MESSAGE_BYTES
// says nothing about whether a broker must exist.
const KAFKA_ENV_REGEX = /^KAFKA_(?:URL|BROKERS?|BOOTSTRAP_SERVERS|HOSTS?)$/;
const RABBITMQ_ENV_REGEX = /^(?:RABBITMQ_(?:URL|HOST)|AMQP_URL|CLOUDAMQP_URL)$/;

/** Kafka: clients/consumers + Kafka/Confluent images in compose. */
export function checkKafka(tree: FileTree): RejectionFinding {
  const compose = composeServices(tree);
  if (compose?.services.some((s) => s.image && /kafka|confluentinc/i.test(s.image))) {
    return { detected: true, dependency: 'kafka', reason: `Unsupported infrastructure: a Kafka service is defined in ${compose.file}.` };
  }

  let client: string | null = null;
  const deps = collectDependencyNames(tree);
  for (const dep of ['kafkajs', 'kafka-node', 'node-rdkafka'] as const) {
    if (deps.includes(dep)) client = `Kafka client ${dep}`;
  }
  for (const [path, content] of Object.entries(tree)) {
    if (!content || client) break;
    if (/(?:^|\/)requirements(?:[^/]*)\.txt$/.test(path) && /^confluent-kafka|^kafka-python|^aiokafka/m.test(content)) {
      client = `a Kafka client declared in ${path}`;
    } else if (/(?:^|\/)pyproject\.toml$/.test(path) && /(?:confluent-kafka|kafka-python|aiokafka)/.test(content)) {
      client = `a Kafka client declared in ${path}`;
    } else if (/(?:^|\/)go\.mod$/.test(path) && /(?:segmentio\/kafka-go|confluent-kafka-go|Shopify\/sarama)/.test(content)) {
      client = `a Kafka client declared in ${path}`;
    } else if (/(?:^|\/)Gemfile$/.test(path) && /ruby-kafka|racecar/.test(content)) {
      client = `a Kafka client declared in ${path}`;
    }
  }
  if (client) {
    const key = brokerConnectionRequired(tree, KAFKA_ENV_REGEX);
    if (key) {
      return {
        detected: true,
        dependency: 'kafka',
        reason: `Unsupported infrastructure: ${client}, and ${key} is required. Deployz does not host Kafka; the app would need a cluster Deployz cannot provision.`,
      };
    }
  }
  return { detected: false, dependency: 'none', reason: 'No Kafka infrastructure detected' };
}

/** RabbitMQ: AMQP clients + rabbitmq images in compose. */
export function checkRabbitMq(tree: FileTree): RejectionFinding {
  const compose = composeServices(tree);
  if (compose?.services.some((s) => s.image && /rabbitmq/i.test(s.image))) {
    return { detected: true, dependency: 'rabbitmq', reason: `Unsupported infrastructure: a RabbitMQ service is defined in ${compose.file}.` };
  }

  let client: string | null = null;
  const deps = collectDependencyNames(tree);
  for (const dep of ['amqplib', 'amqp-connection-manager', 'bunnymq', 'rascal'] as const) {
    if (deps.includes(dep)) client = `RabbitMQ client ${dep}`;
  }
  for (const [path, content] of Object.entries(tree)) {
    if (!content || client) break;
    if (/(?:^|\/)requirements(?:[^/]*)\.txt$/.test(path) && /^pika|^aio-pika|^kombu/m.test(content)) {
      client = `a RabbitMQ client declared in ${path}`;
    } else if (/(?:^|\/)pyproject\.toml$/.test(path) && /(?:^|["'\s])(?:pika|aio-pika|kombu)(?:["'\s]|$)/.test(content)) {
      client = `a RabbitMQ client declared in ${path}`;
    } else if (/(?:^|\/)Gemfile$/.test(path) && /^gem\s+['"]bunny['"]/m.test(content)) {
      client = `a RabbitMQ client declared in ${path}`;
    }
  }
  if (client) {
    const key = brokerConnectionRequired(tree, RABBITMQ_ENV_REGEX);
    if (key) {
      return {
        detected: true,
        dependency: 'rabbitmq',
        reason: `Unsupported infrastructure: ${client}, and ${key} is required. Deployz does not host RabbitMQ.`,
      };
    }
  }
  return { detected: false, dependency: 'none', reason: 'No RabbitMQ infrastructure detected' };
}

/** Complex SQS/event-driven consumption — the app is an event consumer, not a request-driven container. */
export function checkSqsEventArchitecture(tree: FileTree): RejectionFinding {
  const deps = collectDependencyNames(tree);
  const hasSqsSdk = deps.includes('@aws-sdk/client-sqs') || deps.includes('aws-sdk');
  if (!hasSqsSdk) {
    for (const [path, content] of Object.entries(tree)) {
      if (!content) continue;
      if (/(?:^|\/)requirements(?:[^/]*)\.txt$/.test(path) && /^boto3/m.test(content)) {
        if (contentMatches(tree, /\.py$/, /sqs\.receive_message|get_queue_url/).length > 0) {
          return { detected: true, dependency: 'sqs-event-consumer', reason: `Unsupported architecture: the app consumes from an SQS queue (${path}); Deployz provisions no event infrastructure.` };
        }
      }
    }
    return { detected: false, dependency: 'none', reason: 'No SQS consumer architecture detected' };
  }
  for (const [path, content] of Object.entries(tree)) {
    if (!content) continue;
    if (/\.(ts|js|mjs|cjs)$/.test(path) && /(?:SQSClient\s*\(|new\s+SQS\b|\.receiveMessage\s*\(|ReceiveMessageCommand)/.test(content)) {
      return {
        detected: true,
        dependency: 'sqs-event-consumer',
        reason: `Unsupported architecture: the app consumes from an SQS queue (${path}); Deployz provisions no event infrastructure.`,
      };
    }
  }
  return { detected: false, dependency: 'none', reason: 'No SQS consumer architecture detected' };
}

/** Kubernetes: kustomize/Helm/manifests. */
export function checkKubernetes(tree: FileTree): RejectionFinding {
  const kustomize = filePathsMatching(tree, /(?:^|\/)kustomization\.ya?ml$/i);
  const helm = filePathsMatching(tree, /(?:^|\/)Chart\.ya?ml$|(?:^|\/)helmfile\.ya?ml$/i);
  const manifests = contentMatches(
    tree,
    /\.ya?ml$/,
    /^apiVersion:\s*apps\/v1\s*$[\s\S]*?^kind:\s*Deployment\s*$/m,
  );
  if (kustomize.length > 0 || helm.length > 0 || manifests.length > 0) {
    const evidence = [...kustomize, ...helm, ...manifests].slice(0, 3).join(', ');
    return {
      detected: true,
      dependency: 'kubernetes',
      reason: `Unsupported architecture: Kubernetes manifests are present (${evidence}). Deployz runs the app as a single container, not on a Kubernetes cluster.`,
    };
  }
  return { detected: false, dependency: 'none', reason: 'No Kubernetes manifests detected' };
}

/** Serverless / SAM: serverless.yml, SAM template.yaml, samconfig.toml. */
export function checkServerless(tree: FileTree): RejectionFinding {
  const serverless = filePathsMatching(tree, /(?:^|\/)serverless\.ya?ml$/i);
  const sam = contentMatches(tree, /(?:^|\/)template\.ya?ml$/i, /Transform:\s*AWS::Serverless/);
  const samConfig = filePathsMatching(tree, /(?:^|\/)samconfig\.toml$/);
  const serverlessDir = filePathsMatching(tree, /(?:^|\/)serverless\/.*\.ya?ml$/);
  if (serverless.length > 0 || sam.length > 0 || samConfig.length > 0 || serverlessDir.length > 0) {
    const evidence = [...serverless, ...sam, ...samConfig, ...serverlessDir].slice(0, 3).join(', ');
    return {
      detected: true,
      dependency: 'serverless',
      reason: `Unsupported architecture: a serverless configuration is present (${evidence}). Deployz runs containers, not functions.`,
    };
  }
  return { detected: false, dependency: 'none', reason: 'No serverless configuration detected' };
}

/** Docker Compose defining TWO OR MORE application services — a multi-service app, not one container. */
export function checkDockerComposeMultiService(tree: FileTree): RejectionFinding {
  const compose = composeApplicationServices(tree);
  if (!compose || compose.services.length === 0) {
    return { detected: false, dependency: 'none', reason: 'No multi-service compose app detected' };
  }
  const appServices = compose.services;
  if (appServices.length >= 2) {
    return {
      detected: true,
      dependency: 'docker-compose-multi-service',
      reason: `Unsupported architecture: ${compose.file} defines ${appServices.length} application services (${appServices.map((s) => s.name).join(', ')}). Deployz runs ONE application container per deployment.`,
    };
  }
  return { detected: false, dependency: 'none', reason: 'No multi-service compose app detected' };
}

/** Persistent volumes: k8s PVCs, Terraform EFS/EBS, compose named volumes referenced by an app service. */
export function checkPersistentVolumes(tree: FileTree): RejectionFinding {
  const pvc = contentMatches(tree, /\.ya?ml$/, /^kind:\s*PersistentVolumeClaim\s*$/m);
  if (pvc.length > 0) {
    return {
      detected: true,
      dependency: 'persistent-volume',
      reason: `Unsupported infrastructure: a Kubernetes persistent volume claim is declared (${pvc[0]}). Deployz provides object storage, not attachable volumes.`,
    };
  }
  const iac = contentMatches(tree, /\.tf$/, /aws_efs_file_system|aws_ebs_volume|aws_fsx/);
  if (iac.length > 0) {
    return {
      detected: true,
      dependency: 'persistent-volume',
      reason: `Unsupported infrastructure: a Terraform-managed persistent volume is declared (${iac[0]}).`,
    };
  }
  const compose = composeServices(tree);
  if (compose) {
    const content = tree[compose.file] ?? '';
    if (/^volumes:\s*$[\s\S]*?^\s{2}\w/.test(content)) {
      return {
        detected: true,
        dependency: 'persistent-volume',
        reason: `Unsupported storage: ${compose.file} declares named volumes. Deployz runs stateless containers with object storage for persistence.`,
      };
    }
  }
  return { detected: false, dependency: 'none', reason: 'No persistent volume declaration detected' };
}

/** Terraform IaC. */
export function checkTerraform(tree: FileTree): RejectionFinding {
  const files = filePathsMatching(tree, /\.tf$/).concat(
    filePathsMatching(tree, /(?:^|\/)(?:\.terraform(?:\.lock)?\.hcl|terraform\.tfstate(?:\.backup)?|\.terraform\/)/),
  );
  if (files.length > 0) {
    return {
      detected: true,
      dependency: 'terraform',
      reason: `Unsupported infrastructure: Terraform configuration is present (${files.slice(0, 3).join(', ')}). Deployz provisions infrastructure itself and cannot run alongside customer IaC.`,
    };
  }
  return { detected: false, dependency: 'none', reason: 'No Terraform configuration detected' };
}

/** Pulumi IaC. */
export function checkPulumi(tree: FileTree): RejectionFinding {
  const config = filePathsMatching(tree, /(?:^|\/)Pulumi(?:\.\w+)?\.ya?ml$/);
  const deps = collectDependencyNames(tree).filter((d) => d.startsWith('@pulumi/'));
  if (config.length > 0 || deps.length > 0) {
    const evidence = config.length > 0 ? config[0] : deps[0];
    return {
      detected: true,
      dependency: 'pulumi',
      reason: `Unsupported infrastructure: Pulumi is present (${evidence}). Deployz provisions infrastructure itself and cannot run alongside customer IaC.`,
    };
  }
  return { detected: false, dependency: 'none', reason: 'No Pulumi configuration detected' };
}

/** Customer CloudFormation (non-SAM templates the repo ships to deploy its own AWS infra). */
export function checkCloudFormation(tree: FileTree): RejectionFinding {
  // A SAM template carries AWSTemplateFormatVersion too, but it is already its
  // own rejection (checkServerless) — do not double-report it as raw CFN.
  const cfn = contentMatches(tree, /\.(ya?ml|json)$/, /AWSTemplateFormatVersion:/).filter(
    (p) => !/template\.ya?ml$/i.test(p),
  );
  const dir = filePathsMatching(tree, /(?:^|\/)cloudformation\//);
  if (cfn.length > 0 || dir.length > 0) {
    return {
      detected: true,
      dependency: 'cloudformation',
      reason: `Unsupported architecture: the repository ships its own CloudFormation template (${(cfn[0] ?? dir[0])}). Deployz owns the infrastructure for each deployment.`,
    };
  }
  return { detected: false, dependency: 'none', reason: 'No CloudFormation template detected' };
}

/**
 * Azure deployment files. A `@azure/*` package (e.g. an optional storage or
 * KMS SDK) is not evidence the app deploys TO Azure, so only files that
 * describe an Azure deployment pipeline or resource template count.
 */
export function checkAzure(tree: FileTree): RejectionFinding {
  const signals = filePathsMatching(
    tree,
    /(?:^|\/)azure-pipelines\.ya?ml$|(?:^|\/)azuredeploy(?:\.parameters)?\.json$|\.bicep$/,
  );
  if (signals.length > 0) {
    return {
      detected: true,
      dependency: 'azure',
      reason: `Unsupported cloud: an Azure deployment file is present (${signals[0]}). Deployz deploys to AWS.`,
    };
  }
  return { detected: false, dependency: 'none', reason: 'No Azure dependency detected' };
}

/**
 * GCP deployment files. A `@google-cloud/*` or `firebase-admin` package (e.g.
 * an optional KMS or storage client) is not evidence the app deploys TO GCP,
 * so only files that describe a GCP deployment target count.
 */
export function checkGcp(tree: FileTree): RejectionFinding {
  const appEngine = contentMatches(tree, /(?:^|\/)app\.ya?ml$/, /^runtime:\s*(?:nodejs|python|go|java|php)/m);
  const cloudBuild = filePathsMatching(tree, /(?:^|\/)cloudbuild\.ya?ml$|(?:^|\/)\.gcloudignore$/);
  // Google's distroless base images live on gcr.io and say nothing about
  // where the app deploys (Stage A COMP-008).
  const gcrBase = contentMatches(
    tree,
    /(?:^|\/)Dockerfile(?:\.[\w.-]+)?$/i,
    /^FROM\s+(?:[^/\s]+\/)?gcr\.io\/(?!distroless\/)/m,
  );
  if (appEngine.length > 0 || cloudBuild.length > 0 || gcrBase.length > 0) {
    const evidence = (appEngine[0] ?? cloudBuild[0] ?? gcrBase[0]) ?? '';
    return {
      detected: true,
      dependency: 'gcp',
      reason: `Unsupported cloud: a Google Cloud deployment file is present (${evidence}). Deployz deploys to AWS.`,
    };
  }
  return { detected: false, dependency: 'none', reason: 'No Google Cloud dependency detected' };
}

/** GPU requirements — the container needs a GPU Deployz does not provision. */
export function checkGpu(tree: FileTree): RejectionFinding {
  // Only the image Deployz would build counts — a `Dockerfile.transcribe.gpu`
  // variant next to the CPU image is an option, not a requirement (Stage A COMP-027).
  const selected = listDockerfileCandidates(tree)[0];
  const docker = selected && /nvidia\/cuda|cuda:|nvidia-smi|--gpus/.test(tree[selected] ?? '') ? [selected] : [];
  const python = contentMatches(tree, /(?:^|\/)(?:requirements(?:[^/]*)\.txt|pyproject\.toml)$/, /tensorflow-gpu|nvidia-|torch.*cuda|cuda.*torch/);
  if (docker.length > 0 || python.length > 0) {
    const evidence = (docker[0] ?? python[0]) ?? '';
    return {
      detected: true,
      dependency: 'gpu',
      reason: `Unsupported infrastructure: the app requires a GPU (${evidence}). Deployz runs CPU-only containers.`,
    };
  }
  return { detected: false, dependency: 'none', reason: 'No GPU requirement detected' };
}