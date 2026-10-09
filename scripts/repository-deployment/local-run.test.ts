import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseRunArgs, localAppEnvironment } from './index.js';
import type { ArchiveFetch, ProcessOptions, ProcessResult, RunProcess } from './local-build.js';
import { emptyLocalResult, buildLocalSummary, readLocalResult, renderLocalSummary, writeLocalResult, writeLocalSummary, classifyLocal, type LocalIdentity } from './local-results.js';
import {
  DATABASE_ENV,
  HEALTH_WINDOW_MS,
  REDIS_ENV,
  RUN_IMAGES,
  START_WINDOW_MS,
  STORAGE_ENV,
  buildAppEnvironment,
  envArguments,
  reconcileLeftovers,
  resourceNames,
  runLocalRepository,
  type LocalRepositoryContext,
  type RunManifest,
} from './local-run.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const COMMIT = 'c'.repeat(40);
const PASSWORD = 'pw-secret-value-123';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'local-run-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Call {
  file: string;
  args: readonly string[];
  options: ProcessOptions;
}

interface World {
  /** HTTP codes the app answers, one per poll; the last one repeats. */
  health: number[];
  appRunning: boolean;
  migrationExit: number;
  tablesBefore: number;
  tablesAfter: number;
  rows: number;
  redisClients: number;
  bucketObjects: boolean;
  /** Labelled containers that exist (leftovers or created). */
  containers: string[];
  leakAfterRemove: boolean;
  imagePresent: boolean;
  throwOnApp: boolean;
}

function world(overrides: Partial<World> = {}): World {
  return {
    health: [200],
    appRunning: true,
    migrationExit: 0,
    tablesBefore: 0,
    tablesAfter: 3,
    rows: 5,
    redisClients: 1,
    bucketObjects: true,
    containers: [],
    leakAfterRemove: false,
    imagePresent: true,
    throwOnApp: false,
    ...overrides,
  };
}

function fakeDocker(state: World): { run: RunProcess; calls: Call[]; clock: { now(): number; sleep(ms: number): Promise<void> } } {
  const calls: Call[] = [];
  let now = 1_000_000;
  let polls = 0;
  let tableReads = 0;
  const clock = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
  const run: RunProcess = async (file, args, options): Promise<ProcessResult> => {
    calls.push({ file, args, options });
    const ok = (output = '', exitCode = 0): ProcessResult => ({ exitCode, output, timedOut: false });
    if (file !== 'docker') return ok();
    const text = args.join(' ');
    switch (args[0]) {
      case 'image':
        if (args[1] === 'inspect') return state.imagePresent ? ok('sha256:abc 100') : ok('', 1);
        if (args[1] === 'rm') {
          state.imagePresent = false;
          return ok();
        }
        break;
      case 'build':
        return ok('built');
      case 'network':
        if (args[1] === 'ls') return ok(state.containers.length > 0 || state.leakAfterRemove ? 'net1\n' : '');
        return ok();
      case 'volume':
        return ok(state.leakAfterRemove ? 'vol1\n' : '');
      case 'ps':
        return ok(state.containers.join('\n'));
      case 'rm':
        if (!state.leakAfterRemove) state.containers = [];
        return ok();
      case 'logs':
        return ok(`log line with ${PASSWORD} and bearer abcdef\nlast line`);
      case 'inspect':
        if (text.includes('.Mounts')) return ok('');
        return ok(`${state.appRunning} ${state.appRunning ? 0 : 1}`);
      case 'exec':
        if (text.includes('psql')) {
          if (text.includes('select 1')) return ok('1');
          if (text.includes('information_schema.tables') && text.includes('count(*) from')) {
            tableReads += 1;
            return ok(String(tableReads === 1 ? state.tablesBefore : state.tablesAfter));
          }
          return ok(String(state.rows));
        }
        if (text.includes('valkey-cli ping')) return ok('PONG');
        if (text.includes('CLIENT LIST')) return ok(`id=1 cmd=client|list\n${Array.from({ length: state.redisClients }, (_, i) => `id=${i + 2} cmd=get`).join('\n')}`);
        if (text.includes('DBSIZE')) return ok('0');
        return ok();
      case 'run': {
        if (args.includes('--rm')) {
          if (args.includes('PUT')) return ok('200');
          if (text.includes('list-type=2')) return ok(state.bucketObjects ? '<ListBucketResult><Contents>x</Contents>' : '<ListBucketResult></ListBucketResult>');
          polls += 1;
          return ok(String(state.health[Math.min(polls - 1, state.health.length - 1)]));
        }
        if (args.includes('sh')) {
          state.containers.push('migrate');
          return ok('migrated', state.migrationExit);
        }
        if (state.throwOnApp && args.includes('--network-alias') && args[args.indexOf('--network-alias') + 1] === 'app') throw new Error('docker daemon vanished');
        state.containers.push(String(args[args.indexOf('--name') + 1]));
        return ok('containerid');
      }
      default:
        return ok();
    }
    return ok();
  };
  return { run, calls, clock };
}

const fetchOk: ArchiveFetch = async () => ({ status: 200, headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode('x').buffer as ArrayBuffer });

const FULL: RunManifest = {
  port: 3000,
  healthPath: '/health',
  migrationCommand: 'npx prisma migrate deploy',
  postgres: true,
  redis: true,
  storage: true,
  databaseBindings: ['DATABASE_URL', 'DB_HOST'],
  redisBindings: ['REDIS_URL'],
  storageBindings: ['S3_BUCKET'],
};

function identity(hash = 'hash-1'): LocalIdentity {
  return { id: 'repo-001', repository: 'acme/api', commit: COMMIT, set: 'improvement', cohort: 'realistic', deployzCommit: 'd'.repeat(40), analysisVersion: 45, ai: { mode: 'off' }, inputsHash: hash };
}

function context(fake: ReturnType<typeof fakeDocker>, overrides: Partial<LocalRepositoryContext> = {}): LocalRepositoryContext {
  return {
    identity: identity(),
    gate: { status: 'PASS', detail: null, evidence: {}, build: true },
    detectedMetadata: { dockerfilePath: 'Dockerfile' },
    repository: 'acme/api',
    overrides: {},
    buildArgs: [],
    resume: false,
    runsDir: join(dir, 'runs'),
    logsDir: join(dir, 'logs'),
    cacheDir: join(dir, 'cache'),
    token: null,
    fetchFn: fetchOk,
    run: fake.run,
    hostEnv: { PATH: '/bin', GITHUB_TOKEN: 'ghp_hostsecret', AWS_SECRET_ACCESS_KEY: 'hostaws' },
    tmpRoot: dir,
    manifest: FULL,
    appEnv: [{ name: 'SESSION_SECRET', value: 'generated-session-secret' }],
    keepImage: false,
    runId: 'abcd1234',
    generatePassword: () => PASSWORD,
    clock: fake.clock,
    ...overrides,
  };
}

function dockerCalls(fake: { calls: Call[] }, first: string): Call[] {
  return fake.calls.filter((call) => call.file === 'docker' && call.args[0] === first);
}

describe('buildAppEnvironment', () => {
  it('uses the env names of the capability registry, with local endpoints', () => {
    const env = Object.fromEntries(buildAppEnvironment(FULL, [{ name: 'SESSION_SECRET', value: 's' }], PASSWORD, 'bucket-1').map((entry) => [entry.name, entry.value]));
    expect(env).toMatchObject({
      PORT: '3000',
      SESSION_SECRET: 's',
      DATABASE_URL: `postgresql://app:${PASSWORD}@db:5432/app`,
      DB_HOST: 'db',
      REDIS_URL: 'redis://cache:6379',
      S3_BUCKET: 'bucket-1',
      AWS_ENDPOINT_URL_S3: 'http://s3:8333',
    });
    expect(env['DB_PORT']).toBeUndefined();
    expect(env['CACHE_URL']).toBeUndefined();
  });

  it('injects the whole registry set when the manifest names no bindings, and nothing for an absent dependency', () => {
    const names = buildAppEnvironment({ ...FULL, redis: false, storage: false, databaseBindings: [], redisBindings: [], storageBindings: [] }, [], PASSWORD, 'b').map((entry) => entry.name);
    expect(names.sort()).toEqual(['PORT', ...Object.keys(DATABASE_ENV)].sort());
  });

  it('lets a capability binding win over a deploy-config value', () => {
    const env = buildAppEnvironment(FULL, [{ name: 'DATABASE_URL', value: 'postgres://elsewhere' }], PASSWORD, 'b');
    expect(env.find((entry) => entry.name === 'DATABASE_URL')?.value).toContain('@db:5432');
  });

  it('keeps the env names in step with packages/contracts/src/capability-registry.ts', () => {
    const registry = readFileSync(join(REPO_ROOT, 'packages', 'contracts', 'src', 'capability-registry.ts'), 'utf8');
    for (const table of [DATABASE_ENV, REDIS_ENV, STORAGE_ENV]) {
      for (const [name, kind] of Object.entries(table)) expect(registry).toContain(`{ name: '${name}', kind: '${kind}' }`);
    }
  });
});

describe('envArguments', () => {
  it('keeps values off the command line and out of the host environment', () => {
    const { args, env } = envArguments({ PATH: '/bin', GITHUB_TOKEN: 'ghp_x' }, [{ name: 'SECRET_A', value: 'va' }, { name: 'EMPTY', value: '' }, { name: 'PATH', value: '/evil' }]);
    expect(args).toEqual(['-e', 'SECRET_A', '-e', 'EMPTY=', '-e', 'PATH=/evil']);
    expect(env['SECRET_A']).toBe('va');
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['PATH']).toBe('/bin');
  });
});

describe('local run stage', () => {
  it('runs build, run, probes and cleanup for a full-stack app and classifies local-success', async () => {
    const fake = fakeDocker(world());
    const result = await runLocalRepository(context(fake));
    expect(result.stages.run.status).toBe('PASS');
    expect(result.stages.probes.status).toBe('PASS');
    expect(result.stages.cleanup.status).toBe('PASS');
    expect(result.classification).toBe('local-success');
    const probes = result.stages.probes.evidence['probes'] as Record<string, { status: string }>;
    expect(Object.fromEntries(Object.entries(probes).map(([name, probe]) => [name, probe.status]))).toEqual({
      health: 'PASS',
      start: 'PASS',
      migration: 'PASS',
      dbWrite: 'PASS',
      redis: 'PASS',
      storage: 'PASS',
    });
    expect(readLocalResult(join(dir, 'runs'), 'repo-001')).toEqual(result);
  });

  it('isolates every container: labels, no mount, no published port, no privilege, limits, no host environment', async () => {
    const fake = fakeDocker(world());
    await runLocalRepository(context(fake));
    const created = fake.calls.filter((call) => call.file === 'docker' && call.args[0] === 'run');
    expect(created.length).toBeGreaterThanOrEqual(5);
    const names = resourceNames('repo-001', 'abcd1234');
    for (const call of created) {
      const args = call.args.join(' ');
      expect(args).toContain('--label deployz-campaign=fresh-100');
      expect(args).toContain('--label deployz-campaign-repo=repo-001');
      expect(args).toContain(`--network ${names.network}`);
      for (const forbidden of ['-v ', '--volume', '--mount', '-p ', '--publish', '-P', '--privileged', 'docker.sock', '--network host', '--net host', '--secret', '--env-file', '--pid', '--cap-add']) {
        expect(args).not.toContain(forbidden);
      }
      expect(Object.keys(call.options.env)).not.toContain('GITHUB_TOKEN');
      expect(Object.values(call.options.env)).not.toContain('hostaws');
      expect(Object.values(call.options.env)).not.toContain('ghp_hostsecret');
      expect(args).not.toContain(PASSWORD);
      expect(args).not.toContain('generated-session-secret');
    }
    const app = created.find((call) => call.args.includes(names.app))!;
    expect(app.args).toEqual(expect.arrayContaining(['--memory', '1g', '--cpus', '1', '--platform', 'linux/amd64']));
    expect(app.options.env['SESSION_SECRET']).toBe('generated-session-secret');
    expect(app.options.env['DATABASE_URL']).toContain(PASSWORD);
    const network = fake.calls.find((call) => call.args[0] === 'network' && call.args[1] === 'create')!;
    expect(network.args).toEqual(expect.arrayContaining(['--label', 'deployz-campaign=fresh-100', names.network]));
    for (const image of [RUN_IMAGES.postgres, RUN_IMAGES.valkey, RUN_IMAGES.s3]) expect(created.some((call) => call.args.includes(image))).toBe(true);
  });

  it('runs the migration once, before the app starts, from the same image', async () => {
    const fake = fakeDocker(world());
    await runLocalRepository(context(fake));
    const runs = fake.calls.filter((call) => call.args[0] === 'run' && !call.args.includes('--rm'));
    const migrate = runs.findIndex((call) => call.args.includes('sh'));
    const app = runs.findIndex((call) => call.args.includes('--network-alias') && call.args[call.args.indexOf('--network-alias') + 1] === 'app');
    expect(runs.filter((call) => call.args.includes('sh'))).toHaveLength(1);
    expect(migrate).toBeGreaterThan(-1);
    expect(migrate).toBeLessThan(app);
    expect(runs[migrate]!.args.slice(-3)).toEqual(['sh', '-c', 'npx prisma migrate deploy']);
    expect(runs[migrate]!.args).toContain(`deployz-campaign/repo-001:${COMMIT.slice(0, 12)}`);
  });

  it('starts no dependency the manifest does not need and marks its probes NOT_APPLICABLE', async () => {
    const fake = fakeDocker(world());
    const result = await runLocalRepository(context(fake, { manifest: { ...FULL, postgres: false, redis: false, storage: false, migrationCommand: null } }));
    const started = fake.calls.filter((call) => call.args[0] === 'run' && call.args.includes('--network-alias')).map((call) => call.args[call.args.indexOf('--network-alias') + 1]);
    expect(started).toEqual(['app']);
    const probes = result.stages.probes.evidence['probes'] as Record<string, { status: string }>;
    expect(probes['migration']!.status).toBe('NOT_APPLICABLE');
    expect(probes['dbWrite']!.status).toBe('NOT_APPLICABLE');
    expect(probes['redis']!.status).toBe('NOT_APPLICABLE');
    expect(probes['storage']!.status).toBe('NOT_APPLICABLE');
    expect(result.classification).toBe('local-success');
  });

  it('fails the run stage when the migration exits non-zero, skips the probes and still cleans up', async () => {
    const fake = fakeDocker(world({ migrationExit: 3 }));
    const result = await runLocalRepository(context(fake));
    expect(result.stages.run).toMatchObject({ status: 'FAIL', evidence: { failure: 'migration' } });
    expect(result.stages.probes.status).toBe('SKIPPED');
    expect(result.stages.cleanup.status).toBe('PASS');
    expect(result.classification).toBe('run');
    expect(dockerCalls(fake, 'rm').length).toBeGreaterThan(0);
  });

  it('records a migration that leaves the schema unchanged as a FAIL probe', async () => {
    const fake = fakeDocker(world({ tablesBefore: 2, tablesAfter: 2 }));
    const result = await runLocalRepository(context(fake));
    const probes = result.stages.probes.evidence['probes'] as Record<string, { status: string; detail: string }>;
    expect(probes['migration']).toMatchObject({ status: 'FAIL' });
    expect(result.stages.probes.status).toBe('FAIL');
    expect(result.classification).toBe('probes');
  });

  it('fails dbWrite when no application row exists', async () => {
    const fake = fakeDocker(world({ rows: 0 }));
    const result = await runLocalRepository(context(fake));
    expect((result.stages.probes.evidence['probes'] as Record<string, { status: string }>)['dbWrite']!.status).toBe('FAIL');
  });

  it('fails redis without a client or key, and keeps UNVERIFIED storage out of local-success', async () => {
    const fake = fakeDocker(world({ redisClients: 0, bucketObjects: false }));
    const result = await runLocalRepository(context(fake));
    const probes = result.stages.probes.evidence['probes'] as Record<string, { status: string }>;
    expect(probes['redis']!.status).toBe('FAIL');
    expect(probes['storage']!.status).toBe('UNVERIFIED');

    const fake2 = fakeDocker(world({ bucketObjects: false }));
    const second = await runLocalRepository(context(fake2, { runsDir: join(dir, 'runs2') }));
    expect(second.stages.probes.status).toBe('PASS');
    expect(second.classification).toBe('local-unverified');
  });

  it('polls health until 200-399 and records a timeout window failure as health FAIL', async () => {
    const fake = fakeDocker(world({ health: [502, 503, 302] }));
    const ok = await runLocalRepository(context(fake));
    expect((ok.stages.probes.evidence['probes'] as Record<string, { status: string }>)['health']!.status).toBe('PASS');

    const slow = fakeDocker(world({ health: [503] }));
    const started = slow.clock.now();
    const failed = await runLocalRepository(context(slow, { runsDir: join(dir, 'runs2') }));
    const probes = failed.stages.probes.evidence['probes'] as Record<string, { status: string; detail: string }>;
    expect(probes['health']).toMatchObject({ status: 'FAIL', detail: expect.stringContaining('last status 503') });
    expect(slow.clock.now() - started).toBeGreaterThanOrEqual(HEALTH_WINDOW_MS - 10_000);
    expect(failed.classification).toBe('probes');
  });

  it('records start FAIL and health FAIL when the app container exits', async () => {
    const fake = fakeDocker(world({ appRunning: false }));
    const result = await runLocalRepository(context(fake));
    const probes = result.stages.probes.evidence['probes'] as Record<string, { status: string; detail: string }>;
    expect(probes['health']!.detail).toContain('exited');
    expect(probes['start']!.status).toBe('FAIL');
  });

  it('waits the start window before the start probe', async () => {
    const fake = fakeDocker(world());
    const before = fake.clock.now();
    await runLocalRepository(context(fake));
    expect(fake.clock.now() - before).toBeGreaterThanOrEqual(START_WINDOW_MS);
  });

  it('removes the sanitized secrets from the evidence', async () => {
    const fake = fakeDocker(world());
    const result = await runLocalRepository(context(fake));
    const text = JSON.stringify(result);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain('generated-session-secret');
    expect(text).not.toContain('abcdef');
  });

  it('cleanup removes the labelled resources, the image and the build cache, and keeps both with keepImage', async () => {
    const fake = fakeDocker(world());
    const result = await runLocalRepository(context(fake));
    expect(result.stages.cleanup.evidence).toMatchObject({ imageRemoved: true, buildCachePruned: true, keepImage: false });
    expect(fake.calls.some((call) => call.args[0] === 'image' && call.args[1] === 'rm')).toBe(true);
    expect(fake.calls.some((call) => call.args[0] === 'builder' && call.args[1] === 'prune')).toBe(true);

    const keep = fakeDocker(world());
    const kept = await runLocalRepository(context(keep, { keepImage: true, runsDir: join(dir, 'runs2') }));
    expect(kept.stages.cleanup.evidence).toMatchObject({ imageRemoved: false, buildCachePruned: false, keepImage: true });
    expect(keep.calls.some((call) => call.args[0] === 'image' && call.args[1] === 'rm')).toBe(false);
    expect(keep.calls.some((call) => call.args[0] === 'builder' && call.args[1] === 'prune')).toBe(false);
  });

  it('fails the cleanup stage when a labelled resource remains', async () => {
    const fake = fakeDocker(world({ leakAfterRemove: true }));
    const result = await runLocalRepository(context(fake));
    expect(result.stages.cleanup).toMatchObject({ status: 'FAIL', detail: expect.stringContaining('remain') });
    expect(result.classification).toBe('cleanup');
  });

  it('runs cleanup when the harness itself throws, and leaves the run stage IN_PROGRESS', async () => {
    const fake = fakeDocker(world({ throwOnApp: true }));
    await expect(runLocalRepository(context(fake))).rejects.toThrow('docker daemon vanished');
    const saved = readLocalResult(join(dir, 'runs'), 'repo-001')!;
    expect(saved.stages.run.status).toBe('IN_PROGRESS');
    expect(saved.stages.cleanup.status).toBe('PASS');
    expect(dockerCalls(fake, 'rm').length).toBeGreaterThan(0);
  });

  it('skips run and probes without a passing build, and cleans up only when a build was attempted', async () => {
    const rejected = fakeDocker(world());
    const gated = await runLocalRepository(context(rejected, { gate: { status: 'PASS', detail: null, evidence: {}, build: false } }));
    expect(gated.stages.run.status).toBe('SKIPPED');
    expect(gated.stages.probes.status).toBe('SKIPPED');
    expect(gated.stages.cleanup.status).toBe('SKIPPED');
    expect(rejected.calls.filter((call) => call.file === 'docker')).toEqual([]);
  });
});

describe('--resume', () => {
  it('reconciles labelled leftovers before any stage', async () => {
    const state = world({ containers: ['old-app', 'old-db'] });
    const fake = fakeDocker(state);
    const found = await reconcileLeftovers(fake.run, {}, ['repo-001', 'repo-002']);
    expect(found['repo-001']).toMatchObject({ containers: 2 });
    const filters = fake.calls.filter((call) => call.args[0] === 'ps').map((call) => call.args.join(' '));
    expect(filters[0]).toContain('label=deployz-campaign=fresh-100');
    expect(filters[0]).toContain('label=deployz-campaign-repo=repo-001');
    expect(filters[1]).toContain('label=deployz-campaign-repo=repo-002');
    expect(state.containers).toEqual([]);
    expect(fake.calls.some((call) => call.args[0] === 'rm' && call.args.includes('-v') && call.args.includes('-f'))).toBe(true);
  });

  it('skips a repository whose stages are all finished, even though the image is gone', async () => {
    const first = fakeDocker(world());
    await runLocalRepository(context(first));
    const second = fakeDocker(world({ imagePresent: false }));
    const result = await runLocalRepository(context(second, { resume: true }));
    expect(result.classification).toBe('local-success');
    expect(second.calls).toEqual([]);
  });

  it('keeps a recorded run FAIL and does not run it again', async () => {
    const first = fakeDocker(world({ migrationExit: 1 }));
    await runLocalRepository(context(first));
    const second = fakeDocker(world());
    const result = await runLocalRepository(context(second, { resume: true }));
    expect(result.stages.run.status).toBe('FAIL');
    expect(second.calls).toEqual([]);
  });

  it('redoes run and probes when probes was left IN_PROGRESS, keeping gate, source and build', async () => {
    const fake = fakeDocker(world());
    const open = emptyLocalResult(identity());
    for (const name of ['gate', 'source', 'build', 'run'] as const) open.stages[name].status = 'PASS';
    open.stages.probes.status = 'IN_PROGRESS';
    writeLocalResult(join(dir, 'runs'), open);
    const result = await runLocalRepository(context(fake, { resume: true }));
    expect(dockerCalls(fake, 'build')).toHaveLength(0);
    expect(result.stages.run.status).toBe('PASS');
    expect(result.stages.probes.status).toBe('PASS');
    expect(result.stages.cleanup.status).toBe('PASS');
  });

  it('rebuilds a finished build whose image is gone when later stages are open', async () => {
    const open = emptyLocalResult(identity());
    for (const name of ['gate', 'source', 'build'] as const) open.stages[name].status = 'PASS';
    writeLocalResult(join(dir, 'runs'), open);
    const fake = fakeDocker(world({ imagePresent: false }));
    const result = await runLocalRepository(context(fake, { resume: true }));
    expect(dockerCalls(fake, 'build')).toHaveLength(1);
    expect(result.stages.build.evidence['rebuilt']).toBe(true);
    expect(result.classification).toBe('local-success');
  });

  it('starts again when the inputs hash changed', async () => {
    const first = fakeDocker(world());
    await runLocalRepository(context(first));
    const second = fakeDocker(world());
    await runLocalRepository(context(second, { resume: true, identity: identity('hash-2') }));
    expect(dockerCalls(second, 'build')).toHaveLength(1);
  });

  it('parses --keep-image and --resume', () => {
    expect(parseRunArgs(['--local']).keepImage).toBe(false);
    expect(parseRunArgs(['--local', '--keep-image']).keepImage).toBe(true);
  });
});

describe('local summary', () => {
  function done(id: string, probeStatuses: Record<string, string>, classification: string | null): ReturnType<typeof emptyLocalResult> {
    const result = emptyLocalResult({ ...identity(), id });
    for (const name of ['gate', 'source', 'build', 'run', 'cleanup'] as const) {
      result.stages[name] = { ...result.stages[name], status: 'PASS', durationMs: 1000 };
    }
    result.stages.probes = {
      ...result.stages.probes,
      status: 'PASS',
      durationMs: 2000,
      evidence: { probes: Object.fromEntries(Object.entries(probeStatuses).map(([name, status]) => [name, { status, detail: null }])) },
    };
    result.classification = classification;
    return result;
  }

  it('counts attempted, PASS, FAIL, UNVERIFIED and NOT_APPLICABLE per stage and probe, with durations', () => {
    const failed = done('repo-002', { health: 'FAIL', start: 'PASS' }, 'probes');
    failed.stages.probes.status = 'FAIL';
    const skipped = emptyLocalResult({ ...identity(), id: 'repo-003' });
    skipped.stages.gate.status = 'PASS';
    skipped.stages.source.status = 'SKIPPED';
    const summary = buildLocalSummary([done('repo-001', { health: 'PASS', start: 'PASS', redis: 'NOT_APPLICABLE', storage: 'UNVERIFIED' }, 'local-unverified'), failed, skipped]);
    expect(summary.repositories).toBe(3);
    expect(summary.stages.gate).toMatchObject({ attempted: 3, PASS: 3 });
    expect(summary.stages.probes).toMatchObject({ attempted: 2, PASS: 1, FAIL: 1, NOT_ATTEMPTED: 1 });
    expect(summary.stages.source).toMatchObject({ SKIPPED: 1 });
    expect(summary.probes.health).toMatchObject({ attempted: 2, PASS: 1, FAIL: 1 });
    expect(summary.probes.redis).toMatchObject({ attempted: 1, NOT_APPLICABLE: 1 });
    expect(summary.probes.storage).toMatchObject({ UNVERIFIED: 1 });
    expect(summary.classifications).toEqual({ 'local-unverified': 1, probes: 1, incomplete: 1 });
    expect(summary.durations.find((row) => row.id === 'repo-001')!.totalMs).toBe(7000);
    expect(renderLocalSummary(summary)).toContain('| health | 2 | 1 | 1 | 0 | 0 |');
  });

  it('writes local-summary.json and local-summary.md over every *.local.json', () => {
    const runs = join(dir, 'runs');
    writeLocalResult(runs, done('repo-001', { health: 'PASS' }, null));
    writeFileSync(join(runs, 'repo-001.json'), '{}');
    const summary = writeLocalSummary(runs);
    expect(summary.repositories).toBe(1);
    expect(JSON.parse(readFileSync(join(runs, 'local-summary.json'), 'utf8')).repositories).toBe(1);
    expect(readFileSync(join(runs, 'local-summary.md'), 'utf8')).toContain('# Local Docker run summary');
  });

  it('classifies a passing run with an UNVERIFIED probe as local-unverified', () => {
    const result = done('repo-001', { storage: 'UNVERIFIED' }, null);
    expect(classifyLocal(result)).toBe('local-unverified');
  });
});

describe('localAppEnvironment', () => {
  it('turns the app URL token into the in-network address and generates secrets', () => {
    const env = localAppEnvironment(
      { id: 'repo-001', findings: [], notes: [], config: [{ key: 'APP_URL', value: '${DEPLOYZ_APP_URL}/x' }], secrets: ['AUTH_SECRET', { key: 'FROM_ENV', fromEnv: 'SOME_VAR' }] },
      { SOME_VAR: 'given' },
    );
    expect(env[0]).toEqual({ name: 'APP_URL', value: 'http://app/x' });
    expect(env.find((entry) => entry.name === 'AUTH_SECRET')!.value.length).toBeGreaterThan(20);
    expect(env.find((entry) => entry.name === 'FROM_ENV')!.value).toBe('given');
  });
});

describe('production drift guard for the run stage', () => {
  it('keeps the PostgreSQL engine major version the compiler plans', () => {
    const footprint = readFileSync(join(REPO_ROOT, 'packages', 'contracts', 'src', 'footprint.ts'), 'utf8');
    expect(footprint).toMatch(/DATABASE_ENGINE_VERSION = '16'/);
    expect(RUN_IMAGES.postgres).toContain('postgres:16');
  });
});
