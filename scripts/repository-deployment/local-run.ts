/**
 * The isolated run stage and the functional probes of `pnpm benchmark:deploy --local`.
 * The built image runs in a disposable Docker network with the dependencies the
 * gate manifest needs (PostgreSQL, Valkey, an S3 stand-in). Every container and
 * network carries the labels `deployz-campaign=fresh-100` and
 * `deployz-campaign-repo=<id>`; nothing is published to the host, mounted from
 * the host or given a host credential. Docker is driven through the injected
 * `RunProcess`, so unit tests use a fake.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { BUILD_PLATFORM, CAMPAIGN_LABEL, childEnvironment, imageTag, runLocalBuild, type LocalBuildContext, type RunProcess } from './local-build.js';
import { isOpenStage, recordStage, sanitizeLocal, type LocalResult, type StageOutcome } from './local-results.js';

/** Dependency and probe images, pinned by digest. */
export const RUN_IMAGES = {
  postgres: 'postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea',
  valkey: 'valkey/valkey:8-alpine@sha256:081c2f5cb575efc901aa80ff9cdbd1ec6a301682fd35e1ebb4b0990a4a4a8507',
  s3: 'chrislusf/seaweedfs@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d',
  probe: 'curlimages/curl:8.10.1@sha256:d9b4541e214bcd85196d6e92e2753ac6d0ea699f0af5741f8c6cccbfcf00ef4b',
} as const;

export const START_WINDOW_MS = 60_000;
export const HEALTH_WINDOW_MS = 5 * 60_000;
export const RUN_TIMEOUT_MS = 10 * 60_000;
const DEPENDENCY_READY_MS = 90_000;
const POLL_MS = 5_000;
const LOG_TAIL_LINES = 40;
const APP_NAME = 'app';
const DB = { host: 'db', port: 5432, name: 'app', user: 'app' } as const;
const CACHE = { host: 'cache', port: 6379 } as const;
const S3 = { host: 's3', port: 8333, region: 'us-east-1' } as const;

/** Env names the production compiler injects, copied from packages/contracts/src/capability-registry.ts (a test guards the copy). */
export const DATABASE_ENV = { DATABASE_URL: 'url', DB_HOST: 'host', DB_PORT: 'port', DB_NAME: 'database', DB_USER: 'username', DB_PASSWORD: 'password' } as const;
export const REDIS_ENV = { REDIS_URL: 'url', CACHE_URL: 'url' } as const;
export const STORAGE_ENV = { S3_BUCKET: 'bucket', AWS_S3_BUCKET: 'bucket' } as const;

/** Tables that record migrations; their rows are not application writes. */
const BOOKKEEPING_TABLES = [
  '_prisma_migrations',
  '__drizzle_migrations',
  'schema_migrations',
  'alembic_version',
  'knex_migrations',
  'knex_migrations_lock',
  'flyway_schema_history',
  'django_migrations',
  'SequelizeMeta',
  'migrations',
  'typeorm_migrations',
  'goose_db_version',
  'mikro_orm_migrations',
  'kysely_migration',
  'kysely_migration_lock',
  '_sqlx_migrations',
  'seaql_migrations',
];
const TABLE_COUNT_SQL = "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'";
const ROW_COUNT_SQL =
  "select coalesce(sum((xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::int), 0) " +
  `from information_schema.tables where table_schema='public' and table_type='BASE TABLE' and table_name not in (${BOOKKEEPING_TABLES.map((name) => `'${name}'`).join(',')})`;

export type ProbeStatus = 'PASS' | 'FAIL' | 'UNVERIFIED' | 'NOT_APPLICABLE';
export interface ProbeRecord {
  status: ProbeStatus;
  detail: string | null;
}

/** The manifest facts the run acts on (the shape of `manifestFacts`). */
export interface RunManifest {
  port: number | null;
  healthPath: string | null;
  migrationCommand: string | null;
  postgres: boolean;
  redis: boolean;
  storage: boolean;
  databaseBindings: readonly string[];
  redisBindings: readonly string[];
  storageBindings: readonly string[];
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

export interface LocalRepositoryContext extends LocalBuildContext {
  manifest: RunManifest | null;
  /** Deploy-config values and generated secrets, as the vendor would set them. */
  appEnv: readonly { name: string; value: string }[];
  keepImage: boolean;
  runId: string;
  /** A random per-run password for the database and the S3 stand-in. */
  generatePassword(): string;
  clock: Clock;
}

export function resourceNames(id: string, runId: string): Record<'network' | 'db' | 'cache' | 's3' | 'app' | 'migrate', string> {
  const prefix = `deployz-campaign-${id}-${runId}`;
  return { network: prefix, db: `${prefix}-db`, cache: `${prefix}-cache`, s3: `${prefix}-s3`, app: `${prefix}-app`, migrate: `${prefix}-migrate` };
}

function labelArgs(id: string): string[] {
  return ['--label', CAMPAIGN_LABEL, '--label', `deployz-campaign-repo=${id}`];
}

function repoFilters(id: string): string[] {
  return ['--filter', `label=${CAMPAIGN_LABEL}`, '--filter', `label=deployz-campaign-repo=${id}`];
}

// ── Environment ─────────────────────────────────────────────────────────────

function bindingNames(table: Record<string, string>, declared: readonly string[]): string[] {
  const known = Object.keys(table);
  const chosen = declared.filter((name) => known.includes(name));
  return chosen.length > 0 ? chosen : known;
}

function bindingValue(kind: string, parts: { url: string; host: string; port: number; database: string; user: string; password: string; bucket: string }): string {
  switch (kind) {
    case 'url':
      return parts.url;
    case 'host':
      return parts.host;
    case 'port':
      return String(parts.port);
    case 'database':
      return parts.database;
    case 'username':
      return parts.user;
    case 'password':
      return parts.password;
    default:
      return parts.bucket;
  }
}

/** The runtime environment of the app: the deploy-config values, then the capability bindings with local endpoints. */
export function buildAppEnvironment(
  manifest: RunManifest,
  appEnv: readonly { name: string; value: string }[],
  password: string,
  bucket: string,
): { name: string; value: string }[] {
  const env = new Map<string, string>();
  for (const { name, value } of appEnv) env.set(name, value);
  if (manifest.port !== null) env.set('PORT', String(manifest.port));
  if (manifest.postgres) {
    const base = { host: DB.host, port: DB.port, database: DB.name, user: DB.user, password, bucket };
    const url = `postgresql://${DB.user}:${password}@${DB.host}:${DB.port}/${DB.name}`;
    for (const name of bindingNames(DATABASE_ENV, manifest.databaseBindings)) env.set(name, bindingValue(DATABASE_ENV[name as keyof typeof DATABASE_ENV], { ...base, url }));
  }
  if (manifest.redis) {
    const url = `redis://${CACHE.host}:${CACHE.port}`;
    const base = { host: CACHE.host, port: CACHE.port, database: '', user: '', password: '', bucket };
    for (const name of bindingNames(REDIS_ENV, manifest.redisBindings)) env.set(name, bindingValue(REDIS_ENV[name as keyof typeof REDIS_ENV], { ...base, url }));
  }
  if (manifest.storage) {
    const base = { url: '', host: S3.host, port: S3.port, database: '', user: '', password: '', bucket };
    for (const name of bindingNames(STORAGE_ENV, manifest.storageBindings)) env.set(name, bindingValue(STORAGE_ENV[name as keyof typeof STORAGE_ENV], base));
    env.set('AWS_ENDPOINT_URL_S3', `http://${S3.host}:${S3.port}`);
    env.set('AWS_REGION', S3.region);
    env.set('AWS_ACCESS_KEY_ID', `local${password.slice(0, 12)}`);
    env.set('AWS_SECRET_ACCESS_KEY', password);
    env.set('AWS_S3_FORCE_PATH_STYLE', 'true');
  }
  return [...env].map(([name, value]) => ({ name, value }));
}

/**
 * `-e NAME` takes the value from the docker CLI's environment, so values stay off the command line.
 * An empty value or a name the allowlisted child environment already uses goes inline instead.
 */
export function envArguments(hostEnv: NodeJS.ProcessEnv, entries: readonly { name: string; value: string }[]): { args: string[]; env: Record<string, string> } {
  const env = childEnvironment(hostEnv);
  const args: string[] = [];
  for (const { name, value } of entries) {
    if (value === '' || name in env || /^(PATH|SYSTEMROOT|HOME|USERPROFILE)$/i.test(name) || name.startsWith('DOCKER_')) {
      args.push('-e', `${name}=${value}`);
    } else {
      env[name] = value;
      args.push('-e', name);
    }
  }
  return { args, env };
}

// ── Docker helpers ──────────────────────────────────────────────────────────

export interface Session {
  ctx: LocalRepositoryContext;
  names: ReturnType<typeof resourceNames>;
  env: Record<string, string>;
  secrets: string[];
  logPath: string;
  password: string;
  bucket: string;
  deadline: number;
  startedAt: number | null;
  migration: { exitCode: number | null; tablesBefore: number | null; tablesAfter: number | null; durationMs: number; logTail: string } | null;
}

async function docker(session: Pick<Session, 'ctx' | 'env' | 'logPath'>, args: readonly string[], timeoutMs = 120_000, env?: Record<string, string>) {
  return session.ctx.run('docker', args, { env: env ?? session.env, timeoutMs, logPath: session.logPath });
}

function lastLines(text: string, count: number): string {
  return text.trimEnd().split(/\r?\n/).slice(-count).join('\n');
}

async function psql(session: Session, sql: string): Promise<number | null> {
  const result = await docker(session, ['exec', session.names.db, 'psql', '-h', '127.0.0.1', '-U', DB.user, '-d', DB.name, '-tAc', sql]);
  const value = Number(lastLines(result.output, 1).trim());
  return result.exitCode === 0 && Number.isFinite(value) ? value : null;
}

/** One disposable curl container on the run network; the output is the HTTP status code. */
async function curlStatus(session: Session, method: 'GET' | 'PUT', url: string): Promise<number | null> {
  const result = await docker(session, [
    'run', '--rm', '--network', session.names.network, ...labelArgs(session.ctx.identity.id), '--memory', '128m',
    RUN_IMAGES.probe, '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '5', '-X', method, url,
  ]);
  const code = Number(result.output.trim());
  return Number.isInteger(code) && code > 0 ? code : null;
}

async function waitFor(session: Session, untilMs: number, check: () => Promise<boolean>): Promise<boolean> {
  const clock = session.ctx.clock;
  for (;;) {
    if (await check()) return true;
    if (clock.now() + POLL_MS > untilMs) return false;
    await clock.sleep(POLL_MS);
  }
}

async function containerState(session: Session, name: string): Promise<{ running: boolean; exitCode: number | null }> {
  const result = await docker(session, ['inspect', '--format', '{{.State.Running}} {{.State.ExitCode}}', name], 60_000);
  const [running, exit] = result.output.trim().split(' ');
  return { running: running === 'true', exitCode: exit === undefined || result.exitCode !== 0 ? null : Number(exit) };
}

async function logTail(session: Session, name: string): Promise<string> {
  const result = await docker(session, ['logs', '--tail', String(LOG_TAIL_LINES), name], 60_000);
  return sanitizeLocal(lastLines(result.output, LOG_TAIL_LINES), session.secrets);
}

function dependencyRun(session: Session, name: string, alias: string, image: string, extra: readonly string[], command: readonly string[] = []): string[] {
  return [
    'run', '-d', '--name', name, '--network', session.names.network, '--network-alias', alias, ...labelArgs(session.ctx.identity.id),
    '--memory', '512m', '--cpus', '1', ...extra, image, ...command,
  ];
}

// ── Run stage ───────────────────────────────────────────────────────────────

type RunFailure = 'timeout' | 'dependency' | 'migration' | 'start' | 'no-port';

function runFail(failure: RunFailure, detail: string, evidence: Record<string, unknown> = {}): StageOutcome {
  return { status: 'FAIL', detail, evidence: { ...evidence, failure } };
}

/** Network, dependencies, one-off migration, then the app container. */
export async function runApp(session: Session, manifest: RunManifest): Promise<StageOutcome> {
  const { ctx, names } = session;
  const clock = ctx.clock;
  if (manifest.port === null) return runFail('no-port', 'the manifest has no container port');
  const image = imageTag(ctx.identity.id, ctx.identity.commit);
  const created = await docker(session, ['network', 'create', '--label', CAMPAIGN_LABEL, '--label', `deployz-campaign-repo=${ctx.identity.id}`, names.network], 60_000);
  if (created.exitCode !== 0) return runFail('dependency', `docker network create failed: ${lastLines(created.output, 3)}`);

  const dependencies: string[] = [];
  const dependencyEnv = { ...session.env, POSTGRES_PASSWORD: session.password };
  const until = Math.min(session.deadline, clock.now() + DEPENDENCY_READY_MS);
  if (manifest.postgres) {
    const started = await docker(
      session,
      dependencyRun(session, names.db, DB.host, RUN_IMAGES.postgres, ['--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_PASSWORD', '-e', `POSTGRES_USER=${DB.user}`, '-e', `POSTGRES_DB=${DB.name}`]),
      300_000,
      dependencyEnv,
    );
    if (started.exitCode !== 0) return runFail('dependency', `postgres did not start: ${lastLines(started.output, 3)}`);
    dependencies.push('postgres');
  }
  if (manifest.redis) {
    const started = await docker(session, dependencyRun(session, names.cache, CACHE.host, RUN_IMAGES.valkey, ['--tmpfs', '/data']), 300_000);
    if (started.exitCode !== 0) return runFail('dependency', `valkey did not start: ${lastLines(started.output, 3)}`);
    dependencies.push('valkey');
  }
  if (manifest.storage) {
    const started = await docker(session, dependencyRun(session, names.s3, S3.host, RUN_IMAGES.s3, ['--tmpfs', '/data'], ['server', '-s3', '-dir=/data']), 300_000);
    if (started.exitCode !== 0) return runFail('dependency', `s3 stand-in did not start: ${lastLines(started.output, 3)}`);
    dependencies.push('s3-stand-in');
  }
  const ready: [string, boolean, () => Promise<boolean>][] = [
    ['postgres', manifest.postgres, async () => (await docker(session, ['exec', names.db, 'psql', '-h', '127.0.0.1', '-U', DB.user, '-d', DB.name, '-tAc', 'select 1'], 30_000)).exitCode === 0],
    ['valkey', manifest.redis, async () => (await docker(session, ['exec', names.cache, 'valkey-cli', 'ping'], 30_000)).output.includes('PONG')],
    ['s3-stand-in', manifest.storage, async () => (await curlStatus(session, 'PUT', `http://${S3.host}:${S3.port}/${session.bucket}`)) === 200],
  ];
  for (const [label, needed, check] of ready) {
    if (needed && !(await waitFor(session, until, check))) return runFail(clock.now() >= session.deadline ? 'timeout' : 'dependency', `${label} was not ready in time`, { dependencies });
  }

  const environment = buildAppEnvironment(manifest, ctx.appEnv, session.password, session.bucket);
  const { args: envArgs, env: appProcessEnv } = envArguments(ctx.hostEnv, environment);
  const limits = ['--memory', '1g', '--cpus', '1', '--platform', BUILD_PLATFORM];
  const common = ['--network', names.network, ...labelArgs(ctx.identity.id), ...limits, ...envArgs];

  let migration: Session['migration'] = null;
  if (manifest.migrationCommand !== null) {
    const tablesBefore = manifest.postgres ? await psql(session, TABLE_COUNT_SQL) : null;
    const started = clock.now();
    const result = await docker(session, ['run', '--name', names.migrate, ...common, image, 'sh', '-c', manifest.migrationCommand], Math.max(1, session.deadline - started), appProcessEnv);
    const tablesAfter = manifest.postgres ? await psql(session, TABLE_COUNT_SQL) : null;
    migration = { exitCode: result.exitCode, tablesBefore, tablesAfter, durationMs: clock.now() - started, logTail: await logTail(session, names.migrate) };
    session.migration = migration;
    if (result.timedOut) return runFail('timeout', 'the migration command exceeded the run timeout', { dependencies, migration });
    if (result.exitCode !== 0) return runFail('migration', `the migration command exited ${result.exitCode}`, { dependencies, migration });
  }

  const started = await docker(session, ['run', '-d', '--name', names.app, '--network-alias', APP_NAME, ...common, image], 120_000, appProcessEnv);
  if (started.exitCode !== 0) return runFail('start', `the app container did not start: ${sanitizeLocal(lastLines(started.output, 3), session.secrets)}`, { dependencies, migration });
  session.startedAt = clock.now();
  return {
    status: 'PASS',
    detail: null,
    evidence: { image, port: manifest.port, healthPath: manifest.healthPath, dependencies, environmentNames: environment.map((entry) => entry.name).sort(), migration },
  };
}

// ── Probes ──────────────────────────────────────────────────────────────────

/** The six probes. `dbWrite` counts rows outside the migration bookkeeping tables, read with psql inside the database container. */
export async function runProbes(session: Session, manifest: RunManifest): Promise<StageOutcome> {
  const { ctx, names } = session;
  const clock = ctx.clock;
  const probes: Record<string, ProbeRecord> = {};
  const started = session.startedAt ?? clock.now();
  let failure: string | null = null;

  const healthPath = manifest.healthPath ?? '/';
  const url = `http://${APP_NAME}:${manifest.port}${healthPath.startsWith('/') ? healthPath : `/${healthPath}`}`;
  const healthUntil = Math.min(started + HEALTH_WINDOW_MS, session.deadline);
  const seen: { lastCode: number | null; exited: number | null | undefined } = { lastCode: null, exited: undefined };
  const healthy = await waitFor(session, healthUntil, async () => {
    const state = await containerState(session, names.app);
    if (!state.running) {
      seen.exited = state.exitCode;
      return true;
    }
    seen.lastCode = await curlStatus(session, 'GET', url);
    return seen.lastCode !== null && seen.lastCode >= 200 && seen.lastCode < 400;
  });
  if (seen.exited !== undefined) probes['health'] = { status: 'FAIL', detail: `the container exited (code ${seen.exited}) before ${healthPath} answered` };
  else if (healthy) probes['health'] = { status: 'PASS', detail: `${healthPath} answered ${seen.lastCode}` };
  else {
    probes['health'] = { status: 'FAIL', detail: `${healthPath} did not answer 200-399 in ${Math.round((healthUntil - started) / 1000)} s (last status ${seen.lastCode ?? 'none'})` };
    if (clock.now() >= session.deadline) failure = 'timeout';
  }

  const remaining = started + START_WINDOW_MS - clock.now();
  if (remaining > 0) await clock.sleep(remaining);
  const after = await containerState(session, names.app);
  probes['start'] = after.running
    ? { status: 'PASS', detail: `still running ${START_WINDOW_MS / 1000} s after start` }
    : { status: 'FAIL', detail: `the container is not running (exit code ${after.exitCode ?? 'unknown'})` };

  const migration = session.migration;
  if (manifest.migrationCommand === null) probes['migration'] = { status: 'NOT_APPLICABLE', detail: 'the manifest has no migration command' };
  else if (migration === null || migration.exitCode !== 0) probes['migration'] = { status: 'FAIL', detail: 'the migration did not exit 0' };
  else if (manifest.postgres && !((migration.tablesAfter ?? 0) > (migration.tablesBefore ?? 0))) {
    probes['migration'] = { status: 'FAIL', detail: `exit 0 but the public schema kept ${migration.tablesBefore} table(s)` };
  } else probes['migration'] = { status: 'PASS', detail: manifest.postgres ? `tables ${migration.tablesBefore} -> ${migration.tablesAfter}` : 'exit 0' };

  if (!manifest.postgres) probes['dbWrite'] = { status: 'NOT_APPLICABLE', detail: 'the manifest needs no database' };
  else {
    const rows = await psql(session, ROW_COUNT_SQL);
    probes['dbWrite'] =
      rows === null
        ? { status: 'UNVERIFIED', detail: 'the row count could not be read' }
        : rows > 0
          ? { status: 'PASS', detail: `${rows} row(s) outside migration bookkeeping tables` }
          : { status: 'FAIL', detail: 'no rows outside migration bookkeeping tables' };
  }

  if (!manifest.redis) probes['redis'] = { status: 'NOT_APPLICABLE', detail: 'the manifest needs no Redis' };
  else {
    const clients = await docker(session, ['exec', names.cache, 'valkey-cli', 'CLIENT', 'LIST'], 30_000);
    const size = await docker(session, ['exec', names.cache, 'valkey-cli', 'DBSIZE'], 30_000);
    const others = clients.output.split(/\r?\n/).filter((line) => line.includes('id=') && !/cmd=client\|list/.test(line)).length;
    const keys = Number(lastLines(size.output, 1).replace(/\D/g, ''));
    probes['redis'] =
      clients.exitCode !== 0
        ? { status: 'UNVERIFIED', detail: 'CLIENT LIST failed' }
        : others > 0 || keys > 0
          ? { status: 'PASS', detail: `${others} other client(s), ${keys} key(s)` }
          : { status: 'FAIL', detail: 'no client connection and no key from the app' };
  }

  if (!manifest.storage) probes['storage'] = { status: 'NOT_APPLICABLE', detail: 'the manifest needs no storage' };
  else {
    const listing = await docker(session, [
      'run', '--rm', '--network', names.network, ...labelArgs(ctx.identity.id), '--memory', '128m', RUN_IMAGES.probe, '-s', '--max-time', '5', `http://${S3.host}:${S3.port}/${session.bucket}?list-type=2`,
    ]);
    probes['storage'] = /<Contents>/.test(listing.output)
      ? { status: 'PASS', detail: 'the bucket holds an object written by the app' }
      : { status: 'UNVERIFIED', detail: 'the bucket holds no object; reaching the bucket is not proven' };
  }

  const appLogTail = await logTail(session, names.app);
  const failed = Object.entries(probes).filter(([, probe]) => probe.status === 'FAIL').map(([name]) => name);
  return {
    status: failed.length > 0 ? 'FAIL' : 'PASS',
    detail: failed.length > 0 ? `failed: ${failed.join(', ')}` : null,
    evidence: { probes, url, appLogTail, ...(failure ? { failure } : {}) },
  };
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

function lines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/** Removes every labelled container, network and volume of one repository. Returns what it found. */
export async function removeLabelledResources(run: RunProcess, env: Record<string, string>, id: string): Promise<{ containers: number; networks: number; volumes: number }> {
  const call = (args: readonly string[]) => run('docker', args, { env, timeoutMs: 120_000 });
  const containers = lines((await call(['ps', '-a', '-q', ...repoFilters(id)])).output);
  const volumeNames: string[] = [];
  for (const container of containers) {
    const mounts = await call(['inspect', '--format', '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}', container]);
    volumeNames.push(...mounts.output.trim().split(' ').filter(Boolean));
  }
  if (containers.length > 0) await call(['rm', '-f', '-v', ...containers]);
  const networks = lines((await call(['network', 'ls', '-q', ...repoFilters(id)])).output);
  for (const network of networks) await call(['network', 'rm', network]);
  const labelled = lines((await call(['volume', 'ls', '-q', ...repoFilters(id)])).output);
  const volumes = [...new Set([...volumeNames, ...labelled])];
  for (const volume of volumes) await call(['volume', 'rm', '-f', volume]);
  return { containers: containers.length, networks: networks.length, volumes: volumes.length };
}

export async function cleanupResources(
  run: RunProcess,
  hostEnv: NodeJS.ProcessEnv,
  id: string,
  commit: string,
  keepImage: boolean,
): Promise<StageOutcome> {
  const env = childEnvironment(hostEnv);
  const removed = await removeLabelledResources(run, env, id);
  let imageRemoved = false;
  if (!keepImage) imageRemoved = (await run('docker', ['image', 'rm', imageTag(id, commit)], { env, timeoutMs: 120_000 })).exitCode === 0;
  const call = (args: readonly string[]) => run('docker', args, { env, timeoutMs: 60_000 });
  const leaks = {
    containers: lines((await call(['ps', '-a', '-q', ...repoFilters(id)])).output),
    networks: lines((await call(['network', 'ls', '-q', ...repoFilters(id)])).output),
    volumes: lines((await call(['volume', 'ls', '-q', ...repoFilters(id)])).output),
  };
  const leaked = leaks.containers.length + leaks.networks.length + leaks.volumes.length;
  return {
    status: leaked === 0 ? 'PASS' : 'FAIL',
    detail: leaked === 0 ? null : `${leaked} labelled resource(s) remain`,
    evidence: { removed, imageRemoved, keepImage, leaks },
  };
}

// ── One repository: build, run, probes, cleanup ─────────────────────────────

/**
 * gate → source → build (`runLocalBuild`), then run → probes → cleanup. Cleanup
 * runs in `finally` whenever a build was attempted. With `resume`, finished
 * stages are kept; `run` and `probes` are one unit (their containers are gone
 * after a reconcile), so an open one redoes both.
 */
export async function runLocalRepository(ctx: LocalRepositoryContext): Promise<LocalResult> {
  const result = await runLocalBuild(ctx);
  const { id, commit } = ctx.identity;
  const secrets = [...ctx.buildArgs.map((arg) => arg.value), ...ctx.appEnv.map((entry) => entry.value)];
  const buildAttempted = result.stages.build.status !== 'SKIPPED' && result.stages.build.status !== 'NOT_ATTEMPTED';
  try {
    if (isOpenStage(result.stages.run) || isOpenStage(result.stages.probes)) {
      const manifest = ctx.manifest;
      if (result.stages.build.status !== 'PASS' || manifest === null) {
        for (const name of ['run', 'probes'] as const) {
          await recordStage(ctx.runsDir, result, name, async () => ({ status: 'SKIPPED', detail: result.stages.build.status === 'PASS' ? 'no manifest' : 'the build did not pass' }), secrets);
        }
      } else {
        const password = ctx.generatePassword();
        secrets.push(password);
        mkdirSync(ctx.logsDir, { recursive: true });
        const session: Session = {
          ctx,
          names: resourceNames(id, ctx.runId),
          env: childEnvironment(ctx.hostEnv),
          secrets,
          logPath: join(ctx.logsDir, `${id}-run.log`),
          password,
          bucket: `deployz-local-${id}`,
          deadline: ctx.clock.now() + RUN_TIMEOUT_MS,
          startedAt: null,
          migration: null,
        };
        appendFileSync(session.logPath, `# run ${ctx.runId}\n`);
        const run = await recordStage(ctx.runsDir, result, 'run', () => runApp(session, manifest), secrets);
        if (run.status !== 'PASS') {
          await recordStage(ctx.runsDir, result, 'probes', async () => ({ status: 'SKIPPED', detail: 'the run stage failed' }), secrets);
        } else {
          await recordStage(ctx.runsDir, result, 'probes', () => runProbes(session, manifest), secrets);
        }
      }
    }
  } finally {
    if (isOpenStage(result.stages.cleanup)) {
      if (buildAttempted) {
        await recordStage(ctx.runsDir, result, 'cleanup', () => cleanupResources(ctx.run, ctx.hostEnv, id, commit, ctx.keepImage), secrets);
      } else {
        await recordStage(ctx.runsDir, result, 'cleanup', async () => ({ status: 'SKIPPED', detail: 'no build was attempted' }), secrets);
      }
    }
  }
  return result;
}

/** `--resume`: remove the labelled leftovers of the selected repositories before any stage runs. */
export async function reconcileLeftovers(run: RunProcess, hostEnv: NodeJS.ProcessEnv, ids: readonly string[]): Promise<Record<string, { containers: number; networks: number; volumes: number }>> {
  const env = childEnvironment(hostEnv);
  const found: Record<string, { containers: number; networks: number; volumes: number }> = {};
  for (const id of ids) found[id] = await removeLabelledResources(run, env, id);
  return found;
}
