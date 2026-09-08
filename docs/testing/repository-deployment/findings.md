# Stage B findings registry

A finding is a systemic behaviour, never one repository's failure. Ids are
stable (`DEPLOY-001`, `DEPLOY-002`, …). Every result in `runs/` that a
finding explains references it in `findingIds`; the summary counts
repositories per finding.

Vocabulary (see `README.md`): the failure stage names where the funnel
stopped; the root cause names the first responsible layer. Resolution is
one of `FIXED`, `MVP_CAPABILITY_GAP`, `CORRECTLY_UNSUPPORTED`,
`REPO_CONFIGURATION`, `UPSTREAM_REPO_FAILURE`, `DEFERRED_WITH_REASON`, or
`OPEN` while work is in progress.

| Id | Stage | Root cause | Resolution | Affected |
| --- | --- | --- | --- | --- |
| DEPLOY-001 | INFRA_ERROR | DEPLOYZ_BUG | FIXED (pending deploy) | every non-Documenso application (by inspection; Wave 1 measures it) |
| DEPLOY-002 | CONFIG_ERROR | ANALYSIS_BUG | OPEN | repo-001, repo-002, repo-008, repo-051, repo-090, repo-092 (gate audit, analysis version 15) |
| DEPLOY-003 | GATE_ERROR | ANALYSIS_MISSING_SIGNAL | DEFERRED_WITH_REASON | 18 expected-deployable repositories the gate rejects (gate audit, analysis version 15) |
| DEPLOY-004 | GATE_ERROR | ANALYSIS_MISSING_SIGNAL | DEFERRED_WITH_REASON | 6 expected-unsupported repositories the gate accepts (gate audit, analysis version 15) |
| DEPLOY-005 | ENV_BINDING_ERROR | ANALYSIS_MISSING_SIGNAL | FIXED for `process.env` reads (PR #212, analysis v16; kutt rerun 6 reached RDS through `DB_HOST`); SECOND SHAPE measured on directus (attempt 1, 2026-09-07): reads through a local env object (`const env = useEnv(); env['DB_HOST']`) were invisible to the env detectors, so no alias was bound — FIXED in analysis v17 (PR #224 merged and deployed 2026-09-07; directus rerun pending) — v17 over-required keys read through an env object (outline attempt 1 CONFIG_ERROR), corrected in v19 (PR #227 merged 2026-09-08: reads through the env object never imply a requirement); THIRD SHAPE measured on memos (attempt 1, 2026-09-08): Go `viper.SetEnvPrefix("memos")` + `viper.GetString("dsn")` means `MEMOS_DSN`, a name that appears nowhere as a literal, so no `url` alias was bound and the configured task dialled `127.0.0.1:5432` — FIXED (PR #226 merged 2026-09-08, analysis v18: viper prefix + key ⇒ env name; memos rerun pending) | measured on repo-003 (kutt rerun 5: `connect ECONNREFUSED 127.0.0.1:5432`, no `DB_HOST` bound); predicted repo-021, repo-039; repo-035 ihatemoney PASSED (the v15 binding delivered `SQLALCHEMY_DATABASE_URI`) |
| DEPLOY-006 | HEALTH_PATH_ERROR | DEPLOYZ_BUG | FIXED (pending deploy) | repo-008 (gatus; every image without a shell + curl) |
| DEPLOY-007 | DATABASE_ERROR | DEPLOYZ_BUG | FIXED (PR #213 merged, application templates republished 2026-09-07 ~11:35Z: option A — an init container delivers the regional RDS CA bundle into the task, `NODE_EXTRA_CA_CERTS` + `PGSSLROOTCERT`); kutt and umami reruns pending | repo-003 (kutt, `ssl: true`); repo-001 (umami, `sslmode=require` via adapter-pg) likely; every node-postgres client that verifies |
| DEPLOY-008 | BUILD_ERROR | DEPLOYZ_BUG | FIXED (deployed 2026-09-06) | repo-004 (miniflux); predicted repo-039 (memos); every vendor override of the Dockerfile path, build context/command, start command or app root that an analysis run follows |
| DEPLOY-009 | ENV_BINDING_ERROR | DEPLOYZ_BUG | FIXED (PR #207 merged, deployed, templates republished 2026-09-06) | repo-003 (kutt); predicted repo-007 (ghostfolio), repo-021 (directus), repo-016 (outline), repo-039 (memos); every application that needs a vendor value or a Deployz-generated secret to boot |
| DEPLOY-010 | ENV_BINDING_ERROR | DEPLOYZ_BUG | FIXED (PR #208 merged; bootstrap republish pending) | every CONFIG_UPDATE with a secret to write — found on kutt rerun 2 (the first configured first start) |
| DEPLOY-011 | CONTAINER_START_ERROR | DEPLOYZ_BUG | FIXED (PR #209 merged, bootstrap republished 2026-09-07; kutt rerun 3 settled in 12 min with the exit code) | every deploy whose tasks reach RUNNING and then exit — found on kutt rerun 2 (DEPLOY_RELEASE RUNNING for 80+ min, re-offered twice) |
| DEPLOY-012 | ENV_BINDING_ERROR | DEPLOYZ_BUG | FIXED (PR #210 merged, bootstrap republished 2026-09-07; kutt rerun 4's config pass SUCCEEDED) | every CONFIG_UPDATE with a secret to write — found on kutt rerun 3, the first config pass that found its secret (DEPLOY-010) |
| DEPLOY-013 | ENV_BINDING_ERROR | DEPLOYZ_BUG + ANALYSIS_BUG | FIXED in two parts: PR #211 merged and deployed (mint app-internal secrets; kutt rerun 5 minted `JWT_SECRET`); PR #212 in review (the analyser called `DB_PASSWORD`, `REDIS_PASSWORD`, `MAIL_PASSWORD` internal secrets, so rerun 5 minted those too) | every vendor-scope secret typed before an install — found on kutt reruns 4 and 5 |
| DEPLOY-014 | TIMEOUT | DEPLOYZ_BUG | FIXED (PR #217 merged, bootstrap template republished 2026-09-07 ~14:30Z: the relay reads digest and exit code from the task's essential container; regression the #213 init container exposed; verified on ghostfolio attempt 2: the release pointer settled in 12 minutes) | repo-007 (ghostfolio, measured: healthy and serving, DEPLOY_RELEASE never settled); every database-backed application deployed on the #213 template until the relay republish |
| DEPLOY-015 | APPLICATION_ERROR (a false success) | DEPLOYZ_BUG | FIXED (PR #225 merged 2026-09-08; bootstrap republish pending the AWS session; relay: a deploy settles only when the service's PRIMARY deployment runs the revision the deploy targeted; crash loops are counted on that revision) | repo-039 (memos, measured: the circuit breaker rolled the first start back to the unconfigured template revision, which runs the same pinned image, and the relay reported SUCCEEDED while the app served from SQLite); every configured first start whose configured revision fails to become healthy |
| DEPLOY-016 | INFRA_ERROR (control plane down) | DEPLOYZ_BUG | OPEN — task handed to the billing workstream (migration 0036 must settle duplicates; a failed init must not be cached by warm containers); production restored by hand 2026-09-08 03:45Z | every request to api.deployz.dev for ten minutes; memos attempt 2's install wait and cleanup |

---

## DEPLOY-001 — A fresh install runs the template-pinned image, not the application's release

**Stage** INFRA_ERROR (the install stack cannot stabilise) · **Root cause**
DEPLOYZ_BUG · **Resolution** FIXED (pending deploy) · **Found** Phase 0, by
inspection of the deployed templates (2026-09-05).

**Behaviour.** The application template's container image is fixed when the
template is published (`packages/cdk/scripts/publish-application.mjs`:
`APP_IMAGE_REPOSITORY` / `APP_IMAGE_DIGEST` become the task definition's
`Image`; there is no image parameter). The relay's INSTALL creates the stack
from the bootstrap stack's `ApplicationTemplateUrl` and can only set
`param_ContainerPort` and `param_HealthCheckPath` from the manifest
(`packages/relay/src/install.ts`, `buildInstallParametersFromManifest`). The
application's own release is only deployed after INSTALL succeeds
(auto-deploy of the newest READY release). So the first task of every
install runs whatever image the template was published with — in
production today `deployz-images@sha256:a61054b3…`, a Documenso build, with
the Documenso preset's env names and a container health command that
probes `localhost:3000/api/health` regardless of the parameters.

**Effect.** For any application whose port or health path differ from the
published image's, the ECS service never reaches a steady state, the
deployment circuit breaker fires, CloudFormation rolls the stack back
(~20 minutes), the INSTALL job fails, and the release that would have
worked is never deployed. The product's claimed MVP (any single-container
app inside the boundary) is, at the install step, a Documenso-shaped
install.

**Evidence.** Deployed API Lambda `BOOTSTRAP_TEMPLATE_URL` →
`bootstrap/v1/bootstrap-template-v1.json`; its `ApplicationTemplateUrl`
default → `application/v1/application-template-v1.json` (47 resources,
21 `NEXT_PRIVATE` occurrences, image digest `a61054b3d61aaa84…`, parameters
`paramContainerPort, paramHealthCheckPath, paramAppApiKey,
paramAppSigningSecret, paramPublicUrl, paramNextauthSecret,
paramEncryptionKey, paramEncryptionSecondaryKey, paramSmtp*`). The version
canary (`scripts/version-canary/steps.ts`, `publishCanaryTemplate`) had to
publish a per-run template pinned to its own image to install at all.

**Generic fix (Phase 3a).** The application template declares an image
parameter (default: the publish-time image, so existing templates and
Documenso installs are unchanged); the control plane's INSTALL payload
carries the newest READY release's image reference when one exists; the
relay passes it as a parameter (the undeclared-parameter drop keeps older
templates working); a regression test for each of the three. Not a
repository-specific change: it makes the install run the release the
product already selects for auto-deploy.

**Product decisions carried to the final report.** (a) Publish the generic
(no-preset) template as the production default and keep Documenso on a
preset only if it still needs one after binding aliases and generated
secrets. (b) Refuse an install launch when the application has no READY
release, instead of installing a placeholder image.

**Affected.** By construction every application other than the one the
production template was published for. Wave 1 records which repositories
would have hit it; after the fix the finding is measured by its absence.

**Fix.** `packages/cdk/src/application/application-stack.ts` declares
`param_ImageReference` (default: the publish-time image) and uses it
everywhere the task definitions reference the container image;
`packages/contracts/src/index.ts` exports its logical id as
`IMAGE_REFERENCE_PARAMETER`; `apps/api/src/install-parameters.ts`
(`buildInstallParameters`) sets it to the deployment's application's newest
READY release with a known image, omitting the key when there is none
(PR #197, main `1f85974`).

---

## DEPLOY-002 — The gate demands values for variables the application does not need

**Stage** CONFIG_ERROR (the vendor must type values before the first
deploy) · **Root cause** ANALYSIS_BUG · **Resolution** OPEN · **Found**
Phase 2 gate audit (analysis version 15).

**Behaviour.** `evaluateManifestReadiness` refuses a deployment with
`required-env-vars-missing` for variables the environment model marks
required although the application reads them with a default, only inside
an optional integration, or only in a test/build context. Stage A records
the analyser side as COMP-023 (bare reads inside guarded branches), COMP-016
and COMP-041, all "fixed, residual". On the product side the residual is
not cosmetic: a READY repository becomes NEEDS_CONFIGURATION and the vendor
must invent values — umami's `CLOUD_MODE`, `CLICKHOUSE_URL`, `KAFKA_*`;
unleash's fifty rate-limit and `INIT_*` tokens; gatus's `BASE_URL`;
docuseal's `SIDEKIQ_BASIC_AUTH_PASSWORD`; dashy's `API_TOKEN`,
`IS_SERVER`, `VUE_APP_CONFIG_VALID`.

**Effect.** Friction, not a failed deployment: with any value the funnel
proceeds. Stage B configures those keys (`deploy-config.yaml` notes say
which) so the deployment path is still measured, and counts the
repositories here.

**Affected.** repo-001 (umami), repo-002 (unleash), repo-008 (gatus),
repo-051 (docuseal), repo-092 (dashy); repo-090 (pgweb) is the sibling
`health-path-required` demand (COMP-041) — 6 of the 8 READY expectations
in the corpus.

**Decision.** Carried to the final report as CONSIDER_FOR_MVP: the fix is
analyser precision (Stage A's open COMP-023/016/041 work), not a
deployment-path change.

---

## DEPLOY-003 — The gate rejects 18 expected-deployable repositories on reference files

**Stage** GATE_ERROR (false rejection: the repository never reaches the
build) · **Root cause** ANALYSIS_MISSING_SIGNAL · **Resolution**
DEFERRED_WITH_REASON · **Found** Phase 2 gate audit (analysis version 15,
120 repositories, 65 expected deployable).

**Behaviour.** `evaluateManifestReadiness` returns NOT_COMPATIBLE for 18 of
the 65 expected-deployable repositories (27.7%; 13 of them
`customer_realism: high`). Every one is a known Stage A finding:

| Rejection | Repositories | Stage A |
| --- | --- | --- |
| `docker-compose-multi-service` from a reference/dev compose file or an optional worker service | repo-024 cal.com, repo-043 huginn, repo-083 windmill, repo-206 nocobase, repo-005 flagsmith, repo-022 ToolJet, repo-082 mattermost, repo-207 khoj, repo-204 shlink (with `rabbitmq`), repo-055 nocodb (with `kubernetes`) | COMP-010, COMP-009, COMP-026 |
| `local-filesystem` from a declared volume whose S3 alternative or PostgreSQL driver the analyser cannot see | repo-023 requarks/wiki, repo-060 wallabag, repo-087 TandoorRecipes, repo-094 homarr, repo-211 AFFiNE | COMP-024 |
| `background-worker` for a worker that runs in the web process | repo-053 n8n | COMP-010 |
| `terraform` / `kubernetes` from an app's own dogfood or optional target | repo-041 coder, repo-220 headlamp | COMP-017/COMP-040, unseen2 residual |

**Effect.** These repositories get a Stage B outcome of GATE_ERROR with no
AWS cost; the deployment path is never measured for them, and a real
vendor with one of these applications is turned away at analysis.

**Why deferred.** Stage A already owns these as open analyser findings
with their own fix plan (reference-file scoping, optional-service
classification, data-directory alternatives), and none is a
deployment-path defect. Changing the rejection rules during Stage B would
move the Stage A baseline mid-audit; the final report ranks the item
(FIX_BEFORE_MVP candidate by realistic repositories affected) and the
rerun after any Stage A fix is `pnpm benchmark:deploy --gate --finding
DEPLOY-003`.

---

## DEPLOY-004 — The gate accepts 6 expected-unsupported repositories

**Stage** GATE_ERROR (false acceptance) · **Root cause**
ANALYSIS_MISSING_SIGNAL · **Resolution** DEFERRED_WITH_REASON · **Found**
Phase 2 gate audit (analysis version 15).

**Behaviour.** Six repositories Stage A expects to be NOT_COMPATIBLE come
out NEEDS_CONFIGURATION: repo-072 zulip (COMP-002, RabbitMQ read with a
default), repo-074 vaultwarden (COMP-025, undeclared data directory),
repo-084 nango and repo-088 netbox (COMP-015, a declared worker outside
Node), repo-089 Stirling-PDF and repo-097 plausible (COMP-037, unsupported
engines in JVM/Elixir manifests).

**Effect.** Stage B never provisions them: an expected-unsupported entry
is planned `gate-only` (README "Rollout"), so no AWS resource is created
for a false acceptance and the result records GATE_ERROR. A real vendor
would reach the install and fail at runtime (a missing broker, a lost data
directory, a worker that never starts).

**Why deferred.** As DEPLOY-003: open Stage A findings with their own plan,
no deployment-path change involved. Ranked in the final report.

---

## DEPLOY-005 — Applications that read the database or storage under their own variable names get no binding

**Stage** ENV_BINDING_ERROR (predicted; Wave 1 measures it) · **Root
cause** DEPLOYZ_BUG · **Resolution** FIXED for `process.env` reads (PR #212
merged and deployed 2026-09-07; kutt rerun 6 connected to RDS through
`DB_HOST`); a second shape measured on directus is FIX IN REVIEW (analysis
version 17, see "Directus" below) · **Found** Phase 2 gate audit,
from the manifest facts the deployment would act on.

**Behaviour.** The deployment injects the managed database under
`DATABASE_URL` + `DATABASE_HOST/PORT/NAME/USER/PASSWORD` and the bucket
under `AWS_S3_BUCKET`, plus whatever names the manifest's `envBindings`
add (Stage A phase 2, applied post-install by
`packages/relay/src/binding-alias.ts`). In the gate audit the manifests of
the Wave 1 repositories that read the database under their own names carry
only the standard names: repo-003 kutt (`DB_HOST`, `DB_PORT`, `DB_NAME`,
`DB_USER`, `DB_PASSWORD`), repo-021 directus (`DB_HOST`, …,
`DB_DATABASE`), repo-035 ihatemoney (`SQLALCHEMY_DATABASE_URI`), repo-039
memos (`MEMOS_DSN`); only ghostfolio's `POSTGRES_*` and outline's
`AWS_S3_UPLOAD_BUCKET_NAME` were picked up. Wave 1 evidence: ihatemoney
PASSED with its database bound (run
`stage-b-repo-035-20260906-125614-c00c`, dependencies `postgres: PASS`),
so the deployed v15 analysis does deliver `SQLALCHEMY_DATABASE_URI`; the
prediction stands only for the names still unbound in the gate audit. There is no vendor surface to
add a binding (the configuration screen stores literal values, and the
bucket name and database address exist only after the install), so the
application boots without a database.

**Effect.** For such an application the first task cannot connect
(`DATABASE_ERROR` / `ENV_BINDING_ERROR`); the install fails on the health
check or the app runs on a default engine (SQLite) that is not durable.

**Generic fix candidates.** (a) Analyser: read the app's own connection
variable names where the Stage A notes show them (env samples, settings
modules, `os.Getenv`/`viper` reads) — the phase-2 alias detection widened
to non-Node shapes; (b) product: let the vendor map a provisioned value to
a variable name on the configuration screen (`DEPLOYZ_DATABASE_URL`
placeholders resolved by the relay at install), which needs no analyser
signal. Decision after Wave 1 evidence.

**Directus (repo-021, attempt 1, 2026-09-07).** The whole product chain
held (zero-task INSTALL, CONFIG_UPDATE, the release scaled up) and the
configured task exited 1 three times on `"DB_HOST" Environment Variable is
missing` — CONTAINER_START_FAILED through DEPLOY-011's crash-loop rule.
The manifest bound only the standard `DATABASE_*` names: the analyser's
env-var model held two variables for the whole repository (`GITHUB_OUTPUT`,
`NODE_ENV`), although it had fetched `api/src/database/index.ts`, which
reads `env['DB_HOST']`, `env['DB_CLIENT']`, `env['DB_DATABASE']` … through
`const env = useEnv()` (`@directus/env`). Every JS/TS read recogniser keyed
on `process.env`; a module that reads its configuration through a local
`env` object contributed nothing — so no `DB_*` alias, and the app's
internal secrets `KEY`/`SECRET` were neither modelled nor minted
(`unboundSecretKeys: [ADMIN_PASSWORD, KEY, SECRET]`; directus booted with a
random `SECRET`, which would rotate tokens on every restart). Generic fix
(analysis version 17): in a JS/TS module that binds `env` (`const env =
…`, `import env from`, `= useEnv(`), `env.X` and `env['X']` count as reads
for the env-var detector, the env-var model (with the same fallback/guard
rules as `process.env` reads) and the Postgres connection evidence;
`import.meta.env.VITE_X` in a module without such a binding still does not.
Regression tests in `analysis.test.ts`, `phase7.test.ts` and
`stage-b-phase2.test.ts` (the directus shape yields the five `DB_*`
aliases). Also observed on the same run: a task of the template revision
booted next to the configured revision for about five minutes (on SQLite,
directus's default driver) before the rollout replaced it — the
unconfigured start DEPLOY-009 exists to prevent, recorded as an
observation for the relay's scale-up ordering.

**Memos (repo-039, attempt 1, 2026-09-08).** Go, `cmd/memos/main.go`:
`viper.SetEnvPrefix("memos")`, `viper.SetEnvKeyReplacer("-" → "_")`,
`viper.AutomaticEnv()`, then `viper.GetString("dsn")` /
`rootCmd.Flags().String("dsn", …)`. The variable the app reads is
`MEMOS_DSN`, a name that exists nowhere as a literal, so the env-var model
held one variable for the repository (`SKIP_CONTAINER_TESTS`, from a
test helper) and the manifest bound only `DATABASE_*`. With the vendor's
`MEMOS_DRIVER=postgres` and no DSN, memos dialled its default
`127.0.0.1:5432` and exited — four times, then the circuit breaker rolled
the service back (see DEPLOY-015). Generic fix (analysis version 18): a Go
module that calls `viper.SetEnvPrefix("<p>")` with `AutomaticEnv()`
contributes `<P>_<KEY>` for every `viper.Get*("<key>")`,
`viper.SetDefault("<key>", …)` and `Flags().<Type>("<key>", …)` it names
(`-` → `_` when a key replacer is set), so `MEMOS_DSN` reaches the model
and the existing `*_DSN` url alias binds it (PR #226, merged 2026-09-08).

## DEPLOY-006 — The generic template's container health check needs a shell and curl inside the image

**Stage** HEALTH_PATH_ERROR (the container runs, its health check never
passes) · **Root cause** DEPLOYZ_BUG · **Resolution** FIXED (pending
deploy) · **Found** Wave 1, repo-008 gatus (2026-09-06).

**Behaviour.** The generic application template's ECS container health
check ran `CMD-SHELL curl -f http://localhost:<port><healthCheckPath> ||
exit 1` inside the App container regardless of what the image actually
ships. repo-008 (TwiN/gatus) is built `FROM scratch` — no shell, no
`curl` — so every task exited 0 (the application itself ran fine) but ECS
reported "Task failed container health checks" before an ALB target was
ever registered; four consecutive tasks failed the same way, the
deployment circuit breaker fired, and CloudFormation rolled the install
back. The Documenso preset
(`packages/cdk/src/application/documenso.ts`) already had to override the
command with a `node -e "fetch(...)"` probe because its image has node
but no curl — the same defect, worked around per-preset rather than fixed.

**Effect.** Every image without `/bin/sh` and `curl` (distroless, scratch,
most Go/Rust images, slim Node images) fails its first install regardless
of the application's own health.

**Fix.** The container-level health check is defined only when a preset
supplies an explicit command; the generic template relies on the ALB
target group's probe of the health path, which is what promotes the
deployment anyway. Files: `packages/cdk/src/application/application-stack.ts`,
the regenerated artifacts, `packages/cdk/test/application-stack.test.ts`.

---

## DEPLOY-007 — The issued `DATABASE_URL` makes node-postgres verify the RDS certificate against a trust store that does not hold it

**Stage** DATABASE_ERROR (the migration one-off or the first task cannot
open its TLS connection to RDS) · **Root cause** DEPLOYZ_BUG ·
**Resolution** FIXED — the product owner chose option A on 2026-09-07;
PR #213 merged (main `67e3da2`), application templates republished the
same day (no API or bootstrap change); kutt and umami reruns verify it · **Found** Phase 3, Wave 1, umami
attempt 3 (2026-09-06); confirmed on kutt attempt 6 (2026-09-07).

**Withdrawn on 2026-09-06 after kutt attempt 1, reinstated on 2026-09-07
after kutt attempt 6.** Attempt 1's "10 migrations" ran while no vendor
configuration reached the task (DEPLOY-009): kutt's `DB_CLIENT` default is
its bundled SQLite driver, so the migrations succeeded against a local
SQLite file, not RDS, and the withdrawal inferred a TLS success that never
happened. Attempt 6 — the first with the configuration delivered
(DEPLOY-009/010/012/013) and the `DB_*` bindings injected (DEPLOY-005) —
ran the migration one-off against RDS with `DB_SSL=true` and exited on
`Error: self-signed certificate in certificate chain` at
`TLSSocket.onConnectSecure` (run `stage-b-repo-003-20260907-092338-e5d9`,
task log captured by the watcher). That is exactly the mechanism below:
node-postgres verifies the RDS chain against Node's trust store, which
does not hold the RDS CA. The product owner chose option A; PR #213
merged while ghostfolio was building, and ghostfolio's pinned template
already carried the init container (the harness publishes from the
worktree's built `dist`, which held the fix), so ghostfolio was the first
deploy on it — and met DEPLOY-014.

**Behaviour.** The application template issues the customer application's
`DATABASE_URL` as
`postgresql://…@<rds endpoint>:5432/deployz?sslmode=require`
(`packages/cdk/src/application/application-stack.ts`, `DatabaseUrlSecret`)
against an RDS instance on the default parameter group (`rds.force_ssl=1`,
PostgreSQL 16). libpq clients (Rails `pg`, psycopg, Go `lib/pq`/`pgx`) and
Prisma's own engine treat `sslmode=require` as "encrypt, do not verify the
chain", so they connect. node-postgres (`pg`, used directly or through
knex, Sequelize, drizzle, Prisma's `@prisma/adapter-pg`) treats
`prefer`/`require`/`verify-ca` as aliases of `verify-full` unless
`uselibpqcompat=true` is also present (`pg-connection-string`,
`deprecatedSslModeWarning`), and the RDS CA chain is not in Node's default
trust store, so the TLS handshake is rejected and the client never
connects. The control plane's own Lambda already works around exactly this
(`packages/cdk/src/lambda/db-connection.ts`: "uses sslmode=require with
uselibpqcompat=true because RDS has rds.force_ssl=1 and pg v9 treats
sslmode=require as verify-full"); the URL handed to customer applications
does not, and `uselibpqcompat` is a node-postgres-only parameter that libpq
rejects, so it cannot simply be appended for everyone.

**Effect.** Every Node application whose Postgres client is node-postgres
and that exposes no `rejectUnauthorized`/CA knob fails its first task at
boot, the ECS deployment circuit breaker rolls the install back, and the
product reports CONTAINER_START_FAILED with no application log (DEPLOY-006's
rollback also deletes the log group). Applications with a knob need the
vendor to know about the RDS CA (directus: `DB_SSL__REJECT_UNAUTHORIZED=false`;
outline hard-codes `rejectUnauthorized: false`); umami (`check-db.js`,
`new PrismaPg({ connectionString })`) and kutt (`knexfile.js`,
`ssl: env.DB_SSL`) have none.

**Evidence.** umami attempt 3 (run `stage-b-repo-001-20260906-085224-5c2f`):
build READY, template published, Quick Create + enrolment PASS; the ECS
service never stabilised ("ECS Deployment Circuit Breaker was triggered"
on `ServiceD69D759B`), three consecutive tasks ran about five minutes and
exited with code 1 (`EssentialContainerExited`, observed by an external
watcher — the harness's post-failure fetch ran after the rollback had
deleted the cluster and the log group, fixed in PR #204). The retained
RDS instance carries `rds.force_ssl=1` (parameter group
`default.postgres16`) and the retained `DatabaseUrlSecret` ends in
`?sslmode=require`. Documenso passes on the same URL because Prisma's
engine does not verify the chain for `require`. The umami log line and the
kutt attempt will close the evidence.

**Generic fix (option A chosen; PR #213).**
(A) Keep TLS everywhere and make the chain verifiable: the task definition
gets a non-essential init container (`RdsCaBundle`, Amazon Linux 2023
minimal) that fetches the regional RDS trust bundle
(`https://truststore.pki.rds.amazonaws.com/<region>/<region>-bundle.pem`)
into a task-scoped volume and completes before the application starts;
the App (and Worker) container depends on it, mounts the volume read-only
and receives `NODE_EXTRA_CA_CERTS` and `PGSSLROOTCERT` pointing at the
bundle. `SSL_CERT_FILE` is deliberately not set: it replaces the system
roots instead of adding to them. The fetch is best effort — a failure logs
one line and the application starts exactly as before — and the init
container carries no environment, so the relay's application-container
heuristics keep resolving the App container. Nothing is added when the
application has no database. Every client then verifies successfully; no
knob needed. Cost: one more container definition, a volume, an egress
fetch at task start (the NAT gateway already exists). Regression tests:
four cases in `packages/cdk/test/application-stack.test.ts`.
(B) Stop forcing TLS inside the VPC: a custom parameter group with
`rds.force_ssl=0` and a `DATABASE_URL` without `sslmode` — libpq clients
default to `prefer` (TLS, unverified), node-postgres to plaintext on the
private subnet. Zero per-app configuration, but a change of the product's
encryption-in-transit posture. Rejected: it changes the
product's encryption-in-transit posture. After PR #213 merges the
templates are republished and umami and kutt are rerun.

**Affected.** repo-003 (kutt, measured on attempt 6); repo-001 (umami,
the same shape — five silent exits — still to be confirmed by its log
line); every Wave 2+ Node application on node-postgres without a
verification knob. Not affected: gatus (no database), docuseal, miniflux,
ihatemoney, memos (libpq / Go clients), ghostfolio (Prisma engine).

---

## DEPLOY-008 — An analysis run forgets the vendor's manifest overrides

**Stage** BUILD_ERROR · **Root cause** DEPLOYZ_BUG · **Resolution** FIXED
(pending deploy; PR #206) · **Found** Phase 3, Wave 1, miniflux attempt 1
(2026-09-06).

**Behaviour.** `PATCH /api/applications/:id` stores the manifest-only
overrides (`appRoot`, `dockerfilePath`, `buildContext`, `buildCommand`,
`startCommand`) on `detected_metadata.manifestOverrides` because they have
no column (`apps/api/src/server.ts`, `MANIFEST_OVERRIDE_FIELDS`). The
analysis write replaces `detected_metadata` wholesale and carried only
`vendorOverrides` forward (`apps/api/src/analysis.ts`, "this record is
replaced wholesale each run"), so the next analysis run — the first one
after creation, a re-analysis, a push-triggered run — dropped every
manifest override. The build worker then fell back to its defaults
(`packages/cdk/src/lambda/worker.ts`, `resolveBuildContext`: the
Dockerfile's directory unless it is `docker/`).

**Effect.** A repository whose Dockerfile lives outside the root and copies
the repository root (miniflux, memos, every `packaging/`- or
`deploy/`-style layout) builds from the wrong context and fails; a vendor
who corrected the Dockerfile path, start command or app root loses the
correction silently.

**Evidence.** miniflux (run `stage-b-repo-004-20260906-125413-d80a`): the
ledger's step 1 records the PATCH (`dockerfilePath:
packaging/docker/alpine/Dockerfile`, `buildContext: "."`), analysis
COMPLETE / READY; the release recorded `buildContext: null`; CodeBuild
`2c59b4c0…` logged `Building … from packaging/docker/alpine/Dockerfile
(context: packaging/docker/alpine)` and `make: *** No rule to make target
'miniflux'` (no Makefile in that directory; `ADD . /go/src/app` copied the
Dockerfile's directory).

**Fix.** `manifestOverrides` rides the analysis write the way
`vendorOverrides` does; regression test in `apps/api/src/analysis.test.ts`.
Product-side only; no template change, so no republish.

**Affected.** repo-004 (miniflux); predicted repo-039 (memos, the same
override shape); every override-dependent repository in later waves.
Rerun miniflux after `deploy-api.yml`.

---

## DEPLOY-009 — Vendor configuration and generated secrets reach the task only after a successful INSTALL, so an application that needs them to boot never installs

**Stage** ENV_BINDING_ERROR (the first task exits at boot on a missing
vendor value) · **Root cause** DEPLOYZ_BUG · **Resolution** FIXED (PR #207
merged, deployed and templates republished 2026-09-06; verified on kutt
attempts 2–6) — the product owner chose the generic fix; PR #207 implements the
configured first start designed below (template `param_DesiredCount`,
API `startAfterConfig` + `hasStartedInstall` + config-before-deploy
ordering, relay scale-up/scale-back); the wave was stopped under the
systemic-bug rule and resumes after merge, deploy and template republish ·
**Found** Phase 3, Wave 1, kutt attempt 1 (2026-09-06).

**Behaviour.** A fresh install runs the template's task definition, which
carries the managed bindings (database, cache, storage, port) and nothing
the vendor configured (`apps/api/src/install-config.ts`: "A fresh install
runs the template's task definition: it carries the managed bindings … and
nothing the vendor configured"). The Configuration screen's values and the
Deployz-generated secrets are applied by one post-install `CONFIG_UPDATE`
job, queued only when the INSTALL job has succeeded
(`queuePostInstallConfig`); the relay then writes the secrets into
`AppConfigSecret`, registers a new task-definition revision and updates the
service (`packages/relay/src/config-update.ts`). INSTALL succeeds only when
CloudFormation sees the ECS service stable, and the service is created with
`desiredCount: 1` and a circuit breaker that rolls back
(`packages/cdk/src/application/application-stack.ts`). An application that
refuses to start without a vendor value or a generated secret therefore
exits on every task of the first deployment, the circuit breaker rolls the
stack back, INSTALL fails, and the configuration that would have fixed it
is never applied.

**Effect.** Every application whose boot validates its configuration —
`JWT_SECRET` (kutt), `ACCESS_TOKEN_SALT` / `JWT_SECRET_KEY` (ghostfolio,
NestJS), `KEY` / `SECRET` / `DB_CLIENT` (directus), `SECRET_KEY` /
`UTILS_SECRET` / `URL` (outline) — cannot be installed through the product
at all, whatever the vendor types beforehand. Applications that tolerate a
missing value boot with defaults (memos: SQLite instead of the provisioned
PostgreSQL until the post-install pass; ihatemoney: a generated Flask
secret) and are only configured after the first task, which is what the
watch list ("generated secrets reaching the task before the first
request") anticipated.

**Evidence.** kutt (run `stage-b-repo-003-20260906-145904-4452`): the
harness stored `JWT_SECRET` as a vendor secret before the install
(ledger step 2, `keys: [ADMIN_EMAILS, DB_CLIENT, DB_SSL, JWT_SECRET]`);
the INSTALL payload carries `manifest`, `parameters`
(`paramImageReference`, `paramHealthCheckPath`, preset parameters) and
`redisRequired` — no configuration; the first task's log (kept by the
PR #204 snapshot): `knex migrate:latest` → `Batch 1 run: 10 migrations`
(database reachable, TLS fine), then `node server/server.js --production`
→ `Missing environment variables: JWT_SECRET: undefined` → `Exiting with
error code 1`, five times; ECS circuit breaker → ROLLBACK_FAILED (the
retained RDS ENI, as in DEPLOY-007's record); product code
`CONTAINER_START_FAILED`. Nothing in the deployment's events between
`install.requested` and `install.failed` mentions configuration.

**Generic fix (designed; needs a product decision).** Make the first
start a configured start:
1. The application template takes a `param_DesiredCount` (default `1`,
   so published templates and Documenso installs are unchanged).
2. The control plane's INSTALL payload says whether anything must be
   applied before the first task (`buildRelayConfigEntries` non-empty:
   any vendor/customer value or generated key); when it must, the relay
   creates the stack with `param_DesiredCount=0`, so CREATE_COMPLETE does
   not depend on an unconfigured task.
3. The existing post-install `CONFIG_UPDATE` (secrets into
   `AppConfigSecret`, new task-definition revision) then sets the service's
   desired count to the template's count and waits for the deployment to
   stabilise — the same ECS wait DEPLOY_RELEASE already performs — and the
   deployment becomes HEALTHY on that job, not on INSTALL.
4. The failed-first-install semantics in `docs/deployment-resilience.md`
   move with it: a first start that never stabilises marks the deployment
   FAILED as a failed install does today (today a failed CONFIG_UPDATE
   "never touches deployment state", which is right for a running app and
   wrong for the first start).
Regression tests: template snapshot (parameter, default unchanged), relay
install (passes 0 when told), config executor (scales up and waits), API
state machine (HEALTHY after the first configured start; FAILED when it
never stabilises), and the simulated E2E scenario for a boot-time secret.
Templates republished after the CDK/relay change. Alternative the product
may choose instead: declare configuration-at-boot outside the MVP and
record kutt, ghostfolio, directus and outline as MVP_CAPABILITY_GAP.

**Affected.** repo-003 (kutt) measured; predicted repo-007, repo-021,
repo-016 (crash at boot) and repo-039 (boots against SQLite until the
post-install pass — a false PASS unless the dependency check catches it);
every later-wave application with required vendor or generated
configuration.

---

## DEPLOY-010 — CONFIG_UPDATE never finds the application stack's config secret

**Stage** ENV_BINDING_ERROR · **Root cause** DEPLOYZ_BUG · **Resolution**
FIXED (PR #208 merged, main `f4ecd39`) · **Found** Phase 3, Wave 1, kutt rerun 2
(2026-09-06), the first configured first start after DEPLOY-009's fix.

**Behaviour.** The relay's CONFIG_UPDATE executor writes secret values into
the application stack's `AppConfigSecret`, located by logical id with an
exact match (`packages/relay/src/config-update.ts`, `findAppConfigSecretArn`:
`resource.logicalId === 'AppConfigSecret'`). CloudFormation reports a CDK
L2 construct's logical id with a hash suffix — every application stack has
`AppConfigSecret251CAC1E` — so the lookup never matched, and every config
pass that had a secret to write failed with "Stack … has no
AppConfigSecret to write config secrets into". The test fixture used the
bare id, so the unit tests passed. Documenso has no vendor or generated
key and never queues a config job, which is why production never saw it.

**Effect.** No vendor secret has ever reached a task through
CONFIG_UPDATE; with DEPLOY-009's configured first start the failure moved
from "task never configured" to "config pass fails, deploy starts the task
unconfigured".

**Evidence.** kutt (run `stage-b-repo-003-20260906-184251-c686`,
deployment `ed8eda54-…`): INSTALL SUCCEEDED with `paramDesiredCount=0`
(stack `deployz-app-49b7198e`, parameter confirmed via
`describe-stacks`); CONFIG_UPDATE FAILED at 19:00:31Z with exactly that
message; DEPLOY_RELEASE requested 19:00:31Z; the umami/kutt stack
inventories list `AppConfigSecret251CAC1E`.

**Fix.** Match the construct-id prefix (`logicalId.startsWith('AppConfigSecret')`;
the other secrets are `DatabaseSecret…` / `DatabaseUrlSecret…`); the test
fixture carries the real hashed id and a direct test covers the prefix and
the negative case. Relay only: republish the bootstrap template.

**Affected.** Every application with a vendor or generated secret;
kutt, ghostfolio, directus, outline in Wave 1.

---

## DEPLOY-011 — A rollout whose tasks start and then exit is never settled

**Stage** CONTAINER_START_ERROR · **Root cause** DEPLOYZ_BUG · **Resolution**
FIXED (PR #209 merged, main `a8453c9`; the design below) · **Found** Phase 3, Wave 1, kutt rerun 2 (2026-09-06).

**Behaviour.** The deploy executor settles a rollout on three signals:
the circuit breaker's `rolloutState: FAILED`, or `runningCount >=
desiredCount` + `rolloutState: COMPLETED` + healthy targets + the new
digest running (`packages/relay/src/deploy.ts`, `settleEcsDeploy`).
ECS's circuit breaker counts a task as failed only when it never reaches
RUNNING or fails a health check; a task that reaches RUNNING, runs for a
minute (kutt: `npm run migrate`) and then exits is a restart, not a
failure. Such a service never reaches COMPLETED and never FAILS, so the
deploy stays `in-progress` on every resume; the watchdog re-offers it at
the runtime bound (`operation.requeued`, twice in 80 minutes) and would
fail it only at the 24-hour grace.

**Effect.** An application that boots and then dies (a wrong
configuration value, a migration that fails after connecting, a missing
secret the app checks late) leaves the deployment INSTALLING/UPDATING
with a crash-looping service for a day, no failure code, no diagnostics,
and the harness's install wait times out; Disconnect is refused while the
job is active.

**Evidence.** kutt rerun 2: DEPLOY_RELEASE `RUNNING` from 19:00:31Z, still
running at 20:32Z after two re-offers; heartbeat health alternating
`application: HEALTHY / UNHEALTHY` (the task alive for its migration
minute, then gone); the harness's Disconnect got `409 Another deployment
operation is already in progress`.

**Generic fix (designed).** In `settleEcsDeploy`, count the service's
stopped tasks since the command started whose container exited non-zero
(ECS `describe-tasks` on `list-tasks --desired-status STOPPED`); at a
bounded number (3, the same threshold the Stage B harness uses) settle
the deploy as FAILED with `CONTAINER_START_FAILED` and, for a configured
first start, scale the service back to zero. The control plane's
classifier then refines from the stopped reason and the app log tail the
relay reports. Regression tests in `deploy.test.ts`; relay only, so a
bootstrap republish.

**Affected.** Every deploy of an application that exits after starting;
kutt rerun 2 measured. Verified on kutt rerun 3 (2026-09-07): the deploy
settled `CONTAINER_START_FAILED` after 12 minutes with "4 tasks of the new
revision exited with code 1", the deployment went FAILED and Disconnect
was accepted at once.

---

## DEPLOY-012 — The relay role cannot read or write the application's config secret

**Stage** ENV_BINDING_ERROR · **Root cause** DEPLOYZ_BUG · **Resolution**
FIX IN REVIEW (PR #210) · **Found** Phase 3, Wave 1, kutt rerun 3
(2026-09-07), the first config pass that found its secret.

**Behaviour.** CONFIG_UPDATE reads the application stack's `AppConfigSecret`,
merges the vendor/customer values and the secrets it mints, writes it back
and binds the keys on the task definition. The only
`secretsmanager:GetSecretValue`/`PutSecretValue` grant on
installation-tagged secrets was `ProvisionApplicationManage`
(`packages/cdk/src/bootstrap/bootstrap-stack.ts`), attached to the
CloudFormation **execution** role; the relay Lambda's own role had
Get/Put only on its credential secret (phase 1) and tag-scoped
`DeleteSecret` (purge). DEPLOY-010 masked this: the lookup never found the
secret, so the call was never made.

**Effect.** The same as DEPLOY-010: no vendor secret reaches a task through
CONFIG_UPDATE, and the configured first start (DEPLOY-009) starts the task
unconfigured.

**Evidence.** kutt rerun 3 (run `stage-b-repo-003-20260907-031305-7de2`):
INSTALL SUCCEEDED (zero tasks); CONFIG_UPDATE FAILED at 03:31:09Z with
`AccessDeniedException: … RelayRole… is not authorized to perform:
secretsmanager:GetSecretValue on resource: …:secret:AppConfigSecret251CAC1E-…
because no identity-based policy allows the action`; the secret carries
`deployz:installation=af544f9d-…`; DEPLOY_RELEASE then failed
CONTAINER_START_FAILED (DEPLOY-011 working) with the task's log showing
`Missing environment variables: JWT_SECRET`.

**Fix.** The relay's tag-scoped installation-secret statement
(`RelayInstallationSecrets`, formerly `RelayPurgeSecretsDelete`) carries
`GetSecretValue` and `PutSecretValue` beside `DeleteSecret`, under the
same `aws:ResourceTag/deployz:installation` condition; one statement,
because a separate one pushed the provisioner policy over IAM's
6,144-character cap (the size test caught it). Bootstrap artifact and
snapshot regenerated; bootstrap republish after merge.

**Affected.** Every application with a vendor or generated secret; kutt,
ghostfolio, directus, outline in Wave 1.

---

## DEPLOY-013 — A vendor-scope secret typed before an install never reaches it, and is not minted either

**Stage** ENV_BINDING_ERROR · **Root cause** DEPLOYZ_BUG · **Resolution**
FIX IN REVIEW (PR #211) · **Found** Phase 3, Wave 1, kutt rerun 4
(2026-09-07), the first config pass that both found its secret and was
allowed to read it.

**Behaviour.** Secret values are write-only (§31, `apps/api/src/config.ts`):
the control plane keeps a mask, and the value travels once, in the
CONFIG_UPDATE fan-out to the deployments whose relay is connected when it
is saved. A vendor-scope secret typed on the Configuration screen before
any install therefore never reaches a deployment installed later: the
post-install config pass carries no values, the relay finds nothing in
the customer's store and reports the key as `unboundSecretKeys` (by
design, "binding a missing key would stop every task from starting").
And because the key counts as configured, `buildRelayConfigEntries` did
not flag it for minting, so the relay's ability to generate app-internal
secrets never applied. The analyser side compounds it: kutt's `JWT_SECRET`
(`str({ devDefault: "securekey" })`, required in production) is classified
`optional` with `purpose: internal_secret`, not `deployz_generated`.

**Effect.** The configured first start (DEPLOY-009, -010, -012 fixed)
still starts the task without its secret: kutt's migration one-off and
its first task exit on `Missing environment variables: JWT_SECRET`. Every
Wave 1 application whose deploy-config lists a vendor secret (kutt,
docuseal, ghostfolio, directus, outline, ihatemoney — ihatemoney passed
because Flask generates a session key) is affected; in production every
vendor who types a secret before a customer installs is.

**Evidence.** kutt rerun 4 (run `stage-b-repo-003-20260907-052126-9fc3`,
stack `deployz-app-ed02a75b`): INSTALL SUCCEEDED (zero tasks),
CONFIG_UPDATE SUCCEEDED at 05:41:31Z with `generatedKeys: []`,
`unboundSecretKeys: ["JWT_SECRET"]`, DEPLOY_RELEASE FAILED
`MIGRATION_FAILED` ("exit code 1, EssentialContainerExited" — the
migration script requires `server/env.js`, which validates `JWT_SECRET`);
the deployment's manifest lists `JWT_SECRET` as `secret: true, purpose:
internal_secret, classification: optional`.

**Fix.** `buildRelayConfigEntries` marks an entry `generated: true` when
the manifest classifies the key `deployz_generated` or the variable is a
secret with `purpose: internal_secret`, whether or not the vendor typed
one; the relay keeps any value already in the customer's store, so a
delivered vendor value always wins and an absent one is minted. External
credentials and customer-required keys are never minted. API only;
`deploy-api.yml` deploys it. The remaining product question — whether
vendor-scope secret values should be stored (encrypted) so a vendor's own
value survives to later installs — goes to the final report.

**Affected.** kutt measured; every application with a vendor-typed
app-internal secret.

---

## DEPLOY-014 — The relay reads the running image and the migration exit code from the first container of a task

**Stage** TIMEOUT (the deploy never settles; the deployment is HEALTHY and
serving while its `DEPLOY_RELEASE` job stays RUNNING) · **Root cause**
DEPLOYZ_BUG — a regression the DEPLOY-007 fix exposed · **Resolution** FIXED
(PR #217 merged, main `a05c37e`; bootstrap template republished 2026-09-07,
URL unchanged so no API deploy; verified on ghostfolio attempt 2, where the
release pointer settled 12 minutes after INSTALL) · **Found** Phase 3, Wave 1, ghostfolio attempt 1
(2026-09-07), the first deploy on the PR #213 template.

**Behaviour.** The relay identifies the application container by position
in three places: the running-digest observation that settles a deploy
(`packages/relay/src/deploy.ts`, `observeRunningDigest`: the first
container with an image digest), the heartbeat's `runningImageDigest`
(`packages/relay/src/ecs-observe.ts`, the same rule) and the migration
one-off's verdict (`settleMigration`: the first container with an exit
code). Since PR #213 every database-backed task lists the `RdsCaBundle`
init container before the application, so the observed digest is the
Amazon Linux image's. The settle gate `runningDigest === request.imageDigest`
never passes; the relay re-issues the service update against the same
revision and defers again on every poll ("command-still-pending" every
five minutes, the control plane re-dispatching the command about every 45
minutes). A failed migration would have been read as exit 0 from the init
container.

**Effect.** The application installs, scales up and serves — ghostfolio
answered its health path with 200 and the control plane showed HEALTHY /
READY — but `currentReleaseId` stays null, the `DEPLOY_RELEASE` job stays
RUNNING, Disconnect is refused with `409 Another deployment operation is
already in progress`, and the Stage B harness times out on the release
pointer, cannot Disconnect, cannot remove the connector and reports a
failed cleanup (55 resources left). Every database-backed application on
the #213 template would meet it on its first deploy.

**Evidence.** run `stage-b-repo-007-20260907-111857-c854`: INSTALL
SUCCEEDED 11:41Z, CONFIG_UPDATE SUCCEEDED (minted `ACCESS_TOKEN_SALT`,
`JWT_SECRET_KEY`), the migration one-off (`npx prisma migrate deploy`, 125
migrations) exited 0 at 11:42Z with `RdsCaBundle` exit 0 listed first,
the service reached steady state at 11:44Z; relay log
`relay:command-deferred` → `relay:command-still-pending` ×16 →
`relay:command-executed` again at 12:18Z and 13:03Z; the control plane's
`runningImageDigest` was `sha256:279612ae…` — the digest of
`public.ecr.aws/amazonlinux/amazonlinux:2023-minimal` — while the release
is `sha256:f4f450ec…`; `describe-tasks` listed `RdsCaBundle` (STOPPED,
that digest) before `App` (RUNNING, the release digest).

**Generic fix (PR #217).** The application is the task's essential
container. `ecs-observe.ts` gains `essentialContainerNames` (from a task
definition; ECS defaults `essential` to true, init containers and sidecars
declare false) and `applicationContainers` (a task's containers that are
essential; an unnamed container still counts, a definition that names
none keeps the old behaviour). The deploy settle describes the service's
task definition first and reads the running digest from the essential
containers; the migration poll reads the exit code the same way; the
heartbeat observation describes each running task's definition (cached
per ARN) before reading. The real ECS clients pass container names, the
task-definition ARN and a `describeTaskDefinition` for the task reader
(the relay role already holds the permission). The Stage B harness's
`describeRunningService` counts only the containers still RUNNING in a
running task. Regression tests: `ecs-observe.test.ts` (digest past an
init container listed first), `deploy.test.ts` (running digest and
migration exit code past a non-essential init container). Bootstrap
republish after merge (relay change).

**Operator recovery for the stuck environment.** The installed relay is
the old code, so the job never fails on its own: the service was scaled to
0 and the application stack deleted by hand; the relay's next poll finds
no ECS service, fails the job, and `--cleanup --repo repo-007` closes the
ledger through the product (Purge, connector removal, leak audit). The
hand-deleted stack ends DELETE_FAILED on the target group the product's
default-HTTPS listener still held (the product's own Disconnect removes
the listener first, so this shape needs the out-of-band delete): the
product's Disconnect and Purge then leave that one target group behind,
deleted by ARN before the cleanup rerun — the same leftover as kutt
attempt 2's recovery.

**Affected.** repo-007 (ghostfolio, measured); every database-backed
application deployed on the PR #213 template until the relay republish —
kutt, umami, directus, memos, outline and every Wave 2+ repository with a
database.

---

## DEPLOY-015 — A first start the circuit breaker rolls back to the unconfigured template revision is reported as a successful deploy

**Stage** APPLICATION_ERROR — a false success: the product shows HEALTHY and
`DEPLOY_RELEASE: SUCCEEDED` while the application runs unconfigured ·
**Root cause** DEPLOYZ_BUG · **Resolution** FIXED (PR #225 merged, main `4de29dd`; bootstrap republish pending) · **Found**
Phase 3, Wave 1, memos attempt 1 (2026-09-08).

**Behaviour.** A configured first start (DEPLOY-009) scales the service
from zero with the CONFIG_UPDATE revision. When that revision's tasks exit
at boot, ECS's deployment circuit breaker rolls the service back to the
previous deployment — the template revision, which the pinned template
runs on the same image digest — and that revision, unconfigured, comes up
healthy on its defaults (memos and directus boot on SQLite). The relay's
success gate (`packages/relay/src/deploy.ts`, `settleEcsDeploy`) compares
the running digest with the release digest, requires a stable service, a
PRIMARY deployment in `COMPLETED` and healthy targets: all four hold on
the rolled-back service. `rolloutFailed` only sees the failed deployment
while ECS still lists it, and DEPLOY-011's crash count keys on
`service.taskDefinition`, which after the rollback is the old revision,
so the configured revision's exits are no longer counted.

**Effect.** memos: `DEPLOY_RELEASE` SUCCEEDED with `alreadyRunning: true`
at 00:30Z, `currentReleaseId` set, the deployment HEALTHY and serving over
default HTTPS — on SQLite, with the vendor's `MEMOS_DRIVER=postgres`
silently discarded. The harness's runtime, HTTPS and observation checks
passed against that task; only the observation window's crash count (four
non-zero exits) exposed it. A customer would see a healthy deployment
whose data lives in the container.

**Evidence.** run `stage-b-repo-039-20260907-234923-bbde`: CONFIG_UPDATE
SUCCEEDED 00:10:08Z; the template-revision task started 00:10:25Z
("Database driver: sqlite") and served; configured-revision tasks exited
`dial tcp 127.0.0.1:5432` at 00:10:34, 00:16:14, 00:22:07, 00:23:28Z; ECS
"Scaling activity initiated by (deployment …)" at 00:23:45Z and "reached a
steady state" on the previous deployment at 00:25:15Z; the relay's poll at
00:30Z reported success.

**Generic fix (in review).** The deploy remembers the revision it targets
(`registeredApplicationArn`, else the service's task definition when the
command starts) on the pending marker, and settles as a success only when
the service's PRIMARY deployment runs that revision; a PRIMARY deployment
on another revision after the deploy started means ECS rolled it back →
`ECS_DEPLOYMENT_FAILED` (a first start scales back to zero, as
DEPLOY-009). The crash-loop count (DEPLOY-011) is taken on the target
revision, not on whatever the service currently runs. Regression tests in
`packages/relay/src/deploy.test.ts`; bootstrap republish after merge.

**Affected.** repo-039 (memos, measured); directus attempt 1 would have
shown it too had its template revision passed the health check; every
configured first start whose configured revision fails at boot.

---

## DEPLOY-016 — A schema migration that fails on existing rows takes the whole API down, and warm containers keep the failure

**Stage** INFRA_ERROR (the control plane, not the deployment) · **Root
cause** DEPLOYZ_BUG · **Resolution** OPEN — production restored by hand;
the fix belongs to the billing workstream (task handed over) · **Found**
Phase 3, Wave 1, memos attempt 2 (2026-09-08), by the API answering 500 to
the harness's install wait.

**Behaviour.** `packages/db/drizzle/0036_one_active_test_deployment.sql`
(PR #228) creates a partial unique index on `deployments(application_id)
WHERE deployment_type = 'TEST' AND state <> 'DELETED'`. Production held
one application with three non-DELETED TEST deployments (all FAILED, from
the 2026-09-04 Documenso E2E), so the index failed with 23505. The API
Lambda runs migrations at init and caches the promise: every warm
container re-threw the rejected promise in 2 ms, and every request —
`/api/health` included — answered `500 {"message":"Internal Server
Error"}` from ~03:35Z until the data was corrected and the function's
configuration touched to recycle its execution environments (03:45Z).

**Effect.** api.deployz.dev down for about ten minutes; the deploy
workflow reported failure after the code was already live; memos attempt
2 lost its install wait, Disconnect and connector removal (the relay,
which only needs the control plane for polls, carried the install on).

**Fix (handed over).** The migration settles existing duplicates before
creating the index (or a rule the product owner prefers), with a test on
a table that already holds duplicates; the init-time migration must not
poison a warm container — retry on the next invocation and report the
failure on the health route instead of a generic 500.

**Affected.** every vendor and every relay poll during the window; the
Stage B harness run in flight.

