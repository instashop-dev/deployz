import { posix as posixPath } from 'node:path';

import { eq } from 'drizzle-orm';

import type { AiGateway, AnalysisResult, FileTree, ReadinessReport, RepositoryAiInput } from '@deployz/analysis';
import {
  REPO_AI_TIMEOUT_MS,
  analyseRepo,
  analyseRepositoryWithAi,
  buildApplicationAnalysis,
  buildReadinessReport,
  collectScripts,
  collectScriptsWithDir,
  collectUnresolvedQuestions,
  detectDeclaredWorkerCommand,
  listDockerfileCandidates,
  mergeAiAnalysis,
  selectAiContextFiles,
  verdictFromReadiness,
} from '@deployz/analysis';
import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { ApiError } from './errors.js';
import { effectiveReadinessReport } from './fix-instructions.js';
import {
  fetchHeadSha,
  getFileTreeForAnalysis,
  mintInstallationToken,
  parseRepoFullName,
  type FetchFn,
} from './github.js';

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

// Task 6 commit-SHA analysis cache: bumped whenever the detector/AI schema
// changes materially, so a repository whose head commit hasn't moved but
// whose analysis LOGIC has still gets a fresh run instead of a stale cache
// hit. Version 1 is the pre-AI implicit version (no `analysisVersion` field
// on the row at all). Version 3 introduced the semantic readiness report
// (`detected_metadata.readiness`). Version 4 introduced the Phase 7 §11
// metadata (env-var model, external-service requirements, unsupported
// architecture reasons), whose absence would silently keep old verdicts.
// Version 5 fixed file-based health-route path derivation (CANARY-003), so
// a stored `healthPath` computed under the old, buggy logic re-runs.
// Version 6 narrowed the §11.4 architecture rejections (CANARY-002) — a
// dev-only compose file and a bare `@azure/*`/`@google-cloud/*` package no
// longer reject, so a stale NOT_COMPATIBLE verdict from Version 5 must re-run.
// Version 7 is the Stage A detector-signal batch (COMP-001..007, 012, 013,
// 016, 018, 020): ports from Dockerfile/Compose, health paths from health
// checks and non-JS routes, Dockerfile ranking, migration-command resolution
// by value, and the tree-fetch priority — stored ports, health paths and
// NEEDS_CONFIGURATION verdicts from Version 6 must re-run.
// Version 8 is the Stage A rejection-precision batch (COMP-002, 008, 009,
// 011, 019): a configurable SQL engine, an uncorroborated broker client, a
// distroless base image, a one-shot Compose service, a variant/dev Compose
// file or a guarded Redis client, and a conditional cluster client no longer
// reject or provision — stale NOT_COMPATIBLE verdicts and `redisRequired`
// flags from Version 7 must re-run.
// Version 9 is the Stage A main-corpus batch (COMP-024, 026, 027, 028, 029,
// 032, 034, 035): local-disk state must be DECLARED (VOLUME/Compose mount)
// with no object-storage alternative, Compose sidecars and profile-gated
// services are not application services, database clients need the same
// corroboration brokers do, Dockerfile naming/ranking, EXPOSE variables and
// non-HTTP ports, PostgreSQL drivers across PHP/JVM/.NET/Rust/Elixir, script
// health checks, and tooling app roots — stale NOT_COMPATIBLE verdicts,
// ports, health paths and `postgres.required` flags from Version 8 must
// re-run.
// Version 10 is the Stage A hardening batch from the unseen set (COMP-015,
// 036, 037, 038): worker code and declared worker processes outside a root
// package.json script, IaC only in runtime paths, unsupported engines in
// JVM/Elixir/PHP/Python manifests, and Dockerfiles fetched ahead of
// workspace manifests — stale worker flags, NOT_COMPATIBLE verdicts and
// Dockerfile selections from Version 9 must re-run.
// Version 11 makes `resolveMigrationCommand` return a command that actually
// runs where the relay executes it (a bare ORM-CLI script value exited 127
// under `sh -c` with no node_modules/.bin on PATH — production-verified on
// Documenso's `prisma migrate deploy`): a bare invocation gets an `npx`
// prefix, and a schema-less Prisma `migrate deploy` gets a `--schema` flag
// computed from the Dockerfile's runtime WORKDIR — stored migration commands
// from Version 10 must re-run.
// Version 12 fixes `detectEnvVarModel` marking a variable required when a
// bare read is chained straight into further use (`process.env.X.split(',')`)
// even though the same file already early-returns on that key's absence
// (production-verified: Documenso's NEXT_PRIVATE_DATABASE_REPLICA_URLS blocked
// deployment creation with 422 MANIFEST_NEEDS_CONFIGURATION although the app
// runs fine without it) — env-var reads behind an early-return presence guard
// are no longer required — stored env-var models from Version 11 must re-run.
// Version 13 adds the runtime and bind-address detectors and persists the
// canonical `application` projection (runtime, commands, port, bind address,
// database, cache, storage, health check, migrations, env vars — each with
// source, confidence and evidence) — stored metadata from Version 12 must
// re-run so the readiness page can show what was detected.
export const ANALYSIS_VERSION = 13;

export interface AnalysisRunnerDeps {
  db: RuntimeDb;
  fetchFn: FetchFn;
  githubAppId: string | undefined;
  githubAppPrivateKey: string | undefined;
  githubFixtureMode: boolean;
  /** §15 AI repository-analysis fallback — only invoked when a real question is left unresolved. */
  aiGateway: AiGateway;
  /** Injectable clock for JWT iat/exp — defaults to Date.now. */
  now?: (() => number) | undefined;
}

/** The shape `buildServer` wires into the `/analyse` route. */
export type AnalysisRunner = (
  applicationId: string,
  options?: { force?: boolean },
) => Promise<void>;

export function createAnalysisRunner(deps: AnalysisRunnerDeps): AnalysisRunner {
  return (applicationId: string, options?: { force?: boolean }) =>
    runApplicationAnalysis(deps, applicationId, options);
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
  options?: { force?: boolean },
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

    // Task 6 commit-SHA analysis cache (real GitHub mode only — fixture mode
    // has no head commit to compare and always runs fully). The single
    // installation token a real-mode run needs is minted HERE, once, and
    // reused for both the head-sha lookup and — on a full run — the tree/
    // blob fetch below, so a full run never mints a second token.
    // `mintRealModeToken` throws the same errors a full run always threw
    // (missing installation / unconfigured App / a minting failure), which
    // is correct: if minting fails, the run was always going to fail. Once
    // minted, `fetchHeadSha` itself never throws — it degrades to
    // `undefined` on any non-200 — so the cache lookup stays best-effort.
    let headSha: string | undefined;
    let realModeToken: string | undefined;
    if (!deps.githubFixtureMode) {
      realModeToken = await mintRealModeToken(deps, application);
      headSha = await fetchHeadSha(
        { ...parseRepoFullName(application.repoFullName), branch: application.defaultBranch },
        realModeToken,
        deps.fetchFn,
      );
    }

    if (!options?.force && headSha !== undefined && isCommitShaCacheHit(application.detectedMetadata, headSha)) {
      await deps.db
        .update(schema.applications)
        .set({ analysisStatus: 'COMPLETE' })
        .where(eq(schema.applications.id, applicationId));
      return;
    }

    const tree = await fetchTreeForApplication(deps, application, realModeToken);
    const analysis = analyseRepo(tree);
    // The vendor-owned field list lives on detected_metadata, which this
    // write replaces wholesale — carry it across or every re-analysis would
    // forget which fields the vendor edited.
    const vendorOverrides = readVendorOverrides(application.detectedMetadata);

    // §15 AI fallback: only runs when the deterministic scanner left a real
    // question unresolved, and can never fail the analysis — any AI error
    // degrades to the deterministic metadata plus a warning.
    const { metadata, aiResolved } = await applyAiFallback(deps.aiGateway, tree, analysis);
    const mergedAnalysis: AnalysisResult = { ...analysis, metadata };
    const contractFieldUpdates = deriveContractFieldUpdates(vendorOverrides, tree, mergedAnalysis, aiResolved);

    // The semantic readiness report is built from the MERGED metadata, so a
    // start/migration command the AI resolved counts as resolved here too.
    // The persisted verdict is derived from the report — one source of truth.
    const resolvedWorkerCommand = resolveWorkerCommand(tree);
    const readiness: ReadinessReport = buildReadinessReport(mergedAnalysis, {
      workerCommandResolved: resolvedWorkerCommand !== undefined,
    });
    const applicationAnalysis = buildApplicationAnalysis(mergedAnalysis, {
      analysisVersion: ANALYSIS_VERSION,
      aiResolved,
      resolvedMigrationCommand: resolveMigrationCommand(tree) ?? null,
    });
    // The stored report keeps every finding; the persisted verdict reads the
    // report the way the page does — with the vendor's port and start
    // command applied — so the list badge and the readiness page agree.
    const effectiveReadiness = effectiveReadinessReport({
      containerPort: contractFieldUpdates.containerPort ?? application.containerPort,
      detectedMetadata: { ...application.detectedMetadata, readiness },
    });

    await deps.db
      .update(schema.applications)
      .set({
        analysisStatus: 'COMPLETE',
        compatibilityStatus: verdictFromReadiness((effectiveReadiness ?? readiness).state),
        compatibilityReason: (effectiveReadiness ?? readiness).summary,
        detectedMetadata: {
          ...metadata,
          // Phase 8: the resolved worker command rides the metadata so the
          // deployment manifest's worker gate reads CURRENT analysis output
          // (this record is replaced wholesale each run) instead of the
          // sticky worker_command column, which positive-only writes never
          // clear. Null when no worker script resolves.
          resolvedWorkerCommand,
          readiness,
          application: applicationAnalysis,
          vendorOverrides,
          analysisVersion: ANALYSIS_VERSION,
          ...(headSha !== undefined ? { analysisCommitSha: headSha } : {}),
        },
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
  // This runs detached on the worker Lambda and every error above is caught,
  // so this line is the ONLY trace a failed run leaves anywhere. Without it a
  // vendor's "Re-analyse does nothing" is undiagnosable: the row says FAILED,
  // the worker log says nothing at all. The original error goes out too — the
  // persisted `reason` is deliberately vendor-facing and loses the detail.
  console.error(`[analysis] application ${applicationId} FAILED: ${reason}`, error);
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

// ── Task 6 commit-SHA analysis cache ────────────────────────────────────────

/**
 * Guards + mints the ONE installation token a real-mode run needs — shared
 * by the Task 6 head-sha cache lookup and (on a full run) the tree/blob
 * fetch, so a full run never mints more than once. Never called in fixture
 * mode. Throws the same structured errors a full run always threw on a
 * missing installation / unconfigured App / minting failure — a real-mode
 * run that can't get a token was always going to fail regardless of the
 * cache.
 */
async function mintRealModeToken(deps: AnalysisRunnerDeps, application: ApplicationRow): Promise<string> {
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
  return token;
}

/** A cache hit: the stored analysis was for this exact commit and analyser version. */
function isCommitShaCacheHit(metadata: Record<string, unknown> | null, headSha: string): boolean {
  if (!metadata) return false;
  return metadata['analysisCommitSha'] === headSha && metadata['analysisVersion'] === ANALYSIS_VERSION;
}

// ── Repo/branch resolution + tree fetch ─────────────────────────────────────

// `realModeToken` is minted once by `mintRealModeToken` in
// `runApplicationAnalysis` (real mode only) and reused here — this function
// never mints its own token, so a full run mints exactly one.
async function fetchTreeForApplication(
  deps: AnalysisRunnerDeps,
  application: ApplicationRow,
  realModeToken: string | undefined,
): Promise<FileTree> {
  if (deps.githubFixtureMode) {
    return getFileTreeForAnalysis(application.repoFullName, { fixtureMode: true });
  }
  return getFileTreeForAnalysis(application.repoFullName, {
    fixtureMode: false,
    branch: application.defaultBranch,
    installationToken: realModeToken,
    fetchFn: deps.fetchFn,
  });
}

// ── §15 AI repository-analysis fallback ─────────────────────────────────────

/** The deterministic facts `RepositoryAiInput.detected` needs, read off `analysis.metadata`. */
function buildRepositoryAiInput(
  tree: FileTree,
  analysis: AnalysisResult,
  unresolved: string[],
): RepositoryAiInput {
  const metadata = analysis.metadata;
  const buildCommands = metadata['buildCommands'];
  const startupCommands = metadata['startupCommands'];
  const postgres = metadata['postgres'] as { required?: unknown } | undefined;
  const redis = metadata['redis'] as { required?: unknown } | undefined;

  return {
    detected: {
      packageManager: typeof metadata['packageManager'] === 'string' ? metadata['packageManager'] : null,
      framework: typeof metadata['framework'] === 'string' ? metadata['framework'] : null,
      buildCommand: Array.isArray(buildCommands) && typeof buildCommands[0] === 'string' ? buildCommands[0] : null,
      startCommand:
        Array.isArray(startupCommands) && typeof startupCommands[0] === 'string' ? startupCommands[0] : null,
      port: typeof metadata['port'] === 'string' ? metadata['port'] : null,
      dockerfilePath: typeof metadata['dockerfilePath'] === 'string' ? metadata['dockerfilePath'] : null,
      postgresRequired: postgres?.required === true,
      redisRequired: redis?.required === true,
      migrationCommandDetected: metadata['hasMigrationCommand'] === true,
    },
    files: selectAiContextFiles(tree),
    unresolved,
  };
}

/**
 * Runs the §15 AI fallback when (and only when) `collectUnresolvedQuestions`
 * finds something the deterministic scanner could not resolve, then merges
 * the answer with `mergeAiAnalysis` (deterministic always wins). Any AI
 * failure — unconfigured gateway, network error, timeout, schema violation —
 * is caught here and degrades to the deterministic metadata plus a warning;
 * it must never fail an analysis the deterministic scanner completed.
 */
async function applyAiFallback(
  aiGateway: AiGateway,
  tree: FileTree,
  analysis: AnalysisResult,
): Promise<{ metadata: Record<string, unknown>; aiResolved: string[] }> {
  const unresolved = collectUnresolvedQuestions(tree, analysis);
  if (unresolved.length === 0) {
    return { metadata: analysis.metadata, aiResolved: [] };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPO_AI_TIMEOUT_MS);
  try {
    const input = buildRepositoryAiInput(tree, analysis, unresolved);
    const ai = await analyseRepositoryWithAi(input, aiGateway, { abortSignal: controller.signal });
    const outcome = mergeAiAnalysis(analysis.metadata, ai);
    return {
      metadata: {
        ...outcome.metadata,
        aiAnalysis: {
          unresolved,
          aiResolved: outcome.aiResolved,
          warnings: outcome.warnings,
          generatedAt: new Date().toISOString(),
        },
      },
      aiResolved: outcome.aiResolved,
    };
  } catch {
    return {
      metadata: {
        ...analysis.metadata,
        aiAnalysis: { unresolved, warnings: ['AI analysis unavailable'] },
      },
      aiResolved: [],
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── Legacy §19 checks shape ─────────────────────────────────────────────────
// No longer written — analyses persist `detected_metadata.readiness` instead.
// Kept only so computeReadiness (server.ts) can degrade gracefully when it
// reads a row analysed before the semantic-readiness report existed.

export interface ReadyCheck {
  label: string;
}
export interface AttentionCheck {
  title: string;
  detail: string;
  suggestedFix: string | null;
}
export interface UnsupportedCheck {
  title: string;
  reason: string;
}

// ── §35 contract field backfill ─────────────────────────────────────────────

// The §18 migration-command / worker detectors only report WHICH pattern
// matched (e.g. "drizzle-kit"), not the literal script text — not enough to
// persist as an executable command. This looks at package.json script KEYS
// directly (independent of, and narrower than, the §18 detectors) to
// recover an actual runnable command for the two contract fields that need
// one; it only ever proposes a value, never invents one. `collectScripts`
// (shared with the §18 detectors) reads every workspace package's scripts,
// not just the root manifest's — a monorepo's migration/worker script
// usually lives in the app package, not the workspace root.
const MIGRATION_SCRIPT_KEY_REGEX = /migrat/i;
const WORKER_SCRIPT_KEY_REGEX = /^worker$|worker[:-]?start|start[:-]?worker/i;

// A dev-mode migration command must never reach `migrationCommand` — it runs
// unattended against the production database on every deploy (the relay's
// DEPLOY_RELEASE executor runs it), and a dev-mode command is built to prompt
// interactively / reset data, not to run unattended. Matches "migrate dev",
// "migrate-dev", and "migrate:dev" (which also covers a ":migrate-dev"
// script-key form, since that substring contains "migrate-dev").
const DEV_MIGRATION_REGEX = /migrate[\s:-]dev\b/i;

// The deploy-safe subset of MIGRATION_PATTERNS' vocabulary (detectors.ts) —
// commands that apply already-generated migrations non-interactively, as
// opposed to a codegen step (`drizzle-kit generate`) or an ambiguous bare
// `prisma migrate` that could resolve to either deploy or dev depending on
// the rest of the command.
const DEPLOY_MIGRATION_REGEX =
  /prisma\s+migrate\s+deploy\b|drizzle-kit\s+(?:push|migrate)\b|knex\s+migrate:(?:latest|up)\b|sequelize\s+db:migrate\b|typeorm\s+migration:run\b|node-pg-migrate\b|npx\s+migrate\b/;

// The vendor's package.json script is written to run via npm/pnpm/yarn's own
// script runner (developer machine, CI) or by a Dockerfile's start script
// that already resolved its own PATH — both put the package's own
// `node_modules/.bin` on PATH before the command runs. The relay's
// DEPLOY_RELEASE executor runs neither: it runs `sh -c <command>` directly
// inside the built image (docker/Dockerfile's final stage sets no PATH
// pointing at any node_modules/.bin), so a bare CLI-binary invocation exits
// 127 ("command not found") there even though it works everywhere the
// vendor tested it. A command already qualified by npx/npm/pnpm/yarn/bun/
// node/deno, or given as a path, is left alone — never second-guess a
// vendor's already-qualified command.
const BARE_ORM_CLI_REGEX = /^(?:prisma|drizzle-kit|knex|sequelize-cli|sequelize|typeorm|node-pg-migrate|migrate)\b/;

/** Prefix a bare ORM-CLI invocation with `npx` so it resolves regardless of PATH. */
function applyNpxPrefix(command: string): string {
  return BARE_ORM_CLI_REGEX.test(command) ? `npx ${command}` : command;
}

const NPX_PRISMA_MIGRATE_DEPLOY_REGEX = /^npx\s+prisma\s+migrate\s+deploy\b/;
const SCHEMA_FLAG_REGEX = /--schema\b/;
const SCHEMA_PRISMA_PATH_REGEX = /(?:^|\/)schema\.prisma$/;

/**
 * The `schema.prisma` that belongs to the migration script's own package:
 * directly in the package's directory, then its `prisma/` subdirectory,
 * then — only if there is exactly one anywhere in the tree — that one.
 * `node_modules` copies are never candidates.
 */
function findPrismaSchemaPath(tree: FileTree, packageDir: string): string | undefined {
  const candidates = Object.keys(tree).filter(
    (path) => SCHEMA_PRISMA_PATH_REGEX.test(path) && !path.includes('node_modules/'),
  );
  if (candidates.length === 0) return undefined;
  const direct = packageDir ? `${packageDir}/schema.prisma` : 'schema.prisma';
  if (candidates.includes(direct)) return direct;
  const nested = packageDir ? `${packageDir}/prisma/schema.prisma` : 'prisma/schema.prisma';
  if (candidates.includes(nested)) return nested;
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** The selected Dockerfile's raw content, same ranking `detectDockerfile` uses. */
function selectedDockerfileContent(tree: FileTree): string | undefined {
  const path = listDockerfileCandidates(tree)[0];
  return path !== undefined ? tree[path] : undefined;
}

/**
 * The image's runtime working directory and the directory the repository was
 * copied into, read from the LAST build stage of a Dockerfile (an earlier
 * stage's WORKDIR never survives into the runtime image): the first WORKDIR
 * in that stage is where the repo lands (e.g. `/app`), and the last WORKDIR
 * is where `CMD`/the relay's `sh -c <command>` actually runs from — they
 * differ whenever the final stage `WORKDIR`s into a subdirectory afterwards
 * (Documenso's `docker/Dockerfile` sets `WORKDIR /app` then later `WORKDIR
 * /app/apps/remix`). Relative WORKDIRs chain off the previous one, as Docker
 * itself resolves them. No WORKDIR at all means both default to the same
 * directory, so no relative adjustment is needed.
 */
function dockerfileWorkdirs(content: string): { imageRoot: string; runtimeCwd: string } {
  const lastStageStart = [...content.matchAll(/^\s*FROM\s+\S+/gim)].at(-1)?.index ?? 0;
  const finalStage = content.slice(lastStageStart);

  const dirs: string[] = [];
  let current = '/';
  for (const match of finalStage.matchAll(/^\s*WORKDIR\s+(\S+)/gim)) {
    const raw = match[1]!.replace(/^["']|["']$/g, '');
    current = raw.startsWith('/') ? raw : posixPath.join(current, raw);
    dirs.push(current);
  }
  const imageRoot = dirs[0] ?? '/';
  const runtimeCwd = dirs.at(-1) ?? imageRoot;
  return { imageRoot, runtimeCwd };
}

/**
 * If `command` (after the npx-prefix rewrite) is a Prisma `migrate deploy`
 * invocation with no explicit `--schema`, append one computed from the
 * schema's real location relative to the image's runtime WORKDIR. Prisma's
 * CLI does not search upward for a schema from an arbitrary cwd, and the
 * relay's `sh -c` runs the command from the image's WORKDIR — not from the
 * script's own package directory the way npm/pnpm/yarn would run it. Left
 * alone when the schema can't be located, or already sits at Prisma's
 * default lookup location relative to that cwd (`./schema.prisma` or
 * `./prisma/schema.prisma`) — an explicit flag there would be redundant.
 * Only ever applied to a command WE just npx-prefixed, or one the vendor
 * already wrote as `npx prisma migrate deploy` — an already-qualified
 * `pnpm prisma migrate deploy` etc. is left alone, matching the npx-prefix
 * rule's "never second-guess a vendor's already-qualified command".
 */
function withPrismaSchemaFlag(command: string, packageDir: string, tree: FileTree): string {
  if (!NPX_PRISMA_MIGRATE_DEPLOY_REGEX.test(command) || SCHEMA_FLAG_REGEX.test(command)) {
    return command;
  }
  const schemaPath = findPrismaSchemaPath(tree, packageDir);
  if (!schemaPath) return command;

  const dockerfileContent = selectedDockerfileContent(tree);
  const { imageRoot, runtimeCwd } = dockerfileContent !== undefined ? dockerfileWorkdirs(dockerfileContent) : { imageRoot: '/', runtimeCwd: '/' };
  const rootFromCwd = posixPath.relative(runtimeCwd, imageRoot);
  const schemaFromCwd = posixPath.join(rootFromCwd, schemaPath);

  if (schemaFromCwd === 'schema.prisma' || schemaFromCwd === 'prisma/schema.prisma') {
    return command;
  }
  return `${command} --schema ${schemaFromCwd}`;
}

/**
 * Resolve the migration command to persist as the §35 `migrationCommand`
 * contract field — the command the relay's DEPLOY_RELEASE executor runs
 * unattended against the production database on every deploy, so this picks
 * defensively:
 *
 *   0. A candidate is a script whose KEY mentions migrations, or whose VALUE
 *      is already a deploy-shaped command under any key (`update-db: prisma
 *      migrate deploy` — Stage A COMP-006).
 *   1. Drop every dev-shaped candidate outright (`DEV_MIGRATION_REGEX`) —
 *      never a candidate for this field, regardless of what else exists.
 *   2. Among what is left, prefer a deploy-shaped command
 *      (`DEPLOY_MIGRATION_REGEX`) over an ambiguous one.
 *   3. If nothing survives step 1, return undefined — an absent migration
 *      command is safer than a dev-mode one running unattended.
 *
 * The selected script's literal value is then rewritten into a command that
 * is actually runnable where the relay executes it: `sh -c <command>` inside
 * the built image, at the image's runtime WORKDIR, with no node_modules/.bin
 * on PATH (see `applyNpxPrefix`/`withPrismaSchemaFlag`) — the package.json
 * author wrote it assuming npm/pnpm/yarn's own script-running environment,
 * not the relay's.
 */
function resolveMigrationCommand(tree: FileTree): string | undefined {
  const candidates = collectScriptsWithDir(tree).filter(
    ([key, command]) => MIGRATION_SCRIPT_KEY_REGEX.test(key) || DEPLOY_MIGRATION_REGEX.test(command),
  );
  const safeCandidates = candidates.filter(([, command]) => !DEV_MIGRATION_REGEX.test(command));
  if (safeCandidates.length === 0) return undefined;
  const deployShaped = safeCandidates.find(([, command]) => DEPLOY_MIGRATION_REGEX.test(command));
  const [, command, packageDir] = (deployShaped ?? safeCandidates[0])!;
  return withPrismaSchemaFlag(applyNpxPrefix(command), packageDir, tree);
}

/**
 * Resolve the worker start command: a worker script in any workspace
 * package, else a Procfile, Compose or worker-package declaration
 * (Stage A COMP-015).
 */
export function resolveWorkerCommand(tree: FileTree): string | undefined {
  const match = collectScripts(tree).find(([key]) => WORKER_SCRIPT_KEY_REGEX.test(key));
  return match?.[1] ?? detectDeclaredWorkerCommand(tree)?.command;
}

interface ContractFieldUpdates {
  containerPort?: number;
  healthPath?: string;
  migrationCommand?: string;
  workerCommand?: string;
  databaseRequired?: boolean;
  storageRequired?: boolean;
  redisRequired?: boolean;
}

/**
 * The §35 contract fields the vendor has explicitly edited, as recorded by
 * PATCH /api/applications/:id on `detected_metadata.vendorOverrides`. Any
 * other shape (older rows, hand-written metadata) reads as "nothing is
 * vendor-owned yet".
 */
export function readVendorOverrides(metadata: Record<string, unknown> | null): string[] {
  const raw = metadata?.['vendorOverrides'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Writes the §35 contract fields the analyser found, so a re-analysis picks
 * up what actually changed in the repository (a moved port, a new /health
 * route, a renamed migrate script). Two rules bound it:
 *
 *   - A field the vendor edited (`vendorOverrides`) is never touched again.
 *     Being non-null is NOT enough on its own — the previous analysis wrote
 *     most of these values, and treating its own output as vendor intent is
 *     exactly what froze re-analysis.
 *   - Only a positive detection writes. Finding nothing never clears an
 *     existing value: a single unreadable blob drops that file from the
 *     tree (fetchBlobContent returns null on error), so "not detected" is
 *     not reliable enough to wipe a vendor's deployment contract. Booleans
 *     move false -> true on evidence, never back.
 *
 * `analysis` carries the MERGED (post-§15 AI fallback) metadata, and
 * `aiResolved` names which keys the AI filled — `databaseRequired`/
 * `redisRequired` pick up an AI-resolved flip for free via `analysis.metadata`
 * (the same gate `mergeAiAnalysis` already applied), while `containerPort`/
 * `migrationCommand` only fall back to the AI value when `aiResolved` says
 * so, since neither is derivable from `analysis.findings` the way the
 * deterministic path is.
 */
function deriveContractFieldUpdates(
  vendorOverrides: string[],
  tree: FileTree,
  analysis: AnalysisResult,
  aiResolved: string[],
): ContractFieldUpdates {
  const updates: ContractFieldUpdates = {};
  const vendorOwned = new Set(vendorOverrides);
  const finding = (name: string) => analysis.findings.find((f) => f.detector === name);

  if (!vendorOwned.has('containerPort')) {
    const port = finding('port');
    if (port?.detected && typeof port.value === 'string') {
      const parsed = Number.parseInt(port.value, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        updates.containerPort = parsed;
      }
    } else if (aiResolved.includes('port') && typeof analysis.metadata['port'] === 'string') {
      const parsed = Number.parseInt(analysis.metadata['port'] as string, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        updates.containerPort = parsed;
      }
    }
  }

  if (!vendorOwned.has('healthPath')) {
    const health = finding('health-endpoint');
    // The health-endpoint detector's normalized `path` names the literal
    // path it found evidence for (a route registration, a file-based route
    // convention, or the "/health" default when only a Dockerfile
    // HEALTHCHECK / package.json script was found) — see detectors.ts.
    if (health?.detected && health.path) {
      updates.healthPath = health.path;
    }
  }

  if (!vendorOwned.has('migrationCommand')) {
    const command = resolveMigrationCommand(tree);
    if (command) {
      updates.migrationCommand = command;
    } else if (aiResolved.includes('migrationCommands')) {
      const migrationCommands = analysis.metadata['migrationCommands'];
      if (Array.isArray(migrationCommands) && typeof migrationCommands[0] === 'string') {
        updates.migrationCommand = migrationCommands[0];
      }
    }
  }

  if (!vendorOwned.has('workerCommand')) {
    const command = resolveWorkerCommand(tree);
    if (command) updates.workerCommand = command;
  }

  if (!vendorOwned.has('databaseRequired')) {
    // Unlike a mere detector `detected` flag (library presence), RDS
    // provisioning is gated on the required-vs-present evidence rule — a
    // driver/ORM dependency alone never provisions a database.
    // `metadata.postgres.required` is that gate, computed once by
    // `assessPostgres` and carried through `analysis.metadata`.
    const postgres = analysis.metadata['postgres'] as { required?: unknown } | undefined;
    if (postgres?.required === true) updates.databaseRequired = true;
  }

  if (!vendorOwned.has('storageRequired')) {
    const s3 = finding('s3');
    if (s3?.detected) updates.storageRequired = true;
  }

  if (!vendorOwned.has('redisRequired')) {
    // Unlike `databaseRequired`/`storageRequired` (driven straight off a
    // detector's `detected` flag), Redis provisioning is gated on the §7
    // confidence policy, not mere presence — `metadata.redis.required` is
    // already that gate (high confidence AND a supported setup), computed
    // once by `assessRedis` and carried through `analysis.metadata`.
    const redis = analysis.metadata['redis'] as { required?: unknown } | undefined;
    if (redis?.required === true) updates.redisRequired = true;
  }

  return updates;
}
