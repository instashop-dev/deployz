import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseRunArgs, requireRealAws } from './index.js';
import {
  BUILD_PLATFORM,
  DOCKER_HUB_RATE_LIMIT_PATTERN,
  PREFLIGHT_BLOCKED_DETAIL,
  buildImage,
  childEnvironment,
  dockerBuildCommand,
  fetchSourceArchive,
  imageTag,
  runLocalBuild,
  selectBuildInputs,
  sourceArchivePath,
  type ArchiveFetch,
  type LocalBuildContext,
  type ProcessOptions,
  type ProcessResult,
  type RunProcess,
} from './local-build.js';
import { classifyLocal, emptyLocalResult, inputsHash, readLocalResult, recordStage, sanitizeLocal, writeLocalResult, type LocalIdentity } from './local-results.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const COMMIT = 'c'.repeat(40);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'local-build-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Call {
  file: string;
  args: readonly string[];
  options: ProcessOptions;
}

function fakeRunner(handler: (call: Call) => Partial<ProcessResult>): { run: RunProcess; calls: Call[] } {
  const calls: Call[] = [];
  const run: RunProcess = async (file, args, options) => {
    const call = { file, args, options };
    calls.push(call);
    return { exitCode: 0, output: '', timedOut: false, ...handler(call) };
  };
  return { run, calls };
}

describe('selectBuildInputs', () => {
  const cases: { name: string; detected: Record<string, unknown>; overrides?: { dockerfilePath?: string; buildContext?: string }; expected: [string, string] }[] = [
    { name: 'root Dockerfile', detected: { dockerfilePath: 'Dockerfile' }, expected: ['Dockerfile', '.'] },
    { name: 'backend/Dockerfile builds from backend', detected: { dockerfilePath: 'backend/Dockerfile' }, expected: ['backend/Dockerfile', 'backend'] },
    { name: 'docker/Dockerfile builds from the root', detected: { dockerfilePath: 'docker/Dockerfile' }, expected: ['docker/Dockerfile', '.'] },
    { name: 'nested foo/docker/Dockerfile builds from foo/docker', detected: { dockerfilePath: 'foo/docker/Dockerfile' }, expected: ['foo/docker/Dockerfile', 'foo/docker'] },
    { name: 'detected context follows the detected Dockerfile', detected: { dockerfilePath: 'apps/web/Dockerfile', dockerfileBuildContext: '.' }, expected: ['apps/web/Dockerfile', '.'] },
    { name: 'override Dockerfile ignores the detected context', detected: { dockerfilePath: 'a/Dockerfile', dockerfileBuildContext: '.' }, overrides: { dockerfilePath: 'b/Dockerfile' }, expected: ['b/Dockerfile', 'b'] },
    { name: 'override context wins', detected: { dockerfilePath: 'a/Dockerfile', dockerfileBuildContext: 'x' }, overrides: { buildContext: 'y' }, expected: ['a/Dockerfile', 'y'] },
    { name: 'empty overrides are ignored', detected: { dockerfilePath: 'a/Dockerfile' }, overrides: { dockerfilePath: '', buildContext: '' }, expected: ['a/Dockerfile', 'a'] },
  ];
  it.each(cases)('$name', ({ detected, overrides, expected }) => {
    expect(selectBuildInputs(detected, overrides)).toEqual({ dockerfilePath: expected[0], buildContext: expected[1] });
  });

  it('has no inputs when the manifest has no Dockerfile: no `Dockerfile` default', () => {
    expect(selectBuildInputs({})).toBeNull();
    expect(selectBuildInputs({ dockerfilePath: '' }, { dockerfilePath: '' })).toBeNull();
    expect(selectBuildInputs({ dockerfileBuildContext: 'x' }, { buildContext: 'y' })).toBeNull();
  });
});

describe('production drift guard', () => {
  const worker = readFileSync(join(REPO_ROOT, 'packages', 'cdk', 'src', 'lambda', 'worker.ts'), 'utf8');
  const pipeline = readFileSync(join(REPO_ROOT, 'packages', 'cdk', 'src', 'pipeline', 'build-pipeline.ts'), 'utf8');

  it('worker.ts still has the Dockerfile and context precedence the harness copies', () => {
    for (const line of [
      "const dir = dockerfilePath.includes('/') ? dockerfilePath.slice(0, dockerfilePath.lastIndexOf('/')) : '.';",
      "return dir === 'docker' ? '.' : undefined;",
      "(application.detectedMetadata?.['dockerfilePath'] as string | undefined) ??",
      "'Dockerfile';",
      "const detectedBuildContext = application.detectedMetadata?.['dockerfileBuildContext'];",
      "(overrideDockerfile === undefined && typeof detectedBuildContext === 'string' ? detectedBuildContext : undefined) ??",
      'resolveBuildContext(dockerfilePath);',
    ]) {
      expect(worker, line).toContain(line);
    }
    expect(worker).toMatch(/overrideDockerfile \?\?\s+\(application\.detectedMetadata/);
    expect(worker).toMatch(/overrideBuildContext \?\?\s+\(overrideDockerfile/);
  });

  it('build-pipeline.ts still has the buildspec context fallback, extraction and rate-limit pattern', () => {
    expect(pipeline).toContain('export BUILD_CONTEXT=${BUILD_CONTEXT:-$(dirname "$DOCKERFILE_PATH")}');
    expect(pipeline).toContain('tar xzf /tmp/source.tar.gz -C /tmp/src --strip-components=1');
    expect(pipeline).toContain(`const DOCKER_HUB_RATE_LIMIT_PATTERN = '${DOCKER_HUB_RATE_LIMIT_PATTERN}';`);
    expect(pipeline).toContain('Duration.minutes(props.timeoutMinutes ?? 30)');
  });
});

describe('docker build command and environment', () => {
  const inputs = { dockerfilePath: 'backend/Dockerfile', buildContext: 'backend' };

  it('composes the arguments with the platform, labels and tag, and nothing that opens the host', () => {
    const args = dockerBuildCommand('repo-001', COMMIT, dir, inputs, ['NEXT_PUBLIC_X']);
    expect(args.slice(0, 3)).toEqual(['build', '--platform', BUILD_PLATFORM]);
    expect(BUILD_PLATFORM).toBe('linux/amd64');
    expect(args).toContain('deployz-campaign=fresh-100');
    expect(args).toContain('deployz-campaign-repo=repo-001');
    expect(args[args.indexOf('-t') + 1]).toBe(`deployz-campaign/repo-001:${'c'.repeat(12)}`);
    expect(args[args.indexOf('-f') + 1]).toBe(resolve(dir, 'backend/Dockerfile'));
    expect(args.slice(-3)).toEqual(['--build-arg', 'NEXT_PUBLIC_X', resolve(dir, 'backend')]);
    for (const forbidden of ['-v', '--volume', '--mount', '--network', '--privileged', '--secret', '--ssh', '--env-file', '-e']) {
      expect(args).not.toContain(forbidden);
    }
  });

  it('passes only an allowlisted environment plus the build-arg values', async () => {
    const host = { PATH: '/bin', SystemRoot: 'C:\\Windows', DOCKER_HOST: 'npipe://x', AWS_SECRET_ACCESS_KEY: 'aws-secret', GITHUB_TOKEN: 'gh-token', DATABASE_URL: 'postgres://x' };
    expect(childEnvironment(host, [{ name: 'BUILD_FLAG', value: 'v1' }])).toEqual({ PATH: '/bin', SystemRoot: 'C:\\Windows', DOCKER_HOST: 'npipe://x', BUILD_FLAG: 'v1' });

    const { run, calls } = fakeRunner((call) => (call.args[0] === 'image' ? { output: 'sha256:abc 1234' } : {}));
    const result = await buildImage({ id: 'repo-001', commit: COMMIT, sourceDir: dir, inputs, buildArgs: [{ name: 'BUILD_FLAG', value: 'v1' }], logPath: join(dir, 'logs', 'b.log'), hostEnv: host, run });
    expect(result.status).toBe('PASS');
    expect(result.evidence).toMatchObject({ imageId: 'sha256:abc', imageBytes: 1234, exitCode: 0, platform: BUILD_PLATFORM, dockerfilePath: 'backend/Dockerfile', buildContext: 'backend' });
    const build = calls[0]!;
    expect(build.file).toBe('docker');
    expect(build.args).not.toContain('v1');
    expect(build.options.env).toEqual({ PATH: '/bin', SystemRoot: 'C:\\Windows', DOCKER_HOST: 'npipe://x', BUILD_FLAG: 'v1' });
    expect(build.options.timeoutMs).toBe(30 * 60_000);
  });
});

describe('build outcome classification', () => {
  const request = (run: RunProcess, buildArgs: { name: string; value: string }[] = []) => ({
    id: 'repo-001',
    commit: COMMIT,
    sourceDir: dir,
    inputs: { dockerfilePath: 'Dockerfile', buildContext: '.' },
    buildArgs,
    logPath: join(dir, 'b.log'),
    hostEnv: {},
    run,
  });

  it('records a timeout', async () => {
    const result = await buildImage(request(fakeRunner(() => ({ exitCode: null, timedOut: true })).run));
    expect(result).toMatchObject({ status: 'FAIL', failure: 'timeout' });
  });

  it('records a Docker Hub rate limit as infrastructure, not as an application failure', async () => {
    const result = await buildImage(request(fakeRunner(() => ({ exitCode: 1, output: 'error: toomanyrequests: You have reached your pull rate limit' })).run));
    expect(result).toMatchObject({ status: 'FAIL', failure: 'infrastructure' });
  });

  it('records a missing Dockerfile or a failing step as a build failure with a sanitized log tail', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `step ${i}`).concat('ERROR leaked s3cr3t-value by dev@example.com');
    const result = await buildImage(request(fakeRunner(() => ({ exitCode: 1, output: lines.join('\n') })).run, [{ name: 'TOKEN', value: 's3cr3t-value' }]));
    expect(result).toMatchObject({ status: 'FAIL', failure: 'build', detail: 'docker build exited 1' });
    const tail = result.evidence['logTail'] as string;
    expect(tail.split('\n')).toHaveLength(40);
    expect(tail).not.toContain('s3cr3t-value');
    expect(tail).not.toContain('dev@example.com');
  });
});

describe('sanitizeLocal', () => {
  it('removes secret values, bearer tokens, AWS key ids, private keys and emails', () => {
    const text = 'a hunter2 b Bearer abc.def-ghi c AKIAABCDEFGHIJKLMNOP d -----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY----- e me@example.com';
    const out = sanitizeLocal(text, ['hunter2']);
    for (const leaked of ['hunter2', 'abc.def-ghi', 'AKIAABCDEFGHIJKLMNOP', 'MIIB', 'me@example.com']) expect(out).not.toContain(leaked);
  });
});

describe('fetchSourceArchive', () => {
  const response = (status: number, headers: Record<string, string> = {}, body = 'tar-bytes') => ({
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
  });

  it('follows the redirect by hand, sends the token only to GitHub and caches by commit', async () => {
    const seen: { url: string; headers: Record<string, string> | undefined }[] = [];
    const fetchFn: ArchiveFetch = async (url, init) => {
      seen.push({ url, headers: init.headers });
      return url.startsWith('https://api.github.com') ? response(302, { location: 'https://codeload.github.com/x' }) : response(200);
    };
    const path = sourceArchivePath(join(dir, 'cache'), 'acme/api', COMMIT);
    expect(path).toBe(join(dir, 'cache', 'source', 'acme__api', `${COMMIT}.tar.gz`));
    await expect(fetchSourceArchive(fetchFn, 'tok', 'acme/api', COMMIT, path)).resolves.toEqual({ cached: false, bytes: 9 });
    expect(seen[0]).toMatchObject({ url: `https://api.github.com/repos/acme/api/tarball/${COMMIT}` });
    expect(seen[0]!.headers?.['Authorization']).toBe('Bearer tok');
    expect(seen[1]).toEqual({ url: 'https://codeload.github.com/x', headers: undefined });
    expect(readFileSync(path, 'utf8')).toBe('tar-bytes');
    expect(existsSync(`${path}.tmp`)).toBe(false);
    await expect(fetchSourceArchive(fetchFn, 'tok', 'acme/api', COMMIT, path)).resolves.toEqual({ cached: true, bytes: null });
    expect(seen).toHaveLength(2);
  });

  it('fails on an HTTP error and leaves no archive', async () => {
    const path = join(dir, 'a.tar.gz');
    await expect(fetchSourceArchive(async () => response(404), null, 'acme/api', COMMIT, path)).rejects.toThrow('HTTP 404');
    expect(existsSync(path)).toBe(false);
  });
});

describe('local result', () => {
  const identity = (hash: string): LocalIdentity => ({
    id: 'repo-001',
    repository: 'acme/api',
    commit: COMMIT,
    set: 'improvement',
    cohort: 'realistic',
    deployzCommit: 'd'.repeat(40),
    analysisVersion: 45,
    ai: null,
    inputsHash: hash,
  });

  it('hashes every input that decides a result', () => {
    const base = { deployzCommit: 'a', commit: 'b', aiMode: 'off', config: { id: 'repo-001' } };
    expect(inputsHash(base)).toBe(inputsHash({ ...base }));
    for (const change of [{ deployzCommit: 'x' }, { commit: 'x' }, { aiMode: 'live' }, { config: { id: 'repo-002' } }]) {
      expect(inputsHash({ ...base, ...change })).not.toBe(inputsHash(base));
    }
  });

  it('writes IN_PROGRESS before the work, atomically, and keeps it when the work throws', async () => {
    const result = emptyLocalResult(identity('h'));
    let seenInProgress: string | undefined;
    await expect(
      recordStage(dir, result, 'gate', async () => {
        seenInProgress = readLocalResult(dir, 'repo-001')?.stages.gate.status;
        throw new Error('harness failure');
      }),
    ).rejects.toThrow('harness failure');
    expect(seenInProgress).toBe('IN_PROGRESS');
    expect(readLocalResult(dir, 'repo-001')?.stages.gate.status).toBe('IN_PROGRESS');
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('classifies local-success only when every stage passes, otherwise the first failing stage', () => {
    const result = emptyLocalResult(identity('h'));
    expect(classifyLocal(result)).toBeNull();
    for (const name of ['gate', 'source', 'build', 'run', 'probes', 'cleanup'] as const) result.stages[name].status = 'PASS';
    expect(classifyLocal(result)).toBe('local-success');
    result.stages.build.status = 'FAIL';
    result.stages.probes.status = 'FAIL';
    expect(classifyLocal(result)).toBe('build');
  });
});

describe('runLocalBuild', () => {
  const fetchOk: ArchiveFetch = async () => ({ status: 200, headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode('x').buffer as ArrayBuffer });
  let builds: number;
  let imagePresent: boolean;
  let buildExit: number;

  const runner = () =>
    fakeRunner((call) => {
      if (call.file === 'docker' && call.args[0] === 'build') {
        builds += 1;
        return { exitCode: buildExit, output: buildExit === 0 ? 'built' : 'failed' };
      }
      if (call.file === 'docker' && call.args[0] === 'image') return imagePresent ? { output: 'sha256:abc 10' } : { exitCode: 1 };
      return {};
    });

  const context = (overrides: Partial<LocalBuildContext> = {}): LocalBuildContext => ({
    identity: {
      id: 'repo-001',
      repository: 'acme/api',
      commit: COMMIT,
      set: 'improvement',
      cohort: 'realistic',
      deployzCommit: 'd'.repeat(40),
      analysisVersion: 45,
      ai: { mode: 'off' },
      inputsHash: 'hash-1',
    },
    gate: { status: 'PASS', detail: null, evidence: { verdict: 'READY' }, build: true },
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
    run: runner().run,
    hostEnv: {},
    tmpRoot: dir,
    ...overrides,
  });

  beforeEach(() => {
    builds = 0;
    imagePresent = true;
    buildExit = 0;
  });

  it('records gate, source and build and leaves the run stages unattempted; removes the source directory', async () => {
    const { run, calls } = runner();
    const result = await runLocalBuild(context({ run }));
    expect(result.stages.gate.status).toBe('PASS');
    expect(result.stages.source.status).toBe('PASS');
    expect(result.stages.build.status).toBe('PASS');
    expect(result.stages.run.status).toBe('NOT_ATTEMPTED');
    expect(result.classification).toBeNull();
    expect(calls.find((call) => call.file === 'tar')?.args).toEqual(['xzf', `${COMMIT}.tar.gz`, '-C', expect.stringContaining('deployz-local-repo-001-'), '--strip-components=1']);
    expect(calls.find((call) => call.file === 'tar')?.options.cwd).toBe(join(dir, 'cache', 'source', 'acme__api'));
    expect(readLocalResult(join(dir, 'runs'), 'repo-001')).toEqual(result);
    expect(imageTag('repo-001', COMMIT)).toBe(result.stages.build.evidence['image']);
    expect(readdirSync(dir).filter((name) => name.startsWith('deployz-local-'))).toEqual([]);
  });

  it('skips source and build when the gate does not accept the repository', async () => {
    const result = await runLocalBuild(context({ gate: { status: 'PASS', detail: null, evidence: { verdict: 'NOT_COMPATIBLE' }, build: false } }));
    expect(result.stages.source.status).toBe('SKIPPED');
    expect(result.stages.build.status).toBe('SKIPPED');
    expect(builds).toBe(0);
  });

  it('records a failed source and skips the build', async () => {
    const result = await runLocalBuild(context({ fetchFn: async () => ({ status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }) }));
    expect(result.stages.source).toMatchObject({ status: 'FAIL', detail: expect.stringContaining('HTTP 404') });
    expect(result.stages.build.status).toBe('SKIPPED');
    expect(builds).toBe(0);
  });

  it('records FAIL without a docker build when production preflight blocks dockerfile-missing', async () => {
    const result = await runLocalBuild(context({ detectedMetadata: {}, overrides: {} }));
    expect(result.stages.source.status).toBe('PASS');
    expect(result.stages.build).toMatchObject({ status: 'FAIL', detail: PREFLIGHT_BLOCKED_DETAIL, evidence: { failure: 'preflight' } });
    expect(PREFLIGHT_BLOCKED_DETAIL).toBe('production preflight blocks: dockerfile-missing');
    expect(result.classification).toBe('build');
    expect(builds).toBe(0);
  });

  it('builds the vendor override Dockerfile with the production context rule, not the detected one', async () => {
    const { run, calls } = runner();
    await runLocalBuild(context({ run, detectedMetadata: {}, overrides: { dockerfilePath: 'docker/services/Dockerfile' } }));
    const args = calls.find((call) => call.args[0] === 'build')!.args;
    expect(args[args.indexOf('-f') + 1]).toMatch(/docker[\\/]services[\\/]Dockerfile$/);
    expect(args.at(-1)).toMatch(/docker[\\/]services$/);
  });

  it('records a failed build as FAIL with the classification build', async () => {
    buildExit = 1;
    const result = await runLocalBuild(context());
    expect(result.stages.build).toMatchObject({ status: 'FAIL', evidence: { failure: 'build' } });
    expect(result.classification).toBe('build');
  });

  describe('--resume', () => {
    it('keeps a finished build with the same inputs hash and an existing image', async () => {
      await runLocalBuild(context());
      expect(builds).toBe(1);
      await runLocalBuild(context({ resume: true }));
      expect(builds).toBe(1);
    });

    it('keeps a recorded build FAIL', async () => {
      buildExit = 1;
      await runLocalBuild(context());
      buildExit = 0;
      const result = await runLocalBuild(context({ resume: true }));
      expect(result.stages.build.status).toBe('FAIL');
      expect(builds).toBe(1);
    });

    it('rebuilds a PASS whose image is gone and records it', async () => {
      await runLocalBuild(context());
      imagePresent = false;
      const result = await runLocalBuild(context({ resume: true }));
      expect(builds).toBe(2);
      expect(result.stages.build.detail).toContain('rebuilt');
      expect(result.stages.build.evidence['rebuilt']).toBe(true);
    });

    it('starts again when the inputs hash changed', async () => {
      await runLocalBuild(context());
      await runLocalBuild(context({ resume: true, identity: { ...context().identity, inputsHash: 'hash-2' } }));
      expect(builds).toBe(2);
    });

    it('restarts a stage left IN_PROGRESS', async () => {
      const result = emptyLocalResult(context().identity);
      result.stages.gate.status = 'PASS';
      result.stages.source.status = 'PASS';
      result.stages.build.status = 'IN_PROGRESS';
      writeLocalResult(join(dir, 'runs'), result);
      const resumed = await runLocalBuild(context({ resume: true }));
      expect(resumed.stages.build.status).toBe('PASS');
      expect(builds).toBe(1);
    });

    it('without --resume always builds again', async () => {
      await runLocalBuild(context());
      await runLocalBuild(context());
      expect(builds).toBe(2);
    });
  });
});

describe('--local flag', () => {
  it('is a mode of its own, off by default, and needs no real-AWS opt-in even with --resume', () => {
    expect(parseRunArgs(['--gate']).local).toBe(false);
    const options = parseRunArgs(['--local', '--resume']);
    expect(options.local).toBe(true);
    expect(() => requireRealAws(options, {})).not.toThrow();
  });

  it('is exclusive with --real-aws, --cleanup, --audit and --gate', () => {
    for (const other of ['--real-aws', '--cleanup', '--audit', '--gate']) {
      expect(() => parseRunArgs(['--local', other])).toThrow('--local is exclusive');
    }
  });
});
