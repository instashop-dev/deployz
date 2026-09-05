/**
 * The Stage B result model — one schema-validated document per Stage A id
 * under `docs/testing/repository-deployment/runs/`, plus the corpus summary.
 *
 * Two fixed vocabularies (README "Result model"): the failure stage names
 * where the funnel stopped, the root cause names the first responsible
 * layer. Nothing else is accepted. A completed result is protected: a rerun
 * moves the previous document to `runs/history/` only with `--force`, and
 * the frozen first-run results of the unseen set are never overwritten.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { COHORTS, BENCHMARK_SETS, COMPATIBILITY_STATES, REALISM_LEVELS } from '../repository-compatibility/manifest.js';

export const FAILURE_STAGES = [
  'GATE_ERROR',
  'CONFIG_ERROR',
  'SOURCE_FETCH_ERROR',
  'BUILD_ERROR',
  'IMAGE_ERROR',
  'INFRA_ERROR',
  'CONTAINER_START_ERROR',
  'ENV_BINDING_ERROR',
  'DATABASE_ERROR',
  'REDIS_ERROR',
  'MIGRATION_ERROR',
  'STORAGE_ERROR',
  'PORT_ERROR',
  'HEALTH_PATH_ERROR',
  'TLS_ERROR',
  'APPLICATION_ERROR',
  'TIMEOUT',
  'DESTROY_ERROR',
  'CLEANUP_LEAK',
  'EXPECTED_UNSUPPORTED',
  'REPOSITORY_BROKEN',
  'TEST_HARNESS_ERROR',
] as const;
export type FailureStage = (typeof FAILURE_STAGES)[number];

export const ROOT_CAUSES = [
  'DEPLOYZ_BUG',
  'ANALYSIS_BUG',
  'ANALYSIS_MISSING_SIGNAL',
  'MVP_CAPABILITY_GAP',
  'CORRECTLY_UNSUPPORTED',
  'REPO_CONFIGURATION',
  'UPSTREAM_REPO_FAILURE',
  'AWS_TRANSIENT_FAILURE',
  'TEST_HARNESS_FAILURE',
] as const;
export type RootCause = (typeof ROOT_CAUSES)[number];

export const CLASSIFICATIONS = ['PASS', ...FAILURE_STAGES] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

/** One funnel stage's outcome. NOT_ATTEMPTED: an earlier stage stopped the funnel. */
export const STAGE_STATUSES = ['PASS', 'FAIL', 'SKIPPED', 'NOT_REQUIRED', 'NOT_ATTEMPTED'] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export const GATE_OUTCOMES = ['correct-accept', 'correct-reject', 'false-acceptance', 'false-rejection'] as const;
export type GateOutcome = (typeof GATE_OUTCOMES)[number];

const FINDING_ID_REGEX = /^DEPLOY-\d{3}$/;
const stageStatus = z.enum(STAGE_STATUSES);

export const gateResultSchema = z
  .object({
    status: stageStatus,
    /** The deployment gate's verdict for a fresh application with no configured values. */
    verdict: z.enum(COMPATIBILITY_STATES).nullable(),
    analysisVerdict: z.string().nullable(),
    outcome: z.enum(GATE_OUTCOMES).nullable(),
    gateFindings: z.array(z.string()),
    /** Required env keys the gate says have no value yet. */
    requiredKeys: z.array(z.string()),
    unsupported: z.array(z.string()),
    /** The gate's verdict once the Stage B vendor configuration is applied (offline evaluation). */
    configuredVerdict: z.enum(COMPATIBILITY_STATES).nullable(),
    configuredFindings: z.array(z.string()),
    /** Where the verdict came from: the in-process production path, the deployed control plane, or both. */
    source: z.enum(['in-process', 'control-plane', 'both']).nullable(),
    analysisVersion: z.number().int().nullable(),
    /** The manifest facts the deployment would act on (before the Stage B configuration). */
    manifest: z
      .object({
        dockerfilePath: z.string().nullable(),
        buildContext: z.string().nullable(),
        appRoot: z.string().nullable(),
        port: z.number().int().nullable(),
        healthPath: z.string().nullable(),
        healthMode: z.string().nullable(),
        migrationCommand: z.string().nullable(),
        migrationMode: z.string().nullable(),
        postgres: z.boolean(),
        redis: z.boolean(),
        storage: z.boolean(),
        databaseBindings: z.array(z.string()),
        redisBindings: z.array(z.string()),
        storageBindings: z.array(z.string()),
        generatedKeys: z.array(z.string()),
      })
      .strict()
      .nullable(),
    detail: z.string().nullable(),
  })
  .strict();

export const configurationResultSchema = z
  .object({
    status: stageStatus,
    overrides: z.record(z.string(), z.unknown()),
    /** Configuration keys provided (values never recorded). */
    keys: z.array(z.string()),
    generatedKeys: z.array(z.string()),
    detail: z.string().nullable(),
  })
  .strict();

export const buildResultSchema = z
  .object({
    status: stageStatus,
    releaseId: z.string().nullable(),
    version: z.string().nullable(),
    gitSha: z.string().nullable(),
    dockerfilePath: z.string().nullable(),
    buildContext: z.string().nullable(),
    imageDigest: z.string().nullable(),
    buildId: z.string().nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    detail: z.string().nullable(),
  })
  .strict();

export const deploymentResultSchema = z
  .object({
    status: stageStatus,
    deploymentId: z.string().nullable(),
    installationId: z.string().nullable(),
    bootstrapStack: z.string().nullable(),
    applicationStack: z.string().nullable(),
    stackStatus: z.string().nullable(),
    templateSource: z.enum(['production-default', 'stage-b-generic', 'stage-b-pinned']).nullable(),
    templateUrl: z.string().nullable(),
    installJobState: z.string().nullable(),
    failureCode: z.string().nullable(),
    resourceCount: z.number().int().nonnegative().nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    detail: z.string().nullable(),
  })
  .strict();

const componentState = z.enum(['HEALTHY', 'UNHEALTHY', 'UNKNOWN', 'NOT_ATTEMPTED']);

export const runtimeResultSchema = z
  .object({
    ecs: componentState,
    alb: componentState,
    https: stageStatus,
    /** The path actually probed and where it came from. */
    healthPath: z.string().nullable(),
    healthPathSource: z.enum(['stage-b', 'manifest', 'repository-evidence', 'fallback']).nullable(),
    appUrl: z.string().nullable(),
    runningImageDigest: z.string().nullable(),
    releaseServing: z.boolean().nullable(),
    observation: z
      .object({
        seconds: z.number().int().nonnegative(),
        samples: z.number().int().nonnegative(),
        healthStatuses: z.array(z.number().int().nullable()),
        appStatuses: z.array(z.number().int().nullable()),
        httpsHealthStatuses: z.array(z.number().int().nullable()),
      })
      .strict()
      .nullable(),
    detail: z.string().nullable(),
  })
  .strict();

const dependencyState = z.enum(['PASS', 'FAIL', 'NOT_REQUIRED', 'NOT_VERIFIED', 'NOT_ATTEMPTED']);

export const dependenciesResultSchema = z
  .object({
    postgres: dependencyState,
    redis: dependencyState,
    storage: dependencyState,
    migration: dependencyState,
    detail: z.string().nullable(),
  })
  .strict();

export const cleanupResultSchema = z
  .object({
    status: stageStatus,
    destroyJobState: z.string().nullable(),
    purgeJobState: z.string().nullable(),
    cleanupState: z.string().nullable(),
    bootstrapStackFinal: z.string().nullable(),
    leaks: z.array(z.string()),
    durationMs: z.number().int().nonnegative().nullable(),
    detail: z.string().nullable(),
  })
  .strict();

export const stageBResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^repo-\d{3}$/),
    repository: z.string(),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    /** The repository form Deployz was pointed at (`owner/repo`); the same as `repository` unless a fork was needed. */
    repositoryForm: z.enum(['original', 'fork']).nullable(),
    repositoryUsed: z.string().nullable(),
    set: z.enum(BENCHMARK_SETS),
    cohort: z.enum(COHORTS),
    customerRealism: z.enum(REALISM_LEVELS),
    difficulty: z.number().int().min(1).max(5),
    deployzCommit: z.string().regex(/^[0-9a-f]{7,40}$/),
    runId: z.string().nullable(),
    stageAExpected: z.enum(COMPATIBILITY_STATES),
    expectedDeployable: z.boolean(),
    /** How far the harness was asked to go: the gate only, or the whole funnel. */
    mode: z.enum(['gate', 'deploy']),
    gate: gateResultSchema,
    configuration: configurationResultSchema,
    build: buildResultSchema,
    deployment: deploymentResultSchema,
    runtime: runtimeResultSchema,
    dependencies: dependenciesResultSchema,
    cleanup: cleanupResultSchema,
    classification: z.enum(CLASSIFICATIONS),
    failureStage: z.enum(FAILURE_STAGES).nullable(),
    rootCause: z.enum(ROOT_CAUSES).nullable(),
    /** Why the root cause was chosen — or what is still to be investigated. */
    rootCauseEvidence: z.string().nullable(),
    findingIds: z.array(z.string().regex(FINDING_ID_REGEX)),
    timing: z
      .object({
        startedAt: z.string().nullable(),
        finishedAt: z.string().nullable(),
        totalMs: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    /** Summarized, sanitized evidence — never raw AWS logs, never secrets. */
    evidence: z.record(z.string(), z.unknown()),
  })
  .strict();
export type StageBResult = z.infer<typeof stageBResultSchema>;

// ── Construction ─────────────────────────────────────────────────────────

export interface ResultIdentity {
  id: string;
  repository: string;
  commit: string;
  set: StageBResult['set'];
  cohort: StageBResult['cohort'];
  customerRealism: StageBResult['customerRealism'];
  difficulty: number;
  deployzCommit: string;
  runId: string | null;
  stageAExpected: StageBResult['stageAExpected'];
  mode: StageBResult['mode'];
}

/** A result with every stage NOT_ATTEMPTED — the starting point every run fills in. */
export function emptyResult(identity: ResultIdentity): StageBResult {
  const expectedDeployable = identity.stageAExpected !== 'NOT_COMPATIBLE';
  return {
    schemaVersion: 1,
    ...identity,
    repositoryForm: null,
    repositoryUsed: null,
    expectedDeployable,
    gate: {
      status: 'NOT_ATTEMPTED',
      verdict: null,
      analysisVerdict: null,
      outcome: null,
      gateFindings: [],
      requiredKeys: [],
      unsupported: [],
      configuredVerdict: null,
      configuredFindings: [],
      source: null,
      analysisVersion: null,
      manifest: null,
      detail: null,
    },
    configuration: { status: 'NOT_ATTEMPTED', overrides: {}, keys: [], generatedKeys: [], detail: null },
    build: {
      status: 'NOT_ATTEMPTED',
      releaseId: null,
      version: null,
      gitSha: null,
      dockerfilePath: null,
      buildContext: null,
      imageDigest: null,
      buildId: null,
      durationMs: null,
      detail: null,
    },
    deployment: {
      status: 'NOT_ATTEMPTED',
      deploymentId: null,
      installationId: null,
      bootstrapStack: null,
      applicationStack: null,
      stackStatus: null,
      templateSource: null,
      templateUrl: null,
      installJobState: null,
      failureCode: null,
      resourceCount: null,
      durationMs: null,
      detail: null,
    },
    runtime: {
      ecs: 'NOT_ATTEMPTED',
      alb: 'NOT_ATTEMPTED',
      https: 'NOT_ATTEMPTED',
      healthPath: null,
      healthPathSource: null,
      appUrl: null,
      runningImageDigest: null,
      releaseServing: null,
      observation: null,
      detail: null,
    },
    dependencies: {
      postgres: 'NOT_ATTEMPTED',
      redis: 'NOT_ATTEMPTED',
      storage: 'NOT_ATTEMPTED',
      migration: 'NOT_ATTEMPTED',
      detail: null,
    },
    cleanup: {
      status: 'NOT_ATTEMPTED',
      destroyJobState: null,
      purgeJobState: null,
      cleanupState: null,
      bootstrapStackFinal: null,
      leaks: [],
      durationMs: null,
      detail: null,
    },
    classification: 'TEST_HARNESS_ERROR',
    failureStage: 'TEST_HARNESS_ERROR',
    rootCause: 'TEST_HARNESS_FAILURE',
    rootCauseEvidence: 'the run did not reach a classification',
    findingIds: [],
    timing: { startedAt: null, finishedAt: null, totalMs: null },
    evidence: {},
  };
}

/** True when a result's funnel ended in TRUE_DEPLOYMENT_SUCCESS terms (README "Metrics"). */
export function isTrueDeploymentSuccess(result: StageBResult): boolean {
  return (
    result.expectedDeployable &&
    result.mode === 'deploy' &&
    result.build.status === 'PASS' &&
    result.deployment.status === 'PASS' &&
    result.runtime.ecs === 'HEALTHY' &&
    result.runtime.alb === 'HEALTHY' &&
    result.runtime.https === 'PASS' &&
    result.dependencies.postgres !== 'FAIL' &&
    result.dependencies.redis !== 'FAIL' &&
    result.dependencies.storage !== 'FAIL' &&
    result.dependencies.migration !== 'FAIL' &&
    result.classification === 'PASS'
  );
}

// ── Files ────────────────────────────────────────────────────────────────

export function resultPath(runsDir: string, id: string): string {
  return join(runsDir, `${id}.json`);
}

export function readResult(runsDir: string, id: string): StageBResult | null {
  const path = resultPath(runsDir, id);
  if (!existsSync(path)) return null;
  return stageBResultSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function readAllResults(runsDir: string): StageBResult[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .filter((name) => /^repo-\d{3}\.json$/.test(name))
    .sort()
    .map((name) => stageBResultSchema.parse(JSON.parse(readFileSync(join(runsDir, name), 'utf8'))));
}

export interface WriteOptions {
  /** Overwrite a completed result, moving the previous one to history/. */
  force?: boolean | undefined;
}

/**
 * A gate-only result may always replace a gate-only result (the gate audit
 * is cheap and reruns on every analyser change). A `deploy` result is
 * protected: replacing it needs `force`, and the previous document is kept
 * under `history/<id>.<deployzCommit>.<n>.json`.
 */
export function writeResult(runsDir: string, result: StageBResult, options: WriteOptions = {}): { replaced: string | null } {
  mkdirSync(runsDir, { recursive: true });
  const path = resultPath(runsDir, result.id);
  const existing = readResult(runsDir, result.id);
  let replaced: string | null = null;
  if (existing && existing.mode === 'deploy') {
    if (!options.force) {
      throw new Error(`${result.id} already has a deployment result (${existing.classification}); rerun with --force to replace it`);
    }
    const historyDir = join(runsDir, 'history');
    mkdirSync(historyDir, { recursive: true });
    let n = 1;
    while (existsSync(join(historyDir, `${result.id}.${existing.deployzCommit.slice(0, 7)}.${n}.json`))) n += 1;
    replaced = join(historyDir, `${result.id}.${existing.deployzCommit.slice(0, 7)}.${n}.json`);
    renameSync(path, replaced);
  }
  writeFileSync(path, `${JSON.stringify(stageBResultSchema.parse(result), null, 2)}\n`);
  return { replaced };
}

/** The frozen first-run copy of an unseen-set result: written once, never replaced. */
export function writeFrozenIfAbsent(runsDir: string, result: StageBResult): boolean {
  const dir = join(runsDir, 'unseen-frozen');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${result.id}.json`);
  if (existsSync(path)) return false;
  writeFileSync(path, `${JSON.stringify(stageBResultSchema.parse(result), null, 2)}\n`);
  return true;
}

// ── Summary ──────────────────────────────────────────────────────────────

export interface StageBSummary {
  deployzCommit: string;
  total: number;
  expectedDeployable: number;
  expectedUnsupported: number;
  gate: { attempted: number; correctAccept: number; correctReject: number; falseAcceptance: number; falseRejection: number; configuredReady: number };
  build: { attempted: number; succeeded: number; failed: number; successRateAmongDeployable: number };
  infrastructure: { attempted: number; succeeded: number; failed: number };
  runtime: { ecsRunning: number; albHealthy: number; httpsReachable: number; applicationResponseValid: number };
  dependencies: { postgres: number; redis: number; storage: number; migration: number };
  trueDeploymentSuccess: number;
  trueDeploymentSuccessRate: number;
  cleanup: { destroys: number; destroyFailures: number; leaks: number; successRate: number };
  byClassification: Record<string, number>;
  byFailureStage: Record<string, number>;
  byRootCause: Record<string, number>;
  byFinding: Record<string, string[]>;
  bySet: Record<string, CohortBucket>;
  byCohort: Record<string, CohortBucket>;
}

export interface CohortBucket {
  total: number;
  expectedDeployable: number;
  deployed: number;
  trueDeploymentSuccess: number;
  expectedUnsupported: number;
  gateCorrect: number;
}

function percent(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 1000) / 10;
}

function count<T>(items: readonly T[], key: (item: T) => string | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    if (k === null) continue;
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export function buildStageBSummary(results: readonly StageBResult[], deployzCommit: string): StageBSummary {
  const deployable = results.filter((r) => r.expectedDeployable);
  const gated = results.filter((r) => r.gate.status !== 'NOT_ATTEMPTED');
  const built = results.filter((r) => r.build.status === 'PASS' || r.build.status === 'FAIL');
  const buildOk = results.filter((r) => r.build.status === 'PASS');
  const infra = results.filter((r) => r.deployment.status === 'PASS' || r.deployment.status === 'FAIL');
  const infraOk = results.filter((r) => r.deployment.status === 'PASS');
  const destroys = results.filter((r) => r.cleanup.status === 'PASS' || r.cleanup.status === 'FAIL');
  const trueSuccess = results.filter(isTrueDeploymentSuccess);

  const bucket = (key: (r: StageBResult) => string): Record<string, CohortBucket> => {
    const groups: Record<string, CohortBucket> = {};
    for (const r of results) {
      const b = (groups[key(r)] ??= { total: 0, expectedDeployable: 0, deployed: 0, trueDeploymentSuccess: 0, expectedUnsupported: 0, gateCorrect: 0 });
      b.total += 1;
      if (r.expectedDeployable) b.expectedDeployable += 1;
      else b.expectedUnsupported += 1;
      if (r.deployment.status === 'PASS') b.deployed += 1;
      if (isTrueDeploymentSuccess(r)) b.trueDeploymentSuccess += 1;
      if (r.gate.outcome === 'correct-accept' || r.gate.outcome === 'correct-reject') b.gateCorrect += 1;
    }
    return Object.fromEntries(Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)));
  };

  const byFinding: Record<string, string[]> = {};
  for (const r of results) {
    for (const id of r.findingIds) (byFinding[id] ??= []).push(r.id);
  }

  return {
    deployzCommit,
    total: results.length,
    expectedDeployable: deployable.length,
    expectedUnsupported: results.length - deployable.length,
    gate: {
      attempted: gated.length,
      correctAccept: gated.filter((r) => r.gate.outcome === 'correct-accept').length,
      correctReject: gated.filter((r) => r.gate.outcome === 'correct-reject').length,
      falseAcceptance: gated.filter((r) => r.gate.outcome === 'false-acceptance').length,
      falseRejection: gated.filter((r) => r.gate.outcome === 'false-rejection').length,
      configuredReady: gated.filter((r) => r.gate.configuredVerdict === 'READY').length,
    },
    build: {
      attempted: built.length,
      succeeded: buildOk.length,
      failed: built.length - buildOk.length,
      successRateAmongDeployable: percent(buildOk.filter((r) => r.expectedDeployable).length, deployable.length),
    },
    infrastructure: { attempted: infra.length, succeeded: infraOk.length, failed: infra.length - infraOk.length },
    runtime: {
      ecsRunning: results.filter((r) => r.runtime.ecs === 'HEALTHY').length,
      albHealthy: results.filter((r) => r.runtime.alb === 'HEALTHY').length,
      httpsReachable: results.filter((r) => r.runtime.https === 'PASS').length,
      applicationResponseValid: results.filter((r) => r.runtime.https === 'PASS' && r.classification === 'PASS').length,
    },
    dependencies: {
      postgres: results.filter((r) => r.dependencies.postgres === 'PASS').length,
      redis: results.filter((r) => r.dependencies.redis === 'PASS').length,
      storage: results.filter((r) => r.dependencies.storage === 'PASS').length,
      migration: results.filter((r) => r.dependencies.migration === 'PASS').length,
    },
    trueDeploymentSuccess: trueSuccess.length,
    trueDeploymentSuccessRate: percent(trueSuccess.length, deployable.length),
    cleanup: {
      destroys: destroys.length,
      destroyFailures: destroys.filter((r) => r.cleanup.status === 'FAIL').length,
      leaks: results.filter((r) => r.cleanup.leaks.length > 0).length,
      successRate: percent(destroys.filter((r) => r.cleanup.status === 'PASS').length, destroys.length),
    },
    byClassification: count(results, (r) => r.classification),
    byFailureStage: count(results, (r) => r.failureStage),
    byRootCause: count(results, (r) => r.rootCause),
    byFinding: Object.fromEntries(Object.entries(byFinding).sort(([a], [b]) => a.localeCompare(b))),
    bySet: bucket((r) => r.set),
    byCohort: bucket((r) => r.cohort),
  };
}

export function renderStageBSummary(results: readonly StageBResult[], summary: StageBSummary): string {
  const bucketRows = (groups: Record<string, CohortBucket>): string[] =>
    Object.entries(groups).map(
      ([name, b]) =>
        `| ${name} | ${b.total} | ${b.expectedDeployable} | ${b.expectedUnsupported} | ${b.gateCorrect} | ${b.deployed} | ${b.trueDeploymentSuccess} |`,
    );
  const lines: string[] = [
    '# Repository deployment audit — run summary',
    '',
    `Deployz commit: \`${summary.deployzCommit}\``,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Repositories | ${summary.total} |`,
    `| Expected deployable | ${summary.expectedDeployable} |`,
    `| Expected unsupported | ${summary.expectedUnsupported} |`,
    `| Gate: correct accept / correct reject | ${summary.gate.correctAccept} / ${summary.gate.correctReject} |`,
    `| Gate: false acceptance / false rejection | ${summary.gate.falseAcceptance} / ${summary.gate.falseRejection} |`,
    `| Gate: READY with the Stage B configuration | ${summary.gate.configuredReady} |`,
    `| Build attempted / succeeded / failed | ${summary.build.attempted} / ${summary.build.succeeded} / ${summary.build.failed} |`,
    `| Build success among expected deployable | ${summary.build.successRateAmongDeployable}% |`,
    `| Infrastructure attempted / succeeded / failed | ${summary.infrastructure.attempted} / ${summary.infrastructure.succeeded} / ${summary.infrastructure.failed} |`,
    `| Runtime: ECS running / ALB healthy / HTTPS reachable / application response valid | ${summary.runtime.ecsRunning} / ${summary.runtime.albHealthy} / ${summary.runtime.httpsReachable} / ${summary.runtime.applicationResponseValid} |`,
    `| Dependencies: PostgreSQL / Redis / storage / migration verified | ${summary.dependencies.postgres} / ${summary.dependencies.redis} / ${summary.dependencies.storage} / ${summary.dependencies.migration} |`,
    `| **True deployment success / expected deployable** | **${summary.trueDeploymentSuccess} / ${summary.expectedDeployable} (${summary.trueDeploymentSuccessRate}%)** |`,
    `| Cleanup: destroys / failures / leaks / success rate | ${summary.cleanup.destroys} / ${summary.cleanup.destroyFailures} / ${summary.cleanup.leaks} / ${summary.cleanup.successRate}% |`,
    '',
    '## By classification',
    '',
    '| Classification | Repositories |',
    '| --- | --- |',
    ...Object.entries(summary.byClassification).map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '## By root cause',
    '',
    '| Root cause | Repositories |',
    '| --- | --- |',
    ...Object.entries(summary.byRootCause).map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '## By finding',
    '',
    '| Finding | Repositories |',
    '| --- | --- |',
    ...Object.entries(summary.byFinding).map(([k, v]) => `| ${k} | ${v.length}: ${v.join(', ')} |`),
    '',
    '## By set',
    '',
    '| Set | Repositories | Expected deployable | Expected unsupported | Gate correct | Deployed | True success |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...bucketRows(summary.bySet),
    '',
    '## By cohort',
    '',
    '| Cohort | Repositories | Expected deployable | Expected unsupported | Gate correct | Deployed | True success |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...bucketRows(summary.byCohort),
    '',
    '## Repositories',
    '',
    '| Id | Repository | Cohort | Expected | Gate | Build | Deploy | Runtime | Cleanup | Result | Findings |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of results) {
    const runtime = r.runtime.ecs === 'NOT_ATTEMPTED' ? '—' : `${r.runtime.ecs}/${r.runtime.alb}/https ${r.runtime.https}`;
    lines.push(
      `| ${r.id} | ${r.repository}@${r.commit.slice(0, 7)} | ${r.cohort} | ${r.stageAExpected} | ${r.gate.verdict ?? '—'} (${r.gate.outcome ?? '—'}) | ${r.build.status} | ${r.deployment.status} | ${runtime} | ${r.cleanup.status} | ${r.classification}${r.rootCause ? ` / ${r.rootCause}` : ''} | ${r.findingIds.join(', ')} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

export function writeSummaryFiles(runsDir: string, results: readonly StageBResult[], summary: StageBSummary): void {
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(join(runsDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(runsDir, 'summary.md'), renderStageBSummary(results, summary));
}
