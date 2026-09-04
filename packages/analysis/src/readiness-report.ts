/**
 * Semantic readiness report — the MVP application-readiness model.
 *
 * Consumes the deterministic analyser output (post-AI-merge metadata) and
 * produces the structured report the readiness UI and the fix-instructions
 * generator consume: a semantic state (never a percentage), findings split
 * into REQUIRED vs RECOMMENDED, and the passed checks.
 *
 * Purely deterministic: same input → same report. The AI layer only ever
 * turns findings into implementation instructions (fix-instructions.ts) — it
 * can never add, remove, or resolve a finding.
 *
 * Classification policy:
 *   - REQUIRED + blocking: an architectural incompatibility (§10 rejections,
 *     persistent local filesystem). State becomes NEEDS_CHANGES.
 *   - REQUIRED + fixable: Deployz cannot deploy reliably without it
 *     (container setup, health check). State becomes ALMOST_READY.
 *   - RECOMMENDED: deployment can proceed, but reliability/configuration
 *     could improve (migrations for a detected database). Never blocks READY.
 *
 * A convention that is merely absent is NOT a finding: a repository with no
 * database gets no migration finding, and one with no worker-like code gets
 * no worker finding.
 *
 * Phase 8 boundary — background worker processes are deferred. An app with
 * worker-like code AND a resolved worker start command declares a second
 * process Deployz will not run, so it is REQUIRED + blocking (needs-adaptation).
 * Worker-like code WITHOUT a resolved start command stays RECOMMENDED
 * (background jobs must run inside the web process).
 */

import type { AnalysisResult } from './analyser.js';
import type { RejectionFinding } from './rejection.js';

// ── Types ───────────────────────────────────────────────────────────────────

/** Semantic readiness vocabulary. ANALYSIS_INCOMPLETE is derived at the API
 *  edge from `analysisStatus` — a stored report only ever holds the other
 *  three. */
export type ReadinessState = 'READY' | 'ALMOST_READY' | 'NEEDS_CHANGES' | 'ANALYSIS_INCOMPLETE';

export type FindingSeverity = 'required' | 'recommended';

/**
 * How sure the deterministic analyser is about a finding. `confirmed` —
 * definitive evidence; `likely` — strong signal but static analysis can miss
 * a real solution; `needs_confirmation` — the underlying requirement itself
 * is uncertain. The fix-instructions prompt tells the coding agent to verify
 * non-confirmed findings before changing anything.
 */
export type FindingConfidence = 'confirmed' | 'likely' | 'needs_confirmation';

/** One unresolved readiness finding, in UI-ready plain English. */
export interface ReadinessFinding {
  /** Stable machine id (e.g. 'container-setup'). */
  id: string;
  /** Coarse grouping (e.g. 'container', 'health', 'database'). */
  category: string;
  /** Short user-facing title, jargon-free. */
  title: string;
  severity: FindingSeverity;
  /**
   * True for architectural incompatibilities (unsupported database, local
   * filesystem persistence) that force NEEDS_CHANGES; false for fixable
   * required findings (ALMOST_READY).
   */
  blocking: boolean;
  /** One-sentence plain-English statement of the problem. */
  plainEnglishExplanation: string;
  /** Why Deployz needs this, in plain English. */
  whyItMatters: string;
  /** The technical evidence, for the collapsed details section. */
  technicalEvidence: string;
  /** What "fixed" looks like, phrased as a deployment outcome. */
  suggestedOutcome: string;
  confidence: FindingConfidence;
}

/** One passed check, for the collapsed "Passed checks" section. */
export interface PassedCheck {
  id: string;
  label: string;
}

/** The complete semantic readiness report persisted with each analysis. */
export interface ReadinessReport {
  state: Exclude<ReadinessState, 'ANALYSIS_INCOMPLETE'>;
  requiredCount: number;
  recommendedCount: number;
  /** One short, jargon-free explanation of the state. */
  summary: string;
  /** Unresolved findings only — required first, then recommended. */
  findings: ReadinessFinding[];
  passed: PassedCheck[];
}

/** Extra context the caller can resolve that the analyser output alone cannot. */
export interface ReadinessReportContext {
  /**
   * Whether a runnable worker start command resolved (the API resolves this
   * from package.json script keys). A resolved worker start command declares
   * a second process Deployz does not run, so worker-like code with one is a
   * blocking needs-adaptation finding; worker-like code without one is a
   * recommended finding.
   */
  workerCommandResolved?: boolean | undefined;
}

// ── Passed-check labels ─────────────────────────────────────────────────────

// Friendly, jargon-reduced labels for detectors whose positive detection is a
// passed check. Falls back to the detector's own `details` string for any
// future detector, so nothing silently drops out of the passed list.
const PASSED_LABELS: Partial<Record<string, string>> = {
  dockerfile: 'Container setup found',
  framework: 'Framework detected',
  port: 'Application port detected',
  'health-endpoint': 'Health check found',
  'env-vars': 'Environment variables detected',
  postgresql: 'PostgreSQL database detected — Deployz provides a managed database',
  redis: 'Redis detected — provisioned automatically on install',
  s3: 'Object storage usage detected',
  'migration-command': 'Database migration command found',
  'startup-command': 'Start command found',
  'external-services': 'External service integrations detected',
  'package-manager': 'Package manager detected',
  'build-command': 'Build command found',
};

// Detectors whose `detected: true` is a NEGATIVE signal and must never appear
// as a passed check (they surface as findings instead).
const NEGATIVE_SIGNAL_DETECTORS = new Set<string>(['local-filesystem']);

// `worker` is handled as a finding (blocking or recommended) — see the worker
// branch in the report builder. It is never a passed check.
const SEPARATELY_HANDLED_DETECTORS = new Set<string>(['worker']);

// ── Rejection findings (blocking) ───────────────────────────────────────────

interface RejectionCopy {
  id: string;
  category: string;
  title: string;
  plainEnglishExplanation: string;
  whyItMatters: string;
  suggestedOutcome: string;
}

const MYSQL_COPY: RejectionCopy = {
  id: 'unsupported-database-mysql',
  category: 'database',
  title: 'Your database needs a supported engine',
  plainEnglishExplanation:
    'This app uses MySQL, which Deployz cannot host. Deployz provides a managed PostgreSQL database.',
  whyItMatters:
    'Deployz provisions, connects, and backs up the database for every customer deployment. It can only do that for PostgreSQL.',
  suggestedOutcome:
    'Move the data layer to PostgreSQL, or remove the MySQL dependency if it is not actually used.',
};

const MONGO_COPY: RejectionCopy = {
  ...MYSQL_COPY,
  id: 'unsupported-database-mongo',
  plainEnglishExplanation:
    'This app uses MongoDB, which Deployz cannot host. Deployz provides a managed PostgreSQL database.',
  suggestedOutcome:
    'Move the data layer to PostgreSQL, or remove the MongoDB dependency if it is not actually used.',
};

const ELASTICSEARCH_COPY: RejectionCopy = {
  ...MYSQL_COPY,
  id: 'unsupported-database-elasticsearch',
  title: 'Your search engine needs a supported alternative',
  plainEnglishExplanation:
    'This app uses Elasticsearch or OpenSearch, which Deployz cannot host.',
  suggestedOutcome:
    'Replace the search engine with PostgreSQL full-text search, or remove the dependency if it is not actually used.',
};

const OTHER_DB_COPY: RejectionCopy = {
  ...MYSQL_COPY,
  id: 'unsupported-database-other',
  plainEnglishExplanation:
    'This app uses a database Deployz cannot host. Deployz provides a managed PostgreSQL database.',
  suggestedOutcome:
    'Move the data layer to PostgreSQL, or remove the unsupported dependency if it is not actually used.',
};

const SQLITE_COPY: RejectionCopy = {
  ...MYSQL_COPY,
  id: 'unsupported-database-sqlite',
  plainEnglishExplanation:
    'This app uses SQLite, a database stored in a file on the app server. Deployz cannot host it because app disks are wiped on every deploy.',
  whyItMatters:
    'Deployz provisions, connects, and backs up the database for every customer deployment, and it can only do that for a managed PostgreSQL database.',
  suggestedOutcome: 'Move the data layer to PostgreSQL.',
};

const REDIS_COPY: RejectionCopy = {
  id: 'unsupported-redis-setup',
  category: 'cache',
  title: "Your app uses Redis features Deployz can't provide",
  plainEnglishExplanation:
    'This app uses Redis features Deployz cannot provide (such as Redis Stack modules or cluster mode).',
  whyItMatters:
    'Deployz provisions a standard single-node Redis for each deployment. Features beyond that would fail at runtime.',
  suggestedOutcome:
    'Use a standard single-node Redis setup without Stack modules or cluster mode.',
};

/**
 * §11.4 architecture/cloud/queue families. Each stays deliberately generic in
 * the copy fields (jargon-free, §65) — the SPECIFIC reason with its file
 * evidence lives in the rejection's own `reason`, surfaced as the finding's
 * technical evidence.
 */
const ARCHITECTURE_COPY: RejectionCopy = {
  id: 'unsupported-architecture',
  category: 'architecture',
  title: 'Runs its own infrastructure',
  plainEnglishExplanation:
    'This app depends on infrastructure that Deployz does not host or manage (its own deployment tooling, cloud platform files, or cluster setup).',
  whyItMatters:
    'Deployz provisions one container per application with managed database, cache, and storage. Extra infrastructure the app expects would not exist at runtime.',
  suggestedOutcome:
    'Remove the third-party infrastructure and keep only the application code. Deployz provides the hosting, database, cache, and storage.',
};

const MESSAGE_QUEUE_COPY: RejectionCopy = {
  ...ARCHITECTURE_COPY,
  id: 'unsupported-message-queue',
  title: 'Relies on its own message queue',
  plainEnglishExplanation:
    'This app depends on a message queue or event bus that Deployz does not host (for example Kafka, RabbitMQ, or an AWS queue).',
  suggestedOutcome:
    'Replace the queue with background jobs that run inside the Deployz container, or remove the queue dependency if it is not actually used.',
};

const MULTI_SERVICE_COPY: RejectionCopy = {
  ...ARCHITECTURE_COPY,
  id: 'unsupported-multi-service',
  title: 'Runs as several services',
  plainEnglishExplanation:
    "This app's Docker Compose file starts more than one application container, but Deployz runs one container per deployment.",
  suggestedOutcome:
    'Run the app as a single container, or move the extra services out of the deployment.',
};

const STORAGE_COPY: RejectionCopy = {
  ...ARCHITECTURE_COPY,
  id: 'unsupported-persistent-volume',
  category: 'storage',
  title: 'Needs a persistent disk volume',
  plainEnglishExplanation:
    'This app expects a persistent disk volume that stays attached between restarts. Deployz runs apps on disks that are wiped on every deploy.',
  suggestedOutcome: 'Store persistent data in object storage instead of an attached disk.',
};

const GPU_COPY: RejectionCopy = {
  ...ARCHITECTURE_COPY,
  id: 'unsupported-gpu',
  title: 'Needs a graphics processor (GPU)',
  plainEnglishExplanation:
    'This app requires a graphics processor to run. Deployz runs apps on standard processors only.',
  suggestedOutcome:
    'Use a processor-only configuration, or move the graphics processing to a service that provides it.',
};

/** Maps a §10/§11 rejection `dependency` to its blocking-finding copy. */
function rejectionCopy(dependency: string): RejectionCopy {
  if (dependency === 'redis-unsupported') return REDIS_COPY;
  if (dependency === 'mysql' || dependency === 'mysql2' || dependency === 'mariadb' || dependency === '@prisma/client') {
    return MYSQL_COPY;
  }
  if (dependency === 'sqlite') return SQLITE_COPY;
  if (dependency === 'mongoose' || dependency === 'mongodb' || dependency === 'mongodb-client') {
    return MONGO_COPY;
  }
  if (dependency === '@elastic/elasticsearch' || dependency === '@opensearch-project/opensearch') {
    return ELASTICSEARCH_COPY;
  }
  if (dependency === 'kafka' || dependency === 'rabbitmq' || dependency === 'sqs-event-consumer') {
    return MESSAGE_QUEUE_COPY;
  }
  if (dependency === 'docker-compose-multi-service') return MULTI_SERVICE_COPY;
  if (dependency === 'persistent-volume') return STORAGE_COPY;
  if (dependency === 'gpu') return GPU_COPY;
  if (
    dependency === 'kubernetes' ||
    dependency === 'serverless' ||
    dependency === 'terraform' ||
    dependency === 'pulumi' ||
    dependency === 'cloudformation' ||
    dependency === 'azure' ||
    dependency === 'gcp'
  ) {
    return ARCHITECTURE_COPY;
  }
  return OTHER_DB_COPY;
}

function rejectionFinding(rejection: RejectionFinding): ReadinessFinding {
  const copy = rejectionCopy(rejection.dependency);
  return {
    id: copy.id,
    category: copy.category,
    title: copy.title,
    severity: 'required',
    blocking: true,
    plainEnglishExplanation: copy.plainEnglishExplanation,
    whyItMatters: copy.whyItMatters,
    technicalEvidence: rejection.reason,
    suggestedOutcome: copy.suggestedOutcome,
    confidence: 'confirmed',
  };
}

// ── Report builder ──────────────────────────────────────────────────────────

const STATE_SUMMARY: Record<ReadinessReport['state'], string> = {
  READY: 'This app can be deployed through Deployz.',
  ALMOST_READY:
    'Deployz found a few things to address before this app can be deployed reliably.',
  NEEDS_CHANGES: 'This app needs changes before Deployz can deploy it.',
};

/**
 * Build the semantic readiness report from an analysis result. `result`
 * should carry the MERGED (post-AI-fallback) metadata, so a start command or
 * migration command the AI resolved counts as resolved here too.
 */
export function buildReadinessReport(
  result: AnalysisResult,
  context: ReadinessReportContext = {},
): ReadinessReport {
  const metadata = result.metadata;
  const finding = (name: string) => result.findings.find((f) => f.detector === name);
  const findings: ReadinessFinding[] = [];

  // ── Blocking (reject-class) findings ──────────────────────────────────────
  for (const rejection of result.rejections) {
    if (rejection.detected) findings.push(rejectionFinding(rejection));
  }

  const localFs = finding('local-filesystem');
  if (localFs?.detected) {
    findings.push({
      id: 'local-file-storage',
      category: 'storage',
      title: 'Files stored on local disk',
      severity: 'required',
      blocking: true,
      plainEnglishExplanation:
        'This app writes files to its own disk, but Deployz runs apps on disks that are wiped on every deploy.',
      whyItMatters:
        'Anything written to local disk disappears when the app restarts or updates, so uploads and generated files would be lost.',
      technicalEvidence:
        localFs.details ??
        `Persistent local filesystem operations detected: ${String(localFs.value ?? '')}`,
      suggestedOutcome:
        'Store uploaded and persistent files in object storage instead of the local disk.',
      confidence: 'confirmed',
    });
  }

  // ── Required (fixable) findings ───────────────────────────────────────────
  if (metadata['hasDockerfile'] !== true) {
    findings.push({
      id: 'container-setup',
      category: 'container',
      title: "Deployz doesn't know how to start your app",
      severity: 'required',
      blocking: false,
      plainEnglishExplanation:
        'Deployz could not determine how to package and start this application.',
      whyItMatters:
        'Deployz builds and runs your app in its own container for every customer. Without container instructions, deployments cannot be built.',
      technicalEvidence: 'No Dockerfile was found in the repository.',
      suggestedOutcome:
        'Add container build instructions (a Dockerfile) that install dependencies, build the app, and start it.',
      confidence: 'confirmed',
    });
  }

  if (metadata['hasHealthEndpoint'] !== true) {
    findings.push({
      id: 'health-check',
      category: 'health',
      title: 'Give Deployz a way to check your app',
      severity: 'required',
      blocking: false,
      plainEnglishExplanation:
        'Deployz needs a reliable way to know when your app is running and ready.',
      whyItMatters:
        'During every deployment, Deployz waits for your app to report healthy before sending traffic to it. Without a health signal, a broken deploy cannot be detected or rolled back.',
      technicalEvidence:
        'No health endpoint or container health check was found (no /health-style route, no HEALTHCHECK instruction).',
      suggestedOutcome:
        'Expose a lightweight route (for example /health) that returns success once the app is ready, and reference it from the container health check.',
      // Static analysis can miss a real health route (custom path, indirect
      // registration) — the coding agent is told to verify before adding one.
      confidence: 'likely',
    });
  }

  // ── Recommended findings ──────────────────────────────────────────────────
  // Only when a database is actually in play — a repository with no database
  // needs no migration command, and its absence is not a finding at all.
  const postgres = metadata['postgres'] as { required?: unknown } | undefined;
  if (metadata['usesPostgresql'] === true && metadata['hasMigrationCommand'] !== true) {
    const drivers = metadata['postgresqlDrivers'];
    findings.push({
      id: 'database-migrations',
      category: 'database',
      title: 'Give Deployz a way to update your database',
      severity: 'recommended',
      blocking: false,
      plainEnglishExplanation:
        'This app uses a database, but Deployz could not find a command that updates the database structure during deploys.',
      whyItMatters:
        'Deployz runs your migration command automatically on every deploy, so each customer database always matches the code that talks to it.',
      technicalEvidence: `A PostgreSQL library is present (${
        Array.isArray(drivers) ? drivers.join(', ') : 'detected'
      }) but no migration script was found in any package.json.`,
      suggestedOutcome:
        'Add a script that applies database migrations non-interactively (for example a "db:migrate" entry in package.json).',
      // When the database requirement itself is unconfirmed (driver present
      // but no corroborating signal), the whole finding is uncertain.
      confidence: postgres?.required === true ? 'likely' : 'needs_confirmation',
    });
  }

  const worker = finding('worker');
  if (worker?.detected && context.workerCommandResolved === true) {
    // Phase 8 boundary: a resolved worker start command declares a SECOND
    // process the deployment would never start. Needs-adaptation — blocking.
    findings.push({
      id: 'background-worker-unsupported',
      category: 'workers',
      title: "Deployz can't run your app's background worker",
      severity: 'required',
      blocking: true,
      plainEnglishExplanation:
        'This app declares a background worker process, but Deployz runs one web process per application and does not start a second one.',
      whyItMatters:
        'The worker process would never start, so background jobs would stay queued and the app would appear broken or incomplete.',
      technicalEvidence:
        worker.details ?? 'Worker-like code detected and a worker start command resolved.',
      suggestedOutcome:
        'Run the background work inside the web process, or remove the separate worker process before deploying.',
      confidence: 'confirmed',
    });
  } else if (worker?.detected) {
    findings.push({
      id: 'worker-command',
      category: 'workers',
      title: 'Background job runner',
      severity: 'recommended',
      blocking: false,
      plainEnglishExplanation:
        'This app appears to run background jobs, but no command exists that starts a job runner as a separate process.',
      whyItMatters:
        'Deployz runs one web process per application. Background jobs only run when the web process itself processes them.',
      technicalEvidence:
        worker.details ??
        `Worker-like code detected (${String(worker.value ?? '')}) but no worker start script was found.`,
      suggestedOutcome:
        'Process background jobs inside the web process, or remove the job-runner code if it is not used.',
      confidence: 'likely',
    });
  }

  // ── Passed checks ─────────────────────────────────────────────────────────
  const passed: PassedCheck[] = result.findings
    .filter(
      (f) =>
        f.detected &&
        !NEGATIVE_SIGNAL_DETECTORS.has(f.detector) &&
        !SEPARATELY_HANDLED_DETECTORS.has(f.detector),
    )
    .map((f) => ({ id: f.detector, label: PASSED_LABELS[f.detector] ?? f.details ?? f.detector }));

  // ── State ─────────────────────────────────────────────────────────────────
  const required = findings.filter((f) => f.severity === 'required');
  const recommended = findings.filter((f) => f.severity === 'recommended');
  const state: ReadinessReport['state'] =
    required.some((f) => f.blocking) ? 'NEEDS_CHANGES' : required.length > 0 ? 'ALMOST_READY' : 'READY';

  return {
    state,
    requiredCount: required.length,
    recommendedCount: recommended.length,
    summary: STATE_SUMMARY[state],
    findings: [...required, ...recommended],
    passed,
  };
}

// ── Verdict bridge ──────────────────────────────────────────────────────────

/**
 * Map a semantic readiness state onto the persisted `compatibility_status`
 * enum (READY / NEEDS_ATTENTION / NOT_COMPATIBLE — unchanged in the DB).
 */
export function verdictFromReadiness(
  state: ReadinessReport['state'],
): 'READY' | 'NEEDS_ATTENTION' | 'NOT_COMPATIBLE' {
  if (state === 'NEEDS_CHANGES') return 'NOT_COMPATIBLE';
  if (state === 'ALMOST_READY') return 'NEEDS_ATTENTION';
  return 'READY';
}
