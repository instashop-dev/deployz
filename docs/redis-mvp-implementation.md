# Redis MVP — implementation report

Status: shipped (Tasks 1-11 of `docs/superpowers/plans/2026-08-26-redis-mvp.md`, base commit `19b5b98`).
Spec: `docs/redis-mvp-spec.md`. Progress ledger: `.superpowers/sdd/progress.md`.

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
  → packages/cdk ApplicationStack (redisRequired: true → provisions ElastiCache Valkey)
  → packages/cdk BootstrapStack (IAM: ElastiCache actions in the two-phase policy)
  → packages/cdk health-monitor + failure-classifier (runtime signal + failure codes)
  → packages/copy-map (product-language vocabulary for all of the above)
```

The detection layer (`packages/analysis/src/redis.ts`) is deliberately
**provider-neutral** — it never mentions AWS, ElastiCache, or Valkey. Those
names exist only in `@deployz/cdk`. This mirrors the existing
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
| `packages/cdk` | `src/application/application-stack.ts` (+116), `src/bootstrap/bootstrap-stack.ts` (+88), `src/jobs/health-monitor.ts` (+83/-), `src/analysis/failure-classifier.ts` (+95/-), `src/analysis/rejection.ts` | ElastiCache Valkey provisioning; IAM cache actions; 10th health signal; 2 new classifier rules |
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

- **`AWS::ElastiCache::CacheCluster`** (`CfnCacheCluster`) — `engine: 'valkey'`,
  `cacheNodeType: 'cache.t4g.micro'`, `numCacheNodes: 1`, `port: 6379`. No
  explicit `clusterName` (CFN logical-ID naming is deterministic per stack
  and avoids ElastiCache's cluster-name length limit — the same unnamed
  pattern the RDS instance uses).
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
- **Output**: `${stackName}-CacheEndpoint` exports
  `cache.attrRedisEndpointAddress` — only when `redisRequired` is true.

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
| `REDIS_URL`, `REDIS_URI`, `CACHE_URL`, `QUEUE_REDIS_URL`, `CELERY_BROKER_URL`, `CELERY_RESULT_BACKEND` | `url` | `redis://${cache.attrRedisEndpointAddress}:6379` |
| `REDIS_HOST` | `host` | `cache.attrRedisEndpointAddress` |
| `REDIS_PORT` | `port` | `"6379"` (string) |
| `REDIS_PASSWORD` | *(none)* | never resolved — no auth in MVP |

When the repo's detected `connectionEnvVars` is empty or has no recognized
binding kind, `resolveRedisEnvBindings` falls back to the three defaults
Deployz always injects: `REDIS_URL`, `REDIS_HOST`, `REDIS_PORT`. Bindings are
injected into **every** container (web app + worker, in both `expressMode`
branches) — identical env vars everywhere the app runs, not just the web
process.

## 8. Redeployment / reconciliation

The cache lives in the **single** `ApplicationStack` — there is no separate
cache stack or cache-specific lifecycle. It is created once (on first
deploy, when `redisRequired: true`) and reused on every subsequent redeploy:
a redeploy re-synths and re-deploys the same stack, and CloudFormation is
the reconciler — if the cache already exists and its declared properties
haven't changed, CFN no-ops it; if `redisRequired` flips from `false` to
`true` between releases, CFN adds the cache as a stack update.

Drift beyond what CloudFormation itself tracks is not separately monitored
for the cache: the health-monitor's desired-vs-observed diff (`checkCacheStatus`,
§10 below) is the only drift signal, and it only distinguishes "the cache
is where we expect it" from "it isn't," not a fine-grained property diff.

## 9. Deletion

Stack deletion removes the cache — no `RETAIN` override, so CloudFormation's
default `DeletionPolicy: Delete` applies to both the `CfnCacheCluster` and
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

**Health signal (10th of 10)**: `checkCacheStatus` in
`packages/cdk/src/jobs/health-monitor.ts`. Inputs: `redisRequired` (desired
state, mirrors the DB column) and `cacheStatus` (observed ElastiCache
cluster status, or `null` if not yet reported). Logic:

- `redisRequired: false` → always `HEALTHY` ("No managed cache is required")
  — a non-signal for apps that don't use Redis.
- `cacheStatus` in a terminal-failure set → `UNHEALTHY` ("The cache is
  unavailable").
- `cacheStatus === 'available'` → `HEALTHY`.
- Anything else (missing, still converging) → `DEGRADED` ("The cache is not
  yet available").

**Failure classifier** (`packages/cdk/src/analysis/failure-classifier.ts`),
two new rules evaluated in fixed priority order (first match wins):

- **Rule 14 — `REDIS_PROVISIONING_FAILED`**: a CloudFormation-sourced event
  whose `context.resourceType` starts with `AWS::ElastiCache`, or (fallback)
  whose error message contains `AWS::ElastiCache`.
- **Rule 15 — `REDIS_CONNECTION_FAILED`**: a connection-class error code
  (`ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, `NOAUTH`, `WRONGPASS`, `MOVED`,
  `CLUSTERDOWN`) **and** the event identifies the cache as its subject
  (`source: 'cache' | 'redis' | 'elasticache'`, `context.target === 'redis' |
  'cache'`, or a `signal` mentioning cache/redis). The `identifiesCache`
  check is required specifically because `ECONNREFUSED` is also the RDS
  connection-failure code (`RDS_UNAVAILABLE`) — without it, a database
  outage would misclassify as a Redis failure.

There is no runtime log-scraping anywhere in the platform (Redis included):
runtime failures reach the classifier only via structured events (CFN
events, or events the relay/health-monitor themselves emit), never by
parsing application stdout/stderr.

## 11. Tests added

Counts below are `it()`/`test()` blocks added per test file, derived from
`git diff 19b5b98..HEAD` (Tasks 1-11). Approximate where a file's diff mixes
Redis-specific and incidental test edits.

| Package | File(s) | Added tests |
|---|---|---|
| `packages/analysis` | `redis.test.ts` (new), `analysis.test.ts`, `rules.test.ts` | ~40 |
| `packages/cdk` | `application-stack.test.ts`, `bootstrap-stack.test.ts`, `failure-classifier.test.ts`, `health-monitor.test.ts` | ~30 |
| `packages/cdk` (Task 11, this task) | `golden-path-live-aws.test.ts` | +5 always-run (fake-path `ElastiCacheClient` + synth proof) +1 live-AWS-gated (skipped by default) |
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

The exact command a maintainer runs when credentials are available:

```
DEPLOYZ_LIVE_AWS=1 pnpm --filter @deployz/cdk exec vitest run test/golden-path-live-aws.test.ts
```

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

## 14. Known limitations

- **Relay executors are pre-existing no-op stubs.** The relay's
  `INSTALL`/`DEPLOY_RELEASE` durable-workflow executors — the things that
  would actually run `cdk deploy` against a real customer AWS account — are
  stubs that predate this feature. End-to-end Redis provisioning in a real
  customer account is therefore not reachable through the normal
  install/deploy flow today; it's reachable only through the direct,
  gated live-AWS test path added in this task. Relatedly,
  `scripts/synth-app.mjs` (the versioned `runtime-v1` artifact generator)
  still hardcodes `redisRequired: false` — no caller passes `true` yet.
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
- **`database`/`storage` are not wired into the health-monitor at all**
  (pre-existing gap, unrelated to Redis, noted during Task 9 review) —
  `cache` is the only optional-resource health signal that exists.
- **Live-AWS cache-lifecycle test extended but not executed** (this task)
  — see §12 for the exact command and the cost/time note for whoever runs
  it with real credentials.

## 15. AWS IAM changes

`packages/cdk/src/bootstrap/bootstrap-stack.ts` adds `PHASE_2_CACHE_ACTIONS`
(9 actions): `elasticache:CreateCacheCluster`, `DeleteCacheCluster`,
`DescribeCacheClusters`, `ModifyCacheCluster`, `CreateCacheSubnetGroup`,
`DeleteCacheSubnetGroup`, `DescribeCacheSubnetGroups`, `AddTagsToResource`,
`ListTagsForResource`.

These are split three ways, following the same precedent the ACM
(custom-domains) and stack-create/manage statements already established:

- **`ProvisionerCacheCreate`** — `Create*` actions plus
  `AddTagsToResource` (see §13's fix above for why `AddTagsToResource` sits
  here, not in manage: a `ResourceTag` condition can never authorize the
  *first* call that applies a tag to a brand-new, untagged resource — only a
  `RequestTag` condition on create can). Condition: `aws:RequestTag/deployz:installation`
  equals this installation's id.
- **`ProvisionerCacheManage`** — `DeleteCacheCluster`, `ModifyCacheCluster`,
  `DeleteCacheSubnetGroup`, `ListTagsForResource`. Condition:
  `aws:ResourceTag/deployz:installation` equals this installation's id (the
  resource must already carry the tag).
- **`ProvisionerCacheDescribe`** — `DescribeCacheClusters`,
  `DescribeCacheSubnetGroups`. Condition-free: ElastiCache's `Describe*`
  actions don't support resource-level IAM conditions (the same limitation
  the pre-existing ELB `Describe*` statements already work around).

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
