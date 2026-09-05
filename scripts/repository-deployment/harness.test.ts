import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadBenchmark, parseBenchmark, type BenchmarkEntry } from '../repository-compatibility/manifest.js';
import { loadConfig } from '../version-canary/config.js';
import type { DeploymentDetail } from '../version-canary/control-plane.js';
import { applyCleanupToClassification, cleanupAttempt } from './cleanup.js';
import { classifyFailure } from './classify.js';
import { appUrlKeys, configFor, loadDeployConfig, parseDeployConfig, providedKeys } from './config.js';
import { defaultDeploymentUrl, generateSecret, runRepositoryAttempt, resolveHealthPath, DEFAULT_TIMEOUTS, type AwsLike, type ControlPlaneLike, type DeployDeps } from './deploy.js';
import { sanitize } from './evidence.js';
import { gateOutcome, manifestFacts, missingKeys, overridesToManifest } from './gate.js';
import { listUnfinishedLedgers, openLedger, readSeries, stageBRun, stageBRunId, writeSeries } from './ledger.js';
import {
  BENCHMARK_PATH,
  DEPLOY_CONFIG_PATH,
  STAGE_B_DIR,
  buildPlan,
  identityFor,
  parseRunArgs,
  renderPlan,
  repositoryUsedFor,
  requireRealAws,
  selectForRun,
  shouldStopWave,
} from './index.js';
import {
  CLASSIFICATIONS,
  FAILURE_STAGES,
  ROOT_CAUSES,
  buildStageBSummary,
  emptyResult,
  isTrueDeploymentSuccess,
  readResult,
  renderStageBSummary,
  stageBResultSchema,
  writeFrozenIfAbsent,
  writeResult,
  type StageBResult,
} from './results.js';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

const BENCHMARK = parseBenchmark(`
version: 1
findings: []
repositories:
  - id: repo-001
    repository: acme/api
    commit: ${SHA}
    cohort: realistic
    set: improvement
    expected:
      compatibility: NEEDS_CONFIGURATION
      runtime: [node]
      monorepo: false
      postgres: true
      redis: false
      worker: false
      healthPath: /healthz
    customer_realism: high
    difficulty: 2
  - id: repo-002
    repository: acme/worker
    commit: ${OTHER_SHA}
    cohort: boundary
    set: unseen
    expected:
      compatibility: NOT_COMPATIBLE
      runtime: [python]
      monorepo: false
      postgres: false
      redis: true
      worker: true
      unsupported: [kafka]
    customer_realism: medium
    difficulty: 3
`);

const DEPLOY_CONFIG = parseDeployConfig(`
version: 1
waves:
  wave-1: [repo-002, repo-001]
repositories:
  - id: repo-001
    overrides:
      containerPort: 3000
      healthPath: /healthz
    config:
      - { key: DB_CLIENT, value: pg }
      - { key: APP_URL, value: '\${DEPLOYZ_APP_URL}/app' }
    secrets: [JWT_SECRET, { key: SECRET_KEY, format: hex64 }]
    verify:
      appPath: /
      observationSeconds: 30
`);

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'stage-b-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('deploy-config', () => {
  it('parses and defaults', () => {
    expect(DEPLOY_CONFIG.waves['wave-1']).toEqual(['repo-002', 'repo-001']);
    expect(configFor(DEPLOY_CONFIG, 'repo-001').secrets).toEqual(['JWT_SECRET', { key: 'SECRET_KEY', format: 'hex64' }]);
    expect(configFor(DEPLOY_CONFIG, 'repo-999')).toEqual({ id: 'repo-999', findings: [], notes: [] });
    expect(providedKeys(configFor(DEPLOY_CONFIG, 'repo-001'))).toEqual(['APP_URL', 'DB_CLIENT', 'JWT_SECRET', 'SECRET_KEY']);
    expect(appUrlKeys(configFor(DEPLOY_CONFIG, 'repo-001'))).toEqual(['APP_URL']);
    expect(generateSecret('hex64')).toMatch(/^[0-9a-f]{64}$/);
    expect(generateSecret('hex32')).toMatch(/^[0-9a-f]{32}$/);
    expect(generateSecret('password')).toMatch(/^Sb-[A-Za-z0-9_-]+-1$/);
    expect(generateSecret('base64url')).not.toBe(generateSecret('base64url'));
  });

  it('refuses duplicates, a key both configured and generated, an unknown field, and a repeated wave member', () => {
    expect(() => parseDeployConfig('version: 1\nrepositories:\n  - id: repo-001\n  - id: repo-001\n')).toThrow('duplicate repository config repo-001');
    expect(() => parseDeployConfig('version: 1\nrepositories:\n  - id: repo-001\n    config: [{ key: A, value: x }]\n    secrets: [A]\n')).toThrow('both configures and generates A');
    expect(() => parseDeployConfig('version: 1\nrepositories:\n  - id: repo-001\n    config: [{ key: A, value: x }, { key: A, value: y }]\n')).toThrow('configures A twice');
    expect(() => parseDeployConfig('version: 1\nrepositories:\n  - id: repo-001\n    port: 3000\n')).toThrow();
    expect(() => parseDeployConfig('version: 1\nwaves:\n  w: [repo-001, repo-001]\n')).toThrow('wave w lists a repository twice');
  });

  it('never accepts a secret value', () => {
    expect(() => parseDeployConfig('version: 1\nrepositories:\n  - id: repo-001\n    secrets: [{ key: A, value: x }]\n')).toThrow();
    expect(() => parseDeployConfig('version: 1\nrepositories:\n  - id: repo-001\n    secrets: [{ key: A, format: plain }]\n')).toThrow();
  });

  it('parses the committed deploy-config and references only Stage A ids', () => {
    const benchmark = loadBenchmark(BENCHMARK_PATH);
    const config = loadDeployConfig(DEPLOY_CONFIG_PATH);
    const ids = new Set(benchmark.repositories.map((entry) => entry.id));
    for (const entry of config.repositories) expect(ids, `${entry.id} is not a Stage A id`).toContain(entry.id);
    for (const members of Object.values(config.waves)) for (const id of members) expect(ids).toContain(id);
    const registry = new Set([...readFileSync(join(STAGE_B_DIR, 'findings.md'), 'utf8').matchAll(/^\| (DEPLOY-\d{3}) \|/gm)].map((m) => m[1]!));
    for (const entry of config.repositories) for (const id of entry.findings) expect(registry, `${entry.id} references unregistered ${id}`).toContain(id);
  });
});

describe('result model', () => {
  it('starts every stage NOT_ATTEMPTED and validates against the schema', () => {
    const result = emptyResult(identityFor(BENCHMARK.repositories[0]!, SHA, 'gate', null));
    expect(() => stageBResultSchema.parse(result)).not.toThrow();
    expect(result.expectedDeployable).toBe(true);
    expect(emptyResult(identityFor(BENCHMARK.repositories[1]!, SHA, 'gate', null)).expectedDeployable).toBe(false);
  });

  it('accepts only the documented vocabularies', () => {
    const readme = readFileSync(join(STAGE_B_DIR, 'README.md'), 'utf8');
    for (const stage of FAILURE_STAGES) expect(readme).toContain(stage);
    for (const cause of ROOT_CAUSES) expect(readme).toContain(cause);
    expect(CLASSIFICATIONS).toContain('PASS');
    const result = emptyResult(identityFor(BENCHMARK.repositories[0]!, SHA, 'gate', null));
    expect(() => stageBResultSchema.parse({ ...result, classification: 'SOMETHING_ELSE' })).toThrow();
    expect(() => stageBResultSchema.parse({ ...result, rootCause: 'USER_ERROR' })).toThrow();
    expect(() => stageBResultSchema.parse({ ...result, findingIds: ['COMP-001'] })).toThrow();
  });

  it('protects a deployment result and keeps history only with --force', () => {
    const runs = join(tmp, 'runs-protect');
    const gate = emptyResult(identityFor(BENCHMARK.repositories[0]!, SHA, 'gate', null));
    writeResult(runs, gate);
    writeResult(runs, gate); // a gate result always replaces a gate result
    const deploy = { ...emptyResult(identityFor(BENCHMARK.repositories[0]!, SHA, 'deploy', 'run-1')), classification: 'PASS' as const, failureStage: null, rootCause: null };
    writeResult(runs, deploy);
    expect(() => writeResult(runs, deploy)).toThrow('rerun with --force');
    const { replaced } = writeResult(runs, { ...deploy, deployzCommit: OTHER_SHA }, { force: true });
    expect(replaced).toMatch(/history[\\/]repo-001\.aaaaaaa\.1\.json$/);
    expect(readResult(runs, 'repo-001')?.deployzCommit).toBe(OTHER_SHA);
  });

  it('writes the frozen unseen copy once', () => {
    const runs = join(tmp, 'runs-frozen');
    const result = emptyResult(identityFor(BENCHMARK.repositories[1]!, SHA, 'deploy', 'run-1'));
    expect(writeFrozenIfAbsent(runs, result)).toBe(true);
    expect(writeFrozenIfAbsent(runs, { ...result, deployzCommit: OTHER_SHA })).toBe(false);
    expect(JSON.parse(readFileSync(join(runs, 'unseen-frozen', 'repo-002.json'), 'utf8')).deployzCommit).toBe(SHA);
  });

  it('summarizes the funnel and the true-deployment-success metric', () => {
    const pass: StageBResult = {
      ...emptyResult(identityFor(BENCHMARK.repositories[0]!, SHA, 'deploy', 'run-1')),
      gate: { ...emptyResult(identityFor(BENCHMARK.repositories[0]!, SHA, 'deploy', 'run-1')).gate, status: 'PASS', verdict: 'NEEDS_CONFIGURATION', outcome: 'correct-accept', configuredVerdict: 'READY', missingKeys: ['APP_KEY'] },
      build: { ...emptyResult(identityFor(BENCHMARK.repositories[0]!, SHA, 'deploy', 'run-1')).build, status: 'PASS' },
      deployment: { ...emptyResult(identityFor(BENCHMARK.repositories[0]!, SHA, 'deploy', 'run-1')).deployment, status: 'PASS' },
      runtime: { ...emptyResult(identityFor(BENCHMARK.repositories[0]!, SHA, 'deploy', 'run-1')).runtime, ecs: 'HEALTHY', alb: 'HEALTHY', https: 'PASS' },
      dependencies: { postgres: 'PASS', redis: 'NOT_REQUIRED', storage: 'NOT_REQUIRED', migration: 'NOT_REQUIRED', detail: null },
      cleanup: { ...emptyResult(identityFor(BENCHMARK.repositories[0]!, SHA, 'deploy', 'run-1')).cleanup, status: 'PASS' },
      classification: 'PASS',
      failureStage: null,
      rootCause: null,
      rootCauseEvidence: null,
    };
    const unsupported: StageBResult = {
      ...emptyResult(identityFor(BENCHMARK.repositories[1]!, SHA, 'gate', null)),
      gate: { ...emptyResult(identityFor(BENCHMARK.repositories[1]!, SHA, 'gate', null)).gate, status: 'PASS', verdict: 'NOT_COMPATIBLE', outcome: 'correct-reject' },
      classification: 'EXPECTED_UNSUPPORTED',
      failureStage: 'EXPECTED_UNSUPPORTED',
      rootCause: 'CORRECTLY_UNSUPPORTED',
      findingIds: ['DEPLOY-001'],
    };
    expect(isTrueDeploymentSuccess(pass)).toBe(true);
    expect(isTrueDeploymentSuccess({ ...pass, dependencies: { ...pass.dependencies, postgres: 'FAIL' } })).toBe(false);
    const summary = buildStageBSummary([pass, unsupported], SHA);
    expect(summary.expectedDeployable).toBe(1);
    expect(summary.expectedUnsupported).toBe(1);
    expect(summary.gate.correctAccept).toBe(1);
    expect(summary.gate.correctReject).toBe(1);
    expect(summary.trueDeploymentSuccess).toBe(1);
    expect(summary.trueDeploymentSuccessRate).toBe(100);
    expect(summary.cleanup.successRate).toBe(100);
    expect(summary.byFinding['DEPLOY-001']).toEqual(['repo-002']);
    expect(summary.bySet['unseen']?.expectedUnsupported).toBe(1);
    const rendered = renderStageBSummary([pass, unsupported], summary);
    expect(rendered).toContain('**True deployment success / expected deployable** | **1 / 1 (100%)**');
    expect(rendered).toContain('| repo-002 | acme/worker@bbbbbbb | boundary | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) |');
  });
});

describe('selection and CLI', () => {
  it('selects by set, cohort, wave order and finding', () => {
    expect(selectForRun(BENCHMARK, DEPLOY_CONFIG, { ids: [], set: 'unseen', cohort: undefined, wave: undefined, finding: undefined }).map((e) => e.id)).toEqual(['repo-002']);
    expect(selectForRun(BENCHMARK, DEPLOY_CONFIG, { ids: [], set: undefined, cohort: 'realistic', wave: undefined, finding: undefined }).map((e) => e.id)).toEqual(['repo-001']);
    expect(selectForRun(BENCHMARK, DEPLOY_CONFIG, { ids: [], set: undefined, cohort: undefined, wave: 'wave-1', finding: undefined }).map((e) => e.id)).toEqual(['repo-002', 'repo-001']);
    expect(() => selectForRun(BENCHMARK, DEPLOY_CONFIG, { ids: [], set: undefined, cohort: undefined, wave: 'wave-9', finding: undefined })).toThrow('unknown wave wave-9');
    const existing = [{ ...emptyResult(identityFor(BENCHMARK.repositories[1]!, SHA, 'gate', null)), findingIds: ['DEPLOY-001'] }];
    expect(selectForRun(BENCHMARK, DEPLOY_CONFIG, { ids: [], set: undefined, cohort: undefined, wave: undefined, finding: 'DEPLOY-001' }, existing).map((e) => e.id)).toEqual(['repo-002']);
  });

  it('parses the modes and refuses contradictions', () => {
    const gate = parseRunArgs(['--gate', '--repo', 'repo-001', '--repo', 'repo-002']);
    expect(gate.gate).toBe(true);
    expect(gate.ids).toEqual(['repo-001', 'repo-002']);
    expect(gate.offline).toBe(true);
    expect(gate.template).toBe('pinned');
    expect(parseRunArgs(['--real-aws', '--wave', 'wave-1', '--concurrency', '2', '--template', 'production']).concurrency).toBe(2);
    expect(() => parseRunArgs(['--real-aws', '--concurrency', '3'])).toThrow('--concurrency must be 1 or 2');
    expect(() => parseRunArgs(['--real-aws', '--template', 'handmade'])).toThrow('--template must be one of');
    expect(() => parseRunArgs(['--gate', '--real-aws'])).toThrow('exclusive');
    expect(() => parseRunArgs(['--repo', 'repo-001'])).toThrow('choose a mode');
    expect(parseRunArgs(['--resume']).resume).toBe(true);
  });

  it('needs the environment opt-in for anything that touches AWS, and nothing for the gate or a dry run', () => {
    const base = parseRunArgs(['--gate']);
    expect(() => requireRealAws(base, {})).not.toThrow();
    expect(() => requireRealAws(parseRunArgs(['--dry-run']), {})).not.toThrow();
    expect(() => requireRealAws(parseRunArgs(['--real-aws']), {})).toThrow('Real AWS E2E is disabled.');
    expect(() => requireRealAws(parseRunArgs(['--cleanup']), {})).toThrow('DEPLOYZ_E2E_ALLOW_REAL_AWS=1');
    expect(() => requireRealAws(parseRunArgs(['--audit']), { DEPLOYZ_E2E_ALLOW_REAL_AWS: '1' })).not.toThrow();
  });

  it('plans gate-only for expected-unsupported entries, the funnel for the rest, and skips protected results', () => {
    const plan = buildPlan(BENCHMARK.repositories, DEPLOY_CONFIG, [], { gate: false, force: false });
    expect(plan.map((l) => [l.id, l.action])).toEqual([
      ['repo-001', 'full-funnel'],
      ['repo-002', 'gate-only'],
    ]);
    expect(plan[0]?.repositoryUsed).toBe('instashop-dev/api');
    expect(plan[0]?.configuredKeys).toEqual(['APP_URL', 'DB_CLIENT', 'JWT_SECRET', 'SECRET_KEY']);
    const done = { ...emptyResult(identityFor(BENCHMARK.repositories[0]!, SHA, 'deploy', 'r')), classification: 'PASS' as const };
    expect(buildPlan(BENCHMARK.repositories, DEPLOY_CONFIG, [done], { gate: false, force: false })[0]?.action).toBe('skip-has-result');
    expect(buildPlan(BENCHMARK.repositories, DEPLOY_CONFIG, [done], { gate: false, force: true })[0]?.action).toBe('full-funnel');
    expect(renderPlan(plan, { template: 'pinned', concurrency: 1 })).toContain('full funnel: 1, gate only: 1, skipped: 0');
  });

  it('points Deployz at the fork the installation can read', () => {
    expect(repositoryUsedFor(BENCHMARK.repositories[0]!, { id: 'repo-001', findings: [], notes: [] })).toEqual({ repositoryUsed: 'instashop-dev/api', repositoryForm: 'fork' });
    expect(repositoryUsedFor(BENCHMARK.repositories[0]!, { id: 'repo-001', fork: 'instashop-dev/acme-api', findings: [], notes: [] }).repositoryUsed).toBe('instashop-dev/acme-api');
  });
});

describe('gate', () => {
  it('classifies the four gate outcomes', () => {
    expect(gateOutcome(true, 'READY')).toBe('correct-accept');
    expect(gateOutcome(true, 'NEEDS_CONFIGURATION')).toBe('correct-accept');
    expect(gateOutcome(false, 'NOT_COMPATIBLE')).toBe('correct-reject');
    expect(gateOutcome(false, 'READY')).toBe('false-acceptance');
    expect(gateOutcome(true, 'NOT_COMPATIBLE')).toBe('false-rejection');
    expect(gateOutcome(true, null)).toBeNull();
  });

  it('maps vendor overrides onto the manifest override vocabulary', () => {
    expect(overridesToManifest({ containerPort: 8080, healthPath: '/up', dockerfilePath: 'docker/Dockerfile', redisRequired: false })).toEqual({
      port: 8080,
      healthPath: '/up',
      dockerfilePath: 'docker/Dockerfile',
      redisRequired: false,
    });
    expect(overridesToManifest(undefined)).toEqual({});
  });

  it('reads the keys the gate blocks on out of its finding', () => {
    expect(missingKeys({ state: 'NEEDS_CONFIGURATION', findings: [{ id: 'required-env-vars-missing', category: 'configuration', severity: 'error', message: "This app requires environment variables that have no value yet: SECRET_KEY, APP_URL. Set them in the application's Configuration screen before deploying." }] })).toEqual(['APP_URL', 'SECRET_KEY']);
    expect(missingKeys({ state: 'READY', findings: [] })).toEqual([]);
  });

  it('records the manifest facts a deployment acts on', () => {
    const facts = manifestFacts({
      application: { root: '.', runtime: 'node', framework: null, dockerfilePath: 'docker/Dockerfile' },
      build: { command: null, context: '.' },
      web: { command: 'node server.js', port: 8080 },
      health: { path: '/healthz', mode: 'explicit' },
      database: { postgres: true, envBindings: [{ name: 'DB_HOST', kind: 'host' }, { name: 'DATABASE_URL', kind: 'url' }] },
      redis: { required: false, envBindings: [] },
      storage: { required: true, envBindings: [{ name: 'S3_BUCKET', kind: 'bucket' }] },
      migration: { command: null, mode: 'startup' },
      worker: { command: null },
      environment: { variables: [{ key: 'SECRET_KEY', required: true, secret: true, source: [], classification: 'deployz_generated' }, { key: 'X', required: false, secret: false, source: [] }] },
      externalServices: [],
      unsupported: [],
    });
    expect(facts).toEqual({
      dockerfilePath: 'docker/Dockerfile',
      buildContext: '.',
      appRoot: '.',
      port: 8080,
      healthPath: '/healthz',
      healthMode: 'explicit',
      migrationCommand: null,
      migrationMode: 'startup',
      postgres: true,
      redis: false,
      storage: true,
      databaseBindings: ['DATABASE_URL', 'DB_HOST'],
      redisBindings: [],
      storageBindings: ['S3_BUCKET'],
      generatedKeys: ['SECRET_KEY'],
    });
  });

  it('follows the health-path precedence', () => {
    expect(resolveHealthPath({ id: 'repo-001', findings: [], notes: [], verify: { healthPath: '/api/health' } }, '/health', 'explicit', undefined)).toEqual({ path: '/api/health', source: 'stage-b' });
    expect(resolveHealthPath({ id: 'repo-001', findings: [], notes: [] }, '/health', 'explicit', '/status')).toEqual({ path: '/health', source: 'manifest' });
    expect(resolveHealthPath({ id: 'repo-001', findings: [], notes: [] }, '/health', 'vendor_required', '/status')).toEqual({ path: '/status', source: 'repository-evidence' });
    expect(resolveHealthPath({ id: 'repo-001', findings: [], notes: [] }, null, null, undefined)).toEqual({ path: '/', source: 'fallback' });
  });
});

describe('classification', () => {
  const base = { expectedDeployable: true, message: 'x' } as const;

  it('recognises the expected-unsupported gate outcome and the two gate mistakes', () => {
    expect(classifyFailure({ ...base, point: 'gate', expectedDeployable: false, gateVerdict: 'NOT_COMPATIBLE' })).toMatchObject({ failureStage: 'EXPECTED_UNSUPPORTED', rootCause: 'CORRECTLY_UNSUPPORTED' });
    expect(classifyFailure({ ...base, point: 'gate', gateVerdict: 'NOT_COMPATIBLE' })).toMatchObject({ failureStage: 'GATE_ERROR', rootCause: null });
    expect(classifyFailure({ ...base, point: 'gate', expectedDeployable: false, gateVerdict: 'READY' }).rootCauseEvidence).toContain('false acceptance');
    expect(classifyFailure({ ...base, point: 'configuration' }).failureStage).toBe('CONFIG_ERROR');
  });

  it('splits build failures into source fetch, image and build', () => {
    expect(classifyFailure({ ...base, point: 'build', releaseFailure: 'Failed to fetch repo tarball for x (ref: y): HTTP 404' }).failureStage).toBe('SOURCE_FETCH_ERROR');
    expect(classifyFailure({ ...base, point: 'build', releaseFailure: 'POST_BUILD: docker push denied: requested access' })).toMatchObject({ failureStage: 'IMAGE_ERROR', rootCause: 'DEPLOYZ_BUG' });
    expect(classifyFailure({ ...base, point: 'build', releaseFailure: 'BUILD: COPY failed: file not found in build context' }).failureStage).toBe('BUILD_ERROR');
    expect(classifyFailure({ ...base, point: 'build', timedOut: true }).failureStage).toBe('TIMEOUT');
  });

  it('reads container evidence before the CloudFormation status', () => {
    expect(classifyFailure({ ...base, point: 'install', failureCode: 'STACK_CREATE_FAILED', stoppedTasks: [{ exitCode: 1, reason: null, stoppedReason: 'Essential container exited' }], logTail: ['Error: DATABASE_URL is not set'] }).failureStage).toBe('ENV_BINDING_ERROR');
    expect(classifyFailure({ ...base, point: 'install', failureCode: 'STACK_CREATE_FAILED', stoppedTasks: [{ exitCode: 1, reason: null, stoppedReason: null }], logTail: ['connect ECONNREFUSED 10.0.1.5:5432'] }).failureStage).toBe('DATABASE_ERROR');
    expect(classifyFailure({ ...base, point: 'install', stoppedTasks: [{ exitCode: 1, reason: null, stoppedReason: null }], logTail: ['Redis connection to cache:6379 failed'] }).failureStage).toBe('REDIS_ERROR');
    expect(classifyFailure({ ...base, point: 'install', stoppedTasks: [{ exitCode: 137, reason: 'OutOfMemoryError', stoppedReason: null }], logTail: ['starting'] })).toMatchObject({ failureStage: 'CONTAINER_START_ERROR', rootCause: null });
    expect(classifyFailure({ ...base, point: 'install', failureCode: 'IMAGE_PULL_FAILED' })).toMatchObject({ failureStage: 'IMAGE_ERROR', rootCause: 'DEPLOYZ_BUG' });
    expect(classifyFailure({ ...base, point: 'auto-deploy', failureCode: 'MIGRATION_FAILED', logTail: ['prisma migrate deploy failed'] }).failureStage).toBe('MIGRATION_ERROR');
    expect(classifyFailure({ ...base, point: 'install', failureCode: 'QUOTA_EXCEEDED' })).toMatchObject({ failureStage: 'INFRA_ERROR', rootCause: 'TEST_HARNESS_FAILURE' });
  });

  it('tells a wrong health path from a wrong port and from an application error', () => {
    expect(classifyFailure({ ...base, point: 'install', failureCode: 'ECS_DEPLOYMENT_FAILED', stoppedTasks: [{ exitCode: 0, reason: null, stoppedReason: 'Task failed ELB health checks' }], targetHealth: ['unhealthy'], healthStatuses: [404], healthPathSource: 'manifest', manifestHealthPath: '/health', probedHealthPath: '/health' })).toMatchObject({ failureStage: 'HEALTH_PATH_ERROR', rootCause: 'ANALYSIS_BUG' });
    // A running container killed on the task definition's own health command, before any ALB target: the in-container probe (DEPLOY-006).
    expect(classifyFailure({ ...base, point: 'install', failureCode: null, stoppedTasks: [{ exitCode: 0, reason: null, stoppedReason: 'Task failed container health checks' }], targetHealth: [] })).toMatchObject({ failureStage: 'HEALTH_PATH_ERROR', rootCause: 'DEPLOYZ_BUG' });
    expect(classifyFailure({ ...base, point: 'install', failureCode: 'ECS_DEPLOYMENT_FAILED', stoppedTasks: [{ exitCode: null, reason: null, stoppedReason: 'health checks' }], logTail: ['Listening on 0.0.0.0:8080'] }).failureStage).toBe('PORT_ERROR');
    expect(classifyFailure({ ...base, point: 'runtime', targetHealth: ['unhealthy'], healthStatuses: [503] }).failureStage).toBe('APPLICATION_ERROR');
    expect(classifyFailure({ ...base, point: 'runtime', appStatuses: [500, 500, 500] }).failureStage).toBe('APPLICATION_ERROR');
    expect(classifyFailure({ ...base, point: 'https', httpsStatus: 'ERROR' }).failureStage).toBe('TLS_ERROR');
  });

  it('separates timeouts, leaks and harness faults', () => {
    expect(classifyFailure({ ...base, point: 'install', timedOut: true, stackStatus: 'CREATE_IN_PROGRESS' }).failureStage).toBe('TIMEOUT');
    expect(classifyFailure({ ...base, point: 'install', failureCode: 'STACK_CREATE_FAILED', stackReasons: ['AWS::RDS::DBInstance CREATE_FAILED'] })).toMatchObject({ failureStage: 'INFRA_ERROR', rootCause: null });
    expect(classifyFailure({ ...base, point: 'cleanup', message: '2 resource(s) left after teardown' }).failureStage).toBe('CLEANUP_LEAK');
    expect(classifyFailure({ ...base, point: 'cleanup', message: 'destroy ended in FAILED' }).failureStage).toBe('DESTROY_ERROR');
    expect(classifyFailure({ ...base, point: 'harness' })).toMatchObject({ failureStage: 'TEST_HARNESS_ERROR', rootCause: 'TEST_HARNESS_FAILURE' });
  });

  it('never records a credential', () => {
    expect(sanitize('postgresql://app:s3cret@db:5432/app password=hunter2 Bearer abc.def')).toBe('postgresql://app:***@db:5432/app password=*** Bearer ***');
  });
});

// ── The funnel with fakes ────────────────────────────────────────────────────

interface Script {
  analysisStatus?: string;
  preflight?: { state: string; ready: boolean; blockers: { id: string; message: string }[]; warnings: { id: string }[] };
  releaseStatus?: 'READY' | 'FAILED';
  releaseFailure?: string | null;
  createDeploymentError?: { status: number; code: string; message: string };
  bootstrapStatus?: string;
  installState?: string;
  failureCode?: string | null;
  stackStatus?: string;
  pointerAdvances?: boolean;
  httpsStatus?: string;
  probeStatus?: number | null;
  targets?: string[];
  stoppedTasks?: { exitCode: number | null; reason: string | null; stoppedReason?: string }[];
  logTail?: string[];
  application?: Record<string, unknown>;
  presence?: { rds: string | null; cache: string | null; bucket: string | null };
  taskEnv?: { environment: string[]; secrets: string[] };
}

function fakes(script: Script): { deps: DeployDeps; calls: string[]; puts: Record<string, unknown>[] } {
  const calls: string[] = [];
  const puts: Record<string, unknown>[] = [];
  const releaseId = 'rel-1';
  let deployment: DeploymentDetail & { defaultHttps?: unknown } = {
    id: 'dep-1',
    state: 'WAITING_FOR_RELAY',
    applicationId: 'app-1',
    customerId: 'cust-1',
    installLinkId: 'link-1',
    installationId: null,
    bootstrapStackName: 'deployz-bootstrap-x-12345678',
    currentReleaseId: null,
    previousReleaseId: null,
    version: null,
    relayStatus: 'UNKNOWN',
    healthStatus: 'UNKNOWN',
    cleanupState: null,
    runningImageDigest: null,
    appUrl: null,
    jobs: [],
    deploymentStatus: { stage: 'INSTALLING', currentActivity: '', url: null, health: { status: 'UNKNOWN' }, failure: null, job: null },
  };
  let reads = 0;
  const api: ControlPlaneLike = {
    async request<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T; headers: Headers }> {
      calls.push(`${method} ${path}`);
      if (method === 'PUT') puts.push(body as Record<string, unknown>);
      if (path.endsWith('/preflight')) {
        return { status: 200, body: (script.preflight ?? { state: 'READY', ready: true, blockers: [], warnings: [] }) as T, headers: new Headers() };
      }
      return { status: 200, body: {} as T, headers: new Headers() };
    },
    async bindGithubInstallation() {
      calls.push('bind');
      return 'ok';
    },
    async createApplication() {
      calls.push('createApplication');
      return { id: 'app-1' };
    },
    async patchApplication(_id, patch) {
      calls.push(`patch ${Object.keys(patch).join(',')}`);
    },
    async triggerAnalysis() {
      calls.push('analyse');
    },
    async getReadiness() {
      return { state: 'READY', analysisStatus: script.analysisStatus ?? 'COMPLETE', findings: [] };
    },
    async getApplication() {
      return { healthPath: '/healthz', databaseRequired: true, redisRequired: false, storageRequired: false, detectedMetadata: { healthMode: 'explicit', dockerfilePath: 'Dockerfile' }, ...(script.application ?? {}) };
    },
    async createRelease(_id, input) {
      calls.push(`createRelease ${input.gitSha}`);
      return { id: releaseId, version: input.version };
    },
    async listReleases() {
      return [{ id: releaseId, version: 'v', status: script.releaseStatus ?? 'READY', failureReason: script.releaseFailure ?? null }];
    },
    async createCustomer() {
      calls.push('createCustomer');
      return { id: 'cust-1' };
    },
    async createDeployment() {
      calls.push('createDeployment');
      if (script.createDeploymentError) {
        const { ControlPlaneError } = await import('../version-canary/control-plane.js');
        throw new ControlPlaneError(script.createDeploymentError.status, script.createDeploymentError.code, script.createDeploymentError.message, null);
      }
      return { id: 'dep-1', installLinkId: 'link-1' };
    },
    async getDeployment() {
      reads += 1;
      // The deployment "progresses" with every read: enrolled → installed → pointer → https.
      const installState = script.installState ?? 'HEALTHY';
      deployment = {
        ...deployment,
        installationId: reads >= 1 ? 'inst-1' : null,
        state: reads >= 2 ? installState : 'INSTALLING',
        jobs: reads >= 2 ? [{ id: 'job-i', type: 'INSTALL', state: installState === 'FAILED' ? 'FAILED' : 'SUCCEEDED', idempotencyKey: 'k', payload: null, failureCode: script.failureCode ?? null, result: null, createdAt: 't', finishedAt: 't' }] : [],
        deploymentStatus: { ...deployment.deploymentStatus, failure: script.failureCode ? { code: script.failureCode, component: null, reference: 'r', message: 'failed', awsStatus: null } : null },
        currentReleaseId: reads >= 3 && (script.pointerAdvances ?? true) ? releaseId : null,
        runningImageDigest: reads >= 3 && (script.pointerAdvances ?? true) ? 'sha256:deadbeef' : null,
        appUrl: reads >= 4 ? 'https://d-dep-1.deployz.dev' : null,
        defaultHttps: reads >= 4 ? { status: script.httpsStatus ?? 'ACTIVE', hostname: 'd-dep-1.deployz.dev', lastError: null } : { status: 'PENDING', hostname: 'd-dep-1.deployz.dev' },
      };
      return deployment;
    },
    async getInstallInfo() {
      return {
        quickCreateUrl:
          'https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create/review?templateURL=https%3A%2F%2Fb%2Fbootstrap-template-v1.json&stackName=deployz-bootstrap-x-12345678&param_ControlPlaneUrl=https%3A%2F%2Fapi&param_EnrollmentCode=code',
        bootstrapStackName: 'deployz-bootstrap-x-12345678',
        deploymentId: 'dep-1',
        alreadyInstalled: false,
      };
    },
    async markInstallLaunched() {
      calls.push('launched');
      return { state: 'WAITING_FOR_RELAY' };
    },
    async events() {
      return [];
    },
    async diagnostics() {
      return { code: script.failureCode ?? null };
    },
  };
  const aws: AwsLike = {
    async createBootstrapStack(input) {
      calls.push(`createStack ${input.stackName} ${Object.keys(input.parameters).sort().join(',')}`);
      return 'arn:stack';
    },
    async describeStack(name) {
      if (name.startsWith('deployz-bootstrap')) return { status: script.bootstrapStatus ?? 'CREATE_COMPLETE', statusReason: null, outputs: { InstallationId: 'inst-1' } };
      return { status: script.stackStatus ?? 'CREATE_COMPLETE', statusReason: null, outputs: {} };
    },
    async lambdaFunctionNames() {
      return ['relay-fn'];
    },
    async describeRunningService() {
      return { desiredCount: 1, runningCount: 1, runningDigests: ['sha256:deadbeef'], deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED' }] };
    },
    async targetHealth() {
      return script.targets ?? ['healthy'];
    },
    async albDnsName() {
      return 'alb.example.com';
    },
    async ecrDigestForTag() {
      return 'sha256:deadbeef';
    },
    async listStackResources() {
      return [{ type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE', physicalId: 'svc' }];
    },
    async describeStoppedTasks() {
      calls.push('stoppedTasks');
      return (script.stoppedTasks ?? []).map((t, i) => ({ taskArn: `t${i}`, stoppedReason: t.stoppedReason ?? 'Essential container exited', stopCode: 'EssentialContainerExited', stoppedAt: null, containers: [{ name: 'App', exitCode: t.exitCode, reason: t.reason }] }));
    },
    async tailApplicationLogs() {
      calls.push('logs');
      return script.logTail ?? [];
    },
    async describeDependencies() {
      return script.presence ?? { rds: 'db-1', cache: null, bucket: 'bucket-1' };
    },
    async describeTaskDefinitionEnv() {
      return { ...(script.taskEnv ?? { environment: ['PORT', 'DATABASE_HOST'], secrets: ['DATABASE_URL'] }), command: null, image: 'x@sha256:deadbeef' };
    },
  };
  const deps: DeployDeps = {
    api,
    aws,
    probe: async () => ({ status: script.probeStatus === undefined ? 200 : script.probeStatus }),
    sleep: async () => {},
    now: Date.now,
    region: 'us-east-1',
    githubInstallationId: '156387233',
    templateUrl: 'https://b/application/stage-b/x/application-template-v1.json',
    templateSource: 'stage-b-generic',
    timeouts: DEFAULT_TIMEOUTS,
    keep: false,
    generateSecret: () => 'never-stored-secret-value-9f2a',
    pollIntervalMs: 1,
  };
  return { deps, calls, puts };
}

function attempt(entry: BenchmarkEntry, script: Script, config = configFor(DEPLOY_CONFIG, entry.id)) {
  const evidenceDir = join(tmp, 'evidence', `${entry.id}-${Math.random().toString(36).slice(2, 8)}`);
  const runId = stageBRunId(entry.id);
  const evidence = openLedger(evidenceDir, loadConfig({}), { repoId: entry.id, repository: entry.repository, commit: entry.commit, deployzCommit: SHA, cleanupNeeded: false }, runId);
  const result = emptyResult(identityFor(entry, SHA, 'deploy', runId));
  const { deps, calls, puts } = fakes(script);
  return { run: () => runRepositoryAttempt(deps, { benchmark: entry, config, repositoryUsed: 'instashop-dev/api', repositoryForm: 'fork', evidence, result }), calls, puts, evidence, result, evidenceDir };
}

describe('the funnel', () => {
  const deployable = BENCHMARK.repositories[0]!;
  const unsupported = BENCHMARK.repositories[1]!;

  it('passes end to end with the release serving, HTTPS active and dependencies bound', async () => {
    const { run, calls, puts, result, evidence } = attempt(deployable, {});
    const out = await run();
    expect(out.classification).toBe('PASS');
    // The vendor scope gets the placeholder (the gate needs the key); the customer scope gets the real address.
    const vendorPut = puts.find((p) => p['customerId'] === undefined)!;
    expect((vendorPut['entries'] as { key: string; value: string }[]).find((e) => e.key === 'APP_URL')?.value).toBe('https://pending.deployz.dev/app');
    const customerPut = puts.find((p) => p['customerId'] === 'cust-1')!;
    expect(customerPut['entries']).toEqual([{ key: 'APP_URL', value: `${defaultDeploymentUrl('dep-1')}/app`, isSecret: false }]);
    expect(out.build.imageDigest).toBe('sha256:deadbeef');
    expect(out.deployment.status).toBe('PASS');
    expect(out.runtime).toMatchObject({ ecs: 'HEALTHY', alb: 'HEALTHY', https: 'PASS', healthPath: '/healthz', healthPathSource: 'stage-b', releaseServing: true });
    expect(out.dependencies).toMatchObject({ postgres: 'PASS', redis: 'NOT_REQUIRED', storage: 'NOT_REQUIRED' });
    expect(out.configuration.keys).toEqual(['APP_URL', 'DB_CLIENT', 'JWT_SECRET', 'SECRET_KEY']);
    expect(out.configuration.generatedKeys).toEqual(['JWT_SECRET', 'SECRET_KEY']);
    expect(calls).toContain('patch containerPort,healthPath');
    expect(calls).toContain(`createRelease ${SHA}`);
    expect(calls).toContain('createStack deployz-bootstrap-x-12345678 ApplicationTemplateUrl,ControlPlaneUrl,EnrollmentCode');
    expect(stageBRun(evidence).stageB.cleanupNeeded).toBe(true);
    expect(stageBRun(evidence).deploymentId).toBe('dep-1');
    expect(JSON.stringify(result)).not.toContain('never-stored-secret-value'); // the secret value never reaches the result
    expect(JSON.stringify(evidence.run)).not.toContain('never-stored-secret-value'); // nor the ledger
    expect(() => stageBResultSchema.parse(out)).not.toThrow();
  });

  it('stops an accepted expected-unsupported repository at the gate without creating anything', async () => {
    const { run, calls } = attempt(unsupported, {});
    const out = await run();
    expect(out.classification).toBe('GATE_ERROR');
    expect(out.rootCauseEvidence).toContain('false acceptance');
    expect(calls).not.toContain('createDeployment');
    expect(calls.some((c) => c.startsWith('createStack'))).toBe(false);
  });

  it('records EXPECTED_UNSUPPORTED when the control plane refuses an expected-unsupported repository', async () => {
    const { run } = attempt(unsupported, { preflight: { state: 'NOT_COMPATIBLE', ready: false, blockers: [{ id: 'unsupported', message: 'kafka' }], warnings: [] } });
    const out = await run();
    expect(out.classification).toBe('EXPECTED_UNSUPPORTED');
    expect(out.rootCause).toBe('CORRECTLY_UNSUPPORTED');
    expect(out.gate.status).toBe('PASS');
  });

  it('records a false rejection and a configuration refusal without building', async () => {
    const rejected = await attempt(deployable, { preflight: { state: 'NOT_COMPATIBLE', ready: false, blockers: [{ id: 'unsupported', message: 'x' }], warnings: [] } });
    expect((await rejected.run()).classification).toBe('GATE_ERROR');
    expect(rejected.calls.some((c) => c.startsWith('createRelease'))).toBe(false);
    const needs = await attempt(deployable, { preflight: { state: 'NEEDS_CONFIGURATION', ready: false, blockers: [{ id: 'required-env-vars-missing', message: 'APP_KEY' }], warnings: [] } });
    expect((await needs.run()).classification).toBe('CONFIG_ERROR');
    const gate422 = await attempt(deployable, { createDeploymentError: { status: 422, code: 'MANIFEST_NEEDS_CONFIGURATION', message: 'needs APP_KEY' } });
    const out = await gate422.run();
    expect(out.classification).toBe('CONFIG_ERROR');
    expect(gate422.calls.some((c) => c.startsWith('createStack'))).toBe(false);
  });

  it('stops before any infrastructure when the build fails', async () => {
    const { run, calls } = attempt(deployable, { releaseStatus: 'FAILED', releaseFailure: 'BUILD: COMMAND_EXECUTION_ERROR: docker build failed' });
    const out = await run();
    expect(out.classification).toBe('BUILD_ERROR');
    expect(out.build.status).toBe('FAIL');
    expect(out.deployment.status).toBe('NOT_ATTEMPTED');
    expect(calls).not.toContain('createDeployment');
  });

  it('settles the install on a rolled-back stack even while the product still reports INSTALLING', async () => {
    const { run } = attempt(deployable, { installState: 'INSTALLING', stackStatus: 'ROLLBACK_COMPLETE', targets: [], stoppedTasks: [{ exitCode: 0, reason: null, stoppedReason: 'Task failed container health checks' }] });
    const out = await run();
    expect(out.deployment.status).toBe('FAIL');
    expect(out.deployment.stackStatus).toBe('ROLLBACK_COMPLETE');
    expect(out.classification).toBe('HEALTH_PATH_ERROR');
    expect(out.rootCause).toBe('DEPLOYZ_BUG');
  });

  it('collects task and log evidence when the install fails and classifies from it', async () => {
    const { run, calls, result } = attempt(deployable, {
      installState: 'FAILED',
      failureCode: 'STACK_CREATE_FAILED',
      stackStatus: 'ROLLBACK_COMPLETE',
      stoppedTasks: [{ exitCode: 1, reason: null }],
      logTail: ['FATAL: password authentication failed for user "app"'],
    });
    const out = await run();
    expect(out.classification).toBe('DATABASE_ERROR');
    expect(out.deployment.status).toBe('FAIL');
    expect(out.deployment.failureCode).toBe('STACK_CREATE_FAILED');
    expect(calls).toContain('stoppedTasks');
    expect(calls).toContain('logs');
    expect((result.evidence['failure'] as { logTail: string[] }).logTail[0]).toContain('password authentication failed');
  });

  it('fails the runtime stage on a persistent 5xx and the HTTPS stage on a certificate error', async () => {
    const app = await attempt(deployable, { probeStatus: 503 });
    expect((await app.run()).classification).toBe('APPLICATION_ERROR');
    const tls = await attempt(deployable, { httpsStatus: 'ERROR' });
    const out = await tls.run();
    expect(out.classification).toBe('TLS_ERROR');
    expect(out.runtime.https).toBe('FAIL');
  });

  it('fails dependency verification when a required binding is absent', async () => {
    const { run } = attempt(deployable, { taskEnv: { environment: ['PORT'], secrets: [] } });
    const out = await run();
    expect(out.dependencies.postgres).toBe('FAIL');
    expect(out.classification).toBe('APPLICATION_ERROR');
  });
});

describe('cleanup', () => {
  const deployable = BENCHMARK.repositories[0]!;
  const idleApi = () => ({ getDeployment: async () => ({ state: 'HEALTHY', jobs: [{ id: 'j', type: 'INSTALL', state: 'SUCCEEDED' }] }) }) as never;

  it('always runs every stage, records what is left, and marks the ledger complete only on success', async () => {
    const { run, evidence, result } = attempt(deployable, {});
    await run();
    const calls: string[] = [];
    const teardown = {
      async destroyThroughProduct() {
        calls.push('destroy');
      },
      async removeCanaryLeftovers() {
        calls.push('leftovers');
      },
      async leakAudit() {
        calls.push('audit');
      },
    };
    const section = await cleanupAttempt({ config: loadConfig({}), api: idleApi(), evidence, teardown, now: Date.now }, result);
    expect(section.status).toBe('PASS');
    expect(calls).toEqual(['destroy', 'leftovers', 'audit']);
    expect(stageBRun(evidence).stageB.cleanupCompletedAt).toBeTruthy();
    expect(stageBRun(evidence).stageB.cleanupNeeded).toBe(false);
  });

  it('waits for an in-flight job before Disconnect, and records when it never settles', async () => {
    const { run, evidence, result } = attempt(deployable, {});
    await run();
    let reads = 0;
    const api = { getDeployment: async () => ({ state: 'INSTALLING', jobs: [{ id: 'j', type: 'INSTALL', state: reads++ < 2 ? 'RUNNING' : 'FAILED' }] }) } as never;
    const calls: string[] = [];
    const teardown = { destroyThroughProduct: async () => { calls.push('destroy'); }, removeCanaryLeftovers: async () => { calls.push('leftovers'); }, leakAudit: async () => { calls.push('audit'); } };
    const section = await cleanupAttempt({ config: loadConfig({}), api, evidence, teardown, now: Date.now, idleTimeoutMs: 5_000, pollIntervalMs: 1 }, result);
    expect(section.status).toBe('PASS');
    expect(reads).toBeGreaterThanOrEqual(3);
    const stuck = { getDeployment: async () => ({ state: 'INSTALLING', jobs: [{ id: 'j', type: 'INSTALL', state: 'RUNNING' }] }) } as never;
    const { run: run2, evidence: evidence2, result: result2 } = attempt(deployable, {});
    await run2();
    const section2 = await cleanupAttempt({ config: loadConfig({}), api: stuck, evidence: evidence2, teardown, now: Date.now, idleTimeoutMs: 20, pollIntervalMs: 1 }, result2);
    expect(section2.status).toBe('FAIL');
    expect(section2.detail).toContain('idle wait');
    expect(stageBRun(evidence2).stageB.cleanupNeeded).toBe(true);
  });

  it('keeps going after a failed destroy, reports the leak, and turns a PASS into CLEANUP_LEAK', async () => {
    const { run, evidence, result } = attempt(deployable, {});
    await run();
    const calls: string[] = [];
    const teardown = {
      async destroyThroughProduct() {
        calls.push('destroy');
        throw new Error('destroy ended in FAILED');
      },
      async removeCanaryLeftovers() {
        calls.push('leftovers');
      },
      async leakAudit() {
        calls.push('audit');
        evidence.run.steps.push({ index: 99, name: 'AWS leak audit', scenario: 'x', startedAt: 't', status: 'FAIL', details: { disposableLeft: ['rds db-1'] } });
        throw new Error('1 resource(s) left after teardown');
      },
    };
    const section = await cleanupAttempt({ config: loadConfig({}), api: idleApi(), evidence, teardown, now: Date.now }, result);
    expect(section.status).toBe('FAIL');
    expect(section.leaks).toEqual(['rds db-1']);
    expect(calls).toEqual(['destroy', 'leftovers', 'audit']);
    expect(stageBRun(evidence).stageB.cleanupNeeded).toBe(true);
    applyCleanupToClassification(result);
    expect(result.classification).toBe('CLEANUP_LEAK');
    expect(result.failureStage).toBe('CLEANUP_LEAK');
  });

  it('still removes a built image when the funnel stopped before the deployment existed', async () => {
    const { run, evidence, result } = attempt(deployable, { createDeploymentError: { status: 422, code: 'MANIFEST_NEEDS_CONFIGURATION', message: 'needs APP_KEY' } });
    await run();
    expect(stageBRun(evidence).releases['release']?.imageDigest).toBe('sha256:deadbeef');
    const calls: string[] = [];
    const section = await cleanupAttempt(
      {
        config: loadConfig({}),
        api: idleApi(),
        evidence,
        teardown: {
          destroyThroughProduct: async () => {
            calls.push('destroy');
          },
          removeCanaryLeftovers: async () => {
            calls.push('leftovers');
          },
          leakAudit: async () => {
            calls.push('audit');
          },
        },
        now: Date.now,
      },
      result,
    );
    expect(section.status).toBe('PASS');
    expect(calls).toEqual(['destroy', 'leftovers', 'audit']);
  });

  it('cleans a release whose build the ledger never saw finish, and needs no cleanup when nothing was created', async () => {
    const built = attempt(deployable, { releaseStatus: 'FAILED', releaseFailure: 'x' });
    await built.run();
    const calls: string[] = [];
    const teardown = { destroyThroughProduct: async () => { calls.push('destroy'); }, removeCanaryLeftovers: async () => { calls.push('leftovers'); }, leakAudit: async () => { calls.push('audit'); } };
    expect((await cleanupAttempt({ config: loadConfig({}), api: idleApi(), evidence: built.evidence, teardown, now: Date.now }, built.result)).status).toBe('PASS');
    expect(calls).toEqual(['destroy', 'leftovers', 'audit']);
    const nothing = attempt(deployable, { preflight: { state: 'NOT_COMPATIBLE', ready: false, blockers: [{ id: 'unsupported', message: 'x' }], warnings: [] } });
    await nothing.run();
    expect((await cleanupAttempt({ config: loadConfig({}), api: idleApi(), evidence: nothing.evidence, teardown, now: Date.now }, nothing.result)).status).toBe('NOT_REQUIRED');
  });

  it('stops the wave after a failed cleanup', () => {
    const result = emptyResult(identityFor(deployable, SHA, 'deploy', 'r'));
    expect(shouldStopWave(result)).toBe(false);
    result.cleanup.status = 'FAIL';
    expect(shouldStopWave(result)).toBe(true);
  });

  it('lists only the ledgers whose cleanup did not complete, so a resume finishes them first', async () => {
    const dir = join(tmp, 'ledgers');
    const config = loadConfig({});
    const done = openLedger(dir, config, { repoId: 'repo-001', repository: 'a/b', commit: SHA, deployzCommit: SHA, cleanupNeeded: false }, 'stage-b-repo-001-done');
    stageBRun(done).stageB.cleanupCompletedAt = 'now';
    done.save();
    const pending = openLedger(dir, config, { repoId: 'repo-002', repository: 'a/c', commit: SHA, deployzCommit: SHA, cleanupNeeded: true }, 'stage-b-repo-002-pending');
    pending.save();
    const untouched = openLedger(dir, config, { repoId: 'repo-003', repository: 'a/d', commit: SHA, deployzCommit: SHA, cleanupNeeded: false }, 'stage-b-repo-003-untouched');
    untouched.finish('FAIL');
    expect(listUnfinishedLedgers(dir).map((l) => l.runId)).toEqual(['stage-b-repo-002-pending', 'stage-b-repo-003-untouched']);
    expect(readdirSync(dir).length).toBe(3);
  });

  it('keeps the vendor session and the published templates per series', () => {
    const dir = join(tmp, 'series');
    expect(readSeries(dir)).toEqual({ templates: {} });
    writeSeries(dir, { vendor: { email: 'v@example.com', password: 'p' }, templates: { abc: { url: 'u', keyPrefix: 'k', bucket: 'b' } } });
    expect(readSeries(dir).vendor?.email).toBe('v@example.com');
    expect(existsSync(join(dir, 'series.json'))).toBe(true);
  });
});

describe('findings registry', () => {
  it('uses stable DEPLOY-nnn ids and the documented resolutions', () => {
    const doc = readFileSync(join(STAGE_B_DIR, 'findings.md'), 'utf8');
    const ids = [...new Set([...doc.matchAll(/^\| (DEPLOY-\d{3}) \|/gm)].map((m) => m[1]!))].sort();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(doc).toMatch(new RegExp(`^## ${id} — `, 'm'));
  });
});
