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

### After the rejection-precision fixes (analysis version 8)

COMP-002, 008, 009, 011, 019 and 023 are fixed with regression tests. Rerun
on the same 15 snapshots: false rejections 5 → 1 (Flagsmith, the optional
worker profile of COMP-010), false acceptances 0, kutt and gatus no longer
provision Redis or reject on their configurable engines, and every
remaining mismatch is a configuration-detection or fact mismatch: the env
model over-claiming (COMP-023 residuals on umami and Unleash), invisible
secret schemas (COMP-017 on ghostfolio and documenso), a frontend-tooling
read (COMP-016 on gatus), and the missing migration, artifact and engine
signals (COMP-014, 021, 022). Verdict matches move from 7 to 8 of 15 (4
repositories match on every fact): most fixed rejections became
configuration mismatches rather than matches — the rejection layer is now
precise on the pilot; configuration detection is the next frontier and the
80-repository corpus will measure it.

## Main-corpus summary (Phase 3, 80 repositories, analysis version 8 → 9)

The 65 phase-3 repositories (repo-016..080: 49 `realistic`, 17 `messy`,
14 `boundary` with the pilot) were each inspected twice by independent
sub-agents; the second inspection agreed with every compared fact on all
65 entries. One planned repository was replaced before inspection
(redmine → docuseal, the same Rails shape).

Before the phase-3 fixes (analysis version 8 on all 80 snapshots): 36 of
80 verdicts matched, 5 repositories matched on every fact, 24 false
rejections, 8 false acceptances, 12 configuration-detection mismatches,
277 mismatches with no finding. The false rejections had two dominant
causes: any write call in runtime source was persistent local storage
(COMP-024, 20 repositories), and any non-infrastructure image in the
production Compose file was a second application service (COMP-026, 12
repositories). Behind them sat database clients treated as requirements
(COMP-032), wrongly selected Dockerfiles (COMP-027) and unresolved
`EXPOSE` variables (COMP-028).

After the fixes (analysis version 9, COMP-024, 026, 027, 028, 029, 032,
034, 035 with regression tests in
`packages/analysis/test/stage-a-phase3.test.ts`): 39 of 80 verdicts
match (25 of 49 realistic, 5 of 17 messy, 9 of 14 boundary), 4 match on
every fact, false rejections 24 → 8, false acceptances 8 → 10,
configuration-detection mismatches 12 → 23, and every one of the 255
remaining mismatches carries a finding (86 ANALYSIS_BUG residuals, 169
ANALYSIS_MISSING_SIGNAL). The false-acceptance count rose by two because
the old write-call rule had rejected several apps for the wrong reason
(changedetection.io, zulip, grist-core, vaultwarden): their real blockers
— an undeclared data directory, a message broker read with a default, an
embedded document store, a stub Dockerfile — are now visible as COMP-025,
COMP-002, COMP-031 and COMP-033 misses instead of accidental rejections.

Where the remaining mismatches sit:

- 8 false rejections: optional second processes declared in reference
  files (COMP-010 ×4), a durable content volume with no object-storage
  alternative (COMP-024 ×2: wiki.js, wallabag), a root-level development
  Compose file (COMP-026 ×1: ToolJet), Flagsmith (COMP-009 residual).
- 10 false acceptances: durable data directories with no `VOLUME` or
  Compose mount (COMP-025 ×4), deployment descriptors the tree fetch drops
  (COMP-033 ×3: Kubernetes-native argo-cd, the 11-service
  microservices-demo, Azure Bicep), a queue worker outside Node (COMP-015
  ×2: monica, zulip), an embedded document store next to PostgreSQL
  (COMP-002: grist-core), a required third-party service (COMP-031: postiz
  needs Temporal).
- 23 configuration-detection mismatches: 16 are required values named in
  code the env model does not read (COMP-017, all non-Node or
  schema-library apps), 4 are the pilot residuals (COMP-014, 016, 021,
  022), 3 are secret-named bare reads (COMP-023).
- The fact mismatches are dominated by four open signals: migration
  commands outside package.json (COMP-014, 41), health paths outside JS
  conventions (COMP-005, 36), non-Node worker code (COMP-015, 29), and
  Redis provisioning from optional clients (COMP-011, 25).

## Unseen-set results (Phase 4, 20 repositories, analysis version 9 frozen at 2266c14)

Twenty repositories nobody had inspected during the fixes (repo-081..100:
10 `realistic`, 5 `messy`, 5 `boundary`; `set: unseen`) were pinned,
inspected twice by independent sub-agents (one correction: nango's
Compose file runs one application container, so only `background-worker`
applies), and analysed once with the analyser frozen at the phase-3 merge.
One planned repository (ajnart/homarr) is archived and was replaced by its
maintained successor homarr-labs/homarr. No analyser change was made until
all twenty were reported.

Frozen result: 10 of 20 verdicts match (improvement set: 39 of 80), 1
repository matches on every fact (sosedoff/pgweb), 4 false rejections, 5
false acceptances, 1 configuration-detection mismatch, 0 failed analyses,
and every mismatch carries a finding. The verdict rate on unseen
repositories (50%) is the same as on the repositories the fixes were
tuned on (49%), so the phase-3 rules generalise rather than overfit; the
open signals dominate the fact mismatches in the same order (migration 14,
health path 13, worker 12, storage 8).

- False rejections (4): mattermost — a development stack under
  `server/docker-compose.yaml` counted as 17 application services
  (COMP-026 residual) and the production `server/build/Dockerfile` never
  reached the analyser because hundreds of workspace `package.json` files
  fill the 200-file cap ahead of it (COMP-038, new); windmill — the
  reference Compose file declares worker containers the standalone image
  also runs in-process (COMP-010), a Pulumi package under `benchmarks/`
  (COMP-036, new) and a cache volume (COMP-024); TandoorRecipes — a media
  `VOLUME` whose S3 alternative is django-storages, invisible to the S3
  detector (COMP-024 via COMP-012); homarr — `VOLUME /appdata` backs the
  SQLite default but the PostgreSQL driver's own `DB_URL` naming keeps
  `postgres.required` false, so the database-volume exemption does not
  apply (COMP-024 via COMP-029).
- False acceptances (5): nango and netbox declare their worker process in
  a workspace package or documentation, not the root manifest (COMP-015);
  Stirling-PDF (H2) and plausible (ClickHouse) declare their unsupported
  engine in a JVM or Elixir manifest (COMP-037, new); thelounge keeps all
  state under `$THELOUNGE_HOME` with no Dockerfile at all (COMP-025).
- Configuration detection (1): dashy — `API_TOKEN` is a bare secret-named
  read for an optional API (COMP-023).
- Matches (10): hedgedoc, teable, wger, pgweb, nextcloud, openstatus,
  mastodon, wekan, BookStack and penpot — six of them NOT_COMPATIBLE for the
  expected reason, though BookStack rejects on a Compose family where the
  entry expected `mysql` (COMP-037: a MySQL-only Laravel app has no Node
  driver to detect).

The three new findings are recorded below and left open for the Phase 6
hardening batch.

## Post-hardening summary (Phase 6, analysis version 10)

The hardening batch fixed the three defects the unseen set revealed
(COMP-036, 037, 038) and the worker-detection gap the decision report
ranked FIX_BEFORE_MVP (COMP-015), each with regression tests
(`packages/analysis/test/stage-a-phase6.test.ts`, apps/api
`github.test.ts`). Nothing outside the analyser changed.

| | Before hardening (v9) | After hardening (v10) |
| --- | --- | --- |
| Verdict matches, whole corpus | 49 / 100 | 51 / 100 |
| Verdict matches, improvement set | 39 / 80 | 41 / 80 |
| Verdict matches, unseen set | 10 / 20 | 10 / 20 |
| False rejections | 12 (21.8% of 55 deployable) | 12 |
| False acceptances | 15 (33.3% of 45 rejected) | 14 (31.1%) |
| Realistic cohort verdicts | 29 / 59 | 30 / 59 |
| Repositories with a worker mismatch (COMP-015) | 41 | 34 |
| Mismatches without a finding | 0 | 0 |

New unseen accuracy: 10 of 20 verdicts, unchanged — the fixes corrected
facts on the unseen set (mattermost's Dockerfile and port, windmill's
Pulumi rejection, BookStack's engine family) without moving a verdict,
because each unseen false rejection or acceptance has a second, unfixed
cause (a development Compose stack, a licence-gated engine, a Compose file
in another repository, a worker declared in supervisor files). The
improvement set gained two verdicts (nango-style declared workers; firefly-
iii's MySQL default). No repository regressed; the corpus was rerun in
full after every change.

Remaining known gaps, in the decision report's order: binding aliases for
injected variable names (product, FIX_BEFORE_MVP, not an analyser change);
boot-time migration recognition (COMP-014, 55 repositories); health paths
outside JS conventions (COMP-005, 49); required values in env schemas
(COMP-017, 16 verdict flips); Redis optional-vs-required (COMP-011, 26);
ports without `EXPOSE` (COMP-030, 13); undeclared data directories
(COMP-025, 5); deployment descriptors the fetch drops (COMP-033, 3);
optional second processes in reference files (COMP-010, 5); and the
product gaps G1–G3 (persistent disk, a second worker process,
multi-container stacks) that stay outside the MVP.

## Stage B comparison (analysis version 11)

The Stage B batch (analysis version 11, Deployz `1e6ad171`) landed the
deterministic fixes the decision report ranked: evidence/ambiguity
(phase 1), binding aliases (phase 2), schema/helper env reads (phase 3),
generated secrets (phase 4), health modes (phase 5), migration modes
(phase 6), port provenance (phase 7), the remaining Stage A findings
(phase 7b: COMP-010/021/022/025/031/033), the AI resolver and its two
consumers (phases 8–10) and the readiness UX (phase 11). The AI resolver
is unconfigured in this run, so every verdict below is deterministic.
The corpus was rerun in full; the run artifacts are `runs/` at
`1e6ad171` (version 11). The comparison baseline is the committed v10 run
(`runs/` at `5a443f6`), i.e. after the Stage A phase-6 hardening, not the
decision report's original analysis-version-9 baseline (49/100 verdict,
73% boundary, 15/45 false acceptances).

| | Before (v10) | After (v11) |
| --- | --- | --- |
| Verdict matches, whole corpus | 51 / 100 | 61 / 100 |
| Verdict matches, improvement set | 41 / 80 | 51 / 80 |
| Verdict matches, unseen set | 10 / 20 | 10 / 20 |
| False rejections | 12 (21.8% of 55 deployable) | 13 (23.6%) |
| False acceptances | 14 (31.1% of 45 rejected) | 6 (13.3%) |
| Boundary accuracy (whole corpus) | 74 / 100 | 81 / 100 |
| Repositories matching every fact | 5 | 5 |
| Configuration-detection mismatches | 23 | 20 |
| Mismatches without a finding | 0 | 8 |

By cohort (verdict matches): realistic 30/59 → 32/59 (false acceptances
5/21 → 3/21), messy 8/22 → 13/22 (false acceptances 3/5 → 0/5), boundary
13/19 → 16/19 (false acceptances 6/19 → 3/19). By set, all of the gain is
on the improvement set (41 → 51 of 80, 4 → 5 all-facts matches); the
unseen set stayed at 10/20 with its last all-facts match (pgweb) gone.
No repository failed to analyse in either run.

The two headline directions:

- **False acceptances almost halved (14 → 6)** — eight NOT_COMPATIBLE
  repositories that v10 let through now reject correctly: homepage, halo
  and thelounge on their durable local-filesystem data (COMP-025, landed
  in phase 7b), grist-core on its local file store, postiz on its required
  Temporal server (COMP-031), and argo-cd / microservices-demo /
  azure-search-openai-demo on their Kubernetes/Terraform/Azure families
  (COMP-033). The 6 remaining are the correct-reason residuals listed in
  the per-finding sections below.
- **False rejections rose 12 → 13, and 8 mismatches are unexplained** — the
  phase-5 health-name vocabulary widening (added `status`, `ping`, `up`,
  `alive`, `readyz`, `livez`) now reads feature routes that merely end in
  a health-ish word as the health endpoint, displacing the app's real
  `/health` or `/healthcheck` on five repositories that matched at v10
  (COMP-039, new); coder now rejects on its own dogfood Terraform and
  kafdrop on its own Helm chart now that deployment descriptors reach the
  checks (COMP-033 landed in 7b — COMP-040, new); pgweb is downgraded to
  NEEDS_CONFIGURATION because its only health check is a TCP probe, which
  the phase-5 vendor-required gate does not accept (COMP-041, new).

Per-finding movement for the ten open Stage A findings (repositories
carrying a mismatch under that finding id; verdict flips in parentheses):

| Finding | Before (v10) | After (v11) | Status |
| --- | --- | --- | --- |
| COMP-005 | 49 (0) | 45 (0) | open |
| COMP-010 | 5 (5) | 5 (5) | open |
| COMP-014 | 55 (0) | 55 (0) | open |
| COMP-017 | 15 (0) | 11 (1) | open |
| COMP-021 | 1 (0) | 1 (0) | accepted |
| COMP-022 | 1 (0) | 1 (0) | open |
| COMP-025 | 5 (4) | 2 (1) | open |
| COMP-030 | 13 (0) | 9 (0) | open |
| COMP-031 | 1 (1) | 1 (0) | fixed |
| COMP-033 | 3 (3) | 0 (0) | fixed |

The 8 unexplained mismatches are recorded below as three new findings:
COMP-039 (health-path over-match), COMP-040 (cloud-descriptor over-fire
now that descriptors are fetched), COMP-041 (vendor-required health gate
for TCP-probe-only apps). The per-finding sections that follow carry the
updated status of every Stage A finding.

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
- Fix: A SQLite or MySQL driver next to a PostgreSQL driver no longer rejects (the engine is a configuration choice); a Kafka/RabbitMQ client rejects only with a production Compose broker service or a required connection variable (`KAFKA_URL`, `KAFKA_BROKERS`, `AMQP_URL`, …) that the code never presence-tests. Regression: stage-a.test.ts COMP-002; phase7.test.ts kafka/rabbitmq. Residual: uptime-kuma is still rejected on its monitor-target `mongodb` client (and, correctly, on its local database file) rather than on SQLite, whose `@louislam/sqlite3` fork is not a recognised driver.
- Phase 3 residual (80 repositories): the configurable-engine rule now also hides an INTRINSIC embedded database — grist-core keeps every document in its own SQLite file next to its PostgreSQL metadata store (false acceptance), and CTFd (MySQL-only, `psycopg2` shipped for tests) and typebot (a second Prisma schema on MySQL) are rejected on the wrong family. An uncorroborated broker client still hides a real requirement: zulip reads `RABBITMQ_HOST` with a `localhost` default (false acceptance). uptime-kuma keeps its SQLite miss.
- Status: fixed

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
- Phase 3 residual: 36 health-path mismatches remain on the corpus — routes registered in Java/Kotlin/.NET/Elixir/Rust/PHP (Spring `/actuator/health`, Rails `/up`, Phoenix), non-standard names (`/api/ping`, `/status`, `/-/ping`, `/alive`, `/api/app/about`, `/_health`) that no health-segment regex matches, and the `/health` default when only a HEALTHCHECK without a URL exists.
- Stage B (phase 5): health modes (`explicit` / `root` / `vendor_required`) landed; Go/Python/Ruby/PHP/.NET/JVM/Elixir/Rails route literals, Spring Actuator, context paths and Phoenix scopes are now read, and `/health` is never silently defaulted. Residual on v11: 45 repositories still carry a healthPath fact mismatch (no verdict flips) — the corpus's remaining real health routes live in code shapes no literal regex reads, and the widened vocabulary introduced a NEW over-match class on `…/status`-suffixed feature routes, recorded separately as COMP-039 (5 previously-matching repositories regressed).
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
- Fix: `FROM gcr.io/distroless/…` is excluded from the GCP check. Regression: stage-a.test.ts COMP-008.
- Status: fixed

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
- Fix: Dot-prefixed example directories are non-production Compose files, and a service other services wait on with `service_completed_successfully` is not an application container. Regression: stage-a.test.ts COMP-009. Residual: an optional worker profile next to the web service still counts as a second application container — COMP-010.
- Status: fixed

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
- Phase 3 residual: calcom (`calcom-api`), huginn (`web` + `threaded` in the single-process Compose file, while the selected image runs both), nocodb (`worker`) and n8n (queue-mode `worker` command) are rejected for optional second processes the reference files declare — 4 of the 8 remaining false rejections.
- Stage B (phase 7b): an optional compose service is no longer a second application service when the image is the web image and the command is worker-style (`deploy.replicas: 0`, profiles) — regression-guarded in stage-b-final-batch.test.ts. Residual on v11: 5 repositories still false-rejected (calcom, huginn, n8n, nocodb, windmill), 5 verdict flips unchanged — each reference Compose declares the optional second process in a shape the phase-7b exemption does not match.
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
- Fix: Only the primary production Compose file is very-high evidence (a root variant is recorded without weight, a dev/test file ignored), and a client built behind a configuration guard (`if (env.REDIS_ENABLED) { new Redis(…) }`) is evidence without weight. Regression: stage-a.test.ts COMP-011; kutt and Unleash no longer provision Redis. Residual: a `bull`/`bullmq` direct dependency that backs a non-default jobs provider (documenso), a monitor-target client (uptime-kuma), and a settings-driven Django cache (Flagsmith) still read as required.
- Phase 3 residual: 25 `redis` fact mismatches — a Redis service in the production Compose file, or an unguarded client construction, marks Redis required for apps that only use it when configured (directus, ToolJet, cal.com, docuseal, n8n, nocodb, logto, wallabag, …). Provisioning only, never a verdict.
- Status: fixed

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
- Phase 3 residual: 17 `storage` mismatches in both directions — an S3 client shipped for an optional export or backup feature (coder, grafana, casdoor, logto, joplin, superset) reads as "object storage required", while S3 support through a PHP/Kotlin storage abstraction (monica, tolgee, CTFd via a quoted `"s3"` client) is not seen.
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
- Phase 3 residual: 41 `migration` mismatches — the corpus is dominated by apps that migrate at boot (Rails initializers, Go embedded migrations, Flyway/Liquibase, Django `manage.py migrate` in an entrypoint script) or through a non-npm CLI. The gate treats the missing command as a warning, so no verdict changes; the fact stays open for the Phase 5 decision.
- Stage B (phase 6): migration MODES landed — `pre_deploy` (a deploy-safe command), `startup` (the app migrates on boot; evidence recorded, no command invented), `none` and `unknown`. Boot-time migrators no longer get a "no migration command" warning; the gate's finding is informational. Residual on v11: 55 repositories still carry a `migration` fact mismatch (expected true, actual false) because the harness compares the boolean, not the mode; no verdict flips.
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
- Phase 3 residual: 29 `worker` mismatches (sidekiq, celery, good_job, Laravel queues, Go schedulers) and two false acceptances where the missed queue worker is also the declared second process (monica `queue:work`, zulip). superset, twenty and chatwoot reject on the Compose family instead of `background-worker` for the same reason.
- Fix (Phase 6): job-queue libraries in Ruby, Python, Go, JVM, .NET, Elixir, PHP and Rust manifests (sidekiq, celery, rq, asynq, quartz, Hangfire, oban, laravel/horizon, …), a queue-worker command in a Procfile, Dockerfile, Compose file or shell script (`bundle exec sidekiq`, `celery … worker`, `artisan queue:work`, `manage.py rqworker`), and a DECLARED worker process from a Procfile `worker:` line or a production Compose application service whose `command:` runs a queue worker (`chatwoot`'s sidekiq service) — the Phase 8 rejection now has the evidence it needs. In-process cron schedulers (node-cron, croner, robfig/cron, gocron, APScheduler) are deliberately not worker code, and a workspace package merely named `worker` declares nothing (linkwarden runs `apps/worker` inside its web container). Regression: stage-a-phase6.test.ts COMP-015. Worker mismatches fell from 41 to 34 repositories. Residual: nango (its jobs live in a workspace package the self-hosted image strips), netbox (documented systemd units, no Dockerfile), monica and zulip (queue workers started by supervisord/puppet files the fetch does not read) stay false acceptances.
- Status: fixed

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
- Phase 3 residual: 16 configuration-detection mismatches on the main corpus are this finding — Go (memos, coder, authelia, casdoor, kratos), JVM (keycloak, tolgee), .NET (OrchardCore), Python (ihatemoney) and schema-library Node apps (outline, docmost, directus, reactive-resume, logto, hoppscotch) name their required secrets in code the §11.2 model does not read, so they come out READY instead of NEEDS_CONFIGURATION.
- Stage B (phase 3): env-schema reads landed for zod/envalid/Pydantic/Spring `@Value`/Go envconfig/.NET Options, and schema-required secrets now reach the deployment gate; binding aliases (phase 2) carry the injected values under the app's own names. Residual on v11: 11 repositories still carry the label, 10 of them configuration-detection (outline, directus, reactive-resume, ihatemoney, memos, authelia, grafana, tolgee, hoppscotch, kratos read their required secrets in still-unread shapes; resolved since v10: docmost, OrchardCore, keycloak, casdoor). The 11th, coder (repo-041), carries the run's only COMP-017 verdict flip, but its cause is the Terraform over-fire that this run's ref ordering attaches to COMP-017 — the underlying defect is recorded under COMP-040.
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
- Fix: Only a top-level cluster client construction is unsupported; one inside a function or method is an option next to the standalone client. Regression: stage-a.test.ts COMP-019.
- Status: fixed

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
- Phase 3 residual: the Dockerfile directory is still the app root when the build context is the repository root (documenso `apps/remix`, rallly and formbricks `apps/web`) and the other way round (nocodb, whose expected root is `packages/nocodb`); COMP-035 adds `scripts/`, `.docker/`, `container/` and `*docker*` directories to the tooling list.
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
- Stage B (phase 7b): the `missing-copy-source` rejection was implemented,
  then REMOVED as unsound — the tree is capped at 200 files, so an absent
  `COPY` source proves nothing about the repository, and multi-stage
  `COPY --from=` and generated-artifact directories must never reject.
  Accepted as a documented limitation: an app that builds a prebuilt
  binary in a release Dockerfile is trusted as READY. Regression guard:
  `packages/analysis/test/stage-b-final-batch.test.ts` (COMP-021 regression
  guard). Residual on v11: repo-010 (listmonk) remains a single
  configuration-detection mismatch — the benchmark still expects
  NEEDS_CONFIGURATION for a Dockerfile that cannot build from the snapshot,
  while the analyser deliberately does not reject.
- Status: accepted (documented limitation)

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
- Stage B (phase 7b): engine selectors are now resolved through the binding/
  env model so a defaulted non-Postgres engine does not silently win
  (regression: stage-b-final-batch.test.ts COMP-022). Residual on v11:
  repo-011 (healthchecks) still reports READY instead of NEEDS_CONFIGURATION
  — its Django `DB=postgres` selector is read through an indirection the
  model still does not follow. No verdict flip changed; the mismatch stays
  configuration-detection.
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
- Fix: A non-secret read stored as-is (`const url = process.env.X;`, `host: process.env.X,`) is optional unless the code then refuses to run without it (`if (!x) throw …`); a secret-named variable (`*_SECRET`, `*_TOKEN`, `*_API_KEY`, …) stays required on a bare read, because a missing credential is a boot failure while an unset option is a default; a boolean chain or coercion (`Boolean(a && b)`, `!!a`) is a presence test. Regression: stage-a.test.ts COMP-023, phase7.test.ts. Unleash dropped from 27 required values to 7; umami from 20 to 6. Residual: single-argument helper calls (`authTypeFromString(process.env.AUTH_TYPE)`), `.split()` reads inside an enabled-only code path (umami `KAFKA_BROKER`), and alternative-URL reads (documenso `NEXT_PRIVATE_DATABASE_REPLICA_URLS`) still count as required — the remaining NEEDS_CONFIGURATION mismatches on umami and Unleash.
- Phase 3 residual: docuseal is NEEDS_CONFIGURATION for `SIDEKIQ_BASIC_AUTH_PASSWORD`, a bare secret-named read that only protects an optional dashboard — the secret rule keeps it required by design.
- Status: fixed

### COMP-024 — Any write call in runtime source is persistent local storage

- Repositories: repo-019, 022, 023, 026, 027, 028, 029, 033, 034, 036, 040,
  042, 043, 052, 054, 055, 056, 059, 061, 063, 066, 072, 076 (blocked), and
  repo-038, 046 (a real `VOLUME` missed because no write call sat in the
  fetched tree)
- Type: ANALYSIS_BUG
- Expected: `unsupported: []` — a cache write, a temp file, a generated asset,
  a log line is not state the app needs back on the next request
- Actual: `local-file-storage` blocking → NOT_COMPATIBLE on 20 repositories
  that expected NEEDS_CONFIGURATION or READY; reversed on apache/answer and
  kanboard, whose `VOLUME /data` never met a write call in the 200 fetched
  files
- Evidence: `detectLocalFilesystem` matched `fs.writeFile`, `fs.mkdir`,
  Python `open(…, "w")` and Ruby `File.write` anywhere in runtime source.
  planka, linkwarden and reactive-resume ship an S3 alternative and were
  still blocked; authelia was blocked for a certificate write; grafana for
  a frontend build helper.
- Customer relevance: highest of the corpus — the single largest false-
  rejection cause; every mature application writes to disk somewhere.
- Fix: durable local state must be DECLARED: a `VOLUME` in the selected
  Dockerfile, or a volume the production Compose file mounts into an
  application service (read-only mounts, the Docker socket, single-file
  mounts, customisation directories such as `custom/`, `plugins/`,
  `certs/`, and bind mounts of a directory the repository ships never
  count). A volume that only backs the default embedded database
  (`VOLUME /database`, `db_data_sqlite:`) is exempt when a PostgreSQL driver
  is declared, and a detected object-storage alternative (S3 client) clears
  the finding, because the vendor configures S3 through environment
  variables. Regression: stage-a-phase3.test.ts COMP-024; the write-call
  fixtures in analysis.test.ts, phase7.test.ts, rules.test.ts,
  readiness-report.test.ts and manifest.test.ts now declare a volume.
  Residual: wiki.js (`VOLUME /wiki/data/content`, a git-sync cache) and
  wallabag (`./data` bind mount holding images next to the SQLite default)
  stay blocked; gitea's `VOLUME /data` reports as `local-filesystem` where
  the entry expected `persistent-volume` — the two families meet at a
  Dockerfile `VOLUME` and the audit records it under this family.
- Status: fixed

### COMP-025 — A durable data directory with no VOLUME or Compose mount is invisible

- Repositories: repo-031 (homepage: `HOMEPAGE_CONFIG_DIR`, YAML edited through
  the UI), repo-044 (firefly-iii: uploads under `storage/`, no Dockerfile in
  the repository), repo-047 (halo: `~/.halo2` working directory), repo-074
  (vaultwarden: `/data`, but the root `Dockerfile` is a stub pointing at
  `docker/Dockerfile.*` variants), repo-075 (changedetection.io before the
  Compose parser read its four-space indentation)
- Type: ANALYSIS_MISSING_SIGNAL
- Expected: NOT_COMPATIBLE `[local-filesystem]`
- Actual: NEEDS_CONFIGURATION or READY
- Evidence: the app keeps state under a directory named only in its own
  configuration (an env var default, a Java working directory, a Laravel
  `storage/` path) with no container-level declaration COMP-024 can read.
- Customer relevance: medium — the deployment starts and loses data on the
  first redeploy; a failed first deploy is cheaper than a silent data loss.
- Recommended action: Phase 5 decision. Candidate signals: a `*_DATA_DIR` /
  `*_CONFIG_DIR` / `STORAGE_PATH` variable with a local default and no S3
  alternative; a README "volumes" table; the documented image's `VOLUME`
  when the repository builds several variants.
- Stage B (phase 7b + fix 1e6ad17): explicit durable-data-directory
  detection landed — a `*_DATA_DIR`/`*_CONFIG_DIR`/`*_WORK_DIR` variable
  with a local default and no VOLUME/Compose mount now rejects as
  `local-filesystem` (regression: stage-b-final-batch.test.ts COMP-025,
  COMP-024). Residual on v11: 2 repositories still carry the label —
  repo-044 (firefly-iii) rejects on its `mysql` family instead of its
  durable uploads directory (COMP-037/COMP-029 interplay), and repo-074
  (vaultwarden) is the one remaining false acceptance (its `/data`
  directory is declared in a Dockerfile variant the analyser does not
  select). Verdict flips fell 4 → 1.
- Status: open

### COMP-026 — Compose sidecars and profile-gated services count as application services

- Repositories: repo-019 (meilisearch), 021 (mssql, oracle, cockroachdb,
  azure, keycloak, maildev), 022, 024, 025, 026 (seaweedfs), 034 (nginx),
  036 (caddy), 043, 045 (meilisearch, mailpit), 048 (smtp), 051 (caddy),
  054, 055, 066 (chrome, meilisearch), 070 (proxy, pictrs), 074 (a
  `playwright/` Compose file), 076
- Type: ANALYSIS_BUG
- Expected: one application service; a search engine, a mail sandbox, a
  reverse proxy, a headless browser or a test database next to it is a
  dependency, not a second copy of the app
- Actual: `docker-compose-multi-service` → NOT_COMPATIBLE on 12 repositories
  that expected NEEDS_CONFIGURATION or READY
- Evidence: `INFRA_COMPOSE_IMAGE_REGEX` knew only databases, caches, brokers
  and MinIO; every other image counted; `profiles:` (a service that does
  not start with the default stack) was ignored; `playwright/`,
  `benchmarks/`, `devenv/`, `suites/` and `docker-compose-examples/`
  directories counted as production.
- Customer relevance: high — the second-largest false-rejection cause;
  self-hosted products routinely ship a full Compose stack.
- Fix: the Compose parser (now shared by the detectors and the rejection
  checks) records `profiles:` and volumes per service, reads two- and
  four-space indentation, and `composeApplicationServices` drops
  profile-gated services and the sidecar image families (search engines,
  mail sandboxes, proxies, browsers, test databases, vector stores,
  observability, Temporal, SpiceDB, …). More non-production directory
  names. Regression: stage-a-phase3.test.ts COMP-026. Residual: ToolJet's
  root `docker-compose.yaml` is a development stack (`plugins`, `client`,
  `server` build services) while its production file sits under
  `deploy/docker/`; lobehub and LibreChat still count a second built
  service (`fts-search-*`, `rag_api`) on already NOT_COMPATIBLE entries.
- Status: fixed

### COMP-027 — Dockerfile naming and ranking miss real images and pick variants

- Repositories: repo-022 (`docker/ce-production.Dockerfile` unrecognised),
  028 (`Dockerfile.fips.standalone-infisical` over the standard image), 040
  (`Dockerfile.dev.dockerignore` matched as a Dockerfile), 049
  (`…/monaco/…/dockerfile/dockerfile.js`), 050 (`lib/livebook/hubs/dockerfile.ex`),
  052 (`Dockerfile.transcribe.gpu` made the app GPU-only), 054
  (`prod.Dockerfile`), 063 (`operator/Dockerfile` over
  `quarkus/container/Dockerfile`), 065 (an `integrationtest` image;
  `.docker/Dockerfile-build` unrecognised), 069 (`.cursor/Dockerfile`, then
  `twenty-postgres-spilo/`), 072 (`tools/setup/dev-vagrant-docker`), 074
  (`Dockerfile.j2` templates)
- Type: ANALYSIS_BUG
- Expected: the image the project documents, or none
- Actual: a variant, a template, an editor container, an operator, a
  sidecar image, or a source file named after the format; the GPU check
  read the variant and rejected joplin
- Evidence: `DOCKERFILE_REGEX` accepted only `Dockerfile[.suffix]`; the dev
  regex knew a short list of directories; ties broke alphabetically.
- Customer relevance: high — the selected Dockerfile drives the port, the
  health check, the start command, the app root and the GPU check.
- Fix: both naming orders (`<name>.Dockerfile`, `Dockerfile-<name>`) are
  recognised; `.dockerignore`, templates and source files are not
  Dockerfiles; editor, operator, tool, test, documentation and
  infrastructure-image directories, and hardware/base-image variant
  suffixes (`fips`, `gpu`, `cuda`, `alpine`, `arm64`, `preview`, …) rank
  last; at equal depth fewer name segments win; the GPU check reads the
  selected Dockerfile only. The tree fetch accepts the same names.
  Regression: stage-a-phase3.test.ts COMP-027. Residual: n8n
  (`docker/images/engine` over `docker/images/n8n`) and
  microservices-demo (`src/adservice` over `src/frontend`) are genuine
  ambiguities the AI fallback's `multiple-dockerfiles` question exists
  for; wiki.js's `dev/build/Dockerfile` is cut by the 200-file cap
  (COMP-018 class); authelia's entry names `Dockerfile.dev` where the
  analyser selects the root `Dockerfile` — the entry is the outlier.
- Status: fixed

### COMP-028 — EXPOSE variables are unresolved and the first exposed port wins

- Repositories: repo-032 (`EXPOSE ${APP_PORT}`), 035 (`EXPOSE ${PORT}`), 037
  (`EXPOSE ${SUPERSET_PORT}`), 052 (`EXPOSE ${APP_PORT}`), 058 (`EXPOSE 22
  3000`), 072 (`EXPOSE 22` before `EXPOSE 9991`)
- Type: ANALYSIS_BUG
- Expected: the HTTP port the image documents (9000, 8000, 8088, 22300,
  3000, 9991)
- Actual: no port (→ NEEDS_CONFIGURATION), a Compose mapping of an
  unrelated service (superset: the Hive block's 50070), or the SSH port 22
- Evidence: `DOCKERFILE_EXPOSE_REGEX` accepted a literal or `${PORT:-n}`
  only and returned the first match.
- Customer relevance: medium — a missing port is a NEEDS_CONFIGURATION
  verdict; a wrong port is a failed first deploy.
- Fix: every `EXPOSE` token is read; `$VAR` / `${VAR}` resolves against the
  same Dockerfile's `ENV`/`ARG` default; SSH, mail, DNS and bundled-database
  ports are skipped when another port is exposed. Regression:
  stage-a-phase3.test.ts COMP-028. Residual: superset's `SUPERSET_PORT` has
  no default in the image; ToolJet, hoppscotch, django-helpdesk, twenty,
  postiz, n8n and microservices-demo expose a port on a Dockerfile or
  service other than the documented one.
- Status: fixed

### COMP-029 — PostgreSQL drivers outside Node, Python, Ruby and Go are invisible

- Repositories: repo-034, 044, 045, 046, 047, 048, 049, 060, 063, 070
  (PHP `ext-pdo_pgsql` / `docker-php-ext-install pdo_pgsql`, JVM
  `org.postgresql` / `r2dbc-postgresql`, .NET `Npgsql`, Rust `diesel` with
  the `postgres` feature) and repo-035, 038, 039, 040, 058, 064, 065 (a
  direct Go/Python driver with no connection variable the model knows)
- Type: ANALYSIS_MISSING_SIGNAL
- Expected: `postgres: true`
- Actual: `postgres: false`, so Deployz would not provision the database;
  the SQLite rejection also fired on wallabag and vaultwarden because
  `engineIsConfigurable` saw no PostgreSQL driver
- Evidence: the tree fetch never requested `pom.xml`, `build.gradle`,
  `Cargo.toml`, `*.csproj` or `mix.exs`; `assessPostgres` demanded an
  independent connection variable that Go/Java/.NET apps name in their own
  settings (`MEMOS_DSN`, a YAML storage block).
- Customer relevance: high — a missed database means a failed first deploy
  for every JVM, PHP, .NET and Rust customer.
- Fix: the fetch and the dependency scan read the JVM, .NET, Rust, Elixir
  and PHP manifests; PostgreSQL tokens for each (plus the PHP PDO extension
  installed in the selected Dockerfile and a Rust ORM's `postgres`
  feature); a direct driver declared in a runtime manifest (not a tool
  module, not a Go `// indirect` line) is evidence of a configured engine
  by itself; a SQLite connection URL next to a PostgreSQL driver is a
  configurable default. Regression: stage-a-phase3.test.ts COMP-029, the
  COMP-013 indirect-driver case. Residual: firefly-iii, monica and
  kanboard declare no PostgreSQL package (PHP PDO through the base image's
  extension installer), OrchardCore references `Npgsql` from a project file
  the cap drops, lemmy's Cargo feature is spelled through `diesel-async`;
  the other way, gatus and CTFd report `postgres: true` on a direct driver
  where the entry expected `false` (gatus treats SQLite as its default —
  the audit keeps the entry and records the disagreement here), and
  microservices-demo's `productcatalogservice` declares `pgx`.
- Status: fixed

### COMP-030 — A port with no EXPOSE instruction is not found

- Repositories: repo-020 (no Dockerfile), 029, 044, 045, 050, 052, 060, 063,
  065, 074, 077, 079, 080
- Type: ANALYSIS_MISSING_SIGNAL
- Expected: the documented port (3000, 8080, 22300, 8000, 4433, 80, 8000)
- Actual: `port: null` → `port-missing` → NEEDS_CONFIGURATION
- Evidence: the image documents its port only in a Go/Elixir/Rust/PHP
  default (`flag.Int("port", 8080)`, Phoenix `PORT` default, Rocket
  `ROCKET_PORT`), a Compose mapping in a non-root file, or not at all.
- Customer relevance: low — the vendor supplies the port on the
  configuration screen; the verdict is honest.
- Recommended action: Phase 5 decision; a per-runtime default-port table
  (Rails 3000, Django 8000, Phoenix 4000, Spring 8080, Rocket 8000) is the
  cheapest signal and is what Deployz's PORT override needs anyway.
- Stage B (phase 7): port provenance landed — runtime literals in
  Go/Elixir/Rust/PHP source are read, Compose container-side mappings are
  honoured, and a framework-default port is a prefill the deployment gate
  still asks the vendor to confirm (`portIsDefault`); regression:
  stage-b-phase7.test.ts COMP-030. Residual on v11: 9 repositories still
  carry a port fact mismatch and none flips a verdict; livebook
  (repo-050) is the one NEW configuration-detection mismatch — its Phoenix
  default (4000) prefills where the benchmark expected the documented
  8080, and the gate keeps NEEDS_CONFIGURATION.
- Status: open

### COMP-031 — A required third-party service in the Compose stack is not a family

- Repositories: repo-057 (postiz: Temporal server, admin tools and UI)
- Type: ANALYSIS_MISSING_SIGNAL
- Expected: NOT_COMPATIBLE — the app cannot run without a Temporal server
  Deployz does not provision
- Actual: NEEDS_CONFIGURATION once COMP-026 stopped counting the Temporal
  images as application services
- Evidence: the Compose file is the only place the dependency is declared;
  the app reads `TEMPORAL_ADDRESS` with a default.
- Customer relevance: low-medium — workflow engines, search engines and
  vector stores appear in a minority of self-hosted stacks; when they do,
  the first deploy fails at runtime rather than at analysis.
- Recommended action: Phase 5 decision — a `required-service` family driven
  by a non-sidecar image in the production Compose file that the app also
  names in a required connection variable.
- Stage B (phase 7b): `checkRequiredThirdPartyService` landed — a Compose
  service whose image is a third-party server the app cannot run without
  (Temporal) now rejects as a family (regression: stage-b-final-batch.test.ts
  COMP-031). repo-057 (postiz) now returns NOT_COMPATIBLE; its remaining
  mismatch is a family-list fact (expected `docker-compose-multi-service`,
  actual `temporal`) with no verdict flip. The one v10 verdict flip is gone.
- Status: fixed

### COMP-032 — A database client dependency alone rejects integration platforms

- Repositories: repo-022 (ToolJet: mongodb, opensearch data sources), 023
  (wiki.js: a MongoDB search module), 028 (Infisical: mongodb,
  elasticsearch, cassandra dynamic-secret providers), 029 (emailengine: an
  optional Elasticsearch document store), 053 (n8n: the MongoDB node)
- Type: ANALYSIS_BUG
- Expected: no database rejection — the client connects to customers'
  databases, the app's own data is in PostgreSQL
- Actual: `mongodb`, `elasticsearch` and `other-database` rejections →
  NOT_COMPATIBLE
- Evidence: `checkMongo`, `checkElasticsearch` and
  `checkOtherUnsupportedDatabases` fired on the dependency name, unlike the
  broker checks after COMP-002.
- Customer relevance: high — automation, secrets and BI platforms are a
  large share of self-hosted products and all ship these clients.
- Fix: the same corroboration the broker checks use — a service running
  that database in the production Compose file, a connection variable the
  app reads without a fallback, a Prisma `mongodb` provider, or (MongoDB)
  the app's own Mongoose models. LibreChat (models + a `mongodb` service)
  still rejects. Regression: stage-a-phase3.test.ts COMP-032; the bare
  dependency fixtures in analysis.test.ts, rules.test.ts and
  manifest.test.ts now carry corroboration.
- Status: fixed

### COMP-033 — Deployment descriptors the tree fetch drops never reach the cloud checks

- Repositories: repo-077 (argo-cd: `manifests/` kustomizations), repo-078
  (microservices-demo: `kubernetes-manifests/`, `terraform/`), repo-079
  (azure-search-openai-demo: `infra/*.bicep`)
- Type: ANALYSIS_MISSING_SIGNAL
- Expected: NOT_COMPATIBLE `[kubernetes]`, `[kubernetes, terraform]`,
  `[azure]`
- Actual: NEEDS_CONFIGURATION — no cloud or infrastructure check fired on
  the whole corpus
- Evidence: `isRelevantPath` fetches manifests, Dockerfiles, Compose, env
  samples and source files; `.tf`, `.bicep`, `kustomization.yaml` and
  `Chart.yaml` are never in the tree, so `checkKubernetes`,
  `checkTerraform` and `checkAzure` have nothing to read in production.
  Fetching them is not the fix on its own: many deployable apps ship a
  Helm chart or a Terraform module as ONE deployment option (outline, n8n,
  grafana), and the checks would reject them.
- Customer relevance: low — Kubernetes-native controllers and multi-service
  demos are not Deployz customers; the cost is a runtime failure instead
  of an analysis verdict.
- Recommended action: Phase 5 decision on whether a Kubernetes-native
  signal (`k8s.io/client-go` with in-cluster configuration, no HTTP
  listener) is worth more than the false rejections a descriptor-based
  check would create.
- Stage B (phase 7b): deployment descriptors (`.tf`, `Chart.yaml`,
  `kustomization.yaml`, `bicep`) are now fetched, and the Kubernetes,
  Terraform and Azure checks fire on them (regression: github.test.ts
  COMP-033; stage-b-final-batch.test.ts COMP-033). All three repositories
  (argo-cd, microservices-demo, azure-search-openai-demo) now reject
  correctly: 0 repositories carry the label on v11. The warning in the
  Evidence note materialised as intended — an app that ships a chart or
  Terraform as one optional deployment path over-fires — recorded as new
  COMP-040.
- Status: fixed

### COMP-034 — A script-based HEALTHCHECK hides its path

- Repositories: repo-019 (`wget --spider http://localhost:3000`), 024
  (`wget --spider http://localhost:3000`), 027 (`node ./healthcheck.js`)
- Type: ANALYSIS_BUG
- Expected: `/` — the path the image's own check probes
- Actual: `/health`, the default when no candidate names a path
- Evidence: `HEALTHCHECK_URL_REGEX` required a path after the origin, and a
  script referenced by the instruction was never opened.
- Customer relevance: medium — a wrong health path is a failed first
  deploy on an otherwise ready app.
- Fix: a bare origin means `/`; a script the HEALTHCHECK runs is searched
  for its URL. Regression: stage-a-phase3.test.ts COMP-034. Residual:
  planka, linkwarden and cal.com still show `/health` on the corpus because
  a JS route registration elsewhere in the tree outranks the check (COMP-005).
- Status: fixed

### COMP-035 — Build-script directories become the app root

- Repositories: repo-039, 041 (`scripts/Dockerfile`), 063
  (`quarkus/container/Dockerfile`), 065 (`.docker/Dockerfile-build`), 069
  (`packages/twenty-docker/twenty/Dockerfile`)
- Type: ANALYSIS_BUG
- Expected: `appRoot: .`
- Actual: `scripts`, `operator`, `oryx/watcherx/integrationtest`, `.cursor`
- Evidence: COMP-020's tooling list did not include `scripts`, `.docker`,
  `container` or a `*docker*` package directory.
- Customer relevance: medium — a wrong root is a failed build.
- Fix: those directories map to the repository root. Regression:
  stage-a-phase3.test.ts COMP-035.
- Status: fixed

### COMP-036 — Pulumi and other IaC packages in non-runtime directories reject the app

- Repositories: repo-083 (windmill: `@pulumi/aws` in `benchmarks/pulumi/package.json`)
- Type: ANALYSIS_BUG
- Expected: no rejection — a benchmark harness that provisions its own test
  fleet is not the application's deployment
- Actual: `pulumi` → NOT_COMPATIBLE
- Evidence: `checkPulumi` reads every package manifest; the non-runtime
  path filter (`isRuntimeSourcePath`, COMP-003/COMP-016) is not applied to
  the IaC checks.
- Customer relevance: low-medium — rare, but a hard false rejection when it
  happens.
- Recommended action: Phase 6 — apply the runtime-path filter to the
  Pulumi, Terraform, CloudFormation, Serverless and cloud-file checks.
- Fix: every IaC and cloud-descriptor check (Terraform, Pulumi, CloudFormation, Serverless, Azure, GCP) reads runtime paths only, and `benchmarks/` joined the non-runtime segments. Regression: stage-a-phase6.test.ts COMP-036. windmill no longer rejects on Pulumi (it still rejects on its reference Compose workers and cache volume, COMP-010/COMP-024).
- Status: fixed

### COMP-037 — Unsupported database engines declared outside Node manifests are invisible

- Repositories: repo-089 (Stirling-PDF: H2 in `build.gradle`, PostgreSQL
  gated behind a paid licence), repo-097 (plausible: ClickHouse via
  `ecto_ch` in `mix.exs`), repo-099 (BookStack: a MySQL-only Laravel app
  with no Node driver)
- Type: ANALYSIS_MISSING_SIGNAL
- Expected: NOT_COMPATIBLE `[other-database]` / `[mysql]`
- Actual: READY, NEEDS_CONFIGURATION, or NOT_COMPATIBLE on a Compose family
  instead of the engine
- Evidence: the MySQL, MongoDB, Elasticsearch and other-database checks read
  Node dependency names, Prisma providers and Go modules only; the JVM,
  Elixir and PHP manifests COMP-029 now fetches carry no unsupported-engine
  tokens yet.
- Customer relevance: medium — a JVM or Elixir app on the wrong engine is
  accepted and fails at first deploy.
- Recommended action: Phase 6 — engine tokens per manifest family
  (`com.h2database`, `mysql-connector-j`, `mariadb-java-client`, `ecto_ch`,
  `myxql`, Laravel `DB_CONNECTION=mysql` samples with no `pgsql` driver),
  with the same configurable-engine exemption COMP-002 applies.
- Fix: MySQL/MariaDB drivers in Python, Go, JVM and Elixir manifests and a Laravel MySQL default (`config/database.php` or `DB_CONNECTION=mysql` in the env sample) reject when no PostgreSQL driver is declared; ClickHouse clients in any manifest reject with the COMP-032 corroboration; an embedded JVM database (H2, HSQLDB, Derby) with no PostgreSQL driver rejects. Regression: stage-a-phase6.test.ts COMP-037. Residual: all three unseen cases stay — Stirling-PDF declares `org.postgresql` (PostgreSQL is licence-gated, which no static rule can see), plausible keeps its Compose stack in a separate repository and reads `CLICKHOUSE_DATABASE_URL` from Elixir runtime config the env model does not read, and BookStack declares its MySQL default in `config/database.php`, a PHP file the tree fetch never requests. firefly-iii now rejects on `DB_CONNECTION=mysql` in its env sample where the entry expected `local-filesystem` — the right verdict for a weaker reason (its PostgreSQL support goes through a PHP extension no manifest declares, COMP-029).
- Status: fixed

### COMP-038 — Workspace manifests fill the 200-file cap ahead of the production Dockerfile

- Repositories: repo-082 (mattermost: `server/build/Dockerfile` absent from
  the fetched tree; `.cursor/Dockerfile` selected, port 5432)
- Type: ANALYSIS_BUG
- Expected: `server/build/Dockerfile`, port 8065
- Actual: an editor container image and its database port
- Evidence: manifests, Dockerfiles, Compose files and env samples share
  relevance tier 0 and sort alphabetically inside it; a large workspace
  ships more than 200 `package.json` files, so a Dockerfile late in the
  alphabet never enters the tree (COMP-018 handled the source tiers, not
  tier 0).
- Customer relevance: medium — large monorepos are a real customer shape;
  the consequence is a wrong image, port and root.
- Recommended action: Phase 6 — rank Dockerfiles, Compose files and env
  samples above package manifests inside tier 0, and cap the number of
  manifests fetched from non-runtime paths.
- Fix: the real cause was two-fold — `build` was an IGNORED directory segment (build output), so `server/build/Dockerfile` was never fetched at all, and inside relevance tier 0 manifests sorted alphabetically ahead of Dockerfiles. `build/` is no longer ignored (a committed one holds build tooling), Dockerfiles, Compose files and env samples now rank above package manifests, and manifests under test/tool directories rank with those directories (`e2e-tests/`, `integration_tests/` count as non-runtime). Regression: github.test.ts COMP-038. mattermost now selects `server/build/Dockerfile` and port 8065; its verdict stays NOT_COMPATIBLE for the development Compose stack under `server/` (COMP-026 residual).
- Status: fixed

### COMP-039 — A `…/status`-suffixed feature route displaces the app's real health endpoint

- Repositories: repo-004 (miniflux: expected `/healthcheck`, actual
  `/v1/integrations/status`), repo-033 (paperless: expected `/`, actual
  `/ws/status`), repo-059 (vikunja: expected `/health`, actual
  `/csv/status`), repo-076 (LibreChat: expected `/health`, actual
  `/oauth/status`), repo-084 (nango: expected `/health`, actual
  `/sync/status`)
- Type: ANALYSIS_BUG
- Expected: the health route the app actually serves (`/health`,
  `/healthcheck`, or a HEALTHCHECK-probed root)
- Actual: a longer feature API route whose last segment is a generic word
  the phase-5 health vocabulary accepts (`status`, `ping`, `up`, `alive`,
  `readyz`, `livez`)
- Evidence: phase 5 widened `HEALTH_ROUTE_REGEX` /
  `HEALTH_ROUTE_LITERAL_REGEX` / `HEALTH_PATH_SEGMENT_REGEX` from
  `health|healthz|healthcheck|heartbeat` to also accept `readyz|livez|up|
  status|ping|alive|_health`. Route-literal scans across Go/Python/JS then
  match any registration whose URL ends in one of those words, and the
  equal-priority longest-path tie-break lets a longer feature route
  (`/v1/integrations/status`, `/ws/status`, `/csv/status`,
  `/oauth/status`, `/sync/status`) beat the real `/health` or
  `/healthcheck`. All five repositories matched their health path at v10
  and regressed at v11; none of the five flips a verdict (each stays on
  its other blockers).
- Customer relevance: medium — the reported health path drives the
  deployment gate's readiness check and the value the vendor is asked to
  confirm; a wrong path on a healthy app is friction and, for a
  vendor-confirmed prefill, a real readiness risk.
- Recommended action: only accept a generic `…/status`-style literal as
  health evidence when the app registers no health-named route at all;
  prefer an explicit `/health`, `/healthcheck`, `heartbeat` or
  HEALTHCHECK/Compose healthcheck URL over a longer generic-word route,
  and never let the longest-candidate tie-break outrank an exact
  health-named route.
- Status: open

### COMP-040 — Cloud-descriptor checks fire on an app's own chart/terraform (COMP-033 side effect)

- Repositories: repo-041 (coder: Terraform under `dogfood/`, expected no
  `unsupported`, actual `[terraform]` — now a false rejection),
  repo-073 (kafdrop: `chart/Chart.yaml` present, expected `[kafka]`,
  actual `[kafka, kubernetes]`)
- Type: ANALYSIS_BUG
- Expected: only the families the deployment itself requires (`[]` for
  coder, `[kafka]` for kafdrop)
- Actual: an extra `terraform` or `kubernetes` family read from a
  descriptor the repository ships as one optional deployment path or for
  the project's own operation (a Helm chart in `chart/`, dogfood
  Terraform), not as the customer's required infrastructure
- Evidence: phase 7b made the tree fetch include deployment descriptors so
  the cloud checks can fire on genuinely Kubernetes-native repositories
  (COMP-033, fixed — argo-cd, microservices-demo, azure-search-openai-demo
  now reject). The same change surfaces descriptors that are the app's OWN
  option — coder's `dogfood/*.tf` (how the project runs itself) and
  kafdrop's `chart/` — and `checkTerraform`/`checkKubernetes` read them as
  the customer's stack. Both repositories matched their unsupported list
  at v10 and regressed at v11.
- Customer relevance: medium — the cost is a false rejection (coder flips
  NEEDS_CONFIGURATION → NOT_COMPATIBLE) or a wrong reason on an app that
  is rejected for another family anyway (kafdrop).
- Recommended action: fire the Kubernetes/Terraform checks on descriptors
  that represent the app's own deployment (a chart/terraform next to the
  selected Dockerfile that the repo builds from), and treat project-owned
  `dogfood/`, `examples/` and `chart/` packaging as the "one option"
  COMP-033 warned about — corroborate with in-cluster client code before
  rejecting.
- Status: open

### COMP-041 — A TCP-probe-only health check is invisible to the vendor-required health gate

- Repositories: repo-090 (pgweb: no HTTP health route; the reference
  Compose health check is a bare TCP probe, `nc -vz 127.0.0.1 8081`)
- Type: ANALYSIS_MISSING_SIGNAL
- Expected: READY — pgweb is a stateless DB-admin tool whose container
  health check is a TCP probe on the listening port (uptime-kuma
  precedent in this benchmark: no HTTP route required)
- Actual: NEEDS_CONFIGURATION — the phase-5 gate now raises
  `health-path-required` (mode `vendor_required`) whenever no HTTP health
  evidence is found
- Evidence: `detectHealthEndpoint` accepts an HTTP URL from a Dockerfile
  HEALTHCHECK or Compose healthcheck, or a health-named route literal; a
  Compose `test: ["CMD", "nc", "-vz", "127.0.0.1", "8081"]` carries no
  HTTP URL and no route exists, so `healthMode` becomes
  `vendor_required` and `evaluateManifestReadiness` errors. pgweb matched
  every fact at v10 (READY) and regressed to NEEDS_CONFIGURATION at v11.
- Customer relevance: low — one repository, but a real product shape
  (appliances and admin tools that expose a port and are probed at the
  TCP level); the vendor is asked for a health path the image does not
  need.
- Recommended action: when a container/Compose health check exists but is
  not an HTTP URL (a TCP probe or a script without a URL), treat it as
  container-level health evidence with no HTTP path requirement, and keep
  `vendor_required` for the truly probe-less case.
- Status: open
