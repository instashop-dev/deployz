# Deployz MVP — Implementation Status

Phase 0 boundary-mvp baseline. Purpose: record a trustworthy test baseline,
map the live runtime flow, and separate live code from dead or unwired
implementations. No product behavior changed; this document only records.

- Branch: `omos/boundary-mvp` (fast-forwarded to `origin/main` @ `fe9b5a6`)
- Date: 2026-09-02
- Environment: Windows, Node 24, pnpm 10.12.4

## Baseline

Commands (in this order, matching `.github/workflows/ci.yml`):

1. `pnpm install --prefer-offline` — OK (741 packages, lockfile unchanged).
2. `pnpm build` — OK, 9/9 packages (turbo). Next.js build warnings only
   (jose Edge-runtime warning, missing Next ESLint plugin). No errors.
3. `pnpm vitest run` (from repo root) — the full suite.

Full-suite result after build:

- Test files: 75 passed, 11 failed-to-collect (collection error, no verdict),
  1 skipped (119 total).
- Tests: 1681 passed, 2 skipped, 0 failed.
- All 11 failed-to-collect suites failed with the same environment error:
  `EBUSY: resource busy or locked` while transforming `@sentry/*` files in
  the shared pnpm store (`.pnpm/@sentry+core|server-utils@10.70.0`). This is
  Windows parallel-worker file-lock contention on the shared node_modules
  store, not a product failure. One `vitest-worker: onTaskUpdate` timeout
  accompanies it (same load cause).
- Re-running exactly those 11 suites by path (serially): 232 passed,
  1 skipped, 0 failed. Every previously-failing suite passes in isolation.
- Skipped tests are environmental by design:
  - `packages/analysis/test/ai-live.test.ts` — 2 tests, skipped unless
    `DEPLOYZ_LIVE_AI=1` (live AI gateway).
  - `apps/api/src/billing.test.ts` — 1 test, skipped unless a real Stripe
    test-mode key and `RUN_STRIPE_CLOCK` are set.
- Live-AWS suites (`packages/cdk/test/*-live-aws.test.ts`,
  `*-live.test.ts`) are not part of the default run; they require AWS
  credentials and are covered by the separate canary/fresh E2E policy in
  `docs/testing/`.

Baseline verdict: green. The only failures observed were the documented
Windows EBUSY file-lock flake; every affected suite passes on retry. The
same suite would run clean on the Ubuntu CI (see `.github/workflows/ci.yml`,
which builds first — the `Failed to resolve entry for @deployz/*` failures
that appear when running `pnpm test` without `pnpm build` are the missing
`dist/` outputs, not test failures).

## Live Runtime Flow

Two actors:

- **Control plane** (vendor AWS account), deployed by `packages/cdk/bin/
  deployz.ts` → `DeployzStack` (`packages/cdk/src/deployz-stack.ts`):
  API Lambda (`src/lambda/api-handler.ts` → `@deployz/api` `buildServer`),
  worker Lambda (`src/lambda/worker.ts` + `worker-handler.ts`), SQS queue,
  CodeBuild pipeline (`src/pipeline/build-pipeline.ts`), public template
  bucket, DynamoDB durable-execution infra (constructed, no workflows — see
  Dead/Unwired).
- **Customer-side** (`packages/cdk/bin/bootstrap.ts` → `BootstrapStack`
  `src/bootstrap/bootstrap-stack.ts`): relay Lambda
  (`src/lambda/relay-handler.ts` → `@deployz/relay`) on a 5-minute
  EventBridge schedule, communicating with the control plane **egress-only**
  (relay calls OUT; the control plane never reaches into the customer
  account). Bootstrapped credential lives in Secrets Manager; the id,
  enrollment code, template URL and execution role are baked into the stack.

Per-area live paths (control-plane → relay, with the job channel between):

- **Analysis** — `POST /api/applications/:id/analyse` (`apps/api/src/
  server.ts`) → `enqueue({type:'ANALYSE_APPLICATION'})` (`apps/api/src/
  queue.ts`, SQS) → worker Lambda → `runApplicationAnalysis`
  (`apps/api/src/analysis.ts`), the only caller of `@deployz/analysis`
  (deterministic rules `rules.ts`, readiness `readiness-report.ts`, optional
  AI gateway `fix-instructions.ts`/`repository-ai.ts`). Result persisted to
  `applications.analysisStatus/detected_metadata`; reads via
  `GET /api/applications/:id/readiness` and the fix-instructions route.
- **Application persistence** — `POST /api/applications`
  (`server.ts:1914`): GitHub-installation ownership check, one-application-
  per-repo guard, insert row (`analysisStatus: 'PENDING'`). Follow-ups
  `PATCH/DELETE /api/applications/:id`, config `GET/PUT
  /api/applications/:id/config`.
- **Install link** — `POST /api/deployments` creates the deployment with a
  single-use `enrollmentCode` + `installLinkId`. `GET
  /api/install/:installLinkId` (public) renders the page: resource list,
  `WAITING_FOR_RELAY` handling, and a **Quick Create URL built server-side**
  (`buildBootstrapQuickCreateUrl`, `src/quick-create/`) from
  `resolveBootstrapTemplate(region)` — the bootstrap template published by
  `src/quick-create/publish.ts`. `POST .../launched` moves
  `NOT_INSTALLED → WAITING_FOR_RELAY`; `POST .../retry` mints a fresh
  enrollment code and bumps the attempt. `GET .../status` serves the
  customer-only projection of the unified status derivation.
- **Relay registration** — relay's first poll calls
  `POST /api/relay/commands` (after `registerInstallation` in
  `packages/relay/src/auth.ts` → `POST /api/relay/register`). Registration
  looks up the deployment by **enrollment code** (burned on first use),
  binds `installationId` + relay token hash, creates the first
  `INSTALL` job (`createOrReuseJob`, `apps/api/src/jobs.ts`, idempotent on
  `idempotencyKey`), sets `INSTALLING`. Replays are harmless; takeover
  attempts get `409 RELAY_ALREADY_ENROLLED` (recovery via
  `POST /api/deployments/:id/relay/reset`).
- **INSTALL** — control plane: job row `REQUESTED → RUNNING` on claim
  (`GET /api/relay/commands`). Relay: `createInstallExecutor`
  (`packages/relay/src/index.ts`) → `installApplicationStack`
  (`src/install.ts`) creates the published application template as a
  CloudFormation stack (tagged `deployz:installation`, idempotent, timed
  budget), cloudformation-progress events streamed via
  `POST /api/relay/commands/:id/progress` (`src/provision-progress.ts`),
  then `verifyInstallation` (`src/verify.ts`) independently confirms stack +
  resources before `success:true`. Long creates are deferred into the SSM
  pending-command record and re-settled each poll by `createInstallResumer`.
  Result → `POST /api/relay/commands/:id/result` → job `SUCCEEDED`,
  deployment `HEALTHY`. First-install failure recovery
  (`src/recover.ts`) on the vendor `retry-install` route.
- **DEPLOY_RELEASE** — `POST /api/deployments/:id/deploy` (or
  `deploy-bulk` fan-out) → `requireDeployableRelease` builds the payload
  (image repository + digest, from a built release) → `DEPLOY_RELEASE` job.
  Relay: `createEcsDeployExecutor` (`src/deploy.ts`) — reads the ECS service
  through the stack, registers a new task definition whose application
  container image is pinned to `repository@sha256:…`, updates the service,
  and idempotently settles on the digest. Progress and result ride the same
  command channels.
- **Heartbeat** — every 5-minute poll, outside any command: relay observes
  verification (`createObserveHook`), runtime health (`src/ecs-health.ts`),
  running digest (`src/ecs-observe.ts`), provisioning snapshot while the
  stack builds, and posts `POST /api/relay/health`. Control plane persists
  `observedState`, `healthStatus`, identity/capabilities (self-repair),
  liveness (`lastHealthAt`), emits health-change events, and recovers a
  FAILED-but-running deployment to HEALTHY (except after DESTROY).
- **Config update** — `PUT /api/applications/:id/config` → worker
  (`CONFIG_UPDATE` case in `worker.ts`) fans out one `CONFIG_UPDATE` job per
  deployment. Relay fetches effective config from
  `GET /api/relay/config` and applies it via `createConfigUpdateExecutor`
  (`src/config-update.ts`: new task definition with changed environment).
- **Rollback** — `POST /api/deployments/:id/rollback` → `ROLLBACK` job →
  the same `createEcsDeployExecutor` with the previous release's
  repository@digest. `RESTART` uses `createRestartExecutor`.
- **Destroy** — `POST /api/deployments/:id/destroy` → `DESTROY` job →
  `createDestroyExecutor` (`src/destroy.ts`): tag-checked stack delete with
  DELETE_FAILED recovery, stack-events progress, deferred resume
  (`createDestroyResumer`). Success sets deployment `DELETED` and force-
  removes any dangling custom-domain row.
- **Purge** — `POST /api/deployments/:id/purge` → `PURGE` job →
  `createPurgeExecutor` (`src/purge.ts`): tag-refusal guard, removes
  retained resources (RDS/cache/S3 leftovers) and finally the bootstrap
  stack itself, deferred while deletions are in flight. Success sets
  `cleanupState: 'COMPLETE'` (deployment stays `DELETED`).

Supporting live machinery: unified status derivation
(`apps/api/src/deployment-status.ts`), stack-event progress
(`apps/api/src/stack-event-progress.ts`, `packages/relay/src/stack-events.ts`),
step timings (`step-timings.ts`), diagnostics/fix-instructions
(`apps/api/src/fix-instructions.ts`, `packages/analysis/src/remediation.ts`
— this is the LIVE remediation table; see the classifier note below),
domains (`packages/relay/src/domain.ts`), web app at `apps/web`.

## Dead/Unwired Subsystems

Examined on 2026-09-02 against the flow above. "Dead" = no production
caller outside its own tests.

- **`packages/cdk/src/jobs/*` (11 files)** — `install-workflow.ts`,
  `deploy-release-workflow.ts`, `config-update-workflow.ts`,
  `destroy-workflow.ts`, `rollback-workflow.ts`, `health-monitor.ts`,
  `event-emitter.ts`, `notifications.ts`, `preflight.ts`,
  `preflight-engine.ts`, `region-enforcement.ts`. Reachable only from their
  own tests (`packages/cdk/test/*.test.ts`). Nothing in `src/`, the API, or
  the relay imports them. The live equivalents are the relay executors
  listed above.
- **`packages/cdk/src/durable/*`** — the durable-execution runtime
  (`durable-runtime.ts`, `durable-handler.ts`) and its CDK construct
  (`durable-stack.ts`, `DurableExecution`) **are deployed** as part of
  `DeployzStack`, but no workflow implementation is ever registered or
  started against it. Zero live durable workflows. Production durability is
  the relay's SSM pending-command record, not this framework.
- **`packages/cdk/src/analysis/*`** — `failure-classifier.ts`,
  `ai-explainer.ts`, `diagnostic-explainer.ts`, `remediation.ts`,
  `rules.ts`, `diagnostic-event-schema.ts`. No production caller. The live
  analysis packages are `packages/analysis` + `apps/api/src/analysis.ts`;
  live failure-code → remediation mapping is
  `packages/analysis/src/remediation.ts` (already wired into the
  diagnostics endpoint).
- **Unwired preflight engine** — `jobs/preflight-engine.ts` has no caller;
  `jobs/preflight.ts` only contributes its `ALLOWED_REGIONS` constant to the
  live-AWS test harness (`integration/regions.ts`). The live deploy-time
  gates are the relay's `verifyInstallation` (`verify.ts`) and the
  busy/idempotency gates in `apps/api/src/jobs.ts` + `deploy-contract`.
- **Unwired failure classifier** — `analysis/failure-classifier.ts`
  (maps raw AWS errors to failure codes) has no caller. The live failure
  vocabulary is `failureCodeSchema` in `@deployz/contracts` (drives the
  relay result/event model and the remediation lookup). A port of the
  classifier belongs in `packages/relay` or `@deployz/analysis` — see
  decisions below.
- **Unwired ECR grant logic** — `pipeline/ecr-grants.ts`
  (`grantPull`/`revokePull`/`buildRepoPolicyDocument`) is exported from
  `packages/cdk/src/index.ts` but has **no production caller**. The design
  comment says INSTALL time grants the customer ECS cross-account pull on
  the vendor ECR and DESTROY time revokes it. Today the publish/deploy path
  carries `imageRepository@digest` in the command payload, but nothing ever
  grants the customer task role access to that repository. The pipeline
  itself (`build-pipeline.ts`, `source-fetch.ts`) IS live inside
  `DeployzStack`; only the cross-account grant half is unwired.
- **`packages/cdk/src/integration/*`** — canary/fresh live-AWS E2E harness
  (`runner.ts`, `regions.ts`, `scp-blocked.ts`, `teardown.ts`, …).
  Test-only by policy (`docs/testing/`).

## Phase 0 Decisions

1. **Do not wire dead orchestration code.** The relay executors are the
   live runtime; `jobs/*` durable workflows and the durable framework stay
   unwired. No runtime rewiring in Phase 0.
2. **Port candidates (mark, do not move yet)**:
   - `analysis/failure-classifier.ts` → into `packages/relay` (classify at
     the executor boundary) or `@deployz/analysis` (pure classification next
     to `failure-codes.ts`, consumed by the diagnostics endpoint).
   - `jobs/preflight-engine.ts` + `preflight.ts` checks → fold into
     `verify.ts`/`install.ts` as pre-install gates.
   - `pipeline/ecr-grants.ts` → wire `grantPull` into the INSTALL success
     path and `revokePull` into DESTROY/PURGE (control-plane side, since
     the customer account id is known there).
3. **Keep as deployed-but-idle**: `DurableExecution` in `DeployzStack`
   (harmless, zero workflows) until the port decision above lands.
4. **No product behavior changed**: Phase 0 added only this document.
5. **Test discipline**: always run `pnpm build` before `pnpm vitest run`
   (CI order); treat Windows `EBUSY` suite-collection failures as a
   re-run, not a red. Gate on the re-run result.
## Phase 1.1 � ECR pull grants + auto-deploy on install (2026-09-02)

Wired the previously-dead ECR grant logic into the live flow, control-plane side.

- `pipeline/ecr-grants.ts` moved to `apps/api/src/ecr-grants.ts` (Phase 0
  decision #2: grants belong next to the customer-account knowledge, i.e. the
  API). `@deployz/cdk` re-exports it for compatibility; unit tests moved
  with it (`apps/api/src/ecr-grants.test.ts`).
- INSTALL requested (relay register + retry-install) `->`
  `grantPullToCustomer` (idempotent, best-effort).
- DESTROY/PURGE result success `->` `revokePullFromCustomer` (idempotent).
- INSTALL result success `->` auto-enqueues a digest-pinned DEPLOY_RELEASE
  for the newest READY release of the application, using the same
  idempotency key as the manual deploy route. The deployment state is NOT
  advanced (stays INSTALLING until the relay's runtime-health verification
  earns HEALTHY).

Edge cases (deliberate):
- Grant/revoke failures never fail the caller (logged; a missing grant
  surfaces as the customer task's IMAGE_PULL_FAILED at deploy time).
- A failed INSTALL leaves the grant in place; retry-install re-grants
  idempotently. Revoke happens only on DESTROY/PURGE success (or purge after
  force-complete, when the stack is gone).
- Force-complete (dead-relay DESTROY escape hatch) does NOT revoke: the
  customer stack may still exist mid-delete; PURGE is the real teardown.
- No READY release at INSTALL success `->` no auto-deploy (nothing
  deployable yet).
- A vendor deploy of the same release races nothing: the auto-queued job
  reuses the existing idempotency key.
- API Lambda gains scoped ECR policy IAM (ecr:Get/Set/DeleteRepositoryPolicy
  on the pipeline repository only).
