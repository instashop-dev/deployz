/**
 * Stage B repository-deployment audit runner.
 *
 *   pnpm benchmark:deploy --gate                       B1 (+ offline B2) over every repository, no AWS
 *   pnpm benchmark:deploy --gate --repo repo-001       one entry (repeat --repo for several)
 *   pnpm benchmark:deploy --dry-run --wave wave-1      print the plan, touch nothing
 *   pnpm benchmark:deploy --real-aws --repo repo-001   the whole funnel (needs DEPLOYZ_E2E_ALLOW_REAL_AWS=1)
 *   pnpm benchmark:deploy --real-aws --wave wave-1
 *   pnpm benchmark:deploy --real-aws --resume          finish unfinished cleanups, then continue the selection
 *   pnpm benchmark:deploy --cleanup --repo repo-001    Disconnect/Purge/leftovers/audit for the recorded ids
 *   pnpm benchmark:deploy --audit                      account scan for Stage B tags and recorded installations
 *
 * Reads docs/testing/repository-compatibility/benchmark.yaml (by id — never
 * copied) and docs/testing/repository-deployment/deploy-config.yaml, writes
 * docs/testing/repository-deployment/runs/<id>.json and the summaries.
 * Exit code 1 when the harness itself failed; a product failure is the
 * audit's subject, not a harness failure.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { ANALYSIS_VERSION } from '@deployz/api/analysis';

import { openAnalysisSession } from '../repository-compatibility/analyse.js';
import { loadBenchmark, selectEntries, type Benchmark, type BenchmarkEntry } from '../repository-compatibility/manifest.js';
import { createSnapshotFetch, resolveGithubToken } from '../repository-compatibility/snapshot.js';
import {
  albDnsName,
  auditLeaks,
  callerIdentity,
  createBootstrapStack,
  describeRunningService,
  describeStack,
  ecrDigestForTag,
  lambdaFunctionNames,
  listStackResources,
  resourcesTagged,
  targetHealth,
  templateBucketName,
} from '../version-canary/aws.js';
import { CANARY_TAGS, loadConfig, requireRealAwsOptIn, type CanaryConfig } from '../version-canary/config.js';
import { ControlPlane, sleep } from '../version-canary/control-plane.js';
import { Evidence } from '../version-canary/evidence.js';
import { destroyThroughProduct, leakAudit, removeCanaryLeftovers } from '../version-canary/teardown.js';
import { applyCleanupToClassification, cleanupAttempt } from './cleanup.js';
import { configFor, loadDeployConfig, type DeployConfig, type RepositoryConfig } from './config.js';
import { runRepositoryAttempt, DEFAULT_TIMEOUTS, type DeployDeps } from './deploy.js';
import { describeDependencies, describeStoppedTasks, describeTaskDefinitionEnv, tailApplicationLogs } from './evidence.js';
import { gateSection } from './gate.js';
import { listUnfinishedLedgers, openLedger, readSeries, stageBRun, stageBRunId, writeSeries, type StageBRunRecord } from './ledger.js';
import {
  buildStageBSummary,
  emptyResult,
  readAllResults,
  readResult,
  writeFrozenIfAbsent,
  writeResult,
  writeSummaryFiles,
  type StageBResult,
} from './results.js';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..', '..');
export const STAGE_A_DIR = join(REPO_ROOT, 'docs', 'testing', 'repository-compatibility');
export const BENCHMARK_PATH = join(STAGE_A_DIR, 'benchmark.yaml');
export const STAGE_B_DIR = join(REPO_ROOT, 'docs', 'testing', 'repository-deployment');
export const DEPLOY_CONFIG_PATH = join(STAGE_B_DIR, 'deploy-config.yaml');
export const RUNS_DIR = join(STAGE_B_DIR, 'runs');
export const EVIDENCE_DIR = join(RUNS_DIR, 'evidence');
export const CACHE_DIR = join(STAGE_A_DIR, '.cache');

export const TEMPLATE_MODES = ['pinned', 'generic', 'production'] as const;
export type TemplateMode = (typeof TEMPLATE_MODES)[number];

export interface RunOptions {
  ids: string[];
  set: string | undefined;
  cohort: string | undefined;
  wave: string | undefined;
  finding: string | undefined;
  gate: boolean;
  dryRun: boolean;
  realAws: boolean;
  resume: boolean;
  cleanup: boolean;
  audit: boolean;
  force: boolean;
  keep: boolean;
  offline: boolean;
  concurrency: number;
  template: TemplateMode;
  cacheDir: string;
  evidenceDir: string;
  runsDir: string;
}

export function parseRunArgs(argv: readonly string[]): RunOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      repo: { type: 'string', multiple: true },
      set: { type: 'string' },
      cohort: { type: 'string' },
      wave: { type: 'string' },
      finding: { type: 'string' },
      gate: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'real-aws': { type: 'boolean', default: false },
      resume: { type: 'boolean', default: false },
      cleanup: { type: 'boolean', default: false },
      audit: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      keep: { type: 'boolean', default: false },
      online: { type: 'boolean', default: false },
      concurrency: { type: 'string' },
      template: { type: 'string' },
      cache: { type: 'string' },
      'evidence-dir': { type: 'string' },
      'runs-dir': { type: 'string' },
    },
    strict: true,
  });
  const concurrency = values.concurrency ? Number(values.concurrency) : 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) throw new Error('--concurrency must be 1 or 2');
  const template = (values.template ?? 'pinned') as TemplateMode;
  if (!TEMPLATE_MODES.includes(template)) throw new Error(`--template must be one of ${TEMPLATE_MODES.join(', ')}`);
  const modes = [values.gate, values['dry-run'], values['real-aws'], values.cleanup, values.audit].filter(Boolean).length;
  if (modes === 0 && !values.resume) throw new Error('choose a mode: --gate, --dry-run, --real-aws, --cleanup or --audit');
  if (values['real-aws'] && values.gate) throw new Error('--gate and --real-aws are exclusive (the funnel runs the gate itself)');
  return {
    ids: values.repo ?? [],
    set: values.set,
    cohort: values.cohort,
    wave: values.wave,
    finding: values.finding,
    gate: values.gate ?? false,
    dryRun: values['dry-run'] ?? false,
    realAws: values['real-aws'] ?? false,
    resume: values.resume ?? false,
    cleanup: values.cleanup ?? false,
    audit: values.audit ?? false,
    force: values.force ?? false,
    keep: values.keep ?? false,
    offline: !(values.online ?? false),
    concurrency,
    template,
    cacheDir: values.cache ? resolve(values.cache) : CACHE_DIR,
    evidenceDir: values['evidence-dir'] ? resolve(values['evidence-dir']) : EVIDENCE_DIR,
    runsDir: values['runs-dir'] ? resolve(values['runs-dir']) : RUNS_DIR,
  };
}

/**
 * Real AWS needs both the environment opt-in every live suite shares and
 * the explicit flag; a dry run never needs either, and never reads AWS.
 */
export function requireRealAws(options: RunOptions, env: NodeJS.ProcessEnv): void {
  if (!(options.realAws || options.cleanup || options.audit || options.resume)) return;
  requireRealAwsOptIn(env);
  if (!options.realAws && !options.cleanup && !options.audit && !options.resume) {
    throw new Error('real AWS needs --real-aws');
  }
}

/** Selection by id, set, cohort, wave and finding — every filter narrows. */
export function selectForRun(
  benchmark: Benchmark,
  config: DeployConfig,
  options: Pick<RunOptions, 'ids' | 'set' | 'cohort' | 'wave' | 'finding'>,
  existing: readonly StageBResult[] = [],
): BenchmarkEntry[] {
  let entries = selectEntries(benchmark, { ids: options.ids, set: options.set });
  if (options.cohort !== undefined) entries = entries.filter((entry) => entry.cohort === options.cohort);
  if (options.wave !== undefined) {
    const members = config.waves[options.wave];
    if (!members) throw new Error(`unknown wave ${options.wave}`);
    const order = new Map(members.map((id, index) => [id, index]));
    for (const id of members) {
      if (!benchmark.repositories.some((entry) => entry.id === id)) throw new Error(`wave ${options.wave} names unknown repository ${id}`);
    }
    entries = entries.filter((entry) => order.has(entry.id)).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  }
  if (options.finding !== undefined) {
    const affected = new Set(existing.filter((result) => result.findingIds.includes(options.finding!)).map((result) => result.id));
    entries = entries.filter((entry) => affected.has(entry.id));
  }
  return entries;
}

export function deployzSha(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

export function identityFor(entry: BenchmarkEntry, sha: string, mode: StageBResult['mode'], runId: string | null): Parameters<typeof emptyResult>[0] {
  return {
    id: entry.id,
    repository: entry.repository,
    commit: entry.commit,
    set: entry.set,
    cohort: entry.cohort,
    customerRealism: entry.customer_realism,
    difficulty: entry.difficulty,
    deployzCommit: sha,
    runId,
    stageAExpected: entry.expected.compatibility,
    mode,
  };
}

/** The fork Deployz is pointed at for a repository (README "Repository access"). */
export function repositoryUsedFor(entry: BenchmarkEntry, config: RepositoryConfig): { repositoryUsed: string; repositoryForm: 'original' | 'fork' } {
  if (config.fork) return { repositoryUsed: config.fork, repositoryForm: 'fork' };
  const repo = entry.repository.split('/')[1]!;
  return { repositoryUsed: `instashop-dev/${repo}`, repositoryForm: 'fork' };
}

// ── The plan (dry run) ──────────────────────────────────────────────────────

export interface PlanLine {
  id: string;
  repository: string;
  expected: string;
  action: 'gate-only' | 'full-funnel' | 'skip-has-result';
  repositoryUsed: string;
  configuredKeys: string[];
  overrides: string[];
}

export function buildPlan(entries: readonly BenchmarkEntry[], config: DeployConfig, existing: readonly StageBResult[], options: Pick<RunOptions, 'gate' | 'force'>): PlanLine[] {
  return entries.map((entry) => {
    const repoConfig = configFor(config, entry.id);
    const has = existing.find((result) => result.id === entry.id);
    const expectedDeployable = entry.expected.compatibility !== 'NOT_COMPATIBLE';
    let action: PlanLine['action'] = options.gate || !expectedDeployable ? 'gate-only' : 'full-funnel';
    if (!options.gate && has && has.mode === 'deploy' && !options.force) action = 'skip-has-result';
    return {
      id: entry.id,
      repository: entry.repository,
      expected: entry.expected.compatibility,
      action,
      repositoryUsed: repositoryUsedFor(entry, repoConfig).repositoryUsed,
      configuredKeys: [...(repoConfig.config ?? []).map((v) => v.key), ...(repoConfig.secrets ?? [])],
      overrides: Object.keys(repoConfig.overrides ?? {}),
    };
  });
}

export function renderPlan(plan: readonly PlanLine[], options: Pick<RunOptions, 'template' | 'concurrency'>): string {
  const lines = [
    `Stage B plan — ${plan.length} repositories, template ${options.template}, concurrency ${options.concurrency}`,
    ...plan.map((line) => `${line.id} ${line.repository} expected ${line.expected} → ${line.action}${line.overrides.length ? ` overrides[${line.overrides.join(',')}]` : ''}${line.configuredKeys.length ? ` keys[${line.configuredKeys.join(',')}]` : ''}`),
    `full funnel: ${plan.filter((l) => l.action === 'full-funnel').length}, gate only: ${plan.filter((l) => l.action === 'gate-only').length}, skipped: ${plan.filter((l) => l.action === 'skip-has-result').length}`,
  ];
  return lines.join('\n');
}

// ── Gate audit (B1 + offline B2) ───────────────────────────────────────────

export async function runGateAudit(
  entries: readonly BenchmarkEntry[],
  config: DeployConfig,
  options: Pick<RunOptions, 'offline' | 'cacheDir' | 'runsDir'>,
  sha: string,
): Promise<StageBResult[]> {
  const token = options.offline ? null : resolveGithubToken();
  const fetchFn = createSnapshotFetch({ cacheDir: options.cacheDir, token, offline: options.offline });
  const session = await openAnalysisSession(fetchFn);
  const results: StageBResult[] = [];
  try {
    for (const entry of entries) {
      process.stdout.write(`${entry.id} ${entry.repository}@${entry.commit.slice(0, 7)} … `);
      const repoConfig = configFor(config, entry.id);
      const existing = readResult(options.runsDir, entry.id);
      const result = existing ?? emptyResult(identityFor(entry, sha, 'gate', null));
      const raw = await session.analyse(entry);
      const { gate } = gateSection(entry, raw, repoConfig, ANALYSIS_VERSION);
      result.gate = gate;
      if (!existing || existing.mode === 'gate') {
        result.deployzCommit = sha;
        result.mode = 'gate';
        const unsupported = !result.expectedDeployable && gate.verdict === 'NOT_COMPATIBLE';
        result.classification = unsupported ? 'EXPECTED_UNSUPPORTED' : gate.status === 'PASS' ? 'PASS' : 'GATE_ERROR';
        result.failureStage = unsupported ? 'EXPECTED_UNSUPPORTED' : gate.status === 'PASS' ? null : 'GATE_ERROR';
        result.rootCause = unsupported ? 'CORRECTLY_UNSUPPORTED' : null;
        result.rootCauseEvidence = unsupported
          ? `rejected on ${gate.unsupported.join(', ') || 'the gate findings'}`
          : gate.status === 'PASS'
            ? null
            : `${gate.outcome ?? 'no verdict'}: ${gate.detail ?? gate.gateFindings.join(', ')}`;
      }
      writeResult(options.runsDir, result, { force: true });
      results.push(result);
      console.log(`${gate.verdict ?? 'FAILED'} (${gate.outcome ?? gate.detail ?? '—'}) configured→${gate.configuredVerdict ?? '—'}`);
    }
  } finally {
    await session.close();
  }
  return results;
}

// ── Real AWS ───────────────────────────────────────────────────────────────

interface Series {
  config: CanaryConfig;
  api: ControlPlane;
  sha: string;
}

async function ensureVendor(evidenceDir: string, config: CanaryConfig): Promise<ControlPlane> {
  const api = new ControlPlane(config.apiUrl, config.webUrl);
  const series = readSeries(evidenceDir);
  if (series.vendor) {
    await api.signIn(series.vendor);
    return api;
  }
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const vendor = { email: `stage-b-${stamp}@deployz-stage-b.example.com`, password: `StageB-${stamp}-${Math.random().toString(36).slice(2, 12)}` };
  await api.signUp({ name: `Stage B ${stamp}`, ...vendor });
  writeSeries(evidenceDir, { ...series, vendor });
  return api;
}

/** One organization per attempt: the product allows one application per repository per organization. */
async function createAttemptOrganization(api: ControlPlane, name: string): Promise<string> {
  const { body } = await api.request<{ id: string }>('POST', '/api/organizations', { name });
  await api.request('POST', `/api/organizations/${body.id}/activate`, {});
  return body.id;
}

function publishPinnedTemplateWith(config: CanaryConfig, region: string) {
  return async (imageDigest: string, keyPrefix: string): Promise<string> => {
    const identity = await callerIdentity();
    const repository = `${identity.account}.dkr.ecr.${region}.amazonaws.com/deployz-images`;
    const output = execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--filter', '@deployz/cdk', 'run', 'publish:application'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, AWS_REGION: region, APP_IMAGE_REPOSITORY: repository, APP_IMAGE_DIGEST: imageDigest, APPLICATION_KEY_PREFIX: keyPrefix },
      shell: process.platform === 'win32',
    });
    const match = /template\s+(https:\/\/\S+)/.exec(output);
    if (!match?.[1]) throw new Error(`publish:application printed no template URL:\n${output}`);
    void config;
    return match[1];
  };
}

async function probe(url: string): Promise<{ status: number | null; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    return { status: response.status };
  } catch (error) {
    return { status: null, error: String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function realDeps(series: Series, options: RunOptions, templateUrl: string | null): DeployDeps {
  const region = series.config.region;
  return {
    api: series.api,
    aws: {
      createBootstrapStack: (input) => createBootstrapStack(region, input),
      describeStack: (name) => describeStack(region, name),
      lambdaFunctionNames: (name) => lambdaFunctionNames(region, name),
      describeRunningService: (name) => describeRunningService(region, name),
      targetHealth: (name) => targetHealth(region, name),
      albDnsName: (name) => albDnsName(region, name),
      ecrDigestForTag: (tag) => ecrDigestForTag(region, 'deployz-images', tag),
      listStackResources: (name) => listStackResources(region, name),
      describeStoppedTasks: (name) => describeStoppedTasks(region, name),
      tailApplicationLogs: (name) => tailApplicationLogs(region, name),
      describeDependencies: (name) => describeDependencies(region, name),
      describeTaskDefinitionEnv: (name) => describeTaskDefinitionEnv(region, name),
    },
    probe,
    sleep,
    now: Date.now,
    region,
    githubInstallationId: series.config.githubInstallationId,
    templateUrl,
    templateSource: options.template === 'pinned' ? 'stage-b-pinned' : options.template === 'generic' ? 'stage-b-generic' : 'production-default',
    publishPinnedTemplate: options.template === 'pinned' ? publishPinnedTemplateWith(series.config, region) : undefined,
    timeouts: DEFAULT_TIMEOUTS,
    keep: options.keep,
  };
}

async function runAttempt(series: Series, options: RunOptions, config: DeployConfig, entry: BenchmarkEntry): Promise<StageBResult> {
  const repoConfig = configFor(config, entry.id);
  const runId = stageBRunId(entry.id);
  const result = emptyResult(identityFor(entry, series.sha, 'deploy', runId));
  const evidence = openLedger(
    options.evidenceDir,
    series.config,
    { repoId: entry.id, repository: entry.repository, commit: entry.commit, deployzCommit: series.sha, cleanupNeeded: false },
    runId,
  );
  console.log(`\n=== ${entry.id} ${entry.repository}@${entry.commit.slice(0, 7)} — run ${runId} (evidence ${evidence.dir})`);
  const organizationId = await createAttemptOrganization(series.api, `Stage B ${entry.id} ${runId.slice(-9)}`);
  stageBRun(evidence).stageB.organizationId = organizationId;
  evidence.save();
  const { repositoryUsed, repositoryForm } = repositoryUsedFor(entry, repoConfig);
  if (options.template === 'generic') throw new Error('--template generic is not available until DEPLOY-001 is fixed and a generic template is published');
  const deps = realDeps(series, options, null);
  try {
    await runRepositoryAttempt(deps, { benchmark: entry, config: repoConfig, repositoryUsed, repositoryForm, evidence, result });
  } finally {
    if (options.keep) {
      console.log('--keep set: leaving the environment in place. Run --cleanup --repo later.');
      stageBRun(evidence).stageB.cleanupNeeded = true;
      evidence.save();
    } else {
      await cleanupAttempt({ config: series.config, api: series.api, evidence, teardown: { destroyThroughProduct, removeCanaryLeftovers, leakAudit }, now: Date.now }, result);
      applyCleanupToClassification(result);
    }
    evidence.finish(result.classification === 'PASS' || result.classification === 'EXPECTED_UNSUPPORTED' ? 'PASS' : 'FAIL');
  }
  return result;
}

async function cleanupLedger(series: Series, options: RunOptions, runId: string): Promise<void> {
  const evidence = Evidence.open(options.evidenceDir, runId);
  const run = stageBRun(evidence);
  console.log(`\n=== cleanup ${run.stageB.repoId} — run ${runId}`);
  const result = readResult(options.runsDir, run.stageB.repoId) ?? emptyResult({
    id: run.stageB.repoId,
    repository: run.stageB.repository,
    commit: run.stageB.commit,
    set: 'improvement',
    cohort: 'realistic',
    customerRealism: 'high',
    difficulty: 1,
    deployzCommit: run.stageB.deployzCommit,
    runId,
    stageAExpected: 'READY',
    mode: 'deploy',
  });
  if (run.stageB.organizationId) await series.api.request('POST', `/api/organizations/${run.stageB.organizationId}/activate`, {});
  await cleanupAttempt({ config: series.config, api: series.api, evidence, teardown: { destroyThroughProduct, removeCanaryLeftovers, leakAudit }, now: Date.now }, result);
  applyCleanupToClassification(result);
  if (readResult(options.runsDir, run.stageB.repoId)) writeResult(options.runsDir, result, { force: true });
  evidence.save();
}

export async function auditAccount(config: CanaryConfig, evidenceDir: string): Promise<{ runTagged: string[]; installations: Record<string, string[]> }> {
  const tagged = await resourcesTagged(config.region, CANARY_TAGS.testMode, 'canary');
  const runTagged = tagged.filter((arn) => !arn.includes(':cluster/') && !arn.includes(':task-definition/') && !arn.includes(':service/'));
  const installations: Record<string, string[]> = {};
  for (const ledger of listUnfinishedLedgers(evidenceDir)) {
    const run = JSON.parse((await import('node:fs')).readFileSync(ledger.path, 'utf8')) as StageBRunRecord;
    if (!run.installationId) continue;
    const audit = await auditLeaks(config.region, {
      installationId: run.installationId,
      runId: run.runId,
      bootstrapStackName: run.bootstrapStackName ?? null,
      applicationStackName: run.applicationStackName ?? null,
      bootstrapLambdaNames: run.bootstrapLambdaNames ?? [],
      deploymentId: run.deploymentId ?? null,
      ecrRepository: 'deployz-images',
      ecrTags: Object.values(run.releases).map((r) => r.version),
    });
    installations[run.runId] = [
      ...audit.stacks.map((s) => `stack ${s.name} ${s.status}`),
      ...audit.rdsInstances.map((r) => `rds ${r}`),
      ...audit.loadBalancers.map((l) => `alb ${l}`),
      ...audit.buckets.map((b) => `bucket ${b}`),
      ...audit.secrets.map((s) => `secret ${s}`),
      ...audit.logGroups.map((l) => `log-group ${l}`),
      ...audit.ssmParameters.map((p) => `ssm ${p}`),
      ...audit.certificates.map((c) => `acm ${c}`),
      ...audit.ecrTags.map((t) => `ecr ${t}`),
    ];
  }
  return { runTagged, installations };
}

async function pool<T>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

function writeSummaries(runsDir: string, sha: string): void {
  const all = readAllResults(runsDir);
  writeSummaryFiles(runsDir, all, buildStageBSummary(all, sha));
}

async function main(): Promise<number> {
  const options = parseRunArgs(process.argv.slice(2));
  const benchmark = loadBenchmark(BENCHMARK_PATH);
  const config = loadDeployConfig(DEPLOY_CONFIG_PATH);
  for (const entry of config.repositories) {
    if (!benchmark.repositories.some((b) => b.id === entry.id)) throw new Error(`deploy-config names unknown repository ${entry.id}`);
  }
  const sha = deployzSha();
  const existing = readAllResults(options.runsDir);
  const entries = selectForRun(benchmark, config, options, existing);

  if (options.dryRun) {
    console.log(renderPlan(buildPlan(entries, config, existing, options), options));
    return 0;
  }

  if (options.gate) {
    if (entries.length === 0) {
      console.error('No repositories selected.');
      return 1;
    }
    await runGateAudit(entries, config, options, sha);
    writeSummaries(options.runsDir, sha);
    console.log(`Wrote ${entries.length} result file(s) to ${options.runsDir}`);
    return 0;
  }

  requireRealAws(options, process.env);
  const canaryConfig = loadConfig(process.env);
  const identity = await callerIdentity();
  if (identity.account !== canaryConfig.expectedAccountId) {
    throw new Error(`AWS account ${identity.account} is not the expected test account ${canaryConfig.expectedAccountId} — refusing to run`);
  }

  if (options.audit) {
    const audit = await auditAccount(canaryConfig, options.evidenceDir);
    console.log(JSON.stringify(audit, null, 2));
    const leaks = audit.runTagged.length + Object.values(audit.installations).reduce((n, list) => n + list.length, 0);
    console.log(leaks === 0 ? 'No Stage B resources left.' : `${leaks} resource(s) still attributable to Stage B.`);
    return leaks === 0 ? 0 : 1;
  }

  const api = await ensureVendor(options.evidenceDir, canaryConfig);
  const series: Series = { config: canaryConfig, api, sha };

  if (options.cleanup) {
    const ledgers = listUnfinishedLedgers(options.evidenceDir).filter((l) => options.ids.length === 0 || options.ids.includes(l.repoId));
    if (ledgers.length === 0) {
      console.log('Nothing to clean up.');
      return 0;
    }
    for (const ledger of ledgers) await cleanupLedger(series, options, ledger.runId);
    writeSummaries(options.runsDir, sha);
    return 0;
  }

  if (options.resume) {
    for (const ledger of listUnfinishedLedgers(options.evidenceDir)) await cleanupLedger(series, options, ledger.runId);
  }

  const health = await fetch(`${canaryConfig.apiUrl}/health`);
  if (health.status !== 200) throw new Error(`control plane ${canaryConfig.apiUrl}/health answered ${health.status}`);
  await templateBucketName(canaryConfig.region);

  const plan = buildPlan(entries, config, existing, options);
  console.log(renderPlan(plan, options));
  const todo = plan.filter((line) => line.action !== 'skip-has-result');
  const failures: string[] = [];
  await pool(todo, options.concurrency, async (line) => {
    const entry = entries.find((e) => e.id === line.id)!;
    try {
      let result: StageBResult;
      if (line.action === 'gate-only') {
        // Expected unsupported: the gate audit is the whole funnel, and the
        // control-plane gate is exercised without creating AWS resources.
        result = (await runGateAudit([entry], config, options, sha))[0]!;
      } else {
        result = await runAttempt(series, options, config, entry);
        writeResult(options.runsDir, result, { force: options.force });
        if (entry.set !== 'improvement') writeFrozenIfAbsent(options.runsDir, result);
      }
      console.log(`${entry.id}: ${result.classification}${result.rootCause ? ` (${result.rootCause})` : ''}`);
    } catch (error) {
      failures.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
      console.error(`${entry.id}: harness failure — ${error instanceof Error ? error.message : String(error)}`);
    }
    writeSummaries(options.runsDir, sha);
  });
  if (failures.length > 0) {
    console.error(`\n${failures.length} harness failure(s):\n${failures.join('\n')}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
