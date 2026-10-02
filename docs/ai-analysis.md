# AI application analysis, preflight and failure diagnosis

The reference for the P0/P1 AI capabilities of the Deployz MVP: how a
repository becomes a validated application model, how that model gates
deployment, and how a failed deployment is explained. The design decisions
behind the AI boundary are in `docs/decisions/README.md`.

## Operating principle

> **AI infers and explains. Deterministic Deployz systems provision and
> mutate AWS infrastructure.**

- The AI may inspect repository content, resolve ambiguous facts, classify
  and explain. It never calls AWS, never generates infrastructure, never
  changes deployment or job state, never flips a deterministic verdict or
  failure code, and never produces a secret value.
- Every AI output crosses a strict Zod schema before anything reads it. A
  malformed, oversized or missing answer degrades to the deterministic
  result — an analysis still completes, a diagnosis still shows copy-map
  text, a deployment never depends on the model being available.
- Repository files, sample env files and error text are untrusted data. The
  prompts say so; secret-looking values are redacted before they leave the
  process; raw application logs are never collected.

## The flow

```
Repository (GitHub tree, bounded)
  → analyseRepo: deterministic detectors + rejection checks
  → AI fallback ONLY for an unresolved question; merge is
    deterministic-always-wins
  → ApplicationAnalysis (canonical, typed, evidenced)
  → ReadinessReport (findings) · DeploymentManifest (contract)
  → Preflight gate at every path into provisioning
  → Deterministic engine: release build, INSTALL, DEPLOY_RELEASE, config
  → AWS (customer account, through the relay only)
  → Structured job results, CloudFormation events, heartbeats
  → refineFailureCode → DeploymentFailureContext
  → Copy-map explanation; AI explanation for the app-owned evidence-rich
    set (UNKNOWN + startup/config codes), with confidence
  → Vendor and customer UI (plain words; raw detail behind disclosures)
```

## Repository analysis

- **Orchestrator:** `runApplicationAnalysis` (`apps/api/src/analysis.ts`).
  Fetches a bounded file tree, runs `analyseRepo` (`packages/analysis/src/
  analyser.ts`), applies the AI fallback when needed, builds the readiness
  report and the canonical projection, backfills the contract fields the
  vendor has not edited, and persists everything in one write to
  `applications.detected_metadata`.
- **Commit cache:** a run is skipped when `analysisCommitSha` and
  `analysisVersion` match the stored ones. `ANALYSIS_VERSION` must be
  bumped whenever detector output or the projection changes shape, so
  stored rows re-run.
  Nothing re-runs a stale row by itself. `GET /api/applications/:id/readiness`
  returns `analysisOutdated` (the stored `analysisVersion` differs from
  `ANALYSIS_VERSION`), and the application header then shows a "Checks have
  been updated" notice with a Re-analyse action. The vendor starts the run.
- **Detectors** (`packages/analysis/src/detectors.ts`): Dockerfile,
  framework, port (six tiers), health endpoint, env vars, PostgreSQL
  (required vs present), MySQL (required vs present, with the engine
  choice recorded on the manifest; a MariaDB-only driver stays a
  rejection), local filesystem, declared worker processes, S3, migration
  command,
  start command, external services, package manager, build command,
  **runtime** (Dockerfile base image, then the shallowest manifest) and
  **bind address** (loopback-only servers). Redis is assessed separately
  with confidence and purpose. Rejections (`rejection.ts`) name the
  unsupported architectures.
- **Evidence scope:** a language package that a Dockerfile `RUN` installs
  (`pip install mysqlclient`) is a declared dependency, the same as a
  manifest entry. `package.json` build and start scripts and the package
  manager describe the app only when there is no Dockerfile, or when the
  selected Dockerfile builds or runs Node. A Python image does not get a
  sibling front end's `react-scripts build`. The Compose port comes from an
  application service, never from a database, cache or proxy service.
- **One relational database:** a required MySQL database gets the same
  bindings (the `DATABASE_*` names plus the names the app reads, such as
  `DB_HOST`), migration mode and migration findings as PostgreSQL.
  `databaseState` names the engine that the manifest provisions.
- **AI fallback** (`repository-ai.ts`): asked only when a real question is
  open (multiple Dockerfiles, monorepo target, unknown start/build command
  or port, unclear database or Redis requirement), with at most eight files
  / 24k characters of context, sample env files stripped to key names, and
  a strict output schema. `mergeAiAnalysis` lets the AI fill a gap, never
  overwrite; a required-database or Redis flip needs corroborating
  deterministic evidence.

## The canonical model

`ApplicationAnalysis` (`packages/contracts/src/application-analysis.ts`,
built by `buildApplicationAnalysis`): runtime, framework, build, start,
port and bind address as facts — `value`, `source` (dockerfile,
package-manifest, compose, env-file, procfile, source, ai, none),
`confidence` (confirmed, likely, needs_confirmation), `evidence[]` (one
line each, never file content) — plus database, redis, storage, health
check, migrations and the classified environment variables. It is stored as
`detected_metadata.application`, served as `detected` on
`GET /api/applications/:id/readiness`, and rendered as "What Deployz
detected". It explains; the manifest is the contract.

## Compatibility findings

`buildReadinessReport` (`readiness-report.ts`) produces findings with stable
ids, a `required` / `recommended` severity and a `blocking` flag:

| Spec severity | Deployz | Meaning |
|---|---|---|
| BLOCKER | `required` + `blocking` | NEEDS_CHANGES / NOT_COMPATIBLE — a code change is needed |
| WARNING | `required` | ALMOST_READY / NEEDS_ATTENTION — fixable configuration |
| RECOMMENDATION | `recommended` | never blocks READY |

Ids: `unsupported-database-*` (MySQL is a supported engine, so only the
still-unsupported engines land here — MariaDB-only setups, MongoDB,
SQLite, Elasticsearch/OpenSearch, Cassandra, Neo4j, ClickHouse, embedded
JVM databases), `unsupported-redis-setup`,
`unsupported-architecture`, `unsupported-message-queue`,
`unsupported-multi-service` (Compose application services beyond the web
service and declared workers), `unsupported-persistent-volume`,
`unsupported-gpu`, `local-file-storage`
(blocking); `container-setup`, `port-unresolved`, `start-command-missing`,
`health-check`, `localhost-binding`, `migration-command-needs-input`
(required); `database-migrations`,
`worker-command`, `worker-process` (recommended). For a Django project
(`manage.py` with `DJANGO_SETTINGS_MODULE`) whose image runs no migration,
`database-migrations` names `python <path>/manage.py migrate --noinput` as the
suggested migration command; the vendor sets it, Deployz never applies it.
A migration script is persisted only when the selected Dockerfile's
runtime stage, and the stages it is built `FROM`, provides its runner: a
bare ORM CLI gets `npx` only when that Node image also holds the CLI in
node_modules (installed there, or copied from a stage that installed it,
counting a production-only install for production dependencies only).
Dependencies alone never prove it, `bunx` is never substituted and
nothing is installed at run time. Anything else (a Bun or distroless
image, a removed npm, pnpm without corepack, an unreadable base image, no
Dockerfile) is `migration-command-needs-input`: it records
`migrationNeedsInput`, sets `migration.needsCommand` and blocks
deployment until the vendor enters a command or chooses "No separate
migration" — both are vendor overrides that re-analysis keeps. A declared worker
process is `worker-process` — informational, because Deployz now runs it
as its own service. Worker-like code with no declared start command is
`worker-command` and sets `worker.needsCommand`: a needs-input question
that is never provisioned from weak evidence such as a queue library
alone. `reconcileReadiness` applies the vendor's
container port, start command and migration choice as a view, so the page, the persisted
verdict and the fix instructions agree without a re-analysis.

Adding a rule: add the finding in `readiness-report.ts` (id, copy, severity,
confidence), a test in `readiness-report.test.ts`, and — when the deployment
gate must enforce it — the matching check in `manifest.ts` /
`preflight.ts`. Bump `ANALYSIS_VERSION`.

## Async and scheduled workloads

`detectAsyncWorkloads` (`packages/analysis/src/async-detection.ts`) finds
SQS queues and scheduled jobs. It reads two independent evidence families.
Strong evidence provisions infrastructure. Weak or ambiguous evidence never
provisions anything — it becomes a non-blocking `questions` entry instead.

- **Queues (SQS Standard only).**
  - Precondition: the repository depends on an SQS SDK package
    (`@aws-sdk/client-sqs`, `aws-sdk`, `sqs-consumer`, or `sqs-producer`).
    With no such dependency, Deployz detects no queue.
  - Queue env var names: `<NAME>_QUEUE_URL`, `<NAME>_SQS_URL`, and the bare
    `QUEUE_URL` name a queue; a matching `<NAME>_QUEUE_ARN` reads as that
    same queue's ARN. `<NAME>_DLQ_URL` and `<NAME>_DEAD_LETTER_QUEUE_URL`
    name that queue's dead-letter queue.
  - SQS operations: `SendMessageCommand`, `SendMessageBatchCommand`,
    `.sendMessage(`, `.sendMessageBatch(`, and `Producer.create(` count as a
    producer. `ReceiveMessageCommand`, `.receiveMessage(`, and
    `Consumer.create(` count as a consumer.
  - Attribution: Deployz walks from the web app's own entry file, and from
    each declared worker's and each declared scheduled job's entry command,
    through relative imports, up to 4 levels deep. An SQS operation found in
    that reach attributes to the workload that reaches it.
  - Web-consumer distrust: a consume operation reached only from the `web`
    workload is never trusted. A request/response web process is not a
    queue consumer, so this evidence is treated as ambiguous and becomes a
    question instead of an attribution.
  - Provisioning rule: a queue is provisioned only when a producer and a
    consumer both resolve, with no ambiguity anywhere in the evidence. An
    unnamed queue variable, a variable read from more than one workload
    reach, or a queue with only a producer or only a consumer, each becomes
    a `questions` entry and is never provisioned.
  - Python (boto3): `sqs.receive_message`, `sqs.send_message`, and
    `get_queue_url` calls are detected when a `requirements*.txt` file names
    `boto3`, but this evidence always becomes a `questions` entry — Deployz
    does not parse Python well enough to attribute a queue relationship with
    confidence, so it never auto-provisions from Python evidence.
  - SQS usage no longer rejects the repository. Earlier Deployz versions
    treated any SQS consumer as an unsupported event-driven architecture
    (`checkSqsEventArchitecture`, removed); SQS Standard is now a supported
    managed resource.
- **Scheduled jobs.**
  - Recognized only from a `render.yaml` service with `type: cron`
    (schedule plus a command), and from a Kubernetes `CronJob` manifest
    (schedule plus a command/args). Both need a valid cron expression, or a
    macro such as `@daily`; a Kubernetes `CronJob` also needs a valid IANA
    timezone when one is set.
  - Never recognized, never provisioned: an in-process cron library (for
    example `node-cron`), a CI-level schedule (for example a GitHub Actions
    `schedule:` trigger), and a bare cron string with no production
    deployment declaration naming a command.
  - A Vercel `vercel.json` `crons` block (an HTTP path, not a command) and a
    `crontab` or `*.cron` file each become a `questions` entry — Deployz
    cannot resolve either to a runnable command on its own.
  - An id conflict — two schedule declarations that resolve to the same
    component id — becomes a `questions` entry instead of provisioning
    either.
- **Output.** `detectAsyncWorkloads` shapes its result as `ManifestQueue[]` /
  `ManifestScheduledJob[]` / `ManifestQuestion[]` already. `manifest.ts`'s
  `reconcileAsyncDeclarations` then keeps only the queues and jobs whose ids
  and workload references do not collide with the rest of the manifest (a
  reserved id, a vendor override, another queue or job); anything that would
  collide becomes a `questions` entry instead, so the planner is never
  handed a relationship it would reject.

`ANALYSIS_VERSION` is 37 (`apps/api/src/analysis.ts`) — last bumped so a
stored analysis finds a NestJS health controller, drops env vars that were
wrongly required, and stops treating token counts and limits as secrets (see
`docs/environment-variables.md`).

## Fix instructions

`POST /api/applications/:id/fix-instructions` builds a deterministic prompt
for the vendor's own coding agent, structured as: repository facts (only
those the included blockers justify), blocking issues (accurate names plus
evidence), required outcome, implementation guidance (deterministic
per-blocker steps plus AI guidance), validation (only applicable checks),
and a completion report. Informational findings that need no action are
filtered out. `summariseEnvRequirements` splits the env-var model into
build-time, runtime, and platform-injected names — never values. The
document is cached on the row keyed by commit, analysis version, facts and
findings; `{regenerate: true}` bypasses. A resolved finding never reaches
the document.

## Environment variables

`detectEnvVarModel` decides `required` and `secret` with high precision. A
value in a sample file (`.env.example`/`.sample`/`.template`) is never a
default (`docs/environment-variables.md`);
`classifyEnvVariables` (`env-classification.ts`) decides who supplies the
value:

| Classification | Rule | Delivery |
|---|---|---|
| `deployz_managed` | the names the stack injects for THIS app (DATABASE_*, the Redis bindings, STORAGE/S3 bucket, AWS_REGION, PORT, HOSTNAME), and an S3 region/endpoint name the app reads when storage is provisioned | at install; S3 region/endpoint as a `derived` value on the first configuration pass |
| `deployz_generated` | secret + app-internal name (…SECRET, SECRET_KEY(_BASE), ENCRYPTION_KEY, SIGNING_KEY, APP_KEY, SALT…), no third-party prefix, no connection suffix, no shared/webhook secret, not a catalog credential; required, or optional with purpose `internal_secret` (it usually falls back to a development default) | minted once by the relay with `crypto.randomBytes` inside the customer's account, unless the vendor saved another decision (`mintedEnvKeys`) |
| `customer_required` | every other required key | a vendor decision on the configuration screen: the vendor supplies the value, or marks it "Set by customer" or optional (the name means "needs a vendor decision", not "the customer supplies it") |
| `optional` | read with a default | optional |
| `unknown` | declared only in a sample file | listed, never required |

The first configuration pass runs after a successful INSTALL (one
CONFIG_UPDATE job). The relay binds only secret keys whose value exists and
reports `unboundSecretKeys`. A secret entered before the customer's relay is
connected is held KMS-encrypted in the pending-secret vault and delivered
through the authenticated relay config endpoint on that first pass; a value
that waits longer than 24 hours expires and must be entered again
(`docs/pending-secret-delivery.md`).

## Preflight

`evaluatePreflight` (`apps/api/src/preflight.ts`) combines the manifest gate
(unsupported architecture, container setup, port, start command, required
env vars against the customer's saved keys with generated keys counted as
provided) with the readiness report's remaining findings as warnings, and
lists every check. States: READY, READY_WITH_WARNINGS, ACTION_REQUIRED,
UNSUPPORTED. It runs at deployment creation, the install-link and deploy-
link launches and relay registration (`requirePreflightReady`, 422 with
`details.findings`), and is served on `GET /api/applications/:id/preflight`
and `GET /api/deployments/:id/preflight`. Warnings never block; nothing in
the preflight calls the model.

## Failure diagnosis

1. **Classification** — the relay classifies at the executor boundary; the
   API refines coarse codes deterministically from error text and stack
   events (`failure-classification.ts`). Known signatures include SCP and
   IAM denial, quota, image pull, regional artifact mismatch, RDS and
   ElastiCache failures, ECS health-check and container-exit failures, and
   the relay's own state-write failure.
2. **Context** — `buildFailureContext` (`failure-context.ts`) gives one
   bounded, redacted representation: phase, attempt, settled and reported
   codes, blamed resource, ≤5 failed events, version. The diagnostics
   response serves it as `context` for the technical layer.
3. **Explanation** — every code that names an account or infrastructure
   cause is answered from the copy map without a model call. The app-owned
   evidence-rich set (`AI_EXPLAINABLE_FAILURE_CODES` in the diagnostics
   route: `UNKNOWN` plus the startup/config failure codes) asks the AI,
   with the structured event derived from the context, a strict
   `{what, why, fix, confidence}` schema,
   the deterministic code always overriding the echoed one, one generation
   per attempt cached on `deployment_jobs`, and deterministic copy on any
   failure. Confidence below `high` is hedged on the card ("Deployz could
   not determine the exact cause…").

Failed release builds (`apps/api/src/release-build-failure.ts`) follow
the same rules outside the deployment flow. Deployz reads the failed build's
log, redacts it, finds the earliest meaningful error, and classifies who most
likely has to act only when a log line supports it — never from the final
check or an exit code alone. "Explain with AI"
(`POST …/releases/:releaseId/build-failure/explain`) runs only on request,
sends at most 60 redacted log lines fenced as untrusted data, and keeps only
supporting line numbers that exist in that excerpt, shown with the log's own
text. It is not cached. Without log lines it makes no model call; on any AI
failure it answers 503 and the failure details stay usable.

Adding a signature: add the rule in `refineFailureCode` (order matters —
specific before generic), a test in `failure-classification.test.ts`, and
only if no existing code fits, a new code in all five mirrors
(`packages/db/src/enums.ts`, `packages/contracts`, `packages/copy-map`,
`packages/analysis/src/failure-codes.ts`, `apps/web/src/lib/
diagnostic-vocabulary.ts`) plus a migration.

## Configuration and cost

- Gateway: `AI_GATEWAY_BASE_URL`, `AI_PROVIDER_API_KEY`, optional
  `AI_GATEWAY_TOKEN`, `AI_MODEL` (`apps/api/src/ai-config.ts`);
  `AI_FIXTURE_MODE=true` swaps in canned answers for E2E.
- Prompts: `repository-ai.ts`, `fix-instructions.ts`,
  `diagnostic-explainer.ts`. Each has its own token budget, timeout, and
  a spend check on the gateway's reported usage; the gateway retries once
  on transient errors and malformed output, never on 4xx.
- Calls per lifecycle: at most one repository call per analysed commit (and
  only for an open question), one fix-instructions call per commit and
  finding set, one explanation per failed attempt whose code is in the
  AI-explained set (`UNKNOWN` plus the app-owned startup/config codes).
  Never on the deploy button, never per lifecycle event, never in a loop.

## Testing AI changes

- Deterministic corpora: `packages/analysis/test/eval-corpus.test.ts` (nine
  archetypes with exact expectations), `application-analysis.test.ts`,
  `env-classification.test.ts`, `readiness-report.test.ts`, and the
  120-repository Stage A audit (`pnpm benchmark:compat`).
- AI boundaries: schema/gate tests with fake gateways
  (`repository-ai.test.ts`, `diagnostic-explainer.test.ts`,
  `apps/api/src/ai-explanation.test.ts`, `fix-instructions` tests); the
  live gateway test (`ai-live.test.ts`) runs only with `DEPLOYZ_LIVE_AI=1`
  and asserts structure, never wording.
- Changing a prompt or schema: keep `.strict()`, add the fixture-mode
  answer in `apps/api/src/ai-fixture.ts` if E2E needs it, and never assert
  on model prose in CI.
