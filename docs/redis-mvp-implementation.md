# Redis MVP — implementation report

Status: shipped (Tasks 1-11 of `docs/superpowers/plans/2026-08-26-redis-mvp.md`, base commit `19b5b98`).
Spec: `docs/redis-mvp-spec.md`. Progress ledger: `.superpowers/sdd/progress.md`.

> **Read this first — 2026-09-03 status note.** This report records the Redis
> MVP as delivered in that earlier workstream. The boundary-mvp phases
> (PRs #72–#125) since superseded parts of it: the relay's INSTALL and
> DEPLOY_RELEASE executors are real (this report's "no-op stubs" limitation no
> longer holds — see `docs/mvp-implementation-status.md`), and Phase 13 removed
> the `packages/cdk/src/jobs/*`, `packages/cdk/src/durable/*`, and
> `packages/cdk/src/analysis/*` modules this report cites (health-monitor,
> failure-classifier). Redis provisioning and cache health today run through
> the published application templates (`application-template-redis-v1.json`),
> the relay's install/verify executors, and the control plane's server-side
> failure refinement (`apps/api/src/failure-classification.ts`). The detection
> rules in §3-§4 below are unchanged and current. See
> `docs/architecture.md` for the live flow.

This document is the honest as-built record for maintainers: what exists, what
doesn't, and where the seams are. It is not marketing copy.

## 1. Architecture used

Redis support is additive and gated end-to-end on a single boolean,
`applications.redisRequired`, threaded through every layer:

```
repo tree
  → packages/analysis (assessRedis: pure, provider-neutral detection)
  → apps/api (persists redisRequired + failure codes; readiness/install/detail APIs)
  → apps/web (UI copy, readiness card, security-details disclosure)
  → packages/cdk ApplicationStack (redisRequired → provisions ElastiCache Valkey; two published template variants)
  → packages/cdk BootstrapStack (IAM: ElastiCache actions in the two-phase policy)
  → packages/relay (install/verify executors — cache verify check when redisRequired)
  → apps/api failure-classification + copy-map (server-side failure refinement, vocabulary)
```

The detection layer (`packages/analysis/src/redis.ts`) is deliberately
**provider-neutral** — it never mentions AWS, ElastiCache, or Valkey. Those
AWS names appear only in the CDK application template (`@deployz/cdk`), the
relay's resource-type expectations (`packages/relay/src/verify.ts`,
`stack-resources.ts`), and the control-plane inventory/classifier
vocabulary (`@deployz/contracts`). This mirrors the existing
database/storage detection pattern rather than introducing a new abstraction
(a full `ManagedService` interface was considered and rejected as
over-engineering for a single additional resource type — see the plan's
self-review notes, §11).

Everything is gated on `redisRequired`: when it's `false`/unset, zero
ElastiCache resources synth, zero `REDIS_*` env vars are injected, and the
CloudFormation template is byte-identical to a stack without this feature.

## 2. Files/components changed

By package, relative to base commit `19b5b98`:

| Package | Key files | What changed |
|---|---|---|
| `packages/analysis` | `src/redis.ts` (new, ~640 lines), `src/analyser.ts`, `src/rejection.ts`, `src/remediation.ts`, `src/rules.ts`, `src/failure-codes.ts`, `src/index.ts` | `assessRedis()` detection + compatibility; wired into the analyser's rejection/remediation tables; two new failure codes |
| `apps/api` | `src/analysis.ts`, `src/github.ts`, `src/server.ts` | Persists `redisRequired`; readiness/install/detail endpoints report cache status and `resourcesCreated`; file-fetching for Redis-relevant paths |
| `apps/web` | `src/lib/deployment-vocabulary.ts`, `src/lib/diagnostic-vocabulary.ts`, `src/lib/security-details.ts`, `src/lib/applications.ts`, `src/lib/deployments.ts`, `src/components/application-ready-card.tsx`, `src/app/install/[installLinkId]/security/page.tsx`, `src/app/dashboard/deployments/[id]/page.tsx` | Redis-aware copy, readiness card, install-security disclosure |
| `packages/cdk` | `src/application/application-stack.ts`, `src/bootstrap/bootstrap-stack.ts` | ElastiCache Valkey provisioning (published template variants); IAM cache actions; template artifacts `application-template-v1.json` + `application-template-redis-v1.json` |
| `packages/copy-map` | `src/index.ts` | `redis` event family, cache-setup vocabulary, diagnostic copy |
| `packages/contracts` | `src/index.ts`, `vitest.config.ts` (new — pre-existing gap filled) | Shared `FailureCode` additions |
| `packages/db` | `src/enums.ts`, `src/schema/core.ts`, `drizzle/0011_*` | `redisRequired` column + migration |
| `e2e/` | `redis.spec.ts` (new, 148 lines), `playwright.config.ts` | Fixture-mode e2e (bullmq-worker supported path, legacy-redis unsupported path) |
| Task 11 (this task) | `packages/cdk/src/integration/aws-clients.ts`, `packages/cdk/test/golden-path-live-aws.test.ts`, `packages/cdk/package.json` (+`@aws-sdk/client-elasticache`) | ElastiCache describe seam + live-AWS cache-lifecycle test extension |

## 3. Redis detection behavior

`packages/analysis/src/redis.ts` exports `assessRedis(tree: FileTree)`, a
pure function (no AI, no network, no side effects, deterministic).

**Signal collection** (each tagged with a tier and a "type" used for
corroboration):

| Tier | Signal | Purpose tagged |
|---|---|---|
| very-high | `docker-compose`/`compose.yml` service using a `redis`/`valkey` image | — |
| very-high | Source-code client init: `new Redis(`, `Redis.from_url(`, `redis.Redis(`, `Sidekiq.configure`, or `createClient()` + a `redis` import | `background_jobs` for Sidekiq |
| high | Known env var referenced (`.env.example`/sample files or `process.env.X` in source) | — |
| high | npm job-library direct dependency: `bull`, `bullmq`, `@nestjs/bull`, `@nestjs/bullmq` | `queue` |
| high | Python: `rq` dependency; `django-redis`; celery + a Redis broker/result-backend signal | `background_jobs`, `cache`, `broker` |
| high | Ruby: `sidekiq` gem | `background_jobs` |
| medium | npm bare client dependency: `redis`, `ioredis`, `@redis/client`, `connect-redis` | `sessions` for `connect-redis` |
| medium | Python bare `redis` client dependency | — |
| medium | Ruby bare `redis` gem | — |
| medium | Go `go-redis`/`redis` import in `go.mod` | — |
| medium | PHP `predis/predis` in `composer.json` | — |
| low | `redis`-family npm dep present **only** in `devDependencies` | — |
| low | README mentions "redis" | — |

**Confidence policy**: any `very-high` or `high` signal alone → `high`. Two
or more *distinct signal types* at `medium` tier → `high` (a lone medium
signal is `medium`; low signals never affect confidence on their own).
`required = confidence === 'high' && compatibility.supported`.

**Purposes** (`RedisPurpose`): `cache | queue | background_jobs | sessions |
rate_limiting | locks | broker | unknown`. Deduplicated across signals;
falls back to `['unknown']` when nothing tags a purpose (e.g. a bare
`redis`/`ioredis` dependency signals "some kind of Redis usage" without
telling you what for).

**Connection env vars** collected (canonical order): `REDIS_URL`,
`REDIS_URI`, `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `CACHE_URL`,
`QUEUE_REDIS_URL`, `CELERY_BROKER_URL`, `CELERY_RESULT_BACKEND`. The
ambiguous ones (`CACHE_URL`, `CELERY_BROKER_URL`, `CELERY_RESULT_BACKEND`)
only count when corroborated by a `rediss?://` scheme value or another
unconditional Redis env var in the same file/source.

## 4. Supported / unsupported compatibility matrix

`evaluateCompatibility()` runs independently of the confidence/required
verdict — a repo can be `required: false` (low confidence) yet still get a
compatibility verdict if it were required. Checked, in order:

| Unsupported when... | Reason surfaced |
|---|---|
| npm dependency on `@redis/json`, `@redis/search`, or `redis-om` | Requires Redis Stack modules (RedisJSON/RediSearch) |
| Python dependency on `redisearch` or `rejson` | Same — Stack modules |
| compose image name contains `redis-stack` | Same — Stack modules |
| Source code matches `new Redis.Cluster(`, `createCluster(`, `RedisCluster(`, or `CLUSTER SLOTS` (source files only) | Requires Redis Cluster mode |
| `rediss://` scheme anywhere in env samples or source | Requires TLS; Deployz's managed Redis has none |

Everything else is **supported**: Deployz provisions a single-node,
standalone, non-TLS, non-cluster Valkey cache — this matrix is that profile
expressed as detection rules, not a feature checklist.

**Known detection gap** (documented, not fixed): a repo whose *only* Redis
signal is a Stack-module dependency (e.g. `@redis/json` with no `redis`/
`ioredis` client dependency alongside it) produces `compatibility.supported:
false` but zero `evidence` — `checkRedisUnsupported`'s gate requires
`evidence.length > 0`, so the repo surfaces as `detected: false` rather than
as a blocked/unsupported repo. Logged in the ledger after Task 2; not fixed
in this MVP (additive-only constraint per task scope).

## 5. AWS resources created

Gated entirely on `redisRequired` in `packages/cdk/src/application/application-stack.ts`.
When `true`:

- **`AWS::ElastiCache::ReplicationGroup`** (`CfnReplicationGroup`) —
  `engine: 'valkey'`, `cacheNodeType: 'cache.t4g.micro'`,
  `numCacheClusters: 1`, `port: 6379`. (The original MVP report's
  `CfnCacheCluster` is obsolete: ElastiCache's CreateCacheCluster API rejects
  the Valkey engine, so the construct is a single-node replication group with
  `automaticFailoverEnabled`/`multiAzEnabled` false.) No explicit
  `replicationGroupId` (CFN logical-ID naming is deterministic per stack and
  avoids ElastiCache's name-length limit — the same unnamed pattern the RDS
  instance uses).
- **`AWS::ElastiCache::SubnetGroup`** (`CfnSubnetGroup`) — private subnets only
  (`SubnetType.PRIVATE_WITH_EGRESS`).
- **A dedicated `SecurityGroup`** — ingress on TCP 6379 scoped to the VPC's
  own CIDR block (`Peer.ipv4(vpc.vpcCidrBlock)`), not a single service's
  security group. This is intentionally broad within the VPC: Express-mode
  ECS manages its own task security groups, which the stack cannot reference
  directly, so the ingress is opened to the whole VPC (private + public
  subnets) rather than pinned to one service — the same pattern the RDS
  security group already uses.
- **Tags**: all four `deployz:*` tags — `deployz:component` (static,
  `'application'`), `deployz:application`, `deployz:vendor`,
  `deployz:installation` — applied to the cache, the subnet group, and the
  dedicated security group alike.
- **Removal policy**: none set explicitly on the cache or subnet group, so
  CloudFormation's implicit default (`DeletionPolicy: Delete`) applies — no
  `RETAIN`. Stack deletion deletes the cache. (Contrast with the RDS
  instance in the same stack, which *is* `RemovalPolicy.RETAIN` — a
  pre-existing, unrelated ApplicationStack behavior.)
- **Output**: the stack's `CacheEndpoint` output
  (`Fn::GetAtt Cache PrimaryEndPoint.Address`, i.e.
  `cache.attrPrimaryEndPointAddress`) — only when `redisRequired` is true.

## 6. Security/networking model

- The cache sits in **private subnets only** — never internet-reachable.
- Ingress is restricted to TCP 6379 from the VPC CIDR — nothing outside the
  VPC can reach it, and nothing inside the VPC other than port 6379 traffic
  is permitted through this security group.
- **No authentication/AUTH token and no TLS** in the MVP (spec §21,
  intentional — `REDIS_PASSWORD` is a recognized env var name for detection
  purposes only; it is never resolved into a binding). A `rediss://` scheme
  anywhere in the repo flips the compatibility verdict to unsupported
  precisely because the managed cache cannot satisfy that requirement.
- IAM access to provision/manage the cache is scoped by the `deployz:`
  resource-tag boundary — see §15 below. There is no cross-installation
  reach: every cache action requires either the request tag (on create) or
  the resource tag (on manage/delete/describe where AWS supports it)
  matching that installation's id.

## 7. Environment-variable mapping

`packages/analysis/src/redis.ts` exports `resolveRedisEnvBindings(connectionEnvVars: string[])`,
consumed by `application-stack.ts` to build the actual container env entries.

Each detected connection env var name resolves to a `kind`:

| Env var | Kind | Injected value |
|---|---|---|
| `REDIS_URL`, `REDIS_URI`, `CACHE_URL`, `QUEUE_REDIS_URL`, `CELERY_BROKER_URL`, `CELERY_RESULT_BACKEND` | `url` | `redis://${cache.attrPrimaryEndPointAddress}:6379` |
| `REDIS_HOST` | `host` | `cache.attrPrimaryEndPointAddress` |
| `REDIS_PORT` | `port` | `"6379"` (string) |
| `REDIS_PASSWORD` | *(none)* | never resolved — no auth in MVP |

When the repo's detected `connectionEnvVars` is empty or has no recognized
binding kind, `resolveRedisEnvBindings` falls back to the three defaults
Deployz always injects: `REDIS_URL`, `REDIS_HOST`, `REDIS_PORT`. Bindings are
injected into **every** container (web app + worker, in both `expressMode`
branches) — identical env vars everywhere the app runs, not just the web
process.

## 8. Redeployment / reconciliation

The cache lives in the **single** application stack the relay installs from
the published `application-template-redis-v1.json` variant — there is no
separate cache stack or cache-specific lifecycle. The relay selects the Redis
or non-Redis template variant from the application's `redisRequired`
(analysis-derived), and a redeploy (release update) changes the service image,
never the stack's resource set. CloudFormation is the reconciler: if the
cache already exists and its declared properties haven't changed, CFN no-ops
it.

Drift beyond what CloudFormation itself tracks is not separately monitored
for the cache: the verify-time cache ladder check and the resource-inventory
snapshot are the only drift signals (§10 below), and they distinguish "the
cache is where we expect it" from "it isn't," not a fine-grained property
diff.

## 9. Deletion

Stack deletion removes the cache — no `RETAIN` override, so CloudFormation's
default `DeletionPolicy: Delete` applies to both the `CfnReplicationGroup` and
its `CfnSubnetGroup`. This is unconditional: there is no separate
"decommission just the cache" path — deleting the ElastiCache resources
happens as part of deleting the whole `ApplicationStack`, same as every
other resource in it except the RDS instance (which is `RETAIN`, a
pre-existing, Redis-unrelated behavior — see the live-test cost/time warning
in §12).

IAM `ResourceTag` conditions on the delete/manage actions ensure a given
installation's provisioner role can only delete/modify a cache that already
carries *that* installation's `deployz:installation` tag — it cannot reach
another installation's cache even if it somehow learned the resource ARN.

## 10. Runtime validation

> The original "10th health signal" (`checkCacheStatus` in the removed
> `packages/cdk/src/jobs/health-monitor.ts`) and the two Redis classifier
> rules in the removed `packages/cdk/src/analysis/failure-classifier.ts`
> were deleted in Phase 13 of the boundary-mvp work. What replaced them:

- **Provisioning verification**: the relay's `verifyInstallation`
  (`packages/relay/src/verify.ts`) treats the cache as a REQUIRED resource
  whenever `redisRequired` is true — the stack must contain a complete
  `AWS::ElastiCache::ReplicationGroup` (the `cache` ladder check). When
  `redisRequired` is false, the cache is still OBSERVED, so "Not
  provisioned" and "Not reporting" stay distinct in the inventory.
- **Provisioning-failure classification**: the control plane refines a failed
  install whose stack events name an `AWS::ElastiCache` resource to
  `REDIS_PROVISIONING_FAILED` server-side
  (`apps/api/src/failure-classification.ts`) — the same code the Phase 10
  audit lists as the live producer.
- **Runtime health**: runtime cache health is not a separate monitor signal.
  Health is the layered derivation (infrastructure verification, ECS rollout,
  ALB targets, HTTP probe, relay connectivity) plus the resource inventory
  snapshot the heartbeat maintains — see `docs/deployment-resilience.md`.
- There is still no runtime log-scraping anywhere in the platform: runtime
  failures reach classification only via structured events (CFN events, or
  events the relay itself emits), never by parsing application
  stdout/stderr.

## 11. Tests added

Counts below are `it()`/`test()` blocks added per test file, derived from
`git diff 19b5b98..HEAD` (Tasks 1-11). Approximate where a file's diff mixes
Redis-specific and incidental test edits.

| Package | File(s) | Added tests |
|---|---|---|
| `packages/analysis` | `redis.test.ts` (new), `analysis.test.ts`, `rules.test.ts` | ~40 |
| `packages/cdk` | `application-stack.test.ts`, `bootstrap-stack.test.ts` (the `failure-classifier.test.ts`/`health-monitor.test.ts` additions were removed with their modules in Phase 13) | ~30 at the time |
| `packages/cdk` (Task 11, this task) | `golden-path-live-aws.test.ts` | +7 always-run (fake-path `ElastiCacheClient` + synth proof + `requireLiveImage` fail-fast guard) +1 live-AWS-gated (skipped by default) |
| `apps/api` | `analysis.test.ts`, `github.test.ts`, `server.test.ts` | ~6 |
| `apps/web` | `deployment-vocabulary.test.ts`, `diagnostic-vocabulary.test.ts`, `security-details.test.ts` | ~4 |
| `packages/copy-map` | `copy-map.test.ts` | ~7 |
| `packages/contracts` | `index.test.ts` | ~1 |
| `packages/db` | `migrations.test.ts` | ~2 |
| `e2e/` | `redis.spec.ts` (new) | 2 (fixture-mode: supported + unsupported paths) |

At the time of writing, `pnpm --filter @deployz/cdk exec vitest run` reports
85 passing / 2 failing across the package (the 2 failures are the
pre-existing, AWS-STS-credential-dependent tests in `golden-path-e2e.test.ts`
and `integration-harness.test.ts` — present on the base commit before any
Redis MVP work, unrelated to this feature, and unchanged by Task 11). The
suite also intermittently hits a `[vitest-worker]: Timeout calling
"onTaskUpdate"` unhandled error under this sandbox's CPU constraints even
with the package's `fileParallelism: false` / `singleFork: true` config —
reproduced identically with Task 11's changes stashed out, confirming it's
pre-existing sandbox flakiness, not a regression.

## 12. Real repositories tested

**Fixture mode** (`e2e/redis.spec.ts`, 2/2 green): two fixture repos exercise
the full detection → readiness → provisioning-plan flow end-to-end —

- `bullmq-worker` — a supported repository (BullMQ direct dependency, `queue`
  purpose, standard non-TLS non-cluster usage) — proves the "Redis cache"
  resource appears in the readiness verdict and `resourcesCreated` list.
- `legacy-redis` — an unsupported repository (triggers one of the
  compatibility-matrix rejections) — proves the unsupported verdict and
  copy render correctly.

**Live-AWS mode**: extended in this task
(`packages/cdk/test/golden-path-live-aws.test.ts`) but **not executed** —
local AWS credentials are expired (the file's existing bootstrap-stack suite
already fails locally on STS for the same reason; this is a documented,
pre-existing condition, not something Task 11 introduced). The extension:

- Synthesizes a standalone `ApplicationStack` with `redisRequired: true`
  in-process (no `cdk deploy` shell-out needed — the template has no bundled
  Lambda assets, unlike the bootstrap stack, so it can be created directly
  through `aws.cloudFormation.createStack`).
- Deploys it, polls for `CREATE_COMPLETE`, asserts the `-CacheEndpoint`
  output is present, polls the new `aws.elastiCache.describeCacheClusters`
  seam until the cluster reaches `available` (matched by endpoint address,
  not "first cluster returned," so it's safe alongside other clusters in the
  account), deletes the stack, and asserts both the stack and the cache are
  gone.
- **Cost/time note for whoever runs this**: the ApplicationStack
  unconditionally provisions a full VPC + NAT gateway + RDS PostgreSQL + ALB
  + ECS Fargate + S3 alongside the cache (there's no lighter-weight way to
  synth just the cache resources today) — expect ~15-25 minutes to reach
  `CREATE_COMPLETE`, AWS charges for that window, and the RDS instance
  inside this stack is `RemovalPolicy.RETAIN` (pre-existing, unrelated to
  Redis) so it will need manual deletion after the test's stack-delete step.
- **Image requirement**: `ApplicationStack`'s own placeholder default image
  (`public.ecr.aws/deployz/fixture@sha256:000...000`) is not a real,
  pullable digest. Left unoverridden, ECS fails to start the service, the
  deployment circuit breaker fires, and CloudFormation rolls back the whole
  stack — cache included — before `CREATE_COMPLETE`, which would look like a
  Redis/cache bug and isn't. The suite now requires
  `DEPLOYZ_LIVE_IMAGE_REPOSITORY` and `DEPLOYZ_LIVE_IMAGE_DIGEST` (a real,
  already-published image — e.g. a published build of `packages/fixture`)
  and fails fast with a clear error naming both if either is missing when
  `DEPLOYZ_LIVE_AWS=1` is set, rather than letting this surface as a
  confusing rollback 15+ minutes into the run.

The exact command a maintainer runs when credentials are available:

```
DEPLOYZ_LIVE_AWS=1 \
DEPLOYZ_LIVE_IMAGE_REPOSITORY=<a real, published image repo> \
DEPLOYZ_LIVE_IMAGE_DIGEST=<its sha256 digest> \
pnpm --filter @deployz/cdk exec vitest run test/golden-path-live-aws.test.ts
```

To restate plainly: this live path has **not** been executed in this task —
it requires both real AWS credentials and a real, pullable image reference
(a published build of `packages/fixture`, or equivalent), neither of which
is available in this environment.

## 13. Issues found and fixed during review

From the progress ledger (`.superpowers/sdd/progress.md`), the Important/Critical
findings raised and fixed across Tasks 1-10:

- **Cluster-mode compatibility scan scope** (Task 1) — the cluster-usage
  pattern scan initially covered all files; narrowed to source files only so
  prose mentioning `createCluster()` in a README doesn't flip a compatible
  repo to unsupported.
- **`packages/analysis/src/failure-codes.ts` barrel export** — a third
  `FailureCode` mirror (alongside `db`/`contracts`) needed the two new Redis
  codes added, with no parity test against the other two mirrors (documented
  as a residual gap, not fixed — pre-existing pattern).
- **`remediation.ts` exhaustive table** — a second hidden `FailureCode`
  mirror also needed filling in for the two new codes (found alongside the
  failure-codes.ts fix).
- **`relevancePriority` root catch-all tier** (Task 5) — the
  rejection-priority ordering needed an explicit tier so Redis rejections
  don't silently fall through to a default that outranks/underranks them
  incorrectly.
- **IAM `AddTagsToResource` bucket placement** (Task 8, Critical) — initially
  placed in the `ResourceTag`-conditioned "manage" bucket, which is a
  first-tag deadlock (a `ResourceTag` condition can never authorize the
  first call that applies the tag to a brand-new, untagged resource). Moved
  to the `RequestTag`-conditioned "create" bucket, following the existing
  ACM `RequestCertificate`/`AddTagsToCertificate` precedent.
- **IAM bucket assertions: `arrayContaining` → exact-set** (Task 8,
  Important) — test assertions were loosened to `arrayContaining`, which
  would silently pass if an action leaked into the wrong bucket; tightened
  to assert the exact action set per bucket.
- **Ingress rule `CidrIp` pin** (Task 7, Important) — the security-group
  ingress test asserted the rule existed but not that its `CidrIp` was
  pinned to the VPC's own CIDR (as opposed to, say, `0.0.0.0/0`); tightened.
- **Live-test placeholder image would have silently broken the whole stack**
  (Task 11, Important) — the first draft of `synthRedisApplicationTemplate()`
  didn't override `imageRepository`/`imageDigest`, so a real live run would
  have used `ApplicationStack`'s placeholder default
  (`public.ecr.aws/deployz/fixture@sha256:000...000`), which ECS cannot
  pull. That would fire the deployment circuit breaker and roll back the
  whole stack — cache included — before `CREATE_COMPLETE`, with a failure
  that looks unrelated to Redis or credentials. Fixed by adding
  `requireLiveImage()`, a fail-fast guard reading
  `DEPLOYZ_LIVE_IMAGE_REPOSITORY`/`DEPLOYZ_LIVE_IMAGE_DIGEST` and refusing to
  proceed (with a clear, both-vars-named error) rather than silently falling
  back to the placeholder. See §12 for the updated command.

## 14. Known limitations

- **End-to-end provisioning now runs through the real relay executors**
  (supersedes this report's original "relay executors are no-op stubs"
  limitation). The boundary-mvp phases made INSTALL/DEPLOY_RELEASE real
  (`packages/relay/src/install.ts`, `deploy.ts`, `verify.ts`) and the
  `redis-success` simulated E2E scenario proves a Redis-required install to
  HEALTHY with the cache in the inventory. `scripts/synth-app.mjs` now
  synthesizes both template variants (`application-template-v1.json` and
  `application-template-redis-v1.json`). The live-AWS golden-path suite
  (`packages/cdk/test/golden-path-live-aws.test.ts`) remains the real-account
  proof; transient live-AWS verification is the canary runbook's domain
  (`docs/testing/`).
- **No deployment-learning or cost-display system exists platform-wide**
  (not Redis-specific — neither exists for any resource type), so neither
  was added for the cache.
- **Timeline shows stack-level provisioning steps, not per-resource.** A
  customer sees "Application stack: creating" rather than a distinct
  "Provisioning cache" step — consistent with how RDS/S3/ALB provisioning is
  already surfaced.
- **No runtime log-scraping anywhere in the platform.** Redis runtime
  failures are caught exclusively via the structured-event classifier
  (§10) and health checks — never by parsing stdout/stderr.
- **Stack-module-only repos slip past the unsupported gate** (§4, "Known
  detection gap") — a repo depending only on `@redis/json` (no client
  dependency alongside it) reports `detected: false` instead of an
  unsupported verdict, because the unsupported-gate check requires
  non-empty `evidence`.
- **Python/Ruby have no dev-only dependency distinction.** The npm signal
  collector distinguishes a `redis`-family dependency in `devDependencies`
  only (tier `low`) from one in `dependencies` (tier `medium`); the Python
  and Ruby collectors don't make this distinction — a `redis` gem/package
  declared only for tests scores the same as a production dependency.
  Also, `REQUIREMENTS_FILE_REGEX` matches `requirements-dev.txt`, so a
  Python dev-only requirements file is scanned exactly like the main one.
- **`database`/`storage` are not wired into a runtime health-monitor signal**
  (pre-existing gap, unrelated to Redis, noted during Task 9 review) — the
  health-monitor module itself was removed in Phase 13; the cache is
  verified via the relay's install-time verify ladder, and infrastructure
  health surfaces through the layered health derivation and resource
  inventory.
- **Live-AWS cache-lifecycle test extended but not executed** (this task)
  — see §12 for the exact command and the cost/time note for whoever runs
  it with real credentials. Running it also requires a real, already-
  published, pullable image (`DEPLOYZ_LIVE_IMAGE_REPOSITORY`/
  `DEPLOYZ_LIVE_IMAGE_DIGEST`) — there is no CI step in this repo that
  publishes one automatically, so a maintainer must build and push
  `packages/fixture` (or point at any other pullable image) before running
  this suite live.

## 15. AWS IAM changes

`packages/cdk/src/bootstrap/bootstrap-stack.ts` adds `PHASE_2_CACHE_ACTIONS`
(11 actions): `elasticache:CreateCacheCluster`, `DeleteCacheCluster`,
`DescribeCacheClusters`, `ModifyCacheCluster`, `DeleteReplicationGroup`,
`DescribeReplicationGroups`, `CreateCacheSubnetGroup`,
`DeleteCacheSubnetGroup`, `DescribeCacheSubnetGroups`, `AddTagsToResource`,
`ListTagsForResource`. (The replication-group actions were added with the
CacheCluster→ReplicationGroup fix; the original report listed 9.)

These are split three ways, following the same precedent the ACM
(custom-domains) and stack-create/manage statements already established:

- **`ProvisionerCacheCreate`** — `Create*` actions plus
  `AddTagsToResource` (see §13's fix above for why `AddTagsToResource` sits
  here, not in manage: a `ResourceTag` condition can never authorize the
  *first* call that applies a tag to a brand-new, untagged resource — only a
  `RequestTag` condition on create can). Condition: `aws:RequestTag/deployz:installation`
  equals this installation's id.
- **`ProvisionerCacheManage`** — `DeleteCacheCluster`, `ModifyCacheCluster`,
  `DeleteReplicationGroup`, `DeleteCacheSubnetGroup`, `ListTagsForResource`.
  Condition: `aws:ResourceTag/deployz:installation` equals this installation's
  id (the resource must already carry the tag).
- **`ProvisionerCacheDescribe`** — `DescribeCacheClusters`,
  `DescribeReplicationGroups`, `DescribeCacheSubnetGroups`. Condition-free:
  ElastiCache's `Describe*` actions don't support resource-level IAM
  conditions (the same limitation the pre-existing ELB `Describe*`
  statements already work around).

All three statements are included in **both**:

- `permissionsBoundary` (`PermissionsBoundary` managed policy) — the ceiling
  the relay execution role can never exceed, attached at bootstrap-deploy
  time.
- `provisionerPolicy` (`ProvisionerPolicy` managed policy) — defined but
  **not** attached at install time; the control plane attaches it to the
  relay role only after the relay's first contact (the two-phase mechanic
  every other provisioner permission already follows). This is the
  "disclosure lockstep": whatever the provisioner policy can actually do is
  exactly what the boundary allows and exactly what the pre-install security
  disclosure page (`apps/web/src/app/install/[installLinkId]/security/page.tsx`)
  tells the customer will happen — the cache IAM actions were added to the
  boundary, the provisioner policy, and the disclosure copy together, not
  independently.

No new AWS-managed policies are attached anywhere; every cache action stays
inside the existing `deployz:` tag-boundary model the rest of the
provisioner already uses.
