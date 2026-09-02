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

// ── §11.4 architecture rejection checks ─────────────────────────────────────
// Each check detects one class of infrastructure Deployz does NOT host or
// manage. Every check is deliberately narrow (files/dependencies that can
// ONLY mean that infrastructure), so a passing repository is never blocked by
// a README mention or a dev-only helper.

/** Infrastructure container images a docker-compose app sidecar is not "the app". */
const INFRA_COMPOSE_IMAGE_REGEX =
  /postgres|postgis|mysql|mariadb|mongo|redis|valkey|keydb|elasticsearch|opensearch|rabbitmq|kafka|minio|memcached|localstack|mailhog|clickhouse|dynamodb/i;

function filePathsMatching(tree: FileTree, pathRegex: RegExp): string[] {
  return Object.keys(tree).filter((p) => pathRegex.test(p));
}

function contentMatches(tree: FileTree, pathRegex: RegExp, contentRegex: RegExp): string[] {
  return Object.keys(tree).filter((p) => pathRegex.test(p) && !!tree[p] && contentRegex.test(tree[p]));
}

/**
 * Path segments that mark a compose file as dev/test/example tooling rather
 * than the app's own production deployment shape.
 */
const NON_PRODUCTION_COMPOSE_SEGMENT_REGEX =
  /(?:^|\/)(?:development|dev|test|testing|tests|e2e|ci|example|examples|sample|samples|local|\.devcontainer)(?:\/|$)/i;

/** Dev/override-flavoured compose filenames (docker-compose.dev.yml, etc.). */
const NON_PRODUCTION_COMPOSE_FILENAME_REGEX =
  /(?:docker-compose|compose)\.(?:dev|development|test|testing|override|local|example|sample|ci)\.ya?ml$/i;

function isProductionComposeFile(path: string): boolean {
  return !NON_PRODUCTION_COMPOSE_SEGMENT_REGEX.test(path) && !NON_PRODUCTION_COMPOSE_FILENAME_REGEX.test(path);
}

/**
 * Compose services: file → [{ name, image }]. Undefined when no compose file
 * describes the app's own production deployment — dev/test/example compose
 * files (e.g. `docker/development/compose.yml`, a mail sandbox or PDF
 * renderer for local tooling) are not evidence of the app's architecture.
 * Prefers a repository-root compose file over a nested one.
 */
function composeServices(tree: FileTree): { file: string; services: { name: string; image: string | null }[] } | null {
  const candidates = Object.keys(tree).filter(
    (p) => /(?:^|\/)(?:docker-compose|compose)\.ya?ml$/i.test(p) && isProductionComposeFile(p),
  );
  if (candidates.length === 0) return null;
  const path = candidates.find((p) => !p.includes('/')) ?? candidates[0]!;
  const content = tree[path] ?? '';
  const services: { name: string; image: string | null }[] = [];
  const lines = content.split('\n');
  let inServices = false;
  let current: { name: string; image: string | null } | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!inServices) {
      if (/^services:\s*$/.test(line)) inServices = true;
      continue;
    }
    const serviceHeader = /^ {2}([a-zA-Z0-9_-]+):\s*$/.exec(line);
    if (serviceHeader) {
      current = { name: serviceHeader[1]!, image: null };
      services.push(current);
      continue;
    }
    const imageLine = /^ {4}image:\s*["']?([^\s"']+)["']?/.exec(line);
    if (imageLine && current) current.image = imageLine[1] ?? null;
    // Back to a top-level section ends the services block.
    if (/^[a-zA-Z]/.test(line) && !/^ {2}/.test(line) && current) {
      inServices = false;
      current = null;
    }
  }
  return { file: path, services };
}

/** Production SQLite (embedded file DB): Node drivers, Prisma provider, Go driver, sqlite:// URLs. */
export function checkSqlite(tree: FileTree): RejectionFinding {
  const deps = collectDependencyNames(tree);
  for (const dep of ['better-sqlite3', 'sqlite3'] as const) {
    if (deps.includes(dep)) {
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
  if (contentMatches(tree, /(?:^|\/)go\.mod$/, /modernc\.org\/sqlite|mattn\/go-sqlite3/).length > 0) {
    return {
      detected: true,
      dependency: 'sqlite',
      reason: 'Unsupported database: a Go SQLite driver is declared in go.mod. Deployz hosts PostgreSQL only.',
    };
  }
  for (const [path, content] of Object.entries(tree)) {
    if (content && /sqlite3?:\/\/|\.db\s*=|\.sqlite\b/.test(content)) {
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

/** Kafka: clients/consumers + Kafka/Confluent images in compose. */
export function checkKafka(tree: FileTree): RejectionFinding {
  const deps = collectDependencyNames(tree);
  for (const dep of ['kafkajs', 'kafka-node', 'node-rdkafka'] as const) {
    if (deps.includes(dep)) {
      return {
        detected: true,
        dependency: 'kafka',
        reason: `Unsupported infrastructure: Kafka client ${dep}. Deployz does not host Kafka; the app would need a cluster Deployz cannot provision.`,
      };
    }
  }
  for (const [path, content] of Object.entries(tree)) {
    if (!content) continue;
    if (/(?:^|\/)requirements(?:[^/]*)\.txt$/.test(path) && /^confluent-kafka|^kafka-python|^aiokafka/m.test(content)) {
      return { detected: true, dependency: 'kafka', reason: `Unsupported infrastructure: a Kafka client is declared in ${path}.` };
    }
    if (/(?:^|\/)pyproject\.toml$/.test(path) && /(?:confluent-kafka|kafka-python|aiokafka)/.test(content)) {
      return { detected: true, dependency: 'kafka', reason: `Unsupported infrastructure: a Kafka client is declared in ${path}.` };
    }
    if (/(?:^|\/)go\.mod$/.test(path) && /(?:segmentio\/kafka-go|confluent-kafka-go|Shopify\/sarama)/.test(content)) {
      return { detected: true, dependency: 'kafka', reason: `Unsupported infrastructure: a Kafka client is declared in ${path}.` };
    }
    if (/(?:^|\/)Gemfile$/.test(path) && /ruby-kafka|racecar/.test(content)) {
      return { detected: true, dependency: 'kafka', reason: `Unsupported infrastructure: a Kafka client is declared in ${path}.` };
    }
  }
  const compose = composeServices(tree);
  if (compose?.services.some((s) => s.image && /kafka|confluentinc/i.test(s.image))) {
    return { detected: true, dependency: 'kafka', reason: `Unsupported infrastructure: a Kafka service is defined in ${compose.file}.` };
  }
  return { detected: false, dependency: 'none', reason: 'No Kafka infrastructure detected' };
}

/** RabbitMQ: AMQP clients + rabbitmq images in compose. */
export function checkRabbitMq(tree: FileTree): RejectionFinding {
  const deps = collectDependencyNames(tree);
  for (const dep of ['amqplib', 'amqp-connection-manager', 'bunnymq', 'rascal'] as const) {
    if (deps.includes(dep)) {
      return {
        detected: true,
        dependency: 'rabbitmq',
        reason: `Unsupported infrastructure: RabbitMQ client ${dep}. Deployz does not host RabbitMQ.`,
      };
    }
  }
  for (const [path, content] of Object.entries(tree)) {
    if (!content) continue;
    if (/(?:^|\/)requirements(?:[^/]*)\.txt$/.test(path) && /^pika|^aio-pika|^kombu/m.test(content)) {
      return { detected: true, dependency: 'rabbitmq', reason: `Unsupported infrastructure: a RabbitMQ client is declared in ${path}.` };
    }
    if (/(?:^|\/)pyproject\.toml$/.test(path) && /(?:^|["'\s])(?:pika|aio-pika|kombu)(?:["'\s]|$)/.test(content)) {
      return { detected: true, dependency: 'rabbitmq', reason: `Unsupported infrastructure: a RabbitMQ client is declared in ${path}.` };
    }
    if (/(?:^|\/)Gemfile$/.test(path) && /^gem\s+['"]bunny['"]/m.test(content)) {
      return { detected: true, dependency: 'rabbitmq', reason: `Unsupported infrastructure: a RabbitMQ client is declared in ${path}.` };
    }
  }
  const compose = composeServices(tree);
  if (compose?.services.some((s) => s.image && /rabbitmq/i.test(s.image))) {
    return { detected: true, dependency: 'rabbitmq', reason: `Unsupported infrastructure: a RabbitMQ service is defined in ${compose.file}.` };
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
  const compose = composeServices(tree);
  if (!compose || compose.services.length === 0) {
    return { detected: false, dependency: 'none', reason: 'No multi-service compose app detected' };
  }
  const appServices = compose.services.filter(
    (s) => !s.image || !INFRA_COMPOSE_IMAGE_REGEX.test(s.image),
  );
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
  const gcrBase = contentMatches(tree, /(?:^|\/)Dockerfile(?:\.[\w.-]+)?$/i, /^FROM\s+(?:[^/\s]+\/)?gcr\.io\//m);
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
  const docker = contentMatches(tree, /(?:^|\/)Dockerfile(?:\.[\w.-]+)?$/i, /nvidia\/cuda|cuda:|nvidia-smi|--gpus/);
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