/**
 * The local Docker build stage of `pnpm benchmark:deploy --local`: the source
 * is packaged the way production does it (GitHub tarball of the pinned commit,
 * `tar xzf … --strip-components=1`), the Dockerfile and context follow the
 * precedence of `packages/cdk/src/lambda/worker.ts`, and `docker build` runs
 * with the platform of CodeBuild. Docker and tar are injected as `RunProcess`.
 */
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { LOCAL_STAGES, emptyLocalResult, isOpenStage, readLocalResult, recordStage, sanitizeLocal, type LocalIdentity, type LocalResult, type StageOutcome } from './local-results.js';

export const BUILD_PLATFORM = 'linux/amd64';
export const BUILD_TIMEOUT_MS = 30 * 60_000;
export const CAMPAIGN_LABEL = 'deployz-campaign=fresh-100';
/** Copy of `DOCKER_HUB_RATE_LIMIT_PATTERN` in packages/cdk/src/pipeline/build-pipeline.ts; a test guards the copy. */
export const DOCKER_HUB_RATE_LIMIT_PATTERN = 'toomanyrequests|429 Too Many Requests|pull rate limit|manifests[^ ]*: 429';
/** The build detail when the manifest has no Dockerfile: the production preflight check `dockerfile-missing` blocks the deployment. */
export const PREFLIGHT_BLOCKED_DETAIL = 'production preflight blocks: dockerfile-missing';
const LOG_TAIL_LINES = 40;
const OUTPUT_KEEP_CHARS = 200_000;

export interface ProcessResult {
  exitCode: number | null;
  /** The end of the combined stdout and stderr. */
  output: string;
  timedOut: boolean;
}

export interface ProcessOptions {
  env: Record<string, string>;
  timeoutMs: number;
  cwd?: string;
  /** The full output is appended here. */
  logPath?: string;
}

export type RunProcess = (file: string, args: readonly string[], options: ProcessOptions) => Promise<ProcessResult>;

/** Spawns the process without a shell; on timeout the whole process tree is killed. */
export const runProcess: RunProcess = (file, args, options) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(file, [...args], { env: options.env, ...(options.cwd ? { cwd: options.cwd } : {}), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    let timedOut = false;
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      if (options.logPath) appendFileSync(options.logPath, text);
      output = (output + text).slice(-OUTPUT_KEEP_CHARS);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid !== undefined) execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => undefined);
      else child.kill('SIGKILL');
    }, options.timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolvePromise({ exitCode, output, timedOut });
    });
  });

// ── Source packaging ────────────────────────────────────────────────────────

/** The part of `fetch` the archive download uses; the global `fetch` fits. */
export type ArchiveFetch = (
  url: string,
  init: { method: 'GET'; headers?: Record<string, string>; redirect?: 'manual' },
) => Promise<{ status: number; headers: { get(name: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> }>;

/** `<cacheDir>/source/<owner>__<repo>/<commit>.tar.gz` — the commit makes it immutable, so it is reused. */
export function sourceArchivePath(cacheDir: string, repository: string, commit: string): string {
  return join(cacheDir, 'source', repository.replace('/', '__'), `${commit}.tar.gz`);
}

/** `GET /repos/{owner}/{repo}/tarball/{commit}`, the redirect followed by hand as `fetchRepoArchive` does. */
export async function fetchSourceArchive(
  fetchFn: ArchiveFetch,
  token: string | null,
  repository: string,
  commit: string,
  archivePath: string,
): Promise<{ cached: boolean; bytes: number | null }> {
  if (existsSync(archivePath)) return { cached: true, bytes: null };
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  let response = await fetchFn(`https://api.github.com/repos/${repository}/tarball/${encodeURIComponent(commit)}`, { method: 'GET', headers, redirect: 'manual' });
  if (response.status === 301 || response.status === 302) {
    const location = response.headers.get('location');
    if (!location) throw new Error(`GitHub answered ${response.status} without a Location header for ${repository}`);
    response = await fetchFn(location, { method: 'GET' });
  }
  if (response.status < 200 || response.status >= 300) throw new Error(`source tarball of ${repository}@${commit.slice(0, 12)}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  mkdirSync(dirname(archivePath), { recursive: true });
  writeFileSync(`${archivePath}.tmp`, bytes);
  renameSync(`${archivePath}.tmp`, archivePath);
  return { cached: false, bytes: bytes.length };
}

/**
 * The buildspec command: `tar xzf <archive> -C <dir> --strip-components=1`. The archive is named relative to
 * its own directory because GNU tar reads `C:` in an absolute Windows path as a remote host.
 */
export async function extractSource(run: RunProcess, env: Record<string, string>, archivePath: string, sourceDir: string): Promise<void> {
  const result = await run('tar', ['xzf', basename(archivePath), '-C', sourceDir, '--strip-components=1'], { env, timeoutMs: 5 * 60_000, cwd: dirname(archivePath) });
  if (result.exitCode !== 0) throw new Error(`tar failed (exit ${result.exitCode}): ${result.output.slice(-300)}`);
}

// ── Dockerfile and context ──────────────────────────────────────────────────

export interface BuildInputs {
  dockerfilePath: string;
  buildContext: string;
}

function dirnameOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The precedence of `buildRelease` in worker.ts: a vendor override wins over
 * detection; a detected context follows the detected Dockerfile only; then the
 * top-level `docker/` rule (`resolveBuildContext`); then the buildspec fallback
 * `dirname "$DOCKERFILE_PATH"`. With neither an override nor a detected Dockerfile the
 * manifest has no `dockerfilePath`: production preflight blocks `dockerfile-missing` and
 * never builds, so there are no inputs (null) and no `Dockerfile` default.
 */
export function selectBuildInputs(
  detectedMetadata: Record<string, unknown>,
  overrides: { dockerfilePath?: string | undefined; buildContext?: string | undefined } = {},
): BuildInputs | null {
  const overrideDockerfile = nonEmpty(overrides.dockerfilePath);
  const dockerfilePath = overrideDockerfile ?? nonEmpty(detectedMetadata['dockerfilePath']);
  if (dockerfilePath === undefined) return null;
  const detectedContext = detectedMetadata['dockerfileBuildContext'];
  const dir = dirnameOf(dockerfilePath);
  const buildContext =
    nonEmpty(overrides.buildContext) ??
    (overrideDockerfile === undefined && typeof detectedContext === 'string' ? detectedContext : undefined) ??
    (dir === 'docker' ? '.' : undefined) ??
    dir;
  return { dockerfilePath, buildContext };
}

// ── Build ───────────────────────────────────────────────────────────────────

export function imageTag(id: string, commit: string): string {
  return `deployz-campaign/${id}:${commit.slice(0, 12)}`;
}

/** `docker build` arguments; build-arg values are not here, only names. */
export function dockerBuildCommand(id: string, commit: string, sourceDir: string, inputs: BuildInputs, buildArgNames: readonly string[]): string[] {
  return [
    'build',
    '--platform',
    BUILD_PLATFORM,
    '-f',
    resolve(sourceDir, inputs.dockerfilePath),
    '--label',
    CAMPAIGN_LABEL,
    '--label',
    `deployz-campaign-repo=${id}`,
    '-t',
    imageTag(id, commit),
    ...buildArgNames.flatMap((name) => ['--build-arg', name]),
    resolve(sourceDir, inputs.buildContext),
  ];
}

/** Allowlist: the host environment (tokens, AWS keys, .env values) never reaches a child process. */
export function childEnvironment(host: NodeJS.ProcessEnv, buildArgs: readonly { name: string; value: string }[] = []): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(host)) {
    if (value !== undefined && (/^(PATH|SYSTEMROOT|HOME|USERPROFILE)$/i.test(key) || key.startsWith('DOCKER_'))) env[key] = value;
  }
  for (const arg of buildArgs) env[arg.name] = arg.value;
  return env;
}

export type BuildFailure = 'timeout' | 'infrastructure' | 'build';

export interface BuildResult {
  status: 'PASS' | 'FAIL';
  failure: BuildFailure | null;
  detail: string | null;
  evidence: Record<string, unknown>;
}

export interface BuildRequest {
  id: string;
  commit: string;
  sourceDir: string;
  inputs: BuildInputs;
  buildArgs: readonly { name: string; value: string }[];
  logPath: string;
  hostEnv: NodeJS.ProcessEnv;
  run: RunProcess;
  timeoutMs?: number;
}

function lastLines(text: string, count: number): string {
  return text.trimEnd().split(/\r?\n/).slice(-count).join('\n');
}

/** The image id and size, or null fields when the image is gone. */
export async function inspectImage(run: RunProcess, env: Record<string, string>, tag: string): Promise<{ imageId: string | null; imageBytes: number | null }> {
  const result = await run('docker', ['image', 'inspect', '--format', '{{.Id}} {{.Size}}', tag], { env, timeoutMs: 60_000 });
  const [imageId, size] = result.exitCode === 0 ? result.output.trim().split(' ') : [];
  return { imageId: imageId ?? null, imageBytes: size ? Number(size) : null };
}

export async function buildImage(request: BuildRequest): Promise<BuildResult> {
  const env = childEnvironment(request.hostEnv, request.buildArgs);
  const secrets = request.buildArgs.map((arg) => arg.value);
  const timeoutMs = request.timeoutMs ?? BUILD_TIMEOUT_MS;
  mkdirSync(dirname(request.logPath), { recursive: true });
  const started = Date.now();
  const result = await request.run(
    'docker',
    dockerBuildCommand(request.id, request.commit, request.sourceDir, request.inputs, request.buildArgs.map((arg) => arg.name)),
    { env, timeoutMs, logPath: request.logPath },
  );
  const evidence: Record<string, unknown> = {
    dockerfilePath: request.inputs.dockerfilePath,
    buildContext: request.inputs.buildContext,
    platform: BUILD_PLATFORM,
    image: imageTag(request.id, request.commit),
    exitCode: result.exitCode,
    durationMs: Date.now() - started,
    buildArgNames: request.buildArgs.map((arg) => arg.name),
    logTail: sanitizeLocal(lastLines(result.output, LOG_TAIL_LINES), secrets),
  };
  if (result.timedOut) return { status: 'FAIL', failure: 'timeout', detail: `docker build exceeded ${timeoutMs / 60_000} minutes`, evidence };
  if (result.exitCode !== 0) {
    const infrastructure = new RegExp(DOCKER_HUB_RATE_LIMIT_PATTERN, 'i').test(result.output);
    return {
      status: 'FAIL',
      failure: infrastructure ? 'infrastructure' : 'build',
      detail: infrastructure ? 'Docker Hub rate limit blocked a base image download' : `docker build exited ${result.exitCode}`,
      evidence,
    };
  }
  return { status: 'PASS', failure: null, detail: null, evidence: { ...evidence, ...(await inspectImage(request.run, env, imageTag(request.id, request.commit))) } };
}

// ── Stages ──────────────────────────────────────────────────────────────────

export interface LocalBuildContext {
  identity: LocalIdentity;
  /** The gate stage, already evaluated; `build` is false when the gate rejects or the analysis failed. */
  gate: StageOutcome & { build: boolean };
  detectedMetadata: Record<string, unknown>;
  repository: string;
  overrides: { dockerfilePath?: string | undefined; buildContext?: string | undefined };
  buildArgs: readonly { name: string; value: string }[];
  resume: boolean;
  runsDir: string;
  logsDir: string;
  cacheDir: string;
  token: string | null;
  fetchFn: ArchiveFetch;
  run: RunProcess;
  hostEnv: NodeJS.ProcessEnv;
  tmpRoot: string;
}

/**
 * gate → source → build for one repository. With `resume`, a result with the
 * same `inputsHash` and a finished build is kept (a PASS whose image is gone is
 * rebuilt); any other result starts again, so an `IN_PROGRESS` stage re-runs.
 */
export async function runLocalBuild(ctx: LocalBuildContext): Promise<LocalResult> {
  const { identity } = ctx;
  const secrets = ctx.buildArgs.map((arg) => arg.value);
  let rebuilt = false;
  const existing = ctx.resume ? readLocalResult(ctx.runsDir, identity.id) : null;
  if (existing && existing.inputsHash === identity.inputsHash) {
    if (!LOCAL_STAGES.some((name) => isOpenStage(existing.stages[name]))) return existing;
    const build = existing.stages.build;
    if (build.status === 'FAIL') return existing;
    if (build.status === 'PASS') {
      const image = await inspectImage(ctx.run, childEnvironment(ctx.hostEnv), imageTag(identity.id, identity.commit));
      if (image.imageId !== null) return existing;
      rebuilt = true;
    }
  }

  const result = emptyLocalResult(identity);
  await recordStage(ctx.runsDir, result, 'gate', async () => ctx.gate, secrets);
  if (!ctx.gate.build) {
    for (const name of ['source', 'build'] as const) await recordStage(ctx.runsDir, result, name, async () => ({ status: 'SKIPPED', detail: 'the gate did not accept the repository' }), secrets);
    return result;
  }

  const sourceDir = mkdtempSync(join(ctx.tmpRoot, `deployz-local-${identity.id}-`));
  try {
    const source = await recordStage(
      ctx.runsDir,
      result,
      'source',
      async () => {
        try {
          const archivePath = sourceArchivePath(ctx.cacheDir, ctx.repository, identity.commit);
          const archive = await fetchSourceArchive(ctx.fetchFn, ctx.token, ctx.repository, identity.commit, archivePath);
          await extractSource(ctx.run, childEnvironment(ctx.hostEnv), archivePath, sourceDir);
          return { status: 'PASS', detail: null, evidence: { commit: identity.commit, archiveCached: archive.cached, archiveBytes: archive.bytes } };
        } catch (error) {
          return { status: 'FAIL', detail: error instanceof Error ? error.message : String(error), evidence: { commit: identity.commit } };
        }
      },
      secrets,
    );
    if (source.status !== 'PASS') {
      await recordStage(ctx.runsDir, result, 'build', async () => ({ status: 'SKIPPED', detail: 'the source stage failed' }), secrets);
      return result;
    }
    await recordStage(
      ctx.runsDir,
      result,
      'build',
      async () => {
        const inputs = selectBuildInputs(ctx.detectedMetadata, ctx.overrides);
        if (inputs === null) return { status: 'FAIL', detail: PREFLIGHT_BLOCKED_DETAIL, evidence: { failure: 'preflight', rebuilt } };
        const build = await buildImage({
          id: identity.id,
          commit: identity.commit,
          sourceDir,
          inputs,
          buildArgs: ctx.buildArgs,
          logPath: join(ctx.logsDir, `${identity.id}-build.log`),
          hostEnv: ctx.hostEnv,
          run: ctx.run,
        });
        return {
          status: build.status,
          detail: [rebuilt ? 'rebuilt: the recorded image was gone' : null, build.detail].filter(Boolean).join('; ') || null,
          evidence: { ...build.evidence, failure: build.failure, rebuilt },
        };
      },
      secrets,
    );
    return result;
  } finally {
    rmSync(sourceDir, { recursive: true, force: true });
  }
}
