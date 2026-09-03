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

## Phase 7 — Repository compatibility expansion (2026-09-02)

Phase 7 expands the ANALYSIS layer for repository compatibility. Runtime
behavior does not change: the existing Phase 3 gates still enforce readiness
from the manifest, and the new findings simply feed those gates. No failure
code, failure-code schema, or failure-code registry changed.

### Audited-existing (verified, changed only where required)

- §10 rejection checks (MySQL/Mongo/Elasticsearch/other DBs) and their
  blocking readiness findings were already precise. `databaseState`
  derivation now ignores non-database rejections (§11.4) so a Kubernetes or
  Terraform repo is never mislabelled as an "unsupported database".
- `manifest.environment.variables` was a plain name list — extended to
  `{ key, required, secret, source }` (§11.2). Every consumer of the field
  (contracts schema, analysis normalization, relay test fixtures, api test
  fixtures) was updated; the relay reads only port/health/migration from the
  manifest, so no relay logic changed.
- Vendor overrides (appRoot, dockerfilePath, buildContext) flowed into
  manifest normalization but NOT into the release build
  (`packages/cdk/src/lambda/worker.ts` read raw detected metadata). The
  release build now honours `manifestOverrides.dockerfilePath/buildContext`.
- Manifest `build.context` defaulted to the app-root directory. It now
  defaults to the repository root (§11.1); a nested Dockerfile is addressed
  by its own path.

### Added

- §11.2 env-var model: `detectEnvVarModel` seeds from env samples, source
  reads (JS/TS, Prisma `env()`, Python `os.environ`, Ruby `ENV.fetch`), and
  §11.3 service keys. `required` is narrow and honest (a value the app reads
  with no fallback/guard and no repository default). The manifest gate
  reports missing required values as `required-env-vars-missing`
  (NEEDS_CONFIGURATION) when the deployment-creation boundary knows which
  values are configured (vendor defaults + customer overrides,
  `listProvidedConfigKeys`).
- §11.3 external services: deterministic detection for Stripe, Clerk, Auth0,
  Resend, SendGrid, SMTP, Sentry, OpenAI, Anthropic, Twilio, Shopify into
  `manifest.externalServices`, each mapped to its well-known keys. Deployz
  collects configuration; it never provisions these services.
- §11.4 unsupported architecture breadth (each NOT_COMPATIBLE with evidence
  in the reason): MySQL/MariaDB breadth, SQLite, Kafka, RabbitMQ, complex
  SQS consumers, Kubernetes, Serverless/SAM, multi-service Docker Compose,
  persistent volumes (PVC/EFS/compose volumes), Terraform, Pulumi, customer
  CloudFormation, Azure, GCP, GPU.
- §11.5 language breadth: PostgreSQL detection for Python (psycopg2),
  Ruby (`pg`), Go (`pgx`/`lib/pq`), S3 via boto3/aws-sdk-s3/Go AWS SDK, and
  persistent filesystem writes in Python and Ruby.
- Monorepo classification: analysis → manifest → readiness for the monorepo
  fixture is covered end to end (nested app root, repo-root build context,
  READY manifest), plus a worker test that the release build follows the
  vendor-corrected Dockerfile/context.

### Verification

Full build passes. Full `pnpm vitest run`: 95 files / 2094 tests pass with no
failed files (the single reported error is the documented Windows
`onTaskUpdate` worker timeout flake; CI is authoritative). Focused suites for
every touched file pass: analysis (334 tests incl. new `phase7.test.ts`),
contracts manifest, relay (417), api server/manifest/analysis, cdk worker.

## Phase 8 — Background worker decision (2026-09-02)

Decision: **Option B**. Deployz defers background worker support. An app that
declares a worker process is needs-adaptation (NOT_COMPATIBLE). The worker
command config surface is disabled. A deployment can no longer silently
ignore a declared worker.

### Decision and evidence

Option A (real worker support) is not a contained extension after the
manifest work. The audit found:

- The published application template is the only infra the relay creates
  stacks from, and it never carries a worker. `synthesizeApplicationStack`
  (quick-create/publish.ts) exposes no worker option; the relay selects
  between two fixed variants by the boolean Redis requirement only
  (relay/src/index.ts). The worker command is a per-app string that a shared
  template cannot bake, and the infra comment in install.ts says exactly
  that: worker command shapes "infrastructure that is fixed at
  template-publish time".
- The ApplicationStack worker branch (worker task + `WorkerService`) is
  synth-time only. No published template and no production caller enables it.
- Every relay module that reads an ECS service takes the FIRST
  `AWS::ECS::Service` physical id (deploy.ts `findServiceArn`,
  config-update.ts, ecs-health.ts, ecs-observe.ts). The deploy rollout, the
  §10.3 promotion gates, and the Phase 4 migration path are single-service
  by construction.

Option A would need a per-app infra model plus dual-service semantics across
the relay, with byte-identical behavior for no-worker apps. That is not
contained. Option B is the decision.

### Audited-existing (unchanged unless stated)

- Worker-code detection (`detectWorker`: bull, bullmq, agenda,
  worker_threads) — kept; it is the requirement evidence.
- `applications.worker_command` column and its analysis auto-write — kept as
  analysis evidence and API read surface; it no longer feeds any gate.
- Manifest schema field `worker.command` — kept for backward-compatible
  strict parsing of stored manifests; normalization now fills it from
  current analysis metadata.
- Single-service relay runtime (deploy/config-update/health/observe/verify,
  stack-resources, destroy) — unchanged. It stays correct because no
  published template provisions a worker.
- The CDK ApplicationStack worker branch — audited and left in place: it is
  unreachable from the published templates and is not a vendor surface.

### Added

1. **Manifest gate** (packages/analysis/src/manifest.ts): normalization now
   records the resolved worker command from CURRENT metadata
   (`resolvedWorkerCommand`, persisted fresh on every analysis), with the
   sticky column as the legacy fallback. Worker code + a declared worker
   command adds an `unsupported` reason, so `evaluateManifestReadiness`
   returns NOT_COMPATIBLE. The Phase 3 deployment-creation gate then refuses
   the deployment with guidance. Worker code WITHOUT a declared command stays
   deployable (worker code with no worker command was already a deliberate
   non-blocking case, and the Redis e2e fixture depends on it).
2. **Readiness report** (packages/analysis/src/readiness-report.ts): worker
   code + resolved command is now the required/blocking finding
   `background-worker-unsupported` (needs-adaptation, state NEEDS_CHANGES).
   Worker code without a command stays the recommended `worker-command`
   finding with corrected copy (no more "so Deployz can run the job
   processor"). The "Background worker detected" passed check is gone.
3. **Current metadata** (apps/api/src/analysis.ts): each analysis stores the
   resolved worker command (or null) in `detected_metadata`, so a repo that
   removes its worker clears the gate on re-analysis.
4. **Disabled config surface**: `workerCommand` was removed from the POST
   and PATCH application bodies and from CONTRACT_FIELDS (apps/api/src/
   server.ts), from the update input type (apps/web/src/lib/applications.ts),
   and from the application details form (apps/web/src/app/dashboard/
   applications/[id]/page.tsx). Analysis still records a detected worker
   command; the vendor can no longer configure one.

No-worker applications behave as before: the gate fires only when a worker
command is declared, and no relay or CDK runtime file changed.

### Verification

- Full `pnpm build`: 9/9 packages pass (turbo; includes the Next.js web
  build with type/lint checks).
- Focused vitest suites pass: packages/analysis (337), apps/api (39 files,
  926 tests), apps/web + packages/contracts + packages/copy-map (391).
- No new failure code and no exhaustiveness registry changed.

Re-analysis is required for an app analysed before this phase: its stored
metadata does not yet carry `resolvedWorkerCommand`, so the manifest falls
back to the sticky column until the next analysis runs.

## Phase 9 — PostgreSQL and S3 hardening (2026-09-02)

Phase 9 makes the supported persistent services (RDS PostgreSQL + S3)
predictable and safe across provision, use, disconnect, and purge. This is
an audit-plus-close-gaps phase. Nothing was changed without a documented
gap; everything already truthful stayed as it was.

### Lifecycle decision: RETAIN (with evidence)

The MVP data lifecycle is **RETAIN, not SNAPSHOT**. The evidence:

- The application template sets `DeletionPolicy: Retain` on the RDS
  `DBInstance`, the `DBSubnetGroup`, and the S3 `Bucket`. `PURGE` deletes
  the retained orphans directly (RDS/ElastiCache/S3 sweep in
  `packages/relay/src/purge.ts`). This is the RETAIN model.
- A stack-header comment claimed "final-snapshot on delete". No code ever
  took a final snapshot (`SkipFinalSnapshot: true` in the relay RDS delete).
  The claim was false; it is removed.
- The customer-facing copy (install security page, disconnect modal) already
  said "retained"; the implementation now matches it.

The documented behavior is now:

- **Disconnect (DESTROY)**: removes the running application and networking.
  The database, its 7-day automated backups, its generated credential
  secrets, and the stored files stay in the customer account. RDS automated
  backups continue while the instance lives. No final snapshot is taken.
  Charges continue.
- **Purge (PURGE)**: deletes the retained database, its credential secrets,
  the stored files (every version), the cache, then the bootstrap stack.

### Audited existing (verified, changed only where a gap was found)

- `AWS_REGION` env binding for S3: already injected alongside
  `STORAGE_BUCKET`/`S3_BUCKET`/`AWS_S3_BUCKET` in the published template and
  asserted by a test. No change.
- The retained-database purge sweep (RDS orphan discovery + delete with
  `SkipFinalSnapshot`) existed. The relay IAM lacked the read grants its
  discovery needs (`rds:DescribeDBInstances`, `rds:ListTagsForResource`);
  they are added (condition-free read statement `RelayPurgeRdsDiscover`).
- The versioned-bucket retained behavior (destroy retains, purge empties
  then deletes every version and delete marker) existed and is unchanged —
  the Phase 5 purge retained-resource handling is not regressed.
- `DeletionPolicy: Retain` on the RDS instance + bucket was already the
  implementation; the copy that claimed a final snapshot was the lie.

### Added

1. **Retained credentials (PostgreSQL gap)**: `DatabaseSecret` and
   `DatabaseUrlSecret` had `DeletionPolicy: Delete` while the database they
   authenticate was retained. A disconnect destroyed the password to a
   database that stayed behind — a retained database nobody could reach.
   Both secrets now use `removalPolicy: RETAIN` so the retained database
   stays reachable with its retained credentials.
2. **Purge credential sweep**: PURGE now deletes the retained DB-credential
   secrets after the retained database is deleted (`SecretsPurgeClient`,
   tag-verified: `deployz:installation` AND `deployz:component=application`).
   The component check keeps the sweep from touching the bootstrap stack's
   own credential secret. New relay IAM: `RelayPurgeSecretsList`
   (condition-free `ListSecrets`/`DescribeSecret` read discovery — a tag
   condition on the ownership read would deny it for every foreign secret in
   the account) and `RelayPurgeSecretsDelete` (`DeleteSecret`,
   resource-tag-conditioned).
3. **SG-scoped database ingress**: the DB security group no longer opens
   port 5432 to the whole VPC CIDR in plain-Fargate mode. A standalone
   `AWS::EC2::SecurityGroupIngress` admits only the application service's
   own security group (and the worker service's SG when a worker exists).
   Express mode keeps the whole-VPC rule because ECS manages its task
   security groups and the template cannot reference them — a documented
   tradeoff, not a silent one. The rule is a standalone ingress resource so
   the DB security group never depends on the app security group (an inline
   source reference would close a deploy-time dependency cycle through the
   task role's secret grants).
4. **S3 lifecycle rules**: the versioned bucket expires non-current object
   versions after 30 days and aborts multipart uploads incomplete after 7
   days. Current versions are never expired. This is cost control on the
   retained bucket.
5. **Truthful classification**: the inventory classifier
   (`packages/contracts/src/infrastructure.ts`) marks the DB credential
   secrets as `retain` (matching their new deletion policy) while
   `SecretTargetAttachment` rows stay `delete`.
6. **Customer copy**: the install Security Details page's deletion steps no
   longer claim the relay removes the database/storage or takes a final
   snapshot; they state the retain-then-purge truth.

### MVP tradeoffs (documented, deliberate)

- **Unconditional PostgreSQL provisioning**: every published template
  provisions the RDS instance; `databaseRequired` is a synth-time prop the
  relay never toggles. Provisioning a database for an app that does not need
  one is an explicit MVP tradeoff, not a silent behavior.
- **Express-mode DB ingress**: whole-VPC CIDR (see above), because ECS
  manages the task security groups.
- **Failed-first-install retry**: recovery deletes the doomed RDS instance
  but now leaves the retained empty credential secrets behind (they are
  `Retain`). A follow-up cleanup can sweep them; they hold no customer data.

### Tests (vitest fakes only, never real AWS)

- `packages/cdk/test/application-stack.test.ts` — new Phase 9 block: RETAIN
  policy on the RDS instance + both credential secrets (and `Delete` on the
  app config secret), no final-snapshot anywhere, S3 lifecycle rules,
  SG-scoped ingress shape in plain Fargate (standalone
  `AWS::EC2::SecurityGroupIngress`), whole-VPC ingress in Express mode, and
  the worker SG ingress.
- `packages/cdk/test/bootstrap-stack.test.ts` — the new purge IAM statements
  exist with the correct action sets, conditions, and inside the permissions
  boundary.
- `packages/cdk/test/artifacts.test.ts` — committed templates match a fresh
  synth (artifacts regenerated via `synth:app` + `synth:bootstrap`).
- `packages/relay/src/purge.test.ts` — the credential sweep deletes owned
  secrets once RDS/bucket are gone, never on the same pass a retained
  database still exists, orders bootstrap-last, and an access-denied while
  reading owned secrets fails the purge retryably
  (`AWS_PERMISSION_DENIED`).
- Snapshot updates (application-stack + bootstrap-stack) eyeballed to the
  intended diff only.

Verification: `pnpm build` (relay, contracts, cdk) passes; the affected
vitest suites pass. One documented Windows `onTaskUpdate` timeout flake
appeared in the bootstrap suite; it is not a failure (CI is authoritative).

## Phase 10 — Runtime failure classification and diagnostics (2026-09-03)

Phase 10 connects the §61 failure taxonomy to real runtime failures. The
audit came first; most of §14 already existed. Only two real gaps were
wired. No failure code, enum, schema, copy-map entry, or classifier rule
was added.

### §14.2 gap matrix

For each plan item: can the live runtime produce the specific code today,
and from which file? "Audited" = already live before Phase 10. "Added" =
wired in Phase 10.

| §14.2 item | Code | Live producer (file) | State |
|---|---|---|---|
| ECR image pull | IMAGE_PULL_FAILED | Migration RunTask stopped reason (`packages/relay/src/deploy.ts`) | **Added** — was unreachable; a pull failure in the migration stage collapsed to MIGRATION_FAILED. Now a CannotPullContainerError / pull-access-denied stopped reason classifies IMAGE_PULL_FAILED. INSTALL-time pull text also refines server-side (audited). |
| Migration | MIGRATION_FAILED | Relay migration exit code (`packages/relay/src/deploy.ts`) | Audited |
| Port mismatch | PORT_MISMATCH | none | Audited gap — no structured signal distinguishes it from a health-check failure or an app crash: the app's real listening port is not observable (no log access by design), and the §29 rule needs it. Honest code for the observed symptom (app started, targets unhealthy) is IMAGE_HEALTH_CHECK_FAILED. No new code added. |
| Health-check failure | IMAGE_HEALTH_CHECK_FAILED | INSTALL: failed AWS::ECS stack event with a health-check reason, refined at `/result` (`apps/api/src/failure-classification.ts`, `server.ts`) | Audited |
| AWS permission denial | AWS_PERMISSION_DENIED / AWS_SCP_BLOCKED | Relay catch sites + server refine (`packages/relay/src/*`, `apps/api/src/failure-classification.ts`) | Audited |
| Quota | QUOTA_EXCEEDED | Server refine from limit text / stack events (`apps/api/src/failure-classification.ts`) | Audited |
| Database provisioning | DATABASE_CREATE_FAILED | Server refine from failed AWS::RDS stack event | Audited |
| Redis provisioning | REDIS_PROVISIONING_FAILED | Server refine from failed AWS::ElastiCache stack event | Audited |
| Relay timeout / disconnect | RELAY_DISCONNECTED / DOMAIN_OPERATION_TIMEOUT | Worker watchdog (`packages/cdk/src/lambda/worker.ts`) | Audited |

Classify-at-ingest (§14.2 gap 1) already existed: `refineFailureCode` runs
server-side at the `/result` route (option b from Phase 0), because relay
code in customer accounts never updates in place. It is kept. The relay
also already classifies at the executor boundary where it holds structured
evidence (MIGRATION_FAILED, AWS_PERMISSION_DENIED, ECS_DEPLOYMENT_FAILED,
STACK_DELETE_FAILED). Phase 10 extended that boundary classification to the
migration stage's image-pull evidence — the one §14.2 class that was
provably unreachable before.

### Added

1. **Migration-stage image-pull classification** (`packages/relay/src/
   deploy.ts`). The migration stage already read the one-off task's
   `stoppedReason`; it only used it as message text and always failed the
   job with `MIGRATION_FAILED`. A stopped reason that names an image-pull
   failure (`CannotPullContainerError`, `pull access denied`, no basic auth
   credentials, failed to pull image) is now reported as `IMAGE_PULL_FAILED`
   — the migration uses the same image as the service update, so the fix
   belongs to registry/grant access, never to "fix the migration". The
   markers mirror the server-side refinement vocabulary in
   `apps/api/src/failure-classification.ts`, so relay and control plane
   agree. The relay test fake was made honest: a task that never started its
   container reports no exit code (previously the fake forced exit code 0,
   which would have misread a pull failure as success).

2. **Diagnostics technical-detail plumbing** (`apps/web/src/lib/
   diagnostics.ts`). The `/diagnostics` endpoint already served the relay's
   verbatim error as `technicalDetail`, but the web client dropped it, so
   the card's expandable "Technical detail" layer was empty on every
   failure. The response is now mapped into the diagnostic event's
   `error.message`, which the existing card disclosure renders. The mapping
   was extracted to an exported pure `toDiagnostics` function so it is
   unit-testable without a fetch seam.

### Audited existing (unchanged)

- The 22-code taxonomy with copy-map remediation and recoverability for
  every code (`packages/copy-map/src/index.ts`, web mirror) — exhaustive
  tests already lock it.
- Diagnostics endpoint serving remediation + recoverability + technical
  detail, deterministic copy first with AI only for UNKNOWN
  (`apps/api/src/server.ts`).
- Customer recovery surface: what/why/what-to-do and retry-when-safe copy
  per code via copy-map + the vendor/customer status projections
  (`apps/api/src/deployment-status.ts`).
- Watchdog codes and INSTALL stack-event refinement (Phase 5 / resilience
  work) — all audited, none changed.

### Tests

- `packages/relay/src/deploy.test.ts` — a migration task stopped with a
  pull-denial reason (no container exit code) fails with
  `IMAGE_PULL_FAILED`, never touches the service, and never defers; a
  genuine migration crash still fails with `MIGRATION_FAILED`.
- `apps/web/test/diagnostics.test.ts` (new) — `toDiagnostics` maps the
  endpoint response: no card when `failureCode` is null; the relay
  technical detail reaches the card's event error message; no error is set
  when none was served.

Verification: `pnpm build` passes for relay; focused vitest suites pass —
`packages/relay` (20 files / 421 tests), `apps/web` (17 files / 259 tests),
`apps/api` failure-classification + failure-semantics + deployment-status +
server (green), `packages/copy-map` (green). No real AWS was used. No new
failure code, enum, migration, copy-map entry, classifier rule, or
remediation count changed.

## Phase 11 — Default HTTPS without customer DNS (2026-09-03)

Phase 11 gives every successful deployment its own HTTPS address and READY
state with ZERO customer DNS input. The customer never owns or configures a
domain. A custom domain, when the customer adds one, keeps working and keeps
precedence.

### Decision: Option A — Deployz-owned hostname per deployment

**Decision:** Option A (`<deploymentId>.apps.deployz.dev`), a per-deployment
ACM certificate requested IN the customer account/region, DNS-validated via
CNAME records in a Deployz-controlled Route53 zone that the CONTROL PLANE
writes itself.

**Evidence:**

- ACM certificates are region+account-bound and cannot be exported. A shared
  wildcard certificate in the Deployz account cannot terminate TLS for ALBs
  in customer accounts. Option B's CloudFront distribution avoids that only
  by inserting a Deployz-account proxy hop in front of a customer-origin
  HTTP ALB.
- The relay already provisions customer stacks only from fixed published
  templates and executes a real CONFIGURE_DOMAIN/REMOVE_DOMAIN vocabulary
  (packages/relay/src/domain.ts): request ACM cert, read the DNS-validation
  record, wire the ALB 443 listener and the port-80 redirect, delete the
  cert on removal. That machinery is account-agnostic — it operates on a
  payload hostname — so a Deployz hostname needs NO relay change.
- The only thing that made the custom-domain flow require the customer was
  the DNS record ownership. Option A moves that ownership to a Deployz
  Route53 zone (referenced by id, out of band) and makes the control plane
  the record writer. This is the single new control-plane surface: a
  scoped `route53:ChangeResourceRecordSets` grant and two record operations
  (upsert/delete a CNAME).
- Option B adds a cross-account CloudFront lifecycle (Phase 5/9 destroy and
  purge must track and delete distributions in the DEPLOYZ account that
  Phase 9's customer-account machinery cannot reach), a second TLS hop, and
  origin-access identity wiring. It is the larger and less contained change
  for an architecture whose teardown machinery is deliberately
  customer-account-shaped.
- Route53 is implemented without a new dependency: `@aws-sdk/client-route-53`
  is not installed in this workspace and Phase 11 must not add one, so the
  record client (apps/api/src/route53-records.ts) signs the Route53 REST
  call with SigV4 using only `node:crypto` and the Lambda-provided
  credentials — the same env-credential idiom apps/api/src/email.ts already
  uses for SES. This is NOT a general DNS platform: one record type (CNAME),
  two operations.

### Audited existing (unchanged)

- Relay CONFIGURE_DOMAIN/REMOVE_DOMAIN executors, ACM/ELB seam and job
  result shapes (packages/relay/src/domain.ts) — reused as-is.
- Custom-domain state machine (`custom_domains`, CONFIGURE_DOMAIN/
  REMOVE_DOMAIN jobs, runDomainCheck, the relay-heartbeat auto-check,
  "Check now") — untouched; custom domains keep full precedence.
- The application template (fixed published artifacts) — unchanged; the 443
  listener is wired at runtime by the relay, never in the template.
- Bootstrap-stack ACM/ELB IAM grants — unchanged; the new flow requests the
  same tag-scoped certificates. One new purge discovery read was ADDED (see
  Teardown below).
- The status derivation's READY rule (installed + healthy + an `https://`
  URL) — reused; this phase simply makes an https URL appear without a
  customer domain.
- Install-progress label honesty: the interim HTTP ALB copy stays exactly as
  it is ("temporary / not secure") until the HTTPS endpoint serves; once the
  default hostname is ACTIVE the customer URL is the HTTPS one.
- Phase 5/9 watchdog coverage for CONFIGURE_DOMAIN / REMOVE_DOMAIN jobs —
  default-HTTPS jobs use the same job types, so the same bounds apply.

### Added

1. **Default-HTTPS state machine** (apps/api/src/default-https.ts). State
   lives on `deployments.default_https` (jsonb, migration `0027`), separate
   from `custom_domains` because it is NOT customer DNS. Statuses mirror the
   custom-domain machine: PENDING -> WAITING_FOR_DNS -> CONFIGURING ->
   ACTIVE (ERROR at any step, automatic retry; REMOVING on destroy).
   Job idempotency keys are namespaced `:default-https:` so the result route
   dispatches default vs custom domain results.
2. **Driver** — the relay heartbeat (the existing ~5-minute cadence the
   custom-domain check already rides) plus one immediate kick after a
   successful INSTALL result. Idempotent: in-flight jobs block duplicates,
   record writes are upserts. While a custom domain is ACTIVE/CONFIGURING the
   driver does not start a wasteful per-deployment cert.
3. **Record API** (apps/api/src/route53-records.ts) — upsert/delete CNAME
   against the deployz Route53 zone. Off unless `DEPLOYZ_DNS_ZONE_ID` is
   configured; under the fixture DNS, a no-op writer is used.
4. **URL precedence** (apps/api/src/fleet-row.ts `resolveAppUrl`, the probe
   URL in server.ts, admin queries): ACTIVE/CONFIGURING custom domain, then
   ACTIVE/CONFIGURING default hostname, then the interim HTTP ALB endpoint.
   The Phase 6 probe therefore verifies the HTTPS URL once it serves.
5. **Status derivation** — the https component and `needsDomainSetup` now
   read the default-HTTPS machine: no customer-action nudge ("set up a
   custom domain") while the default endpoint is progressing on its own.
6. **Teardown** — destroy enqueues a REMOVE_DOMAIN job for the default
   hostname (relay removes the cert + listener); DESTROY success, REMOVE
   success, force-complete and purge each clear the state and best-effort
   delete the deployz-zone records. The relay PURGE now also sweeps orphaned
   ACM certificates (tag-verified, Phase 11 default-HTTPS and custom-domain
   certs alike) after the application stack is gone; the bootstrap stack
   gains one condition-free discovery read `acm:ListCertificates`
   (`RelayPurgeAcmDiscover`) inside the permissions boundary. Bootstrap
   artifact regenerated (`synth:bootstrap`).
7. **Control-plane stack** — `DEPLOYZ_DNS_ZONE_ID` passes to the API Lambda
   and a role grant scoped to that one hosted zone ARN (not route53:*).
8. **Fixture mode** — the simulated E2E harness answers
   CONFIGURE_DOMAIN/REMOVE_DOMAIN with a healthy simulated HTTPS path. The
   automatic flow is an OPT-IN under the fixture DNS
   (`DEPLOYZ_DEFAULT_HTTPS_FIXTURE`): the existing fixture suite is written
   against HTTP-only installs and keeps its behaviour. When the opt-in is
   set, the scenario happy path exercises default HTTPS end to end to READY.

### Verification

- Vitest fakes only, no real AWS: apps/api (default-https state machine over
  PGlite incl. the full migrations, route53 SigV4/XML/not-found semantics,
  deployment-status precedence and https-component additions), packages/relay
  (purge ACM sweep), packages/cdk (bootstrap purge-grant + DeployzStack zone
  env/grant synth tests; artifacts + snapshot regenerated).
- `pnpm build` passes for the touched packages. Full-suite vitest run on the
  affected packages is green (Windows `onTaskUpdate`/EBUSY flakes re-run per
  the Phase 0 discipline; CI is authoritative).
- Constraint: a real (non-fixture) Route53 round trip is validated only by
  the canary/fresh live-AWS policy, never by the default suites.

