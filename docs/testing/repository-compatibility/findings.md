# Repository compatibility findings

Every mismatch between an expected fact in [`benchmark.yaml`](benchmark.yaml)
and what the production analysis path produced is recorded here once, under
a stable `COMP-xxx` id, with the classification the audit assigned it. The
`findings` section of `benchmark.yaml` mirrors the id and type of every entry
below; a test keeps the two in step.

Types (defined in [`README.md`](README.md#finding-categories)):
`ANALYSIS_BUG`, `ANALYSIS_MISSING_SIGNAL`, `MVP_CAPABILITY_GAP`,
`CORRECTLY_UNSUPPORTED`, `REPO_INVALID`.

Status vocabulary: `open` (mismatch stands), `fixed` (analyser changed,
regression test added, affected repositories rerun), `accepted` (a documented
boundary or a gap deferred by decision — the mismatch stands by design).

Customer relevance: how often a plausible Deployz customer repository hits
the finding and what it costs them (a false rejection turns a customer away;
a missed configuration fact costs a failed first deploy; an over-provisioned
service costs money).

## Pilot summary (Phase 2, 15 repositories, Deployz 3e63003, analysis version 6)

Before any fix: 8 of 15 deployment-gate verdicts matched, 1 repository
matched on every fact, 5 false rejections (umami, kutt, miniflux, Flagsmith,
gatus — all `realistic`), 0 false acceptances, 2 configuration-detection
mismatches (Unleash: port undetected; documenso: a required secret
undetected), 0 failed analyses. Eleven repositories had
no port detected because the analyser never reads a Dockerfile `EXPOSE` or
`ENV PORT` line; that alone drives most `NEEDS_CONFIGURATION` verdicts.
`runs/summary.md` carries the per-repository table.

The false rejections share one root cause class: presence of a dependency
or file is treated as an architectural requirement (an optional Kafka
client, a SQLite driver next to a PostgreSQL driver, an example Compose
file, a distroless base image on `gcr.io`, build scripts that write to
disk). The analysis intent documented in `rejection.ts` is precision
("files/dependencies that can ONLY mean that infrastructure"); the pilot
shows where the implementation is broader than the intent.

## Findings

### COMP-001 — Dockerfile `EXPOSE` / `ENV PORT` and Compose `ports` are not port evidence

- Repositories: repo-002, 003, 004, 005, 007, 008, 010, 011, 012, 014, 015
- Type: ANALYSIS_BUG
- Expected: the documented container port (4242, 3000, 8080, 8000, 3333, 9000, 2283, …)
- Actual: `port: null` → manifest gate `port-missing` → NEEDS_CONFIGURATION
- Evidence: `detectPort` reads root `.env*` files, a root `docker-compose.yml`
  `${PORT:-n}` pattern, and `process.env.PORT || n` in JS source only. Every
  pilot Dockerfile documents the port (`EXPOSE 4242`, `ENV PORT=3000`,
  `EXPOSE ${PORT:-3333}` with `ENV PORT="8080"`), and Compose files publish
  it (`ports: - 3000:3000`); none of that is read.
- Customer relevance: high — 11 of 15 repositories, every non-Node app and
  most Node apps; the vendor is asked for a value the repository states.
- Recommended action: read `ENV PORT=`, `EXPOSE n`, `EXPOSE ${PORT:-n}` from
  the selected Dockerfile and `ports: "n:n"` from the production Compose
  service; keep the existing sources first.
- Status: open

### COMP-002 — Optional or configurable dependencies are treated as architectural requirements

- Repositories: repo-001 (kafkajs, optional by `KAFKA_URL`), repo-003
  (better-sqlite3 + mysql2 next to pg, selected by `DB_CLIENT`), repo-008 (a
  Go SQLite driver next to lib/pq, storage selected by config), repo-013
  (kafkajs, mongodb, mysql2 are monitor-target clients)
- Type: ANALYSIS_BUG
- Expected: `unsupported: []` (kutt, umami, gatus) — deployable on PostgreSQL
- Actual: NOT_COMPATIBLE with `kafka`, `sqlite`, `mysql`, `mongodb`
- Evidence: `checkSqlite`, `checkMysql`, `checkMongo`, `checkKafka` reject on
  a bare dependency token; `rejection.ts` documents the opposite intent
  ("deliberately narrow ... so a passing repository is never blocked by a
  README mention or a dev-only helper"). Umami reads `KAFKA_URL` only behind
  a presence guard; kutt lists six database clients and picks one by env.
- Customer relevance: high — three of nine realistic pilot repositories are
  false rejections for this reason alone; multi-database and optional
  integration dependencies are common in mature applications.
- Recommended action: a database driver rejects only when no PostgreSQL
  driver is also declared (a configurable engine is a configuration, not a
  rejection); a queue client rejects only with corroboration (a production
  Compose service, or an unguarded read of its connection variable).
  uptime-kuma stays rejected on its own SQLite default.
- Status: open

### COMP-003 — Local-filesystem writes in build scripts, tooling and tests count as persistent storage

- Repositories: repo-001 (`scripts/build-geo.js`, `scripts/update-tracker.js`),
  repo-003 (`docs/api/generate.js`), repo-005 (`api/app/handlers.py`),
  repo-013 (`extra/release/*.mjs`)
- Type: ANALYSIS_BUG
- Expected: no `local-filesystem` blocker
- Actual: `local-file-storage` blocking finding → NOT_COMPATIBLE
- Evidence: `detectLocalFilesystem` scans every source file; the writes it
  found are build-time generators (`scripts/`), documentation generators
  (`docs/`), release tooling (`extra/`) and test files — none run in the
  deployed container's request path.
- Customer relevance: high — a build script that writes a file is ordinary;
  the rejection copy ("writes files to its own disk") is untrue for the app.
- Recommended action: ignore writes under `scripts/`, `script/`, `tools/`,
  `bin/`, `docs/`, `extra/`, `test*/`, `__tests__/`, `e2e/`, and
  `*.test.*`/`*.spec.*` files. Runtime writes (uploads, data dirs) still block.
- Status: open

### COMP-004 — A file named `health*`/`heartbeat*` outside a file-router directory becomes a URL path

- Repositories: repo-013 (`server/model/heartbeat.js` → `/server/model/heartbeat`),
  repo-014 (`packages/backend/src/controllers/healthcheck.js` → `/packages/backend/controllers/healthcheck`)
- Type: ANALYSIS_BUG
- Expected: `/healthcheck` (automatisch); none (uptime-kuma)
- Actual: the file path minus `src` as the health path, written to `healthPath`
- Evidence: `HEALTH_ROUTE_FILE_REGEX` matches any `healthcheck.js`;
  `deriveHealthPathFromFile` only strips `routes`/`pages`/`app`/`src`, so a
  model or controller file produces a path the app never serves — and the
  deployment would health-check that path.
- Customer relevance: medium — one wrong `healthPath` fails every deploy of
  that app until the vendor corrects it.
- Recommended action: derive a file-based path only when the file sits under
  a router root (`routes`, `pages`, `app`) or an `api` segment.
- Status: open

### COMP-005 — Health paths are only found in JS route registrations and file-router conventions

- Repositories: repo-002 (`this.use('/health', …)` mount), repo-003 (a health
  router mounted at `/health` with a `/` route), repo-004 (Go
  `HandleFunc("GET /healthcheck")`), repo-005 (Django, HEALTHCHECK is a TCP
  check → defaults to `/health`), repo-007 (NestJS `@Controller('health')`
  under `/api/v1`), repo-008 (Go fiber `app.Get("/health")`), repo-010 (Go
  echo `g.GET("/health")`), repo-015 (HEALTHCHECK runs a script that curls
  `/api/server/ping` → defaults to `/health`)
- Type: ANALYSIS_MISSING_SIGNAL
- Expected: the route path the app serves
- Actual: `healthPath: null`, or `/health` from a Dockerfile HEALTHCHECK that
  targets another path
- Evidence: `detectHealthEndpoint` scans `.ts/.js` files for `.get('/health')`
  shapes and file names; Dockerfile `HEALTHCHECK`/Compose `healthcheck` URLs
  are used only as a boolean, and the path then defaults to `/health`.
- Customer relevance: high — the health path is the deployment's promotion
  gate; a wrong default (`/health` for immich, Flagsmith) fails every deploy.
- Recommended action: parse the URL path from `HEALTHCHECK` and Compose
  `healthcheck` commands; treat a router mounted at a health prefix as a
  registration; read Go/Python literal route strings and NestJS
  `@Controller('health')`; never default to `/health` when the HEALTHCHECK
  names a different path or no path.
- Status: open

### COMP-006 — The manifest migration command falls back to a detector label

- Repositories: repo-001 (`update-db: prisma migrate deploy` → manifest
  `migration.command = "prisma migrate"`)
- Type: ANALYSIS_BUG
- Expected: `prisma migrate deploy` (a runnable command)
- Actual: the pattern name `prisma migrate` — `migration: true` matched by
  accident; the relay would run the label
- Evidence: `resolveMigrationCommand` (apps/api) resolves by script KEY
  (`/migrat/`), so `update-db` is skipped and the column stays null;
  `normalizeDeploymentManifest` then falls back to
  `metadata.migrationCommands[0]`, which holds `detectMigrationCommand`'s
  pattern names, not commands.
- Customer relevance: high — the migration stage runs unattended against the
  production database; a label is a guaranteed failed deploy.
- Recommended action: resolve by script VALUE when it is deploy-shaped
  (`prisma migrate deploy`, `knex migrate:latest`, …) regardless of key, and
  never fall back to a label in the manifest.
- Status: open

### COMP-007 — Dockerfile ranking prefers dev, packaging and sibling-service images

- Repositories: repo-004 (`packaging/debian/Dockerfile` chosen over
  `packaging/docker/alpine/Dockerfile`), repo-014 (`.devcontainer/Dockerfile`
  over `docker/Dockerfile`), repo-015 (`machine-learning/Dockerfile` over
  `server/Dockerfile`, and `gpu` rejected from the ML image)
- Type: ANALYSIS_BUG
- Expected: the Dockerfile that builds the web service
- Actual: the shallowest, lexicographically first Dockerfile; rejection
  checks (`checkGpu`, `checkGcp`) and the startup-command detector read
  every Dockerfile in the tree, not the selected one
- Evidence: `compareDockerfileCandidates` ranks by depth, exact name, then
  name order; `.devcontainer` sorts before `docker`, `debian` before `docker`.
- Customer relevance: high — the wrong Dockerfile is a failed build (or a
  built dev image) on the first deploy.
- Recommended action: rank candidates under dev/test/example/packaging
  segments (`.devcontainer`, `dev`, `test`, `e2e`, `examples`, `debian`,
  `rpm`, …) last; evaluate Dockerfile-scoped rejections on the selected
  Dockerfile. immich (two real services) remains ambiguous by nature.
- Status: open

### COMP-008 — A `gcr.io/distroless` base image counts as a Google Cloud deployment

- Repositories: repo-004
- Type: ANALYSIS_BUG
- Expected: `unsupported: []`
- Actual: NOT_COMPATIBLE `gcp` — "a Google Cloud deployment file is present (packaging/docker/distroless/Dockerfile)"
- Evidence: `checkGcp` treats any `FROM …gcr.io/` as a GCP target; Google's
  distroless images are hosted there and are a common production base.
- Customer relevance: medium — distroless bases are widespread in Go and
  Java images; each one is a false rejection.
- Recommended action: exclude `gcr.io/distroless/` (and `*.gcr.io/distroless`).
- Status: open

### COMP-009 — Compose service counting includes example directories, one-shot services and optional profiles

- Repositories: repo-005 (`migrate-db` one-shot + optional
  `flagsmith-task-processor`), repo-008 (`.examples/docker-compose-grafana-prometheus/compose.yaml`)
- Type: ANALYSIS_BUG
- Expected: `unsupported: []`
- Actual: NOT_COMPATIBLE `docker-compose-multi-service`
- Evidence: `NON_PRODUCTION_COMPOSE_SEGMENT_REGEX` excludes `examples` but
  not `.examples`; `composeServices` counts a service other services wait on
  with `condition: service_completed_successfully` (a migration job) as an
  application container.
- Customer relevance: medium — example directories and init-job services are
  common in mature repositories.
- Recommended action: treat dot-prefixed example/dev directories as
  non-production; exclude services depended on with
  `service_completed_successfully`.
- Status: open

### COMP-010 — A declared worker service rejects an app that can run its jobs in-process

- Repositories: repo-005 (`flagsmith-task-processor` in the reference Compose;
  `TASK_RUN_METHOD` defaults to an in-process thread)
- Type: CORRECTLY_UNSUPPORTED
- Expected: NEEDS_CONFIGURATION (in-process mode works without configuration)
- Actual: NOT_COMPATIBLE `docker-compose-multi-service` (after COMP-009)
- Evidence: `docs/architecture.md` — a repository that declares a worker
  process is needs-adaptation by decision (Phase 8, Option B). The analyser
  cannot tell an optional processor profile from a mandatory one.
- Customer relevance: medium — conservative by design; the vendor is told
  why, and an app that truly needs the processor would otherwise fail
  silently.
- Recommended action: none now; revisit if the final report ranks
  "optional worker profiles" as a gap worth a heuristic.
- Status: accepted

### COMP-011 — Redis is required from non-production Compose files and optional clients

- Repositories: repo-001 (`REDIS_URL` optional), repo-003
  (`docker-compose.mariadb.yml`/`postgres.yml`/`sqlite-redis.yml` variants;
  `REDIS_ENABLED` defaults to false), repo-006
  (`docker/development/compose.yml`; BullMQ is a non-default jobs provider),
  repo-013 (`test/manual-test-radius/compose.yaml`; the redis client is a
  monitor target)
- Type: ANALYSIS_BUG
- Expected: `redis: false`
- Actual: `redis.required: true` (confidence high) → a cache is provisioned
- Evidence: `collectComposeSignals` scans every compose-shaped file at any
  depth, including `test/` and `development/`, as a very-high signal;
  `bull`/`bullmq` as a direct dependency is a high signal on its own.
- Customer relevance: medium — an unused ElastiCache node per deployment is
  a recurring cost; ghostfolio (Redis truly required) is detected correctly.
- Recommended action: scope Compose signals to production Compose files
  (the same rule the rejection checks use); a guarded optional client
  (`if (env.REDIS_ENABLED)`, a non-default jobs provider) remains a known
  residual until a guard-aware rule is designed.
- Status: open

### COMP-012 — Any AWS SDK dependency counts as object-storage usage

- Repositories: repo-008 (`aws-sdk-go` for SES alerts), repo-005 (boto3 for an
  optional export feature), repo-006 (`@aws-sdk/client-s3` for an optional
  upload transport)
- Type: ANALYSIS_BUG
- Expected: `storage: false`
- Actual: `storage.required: true` → a bucket is provisioned
- Evidence: `detectS3` accepts the generic `aws-sdk` and
  `github.com/aws/aws-sdk-go` tokens, and `boto3` in any manifest, as S3
  usage.
- Customer relevance: low — a bucket is cheap; but the manifest tells the
  vendor their app "uses object storage" when it does not.
- Recommended action: require S3-specific evidence (an S3 client package or
  import, `boto3.client('s3')`, `s3.New`, an S3 env var). Optional S3
  transports (documenso) remain over-provisioned; documented.
- Status: open

### COMP-013 — PostgreSQL "required" evidence misses nested Compose files and non-JS configuration

- Repositories: repo-003 (`docker-compose.postgres.yml`, discrete `DB_*`
  vars), repo-004 (Go, `DATABASE_URL` read in `internal/config`), repo-011
  (`docker/docker-compose.yml` postgres:16, Django `DB=postgres`), repo-015
  (`docker/docker-compose.yml` pgvector image)
- Type: ANALYSIS_MISSING_SIGNAL
- Expected: `postgres: true` (a managed database is provisioned)
- Actual: `postgres.required: false` — driver present, no corroboration
- Evidence: `assessPostgres` accepts only root `.env*`, a root
  `docker-compose.yml`, and `process.env.DATABASE_URL` in JS as independent
  evidence; Go/Python reads and nested or variant Compose files are ignored.
- Customer relevance: high — `databaseRequired` stays false, so the app is
  deployed without a database and fails at boot.
- Recommended action: accept a PostgreSQL image in any production Compose
  file at any depth and a `DATABASE_URL`/`POSTGRES_*` literal in Go, Python
  and Ruby source as independent evidence.
- Status: open

### COMP-014 — Migration commands outside package.json scripts are not detected

- Repositories: repo-004 (`miniflux -migrate` / `RUN_MIGRATIONS`), repo-005
  (`python manage.py migrate`, Procfile `release:`), repo-010 (`listmonk
  --upgrade --yes`), repo-011 (`manage.py migrate` in `docker/uwsgi.ini`)
- Type: ANALYSIS_MISSING_SIGNAL
- Expected: `migration: true`
- Actual: `migration.command: null` (a `migration-command-missing` warning)
- Evidence: `detectMigrationCommand` and `resolveMigrationCommand` read
  package.json scripts only.
- Customer relevance: medium — the deployment proceeds without a migration
  stage; for Django and Alembic apps a safe command is inferable.
- Recommended action: Phase 3 candidate — infer `python manage.py migrate
  --noinput` (manage.py + Django dependency), `alembic upgrade head`
  (alembic.ini), `prisma migrate deploy` (a PostgreSQL Prisma schema) and read
  Procfile `release:` lines; Go binary flags stay vendor-supplied.
- Status: open

### COMP-015 — Worker-code detection is Node-only

- Repositories: repo-005 (Flagsmith task processor), repo-011 (Django
  `sendalerts`/`sendreports` daemons)
- Type: ANALYSIS_MISSING_SIGNAL
- Expected: `worker: true`
- Actual: `hasWorkerProcesses: false`
- Evidence: `detectWorker` knows `bull`, `bullmq`, `agenda` and
  `worker_threads`; Celery/RQ/Dramatiq, Sidekiq/Resque/GoodJob, Asynq and
  Procfile `worker:` lines are invisible. `redis.ts` already recognises
  celery/rq/sidekiq purposes.
- Customer relevance: high for Python and Ruby customers — a Celery app with
  a mandatory worker is accepted and then never processes jobs.
- Recommended action: Phase 3 candidate — reuse the redis module's job-library
  signals for `detectWorker`, and read Procfile `worker:` lines for the
  resolved worker command.
- Status: open

### COMP-016 — Platform and tooling variables are marked required

- Repositories: repo-001 (`CI`, `NODE_ENV`, `VERCEL`,
  `PLAYWRIGHT_SKIP_WEB_SERVER`, `ENABLE_TEST_CONSOLE`, … from
  `playwright.config.ts` and `scripts/`)
- Type: ANALYSIS_BUG
- Expected: READY (nothing to configure beyond injected values)
- Actual: `required-env-vars-missing` → NEEDS_CONFIGURATION
- Evidence: `detectEnvVarModel` treats a bare read in any JS file as a
  required value; test-runner and build-script reads and platform-provided
  names (`NODE_ENV`, `CI`, `PORT`, `HOSTNAME`, `VERCEL`, `HOME`, `PATH`) are
  not excluded.
- Customer relevance: high — the vendor is asked to configure `CI` and
  `NODE_ENV` before deploying.
- Recommended action: exclude platform-provided names and reads in test,
  config-tooling and script files from the required set.
- Status: open

### COMP-017 — Environment reads through helper functions and schema libraries are invisible

- Repositories: repo-006 (`env('NEXTAUTH_SECRET')` throws when unset), repo-007
  (envalid `ACCESS_TOKEN_SALT: str()`), repo-003 (envalid `JWT_SECRET` with a
  dev-only default), repo-012 (zod `CORE_SECRET`), repo-014
  (`process.env.ENCRYPTION_KEY || ''` then an explicit throw)
- Type: ANALYSIS_MISSING_SIGNAL
- Expected: NEEDS_CONFIGURATION (a secret must be supplied)
- Actual: READY once port detection is fixed (documenso today)
- Evidence: the env model only sees `process.env.X`, Prisma `env()`,
  `os.environ` and `ENV.fetch`; wrapper helpers, envalid/zod schemas and
  "empty-string default then throw" are the common patterns in modern apps.
- Customer relevance: high — a false READY is a boot failure on the first
  deploy for the most common secret-handling styles.
- Recommended action: Phase 3 candidate — recognise envalid/zod-style
  schema keys without defaults and `env('X')`-style helpers when the helper
  wraps `process.env`.
- Status: open

### COMP-018 — The 200-file cap is filled by test, spec and tooling files

- Repositories: repo-002 (190 source slots went to `frontend/cypress/**`
  specs and root config files; no `src/lib/routes/*` file was fetched, so
  neither `/health` nor the port default was visible), repo-007, repo-013
- Type: ANALYSIS_BUG
- Expected: application source visible to the detectors
- Actual: port and health path undetected on large repositories
- Evidence: `relevancePriority` (apps/api/src/github.ts) ranks all source
  files equally (tier 4) in GitHub tree order; root-level tooling configs sit
  in tier 1 ahead of every application file.
- Customer relevance: high — any repository over ~200 relevant files is
  analysed on an arbitrary subset; test-heavy repositories lose their
  application code first.
- Recommended action: rank test/spec/fixture/e2e/cypress files and tooling
  configs last; prefer shallower application source (`src`, `server`, `app`,
  `api`, `lib`) first.
- Status: open

### COMP-019 — A conditional Redis Cluster client rejects the whole app

- Repositories: repo-005 (`api/core/redis_cluster.py` builds `RedisCluster(…)`
  only for an opt-in cluster cache backend; the default is `LocMemCache`)
- Type: ANALYSIS_BUG
- Expected: `unsupported: []`
- Actual: NOT_COMPATIBLE `redis-unsupported` — "Requires Redis Cluster mode"
- Evidence: `CLUSTER_PATTERNS` in `redis.ts` match `RedisCluster(` anywhere
  in source; the standalone client is also present and is the default.
- Customer relevance: medium — cluster support next to standalone support is
  a feature, not a requirement.
- Recommended action: treat cluster usage as unsupported only when no
  standalone client construction exists in the repository.
- Status: open

### COMP-020 — `application.root` is the Dockerfile's directory even for tooling folders

- Repositories: repo-006 (`docker`), repo-011 (`docker`), repo-013 (`docker`),
  repo-004 (`packaging/debian`)
- Type: ANALYSIS_BUG
- Expected: `.` (or `apps/remix` for documenso)
- Actual: the directory of the selected Dockerfile
- Evidence: `appRootFromDockerfile` in `manifest.ts`; nothing at deploy time
  consumes `application.root` today (the build already special-cases
  `docker/`), so the impact is the vendor-facing manifest only.
- Customer relevance: low.
- Recommended action: a directory named `docker`, `dockerfiles`,
  `.devcontainer` or `packaging/*` is tooling, not an app root → `.`.
- Status: open
