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
| DEPLOY-005 | ENV_BINDING_ERROR | DEPLOYZ_BUG | OPEN | predicted from the gate audit for repo-003, repo-021, repo-039 (and every app that reads its database under its own name); Wave 1 measures it — repo-035 ihatemoney PASSED (the v15 binding delivered `SQLALCHEMY_DATABASE_URI`) |
| DEPLOY-006 | HEALTH_PATH_ERROR | DEPLOYZ_BUG | FIXED (pending deploy) | repo-008 (gatus; every image without a shell + curl) |
| DEPLOY-007 | CONTAINER_START_ERROR / DATABASE_ERROR | DEPLOYZ_BUG | OPEN (fix proposed) | repo-001 (umami); predicted repo-003 (kutt); every node-postgres client without a `rejectUnauthorized` knob |
| DEPLOY-008 | BUILD_ERROR | DEPLOYZ_BUG | FIXED (pending deploy) | repo-004 (miniflux); predicted repo-039 (memos); every vendor override of the Dockerfile path, build context/command, start command or app root that an analysis run follows |

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
cause** DEPLOYZ_BUG · **Resolution** OPEN · **Found** Phase 2 gate audit,
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

**Stage** CONTAINER_START_ERROR (the container exits before the ALB probe
sees it; DATABASE_ERROR once the log line is captured) · **Root cause**
DEPLOYZ_BUG · **Resolution** OPEN (fix proposed, product decision needed) ·
**Found** Phase 3, Wave 1, umami attempt 3 (2026-09-06); mechanism
confirmed from product code.

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

**Generic fix (proposed; needs a product decision).**
(A) Keep TLS everywhere and make the chain verifiable: the task definition
gets an init container that writes the RDS trust bundle
(`https://truststore.pki.rds.amazonaws.com/<region>/<region>-bundle.pem`)
to a shared ephemeral volume and completes before the application starts;
the application container receives `NODE_EXTRA_CA_CERTS`, `PGSSLROOTCERT`
and `SSL_CERT_FILE` pointing at it. Every client then verifies
successfully; no knob needed. Cost: one more container definition, a
volume, an egress fetch at task start (the NAT gateway already exists).
(B) Stop forcing TLS inside the VPC: a custom parameter group with
`rds.force_ssl=0` and a `DATABASE_URL` without `sslmode` — libpq clients
default to `prefer` (TLS, unverified), node-postgres to plaintext on the
private subnet. Zero per-app configuration, but a change of the product's
encryption-in-transit posture. Either way a regression test in
`packages/cdk/test/application-stack.test.ts` pins the URL and the task
definition, the templates are republished, and umami and kutt are rerun.

**Affected.** repo-001 (umami); predicted repo-003 (kutt) from its
`knexfile.js`; every Wave 2+ Node application on node-postgres without a
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
