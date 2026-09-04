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

### After the detector-signal fixes (analysis version 7)

COMP-001, 003, 004, 006, 007, 012, 013, 016, 018 and 020 are fixed with
regression tests (`packages/analysis/test/stage-a.test.ts`, apps/api
`github.test.ts` / `analysis.test.ts`); COMP-005 is partly addressed. Rerun
on the same 15 snapshots: 7 of 15 verdicts match, 4 repositories match on
every fact (was 1), the port is detected on all 15 (11 mismatches → 0),
health-path mismatches fell from 9 to 4, and no mismatch is unexplained.
The verdict count moved from 8 to 7 for an honest reason: two earlier
matches were coincidences (listmonk and healthchecks were
`NEEDS_CONFIGURATION` only because their port was undetected; the true
causes are now visible as COMP-021 and COMP-022), and documenso now matches
`NEEDS_CONFIGURATION` for a weak reason (a replica-URL variable, COMP-023
class) rather than its real secret (COMP-017). The five false rejections
are untouched by design — they belong to the rejection-precision batch
(COMP-002, 008, 009, 011, 019).

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
- Fix: `detectPort` reads the selected Dockerfile (`ENV PORT`, `EXPOSE`, `EXPOSE ${PORT:-n}`) and production Compose port mappings (analysis version 7). Regression: `packages/analysis/test/stage-a.test.ts` COMP-001. All eleven repositories now report their port.
- Status: fixed

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
- Fix: `isRuntimeSourcePath` excludes tests, fixtures, scripts, tooling and docs from the local-filesystem scan (and from the env-var reads, COMP-016). Regression: stage-a.test.ts COMP-003. Residual: Flagsmith `api/app/handlers.py` (a runtime `os.makedirs`) still flags — a Phase 3 candidate for a "non-storage write" rule.
- Status: fixed

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
- Fix: A file-based health path is derived only under a router root (`routes`, `pages`, `app`) or an `api` segment. Regression: stage-a.test.ts COMP-004 / COMP-005.
- Status: fixed

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
- Fix: Partly addressed in version 7: a router mounted at a health prefix, the URL in a Dockerfile `HEALTHCHECK` / Compose `healthcheck`, and Go/Python/Ruby route literals are read (Go sources are now fetched). Remaining: NestJS controllers under a versioned global prefix (ghostfolio), Django health-check apps that register routes outside the repository (Flagsmith), a mount chain through a member expression (kutt `app.use("/api", routes.api)`), and a HEALTHCHECK that runs a script (immich).
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
- Fix: `resolveMigrationCommand` accepts a deploy-shaped script value under any key, and the manifest no longer falls back to the detector label (`fix-instructions` likewise). Regression: apps/api analysis.test.ts "resolves a deploy-shaped migration script whose key does not mention migrations", stage-a.test.ts COMP-006.
- Status: fixed

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
- Fix: Dev-container, test, example and OS-package Dockerfiles rank last; the startup command and HEALTHCHECK are read from the selected Dockerfile only. Regression: stage-a.test.ts COMP-007. Residual: immich (`machine-learning/Dockerfile` vs `server/Dockerfile` — two genuine services, and the GPU check still scans every Dockerfile).
- Status: fixed

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

### COMP-010 — An optional worker service in a reference Compose file is indistinguishable from a mandatory one

- Repositories: repo-005 (`flagsmith-task-processor` in the reference Compose,
  same image, `command: run-task-processor`; `TASK_RUN_METHOD` defaults to an
  in-process thread, so the service is an optional profile)
- Type: ANALYSIS_MISSING_SIGNAL
- Expected: NEEDS_CONFIGURATION (in-process mode works without configuration)
- Actual: NOT_COMPATIBLE `docker-compose-multi-service` — two application
  services remain once COMP-009 removes the one-shot `migrate-db`
- Evidence: `checkDockerComposeMultiService` counts the processor as a second
  application container; nothing in the file marks it optional (no
  `profiles:` key), and the worker gate in `readiness-report.ts` is not the
  path that fires (no worker script resolves). The conservative outcome is
  consistent with `docs/architecture.md` (a declared worker process is
  needs-adaptation), but the analyser has no signal to tell an optional
  profile from a mandatory process.
- Customer relevance: medium — apps that ship an optional processor service
  next to an in-process default are rejected; the vendor is told why.
- Recommended action: none now — a heuristic (a Compose `profiles:` key, or a
  second service that reuses the web image with a worker-style command) is
  a Phase 3 candidate only if the pattern recurs.
- Status: open

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
- Fix: Only S3-specific packages or an S3 client construction count. Regression: stage-a.test.ts COMP-012. Residual: an optional S3 transport that is a real S3 client (documenso `@aws-sdk/client-s3`, Flagsmith `boto3.client("s3")` for exports) still provisions a bucket — over-provisioning, not blocking.
- Status: fixed

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
- Fix: A PostgreSQL image in any production Compose file (nested or a root variant) and a `DATABASE_URL`/`POSTGRES_*` literal in Go, Python or Ruby source are independent evidence; Go sources are now fetched. Regression: stage-a.test.ts COMP-013.
- Status: fixed

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
  `playwright.config.ts` and `scripts/`), repo-002 (`UNLEASH_OPENAPI_URL`,
  read by the OpenAPI client-generation script), repo-008 (`BASE_URL`, read
  by the Vue frontend's build tooling under `web/app/`, which the Go
  Dockerfile never runs)
- Type: ANALYSIS_BUG
- Expected: READY (nothing to configure beyond injected values)
- Actual: `required-env-vars-missing` → NEEDS_CONFIGURATION
- Evidence: `detectEnvVarModel` treats a bare read in any JS file as a
  required value; test-runner, build-script and frontend-tooling reads and
  platform-provided names (`NODE_ENV`, `CI`, `PORT`, `HOSTNAME`, `VERCEL`,
  `HOME`, `PATH`) are not excluded.
- Customer relevance: high — the vendor is asked to configure `CI` and
  `NODE_ENV` before deploying.
- Recommended action: exclude platform-provided names and reads in test,
  config-tooling and script files from the required set; a read inside a
  frontend tree the selected Dockerfile never builds is a residual to
  measure in Phase 3.
- Fix: Platform-provided names (`NODE_ENV`, `PORT`, `CI`, `VERCEL`, …) are never required, reads in non-runtime files are ignored, and the deployment gate counts every injected database variable (`DATABASE_URL`, `DATABASE_HOST/PORT/NAME/USER/PASSWORD`) as provided. Regression: stage-a.test.ts COMP-016. See COMP-023 for the remaining over-claim on Unleash.
- Status: fixed

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
- Fix: `relevancePriority` ranks tests, specs, fixtures and tool configs last and shallower application source first. Regression: apps/api github.test.ts "ranks specs, fixtures and tool configs last".
- Status: fixed

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
- Fix: A Dockerfile under `docker/`, `dockerfiles/`, `.devcontainer/`, `packaging/`, `deploy/`, `build/`, `ci/` or `infra/` maps to root `.`. Regression: stage-a.test.ts COMP-020. Residual: documenso (`apps/remix`, a monorepo target the Dockerfile builds from the root).
- Status: fixed

### COMP-021 — A Dockerfile that copies an artifact the repository does not contain is accepted

- Repositories: repo-010 (`COPY listmonk .` — the binary comes from `make dist`/goreleaser)
- Type: ANALYSIS_MISSING_SIGNAL
- Expected: NEEDS_CONFIGURATION (a working Dockerfile must be supplied)
- Actual: READY — the Dockerfile, port, start command and health check all look complete
- Evidence: nothing in the analysis reads the `COPY` sources of a Dockerfile against
  the tree; a plain `docker build` of the snapshot fails on the first `COPY`.
  Related: listmonk's `config.toml.sample` binds `localhost:9000`, which the
  reference Compose overrides with an env var — invisible for the same reason.
- Customer relevance: medium — release-packaging Dockerfiles are common in Go
  projects; the failure only shows at the first build.
- Recommended action: Phase 3 candidate — flag a Dockerfile whose `COPY`/`ADD`
  source path is absent from the tree and produced by no `RUN` step in the
  same Dockerfile.
- Status: open

### COMP-022 — A database engine selected by an environment value is READY without the value

- Repositories: repo-011 (Django `DB=postgres`), repo-003 (`DB_CLIENT=pg` — once COMP-002 is fixed)
- Type: ANALYSIS_MISSING_SIGNAL
- Expected: NEEDS_CONFIGURATION (the engine selector must be set for the provisioned PostgreSQL to be used)
- Actual: READY (healthchecks after COMP-001) — the default engine is SQLite and nothing marks the selector required
- Evidence: `hc/settings.py` reads `os.getenv("DB")` with a SQLite fallback; the
  env model treats a defaulted read as optional (correctly), so the deployment
  gate has nothing to ask for.
- Customer relevance: medium — the app deploys and boots on SQLite inside the
  container, losing data on every deploy, instead of using the provisioned database.
- Recommended action: Phase 3 candidate — when a PostgreSQL driver and a SQLite
  driver/default coexist, surface the engine selector as a required
  configuration value (the read that decides between them) rather than a
  rejection (COMP-002) or silence.
- Status: open

### COMP-023 — Bare reads assigned to configuration properties are counted as required

- Repositories: repo-002 (27 optional settings in `src/lib/create-config.ts`:
  `host: process.env.HTTP_HOST`, `edgeUrl: process.env.EDGE_URL`,
  `const openAIAPIKey = process.env.OPENAI_API_KEY`, …)
- Type: ANALYSIS_BUG
- Expected: READY
- Actual: `required-env-vars-missing` → NEEDS_CONFIGURATION
- Evidence: the §11.2 model counts any read with no inline fallback and no
  guard as "needs a value"; a read whose result is stored in a config object
  or a variable proves nothing about need — the consumer decides later.
  Version 7 already exempts the alternative of a `??`/`||` chain and a
  defaulting helper argument (`parseEnvVarNumber(process.env.X, 4242)`).
- Customer relevance: high — large configuration surfaces (Unleash, Ghostfolio-
  style apps) are the norm in mature products; each one becomes a wall of
  "required" values the vendor must clear before the first deploy.
- Recommended action: Phase 3 — measure how often the pattern flips a verdict
  across the 80-repository corpus, then decide between "bare assignment is
  optional" (recall loss on `const secret = process.env.X; if (!secret) throw`)
  and a throw-guard-aware rule.
- Status: open
