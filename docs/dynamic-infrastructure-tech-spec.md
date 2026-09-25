# Deployz Dynamic Infrastructure --- Consolidated Technical Specification

**Status:** Target architecture\
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
ApplicationGraph
    ↓
Capability Resolver
    ↓
Planner
    ↓
DeployzIR
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

Existing deployments remain on their frozen infrastructure generation.

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
Runtime cycles are normal.

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

Infrastructure generations must be explicit, tracked on the deployment's
`infra_version` column:

``` text
runtime-v1           (the current published-template generation)
dynamic-compiler-v2  (the compiler generation, Phase 2+)
```

Existing deployments are never silently recompiled with a new compiler.

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

Phase 2 should generalize this durable marker/idempotency model to serve
the compiler-generated deployment spec, keeping the conceptual key:

``` text
installationId + idempotencyKey
```

with command/status/result metadata and conditional writes.

## 17. Verification

Move toward a compiler-generated generic verification contract.

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

Two profile concepts must stay distinct:

- `InfrastructureProfile` (`{ postgres, redis }`) — graph-shaping: which
  template variant to select.
- `InfrastructureSizeProfile` (`small-v1`) — sizing: CPU/memory, desired
  counts, RDS class, cache node type/count.

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
these names rather than introducing a parallel set. A richer backend
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

### 25.1 MySQL

Map supported MySQL applications to RDS MySQL.

Reuse generic: - network; - credentials; - Secrets Manager; -
retention; - backup policy; - purge; - pricing; - verification.

Keep engine-specific URL/port/SSL/version/migration behavior isolated.

### 25.2 Workers

Use `workloads[]`.

Support one image with multiple commands first.

Each workload may have independent command, bindings, IAM, sizing,
desired count, and health.

### 25.3 Migration

Migration is a first-class one-shot workload.

Typical sequence:

``` text
infrastructure ready
    ↓
migration task
    ↓
success → start services
failure → stop rollout + diagnostics
```

### 25.4 SQS

Initial support: - standard queue; - optional DLQ; - visibility
timeout; - retention; - producer/consumer IAM; - URL/ARN bindings; -
verification; - pricing/lifecycle.

### 25.5 EventBridge Scheduler

Prefer EventBridge Scheduler for scheduled targets.

Support: - cron/rate; - timezone where needed; - target; - retry
policy; - max event age; - optional standard-SQS DLQ.

Initial target may be ECS tasks; Lambda can follow.

### 25.6 DynamoDB

Schema must come from explicit evidence/configuration.

Do not invent key schema from weak AI inference.

Treat key-schema changes conservatively.

### 25.7 Lambda

Lambda has its own build/runtime contract.

Do not assume an ECS image is automatically valid for Lambda.

Model: - runtime/image; - handler; - memory; - timeout; -
architecture; - env; - bindings; - triggers.

### 25.8 DocumentDB

Do not map MongoDB usage to DocumentDB solely because a Mongo driver
exists.

Use compatibility evaluation.

Unknown/incompatible applications require configuration or remain
unsupported.

### 25.9 OpenSearch

Explicitly model: - engine version; - VPC/public placement; -
encryption; - authentication/access; - storage/sizing; -
upgrade/replacement behavior; - cost.

Keep maturity conservative until lifecycle testing is strong.

### 25.10 CloudFront

CloudFront is provisioned in the customer's account.

Model global/fixed-region requirements explicitly, including certificate
placement where relevant.

### 25.11 EFS / generic persistent containers

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
compiler → contracts + capabilities + CDK
relay → contracts
```

Avoid analysis importing provisioning/AWS implementation and AI
importing compiler/relay code.

These package names are targets, not a mandate to duplicate better
abstractions already present in the repository. The reconciliation below
is the Phase 0 result.

### 28.1 Existing abstractions → target abstractions (Phase 0)

`packages/contracts` already holds the derivation core the
planner/capability/compiler layers are meant to own. Phase 1 must evolve
these in place, not duplicate them.

| Existing (today) | Location | Future role |
|---|---|---|
| `ApplicationAnalysis` | `contracts/src/application-analysis.ts`, `analysis/src/application-analysis.ts` | The canonical evidence + derived app projection feeding the manifest. Stays the analysis-layer read model. |
| `DeploymentManifest` | `contracts/src/manifest.ts`, built by `analysis/src/manifest.ts` | The frozen, versioned contract (`schemaVersion: 1`) a deployment is created with; today it fuses requirements and intent. Stays untouched as the production contract. The generalized `ApplicationGraph` (new shadow-mode schema) is derived FROM it — a projection, not an independent model. |
| `DeploymentFootprint` | `contracts/src/footprint.ts` | The resolved "what gets created" model (workloads + resources + sizing). Closest existing analog to a resolved `DeployzIR`; extend, do not replace. |
| `DeploymentPlan` | `contracts/src/plan.ts` | Deterministic INSTALL/UPDATE/DESTROY derived data. Already the planner output the UI consumes. |
| `InfrastructureProfile` | `contracts/src/index.ts` (`{ postgres, redis }`) | Graph-shaping requirement set → template-variant selection. The v1 selection key; superseded by graph `resources[]` in v2. |
| `InfrastructureSizeProfile` | `contracts/src/profile.ts` | The immutable sizing registry (`small-v1`). §22's future sizes are new versions here. |
| `INFRASTRUCTURE_COMPONENTS` | `contracts/src/components.ts` | Proto-capability catalog: lifecycle, verification check, primary resource type. §7's capability registry generalizes this. |
| `AWS_RESOURCES` / `CONNECTOR_RESOURCES` | `contracts/src/aws-resources.ts` | Customer-facing resource catalog + grouping/lifecycle. The presentation half of a capability. |
| `classifyResource` / inventory | `contracts/src/infrastructure.ts` | CFN resource type → component kind/role/lifecycle. The ownership/verification half of a capability. |
| `FOOTPRINT_RESOURCES` / pricing adapters | `contracts/src/footprint.ts`, `pricing.ts` | Resource handlers + pricing adapters keyed by service. The compile/pricing half of a capability. |
| `resolveDeploymentFootprint` + `estimateFootprintCost` | `contracts/src/footprint.ts`, `pricing.ts` | Proto-planner/compiler derivation already in `contracts`. |

Target-role mapping (revised after Phase 1 implementation):

- `ApplicationGraph` → a NEW versioned shadow-mode schema
  (`contracts/src/application-graph.ts`) built from the manifest by
  `analysis/src/graph.ts#manifestToApplicationGraph`. It is a projection of
  the manifest (single source of truth), not an independently-maintained
  parallel model. `DeploymentManifest v1` stays untouched as the production
  contract.
- `DeployzIR` → a NEW versioned schema (`contracts/src/deployz-ir.ts`)
  generalizing the resolved model (footprint + plan + size profile) with
  ingress/schedules/placement/policies.
- `DeploymentSpecV2` → a new versioned envelope
  (`contracts/src/deployment-spec-v2.ts`) freezing graph + IR + hashes +
  capability-registry/size-profile refs; compiler/template hashes are
  `null` until Phase 2.
- Capability registry → a new interface (`contracts/src/capability-registry.ts`)
  generalizing `INFRASTRUCTURE_COMPONENTS` + `AWS_RESOURCES` + footprint
  handlers + pricing adapters; registers only current capabilities.
- Infrastructure compiler → a new boundary; CDK stays the mechanism; the
  relay must never synthesize (already true — templates are pre-published
  and `resolveApplicationTemplateUrl` is a pure string derivation).

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

### 29.4 Customer install

Keep the customer experience simpler than the vendor experience.

The page should answer: 1. What will be created? 2. Where? 3.
Approximate cost? 4. What can the customer choose? 5. What happens to
data on disconnect?

Group resources by: - Application - Data - Messaging - Storage -
Networking - Edge

Keep technical AWS details expandable.

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

### 29.9 Failures and diagnostics

Customer-facing errors should reference understandable application
components.

Vendor diagnostics can include: - component ID; - capability; - failed
check; - likely cause; - relevant logs; - coding-agent fix prompt.

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

### Real AWS canaries

Before adding new capabilities, the compiler must reproduce the current
ECS/Postgres/Redis/S3/ALB lifecycle.

Then add targeted canaries for new capabilities.

## 31. Infrastructure Evolution

Automatic topology upgrades are deferred until the dynamic-install path
is mature.

Future flow:

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

Initial releases may permit only application image/config changes when
topology is unchanged.

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

## 35. Product Principle

> Deployz understands your SaaS like a DevOps engineer, but deploys it
> like a compiler.
