# Discovery: AWS integration boundary

Point-in-time investigation (2026-09-01) that informed the Phase 1 E2E architecture.
File paths and line numbers are as of branch `claude/deployz-phase1-e2e-testing-d6512e`
(HEAD `1c712f9`); they can drift. For the resulting architecture, see `../e2e-testing.md`.

Two populations exist, clearly separated by *where the code runs*:

- **Control plane** (`apps/api`, `packages/cdk/src/lambda/*`, `packages/cdk/src/jobs/*`, `packages/cdk/src/quick-create/*`, `packages/cdk/src/pipeline/*`) — runs in Deployz's own AWS account (API Lambda, worker Lambda, publisher scripts).
- **Customer-side relay** (`packages/relay/src/*`, bundled by CDK into a Lambda deployed *into the customer's account* by the bootstrap stack) — this is the only code that ever touches the customer's AWS resources.

## 1. Every AWS SDK client instantiation and API call

### 1a. Relay (customer account) — `packages/relay/src`

| File:Lines | SDK package | Client | Commands | Purpose |
|---|---|---|---|---|
| `index.ts:23-32` | `@aws-sdk/client-ecs` | `ECSClient` | `ListTasksCommand`, `DescribeTasksCommand` (167-192, lazy `getEcsTaskReader`) | digest observation |
| `index.ts:23-32,243-380` | `@aws-sdk/client-ecs` | `ECSClient` | `DescribeServicesCommand`, `DescribeTaskDefinitionCommand`, `RegisterTaskDefinitionCommand`, `UpdateServiceCommand`, `ListTasksCommand`, `DescribeTasksCommand` (`getEcsDeployClient`, `getEcsServiceReader`) | DEPLOY_RELEASE/ROLLBACK/RESTART/CONFIG_UPDATE write path, health/service reads |
| `index.ts:33-36,267-284` | `@aws-sdk/client-elastic-load-balancing-v2` | `ElasticLoadBalancingV2Client` | `DescribeTargetHealthCommand` | target-health reads (`getTargetHealthReader`) |
| `index.ts:37,1540-1548` | `@aws-sdk/client-secrets-manager` | `SecretsManagerClient` | `GetSecretValueCommand` | reads the bootstrap-generated credential |
| `index.ts:38,200-221` | `@aws-sdk/client-cloudformation` | `CloudFormationClient` | `DeleteStackCommand` | `getStackDeleter()` — DESTROY/PURGE stack teardown |
| `install.ts:35-41,439-559` | `@aws-sdk/client-cloudformation` | `CloudFormationClient` | `CreateStackCommand`, `DescribeStacksCommand`, `DescribeStackEventsCommand` | `toInstaller`/`createStackInstaller` — INSTALL creates and polls the application stack |
| `verify.ts:26-31,284-377` | `@aws-sdk/client-cloudformation` | `CloudFormationClient` | `DescribeStacksCommand`, `DescribeStackResourcesCommand`, `ListStackResourcesCommand` | `toReader`/`createCloudFormationReader` — `verifyInstallation`, provisioning snapshot, resource inventory |
| `stack-events.ts:16,151-212` | `@aws-sdk/client-cloudformation` | `CloudFormationClient` | `DescribeStackEventsCommand` | pages CloudFormation events during INSTALL/DESTROY wait loop and reports progress to control plane |
| `recover.ts:42-53,395-477` | `@aws-sdk/client-cloudformation`, `@aws-sdk/client-elasticache`, `@aws-sdk/client-rds` | `CloudFormationClient`, `ElastiCacheClient`, `RDSClient` | `DescribeStackResourcesCommand`, `DescribeStacksCommand`, `DeleteStackCommand`; `DeleteReplicationGroupCommand`; `ModifyDBInstanceCommand`, `DeleteDBInstanceCommand` | first-install recovery: clears orphaned RDS/ElastiCache blockers, retries stack delete |
| `purge.ts:24-53,367-490` | `@aws-sdk/client-elasticache`, `@aws-sdk/client-rds`, `@aws-sdk/client-s3` | `ElastiCacheClient`, `RDSClient`, `S3Client` | `DescribeReplicationGroupsCommand`, `ListTagsForResourceCommand`; `DescribeDBInstancesCommand`, `ListTagsForResourceCommand`; `ListBucketsCommand`, `GetBucketTaggingCommand`, `ListObjectVersionsCommand`, `DeleteObjectsCommand`, `DeleteBucketCommand` | PURGE — permanently deletes retained data resources + bootstrap stack |
| `domain.ts:13-30,249-437` | `@aws-sdk/client-acm`, `@aws-sdk/client-elastic-load-balancing-v2` | `ACMClient`, `ElasticLoadBalancingV2Client` | `RequestCertificateCommand`, `DescribeCertificateCommand`, `DeleteCertificateCommand`; `DescribeLoadBalancersCommand`, `DescribeTagsCommand`, `DescribeListenersCommand`, `DescribeTargetGroupsCommand`, `CreateListenerCommand`, `AddListenerCertificatesCommand`, `RemoveListenerCertificatesCommand`, `DeleteListenerCommand`, `ModifyListenerCommand` | CONFIGURE_DOMAIN / REMOVE_DOMAIN |
| `pending.ts:24-29,102-151` | `@aws-sdk/client-ssm` | `SSMClient` | `GetParameterCommand`, `PutParameterCommand`, `DeleteParameterCommand` | cross-invocation "pending command" durable marker |

All relay clients are constructed as **lazy singletons** ("construct on first use", never at module load) — an explicit, repeated idiom throughout the package (see comments in `index.ts:142-236`).

### 1b. Control plane — `packages/cdk/src`, `apps/api/src`

| File:Lines | SDK package | Commands | Purpose |
|---|---|---|---|
| `packages/cdk/src/integration/aws-clients.ts:20-51,266-433` | `@aws-sdk/client-cloudformation`, `-ecs`, `-elastic-load-balancing-v2`, `-sts`, `-organizations`, `-elasticache` | `CreateStackCommand`, `DescribeStacksCommand`, `DeleteStackCommand`; `DescribeServicesCommand`; `DescribeTargetHealthCommand`; `GetCallerIdentityCommand`; `ListPoliciesCommand`; `DescribeCacheClustersCommand` | **Test-harness seam** ("todo 14 PENDING-AWS"/"integration suite") — deploys the fixture app to a real test AWS account for CI verification. Not part of the live product path. |
| `packages/cdk/src/jobs/preflight.ts:18-26,104-126` | `@aws-sdk/client-sts`, `-organizations` | `GetCallerIdentityCommand`, `ListPoliciesCommand` | §32 minimal preflight SCP check, run pre-INSTALL. Uses the **default SDK credential chain** — no cross-account role assumption is coded anywhere; "degrades gracefully and passes" when credentials/org access are absent. |
| `packages/cdk/src/jobs/preflight-engine.ts:794-830` | `@aws-sdk/client-service-quotas` | `GetServiceQuotaCommand` | `createRealQuotaChecker()` — Fargate quota checks (3 of 17); injectable seam, `SKIPPED` unless wired |
| `packages/cdk/src/jobs/notifications.ts:402-448` | `@aws-sdk/client-ses` | `SendEmailCommand` | `SesEmailSender` — vendor notification emails (control plane's own account) |
| `packages/cdk/src/lambda/worker-handler.ts:11-12,62-148` | `@aws-sdk/client-codebuild`, `@aws-sdk/client-s3` | `StartBuildCommand`, `BatchGetBuildsCommand`; `PutObjectCommand` | build pipeline: starts/polls CodeBuild release builds, uploads build artifacts |
| `packages/cdk/src/lambda/db-connection.ts:15-18,103-108` | `@aws-sdk/client-secrets-manager` | `GetSecretValueCommand` | control-plane Lambda fetches its own RDS credentials |
| `packages/cdk/src/pipeline/ecr-grants.ts:23-28,64-114` | `@aws-sdk/client-ecr` | `GetRepositoryPolicyCommand`, `SetRepositoryPolicyCommand`, `DeleteRepositoryPolicyCommand` | grants/revokes customer-account cross-account ECR pull access, at INSTALL/DESTROY time |
| `packages/cdk/src/quick-create/publish.ts:15-24,53-79,340-369` | `@aws-sdk/client-s3`, `@aws-sdk/client-cloudformation` | `PutObjectCommand`, `GetBucketLocationCommand`, `HeadObjectCommand`; `ValidateTemplateCommand` | publishes bootstrap/application CFN templates + Lambda asset ZIPs to public S3, verifies |
| `packages/cdk/scripts/publish-bootstrap.mjs:52-113` | `@aws-sdk/client-cloudformation`, `@aws-sdk/client-s3` | `ListExportsCommand`; `HeadObjectCommand` | CLI: resolves template bucket from control-plane stack export, checks application template exists |
| `packages/cdk/scripts/audit-deployment.mjs:20-57` | (via `@deployz/relay/verify`) | `DescribeStacksCommand`, `DescribeStackResourcesCommand` | operator CLI — runs the relay's own `verifyInstallation` against a live customer stack |
| `apps/api/src/queue.ts:1,34-50` | `@aws-sdk/client-sqs` | `SendMessageCommand` | control-plane work queue (JOB_QUEUE_URL) |
| `apps/api/src/email.ts:1,28-50` | `@aws-sdk/client-ses` | `SendEmailCommand` | `SesEmailSender` — transactional emails (invitations etc.) |
| `apps/api/scripts/repair-documenso.ts:18` | `@aws-sdk/client-ecr` | `DescribeImagesCommand` | one-off repair script |

None of the control-plane AWS calls reach into a customer's AWS account (with the caveat on `preflight.ts` above) — the relay is the sole customer-account actor.

## 2. Relay architecture

`packages/relay` is a single Lambda (`handler` export of `packages/relay/src/index.ts`) that the bootstrap stack deploys **into the customer's own AWS account**. It is invoked by an **EventBridge schedule, fixed at 5 minutes** (`packages/cdk/src/bootstrap/bootstrap-stack.ts:1153-1155`).

**Protocol**: plain HTTPS/JSON, egress-only (relay calls out; control plane never calls in). Bearer-token auth (`auth.ts`, rotated tokens). Routes (all under the control plane's Fastify app, `apps/api/src/server.ts`):

| Route | Direction | Purpose |
|---|---|---|
| `POST /api/relay/register` (`server.ts:3736`) | relay → control plane | first contact; binds `installationId` to a deployment via single-use `enrollmentCode`; on first-ever install, creates the INSTALL job |
| `GET /api/relay/commands` (`server.ts:3872`) | relay → control plane | polls for `REQUESTED`/`QUEUED` `deployment_jobs`, atomically flips them to `RUNNING`; also returns `deployment.redisRequired` meta |
| `POST /api/relay/commands/:id/result` (`server.ts:3921`) | relay → control plane | reports a settled command outcome; drives `deployment_jobs.state` and `deployments.state` transitions |
| `POST /api/relay/commands/:id/progress` (`server.ts:4075`) | relay → control plane | mid-flight CloudFormation stack-event batches for INSTALL/DESTROY jobs (fed by `stack-events.ts`'s collector) |
| `POST /api/relay/health` (`server.ts:4178`) | relay → control plane | §59 heartbeat — observed state, health status, components, running image digest, identity self-repair, resource inventory |
| `GET /api/relay/config` (`server.ts:4403`) | relay → control plane | CONFIG_UPDATE executor fetches effective desired config (plain values only; secrets stay write-only) |

**Command vocabulary** (`RelayCommand.type`, `packages/db/src/enums.ts:67-82` `jobTypeEnum`): `INSTALL, DEPLOY_RELEASE, ROLLBACK, RESTART, CONFIG_UPDATE, DESTROY, MIGRATION, INFRA_UPGRADE, HEALTH_REPORT, PREFLIGHT, HEALTH_CHECK, CONFIGURE_DOMAIN, REMOVE_DOMAIN, PURGE`.

**Poll cycle** (`packages/relay/src/poll.ts:pollOnce`, called from `index.ts`'s `relayHandler`):
1. Enroll on first contact (`registerInstallation`).
2. **Resume** anything an earlier invocation deferred (`resume` hook — composes `createInstallResumer`, `createEcsDeployResumer`, `createDestroyResumer`, `createPurgeResumer`, each checking the one `PendingStore` record it owns).
3. `GET /api/relay/commands`.
4. Dispatch each command through `dispatchCommand` (`commands.ts`) with idempotency tracking (`IdempotencyStore`).
5. `POST .../result` for settled (non-deferred) commands.
6. `POST /api/relay/health` — always, even on an idle poll (this is what drives §59 drift/heartbeat).

**Install/update/delete/rollback command paths** (all in `packages/relay/src`):
- **INSTALL** — `install.ts` (`installApplicationStack`, `toInstaller`/`createStackInstaller`) creates the application CFN stack idempotently (describe-before-create), watches to a terminal state within a time budget (default 180s), defers via `pending.ts` if it outlives the invocation, and is gated by `verify.ts`'s `verifyInstallation` before ever reporting success (`settleInstall` in `index.ts:575-666`). First-install recovery (`recover.ts`) can clear orphaned RDS/ElastiCache resources from a `ROLLBACK_COMPLETE`/`DELETE_FAILED` stack so a retried INSTALL isn't permanently stuck.
- **DEPLOY_RELEASE / ROLLBACK** — `deploy.ts` (`createEcsDeployExecutor`) — both share one executor; they roll the ECS service to an immutable `sha256:` digest, discovered via the stack's ECS service, using a copy-modify-register-update pattern on the task definition. Idempotent, bounded/resumable via `pending.ts`.
- **RESTART** — `deploy.ts` (`createRestartExecutor`) — forced rolling redeployment, no task-definition change.
- **CONFIG_UPDATE** — `config-update.ts` — diffs desired vs. running task-definition environment, registers a new revision only when changed.
- **DESTROY** — `destroy.ts` (`createDestroyExecutor`/`settleDestroy`) — deletes the application stack; DEFAULT path is data-preserving (retains blocked resources on `DELETE_FAILED`); only proceeds to destructive orphan-clearing when the control plane payload sets `dataDeletionAuthorized: true`.
- **PURGE** — `purge.ts` (`settlePurge`) — phased: application stack → owned RDS/ElastiCache/S3 orphans (tag-verified ownership) → bootstrap/relay stack itself (deleted last, un-awaited).
- **CONFIGURE_DOMAIN / REMOVE_DOMAIN** — `domain.ts` — ACM certificate + ALB HTTPS listener orchestration.

**Server-side handling**: all of the above land in `apps/api/src/server.ts`'s `/api/relay/*` routes, which mutate `packages/db/src/schema/jobs.ts` (`deploymentJobs`) and `packages/db/src/schema/deployments.ts` (`deployments`) directly inside Drizzle transactions, and call into `apps/api/src/stack-event-progress.ts` (`summarizeStackEvents`) and `packages/db/src/deployment-resources-persist.ts` (`persistDeploymentResourceSnapshot`) for progress/inventory persistence.

## 3. Bootstrap operations

- **Bootstrap template**: `packages/cdk/src/bootstrap/bootstrap-stack.ts` (`BootstrapStack`) — the first CFN stack a customer deploys, distinct from the control-plane's own CDK stack. Provisions (per file header, lines 1-29): (1) a Custom Resource (`packages/cdk/src/lambda/bootstrap-init.ts`) that mints a UUIDv4 installation id — never a template parameter, never in the Quick Create URL; (2) an `AWS::SecretsManager::Secret` + `GenerateSecretString` communication credential, minted by CloudFormation itself; (3) the relay Lambda + an `events.Rule` on `Schedule.rate(Duration.minutes(5))` (`bootstrap-stack.ts:1153-1155`); (4) a two-phase execution role (minimal at install, provisioner permissions attached by the control plane after first relay contact, all `deployz:`-tag-scoped); (5) `deployz:` tags on every taggable resource; (6) IAM denial of `logs:GetLogEvents`/`logs:FilterLogEvents` on the relay role (§16 write-only-logs boundary).
- **`publish:bootstrap`** — `packages/cdk/scripts/publish-bootstrap.mjs`, driving `packages/cdk/src/quick-create/publish.ts`'s `synthesizeBootstrapStack` + `publishBootstrapToAllRegions`. Synthesizes via `aws-cdk-lib` (no AWS calls), repacks the template to be self-contained per region (`repack.ts`), zips Lambda assets (`zip.ts`), and uploads template + assets to `deployz-templates-<region>` public S3 buckets for **every** supported region (`SUPPORTED_AWS_REGIONS`) — a Lambda must read its code from a bucket in its own region (`PermanentRedirect` otherwise). Verifies every region (`verifyPublishedRegion`: bucket region, object presence, `Code.S3Bucket` match, URL reachability, `ValidateTemplate`) and throws if any region fails.
- **`publish:application`** — same file, `ApplicationPublisher`/`synthesizeApplicationStack` — publishes the *application* CFN template (the one the relay's `CreateStack` call actually installs) to the same bucket under `application/v1`.
- **Install links / Quick Create**: `packages/cdk/src/quick-create/install-link.ts` re-exports `buildBootstrapQuickCreateUrl` from `@deployz/contracts` — pure string construction. No AWS calls, no secrets in the URL (NoEcho params like `AppApiKey`/`AppSigningSecret` are deliberately never URL-suppliable). Served by `GET /api/install/:id` (`apps/api/src/server.ts`), gated by `env.deployableAwsRegions`/`env.bootstrapTemplateUrl` (`apps/api/src/env.ts:159-170`).

## 4. Stack polling

Two independent polling loops feed the same progress model:

- **Point-in-time (`DescribeStacks`/`DescribeStackResources`)** — inside `installApplicationStack`'s wait loop (`packages/relay/src/install.ts:265-326`), on a 5-second interval (`DEFAULT_POLL_INTERVAL_MS`), bounded by a 180s-default budget (`DEFAULT_BUDGET_MS`) per Lambda invocation, resumed on the next 5-minute EventBridge tick via `pending.ts`. Feeds `packages/relay/src/verify.ts`'s `verifyInstallation` (health/correctness gate) and `packages/relay/src/provision-progress.ts`'s `buildProvisioningSnapshot`/`summarizeProvisioning` (per-category: network/database/storage/redis/application — pure, synchronous rollup of `DescribeStackResources` output).
- **Event-driven (`DescribeStackEvents`)** — `packages/relay/src/stack-events.ts`'s `createStackEventCollector`, invoked once per install wait-loop tick (`install.ts`'s `onPoll` hook) and once per DESTROY invocation/resume tick (`destroy.ts:227,322`). Pages backward through CFN history, batches ≤50 events oldest-first, POSTs to `/api/relay/commands/:id/progress`.

**Server-side parsing into status**:
- `apps/api/src/stack-event-progress.ts` (`summarizeStackEvents`, `categorizeResourceType`) replays *persisted* stack events (`deploymentStackEvents` table) into the same category-progress shape the heartbeat's snapshot uses — the "event-driven equivalent" of `provision-progress.ts`.
- `apps/api/src/deployment-status.ts` (`deriveDeploymentStatus`, ~1000 lines) is the single pure read-time derivation that turns `deployments`/`deploymentJobs`/`observedState`/`stepTimings` into the six-stage customer/vendor status model (`WAITING_FOR_AWS → CONNECTING → PROVISIONING → VERIFYING → READY`/`FAILED`), the active `DeploymentStep`, `stepStartedAt`/`typicalDurationSeconds`/`takingLongerThanUsual`, and per-component `ComponentProgress[]`. It reads `deployment.observedState.infraHealth.provisioning` (`readProvisioningSnapshot`, lines 529-550) and `.checks` for the ladder logic. `packages/analysis` is not involved in deployment-status derivation.

## 5. Resource inventory → DB persistence

1. Relay: `packages/relay/src/stack-resources.ts`'s `listAllStackResources(reader, stackName)` pages `ListStackResources` to completion via the same `CloudFormationReader` seam (`verify.ts`); fail-closed — any page failure returns `null` (never a partial inventory).
2. `index.ts`'s `createObserveHook` (lines 1255-1290) calls this as the `listInventory` argument on every poll and attaches the result as `verification.inventory` (shape: `{ stackId, resources, observedAt }`).
3. This rides the `/api/relay/health` payload's `observedState.infraHealth.inventory`.
4. Server: `apps/api/src/server.ts:4315-4334` extracts `infraHealth.inventory` and calls `persistDeploymentResourceSnapshot` (`packages/db/src/deployment-resources-persist.ts:38-96`).
5. That function idempotently upserts into `deploymentResources` (`packages/db/src/schema/deployment-resources.ts`), keyed on `(deploymentId, stackId, logicalResourceId)`, using `classifyResource`/`mapResourceStatus` (`@deployz/contracts`) to derive `componentKind`/`resourceRole`/`lifecyclePolicy`, and a `setWhere: lastUpdatedAt <= excluded.last_updated_at` stale-guard so an out-of-order/partial read can never regress a newer snapshot. A `null` inventory (partial/failed read) is a no-op that preserves the last complete snapshot — rows are never deleted when a stack disappears.

## 6. Health checks

Health is **never actively HTTP-probed by the control plane**. Two independent AWS-native mechanisms exist:

- **AWS-native probing**: the application's `healthPath` (from `applications.healthPath`, read in `apps/api/src/install-parameters.ts:45-65`) is baked into the CFN template as `paramHealthCheckPath`, consumed by `packages/cdk/src/application/application-stack.ts` to configure the **ALB target-group health check and ECS container health check** — AWS itself probes the app; nothing in this codebase makes an HTTP call to the customer's app.
- **Relay-side runtime observation** (`packages/relay/src/ecs-health.ts`, `observeRuntimeHealth`): reads `DescribeStackResources` → resolves the ECS service/target-group physical ids → `ECS.DescribeServices` (desired/running counts, rollout state) + `ELB.DescribeTargetHealth` (healthy/unhealthy target counts) → derives one of `HEALTHY/DEGRADED/UNHEALTHY/UNKNOWN` (`deriveHealthStatus`) plus a per-component breakdown (application/loadBalancer/database/storage/redis — the latter three inferred from CFN resource completeness, since there's no live DB/S3/cache probe by IAM-frugality design).
- This rides `/api/relay/health` as `healthStatus`/`components`, consumed by `apps/api/src/server.ts:4178-4396` (writes `deployments.healthStatus`, `observedState.components`, drives `health.recovered`/`health.degraded`/`health.unhealthy`/`ecs.rollout_failed` events, and `deployment.state_recovered`).
- **Control-plane-side aggregate health model**: `packages/cdk/src/jobs/health-monitor.ts` — 10 pure `check*` functions (`HEALTH_SIGNAL_KEYS`: stack, service, target-health, rds, relay, http, utilization, consistency, container-exit, cache) plus `reconcileDeploymentHealth`. This module takes plain observed data as input (no AWS SDK of its own); its `checkHttpHealth` signal has no wired live data source — scaffolding not currently connected to a live prober.

## 7. Deployment/job state persistence

- **Tables**: `packages/db/src/schema/deployments.ts` (`deployments` — `state`: `NOT_INSTALLED, WAITING_FOR_RELAY, INSTALLING, HEALTHY, UPDATING, UPDATE_AVAILABLE, FAILED, DISCONNECTED, DELETING, DELETED`; plus `relayStatus`, `healthStatus`, `observedState` jsonb, `stepTimings` jsonb) and `packages/db/src/schema/jobs.ts` (`deploymentJobs` — `state`: `REQUESTED, QUEUED, WAITING, RUNNING, SUCCEEDED, SUCCESS, FAILED, CANCELLED`; `type`: `jobTypeEnum`; `failureCode`: `failureCodeEnum`).
- **Actual production state-transition code** lives directly in `apps/api/src/server.ts`'s relay routes (register §3736, commands §3872, result §3921, progress §4075, health §4178) and `apps/api/src/jobs.ts`'s `createOrReuseJob` (idempotent job creation via unique-constraint-conflict-as-signal). `JOB_SUCCESS_STATE`/`JOB_RESULT_EVENT` maps (`server.ts:905-929`) drive the `deploymentJobs.state → deployments.state` transition and the §40 activity-feed event on each relay result.
- **Important nuance**: `packages/cdk/src/jobs/install-workflow.ts`, `deploy-release-workflow.ts`, `destroy-workflow.ts`, `rollback-workflow.ts`, `config-update-workflow.ts`, and the underlying generator-based durable-execution engine (`packages/cdk/src/durable/durable-runtime.ts`) are **not imported anywhere under `apps/api/src` or any Lambda handler** — a self-contained, currently-unwired orchestration exploration, not the live state machine.
- The real "watchdog"/sweep logic is in `packages/cdk/src/lambda/worker.ts` (`sweepStuckJobs`, `sweepRelayLiveness`, `sweepStuckBuilds`), invoked on a 15-minute EventBridge schedule from `worker-handler.ts:161-179`, and `apps/api/src/relay-liveness.ts` (persisted `CONNECTED`/`DISCONNECTED`, `RELAY_STALE_AFTER_MS`).

## 8. Existing fixture-mode env flags

All three follow one pattern; a fourth "simulated AWS" mode would mirror it:

| Flag | Read at | Wiring |
|---|---|---|
| `GITHUB_FIXTURE_MODE` | `apps/api/src/env.ts:172-173` → `env.githubFixtureMode` (`=== 'true' \|\| === '1'`) | Threaded as an optional constructor param through `buildServer`/`createAnalysisRunner` (`server.ts:938,1065,1779,1793,1910`); when true, GitHub calls resolve against `GITHUB_FIXTURE_INSTALLATIONS` (`apps/api/src/github.ts:465-…`). Also read directly in `packages/cdk/src/lambda/worker-handler.ts:144`. |
| `AI_FIXTURE_MODE` | `env.ts:179` → `env.aiFixtureMode` | `server.ts:945`: `aiGateway = env.aiFixtureMode ? createFixtureAiGateway() : createAiGateway(env.aiGateway)` — default-parameter injection, overridable via `ServerDeps` for tests. `createFixtureAiGateway()` (`apps/api/src/ai-fixture.ts:31-41`) returns canned, schema-valid responses keyed by call `label`; an unknown label throws the same `AiGatewayNotAvailableError` the real gateway would — "degraded paths stay exercised as degraded." |
| `DOMAIN_FIXTURE_MODE` | `env.ts:176` → `env.domainFixtureMode` | `server.ts:946`: `domainCheckDeps = env.domainFixtureMode ? createFixtureDomainCheckDeps() : createRealDomainCheckDeps()`. Deterministic answers for hostnames ending `.deployz-fixture.test`. |

**Pattern to mirror for a simulated-AWS mode**: an env flag read once in `env.ts`, exposed as a boolean on the `env` object; a `create{Real,Fixture}X()` factory pair; the factory chosen via a **default parameter** on the constructing function (`buildServer`, or the relay's `createDefaultInstallDeps`/`createDefaultExecutors`/`getXSdkClient()` lazy singletons), always overridable by an explicit dependency-injection parameter for tests.

## 9. Existing abstraction/interface over infrastructure operations

Two overlapping-but-distinct seams already exist:

1. **`packages/cdk/src/integration/aws-clients.ts`** — an explicit injectable interface (`AwsClients` = `{ cloudFormation, ecs, elb, sts, organizations, elastiCache? }`) with a real SDK-backed implementation (`createAwsClients()`) and documented intent for mock implementations. Its header: *"Every AWS call flows through one of these interfaces so the entire harness can be exercised with mocks and zero AWS credentials."* Scoped to the **integration test harness** (`packages/cdk/src/integration/runner.ts`, `teardown.ts`, `scp-blocked.ts`) — not wired into the relay or the live control-plane request path, but the closest existing precedent for a "DeploymentInfrastructure" seam.
2. **The relay's per-operation seams** — every relay module defines its own narrow interface (`CloudFormationReader` in `verify.ts`, `StackInstaller` in `install.ts`, `StackEventsReader` in `stack-events.ts`, `StackDeleter` in `destroy.ts`, `RdsPurgeClient`/`CachePurgeClient`/`S3PurgeClient` in `purge.ts`, `AcmClient`/`ElbClient` in `domain.ts`, `EcsDeployClient`/`EcsServiceReader`/`TargetHealthReader`/`EcsTaskReader` across `deploy.ts`/`ecs-health.ts`/`ecs-observe.ts`, `PendingStore` in `pending.ts`) with a `toX(sdkClient)` pure-adapter function separated from a `createRealX()` SDK-constructing wrapper — explicitly so each can be "tested against a fake client with no SDK construction" (repeated comment across `verify.ts`, `install.ts`, `pending.ts`). These are per-module, not unified — there is no single `DeploymentInfrastructure`-style facade today; a new seam would consolidate or wrap these ~10 existing narrow interfaces rather than invent AWS-call sites from scratch, since virtually every AWS touchpoint in the relay is already behind *some* interface boundary.
