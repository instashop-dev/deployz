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

## Phase 3 — Real readiness enforcement (2026-09-02)

Server-side gates at every boundary where a not-yet-provisioned deployment
can be advanced. Phase 2 gated deployment creation; Phase 3 closes the
remaining two boundaries.

- New helper `requireReadyManifest` (`apps/api/src/manifest.ts`): re-reads
  the stored `desired_state.manifest`, re-evaluates readiness, throws 422
  `MANIFEST_NOT_COMPATIBLE` / `MANIFEST_NEEDS_CONFIGURATION` with findings.
- Gate 1 — install link: `POST /api/install/:installLinkId/launched`
  refuses to move a non-READY deployment to `WAITING_FOR_RELAY`.
- Gate 2 — relay registration: `POST /api/relay/register` refuses to
  enroll and mint the first INSTALL job when the stored manifest is not
  READY (the final defensive boundary before AWS provisioning).
- The INSTALL job is only ever created at relay registration, so these
  two gates cover the whole pre-provisioning surface; no worker-side
  duplicate gate was needed.
- Existing deployments without a stored manifest fail closed (422
  MANIFEST_NEEDS_CONFIGURATION) — pre-manifest deployments cannot quietly
  provision.
- Test fixtures updated: DB-seeded deployments in the five suites that
  exercise the gated endpoints now carry a READY manifest.

Deferred within Phase 3 (follow-ups, not blockers):
- Required-env-var readiness findings (manifest `environment.variables`
  is still a name list; needs a `required`/`secret` model first — see
  Phase 7's env-var model).
- Broader unsupported-architecture detectors (Kafka, K8s, Terraform, …)
  ride Phase 7's compatibility expansion.

## Phase 4 — Database migrations as a gated deployment stage (2026-09-02)

A DEPLOY_RELEASE with a migration command runs the migration before the
service update. Without a command, the deploy is exactly as before.

- The deploy payload now carries `migrationCommand` when one resolves: the
  stored manifest's `migration.command` first, else the release row's
  `migrationCommand`. The key is omitted for a no-migration deploy, so that
  payload is byte-for-byte unchanged. Bulk deploys resolve the manifest half
  per target deployment.
- The relay runs the migration as a one-off ECS RunTask BEFORE the service
  update: same cluster, subnets, security groups, image digest and
  env/secrets as the app service, command overridden, no load balancer. It
  polls DescribeTasks until STOPPED. Exit code 0 continues the normal
  task-definition registration and service update.
- A non-zero exit fails the job with `MIGRATION_FAILED`; the error carries
  the exit code and stoppedReason (never raw log bodies — the relay role
  still has no `logs:GetLogEvents`).
- On MIGRATION_FAILED the deployment state, `currentReleaseId` and
  `previousReleaseId` are untouched — the previous release keeps running.
- A migration that outlives one invocation is resumed by task ARN on later
  polls (same pending-marker pattern as the rollout). The marker also
  records the registered task-definition ARN, so a resumed deploy never
  registers a second copy, and a completed migration is never re-run.
- ROLLBACK deploys the old digest WITHOUT running migrations — schema
  changes are never auto-reversed (noted in the executor).
- The relay's bootstrap-stack IAM gains a condition-free `ecs:RunTask`
  grant (RunTask is evaluated against cluster + task definition + further
  untagged resource ARNs); `iam:PassRole` for the task roles was already
  granted. PassRole for the task roles lives in the relay's deploy policy.
- Progress ladder: a new `MIGRATION` step sits between the cache (REDIS)
  and the application in the contracts schema, the API derivation and the
  web step copy. It appears in the applicable list only for applications
  with a migration command; a MIGRATION_FAILED deploy names that step.
- Tests are vitest fakes only: migration success proceeds to the service
  update, non-zero exit fails with MIGRATION_FAILED leaving pointers and
  the service untouched, no-command deploys behave as before, rollback
  never runs migrations, and the ladder includes Migration.

## Phase 5 — Delete, purge, and disconnect lifecycle correctness (2026-09-02)

Phase 5 closes the remaining lifecycle gaps around delete (DESTROY), purge
(PURGE), the disconnect force-complete escape hatch, relay-reset tracking,
and the relay-liveness gates. It adds behavior ONLY where the plan (§9)
identified gaps; everything already correct was audited and left in place.

### Already existed (audited, not reimplemented)

- Tag-checked DESTROY with DELETE_FAILED recovery and the destroy resumer
  (`packages/relay/src/destroy.ts`).
- PURGE with the tag-refusal guard, retained-resource cleanup (RDS /
  ElastiCache / S3), pending debt, and the purge resumer
  (`packages/relay/src/purge.ts`).
- Force-complete for a stale DESTROY on a relay confirmed DISCONNECTED,
  and purge eligibility (`SKIPPED_RELAY_OFFLINE`), in
  `apps/api/src/disconnect-force-complete.test.ts`.
- `POST /api/deployments/:id/relay/reset` (re-enrollment flow).
- Custom-domain jobs (`CONFIGURE_DOMAIN` / `REMOVE_DOMAIN`) in
  `apps/api/src/domains.ts`.
- The watchdog (`sweepStuckJobs` in `packages/cdk/src/lambda/worker.ts`)
  already covered INSTALL, DEPLOY_RELEASE, ROLLBACK, RESTART, CONFIG_UPDATE,
  DESTROY and PURGE timeouts.
- `deploymentStateAfterFailedJob` already returned `null` for a failed
  PURGE, so a DELETED deployment was never resurrected to FAILED by the
  relay-result path.

### Added

1. **Purge ownership (§9.1)** — the bootstrap/relay stack never carries a
   `deployz:installation` tag (the id is minted inside it after creation),
   so the old tag-refusal guard made the bootstrap removal never run. The
   purge now deletes the bootstrap stack by its KNOWN NAME (baked into the
   relay environment as `Ref AWS::StackName`). The application stack and
   orphan resources still verify the tag. A permission failure
   (AccessDenied / UnauthorizedOperation / 403) while reading orphan tags
   is now classed as a retryable `AWS_PERMISSION_DENIED` failure — it is
   NEVER silently treated as "resource does not exist" (the old behavior
   reported `purged: true` while resources remained).

2. **Cleanup state separation (§9.2)** — new `cleanup_state` value
   `PURGE_FAILED` (migration `0025`). A failed PURGE keeps the deployment
   `DELETED` and records the failure on `cleanupState` (both on the relay
   result route and the watchdog). The purge route now accepts
   `PURGE_FAILED` as retryable. The web banner "resources may remain" now
   also shows for `PURGE_FAILED`.

3. **Watchdogs (§9.3)** — `CONFIGURE_DOMAIN` and `REMOVE_DOMAIN` now have
   the generous 60-minute staleness / 90-minute runtime bounds. A stuck
   domain job is failed with the new `DOMAIN_OPERATION_TIMEOUT` code
   (live relay) or `RELAY_DISCONNECTED` (dead relay after grace), the
   deployment state is never touched (domain lifecycle is separate), and
   the custom-domain row records the failure on `lastError` so the next
   heartbeat nudge opens a fresh retry cycle.

4. **Force-complete (§9.4)** — the escape hatch now also covers repeated
   DESTROY failures on a relay still online: two or more FAILED DESTROY
   jobs whose newest is the deployment's newest job, with the latest
   failure older than `DESTROY_PENDING_STALE_AFTER_MS`, settle to `DELETED`
   + `SKIPPED_RELAY_OFFLINE` with event reason
   `REPEATED_DESTROY_FAILURE` (honest "resources may remain").

5. **Relay liveness gates (§9.5)** — deploy, rollback and restart now
   refuse `409 RELAY_NOT_CONNECTED` (no relay bound) or
   `409 RELAY_DISCONNECTED` (bound but dead) before queuing a job,
   mirroring retry-install. Bulk deploy skips DISCONNECTED targets with a
   reason. `PUT /api/applications/:id/config` with a customer scope whose
   deployment relay is DISCONNECTED refuses `409 RELAY_DISCONNECTED`.

6. **Relay reset tracking (§9.6)** — new columns
   `previous_installation_id` and `previous_bootstrap_stack_name`
   (migration `0025`). `relay/reset` records the identifiers it replaces,
   the re-enrollment event carries them, and the purge job payload passes
   them so the old stack's retained resources stay attributable to the
   deployment instead of being silently orphaned. (The relay's IAM cannot
   delete old-stack resources by design, so this is a control-plane
   attribution record, not a new relay capability.)

### Tests

One focused test per gap, all vitest fakes (no real AWS):

- `packages/relay/src/purge.test.ts` — permission failure → retryable
  `AWS_PERMISSION_DENIED` (never success); bootstrap stack deleted by name
  even untagged / mismatched-tag.
- `apps/api/src/failure-semantics.test.ts` — failed PURGE via relay result
  → deployment stays `DELETED`, `cleanupState` becomes `PURGE_FAILED`.
- `apps/api/src/disconnect-force-complete.test.ts` — failed PURGE retry
  (route-level 202) and force-complete on repeated DESTROY failures (live
  relay) + single-failure refusal.
- `packages/cdk/test/worker.test.ts` — stuck CONFIGURE_DOMAIN →
  `DOMAIN_OPERATION_TIMEOUT`, deployment unchanged, domain `lastError` set.
- `apps/api/src/server.test.ts` — deploy/rollback refuse on
  disconnected / unbound relays; config PUT refuses on a dead relay;
  `relay/reset` records previous identifiers (+ event payload).
- `apps/web/test/diagnostic-vocabulary.test.ts` +
  `packages/copy-map/test/copy-map.test.ts` — failure-code list widened to
  22 with the new code.

Full build (`pnpm build`) and the full vitest suite pass (93 files; one
known Windows `onTaskUpdate` timeout flake, no real failure).

## Phase 6 — Runtime health and promotion correctness (2026-09-02)

Phase 6 adds the HTTP application probe and makes release promotion wait for
every health gate. The plan (§10) is here; all tests use vitest fakes, never
real AWS. No new failure code was added, so no registry changed.

### Already existed (audited, not reimplemented)

- Honest ALB target interpretation in the heartbeat: healthy, pending
  (`initial`/`draining`), unknown, and unhealthy counts plus the ECS rollout
  state (`packages/relay/src/ecs-health.ts`, Phase 1.3).
- ECS counts, rollout state, target counts, and the running image digest in
  the heartbeat's observed state (`packages/relay/src/poll.ts`, index.ts).
- `settleEcsDeploy` deferred a rollout that outlived one invocation through
  the pending marker, and waited for the digest to run with the full task
  count (`packages/relay/src/deploy.ts`).
- The control-plane heartbeat handler (INSTALLING to HEALTHY, self-healing
  of a FAILED-but-running deployment, rollout-failure events) and the digest
  reconciliation of the release pointer (`apps/api/src/server.ts`).
- Layer inputs already stored: infrastructure verification
  (`observedState.infraHealth`), rollout and target fields (observed state),
  relay connectivity (`deployments.relay_status`).
- The unified status derivation (`apps/api/src/deployment-status.ts`).

### Added

1. **HTTP probe (§10.2)** — new `packages/relay/src/http-probe.ts`. Each
   poll the relay GETs the deployment's probe URL and records status code,
   latency, and check time. A timeout or unreachable host is a FAILED check,
   never UNKNOWN-forever. The response body is never read. The probe URL is
   built server-side (latest INSTALL ALB endpoint + the manifest-derived
   health path) and passed in each poll's deployment meta; the control plane
   maintains `lastSuccessAt`/`lastFailedAt` across heartbeats in
   `observedState.httpProbe`.

2. **Layered health (§10.1)** — the derivation now exposes five separate
   layers in the vendor status (`health.layers`): infrastructure (verifier
   verdict), ECS rollout state, ALB target counts, the HTTP probe record,
   and relay connectivity. Each layer reports only what its own source
   observed; a failing app never appears as a target or rollout problem.
   New schema `runtimeHealthLayersSchema` in `@deployz/contracts`.

3. **Promotion gate (§10.3)** — two changes, matching the plan's split:
   - The relay now settles a deploy only when the digest runs, the task
     count is full, the PRIMARY rollout state is COMPLETED, and every ALB
     target is healthy. Any other state stays `in-progress` through the
     pending marker (`packages/relay/src/deploy.ts`, new ELB seam).
   - The control plane no longer advances the release pointer on the
     DEPLOY_RELEASE/ROLLBACK job result. The heartbeat's digest
     reconciliation advances it only when that same heartbeat shows rollout
     COMPLETED, full counts, healthy targets, and a successful HTTP probe
     (`apps/api/src/server.ts`). A partially rolled-out or failing release
     is never promoted.
   - Phase 1.3's INSTALLING-to-HEALTHY heartbeat behavior is unchanged.
   - A failed update still preserves the previous release and pointer.

4. **Rollback** — uses the same settle path and never runs migrations
   (Phase 4 behavior unchanged; regression-tested).

### Tests (focused, per gap)

- `packages/relay/src/http-probe.test.ts` — records code/latency/time;
  non-2xx and transport/timeout failures are failed checks; a bodyless
  response is enough (the body is never read).
- `packages/relay/src/deploy.test.ts` — never settles while the primary
  rollout is IN_PROGRESS or while targets register; settles once COMPLETED
  and healthy.
- `packages/relay/src/poll.test.ts` — the probe record rides the heartbeat's
  observed state; a failed probe is reported, never dropped; malformed meta
  is ignored.
- `apps/api/src/digest-reconciliation.test.ts` — promotion blocked when the
  rollout is incomplete, targets are pending, or the probe fails; promotion
  advances when all gates pass; probe timestamps persist across heartbeats
  with no body ever stored.
- `apps/api/src/deployment-status.test.ts` — the five layers are visible
  separately, never collapsed.
- `apps/api/src/server.test.ts` and `deploy-contract.test.ts` — pointer
  advance moves from the job result to the gated heartbeat; a failed update
  keeps the previous release pointer.

Full build (`pnpm build`) passes; relay, contracts, api and web vitest
suites pass with the changed fixtures.
