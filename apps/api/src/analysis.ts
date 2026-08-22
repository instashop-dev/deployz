import { eq } from 'drizzle-orm';

import type { AnalysisResult, CompatibilityResult, FileTree } from '@deployz/analysis';
import { analyseRepo, evaluateCompatibility } from '@deployz/analysis';
import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { ApiError } from './errors.js';
import { getFileTreeForAnalysis, mintInstallationToken, type FetchFn } from './github.js';

// §18/§19/§20 analysis orchestrator — the ONLY caller of `analyseRepo` /
// `evaluateCompatibility` outside their own package tests. Wires:
//   1. Load the application row + resolve its GitHub repo/branch.
//   2. Fetch a capped file tree (github.ts) and run the deterministic
//      analyser + rules engine (@deployz/analysis).
//   3. Persist analysisStatus/compatibilityStatus/compatibilityReason/
//      detectedMetadata, and backfill the §35 contract fields the analyser
//      found where they are still null.
//
// This module NEVER throws out of `runApplicationAnalysis` — every failure
// mode (repo not found, empty repo, no installation, GitHub disabled, rate
// limited, unexpected error) is caught and persisted as analysisStatus
// 'FAILED' with a reason. server.ts calls this detached from the request
// that triggered it (§ fire-and-forget 202-accepted semantics), so an
// unhandled rejection here would crash the process.

type ApplicationRow = typeof schema.applications.$inferSelect;

export interface AnalysisRunnerDeps {
  db: RuntimeDb;
  fetchFn: FetchFn;
  githubAppId: string | undefined;
  githubAppPrivateKey: string | undefined;
  githubFixtureMode: boolean;
  /** Injectable clock for JWT iat/exp — defaults to Date.now. */
  now?: (() => number) | undefined;
}

/** The shape `buildServer` wires into the `/analyse` route. */
export type AnalysisRunner = (applicationId: string) => Promise<void>;

export function createAnalysisRunner(deps: AnalysisRunnerDeps): AnalysisRunner {
  return (applicationId: string) => runApplicationAnalysis(deps, applicationId);
}

/**
 * Runs the full §18/§19 pipeline for one application and persists the
 * result. Safe to call detached (not awaited) — every error path is caught
 * internally and turned into a persisted FAILED status rather than a thrown
 * or rejected promise.
 */
export async function runApplicationAnalysis(
  deps: AnalysisRunnerDeps,
  applicationId: string,
): Promise<void> {
  try {
    const rows = await deps.db
      .select()
      .from(schema.applications)
      .where(eq(schema.applications.id, applicationId))
      .limit(1);
    const application = rows[0];
    if (!application) {
      // The row vanished between the route accepting the request and this
      // background run starting — nothing left to persist to.
      return;
    }

    const tree = await fetchTreeForApplication(deps, application);
    const analysis = analyseRepo(tree);
    const compatibility = evaluateCompatibility(analysis);
    const checks = buildChecks(analysis, compatibility);
    const contractFieldUpdates = deriveContractFieldUpdates(application, tree, analysis);

    await deps.db
      .update(schema.applications)
      .set({
        analysisStatus: 'COMPLETE',
        compatibilityStatus: compatibility.verdict,
        compatibilityReason: compatibility.reason,
        detectedMetadata: { ...analysis.metadata, checks },
        ...contractFieldUpdates,
      })
      .where(eq(schema.applications.id, applicationId));
  } catch (error) {
    await markFailed(deps.db, applicationId, error);
  }
}

async function markFailed(db: RuntimeDb, applicationId: string, error: unknown): Promise<void> {
  const reason =
    error instanceof ApiError ? error.message : 'Repository analysis failed unexpectedly';
  try {
    await db
      .update(schema.applications)
      .set({ analysisStatus: 'FAILED', compatibilityReason: reason })
      .where(eq(schema.applications.id, applicationId));
  } catch {
    // The DB write itself failed (e.g. connection dropped mid-run) — there
    // is nothing more we can do here. The row is left in ANALYZING; a retry
    // (re-POSTing /analyse) is the recovery path. Never rethrow.
  }
}

// ── Repo/branch resolution + tree fetch ─────────────────────────────────────

async function fetchTreeForApplication(
  deps: AnalysisRunnerDeps,
  application: ApplicationRow,
): Promise<FileTree> {
  if (deps.githubFixtureMode) {
    return getFileTreeForAnalysis(application.repoFullName, { fixtureMode: true });
  }

  if (!application.githubInstallationId) {
    throw new ApiError(
      422,
      'GITHUB_INSTALLATION_MISSING',
      'No GitHub installation is linked to this application',
    );
  }
  if (!deps.githubAppId || !deps.githubAppPrivateKey) {
    throw new ApiError(503, 'GITHUB_DISABLED', 'GitHub App is not configured');
  }

  const { token } = await mintInstallationToken(
    application.githubInstallationId,
    deps.githubAppId,
    deps.githubAppPrivateKey,
    deps.now ? deps.now() : Date.now(),
    deps.fetchFn,
  );
  return getFileTreeForAnalysis(application.repoFullName, {
    fixtureMode: false,
    branch: application.defaultBranch,
    installationToken: token,
    fetchFn: deps.fetchFn,
  });
}

// ── §19 checks shape (must match computeReadiness in server.ts EXACTLY) ────

interface ReadyCheck {
  label: string;
}
interface AttentionCheck {
  title: string;
  detail: string;
  suggestedFix: string | null;
}
interface UnsupportedCheck {
  title: string;
  reason: string;
}

// Friendly, §65 jargon-reduced titles for the §18 detectors that are
// positive/informational signals. Falls back to the detector's own `details`
// string (already human-readable) for anything not in this map, so a future
// detector never silently drops out of the ready list.
const READY_LABELS: Partial<Record<string, string>> = {
  dockerfile: 'Dockerfile found',
  framework: 'Framework detected',
  port: 'Application port detected',
  'health-endpoint': 'Health check endpoint found',
  'env-vars': 'Environment variables detected',
  postgresql: 'PostgreSQL database configured',
  worker: 'Background worker detected',
  s3: 'Object storage usage detected',
  'migration-command': 'Database migration command found',
  'startup-command': 'Startup command found',
  'external-services': 'External service integrations detected',
};

// Detectors whose `detected: true` is a NEGATIVE signal (they only ever fire
// alongside a NOT_COMPATIBLE verdict — see evaluateCompatibility) and must
// never be surfaced in the "ready" list.
const NEGATIVE_SIGNAL_DETECTORS = new Set<string>(['local-filesystem']);

function buildReadyChecks(analysis: AnalysisResult): ReadyCheck[] {
  return analysis.findings
    .filter((f) => f.detected && !NEGATIVE_SIGNAL_DETECTORS.has(f.detector))
    .map((f) => ({ label: READY_LABELS[f.detector] ?? f.details ?? f.detector }));
}

function humanizeCode(code: string): string {
  return code
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// Per-issue-code title + suggested fix for the §19 ATTENTION rules
// (packages/analysis/src/rules.ts). Each needs its OWN suggested fix per
// §19 — never a generic "fix your app" message.
const ATTENTION_META: Partial<Record<string, { title: string; suggestedFix: string }>> = {
  MISSING_DOCKERFILE: {
    title: 'Add a Dockerfile',
    suggestedFix:
      'Add a Dockerfile to the repository root so Deployz knows how to build and run your application.',
  },
  MISSING_HEALTH_ENDPOINT: {
    title: 'Add a health check endpoint',
    suggestedFix:
      'Expose a /health route (or a Dockerfile HEALTHCHECK instruction) that returns success once the app is ready to serve traffic.',
  },
  MISSING_MIGRATION_COMMAND: {
    title: 'Add a database migration command',
    suggestedFix:
      'Add a migration script (for example a "db:migrate" entry in package.json) so Deployz can run your schema migrations automatically during deploys.',
  },
};

function buildNeedsAttentionChecks(compatibility: CompatibilityResult): AttentionCheck[] {
  if (compatibility.verdict !== 'NEEDS_ATTENTION') return [];
  return compatibility.issues.map((issue) => {
    const meta = ATTENTION_META[issue.code];
    return {
      title: meta?.title ?? humanizeCode(issue.code),
      detail: issue.message,
      suggestedFix: meta?.suggestedFix ?? null,
    };
  });
}

// Per-issue-code title for the §19/§10 REJECT rules.
const UNSUPPORTED_META: Partial<Record<string, string>> = {
  REDIS_DEPENDENCY: 'Redis is not supported',
  MYSQL_DEPENDENCY: 'MySQL is not supported',
  MONGO_DEPENDENCY: 'MongoDB is not supported',
  ELASTICSEARCH_DEPENDENCY: 'Elasticsearch / OpenSearch is not supported',
  UNSUPPORTED_DATABASE: 'Unsupported database',
  UNSUPPORTED_DEPENDENCY: 'Unsupported dependency',
  MISSING_POSTGRESQL: 'No PostgreSQL database detected',
  LOCAL_FILESYSTEM_USAGE: 'Persistent local storage is not supported',
};

function buildUnsupportedChecks(compatibility: CompatibilityResult): UnsupportedCheck[] {
  if (compatibility.verdict !== 'NOT_COMPATIBLE') return [];
  return compatibility.issues.map((issue) => ({
    title: UNSUPPORTED_META[issue.code] ?? humanizeCode(issue.code),
    reason: issue.message,
  }));
}

function buildChecks(
  analysis: AnalysisResult,
  compatibility: CompatibilityResult,
): { ready: ReadyCheck[]; needsAttention: AttentionCheck[]; unsupported: UnsupportedCheck[] } {
  return {
    ready: buildReadyChecks(analysis),
    needsAttention: buildNeedsAttentionChecks(compatibility),
    unsupported: buildUnsupportedChecks(compatibility),
  };
}

// ── §35 contract field backfill ─────────────────────────────────────────────

function parsePackageJsonScripts(tree: FileTree): Record<string, string> {
  const raw = tree['package.json'];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as { scripts?: unknown };
    const scripts = parsed.scripts;
    if (typeof scripts !== 'object' || scripts === null) return {};
    return scripts as Record<string, string>;
  } catch {
    return {};
  }
}

// The §18 migration-command / worker detectors only report WHICH pattern
// matched (e.g. "drizzle-kit"), not the literal script text — not enough to
// persist as an executable command. This looks at package.json script KEYS
// directly (independent of, and narrower than, the §18 detectors) to
// recover an actual runnable command for the two contract fields that need
// one; it only ever proposes a value, never invents one.
const MIGRATION_SCRIPT_KEY_REGEX = /migrat/i;
const WORKER_SCRIPT_KEY_REGEX = /^worker$|worker[:-]?start|start[:-]?worker/i;

function findScriptCommand(scripts: Record<string, string>, keyPattern: RegExp): string | null {
  const key = Object.keys(scripts).find((k) => keyPattern.test(k));
  return key ? (scripts[key] ?? null) : null;
}

interface ContractFieldUpdates {
  containerPort?: number;
  healthPath?: string;
  migrationCommand?: string;
  workerCommand?: string;
  databaseRequired?: boolean;
  storageRequired?: boolean;
}

/**
 * Backfills the §35 contract fields the analyser found — but ONLY where the
 * application row doesn't already carry a value (nullable fields: null;
 * boolean fields: an auto-detected `true` never overrides a value the
 * vendor already set, and a still-default `false` may be upgraded to `true`
 * when the analyser found positive evidence — never downgraded).
 */
function deriveContractFieldUpdates(
  application: ApplicationRow,
  tree: FileTree,
  analysis: AnalysisResult,
): ContractFieldUpdates {
  const updates: ContractFieldUpdates = {};
  const finding = (name: string) => analysis.findings.find((f) => f.detector === name);

  if (application.containerPort === null) {
    const port = finding('port');
    if (port?.detected && typeof port.value === 'string') {
      const parsed = Number.parseInt(port.value, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        updates.containerPort = parsed;
      }
    }
  }

  if (application.healthPath === null) {
    const health = finding('health-endpoint');
    if (health?.detected) {
      // §18's health-endpoint detector only ever matches the literal
      // "/health" path (HEALTH_ROUTE_REGEX / Dockerfile HEALTHCHECK), so
      // this is a faithful value, not a guess.
      updates.healthPath = '/health';
    }
  }

  const scripts = parsePackageJsonScripts(tree);

  if (application.migrationCommand === null) {
    const command = findScriptCommand(scripts, MIGRATION_SCRIPT_KEY_REGEX);
    if (command) updates.migrationCommand = command;
  }

  if (application.workerCommand === null) {
    const command = findScriptCommand(scripts, WORKER_SCRIPT_KEY_REGEX);
    if (command) updates.workerCommand = command;
  }

  if (!application.databaseRequired) {
    const postgresql = finding('postgresql');
    if (postgresql?.detected) updates.databaseRequired = true;
  }

  if (!application.storageRequired) {
    const s3 = finding('s3');
    if (s3?.detected) updates.storageRequired = true;
  }

  return updates;
}
