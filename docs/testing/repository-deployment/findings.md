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
| DEPLOY-005 | ENV_BINDING_ERROR | DEPLOYZ_BUG | OPEN | predicted from the gate audit for repo-003, repo-021, repo-035, repo-039 (and every app that reads its database under its own name); Wave 1 measures it |

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
`AWS_S3_UPLOAD_BUCKET_NAME` were picked up. There is no vendor surface to
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
