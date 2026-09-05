# Deployz AI MVP (P0/P1) — implementation record

The per-phase record for the P0/P1 AI capabilities: repository understanding,
structured requirement extraction, blocker detection, fix instructions,
failure diagnosis, error simplification, environment-variable intelligence
and the preflight gate. It follows the same conventions as
`docs/mvp-implementation-status.md`: audit first, extend what exists, one
reviewable PR per phase.

Operating principle for every phase:

> AI infers and explains. Deterministic Deployz systems provision and mutate
> AWS infrastructure.

## Phase 0 — Repository audit and gap map (2026-09-05)

The audit covered `packages/analysis`, `apps/api` (analysis, readiness gate,
config, diagnostics), `packages/relay` and the worker (failure evidence),
`packages/copy-map`, `apps/web` (readiness, configuration, deployment
detail, install and deploy-link pages), the test infrastructure, fixtures
and the existing AI documentation. Nothing was changed by the audit.

### What already exists (reuse, do not rebuild)

| Area | Where | State |
|---|---|---|
| Deterministic analysis | `packages/analysis/src/analyser.ts`, `detectors.ts`, `rejection.ts`, `redis.ts` | Live. 14 detectors, 19 rejection checks, Redis/Postgres requirement assessment, flat `detected_metadata` JSONB |
| Semantic readiness report | `packages/analysis/src/readiness-report.ts`, `rules.ts` | Live. 17 finding ids with `required`/`recommended` severity, `blocking` flag and `confirmed`/`likely`/`needs_confirmation` confidence; state READY / ALMOST_READY / NEEDS_CHANGES |
| Deployment manifest + gate | `packages/analysis/src/manifest.ts`, `apps/api/src/deploy-links.ts`, `apps/api/src/manifest.ts` | Live. `evaluateManifestReadiness` refuses deployment creation (422), install launch and relay enrolment for non-READY manifests |
| AI gateway | `packages/analysis/src/ai-gateway.ts`, `apps/api/src/ai-config.ts` | Live. Cloudflare AI Gateway via the Vercel AI SDK, strict Zod output, bounded retries, spend caps, fixture mode (`AI_FIXTURE_MODE`) |
| AI repository fallback | `packages/analysis/src/repository-ai.ts`, `apps/api/src/analysis.ts` | Live. Runs only for one of seven unresolved questions; deterministic-always-wins merge; any AI failure degrades to deterministic output |
| Commit-SHA analysis cache | `apps/api/src/analysis.ts` (`ANALYSIS_VERSION`, `isCommitShaCacheHit`) | Live |
| Fix instructions | `packages/analysis/src/fix-instructions.ts`, `POST /api/applications/:id/fix-instructions`, `apps/web/src/components/fix-instructions-dialog.tsx` | Live. Deterministic document with AI guidance per finding, guardrail text, CTA placed below the findings |
| Env-var model | `detectEnvVarModel` (`detectors.ts`), `application_configs`, `apps/web/src/app/dashboard/applications/[id]/config/page.tsx` | Live. `key/required/secret/source`; masked write-only secrets; required-env gate at deployment creation |
| Failure taxonomy | `packages/db/src/enums.ts`, `packages/copy-map/src/index.ts`, `apps/api/src/failure-classification.ts`, `packages/relay/src/deploy.ts` | Live. 23 failure codes mirrored in five places with parity tests; relay classifies at the executor boundary, the API refines coarse codes from stack events and error text |
| Sanitisation | `packages/analysis/src/redact.ts` | Live. Applied at stack-event ingest and inside every AI prompt builder |
| AI failure diagnosis | `packages/analysis/src/diagnostic-explainer.ts`, `apps/api/src/ai-explanation.ts`, `GET /api/deployments/:id/diagnostics` | Live. Deterministic what/why/fix for every known code; AI only for `UNKNOWN`; cached per job with single-flight claim |
| Jargon boundary | `packages/copy-map`, `docs/ui-system.md`, ESLint rule in `eslint.config.mjs` | Live. Raw CloudFormation/ECS text reaches vendor UI only behind "Advanced details" / "Technical detail" disclosures; customer surfaces get translated phrases |
| Test corpus | `packages/analysis/test/*`, `apps/api/src/github.ts` fixture repos, `docs/testing/repository-compatibility/` (100 pinned repositories, Documenso = repo-006) | Live |

### Gap matrix

| Capability | Existing | Partial | Missing | Changes needed (phase) |
|---|---|---|---|---|
| Runtime detection | | ✓ | | `manifest.runtime` is `node` or `unknown`; no language detector. Add a deterministic runtime detector (Node, Python, Ruby, Go, JVM, .NET, PHP, Elixir, Rust) from manifests and the Dockerfile base image (1) |
| Build command | ✓ | | | `detectBuildCommand` (package.json only). Expose with source and evidence (1) |
| Start command | ✓ | | | `detectStartupCommand` (Dockerfile CMD/ENTRYPOINT, `scripts.start`). Expose with source and evidence (1) |
| Port | ✓ | | | `detectPort` six-tier cascade. Expose with source and evidence (1) |
| Bind address | | | ✓ | No localhost-binding detector. Add `detectBindAddress` and the `localhost-binding` finding (1, 2) |
| DB | ✓ | | | `assessPostgres` with evidence. Expose in the canonical view (1) |
| Redis | ✓ | | | `assessRedis` with confidence, purpose, evidence. Expose in the canonical view (1) |
| Storage | ✓ | | | `detectLocalFilesystem` (declared state only) and `detectS3`. Expose in the canonical view (1) |
| Health endpoint | ✓ | | | `detectHealthEndpoint`. Expose with source and evidence (1) |
| Migrations | | ✓ | | Node tools only. Expose in the canonical view; framework label (1) |
| Env vars | | ✓ | | Model has `required`/`secret`/`source`, no classification, no aliasing, no description. Add `classification` (Deployz-managed, Deployz-generated, customer-required, optional, unknown) and the split UI (4) |
| Canonical analysis | | ✓ | | Storage is a flat JSONB record; per-field evidence and confidence exist only for Postgres and Redis. Add one typed `ApplicationAnalysis` projection built at analysis time and served on the readiness endpoint (1) |
| Compatibility blockers | ✓ | | | Severity/blocking model and stable ids exist. Add the findings the deployment gate enforces but the report never shows (`port-unresolved`, `start-command-missing`) and the new `localhost-binding` finding; show detected facts on the readiness page (2) |
| Fix guidance | ✓ | | | Regenerated on every request. Add a cache keyed on commit SHA, analysis version and the finding set (3) |
| Failure diagnosis | ✓ | | | AI output is `what/why/fix` with no confidence. Add `confidence` and the low-confidence wording; keep AI limited to `UNKNOWN` (7) |
| Error simplification | ✓ | | | Vendor and customer surfaces already translate. Audit the remaining interpolated raw values (release build failure text names CodeBuild; admin progress card) (8) |
| Preflight | | ✓ | | The manifest gate runs at three boundaries, but the required-env check runs only at creation and there is no preflight endpoint or pre-deploy summary. Add one `evaluatePreflight` used by all three boundaries and by a `GET .../preflight` route with a UI summary (5) |
| Error normalisation | ✓ | | | `refineFailureCode` + `StructuredEvent` + redaction. Add a regional-artifact mismatch mapping if a code fits without a new enum value; otherwise record the mapping table (6) |

### Architectural decisions

1. **No second analysis pipeline.** `runApplicationAnalysis` stays the only
   orchestrator. The canonical `ApplicationAnalysis` is a typed projection
   built from the same detector output at persist time and stored beside the
   flat metadata (`detected_metadata.application`). The flat keys keep
   feeding the manifest, contract fields and the compatibility benchmark
   unchanged.
2. **Keep the existing severity vocabulary.** `required` + `blocking` is the
   spec's BLOCKER, `required` alone is its WARNING, `recommended` is its
   RECOMMENDATION. Renaming would churn copy-map, the web mirror and the E2E
   suite for no user-visible gain. The eligibility states map as READY →
   READY (with recommended findings → READY_WITH_WARNINGS), ALMOST_READY →
   ACTION_REQUIRED, NEEDS_CHANGES → UNSUPPORTED.
3. **No new failure codes unless a live producer exists.** Adding a code
   touches five mirrors and a Postgres enum migration. Phase 6 maps new
   signatures onto existing codes first.
4. **Generated secrets stay deterministic.** The Documenso preset already
   generates its auth secrets per install with `crypto.randomBytes`. Phase 4
   generalises that path; the LLM never produces a secret value.
5. **AI stays behind the readiness endpoint and the diagnostics endpoint.**
   No LLM call per lifecycle event, no LLM call on the deploy button when
   the commit SHA and analysis version are unchanged.
6. **Persistence stays in `detected_metadata` and `deployment_jobs`.** No
   new tables; a new column is added only if a JSONB field cannot carry the
   data safely.

### Duplication risks noted

- `apps/web/src/lib/readiness.ts` mirrors the analysis types by hand and
  `apps/web/src/lib/diagnostic-vocabulary.ts` mirrors copy-map; every new
  field must be added on both sides and covered by the parity tests.
- Two readiness evaluations exist by design (semantic report vs manifest
  gate). Phase 2 and Phase 5 align them rather than merging them.
- Contract-field vendor edits (`PATCH /api/applications/:id`) do not rebuild
  the stored readiness report; Phase 2 must keep the page and the gate
  consistent after an edit.

### Verification

Baseline on the merge base (`ee7aa01`): `pnpm build` passed (9 tasks);
`pnpm vitest run` — 2646 passed, 3 skipped, 5 suites failing only in the
local environment (four `apps/web` tsx suites and the compatibility harness's
PGlite resolution; both green in CI). No production behaviour changed in
Phase 0. PR #175.

## Phase 1 — Canonical structured application analysis (2026-09-05)

One typed projection of what Deployz understands about an application,
built from the same detector output as the flat metadata and the manifest.
Analysis version 12 → 13.

### Audited existing (unchanged)

- `analyseRepo` stays the only detector orchestrator; `runApplicationAnalysis`
  the only caller. The flat `detected_metadata` keys, the §35 contract-field
  backfill, the manifest normalisation and the compatibility benchmark read
  exactly what they read before.
- `mergeAiAnalysis` precedence (explicit config > deterministic > AI) is
  untouched; the projection only reports which keys the AI filled.

### Added

1. **`ApplicationAnalysis` contract** (`packages/contracts/src/
   application-analysis.ts`). Strict Zod schema: `runtime`, `framework`,
   `build`, `start`, `network.port`, `network.bindAddress` as facts
   (`value`, `source`, `confidence`, `evidence[]`); `database`, `redis`,
   `storage`, `healthCheck`, `migrations` as structured blocks with
   evidence; `environmentVariables` reuses the manifest env-var model;
   `analysisVersion`. Sources: dockerfile, package-manifest, compose,
   env-file, procfile, source, ai, none. Confidence reuses the readiness
   vocabulary (confirmed / likely / needs_confirmation).
2. **Projection builder** (`packages/analysis/src/application-analysis.ts`).
   `buildApplicationAnalysis(analysis, {analysisVersion, aiResolved,
   resolvedMigrationCommand})` is pure and validates its own output.
   Evidence is the detector's one-line `details`, never file content. An
   AI-resolved value is `source: 'ai'`, `confidence: 'likely'`, and can
   never displace a detector value. `readApplicationAnalysis(metadata)`
   returns null for a row analysed before Version 13 or a malformed
   projection — never a partially trusted object.
3. **Detector sources.** `DetectorFinding.source` names the evidence family
   for framework, port (all six tiers), health endpoint (tracked per path
   candidate), start, build and migration commands.
4. **Runtime detector** (`detectRuntime`). The selected Dockerfile's last
   recognisable base image decides (registry host and tag stripped;
   multi-stage builds walk back past a bare distroless/alpine final
   stage); otherwise the shallowest dependency manifest. Families: node,
   python, ruby, go, jvm, dotnet, php, elixir, rust. `manifest.application.
   runtime` now reads it, with the legacy Node-or-unknown inference for
   rows analysed before Version 13.
5. **Bind-address detector** (`detectBindAddress`). Flags a server that
   binds only to a loopback address from evidence that decides production:
   Dockerfile `ENV HOST`, Dockerfile CMD/ENTRYPOINT (exec form
   normalised), Procfile `web:`, the `start` script, and runtime source
   (`listen(port, '127.0.0.1')`, Flask/uvicorn `host=`, gunicorn `bind`,
   Go `ListenAndServe("localhost:…")`). `uvicorn` / `flask run` without
   `--host` count, because they bind 127.0.0.1 by default. Dev scripts,
   sample env files and test files never count. Metadata:
   `bindsLocalhost`, `bindAddress`.
6. **Persistence and wire.** `runApplicationAnalysis` stores the projection
   as `detected_metadata.application`; `GET /api/applications/:id/readiness`
   serves it as `detected` (null until a Version 13 analysis ran).

### Tests

- `packages/analysis/test/application-analysis.test.ts` (21): runtime
  detector (image, multi-stage, registry prefix, manifest fallback, none);
  bind-address detector (Node listen, start script, dev script ignored,
  uvicorn default, `--host 0.0.0.0`, test files ignored, Dockerfile ENV, Go);
  projection fixtures for Express+PostgreSQL, Next.js+Prisma, Python,
  Redis, declared local filesystem, missing health endpoint, and an
  ambiguous repository resolved by a fake AI merge; determinism; read-back
  of a stored, missing and malformed projection.
- `apps/api/src/analysis.test.ts`: the fixture-mode run persists a
  projection readable through the contract.
- `apps/api/src/server.test.ts`: the readiness route serves a stored
  projection as `detected` and degrades a malformed one to null.

Verification: `@deployz/analysis` 435 tests, `@deployz/api` full project,
lint on analysis/contracts/api, `tsc --noEmit` on the API. PR #176.

## Phase 2 — Compatibility and deployment blocker detection (2026-09-05)

### Decisions

- **Severity vocabulary kept.** `required` + `blocking` is the spec's
  BLOCKER (state NEEDS_CHANGES, verdict NOT_COMPATIBLE); `required` alone is
  its WARNING (ALMOST_READY / NEEDS_ATTENTION — deployment creation is still
  refused by the manifest gate for the port and start-command cases);
  `recommended` is its RECOMMENDATION (never blocks READY). The stable
  finding ids are the machine-readable issue codes.
- **The page and the gate must agree.** The manifest gate already refused a
  deployment for a missing port or start command while the readiness page
  could say "Ready to deploy". The report now carries those findings, and
  the vendor's own configuration resolves them without a re-analysis.
- **Reconciliation is a view, never a rewrite.** The stored report keeps
  every finding. `reconcileReadiness(report, {containerPort, startCommand})`
  turns a finding the vendor resolved through the application details into
  a passed check and re-derives the state; it runs wherever the report is
  read or its verdict persisted, so clearing the value brings the finding
  back.

### Added

1. **Findings** (`packages/analysis/src/readiness-report.ts`):
   - `port-unresolved` (required, non-blocking, confirmed) — a Dockerfile
     exists but no port was found in any tier.
   - `start-command-missing` (required, non-blocking, confirmed) — a
     Dockerfile exists with no CMD/ENTRYPOINT and no `start` script. Both
     are omitted when there is no Dockerfile at all (`container-setup`
     already covers "Deployz doesn't know how to start your app").
   - `localhost-binding` (required, non-blocking, likely) — from the Phase 1
     bind-address detector, with the detector's evidence.
   - `runtime` joins the passed checks; `bind-address` never does.
2. **`reconcileReadiness`** and `ReadinessResolution` (exported).
3. **API** — `effectiveReadinessReport` / `readinessResolution`
   (`apps/api/src/fix-instructions.ts`) read the container-port column and
   the manifest-only start command. Used by the readiness route, by the
   fix-instructions context (a resolved finding never reaches the coding
   agent), by the analysis runner when it persists the verdict, and by the
   application PATCH handler, which re-derives `compatibilityStatus` /
   `compatibilityReason` when the port or a manifest-only override changes.
4. **UI** — "What Deployz detected" on the readiness card
   (`apps/web/src/components/readiness-result.tsx`, rows from
   `detectedFactRows` in `apps/web/src/lib/readiness.ts`): runtime,
   framework, start and build commands, port, database, cache/queue, file
   storage, health check, migrations. Each row shows the value in plain
   words, a one-line source/confidence hint ("From the container setup",
   "Inferred by AI analysis — verify before relying on it"), and the
   evidence behind a disclosure. Missing values render quietly; the checks
   above already say what needs action. Rows analysed before Version 13
   simply omit the section.

### Tests

- `packages/analysis/test/readiness-report.test.ts`: the three findings,
  their severities, the no-Dockerfile suppression, runtime as a passed check,
  and `reconcileReadiness` (resolves, partial, identity, immutability, never
  a blocking finding).
- `apps/api/src/fix-instructions.test.ts`: resolution reading, effective
  report, resolved findings excluded from fix instructions.
- `apps/api/src/server.test.ts`: GET readiness reconciles; PATCH sets and
  clears the verdict with the port; unrelated PATCH leaves it alone.
- `apps/web/test/readiness.test.ts`: `detectedFactRows` order, plain-words
  values, quiet missing values, AI/likely hints, jargon-free.
- `apps/web/test/readiness-result.test.tsx`: the section renders after the
  checks with evidence behind a disclosure; omitted for legacy rows.
- `e2e/readiness.spec.ts`: the detected section for the fixture repository.
- Every GitHub fixture repository keeps its readiness state (checked by
  running the report over `GITHUB_FIXTURE_FILE_TREES`).

PR #177.

## Phase 3 — AI remediation and fix instructions (2026-09-05)

The existing "Generate fix instructions" flow is extended, not replaced:
the same route, the same generator, the same dialog, the same CTA placed
below the findings.

### Audited existing (unchanged)

- `generateFixInstructions` builds the document deterministically around
  the model's per-finding guidance; the guardrail, validation and
  completion-report sections are templated. No repository file content
  reaches the model — only facts and finding evidence.
- The dialog renders one consolidated document with copy, regenerate and
  re-analyse actions; any AI failure is a retryable 503.

### Added

1. **Cache** (`apps/api/src/fix-instructions.ts`, `POST /api/applications/
   :id/fix-instructions`). `fixInstructionsCacheKey` hashes the analysed
   commit, the analysis version, every fact and every finding's id,
   evidence, outcome and confidence. A generated document is stored as
   `detected_metadata.fixInstructions = {key, instructions, generatedAt}`
   and reused (`cached: true`) while the key matches. `{regenerate: true}`
   bypasses the cache. A re-analysis replaces the metadata wholesale, so a
   new commit or a changed finding set invalidates on its own; a failed
   regeneration leaves the earlier document in place.
2. **Targeting.** The prompt and the document carry the detected runtime
   (from Phase 1) beside the framework, and each finding block now reads
   Problem / Why this matters / Detected / Desired deployment outcome /
   Confidence / Implementation guidance, so the coding agent gets the
   reason as well as the evidence. The Phase 2 findings (port, start
   command, localhost binding) flow through unchanged; a finding the vendor
   resolved through the application details never reaches the document.
3. **Dialog.** Shows when the document was generated and, for a reused
   document, "Reused the instructions generated earlier for this analysis.
   Regenerate to write them again." Regenerate requests a fresh document.

### Tests

- `apps/api/src/fix-instructions.test.ts`: key determinism and
  sensitivity (commit, version, fact, finding), stored-document reading.
- `apps/api/src/server.test.ts`: one generation per key, `cached: true` on
  reuse, regenerate bypass, a changed finding set misses, a failed
  regeneration keeps the earlier document.
- `apps/web/test/readiness.test.ts`: generated-at label, jargon-free note.
- `e2e/fix-instructions.spec.ts`: generated label and regenerate.

PR #178.

## Phase 4 — Environment-variable intelligence (2026-09-05)

### What the audit found

- The §11.2 model already decides `required` and `secret` with high
  precision from reads, defaults and the external-service catalog. It had
  no notion of who supplies a value.
- Two delivery gaps sat underneath the model. The CONFIG_UPDATE fan-out
  only targets installed deployments and INSTALL carries no configuration,
  so a value saved before the first install never reached it. And the
  control plane never stores secret values, so a vendor-scope secret's
  value was dropped at save time (documented in `apps/api/src/config.ts`) —
  a later configuration pass would then have bound a key with no value,
  which stops every task from starting.

### Decisions

- **Classification is deterministic and value-free.** Names, the detected
  requirements and the external-service catalog decide; the LLM takes no
  part. Rules live in `packages/analysis/src/env-classification.ts`.
- **Generated secrets are minted by the relay, inside the customer's
  account, once.** The control plane never sees the value. Only
  app-internal secrets qualify (a name ending in SECRET, SECRET_KEY(_BASE),
  ENCRYPTION_KEY, SIGNING_KEY, APP_KEY, SESSION_KEY, JWT_KEY, COOKIE_KEY,
  SALT/PEPPER, with no third-party prefix such as STRIPE_/SMTP_/GITHUB_/AWS_
  and no connection suffix such as _URL/_TOKEN/_API_KEY/_CLIENT_SECRET).
  A catalog credential is never generated.
- **The first configuration pass happens after INSTALL.** One CONFIG_UPDATE
  job per install (idempotent on the install job id, no values in the
  payload) applies saved plain values, binds saved secrets, mints generated
  ones and reports what it did — key names only.
- **A secret without a value is reported, never bound.** The relay binds
  only keys present in the store and lists the rest as
  `unboundSecretKeys` in the job output. The vendor-scope secret limitation
  itself stands (the control plane holds no secret values): a secret entered
  before a customer's relay is connected must be entered again from that
  deployment's configuration.

### Added

1. **Contract** — `manifestEnvVariableSchema.classification` (optional:
   `deployz_managed`, `deployz_generated`, `customer_required`, `optional`,
   `unknown`), `envVariableClassificationSchema`.
2. **Classification** (`classifyEnvVariables`, wired in `analyseRepo` after
   the requirements are known): managed = the names the application stack
   injects for THIS app (database, cache bindings, storage, PORT/HOSTNAME);
   generated = required + secret + app-internal; customer-required = the
   other required keys; optional = read with a default; unknown = declared
   only in a sample file. `isGeneratableSecretName` is exported for reuse.
3. **Gate** — `evaluateManifestReadiness` counts generated keys as
   auto-provided (`generatedEnvKeys`), so the vendor is asked only for what
   Deployz cannot derive or mint. Rows analysed before Phase 4 keep the old
   rule (every required key is the vendor's).
4. **Relay** (`packages/relay/src/config-update.ts`): `generated` entries
   are minted with 256 bits of `crypto.randomBytes` when absent and kept
   thereafter; `computeSecretChanges` takes the set of keys the store holds;
   the job output carries `generatedKeys` and `unboundSecretKeys`.
5. **API** (`apps/api/src/install-config.ts`): `buildRelayConfigEntries`
   (the `/api/relay/config` view plus `generated: true` entries for
   unconfigured generated keys) and `queuePostInstallConfig` (called from
   the INSTALL-success hook beside the auto-deploy). The simulated relay
   answers the job as applied.
6. **UI** — the configuration screen opens with an "Environment" card:
   "Deployz configures automatically" (managed, generated), "You need to
   provide" (missing first, ✓ when a value is saved for this scope) and a
   collapsed "Optional" list, built by `buildEnvPlan` in
   `apps/web/src/lib/env-plan.ts`. Never a value.
7. **Fixture** — `deployz-demo/config-required-app` now reads LICENSE_KEY
   (customer-required) beside SESSION_SECRET (generated); the lifecycle
   sweep provides LICENSE_KEY.

### Tests

- `packages/analysis/test/env-classification.test.ts` (10): generatable
  names, managed-only-when-required, service credentials never generated,
  optional vs unknown, purity, analysis → manifest → gate, legacy model.
- `packages/relay/src/config-update.test.ts` (+4): mint once and report
  the key only, keep an existing value, never bind an unbound key, value
  entropy.
- `apps/api/src/install-config.test.ts` (3): relay view, one job per
  install with key names only, nothing queued when nothing applies.
- `apps/web/test/env-plan.test.ts` (3): grouping, legacy fallback, summary.
- E2E: `scenario-sweep.spec.ts` (gate on LICENSE_KEY, post-install config
  job over the simulated relay), `config.spec.ts`, `readiness.spec.ts`.

PR #179.

## Phase 5 — Pre-deployment readiness / preflight gate (2026-09-05)

### What the audit found

The manifest gate ran at three boundaries (deployment creation, install-link
launch, relay registration) plus the deploy-link launch, but only the
creation call knew the customer's provided env keys — the later boundaries
passed none, so a required value removed after creation still launched.
There was no preflight endpoint and nothing shown before the deploy button.

### Decisions

- **One evaluation, four boundaries.** `evaluatePreflight` in
  `apps/api/src/preflight.ts` combines the manifest gate (unsupported
  architecture, container setup, port, start command, required env vars
  against THIS customer's saved keys, generated keys counted as provided)
  with the readiness report's remaining non-blocking findings as warnings,
  and lists every check. Deployment creation, the install-link and
  deploy-link launches and relay registration all call it through
  `requirePreflightReady`, with the same 422 codes clients already handle
  (`details.findings` blockers first, then warnings, plus `state`).
- **No AI on the deploy button.** The preflight reads the persisted analysis,
  the stored manifest and the configuration rows. Nothing is fetched,
  nothing is generated.
- **Warnings never block.** Missing health endpoint, missing migration
  command, a localhost binding and the worker recommendation surface as
  warnings; a blocker is a missing Dockerfile/port/start command, an
  unsupported architecture, or a missing customer-required value.

### Added

1. `evaluatePreflight` / `runApplicationPreflight` (fresh manifest, vendor
   scope or one customer) / `runDeploymentPreflight` (stored manifest,
   customer scope) / `requirePreflightReady`. States: READY,
   READY_WITH_WARNINGS, ACTION_REQUIRED, UNSUPPORTED. Checks: supported
   architecture, build configuration, start command, port, database, cache,
   file storage, Deployz-managed variables, required customer variables
   (missing names listed), health configuration, database migrations, plus
   one row per readiness warning.
2. `listProvidedConfigKeys` accepts a null customer (vendor defaults only).
3. Routes: `GET /api/applications/:id/preflight?customerId=` and
   `GET /api/deployments/:id/preflight`.
4. UI: `PreflightSummary` (`apps/web/src/components/preflight-summary.tsx`)
   on the create-deployment form (against the vendor defaults, refreshed
   when the application changes; never disables the button — the API is the
   authority) and beside the install link on a not-yet-installed deployment
   (against the customer's configuration).

### Tests

- `apps/api/src/preflight.test.ts` (8): every state, missing customer value
  named and generated ones never, port/start blockers, unsupported, the
  three warning sources, legacy manifest, determinism, `requirePreflightReady`.
- `apps/api/src/server.test.ts` (+2): the application route in vendor and
  customer scope; the install-link launch refuses when a required value was
  removed after creation and the deployment stays NOT_INSTALLED.
- `apps/web/test/preflight-summary.test.tsx` (3): presentation per state,
  ready rendering, blocked/recommended ordering.
- `e2e/create-deployment.spec.ts`: the preflight shows UNSUPPORTED before
  submit for the unsupported fixture.

PR #180.

## Phase 6 — Deployment error normalisation (2026-09-05)

### Audited existing (unchanged)

- The 23-code taxonomy, its five mirrors and parity tests; the relay's
  executor-boundary classification; `refineFailureCode` at result ingest;
  `redactSecrets` / `normalizeErrorText`; the per-code copy map; the
  `StructuredEvent` boundary with no raw-log field. No failure code, enum,
  copy-map entry or migration was added.

### Added

1. **One failure representation** — `buildFailureContext`
   (`apps/api/src/failure-context.ts`) turns the failed job and the
   CloudFormation events persisted for it into `DeploymentFailureContext`:
   phase (job type), attempt, the settled code, the code the relay reported
   when refinement changed it, the resource CloudFormation blamed first,
   the relay's error redacted and truncated to 500 characters, at most five
   failed-resource events (cascade cancellations and the stack's own status
   never count), and the version a deploy targeted. `toStructuredEvent`
   derives the AI explainer's bounded event from that context only.
2. **Diagnostics route** — serves the context as `context` and feeds the AI
   (still only for `UNKNOWN`) from it. The web diagnostics mapping carries
   it into the card's "Technical detail" disclosure: operation, attempt,
   the helper's original code, version, failed resource and failed events.
   Nothing new reaches the top level.
3. **Three more deterministic signatures** in `refineFailureCode`, mapped
   onto existing codes: S3 `PermanentRedirect` / "must be addressed using
   the specified endpoint" → `REGION_NOT_SUPPORTED`; ECS "failed container
   health checks" → `IMAGE_HEALTH_CHECK_FAILED`; "essential container in
   task exited" / "exited with code" / out-of-memory →
   `CONTAINER_START_FAILED`. IAM denial and quota keep precedence.

### Tests

- `apps/api/src/failure-context.test.ts` (4): phase/codes/resource/events,
  redaction of tokens and secret-shaped pairs, cancellation noise dropped,
  event cap and reason truncation, the AI event shape.
- `apps/api/src/failure-classification.test.ts` (+3).
- `apps/web/test/diagnostics.test.ts` (+1), `apps/web/test/diagnostic-card.test.tsx` (2).

PR #181.

## Phase 7 — AI deployment failure diagnosis (2026-09-05)

### Audited existing (unchanged)

- AI is consulted only for `UNKNOWN`; every known code is answered from the
  copy map without a model call. The explanation is generated once per
  attempt behind an atomic claim and cached on `deployment_jobs`; every
  failure mode degrades to the deterministic copy. The model's echoed
  failure code is always overridden by the deterministic one.
- The prompt is built from the Phase 6 context only — never raw logs.

### Added

1. **Confidence in the structured output.** `diagnosticExplanationSchema`
   requires `confidence: high | medium | low`; the prompt tells the model
   to mark `high` only when the evidence names the cause directly and to
   name the most relevant failure signal with `low` when it is inferring.
   Malformed output (no confidence, unknown level, extra keys) still fails
   validation and degrades to deterministic copy.
2. **Cache** — `deployment_jobs.ai_explanation_confidence` (migration 0030,
   nullable text; wired into the Lambda migration map). A row cached before
   the column existed is served as `medium`, hedged, rather than dropped.
3. **Route** — `GET /api/deployments/:id/diagnostics` adds `source`
   (`deterministic` | `ai`) and `confidence` (null for deterministic copy).
4. **UI** — the diagnostic card hedges a medium or low AI reading before the
   text ("Deployz could not determine the exact cause. This is its best
   reading of the most relevant failure — treat it as a lead, not a
   verdict.") and names the source under it. Copy lives in
   `@deployz/copy-map` (`AI_CONFIDENCE_COPY`, `AI_EXPLANATION_SOURCE_NOTE`)
   with the web mirror under parity test. Deterministic copy is unchanged.

### Tests

- `packages/analysis/test/diagnostic-explainer.test.ts` (4): schema
  strictness, prompt honesty rule and redaction, confidence returned with
  the deterministic code, older-shaped output rejected.
- `apps/api/src/ai-explanation.test.ts`: the cached text carries the
  confidence.
- `apps/api/src/server.test.ts`: a known code is `deterministic` with no
  confidence.
- `apps/web/test/diagnostics.test.ts` (+1), `apps/web/test/diagnostic-card.test.tsx` (+2),
  `apps/web/test/copy-map-parity.test.ts`.

PR #182.

## Phase 8 — AWS jargon and activity feed audit (2026-09-05)

### Audit

Every user-visible error and status surface was read against the §65 rule
(raw provider vocabulary only behind a disclosure). The rule was already
enforced structurally: `packages/copy-map` translates deployment states,
customer statuses, event types and failure codes; an ESLint rule refuses
raw CloudFormation status literals in `apps/web/src`; the E2E suites assert
jargon-free top-level copy on the readiness, configuration, fleet, billing
and install pages.

| Surface | Top level | Behind a disclosure | Finding |
|---|---|---|---|
| Deployment detail (vendor) | Hero copy from `deriveHero`; activity rows from `eventTypeLabel` + `activityFailureSummary` | "Advanced details" (stack status, failure status, infrastructure events), per-row raw relay error | Compliant |
| Diagnostics card | Copy-map what/why/fix; AI text hedged (Phase 7) | "Technical detail": code, Phase 6 context, event fields | Compliant |
| Install / deploy-link pages (customer) | `customerMessage`; stack status pre-translated by `customerStackStatusLabel` | "Technical details" | Compliant. "Open AWS CloudFormation" names the console the customer must use — intentional |
| Application readiness | Finding titles in user language; detected facts in plain words | "How to fix" technical evidence, per-fact evidence | Compliant |
| Configuration | Environment plan in plain words | — | Compliant |
| Preflight (Phase 5) | Check labels and details in plain words | — | Compliant |
| Fleet / customers / home | Copy-map labels and badges | — | Compliant |
| Toasts and inline errors | Server messages (§65) or the generic fallback | — | Compliant |
| Releases list | **Raw worker text: "CodeBuild reported FAILED — POST_BUILD: …"** | — | **Fixed** |
| Team Admin progress card | Raw `awsStatus` rows | — | Internal operator surface; left as the technical view it is |

### Added

- `releaseBuildFailureSummary` (`@deployz/copy-map`): a deterministic,
  ordered mapping of the stored build failure reason onto plain words
  (ran out of time / could not fetch the repository / could not be stored
  in the registry / could not start / could not be built / failed). The
  releases list shows the summary and keeps the raw reason behind a
  "Technical detail" disclosure. No LLM call — the mapping is a table.

### Tests

- `packages/copy-map/test/copy-map.test.ts`: every branch, never the build
  service's name, never the jargon pattern.

PR #183.

## Phase 9 — Integration, regression and AI quality testing (2026-09-05)

### Evaluation corpus

`packages/analysis/test/eval-corpus.test.ts` is the permanent MVP corpus:
nine repositories with exact, deterministic expectations — readiness state
and the complete finding set (no invented blockers, none missing), the
deployment-gate state, the detected runtime / framework / port / database /
cache / health path with evidence present and bounded, the env-var
classification, and which questions the AI fallback would be asked. It
covers a simple Node app, Next.js + Prisma, PostgreSQL without migrations,
a BullMQ Redis app, a declared local volume, an env-heavy SaaS (Stripe,
SMTP, app secret, optional and sample-only flags), a deliberately broken
configuration (no port, no start command, loopback binding), MySQL, and
an ambiguous repository. Two expectations were corrected against the
analyser's deliberate precision rules while writing it: `PORT` read with a
default is a managed variable, and a bare non-secret read (`host:
process.env.SMTP_HOST`) is optional (Stage A COMP-023) while the credential
stays required.

AI output is tested on structure and gates only (`diagnostic-explainer.
test.ts`, `repository-ai.test.ts`, `ai-explanation.test.ts`, fix-instruction
tests, `ai-live.test.ts` behind `DEPLOYZ_LIVE_AI=1`); CI never depends on
model wording.

### Regression campaign

Run on the merged Phase 7 tree: `pnpm build` (every package), `pnpm vitest
run` (every project — analysis, contracts, copy-map, db, cdk, relay, api,
web, version-canary, repository-compatibility harness), `pnpm lint`, and the
simulated E2E suites touched by the AI phases (readiness, fix-instructions,
config, create-deployment, deployment-detail, scenario-install,
scenario-deploy-link, scenario-sweep, diagnostics, admin,
scenario-provisioning). CI ran the full simulated scenario suite on every
phase PR. No P0/P1 regression remains; the four `apps/web` suites that
failed on this machine before the workstream were a missing local `jsdom`
install, not a defect.

### Cost and latency review

| Call | When | Bound |
|---|---|---|
| Repository analysis | once per analysed commit, only when one of seven questions is open | ≤8 files / 24k chars, 6k prompt / 2.5k output tokens, 30 s |
| Fix instructions | once per commit + analysis version + finding set (cached; explicit regenerate) | 3k / 2.5k tokens, 25 s |
| Failure explanation | once per failed attempt, only for `UNKNOWN` (cached, single-flight) | 700 / 800 tokens, 10 s |
| Preflight, readiness reads, activity feed, lifecycle events, heartbeats | never call the model | — |

No polling loop calls the model; the gateway retries at most once on a
transient error or malformed output.
