# AI application analysis, preflight and failure diagnosis

The reference for the P0/P1 AI capabilities of the Deployz MVP: how a
repository becomes a validated application model, how that model gates
deployment, and how a failed deployment is explained. The per-phase record
with tests and PRs is `docs/ai-mvp-implementation-status.md`.

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
  → AI fallback ONLY for one of seven unresolved questions; merge is
    deterministic-always-wins
  → ApplicationAnalysis (canonical, typed, evidenced)
  → ReadinessReport (findings) · DeploymentManifest (contract)
  → Preflight gate at every path into provisioning
  → Deterministic engine: release build, INSTALL, DEPLOY_RELEASE, config
  → AWS (customer account, through the relay only)
  → Structured job results, CloudFormation events, heartbeats
  → refineFailureCode → DeploymentFailureContext
  → Copy-map explanation; AI explanation only for UNKNOWN, with confidence
  → Vendor and customer UI (plain words; raw detail behind disclosures)
```

## Repository analysis

- **Orchestrator:** `runApplicationAnalysis` (`apps/api/src/analysis.ts`).
  Fetches a bounded file tree, runs `analyseRepo` (`packages/analysis/src/
  analyser.ts`), applies the AI fallback when needed, builds the readiness
  report and the canonical projection, backfills the §35 contract fields the
  vendor has not edited, and persists everything in one write to
  `applications.detected_metadata`.
- **Commit cache:** a run is skipped when `analysisCommitSha` and
  `analysisVersion` match the stored ones. `ANALYSIS_VERSION` must be
  bumped whenever detector output or the projection changes shape, so
  stored rows re-run.
- **Detectors** (`packages/analysis/src/detectors.ts`): Dockerfile,
  framework, port (six tiers), health endpoint, env vars, PostgreSQL
  (required vs present), local filesystem, worker, S3, migration command,
  start command, external services, package manager, build command,
  **runtime** (Dockerfile base image, then the shallowest manifest) and
  **bind address** (loopback-only servers). Redis is assessed separately
  with confidence and purpose. Rejections (`rejection.ts`) name the
  unsupported architectures.
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

Ids: `unsupported-database-*`, `unsupported-redis-setup`,
`unsupported-architecture`, `unsupported-message-queue`,
`unsupported-multi-service`, `unsupported-persistent-volume`,
`unsupported-gpu`, `local-file-storage`, `background-worker-unsupported`
(blocking); `container-setup`, `port-unresolved`, `start-command-missing`,
`health-check`, `localhost-binding` (required); `database-migrations`,
`worker-command` (recommended). `reconcileReadiness` applies the vendor's
container port and start command as a view, so the page, the persisted
verdict and the fix instructions agree without a re-analysis.

Adding a rule: add the finding in `readiness-report.ts` (id, copy, severity,
confidence), a test in `readiness-report.test.ts`, and — when the deployment
gate must enforce it — the matching check in `manifest.ts` /
`preflight.ts`. Bump `ANALYSIS_VERSION`.

## Fix instructions

`POST /api/applications/:id/fix-instructions` builds a deterministic
document (facts, per-finding Problem / Why this matters / Detected /
Desired outcome / Confidence, guardrails, validation, completion report)
around AI guidance per finding. The document is cached on the row keyed by
commit, analysis version, facts and findings; `{regenerate: true}`
bypasses. A resolved finding never reaches the document.

## Environment variables

`detectEnvVarModel` decides `required` and `secret` with high precision;
`classifyEnvVariables` (`env-classification.ts`) decides who supplies the
value:

| Classification | Rule | Delivery |
|---|---|---|
| `deployz_managed` | the names the stack injects for THIS app (DATABASE_*, the Redis bindings, STORAGE/S3 bucket, AWS_REGION, PORT, HOSTNAME) | at install |
| `deployz_generated` | required + secret + app-internal name (…SECRET, SECRET_KEY(_BASE), ENCRYPTION_KEY, SIGNING_KEY, APP_KEY, SALT…), no third-party prefix, no connection suffix, not a catalog credential | minted once by the relay with `crypto.randomBytes` inside the customer's account |
| `customer_required` | every other required key | the vendor, on the configuration screen |
| `optional` | read with a default | optional |
| `unknown` | declared only in a sample file | listed, never required |

The first configuration pass runs after a successful INSTALL (one
CONFIG_UPDATE job, key names only). The relay binds only secret keys whose
value exists and reports `unboundSecretKeys`; the control plane never stores
secret values, so a secret entered before the customer's relay is connected
must be entered again from that deployment's configuration.

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
3. **Explanation** — every known code is answered from the copy map without
   a model call. Only `UNKNOWN` asks the AI, with the structured event
   derived from the context, a strict `{what, why, fix, confidence}` schema,
   the deterministic code always overriding the echoed one, one generation
   per attempt cached on `deployment_jobs`, and deterministic copy on any
   failure. Confidence below `high` is hedged on the card ("Deployz could
   not determine the exact cause…").

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
  finding set, one explanation per failed attempt with an UNKNOWN code.
  Never on the deploy button, never per lifecycle event, never in a loop.

## Testing AI changes

- Deterministic corpora: `packages/analysis/test/eval-corpus.test.ts` (nine
  archetypes with exact expectations), `application-analysis.test.ts`,
  `env-classification.test.ts`, `readiness-report.test.ts`, and the
  100-repository Stage A audit (`pnpm benchmark:compat`).
- AI boundaries: schema/gate tests with fake gateways
  (`repository-ai.test.ts`, `diagnostic-explainer.test.ts`,
  `apps/api/src/ai-explanation.test.ts`, `fix-instructions` tests); the
  live gateway test (`ai-live.test.ts`) runs only with `DEPLOYZ_LIVE_AI=1`
  and asserts structure, never wording.
- Changing a prompt or schema: keep `.strict()`, add the fixture-mode
  answer in `apps/api/src/ai-fixture.ts` if E2E needs it, and never assert
  on model prose in CI.
