# Deployz Dynamic Infrastructure --- Consolidated Technical Specification

**Status:** Target architecture; delivered phases are marked inline (Phases 2, 4 and 5 implemented)\
**Audience:** Deployz engineering team and AI coding agents\
**Companion:** `docs/dynamic-infrastructure-implementation-plan.md`

## 1. Purpose

Deployz should evolve from a small fixed set of AWS templates into a
deterministic infrastructure platform that can understand conventional
SaaS repositories and deploy them safely into a customer's AWS account.

The core principle is:

> AI understands application topology. Deployz provisions only topology
> that can be compiled into a bounded catalogue of trusted
> infrastructure capabilities.

Deployz must not become an AI system that writes and executes arbitrary
CloudFormation, Terraform, IAM, or AWS commands.

## 1.1 Pre-launch constraint and runtime-v1 disposition

Deployz is pre-launch. There are no live customer deployments that had to
stay compatible with the earlier runtime-v1 template generation, so no
compatibility or migration mechanism was ever built.

compiler-v2 is the **single infrastructure generation** (`dynamic-compiler-v2`)
and the single provisioning path. The runtime-v1 machinery — the four
application template constants and artifacts, the profile→URL resolution,
`InfrastructureProfile { postgres, redis }`, `DOCUMENSO_PARAMETERS`, the CDK
application stack and preset, the synth/publish application scripts, the
lifecycle/sizing parity tests, the bootstrap `ApplicationTemplateUrl` override,
and the shadow runner — is removed. The historical template variants survive
only as reference material; no code path resolves or executes them.

Existing internal test deployments may be recreated.

## 2. Product Goal

Internal north star:

> Automatically deploy any conventional SaaS application architecture
> that AWS can reliably host.

External product promise:

> Connect your SaaS. Deployz figures out how to run it privately in your
> customer's AWS.

A useful product framing is:

> Deployz converts arbitrary SaaS software into a verified, repeatable,
> customer-owned AWS deployment.

The implementation should optimize for small SaaS vendors, low
operational complexity, safe customer-owned AWS infrastructure, and a
simple vendor/customer experience.

## 3. Target Capability Scope

### Near-term MVP

**Workloads** - Web application - Multiple workers - Private services -
Migration task - Scheduled job

**Databases** - PostgreSQL - MySQL

**Cache** - Redis / Valkey

**Storage** - S3

**Messaging** - SQS

**Scheduling** - EventBridge Scheduler

**Networking** - ALB - Private workload networking

### Extended capabilities

-   Generic stateless containers
-   Multiple build artifacts
-   EFS
-   Lambda
-   DynamoDB
-   DocumentDB where compatibility is established
-   OpenSearch
-   Customer-account CloudFront
-   Future AI/vector infrastructure through explicit capabilities

## 4. Architecture Principles

### 4.1 AI proposes; compilers provision; verification decides

AI is used where repository semantics are difficult to determine with
deterministic rules. It may infer workload boundaries, production versus
development services, dependency purpose, migrations, optionality,
monorepo roots, and relationships.

AI does not: - produce authoritative CloudFormation; - produce
authoritative IAM; - execute AWS APIs; - bypass the capability
registry; - mark unsupported infrastructure as supported; - receive AWS
credentials.

### 4.2 Application Graph is the core abstraction

Do not make dynamic CloudFormation the core abstraction.

The core representation is an AWS-independent `ApplicationGraph`
describing what the application needs. AWS is the first infrastructure
compiler target.

Target flow:

``` text
Repository
    ↓
Evidence Extraction
    ↓
Deterministic Analysis + Bounded AI Reconciliation
    ↓
DeploymentManifest (frozen deployment contract)
    ↓
ApplicationGraph (what the application needs)
    ↓
Capability Resolver (kind/engine → capability)
    ↓
Planner (region, size profile, policy)
    ↓
DeployzIR (authoritative provisioning intent)
    ↓
Size Profile + Region + Policy
    ↓
Deterministic Infrastructure Compiler
    ↓
Resolved AWS Graph
    ↓
CloudFormation
    ↓
Validation
    ↓
Immutable Artifact
    ↓
Customer Relay
    ↓
Customer AWS
    ↓
Verification
```

### 4.3 One authoritative provisioning intent

`ApplicationGraph` describes application requirements.

`DeployzIR` is the authoritative provisioning intent.

CloudFormation, deployment footprint, pricing representation,
verification contract, and UI deployment plan are derived from the
frozen IR.

`DeploymentSpecV2` freezes the deployment contract.

There is one infrastructure generation and one provisioning path for the
MVP: `dynamic-compiler-v2`. Every new deployment compiles the frozen
manifest through the graph→planner→compiler chain; runtime-v1 machinery is
removed, not carried forward.

### 4.4 Capability completeness

A capability is supported only when it has explicit behavior for: -
detection/resolution; - validation; - compilation; - bindings; - IAM; -
networking; - pricing; - preflight; - installation; - verification; -
progress; - diagnostics; - retry; - update policy; - retention; -
destroy; - purge; - backup/restore policy; - tests.

Creation alone is not support.

## 5. Application Graph

Introduce a versioned `ApplicationGraph`.

Conceptually:

``` text
ApplicationGraph
  buildArtifacts[]
  workloads[]
  resources[]
  bindings[]
  externalServices[]
  evidence[]
  unresolved[]
```

### 5.1 Workloads

Support the schema for: - `web` - `worker` - `private-service` -
`migration` - `scheduled-job` - `lambda`

A workload may include: - stable component ID; - source root; - build
artifact ID; - command; - port; - public/private status; - health
check; - scaling; - runtime; - architecture; - evidence; -
confidence/provenance.

The graph must support multiple workloads of the same type.

### 5.2 Build artifacts

Build artifacts are first-class:

``` text
BuildArtifact
  id
  sourceRoot
  dockerfile?
  buildContext
  architecture
  target?
```

Workloads reference `buildArtifactId`.

The initial MVP may restrict production deployment to one unique build
artifact, but the schema must support multiple artifacts.

### 5.3 Resource/dependency kinds

Support: - relational database; - document database; - key-value
database; - cache; - queue; - object storage; - filesystem; - search; -
event bus; - vector store; - external service; - generic service.

Multiplicity must be supported even when product limits are initially
stricter.

### 5.4 Dependency ownership

Every dependency should distinguish ownership:

``` text
DEPLOYZ_MANAGED
CUSTOMER_EXISTING
CUSTOMER_PROVIDED
VENDOR_PROVIDED
EXTERNAL_SAAS
OPTIONAL
UNRESOLVED
```

This prevents every detected SDK or connection string from becoming
Deployz-managed infrastructure and prepares for future existing-resource
bindings.

### 5.5 Relationship types

Distinguish: - `PROVISIONING` - `RUNTIME` - `BINDING` - `STARTUP`

Do not translate every graph edge into a CloudFormation `DependsOn`.
Runtime cycles are normal. In the implemented MVP the builder connects
every workload to every managed resource (a BINDING superset) and the
runtime env injection is identical for every workload; per-workload
narrowing is not modeled. This superset behavior is unchanged for
databases, cache and storage.

**Implemented (Phase 5).** Queue and schedule edges do not use the
superset. Each edge (`produce`, `consume`, `dead-letter`, `invoke`)
carries an explicit access role from the graph. The capability registry
declares one IAM intent per access role, so a producer edge grants only
`sqs:SendMessage`, a consumer edge grants only the receive/delete/
visibility actions, and a schedule's `invoke` edge grants only
`ecs:RunTask`/`iam:PassRole` on its own target. A workload never
inherits permissions or env bindings for a queue it has no edge to.

## 6. Evidence Extraction and Analysis

Extend the existing deterministic analyzer rather than replacing it.

Evidence should be extracted from: - Dockerfiles; - Docker Compose; -
package manifests; - Prisma and ORM configuration; - environment
declarations; - runtime environment reads; - Procfile/startup/supervisor
configuration; - Terraform; - CloudFormation; - CDK; - Pulumi; -
Kubernetes/Helm; - SAM/Serverless; - GitHub Actions/CI; -
README/deployment documentation; - source imports and framework
configuration.

Repository IaC is architecture evidence. Deployz must never execute
arbitrary repository IaC as part of this system.

### 6.1 Evidence reconciliation

Prefer stronger production evidence over weak hints.

Typical priority:

``` text
explicit production deployment config
    ↓
runtime/framework configuration
    ↓
dependency declarations
    ↓
source usage
    ↓
AI inference
```

AI may reconcile evidence but must not override stronger evidence
without making the conflict explicit.

Consequential ambiguity becomes a vendor question rather than a guess.

## 7. Capability Registry

Create a versioned capability registry.

Representative capabilities:

``` text
compute
  aws.ecs-service
  aws.ecs-task
  aws.lambda
  generic.container

database
  aws.rds-postgres
  aws.rds-mysql
  aws.documentdb
  aws.dynamodb

cache
  aws.elasticache-valkey

storage
  aws.s3
  aws.efs

messaging/events
  aws.sqs
  aws.eventbridge-scheduler

search
  aws.opensearch

network/edge
  aws.alb
  aws.cloud-map
  aws.cloudfront

security/config
  aws.secrets-manager
```

A capability interface should cover: - key/version; - maturity; -
acceptance/compatibility; - validation; - resolution; - bindings; -
IAM; - network requirements; - lifecycle; - verification; - pricing; -
presentation; - diff/replacement behavior.

Capability maturity is separate from compatibility:

``` text
EXPERIMENTAL
PREVIEW
SUPPORTED
DEPRECATED
```

## 8. Deployz IR

Introduce a versioned `DeployzIR`.

It represents the exact infrastructure Deployz intends to create after
repository understanding, capability resolution, vendor/customer
choices, region selection, sizing, and policy.

It should contain: - workloads; - resources; - bindings; - ingress; -
schedules; - policies; - lifecycle; - placement; - metadata.

Every node must resolve to a known capability. Unresolved nodes stop
compilation.

## 9. Planner

The planner transforms:

``` text
ApplicationGraph
+ vendor/customer choices
+ region
+ size profile
+ policy
        ↓
DeployzIR
```

The planner determines: - required/recommended/optional resources; -
dependency closure; - capability selection; - resource placement; -
region compatibility; - allowed customer choices.

The frontend must never independently calculate these relationships.

## 10. Infrastructure Compiler

Introduce a deterministic infrastructure compiler.

Suggested ownership:

``` text
packages/infrastructure-compiler/
  compiler
  capabilities
  network
  iam
  bindings
  lifecycle
  validation
```

Input:

``` text
DeployzIR
+ size profile
+ region
+ compiler version
```

Output: - resolved AWS graph; - CloudFormation; - deployment
footprint; - verification contract; - presentation metadata; - immutable
artifact metadata.

CDK may remain the implementation mechanism, but the compiler is the
architectural boundary.

The customer relay must not synthesize CDK.

**Implementation (Phase 2).** `packages/infrastructure-compiler` is the
boundary: a CDK-free deterministic CloudFormation emitter. `compile.ts`
builds a resolved AWS graph (an ordered list of logical resources, each
carrying stable identity + `componentId`/`componentKind`/`capability`/
`resourceRole` + stateful/retention/purge metadata + a verification
check), `cfn-emit.ts` serializes it deterministically, and `derived.ts`
derives the footprint, verification contract, ownership records and
artifact hashes from the same graph. It emits CloudFormation directly
rather than through CDK L2 constructs so logical ids are the stable
semantic ids of §11 instead of CDK's auto-hashed ids; CDK stays the
control-plane mechanism, and the relay still consumes pre-compiled
artifacts only. The compiler never imports an AWS SDK, never calls AI, and
never reads the wall clock (an architecture-fitness test enforces this).

### 10.1 Determinism

Equivalent: - IR; - compiler version; - capability versions; - size
profile; - relevant region capability rules

must produce equivalent infrastructure.

Avoid: - timestamps; - random IDs; - unstable iteration; - AI-generated
logical IDs; - synth-time AWS lookups; - repository-controlled logical
IDs.

## 11. Stable Resource Identity

Stable CloudFormation logical identity is a P0 requirement.

Derive identity from stable semantic identity such as:

``` text
componentId + capability + resourceRole
```

Examples:

``` text
primary-db/rds-instance
primary-db/secret
email-worker/ecs-service
email-queue/queue
```

Compiler refactors must not silently replace stateful resources.

CI should include logical-ID stability/golden tests.

## 12. DeploymentSpecV2 and Immutability

`DeploymentSpecV2` should freeze or reference: - ApplicationGraph; -
DeployzIR; - graph hash; - IR hash; - compiler version; - capability
registry version; - capability versions; - template hash; - artifact
location; - verification contract version.

Infrastructure generation is tracked on the deployment's
`infra_version` column. The MVP uses only:

``` text
dynamic-compiler-v2  (the compiler generation)
```

Deployments are never silently recompiled with a different compiler.

### 12.1 Frozen artifact publication and identity

At deployment creation the control plane compiles the deployment's frozen
manifest (`manifestToApplicationGraph` →
`planApplicationGraphWithSpec({ graph, region, sizeProfile })` →
`compileDeployzInfrastructure`) and publishes the resulting template to the
region's public-read template bucket under the content-addressed key:

``` text
compiler-v2/<templateHash>.json
```

Publication is a conditional `PutObject` with `IfNoneMatch: '*'`; a `412
PreconditionFailed` is dedup success, not an error — the object already
holding the hash is byte-identical by construction. The artifact URL and the
completed `DeploymentSpecV2` are persisted on the deployment row
(`deployments.spec_v2`, `infra_version = 'dynamic-compiler-v2'`), and the
publish happens **before** the database insert: no compile or publish, no
deployment row (fail closed). Outside the deployed Lambda the publisher is an
injectable no-op, gated by `env.releaseImageRegistryEnabled`, so simulated
E2E and tests run the full pipeline without S3.

Artifact identity is content: the template hash pins exactly what the relay
will execute, and identical infrastructure re-publishes nothing.

### 12.2 Runtime execution contract

INSTALL payloads carry the frozen artifact URL plus typed parameters:

- `templateUrl` — the published `compiler-v2/<hash>.json` artifact. The
  relay executes **only** `payload.templateUrl` and fails closed without it;
  there is no environment or profile fallback.
- `paramImageReference` — the newest READY release, digest-pinned
  (`repository@sha256:…`).
- `paramDesiredCount` — `'0'` when configuration must precede the first
  start (`configPrecedesFirstStart`), so no unconfigured task boots.
- `paramAppApiKey` and `paramAppSigningSecret` — API-generated application
  secrets (random 32-byte base64url), sent as `NoEcho` parameters and
  redacted from the stored payload once the relay claims the job
  (`INSTALL_SECRET_PARAMETER_IDS`).
- `paramContainerPort` and `paramHealthCheckPath` — derived by the relay
  from the deployment manifest at claim time.
- Any template parameter the relay cannot derive is filtered out against one
  template fetch: undeclared parameters never reach CloudFormation.

The relay never synthesizes templates, never resolves template URLs from
profiles, and never recompiles.

Parameter classes stay distinct:

- **Infrastructure parameters** — what the compiled stack needs to exist
  (image reference, desired count, container port, health-check path).
- **Application configuration** — vendor/customer values, delivered through
  the config pipeline (`CONFIG_UPDATE` / pending secrets), not through the
  template.
- **Deployz-generated secrets** — `paramAppApiKey` /
  `paramAppSigningSecret`, minted per install, `NoEcho`, redacted after the
  claim.
- **Release-specific values** — only the pinned image digest changes per
  release; the artifact and every other parameter do not.

### 12.3 Release versus infrastructure-change semantics

A release is an image/config change against an unchanged topology: the
frozen artifact is never recompiled and never replaced. No recompile path
exists — an existing deployment keeps the artifact it was installed with.
Requirement drift is detected by comparing the stored spec's `graphHash`
against the desired graph hash and reported as drift; an unsupported
topology change fails closed (§31).

## 13. Resource Ownership

Introduce generic ownership records for managed resources.

Conceptually:

``` text
ResourceOwnershipRecord
  installationId
  componentId
  capability
  logicalResourceId
  physicalResourceId?
  stackId
  stateful
  retentionPolicy
  purgeStrategy
  createdAt
```

Use ownership for: - verification; - destroy; - purge; - failed-install
recovery; - orphan recovery; - diagnostics.

Avoid broad account sweeps.

## 14. Lifecycle

Every capability defines explicit behavior for:

``` text
CREATE
VERIFY
UPDATE
BACKUP
RESTORE
DESTROY
PURGE
```

An unsupported lifecycle operation must be explicit.

Stateful capabilities require a clear backup/restore answer.

### 14.1 DESTROY and PURGE (retain, then purge)

DESTROY (disconnect) deletes the application stack; CloudFormation's
per-resource retention policies decide what stays. When the stack lands on
`DELETE_FAILED` because the deletion-protected RDS instance still pins its
security group and subnet, the relay lists the failed resources and re-issues
`delete-stack` with `RetainResources`, repeating the pass on each poll until
the stack reaches `DELETE_COMPLETE`. The deployment then settles as `DELETED`
— a truthful success — while the RDS instance, its credential secrets, the
bucket and the network objects the ENI pins remain behind for PURGE. A
`DELETE_FAILED` stretch blocked by retained data is expected pacing (45+
minutes), not a failure.

PURGE deletes the retained data separately: the RDS instance (deletion
protection off, `SkipFinalSnapshot`), every owned application secret except
the relay's own `deployz:component=bootstrap` secret — generation-agnostic,
so compiler-v2 and any earlier artifacts purge alike — the bucket (every
version), ACM certificates, subnet groups and network orphans. A failed
purge lands on `cleanupState: PURGE_FAILED` and stays retryable.

## 15. Stateful Safety and Replacement

Use explicit: - `DeletionPolicy`; - `UpdateReplacePolicy`; -
retention; - purge strategy; - replacement classification.

Infrastructure changes should eventually classify as:

``` text
SAFE
UPDATE
REPLACEMENT
DESTRUCTIVE
UNSUPPORTED_MIGRATION
```

Fail closed for: - stateful replacement/deletion; - removal of
retention; - unsafe encryption changes; - unsafe VPC/network
replacement; - unsupported migrations.

General automatic infrastructure upgrades are deferred until after the
initial dynamic-infrastructure MVP.

## 16. Relay

Keep the relay as a bounded customer-account execution mechanism.

Do not turn it into: - an AI agent; - arbitrary AWS command execution; -
arbitrary IaC execution.

Existing high-level commands can remain largely stable.

### 16.1 Durable idempotency

Production command idempotency must survive Lambda cold starts and
redelivery.

This already exists in the live relay and must be hardened, not replaced.
The relay persists a cross-invocation SSM pending-command marker
(`/deployz/<installationId>/pending-command`, SecureString,
`packages/relay/src/pending.ts`) that records the owed answer, the
original payload, and any deferred migration task ARN / stack-event
cursor. The control plane mints a durable idempotency key per operation
(`{deploymentId}:{TYPE}[:{releaseId}][:RETRY:n]`, ON CONFLICT DO NOTHING
via `createOrReuseJob`) and claims jobs atomically. Every relay executor
reads before it writes (describe-before-create/delete), so a re-delivered
or re-offered command converges on real AWS state instead of duplicating a
mutation.

This durable marker/idempotency model serves the compiler-generated
deployment spec, keeping the conceptual key:

``` text
installationId + idempotencyKey
```

with command/status/result metadata and conditional writes. Retries reuse
the frozen artifact: a retried INSTALL re-executes the same
`compiler-v2/<hash>.json` artifact, describe-before-create executors adopt
whatever CloudFormation already created, and re-publication of an identical
artifact is a `412` dedup, so retry convergence never depends on
recompiling.

## 17. Verification

The compiler emits a generic verification contract alongside the template
(§10): the relay's poll-meta verification booleans (`databaseRequired` /
`redisRequired`) derive from the spec's verification contract, and the
heartbeat's inventory classification joins CloudFormation stack resources
with the spec's ownership records by logical id, falling back to
`classifyResource` by resource type.

Conceptually:

``` text
HealthReport
  overall
  components[componentId]
    capability
    status
    checks[]
```

Support: - resource health; - workload health; - binding health where
practical.

Examples: - ECS rollout stable; - RDS available; - SQS exists; -
DynamoDB active; - OpenSearch active; - Lambda active; - EFS mount
targets ready; - workload-to-resource access checks where supported.

## 18. Networking

Networking should be planned centrally from the graph.

Derive: - VPC/subnets; - routes; - security groups; - service
discovery; - public/private ingress.

Capabilities should declare requirements rather than independently
invent network topology.

For MVP, keep a single flat dynamic application stack unless complexity
requires otherwise. Nested stacks are not required initially.

Stable component IDs must make a future nested-stack transition
possible.

## 19. IAM

Derive least-privilege workload IAM from bindings.

Prefer workload-specific roles.

Avoid: - broad shared application roles; - wildcard workload IAM; -
repo-controlled IAM; - AI-generated authoritative IAM.

Bootstrap/relay infrastructure-management permissions should evolve
around known capability/action groups.

Customer-facing security explanations should derive from canonical
capability groups rather than hard-coded prose.

**Implemented (Phase 5).** Every non-web workload — each worker, the
migration task and each scheduled job — now gets its own ECS task role
and policy, built only from that workload's own queue edges
(`compileWorkloadTaskRole`). The web role keeps the pre-Phase-5 shared
policy shape when it has no queue edges. Queue permissions are
edge-derived: each produce/consume binding compiles to one
least-privilege statement scoped to the target queue's ARN, never a
wildcard resource.

The EventBridge Scheduler execution role follows the same pattern:

- Trust policy: `scheduler.amazonaws.com`, guarded by an
  `aws:SourceAccount` condition (confused-deputy protection).
- `ecs:RunTask` is scoped to the target workload's own task-definition
  family and conditioned on the specific ECS cluster ARN.
- `iam:PassRole` is limited to the target workload's own task role and
  the shared execution role, conditioned on
  `iam:PassedToService: ecs-tasks.amazonaws.com`.
- `sqs:SendMessage` is scoped to the schedule's own dead-letter queue
  only, when one is configured.

No broad shared role and no wildcard workload IAM were introduced.

## 20. Preflight

Preflight must validate the exact frozen IR against the selected
customer account/region where possible.

Checks should cover: - region capability/service availability; -
permissions; - quotas; - subnet/IP constraints; - EIP/NAT constraints; -
service-linked roles; - CloudFormation safety limits; - ECS/Fargate
architecture; - RDS engine/version/class; - capability-specific
restrictions; - baseline cost guards.

Known weaknesses in current quota checking should be corrected before
dynamic infrastructure depends on it.

## 21. Resource Placement

Represent resource scope explicitly:

``` text
REGIONAL
GLOBAL
FIXED_REGION
```

Conceptually:

``` text
ResourcePlacement
  account
  region?
  scope
```

This is required for future capabilities such as customer-account
CloudFront and fixed-region certificates.

## 22. Size Profiles

Keep topology separate from sizing.

The immutable size-profile registry already exists
(`packages/contracts/src/profile.ts`, `InfrastructureSizeProfile`):
`small-v1` is the only published profile and every deployment freezes
`{ id, version }` in `desired_state.infrastructureProfile`. A topology- or
sizing-changing option requires a NEW version plus a new `infra_version`
and a security review — a published entry is never mutated.

There is one profile concept:

- `InfrastructureSizeProfile` (`small-v1`) — sizing: CPU/memory, desired
  counts, RDS class, cache node type/count. What exists is decided by the
  graph → planner → IR chain, not by a profile.

Profiles such as `minimal` / `standard` / `large` are additional
`InfrastructureSizeProfile` versions, never new architecture.

Profiles may control: - ECS CPU/memory; - desired counts; - RDS class; -
cache size; - OpenSearch size; - worker sizing.

## 23. Compatibility States

The manifest readiness gate already emits a three-state vocabulary that
the UI surfaces directly (`evaluateManifestReadiness`,
`packages/analysis/src/manifest.ts`):

``` text
READY
NEEDS_CONFIGURATION
NOT_COMPATIBLE
```

The application-level column uses a parallel trio (`READY` /
`NEEDS_ATTENTION` / `NOT_COMPATIBLE`, `compatibilityStatusSchema`). Reuse
these names rather than introducing a parallel set. Both vocabularies
surface through the established ui-system mappings (the Configuration
table's vocabulary in `ui-system.md`), never as raw enum text. A richer backend
taxonomy — `SUPPORTED` / `CONFIGURATION_REQUIRED` /
`RECOGNIZED_UNSUPPORTED` / `UNKNOWN_ARCHITECTURE` — may map onto the same
three UI states, but is not required before the graph/IR work needs it.

Capability maturity remains a separate concept.

## 24. Cost Estimation

Cost must be capability-driven and derive from the same frozen plan used
for deployment.

Each capability should provide an estimate where practical.

Aggregate by useful customer categories: - compute; - database; -
cache; - storage; - messaging; - networking; - other.

If cost cannot be estimated reliably, show estimate unavailable rather
than inventing a value.

## 25. Service-Specific Requirements

### 25.1 MySQL — implemented (Phase 4)

`aws.rds-mysql` is the sibling of `aws.rds-postgres`. Both sit on the
`relational_database` graph kind; the resolver maps kind + engine to the
capability, so the graph still describes only the need.

Implemented behavior:

- RDS MySQL 8.0 with the engine version pinned by Deployz; one managed
  instance per MySQL dependency.
- The existing size profiles apply unchanged.
- Private networking, encryption at rest, 7-day backups, deletion
  protection.
- Managed credentials: a master secret and an application URL secret,
  like PostgreSQL.
- Generic bindings: `DATABASE_URL` with the `mysql://` scheme, plus the
  `MYSQL_URL` and `DB_*` alias patterns the application reads.
- The RDS CA bundle environment is shared by every workload in the
  stack, so workers and the migration task verify TLS the same way the
  web service does.
- Verification, DESTROY (retain) and PURGE (delete, no final snapshot)
  reuse the PostgreSQL lifecycle behavior.
- PostgreSQL is unaffected: a PostgreSQL manifest compiles byte-identical
  output and its golden pins do not move.

Engine-specific URL/port/SSL/version behavior stays isolated in the
compiler's engine descriptor.

### 25.2 Workers — implemented (Phase 4)

`workloads[]` is first-class in the ApplicationGraph, the IR and the
frozen spec. One build artifact is shared by the web service, N workers
and the optional migration workload; each workload carries its own
frozen command.

Implemented behavior:

- Stable per-workload identity: a kebab-case id derived from the
  evidence, with `worker` and `worker-2` as fallbacks.
- Workers are `public: false`: no ALB target group, no listener route,
  no HTTP health check.
- One ECS service per persistent workload (`web` and `worker`). Each
  service has its own log group and security group.
- Desired counts: the web service uses the profile parameter; each
  worker service runs one task.
- Verification has one `compute` check and one component seat per
  workload. A worker verifies through service stability, not HTTP.
- Detection: a declared run process (a Procfile non-web entry, a
  Compose application service, or an npm-script worker) becomes a
  provisioned workload. Weak evidence (queue libraries only) sets
  `worker.needsCommand`; that becomes an unresolved needs-input
  question and is never provisioned. Dev, test and build utilities
  never become workloads.
- `manifest.workers[]` holds the workers. There are no numbered worker
  fields. The legacy single `worker.command` slot keeps the first
  worker's command, so older consumers keep working.

### 25.3 Migration — implemented (Phase 4)

Migration is a first-class one-shot workload. Ordering:

``` text
infrastructure ready (install / database ready)
    ↓
migration task runs once, exit 0 required
    ↓
success → services roll to the new release
failure → MIGRATION_FAILED diagnostics, no service update
```

Implemented behavior:

- The compiler emits one `AWS::ECS::TaskDefinition`
  (`MigrationTaskDefinition`, family `DeployzAppMigration`) with the
  frozen command `['sh', '-c', cmd]` baked in. There is no service, no
  ALB entry, no desired-count parameter and no verification seat for
  the migration workload.
- The relay runs ONLY that named family. The deploy payload carries
  `{family, identity}`; a payload that carries a command string is
  rejected and dropped. The relay can never execute an arbitrary
  command.
- Identity = sha256 over the frozen command plus the image digest. A
  SUCCEEDED `DEPLOY_RELEASE` job row that carries the identity confirms
  it; a failed job never confirms. A relay retry of a confirmed
  identity skips the run; within one rollout the same task ARN resumes.
- A failed migration surfaces `MIGRATION_FAILED` diagnostics (family,
  exit code, stopped reason). No service updates, and the deployment
  returns to `UPDATE_AVAILABLE` — a failed update is not a failed
  deployment.
- ROLLBACK and RESTART never run migrations. No down-migration
  orchestration exists.

### 25.4 SQS — implemented (Phase 5)

`aws.sqs` resolves from the `queue` graph kind with `engine: standard`.
Any other engine (FIFO, a broker) resolves nothing and fails closed —
the planner never provisions it. Maturity is `PREVIEW` until a
real-AWS qualification is recorded (see the Phase 5 Result in
`docs/dynamic-infrastructure-implementation-plan.md`).

Implemented behavior:

- One standard queue per `queue` resource. Default message retention
  is 4 days (345 600 seconds); default visibility timeout is 30
  seconds.
- An optional dead-letter queue, reached by a queue-to-queue
  `dead-letter` edge. The DLQ keeps 14 days of retention (the SQS
  maximum) and a redrive policy with `maxReceiveCount` on the source
  queue. Deleting a queue deletes its messages; there is no
  retained-message semantics.
- A `AWS::SQS::QueuePolicy` denies every `sqs:*` action when
  `aws:SecureTransport` is false, so the queue accepts only TLS
  traffic.
- Producer/consumer/dead-letter IAM is edge-specific and least
  privilege (§19): a producer can only `sqs:SendMessage`; a consumer
  can only receive, delete, extend visibility and read attributes; a
  dead-letter source can only send.
- Env bindings: `QUEUE_URL` and `QUEUE_ARN`, driven by the manifest's
  own binding names — never a fixed name the workload must match.
- Verification carries a `queue` resource check (a generic stack
  resource + type + status match; no queue-specific relay code).
- Pricing is usage-based (per request): no request volume is ever
  invented. When usage is unknown the estimate is marked incomplete,
  never zero.

### 25.5 EventBridge Scheduler — implemented (Phase 5)

`aws.eventbridge-scheduler` resolves from the `schedule` graph kind.
Maturity is `PREVIEW` until a real-AWS qualification is recorded.

Implemented behavior:

- One EventBridge Scheduler schedule per graph schedule, named
  `<stack-name>-<PascalCaseScheduleId>`. Cron and rate expressions are
  translated to the AWS Scheduler syntax (`cron(...)`/`rate(...)`);
  standard 5-field cron day-of-week values are remapped to AWS's
  1(Sun)–7(Sat) numbering. An optional IANA timezone is carried
  through as `ScheduleExpressionTimezone`.
- The schedule targets its job's ECS task-definition family without a
  revision suffix, so it always invokes the family's latest revision —
  never a frozen revision number.
- Retry policy (`maximumRetryAttempts`, `maximumEventAgeSeconds`) and
  an optional standard-SQS dead-letter queue carry through unchanged
  from the graph.
- The scheduler execution role is scoped per §19: confused-deputy
  trust condition, `RunTask` limited to the one family and cluster,
  `PassRole` limited to the job's own roles, and DLQ `SendMessage`
  limited to the schedule's own DLQ.
- Verification carries a `schedule` resource check, generic like the
  queue check.
- The initial target is an ECS task; Lambda targets are not
  implemented.

### 25.6 Scheduled jobs — implemented (Phase 5)

A scheduled job is a separate workload kind from the migration task,
even though both compile to a one-shot ECS task definition with a
frozen command:

- A migration is a one-shot **pre-deploy** step: it runs once per
  release, gates the following service update, and its timing is tied
  to `DEPLOY_RELEASE`/`ROLLBACK`.
- A scheduled job is a recurring, **independent** one-shot task. It has
  no ECS service, no verification/readiness check of its own (it is
  never deployment-gating), and its own security group. EventBridge
  Scheduler invokes it on its own cron/rate schedule, not on deploy
  timing.
- The one link to release timing is the task definition's image: the
  relay registers the newest release image into every scheduled job's
  task family, but only after a `DEPLOY_RELEASE`/`ROLLBACK` rollout has
  otherwise settled — never before, and never as a condition for the
  rollout to succeed. A registration error keeps the deploy command in
  progress; it does not fail the deployment.
- At DESTROY, the relay stops standalone scheduled-job task runs (ECS
  tasks with no owning service) before the stack is torn down.

### 25.7 DynamoDB

Schema must come from explicit evidence/configuration.

Do not invent key schema from weak AI inference.

Treat key-schema changes conservatively.

### 25.8 Lambda

Lambda has its own build/runtime contract.

Do not assume an ECS image is automatically valid for Lambda.

Model: - runtime/image; - handler; - memory; - timeout; -
architecture; - env; - bindings; - triggers.

### 25.9 DocumentDB

Do not map MongoDB usage to DocumentDB solely because a Mongo driver
exists.

Use compatibility evaluation.

Unknown/incompatible applications require configuration or remain
unsupported.

### 25.10 OpenSearch

Explicitly model: - engine version; - VPC/public placement; -
encryption; - authentication/access; - storage/sizing; -
upgrade/replacement behavior; - cost.

Keep maturity conservative until lifecycle testing is strong.

### 25.11 CloudFront

CloudFront is provisioned in the customer's account.

Model global/fixed-region requirements explicitly, including certificate
placement where relevant.

### 25.12 EFS / generic persistent containers

Generic stateless containers are high leverage.

Initial policy: - stateless private service: supported; - stateless
worker: supported; - public HTTP: bounded support; - persistent + EFS:
preview; - database-like persistent container: unsupported; -
distributed cluster: unsupported.

Do not claim persistence guarantees merely because a container boots
with EFS.

## 26. Security Boundaries

Do not support arbitrary: - AI-generated infrastructure; - repository
Terraform/CloudFormation execution; - repository IAM; - privileged
ECS; - host networking; - EC2 user data; - customer IAM creation; -
unsafe public databases/caches.

Require: - encryption where applicable; - explicit retention; -
resource/cost ceilings; - typed validation boundaries; - capability
allowlisting; - least-privilege bindings.

## 27. Data Persistence

Prefer versioned JSON contracts/JSONB for evolving Graph/IR state rather
than premature relational normalization.

Persist enough data to reproduce and diagnose the frozen deployment: -
graph/version/hash; - IR/version/hash; - compiler version; - capability
versions; - template hash; - desired state.

## 28. Package Ownership

Target responsibility boundaries:

``` text
packages/contracts
  versioned schemas

packages/analysis
  repository → evidence → ApplicationGraph

packages/capabilities
  capability definitions/lifecycle/pricing/verification

packages/planner
  Graph + choices + region + size + policy → IR

packages/infrastructure-compiler
  IR → resolved AWS graph → CloudFormation

packages/infrastructure-policy
  security/cost/compliance where useful

packages/cdk
  AWS constructs/control plane/bootstrap

packages/relay
  execute frozen artifact, verify, operate, destroy, purge
```

Prefer dependency direction:

``` text
analysis → contracts
planner → contracts + capabilities
compiler → contracts + capabilities
relay → contracts
```

Avoid analysis importing provisioning/AWS implementation and AI
importing compiler/relay code.

These package names are targets, not a mandate to duplicate better
abstractions already present in the repository.

### 28.1 Existing abstractions → target abstractions (Phase 2)

`packages/contracts` already holds the derivation core the
planner/capability/compiler layers are meant to own. Phase 2 evolves
these in place rather than duplicating them.

| Existing (today) | Location | Role after Phase 2 |
|---|---|---|
| `ApplicationAnalysis` | `contracts/src/application-analysis.ts`, `analysis/src/application-analysis.ts` | The canonical evidence + derived app projection feeding the manifest. Stays the analysis-layer read model. |
| `DeploymentManifest` | `contracts/src/manifest.ts`, built by `analysis/src/manifest.ts` | The frozen, versioned deployment contract (`schemaVersion: 1`). It remains the input to graph derivation and preflight. |
| `ApplicationGraph` | `contracts/src/application-graph.ts`, built by `analysis/src/graph.ts` | A projection of the manifest describing what the application needs. AWS capability selection moves OUT of the graph into the resolver/planner. |
| `DeployzIR` | `contracts/src/deployz-ir.ts`, built by `packages/planner` | Authoritative provisioning intent. Every managed resource resolves to a known capability. |
| `DeploymentSpecV2` | `contracts/src/deployment-spec-v2.ts` | Frozen envelope (graph + IR + hashes + capability-registry/size-profile refs + compiler artifact location). |
| `DeploymentPlan` | `contracts/src/plan.ts` | Deterministic INSTALL/UPDATE/DESTROY derived data. Planner output the UI consumes. |
| `InfrastructureProfile` | *removed* (was `{ postgres, redis }` in `contracts/src/index.ts`) | Removed. The compiler composes infrastructure from `DeployzIR.resources[]`; no template-variant key exists. |
| `InfrastructureSizeProfile` | `contracts/src/profile.ts` | The immutable sizing registry (`small-v1`). Future sizes are new versions here. |
| `INFRASTRUCTURE_COMPONENTS` | `contracts/src/components.ts` | The shared semantic catalog (five components: lifecycle, primary CloudFormation resource type, relay verification check). Drives plans, footprint and verification presentation; the compiler — not this catalog — decides construction. |
| `AWS_RESOURCES` / `CONNECTOR_RESOURCES` | `contracts/src/aws-resources.ts` | Customer-facing resource catalog. Presentation layer; not the provisioning source of truth. |
| `classifyResource` / inventory | `contracts/src/infrastructure.ts` | CFN resource type → component kind/role/lifecycle. Ownership/verification helper; not a provisioning source. |
| `FOOTPRINT_RESOURCES` / pricing adapters | `contracts/src/footprint.ts`, `pricing.ts` | Proto-pricing; migrate to capability-driven estimates from the same resolved graph. |

Removed in Phase 2 (no successor role): the runtime-v1 CDK application stack
and Documenso preset, `DOCUMENSO_PARAMETERS`, the profile→URL resolution,
the synth/publish application scripts, the committed application template
artifacts and their lifecycle/sizing parity tests, the bootstrap
`ApplicationTemplateUrl` override, and the shadow runner
(`dynamic-infrastructure-shadow.ts`).

Target roles as implemented:

- `ApplicationGraph` → projection of the manifest; no `capabilityKey` on
  resources; kind/engine describe the need.
- `Capability Resolver` → deterministic kind/engine → capability mapping,
  owned by the planner/capability layer.
- `DeployzIR` → authoritative provisioning intent with capability-selected
  resources.
- `DeploymentSpecV2` → frozen envelope; the compiler fills
  `compilerVersion`, `templateHash` and `artifactLocation`, and the
  completed spec is persisted on the deployment row.
- Capability registry → generalizes `INFRASTRUCTURE_COMPONENTS` +
  `AWS_RESOURCES` + footprint handlers + pricing adapters; registers only
  current capabilities.
- Infrastructure compiler → `packages/infrastructure-compiler`, the sole
  CloudFormation source for the MVP.
- Relay → executes the artifact URL carried in its INSTALL payload; never
  synthesizes templates and never resolves template URLs from profiles.

## 29. UI/UX

Dynamic infrastructure requires UI evolution, not a wholesale redesign.

### 29.1 Core UX principle

Do not create an infrastructure designer.

Vendor responsibility:

> Confirm that Deployz understood the application.

Customer responsibility:

> Understand and approve what Deployz will create in the customer's AWS
> account.

### 29.2 Vendor application

Keep the existing primary tabs:

``` text
Overview
Configuration
Releases
```

Do not add a top-level Architecture tab for MVP.

**Overview** should show a compact architecture summary:

``` text
Architecture detected

1 web application
2 background workers
MySQL
Redis
2 queues
S3

Ready to deploy
[View architecture]
```

Use progressive disclosure.

**Configuration** becomes the place to resolve architecture questions.
Organize around: - environment variables; - application architecture; -
infrastructure preferences; - advanced settings.

Components may show: - Detected automatically - Confirmed - Needs input

Avoid raw confidence percentages by default.

A compact graph view may explain relationships but should not be
editable IaC.

Ambiguity should become focused questions, not JSON/YAML editing.

**Implemented (Phase 3).** The Overview "Architecture detected" card, the
Configuration sections (Environment variables / Application architecture
/ Data & infrastructure / Deployment preferences) and the three
component states render through the surfaces documented in
`ui-system.md`; the card hides while the readiness payload carries no
`architecture` block, and analysis states win over it.

### 29.3 Releases

For code-only releases show:

``` text
No infrastructure changes
```

For future topology changes show a semantic diff such as:

``` text
+ Email worker
+ Email queue
~ Worker IAM
```

Do not automatically execute unsupported topology upgrades during the
initial MVP.

**Implemented (Phase 3).** Each release shows an Infrastructure line:
`No infrastructure changes`, or a warning that the release requires
infrastructure changes and automatic infrastructure upgrades are not
supported yet. The update plan always carries `infrastructureChange`
(`none`, or `unsupported` with reason `topology_changed`); the semantic
diff shown above stays future work.

### 29.4 Customer install

Keep the customer experience simpler than the vendor experience.

The page should answer: 1. What will be created? 2. Where? 3.
Approximate cost? 4. What can the customer choose? 5. What happens to
data on disconnect?

Group resources by: - Application - Data - Messaging - Storage -
Networking - Edge

Keep technical AWS details expandable.

**Implemented (Phase 3).** The install page groups "What Deployz will
create" under the eight shipped groups (application, data, cache,
storage, messaging, networking, edge, security) — the fallback chain is
component group → kind map → Application, and only non-empty groups
render.

### 29.5 Resource selection

Continue required/recommended/optional semantics, but make them
planner-driven.

Required resources are locked.

When optional choices affect dependencies, the backend planner
recalculates the plan.

### 29.6 Region

Keep customer region selection where permitted.

The planner evaluates capability availability in the selected region and
explains incompatibility.

The frontend should not own a static capability matrix.

### 29.7 Cost

Show: - estimated monthly total; - expandable category breakdown.

Avoid AWS SKU jargon by default.

### 29.8 Deployment progress

Progress should be component-driven rather than hard-coded by
CloudFormation resource type.

Compiler/capability metadata should map:

``` text
logicalResourceId
    ↓
componentId
    ↓
presentation metadata
    ↓
friendly progress
```

Example:

``` text
✓ Private network
✓ MySQL
✓ Redis
✓ Email queue
● Starting application
○ Checking application
```

For multiple workloads:

``` text
✓ Web
✓ Email worker
● Jobs worker
```

Keep raw CloudFormation events behind progressive disclosure.

**Implemented (Phase 3).** Progress renders component lists from the
status payload's `specComponents`, derived from stack events through the
spec's ownership records; payloads without `specComponents` fall back
byte-identically to the legacy rendering.

### 29.9 Failures and diagnostics

Customer-facing errors should reference understandable application
components.

Vendor diagnostics can include: - component ID; - capability; - failed
check; - likely cause; - relevant logs; - coding-agent fix prompt.

**Implemented (Phase 3).** The failure context carries the affected
component (`componentId`/`componentLabel`) and the vendor diagnostic
card names it; customer surfaces keep component labels and neutral
details, never raw AWS types.

### 29.10 Infrastructure details

Evolve the existing shared infrastructure-details UI rather than
replacing it.

Group: - Compute - Data - Storage - Messaging - Networking - Edge -
Security

Expanded details may show: - AWS service; - exact size; -
lifecycle/retention.

### 29.11 Lifecycle UX

Stateful resources should explicitly explain retention.

Example:

``` text
On disconnect: retained
On permanent deletion: deleted after confirmation
```

Purge confirmation should derive the actual retained-resource list from
ownership/lifecycle data.

### 29.12 Shared UI model

UI should consume backend planning data:

``` text
ApplicationGraph
    ↓
Planner
    ↓
DeploymentPlan API
    ↓
Vendor UI / Customer UI / Diagnostics
```

The frontend never independently infers infrastructure intent.

## 30. Testing

Preserve the existing layered testing philosophy.

### Analysis fixtures

Cover: - MySQL; - workers; - SQS; - cron; - Lambda; - DynamoDB; -
MongoDB; - OpenSearch; - multiple Dockerfiles; - external
dependencies; - ambiguity.

### Capability conformance

Every capability should test: - valid/invalid resolution; -
deterministic output; - pricing; - lifecycle; - verification; - IAM; -
security; - destroy/purge.

### Compiler fixtures

Maintain representative fixtures including: - web-only; - Postgres; -
Redis; - MySQL; - web + worker; - multiple workers; - SQS worker; -
scheduled job; - DynamoDB; - DocumentDB; - OpenSearch; - CloudFront; -
generic private service; - generic + EFS; - Lambda + SQS.

Prefer semantic assertions with targeted identity snapshots.

### Capability-composition tests

The compiler test suite must prove composition, not static topology
selection:

- adding a capability adds only its required resources/bindings/verification;
- removing a capability has predictable effects;
- unrelated component logical identities remain stable;
- IR ordering does not affect compiled infrastructure;
- identical inputs produce equivalent graph/template/hash;
- sizing changes affect only relevant resources;
- every managed resource maps to `componentId + capability + resourceRole`;
- no static topology-selection logic exists in compiler-v2.

Capability composition — not the four historical template variants — is
the primary testing model. The old runtime-v1 template comparisons and
their parity tests were removed with runtime-v1; the retained-delete
simulated scenario (`retained-delete-recovery`) and the composite canary
prove DESTROY-retains / PURGE-removes instead.

### Real AWS canaries

Before adding new capabilities, the compiler must safely deploy and
destroy representative compositions of the current capabilities
(ECS/Postgres/Redis/S3/ALB/Secrets Manager).

Then add targeted canaries for new capabilities.

**Phase 5 status.** SQS and EventBridge Scheduler shipped through
simulated E2E, unit and compiler tests only. A real-AWS canary for
these capabilities is recorded as pending (see the Phase 5 Result in
`docs/dynamic-infrastructure-implementation-plan.md`); `aws.sqs` and
`aws.eventbridge-scheduler` stay at `PREVIEW` maturity until it runs.

## 31. Infrastructure Evolution

Automatic topology upgrades are deferred until the dynamic-install path
is mature.

For the MVP, an infrastructure change that would replace or delete a
managed resource—especially a stateful resource—fails closed. The
allowed release path is image/config changes with unchanged topology.

Future flow (post-MVP):

``` text
DeploymentSpec A
    ↓
DeploymentSpec B
    ↓
semantic IR diff
    ↓
CloudFormation Change Set
    ↓
replacement analysis
    ↓
safety policy
    ↓
safe update / migration required
```

## 32. Explicit Non-Goals for Initial Dynamic MVP

Not initial goals: - arbitrary AI-generated infrastructure; - arbitrary
Terraform/CloudFormation/IAM/Kubernetes execution; - multi-region
application architectures; - complex distributed databases; - automatic
destructive migrations; - automatic stateful replacement; -
customer-facing AWS infrastructure builder; - fully generic AWS service
generation; - GPU/Windows workloads; - arbitrary customer IAM; - Direct
Connect/VPN; - Kafka clusters.

## 33. Success Metrics

Track: - percentage of repositories correctly understood; - percentage
automatically deployable; - percentage requiring vendor clarification; -
percentage blocked by missing capability; - vendor correction rate; -
first-install success; - retry success; - destroy success; - purge
success; - false-positive infrastructure detection; - plan-vs-actual
mismatch; - blocker counts by capability.

Use the repository corpus as a roadmap engine.

## 34. Architectural Success Criterion

The goal is not to support the largest number of AWS services.

The goal is:

> Adding the next safe application capability should primarily mean
> adding a capability, its detection/planning/bindings/verification, and
> tests---not modifying Deployz everywhere.

After SQS and EventBridge Scheduler are implemented, explicitly verify
this property before accelerating capability expansion.

**Phase 5 review.** SQS/Scheduler knowledge landed only in the
capability registry, the resolver, the compiler, the detection module
and two presentation tables. The relay gained no queue/schedule-specific
logic — only generic mechanisms (contract-check verification,
release-image registration into spec-named task families, stopping
standalone tasks at destroy). See HARD GATE C in
`docs/dynamic-infrastructure-implementation-plan.md` for the full
review.

## 35. Product Principle

> Deployz understands your SaaS like a DevOps engineer, but deploys it
> like a compiler.
