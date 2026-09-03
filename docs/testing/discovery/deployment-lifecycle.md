# Discovery: deployment lifecycle and state machine

Point-in-time investigation (2026-09-01) that informed the Phase 1 E2E architecture.
File paths and line numbers are as of branch `claude/deployz-phase1-e2e-testing-d6512e`
(HEAD `1c712f9`, merge of PR #67 "cloudformation-progress-polling"); they can drift.
For the resulting architecture, see `../e2e-testing.md`.

## 1. DB Schema

Drizzle schema lives in `packages/db/src/schema/*.ts`; enums in `packages/db/src/enums.ts`; SQL migrations in `packages/db/drizzle/0000..0022`.

### `applications` (`packages/db/src/schema/core.ts:23-52`)
Vendor-created app record. Key columns: `analysisStatus` (`analysis_status` enum: `PENDING|ANALYZING|COMPLETE|FAILED`), `compatibilityStatus` (`compatibility_status` enum: `READY|NEEDS_ATTENTION|NOT_COMPATIBLE`), `compatibilityReason`, `detectedMetadata` (jsonb — holds the readiness report, checks, dockerfilePath), `databaseRequired/storageRequired/redisRequired` booleans, `containerPort`, `healthPath`, `migrationCommand`.

### `releases` (`core.ts:54-79`)
Immutable version record. `buildStatus` (`build_status`: `PENDING|BUILDING|SUCCEEDED|FAILED`), `releaseStatus` (`release_status`: `BUILDING|READY|FAILED`), `imageDigest` (`repository@sha256:...`), `currentBuildId` (CodeBuild build-attempt pin), `failureReason`. Unique on `(applicationId, version)`.

### `customers` / `applicationConfigs` (`core.ts:81-119`)
Per-vendor customer records and vendor-default/customer-override config KV (`isSecret` flag).

### `deployments` (`packages/db/src/schema/deployments.ts:14-81`)
The central row. `state` — `deployment_state` enum (§46, `enums.ts:51-62`):
```
NOT_INSTALLED, WAITING_FOR_RELAY, INSTALLING, HEALTHY, UPDATING,
UPDATE_AVAILABLE, FAILED, DISCONNECTED, DELETING, DELETED
```
(`DISCONNECTED` is a valid enum value nothing currently writes — handled defensively in `deployment-status.ts:759-766`.)

Other key columns: `relayStatus` (`relay_status`: `CONNECTED|DISCONNECTED|UNKNOWN`), `healthStatus` (`health_status`: `UNKNOWN|HEALTHY|DEGRADED|UNHEALTHY`, defaults `UNKNOWN`), `currentReleaseId`/`previousReleaseId`, `observedState` (jsonb — relay heartbeat payload, `infraHealth.provisioning`, `components`, `runningImageDigest`), `stepTimings` (jsonb, write-once per-`DeploymentStep` `{startedAt, completedAt?}`), `installLinkId`/`enrollmentCode`/`enrollmentUsedAt`/`installationId` (three separate identifiers, §12), `attemptNumber`/`bootstrapStackName`/`installStartedAt` (retry isolation), `relayTokenHash`/`relayBoundAt` (sha256-only credential binding), `cleanupState` (`cleanup_state`: `SKIPPED_RELAY_OFFLINE|COMPLETE`, null on a normal disconnect).

### `deploymentJobs` (`packages/db/src/schema/jobs.ts:13-57`)
§39 unit of relay work. `type` — `job_type` enum (`enums.ts:67-82`):
```
INSTALL, DEPLOY_RELEASE, ROLLBACK, RESTART, CONFIG_UPDATE, DESTROY,
MIGRATION, INFRA_UPGRADE, HEALTH_REPORT, PREFLIGHT, HEALTH_CHECK,
CONFIGURE_DOMAIN, REMOVE_DOMAIN, PURGE
```
`state` — `job_state` enum: `REQUESTED, QUEUED, WAITING, RUNNING, SUCCEEDED, SUCCESS, FAILED, CANCELLED`. `idempotencyKey` unique. `failureCode` — `failure_code` enum (22 values, e.g. `STACK_CREATE_FAILED`, `ECS_DEPLOYMENT_FAILED`, `REDIS_PROVISIONING_FAILED`). `lastProgressAt` is the watchdog's timeout clock (not `updatedAt`). AI-explanation-cache columns (`aiExplanationState/What/Why/Fix`) are per-attempt, separate from job state.

### `deploymentStackEvents` (`packages/db/src/schema/stack-events.ts:10-30`)
Raw CFN `DescribeStackEvents` rows the relay reports mid-install/destroy. Unique on `(deploymentId, providerEventId)` for idempotent ingestion. Diagnostics only — "never an input to lifecycle decisions" (comment, line 7).

### `deploymentResources` (`packages/db/src/schema/deployment-resources.ts:25-53`)
Last-complete snapshot per CFN resource (vendor-facing inventory, PR #66). `componentKind` (`infrastructure_component_kind`: `application|database|storage|cache|endpoint|network|monitoring|container_registry|other`), `resourceRole` (`primary|supporting`), `lifecyclePolicy` (`infrastructure_lifecycle`: `delete|retain|snapshot|conditional`), `resourceStatus` (product-mapped) vs `rawResourceStatus` (verbatim AWS). Upserted idempotently per relay heartbeat by `persistDeploymentResourceSnapshot` (`packages/db/src/deployment-resources-persist.ts`).

### `eventLogs` (`packages/db/src/schema/events.ts:19-34`)
§40 append-only audit stream, immutability enforced by a Postgres trigger (`drizzle/0001_event_logs_immutable.sql`). No FKs, no `updatedAt`. `eventType` is a free-text family (`install.*`, `deploy.*`, `rollback.*`, `destroy.*`, `health.*`, ...).

## 2. Deployment state machine

**Persisted lifecycle** = `deployments.state` (10 values above). **Derived 6-stage progress model** (never persisted) is computed at read time by `apps/api/src/deployment-status.ts::deriveDeploymentStatus` — stages: `WAITING_FOR_AWS, CONNECTING, PROVISIONING, VERIFYING, READY, FAILED` (`packages/contracts/src/index.ts:277-284`), further broken into 10 `DeploymentStep`s (`AWS_SETUP, RELAY_CONNECT, PREPARING, NETWORK, DATABASE_STORAGE, REDIS, APPLICATION, HEALTH_CHECK, TLS, READY` — `contracts/src/index.ts:298-328`).

### Transitions and their triggers (all in `apps/api/src/server.ts` unless noted)

| From → To | Trigger | Code |
|---|---|---|
| (insert) `NOT_INSTALLED` | Vendor `POST /api/deployments` | `server.ts:2180-2220` |
| `NOT_INSTALLED` → `WAITING_FOR_RELAY` | Customer `POST /api/install/:installLinkId/launched` (clicked "Deploy to AWS") | `server.ts:1528-1573` |
| `NOT_INSTALLED`/`WAITING_FOR_RELAY` → `INSTALLING` | Relay `POST /api/relay/register` (first enrollment; also creates the `INSTALL` job) | `server.ts:3736-3866` |
| `INSTALLING`/any → `HEALTHY` (INSTALL success) | Relay `POST /api/relay/commands/:id/result` for an `INSTALL`/`DEPLOY_RELEASE`/`ROLLBACK`/`RESTART` job, `success:true` (`JOB_SUCCESS_STATE`, `server.ts:905-911`) | `server.ts:3921-4066` |
| any live state → `FAILED` | Job result `success:false`, or worker watchdog timeout (`sweepStuckJobs`) | `server.ts:3965-3969`; `packages/cdk/src/lambda/worker.ts:434-487` |
| `FAILED` → `HEALTHY` | Relay heartbeat reports `healthStatus: HEALTHY` while `currentReleaseId != null` and latest job isn't `DESTROY` (self-healing "state_recovered") | `server.ts:4244-4299` |
| `HEALTHY` → `UPDATE_AVAILABLE` | Vendor `POST /api/applications/:id/releases` (new release created) — flips every `HEALTHY` deployment of that app | `server.ts:2421-2433` |
| `HEALTHY`/`UPDATE_AVAILABLE` → `UPDATING` | `markJobRequested` on `deploy`/`rollback`/`restart` when `BULK_DEPLOYABLE_STATES.has(state)` | `server.ts:2471-2502`, `2534/2664/2696` |
| `UPDATING` → `HEALTHY` | Same job-result path as INSTALL | `server.ts:3969` |
| any (not `DELETED`) → `DELETING` | Vendor `POST /api/deployments/:id/destroy` (creates `DESTROY` job) | `server.ts:2705-2787` |
| `NOT_INSTALLED`/`WAITING_FOR_RELAY` → `DELETED` directly (no job) | Same destroy route — nothing to remove, no relay to ask | `server.ts:2719-2742` |
| `DELETING` → `DELETED` | `DESTROY` job succeeds | `server.ts:3991-4017` (also force-clears any dangling custom domain) |
| `DELETING` → `DELETED`, `cleanupState=SKIPPED_RELAY_OFFLINE` | Vendor `POST /api/deployments/:id/disconnect/force-complete` (relay confirmed `DISCONNECTED` and DESTROY job stale past `DESTROY_PENDING_STALE_AFTER_MS`) | `server.ts:2797-2899` |
| `NOT_INSTALLED` (re-arm) | Vendor `POST /api/deployments/:id/relay/reset`, only if never successfully installed | `server.ts:2964-3025` |
| `INSTALLING` (retry) | Vendor `POST /api/deployments/:id/retry-install` on a `FAILED` deployment that never succeeded an install (authorizes destructive AWS-side cleanup) | `server.ts:3038-3163` |

`relayStatus` (`CONNECTED/DISCONNECTED/UNKNOWN`) is a **separate** column from `state`, written by: relay heartbeat → `CONNECTED` (`server.ts:4255`); worker's 15-min sweep → `DISCONNECTED` after `RELAY_STALE_AFTER_MS` (15 min) silence (`sweepRelayLiveness`, `worker.ts:500-520`). `healthStatus` is masked to `UNKNOWN` for display whenever `relayStatus==DISCONNECTED` (`relay-liveness.ts:29-34`), but the **stage** is never regressed by a disconnected relay — it retains the last confirmed stage (`deployment-status.ts:784-790`).

`deriveDeploymentStatus` precedence (`deployment-status.ts:744-821`): (1) `state==FAILED`→`FAILED`; (2) `everInstalled` (state ever `HEALTHY/UPDATING/UPDATE_AVAILABLE`, or `currentReleaseId` set, or a succeeded INSTALL job exists) → `READY` (healthy+HTTPS) or `VERIFYING`; (3) latest INSTALL job `RUNNING/WAITING` → `PROVISIONING`; (4) relay registered (`enrollmentUsedAt`/`relayBoundAt` set, or `state==INSTALLING`) → `CONNECTING`; (5) else → `WAITING_FOR_AWS`.

## 3. Jobs / background processing

Two separate execution surfaces:

**A. API Lambda → SQS queue → Worker Lambda** (`apps/api/src/queue.ts`, `packages/cdk/src/worker-lambda.ts`, `packages/cdk/src/lambda/worker.ts`, `worker-handler.ts`). Queue messages: `ANALYSE_APPLICATION`, `BUILD_RELEASE`, `CONFIG_UPDATE` (`queue.ts:17-32`). Without `JOB_QUEUE_URL` configured, `enqueue()` returns `false` and callers run work inline (local dev/tests).
- SQS event source, batch size 5, `reportBatchItemFailures: true` (`packages/cdk/src/worker-lambda.ts:70-75`).
- **EventBridge rule** `WatchdogSchedule`: `Schedule.rate(15 minutes)` invokes the same worker Lambda (`worker-lambda.ts:81-85`). Handler routes it to three sweeps (`worker-handler.ts:161-179`):
  - `sweepStuckJobs` — fails any `REQUESTED/QUEUED/WAITING/RUNNING` job whose `lastProgressAt` (falling back to `startedAt`/`createdAt`) exceeds its type's timeout (`JOB_TIMEOUTS_MS`, `worker.ts:412-423`: INSTALL 60min, DEPLOY_RELEASE/ROLLBACK/RESTART/CONFIG_UPDATE 20min, DESTROY has **no** timeout by design — settled via force-complete instead). Fails the job AND sets `deployments.state='FAILED'`.
  - `sweepRelayLiveness` — flips `relayStatus` to `DISCONNECTED` past `RELAY_STALE_AFTER_MS` (15 min).
  - `sweepStuckBuilds` — 30-min timeout; polls CodeBuild directly via `batchGetBuilds` for releases stuck `BUILDING`.
- **EventBridge rule** `BuildStateRule` (`packages/cdk/src/deployz-stack.ts:263-273`): CodeBuild state-change events (`SUCCEEDED|FAILED|STOPPED|FAULT|TIMED_OUT`) → worker → `recordBuildResult` writes `releases.imageDigest`/`releaseStatus`.

**B. Relay poll loop** (in the customer's AWS account, EventBridge-scheduled every 5 minutes — `packages/cdk/src/bootstrap/bootstrap-stack.ts:1153-1155`). `packages/relay/src/poll.ts::pollOnce` — per tick: (1) register if not enrolled, (2) resume any deferred command via `resume()`, (3) `GET /api/relay/commands`, (4) execute each via `dispatchCommand`, (5) `POST /api/relay/health` heartbeat (always, even with zero commands).

**C. A third, unwired system** exists: `packages/cdk/src/durable/` ("U1 Durable Function spike") + `packages/cdk/src/jobs/*-workflow.ts` (`install-workflow.ts`, `deploy-release-workflow.ts`, `rollback-workflow.ts`, `destroy-workflow.ts`, `config-update-workflow.ts`, `health-monitor.ts`, `preflight-engine.ts`). These implement an async-generator durable-workflow pattern over a DynamoDB-backed runtime, deployed by `DurableExecution` in `deployz-stack.ts:276-284`. **Confirmed not referenced anywhere in `apps/api/src`** — a standalone piece of infrastructure, not part of the live deployment_jobs/relay-poll path. Treat it as experimental/inert for simulation purposes.

## 4. Progress/steps derivation (PR #64 "richer steps" / PR #67 "CFN progress polling")

Two parallel provisioning-snapshot producers feeding the same shape, `observedState.infraHealth.provisioning = { stackStatus, observedAt, categories: { network|database|storage|redis|application: { status, startedAt?, completedAt? } } }`:

1. **Relay-computed, via heartbeat** (`packages/relay/src/provision-progress.ts::summarizeProvisioning`) — reads `DescribeStackResources` already fetched for verification; categorizes by CFN type prefix; pure/synchronous. Written into `observedState` on every `POST /api/relay/health` while the stack is mid-create (only when `stack-exists` passed and `stack-complete` failed — `packages/relay/src/index.ts::createObserveHook`, lines 1255-1290).
2. **Event-driven, via the stack-events ingest route** (`apps/api/src/stack-event-progress.ts::summarizeStackEvents`) — replays persisted `deployment_stack_events` rows (latest event per resource wins; `DELETE_*`/`ROLLBACK_*` events are "debris" and never regress a completed category or mark one FAILED — lines 61-107). Called from `POST /api/relay/commands/:id/progress` (`server.ts:4126-4165`) whenever the INSTALL job is `RUNNING`/`WAITING`.

The relay collects raw events via `packages/relay/src/stack-events.ts::createStackEventCollector` — pages `DescribeStackEvents` backward, stops at a cursor (`resumeAfter`/`operationStartedAt` boundary), reverses to oldest-first, batches ≤50 to `POST /api/relay/commands/:id/progress`. Called from inside `installApplicationStack`'s wait loop via the `onPoll` hook (`packages/relay/src/install.ts:154-161, 269-325`) — same 5-second poll cadence as the CFN `DescribeStacks` wait loop, "never a second timer." For DESTROY, `onPoll` fires at most once per invocation/resume tick (`packages/relay/src/destroy.ts:224-227, 320-322`).

Read-time derivation (`apps/api/src/deployment-status.ts`):
- `provisioningLadderStep` (lines 613-625): first of `NETWORK → DATABASE_STORAGE(if req) → REDIS(if req) → APPLICATION` not yet `COMPLETE`.
- `snapshotFailedStep` (632-644): earliest category marked `FAILED` — "the only ladder question that stays answerable while a stack rolls back."
- `snapshotRollingBack` guard (line 832-833): if `stackStatus` matches `/ROLLBACK|DELETE/`, the ladder is suppressed (would otherwise show the step "regressing") — falls back to `PREPARING` unless a category genuinely `FAILED`.
- **Step timing persistence**: `apps/api/src/step-timings.ts::advanceStepTimings` — write-once into `deployments.stepTimings`; active step gets a `startedAt`; earlier steps get `completedAt`. Skipped entirely on `FAILED`/removed. Fires a `deployment.step_completed` event log per newly-completed step. Called after every job-result write and every heartbeat (`advanceStepTimingsAfterWrite`, `server.ts:842-892`, called at lines 4056, 4160, 4379).
- **Duration/ETA**: `TYPICAL_STEP_DURATION_SECONDS` (`packages/contracts/src/index.ts:340-351`) is the **only** source of "usually takes N minutes," hand-tuned per step (e.g. `REDIS: {min:480,max:1200}` for ElastiCache). `takingLongerThanUsual` (`deployment-status.ts:899-906`) fires once elapsed time on the active step passes `max`, suppressed during rollback or when `statusUpdatesUnavailable`. **No percentage anywhere** — the model is deliberately semantic/step-based, never a numeric progress bar.

## 5. Customer install flow end-to-end

1. Vendor creates a customer deployment → row inserted `NOT_INSTALLED`, mints `installLinkId` (UUID, in the URL) and `enrollmentCode` (single-use secret, never in the URL) — `server.ts:2180-2220`.
2. Customer opens `/install/:installLinkId` (`apps/web/src/app/install/[installLinkId]/page.tsx`). Server-fetches `GET /api/install/:installLinkId` (`server.ts:1349-1475`) which returns publisher/app/customer names, resources-to-be-created list, and — if not yet installed — a **Quick Create URL** built server-side by `buildBootstrapQuickCreateUrl` (region-specific bootstrap template, carries the enrollment code as a CFN parameter, never a credential in the URL itself).
3. Customer clicks "Deploy to AWS" → client posts `POST /api/install/:installLinkId/launched` (idempotent) → `state: NOT_INSTALLED → WAITING_FOR_RELAY`, records `installStartedAt`/`bootstrapStackName` (`server.ts:1528-1573`) → the browser navigates to the AWS Console CloudFormation Quick Create page.
4. Customer approves the stack in their own AWS account. The **bootstrap stack** (`packages/cdk/src/bootstrap/bootstrap-stack.ts`) provisions: a relay Lambda, a Secrets Manager secret for its bearer token, IAM roles scoped via the `deployz:installation` tag condition, and a 5-minute EventBridge schedule.
5. Relay's first invocation: reads its credential from Secrets Manager, calls `POST /api/relay/register` with `{enrollmentCode, installationId, awsAccountId, relayVersion, ...}`. Control plane validates the enrollment code (single-use — a second party presenting a different token/installationId gets `409 RELAY_ALREADY_ENROLLED`), binds `relayTokenHash` (sha256 only), sets `state: → INSTALLING`, and creates the first `INSTALL` job (idempotency key `${deploymentId}:INSTALL`) — `server.ts:3736-3866`.
6. Relay polls `GET /api/relay/commands` → picks up `INSTALL` (job moves `REQUESTED→RUNNING`) → runs `createInstallExecutor` (`packages/relay/src/index.ts:735-818`): `CreateStack`/adopt-existing → poll `DescribeStacks` every 5s up to a time budget (default 180s, `install.ts:178-179`), reporting stack events on each tick → on success independently re-verifies via `verifyInstallation` (never trusts CFN's own "COMPLETE" alone) → reports result to `POST /api/relay/commands/:id/result`.
   - If the stack outlives the Lambda invocation, the executor writes a "pending" marker (SSM Parameter Store, `packages/relay/src/pending.ts`) and returns `deferred: true` (no result reported yet) — the **next poll's `resume()`** (`createInstallResumer`) picks it back up until it settles.
7. On `INSTALL` success: `deployments.state → HEALTHY`. On failure: `→ FAILED` with a `failureCode`.
8. **Web polling**: `InstallProgress` component (`apps/web/src/components/install-progress.tsx`) uses `useStatusPoll` (`apps/web/src/lib/use-status-poll.ts`) hitting `GET /api/install/:installLinkId/status` (unauthenticated, `server.ts:1483-1520`, returns `toCustomerDeploymentStatus`). Cadence: **5s** while non-terminal, **60s** once terminal (`isTerminal`), exponential backoff on failure (cap 30s), immediate refresh on tab-visibility-change, keeps last-good value through transient failures rather than showing a lifecycle regression (`use-status-poll.ts:76-106`).

## 6. Update / rollback / disconnect / delete

**Update (deploy):** Vendor `POST /api/applications/:id/releases` → inserts release `BUILDING`, enqueues `BUILD_RELEASE` → worker fetches repo via GitHub App token, uploads source to S3, starts CodeBuild (`packages/cdk/src/lambda/worker.ts:139-222`) → CodeBuild EventBridge state-change → `recordBuildResult` sets `imageDigest`/`releaseStatus: READY` (build-attempt-pinned via `currentBuildId`, stale/duplicate events ignored, `worker.ts:310-384`) → **every `HEALTHY` deployment of that application flips to `UPDATE_AVAILABLE`** (`server.ts:2425-2433`). Vendor triggers `POST /api/deployments/:id/deploy` (single) or `POST /api/applications/:id/deploy-bulk` (fan-out, one job per target, `server.ts:2547-2634`) → creates `DEPLOY_RELEASE` job → `state → UPDATING` if it was `HEALTHY`/`UPDATE_AVAILABLE` (`markJobRequested`, `BULK_DEPLOYABLE_STATES`). Relay's `createEcsDeployExecutor` (`packages/relay/src/deploy.ts`) discovers the ECS service through the CFN stack (never hardcoded), registers a new task-definition revision with the immutable `repository@sha256:...` digest, calls `UpdateService`, waits for rollout to stabilize (bounded/resumable like install). On job success, `currentReleaseId ← payload.releaseId`, `previousReleaseId ← old currentReleaseId` (`RELEASE_ADVANCING_JOBS`, `server.ts:913-914, 3970-3973`), `state → HEALTHY`.

**Rollback:** `POST /api/deployments/:id/rollback` with `{releaseId}` (typically a previous release) → same idempotent-job path, type `ROLLBACK`, same `createEcsDeployExecutor` (shared with deploy — "the only difference is which release the control plane derived the payload from," `packages/relay/src/deploy.ts:1-8`). **Restores image + task/service config only — never reverses DB migrations**. A rollback ECS deployment the circuit-breaker reports `FAILED` fails with `ECS_DEPLOYMENT_FAILED`, never a false success.

**Restart:** `POST /api/deployments/:id/restart` → `RESTART` job, no release-pointer change, `createRestartExecutor` forces a new ECS rolling deployment of the current task definition.

**Disconnect/Destroy:** `POST /api/deployments/:id/destroy` → `NOT_INSTALLED`/`WAITING_FOR_RELAY` deployments are deleted immediately with no relay job (nothing to remove); otherwise creates a `DESTROY` job, `state → DELETING`, and kicks off `removeCustomDomain` alongside it if one exists (`server.ts:2705-2787`). Relay's `settleDestroy` (`packages/relay/src/destroy.ts:84-180`): reads-before-writes — absent stack ⇒ success (idempotent), `DELETE_IN_PROGRESS` ⇒ deferred, refuses to delete a stack not tagged with this installation's id. **Data-preserving by default**: a normal `DeleteStack` lets CloudFormation's own per-resource retention policies keep DB/storage/backups; only on `DELETE_FAILED` **and** `dataDeletionAuthorized===true` (set only when the control plane proved the deployment *never* completed a successful install, `server.ts:2751-2764`) does the relay clear orphaned RDS/ElastiCache blockers outright (`clearDeleteBlockersAndRetryDelete`, `packages/relay/src/recover.ts`). Job success → `state: DELETED`, `deletedAt` set, any dangling custom domain force-removed as a safety net (`server.ts:4004-4017`).

**Stuck-relay disconnect:** if the DESTROY job's relay never answers (`relayStatus: DISCONNECTED`, confirmed by the 15-min liveness sweep) and the job has been pending past `DESTROY_PENDING_STALE_AFTER_MS`, vendor can `POST /api/deployments/:id/disconnect/force-complete` — cancels the job, sets `state: DELETED`, `cleanupState: SKIPPED_RELAY_OFFLINE` (explicitly **not** claiming AWS resources were removed, `server.ts:2789-2899`).

**Retained-resources purge:** `POST /api/deployments/:id/purge` — only eligible when `state===DELETED && cleanupState===SKIPPED_RELAY_OFFLINE` — creates a `PURGE` job; relay re-verifies ownership of every leftover resource before deleting (`packages/relay/src/purge.ts`). Success sets `cleanupState: COMPLETE` (`server.ts:4019-4027`) — the deployment `state` itself never moves (already `DELETED`).

## 7. Health monitoring & readiness

**Deployment health (post-install runtime signal, distinct from lifecycle `state`):** relay computes it every heartbeat via `observeRuntimeHealth` (`packages/relay/src/ecs-health.ts`) — reads ECS `DescribeServices` + ELB `DescribeTargetHealth` off resources discovered through the CFN stack (never hardcoded names); a resource is included only once its CFN record reached a *complete* status (guards against stale ARNs from a rolled-back stack, lines 121-125). Pure verdict function `deriveHealthStatus` (lines 76-85):
- `rolloutFailed` → `UNHEALTHY`
- `runningCount===null||desiredCount===null` → `UNKNOWN`
- `runningCount===0` or all targets unhealthy → `UNHEALTHY`
- fully running (`runningCount>=desiredCount`) and 0 unhealthy targets → `HEALTHY`
- any unhealthy targets (but still serving) → `DEGRADED`

Per-component health (`application/loadBalancer/database/storage/redis`) rides in `POST /api/relay/health`'s `components` field; database/storage/redis have **no runtime probe** — they report `HEALTHY` purely from "CFN says the resource completed" (IAM-frugality — `ecs-health.ts:186-193`). API-side, `apps/api/src/deployment-status.ts::mergeComponentState` (lines 68-98) merges this observed map with the relay's `infraHealth.checks` verification results into `HEALTHY/DEGRADED/UNHEALTHY/UNKNOWN/NOT_PROVISIONED` per component, feeding `ComponentProgress` (`READY/IN_PROGRESS/PENDING/FAILED/NOT_REQUIRED`) shown on both the fleet dashboard and the install page.

`deployments.healthStatus` is written only by `POST /api/relay/health` (`server.ts:4224-4266`) and is masked to `UNKNOWN` for display whenever the relay is stale/disconnected (`relay-liveness.ts::deriveHealthStatus`) — but this masking never regresses the persisted `state` or the derived `stage`.

**"Semantic readiness" (PR #63)** is a **separate concept** — pre-deployment application compatibility, not runtime health. `GET /api/applications/:id/readiness` (`server.ts:2087-2092`) → `computeReadiness` (`server.ts:667-713`) reads `applications.detectedMetadata`/`compatibilityStatus`, producing a `ReadinessResponse` with `state: READY|ALMOST_READY|NEEDS_CHANGES|ANALYSIS_INCOMPLETE` (`packages/analysis/src/readiness-report.ts:35`), `findings[]` (severity `required|blocking` vs `recommended`), and `passed[]` checks. Purely deterministic from the analyser output — the AI layer (`packages/analysis/src/fix-instructions.ts`) only turns unresolved findings into a coding-agent prompt via `POST /api/applications/:id/fix-instructions`; it never adds/removes/resolves findings itself.

## 8. Web UI — where deployment state is read

- **Vendor fleet dashboard**: `apps/web/src/app/dashboard/deployments/page.tsx` — lists `GET /api/deployments` rows (each carries a `deploymentStatus` = `VendorDeploymentStatus` via `toVendorDeploymentStatus`).
- **Vendor deployment detail**: `apps/web/src/app/dashboard/deployments/[id]/page.tsx` — uses `useStatusPoll` against `GET /api/deployments/:id`; renders `DeploymentStatusBadge`, `DeploymentHero` (the state-aware headline chosen by `apps/web/src/lib/deployment-hero.ts::deriveHero` from `state` + `deploymentStatus` + `jobs`, with the install step list and a collapsed relay/job/stack detail list), `InfrastructureSummary` (one row per service, expanding into `InfrastructureSection`'s resource inventory, PR #66), `ActivityFeed` (event log, newest first), and — under the collapsed "Advanced details" — the AWS identifiers plus `InfrastructureEvents` (stack-events timeline, gated by `stage`). A failed inventory/activity request degrades its own section only; the page renders as long as the deployment itself loads.
- **Vendor diagnostics**: `apps/web/src/app/dashboard/deployments/[id]/diagnostics/page.tsx` — `fetchDiagnostics` + `fetchDeployment`, renders `DiagnosticCard` (what/why/fix + raw §61 code behind an expandable technical section).
- **Stack events data fetch**: `apps/web/src/lib/stack-events.ts:12` → `GET /api/deployments/:id/stack-events`.
- **Resource inventory / infra components**: `apps/web/src/components/infrastructure-section.tsx`, `infrastructure-events.tsx`.
- **Customer install page**: `apps/web/src/app/install/[installLinkId]/page.tsx` (server component, `dynamic='force-dynamic'`) — three render branches by server state: `waitingForRelay`, `alreadyInstalled` (covers CONNECTING→READY→FAILED via `InstallProgress`), and the pre-launch "what will happen" explainer. Client polling lives in `apps/web/src/components/install-progress.tsx` + `apps/web/src/lib/use-status-poll.ts`.
- **Security details** sub-page: `apps/web/src/app/install/[installLinkId]/security/page.tsx`.

## 9. Clock / time abstraction

There is **no single injected `Clock` service** — each pure module takes its own optional `now` parameter, defaulting to a fresh `Date`/`Date.now()` call at the real call site:

- `apps/api/src/deployment-status.ts::deriveDeploymentStatus` — `input.now?: Date`, defaults `new Date()` (line 757); used **only** to compute `takingLongerThanUsual` (line 899-906) — one of only two documented clock exceptions in the module (the other being the `updatedAt` fallback, line 933).
- `apps/api/src/step-timings.ts::advanceStepTimings(previous, derived, now: Date)` — required (non-defaulted) parameter; the one call site (`server.ts:867`) passes `new Date()` directly.
- `packages/cdk/src/lambda/worker.ts` — `sweepStuckJobs(db, now: Date = new Date())`, `sweepRelayLiveness(db, now: Date = new Date())`, `sweepStuckBuilds(deps, now: Date = new Date())` — all three watchdog sweeps take an injectable `now`.
- `packages/relay/src/install.ts::InstallOptions` — `now?: () => number` (defaults `Date.now`) and `sleep?: (ms) => Promise<void>` (defaults real `setTimeout`) — both injectable, used to drive the bounded wait loop deterministically in tests.
- `packages/relay/src/destroy.ts::DestroyDeps.now?: () => string` (defaults `() => new Date().toISOString()`), used only for the pending-marker's `startedAt`.
- `packages/relay/src/provision-progress.ts::buildProvisioningSnapshot(cfn, stackName, now: () => string = () => new Date().toISOString())`.

**Direct, non-injected `Date.now()`/`new Date()`** calls that matter for progress/ETA and are **not** parameterized (candidates a simulated-clock harness would need to intercept): `server.ts:1411` (`relayStuck` staleness check against `RELAY_STALE_AFTER_MS`), `server.ts:2841` (force-complete's `pendingMs` vs `DESTROY_PENDING_STALE_AFTER_MS`), `server.ts:3069` (retry-install's `INSTALL_JOB_STALE_AFTER_MS` freshness check), `server.ts:4365` (custom-domain auto-check throttle), and the relay's own default `now`/`sleep` closures when no override is supplied (`packages/relay/src/index.ts` production wiring passes no overrides).
