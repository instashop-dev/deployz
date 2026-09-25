# Deployz Dynamic Infrastructure --- Phasewise Implementation Plan for AI Coding Agents

**Status:** Implementation plan\
**Audience:** AI coding agents and human reviewers\
**Companion:** `docs/dynamic-infrastructure-tech-spec.md`

## 1. Purpose

This document defines the implementation sequence for evolving Deployz
from fixed AWS application templates into a deterministic
dynamic-infrastructure platform.

Read the companion technical specification before implementing any
phase.

The core implementation rule is:

> First make the new architecture reproduce everything Deployz already
> does. Only then use it to support more architectures.

Because Deployz is pre-launch, "everything Deployz already does" means
the current supported application architecture, not compatibility with
historical runtime-v1 deployments or static template variants.

## 2. Program Overview

  -----------------------------------------------------------------------------------
  Phase             Outcome              Production impact Gate
  ----------------- -------------------- ----------------- --------------------------
  0                 Baseline &           None              Current lifecycle proven
                    guardrails                             

  1                 ApplicationGraph +   Shadow only       Current repos represented
                    IR foundation                          correctly

  2                 Dynamic compiler     Yes               Hard Gate A
                    parity + operational                   New deployments use
                    foundation                             compiler-v2

  3                 Generic UI +         Yes               Current deployments
                    cleanup                                unchanged or better

  4                 MySQL + workers +    Yes               Hard Gate B
                    private services +                     
                    migrations                             

  5                 SQS + EventBridge    Yes               Hard Gate B
                    Scheduler                              

  6                 Extended capability  Incremental       Capability-by-capability
                    program                                
  -----------------------------------------------------------------------------------

Automatic infrastructure topology upgrades are deferred until after the
initial dynamic-infrastructure MVP.

## 3. Non-Negotiable Rules

1.  `ApplicationGraph` describes what the application needs; it does not
    contain AWS capability decisions.
2.  `DeployzIR` is authoritative provisioning intent.
3.  CloudFormation is a deterministic derived artifact.
4.  `DeploymentSpecV2` freezes the v2 deployment contract.
5.  AI may infer application semantics but may not directly provision
    AWS.
6.  New AWS infrastructure comes through known, versioned capabilities.
7.  `dynamic-compiler-v2` is the sole infrastructure generation for the
    MVP; there are no live runtime-v1 deployments to remain compatible
    with.
8.  Unsafe stateful replacement/destruction fails closed.
9.  Relay remains a bounded execution mechanism.
10. UI derives infrastructure decisions from backend planning.

## 4. General Agent Execution Rules

For every phase:

1.  Read the complete tech spec and this plan.
2.  Inspect latest `main` and recent relevant commits.
3.  Verify assumptions against actual code/tests/docs.
4.  Reuse existing abstractions instead of duplicating them.
5.  Produce a concise current-phase plan.
6.  Implement the phase end-to-end.
7.  Run the appropriate test ladder.
8.  Fix failures rather than merely reporting them.
9.  Run real AWS tests when the phase requires them.
10. Clean temporary AWS resources.
11. Update documentation in the same work.
12. Review the implementation against architectural invariants.
13. Use focused PR(s), resolve CI/review issues, and merge when safe.

Do not stop after analysis, planning, code generation, opening a PR, or
a normal fixable CI failure.

Implement only the current phase. Do not opportunistically implement
future capabilities.

## 5. Infrastructure Generation Strategy

The deployment `infra_version` column tracks the infrastructure
generation. The MVP uses only:

``` text
dynamic-compiler-v2  (compiler generation, Phase 2+)
```

Runtime-v1 is not carried forward. There is no migration period because
Deployz is pre-launch and has no live customer deployments on
runtime-v1.

# Phase 0 --- Baseline & Guardrails

## Objective

Establish a verified baseline of current Deployz behavior and reconcile
the target documents with repository reality.

No intentional production provisioning behavior change.

## Work

Inspect and trace:

``` text
repo
 → analysis
 → manifest/plan/profile
 → CDK/template
 → API
 → relay
 → CloudFormation
 → AWS
 → verification/lifecycle
 → vendor/customer UI
```

Establish the exact baseline for: - stateless; - PostgreSQL; -
Redis/Valkey; - PostgreSQL + Redis/Valkey; - S3; - ALB/networking; -
Secrets Manager; - HTTPS/domain behavior where relevant.

Inspect: - contracts and analysis; - deployment
manifest/profile/footprint/plan; - build/image assumptions; -
CDK/template generation and publication; - relay
commands/retry/idempotency; - verification/health; -
destroy/purge/retention; - IAM/networking; - preflight/quotas; - region
handling; - pricing; - customer progress; - vendor/customer UI; -
simulation; - compatibility tests; - CI and AWS canaries.

Compare actual code with both dynamic-infrastructure documents.

Classify material findings as:

``` text
CURRENT_IMPLEMENTATION_GAP
SPEC_INACCURACY
REUSE_OPPORTUNITY
MISSING_REQUIREMENT
OVERENGINEERING
ARCHITECTURAL_CONFLICT
```

The agent may directly update both documents for all categories except
`ARCHITECTURAL_CONFLICT`, which requires human review.

Specifically determine the future role of existing: -
`ApplicationAnalysis`; - `DeploymentManifest`; -
`DeploymentFootprint`; - `DeploymentPlan`; - `InfrastructureProfile`

relative to: - `ApplicationGraph`; - `DeployzIR`; - `DeploymentSpecV2`.

Avoid duplicate abstractions.

Make only minimal code changes needed for baseline tests, version/shadow
scaffolding, observability, or clearly necessary guardrails.

## Tests

Run relevant existing: - type/lint; - unit; - contract; - analysis; -
CDK; - relay; - simulation; - UI; - compatibility; - integration tests.

Use the established real-AWS canary process to establish a trustworthy
lifecycle baseline where appropriate.

Cover relevant: - install; - verification; - deploy release; -
restart; - rollback; - destroy; - purge; - retry/rollback/retention
behavior.

Clean temporary AWS resources.

## Non-goals

Do not implement: - production ApplicationGraph/DeployzIR; - dynamic
compiler; - MySQL; - worker provisioning; - private services; -
migration workloads; - SQS/EventBridge; - extended capabilities; -
infrastructure upgrades.

## Exit Criteria

Phase 0 passes when: - current architecture/lifecycle is verified; -
current CI and required AWS canaries pass; - reusable abstractions and
hard-coded assumptions are identified; - both dynamic-infrastructure
documents reflect repository reality and remain mutually consistent; -
no production behavior changed unintentionally; - Phase 1 can start
without rediscovering current architecture.

## Phase 0 Result (2026-09-25)

The existing abstractions already cover much of the target architecture.
The authoritative mapping lives in the tech spec §28.1; the material
corrections made here are:

- **Generation naming**: the live generation value is `infra_version:
  runtime-v1`, not `legacy-template-v1` (§5, tech spec §12).
- **Durable relay idempotency already exists** — the SSM pending-command
  marker, durable idempotency keys and describe-before-create executors.
  Phase 2 hardens it rather than building it from scratch (Phase 2).
- **Size profiles already exist** as `InfrastructureSizeProfile`
  (`small-v1`); `InfrastructureProfile` (`{ postgres, redis }`) is the
  separate graph-shaping key (tech spec §22).
- **Compatibility vocabulary already exists**: `READY` /
  `NEEDS_CONFIGURATION` / `NOT_COMPATIBLE` (manifest) and `READY` /
  `NEEDS_ATTENTION` / `NOT_COMPATIBLE` (application) (tech spec §23).

No production code changed: this phase is a verification and
documentation reconciliation. The current supported variants (stateless,
PostgreSQL, Redis/Valkey, PostgreSQL+Redis, plus S3/ALB/Secrets
Manager/HTTPS) are the four published application templates selected by
`InfrastructureProfile`, and every invariant in
`docs/deployment-resilience.md` is preserved.

# Phase 1 --- ApplicationGraph, Evidence, Planner and DeployzIR

## Objective

Create generalized application and infrastructure models in shadow mode
without changing production provisioning.

## ApplicationGraph

Add a versioned graph supporting:

``` text
buildArtifacts[]
workloads[]
resources[]
bindings[]
externalServices[]
unresolved[]
evidence/provenance
```

Workloads: - web; - worker; - private-service; - migration; -
scheduled-job; - lambda.

Resources: - relational database; - document database; - key-value
database; - cache; - queue; - object storage; - filesystem; - search; -
event bus; - generic service; - external service.

Support multiplicity and stable component IDs.

## BuildArtifact

Make build artifacts first-class and let workloads reference them.

The initial production implementation may restrict unique build
artifacts to one, but the schema must support multiple.

## Ownership

Model:

``` text
DEPLOYZ_MANAGED
CUSTOMER_EXISTING
CUSTOMER_PROVIDED
VENDOR_PROVIDED
EXTERNAL_SAAS
OPTIONAL
UNRESOLVED
```

## Relationship Types

Model:

``` text
PROVISIONING
RUNTIME
BINDING
STARTUP
```

## Evidence

Extend deterministic analysis for: - Dockerfiles/Compose; - package
manifests; - Prisma/ORM; - env declarations/runtime reads; -
Procfile/startup config; - Terraform/CFN/CDK/Pulumi; -
Kubernetes/Helm; - SAM/Serverless; - CI; - README/deployment docs; -
source/framework usage.

Repository IaC is evidence, never automatically executed.

## AI

AI may reconcile semantic ambiguity through strict typed output.

It does not choose arbitrary AWS resources or create trusted
infrastructure.

## Capability Registry

Introduce the interface but initially register only existing supported
capabilities.

The interface must cover: - validation; - resolution; - bindings; -
IAM; - network; - lifecycle; - verification; - pricing; -
presentation; - diff; - maturity/version.

## Planner

Implement:

``` text
ApplicationGraph
 + configuration
 + region
 + size profile
 + policy
       ↓
DeployzIR
```

Planner determines dependency closure, required/recommended/optional
resources, placement, and region compatibility.

## DeploymentSpecV2

Freeze/reference: - graph; - IR; - hashes; - compiler version; -
capability versions; - template metadata when compiled.

## Shadow Mode

Continue provisioning through the legacy path while generating Graph →
IR in parallel for comparison.

## Tests

Extend repository fixtures for: - current supported apps; - workers; -
MySQL; - MongoDB; - queues; - schedules; - multiple Dockerfiles; -
monorepos; - external/optional dependencies; - ambiguity.

Separate detection, graph, capability-resolution, and deployability
accuracy.

## Exit Criteria

-   current supported repos produce correct graphs;
-   current topology maps cleanly to IR;
-   unsupported resources can exist without breaking analysis;
-   external dependencies are not incorrectly provisioned;
-   ambiguity becomes explicit unresolved state;
-   generalized contracts avoid current boolean/singleton assumptions;
-   production still uses the legacy path.

## Phase 1 Result (2026-09-25)

Phase 1 built the generalized models. Because Deployz is pre-launch, these
models become the production path in Phase 2 rather than remaining in
shadow mode.

Implemented:

- **Versioned contracts** (`packages/contracts/src/`):
  - `application-graph.ts` — `ApplicationGraph` (buildArtifacts[],
    workloads[], resources[], bindings[], externalServices[],
    unresolved[], evidence/provenance), multiplicity, stable component IDs,
    ownership (`DEPLOYYZ_MANAGED` … `UNRESOLVED`), relationship types
    (`PROVISIONING`/`RUNTIME`/`BINDING`/`STARTUP`).
  - `deployz-ir.ts` — `DeployzIR` (workloads, resources, bindings, ingress,
    schedules, policies, lifecycle, placement, metadata).
  - `deployment-spec-v2.ts` — `DeploymentSpecV2` (graph + IR + hashes +
    capability-registry version + size-profile id + compiler/template
    placeholders).
  - `capability-registry.ts` — the capability registry interface and the
    default registry registering only current capabilities
    (ecs-service, ecs-task, rds-postgres, elasticache-valkey, s3, alb,
    secrets-manager), each with lifecycle/network/bindings/iam/pricing/
    presentation metadata.
- **Graph builder** (`packages/analysis/src/graph.ts`):
  `manifestToApplicationGraph` / `buildApplicationGraph` re-express the
  manifest as a generalized graph describing what the application needs.
  Unsupported reasons become blocking `unresolved[]`; external services
  become `EXTERNAL_SAAS` resources (never provisioned); ambiguity becomes
  explicit non-blocking `unresolved[]`.
- **Planner** (`packages/analysis/src/planner.ts`):
  `planApplicationGraph` → `DeployzIR`, plus `buildDeploymentSpecV2` /
  `planApplicationGraphWithSpec`. Pure and deterministic; resolves
  workload→compute capability, resource→capability, sizing from the immutable
  size profile, and IAM intents from capability bindings.
- **Shadow integration** (`apps/api/src/dynamic-infrastructure-shadow.ts`):
  wired into the analysis runner and the server to exercise the graph → IR
  → spec pipeline. In Phase 2 this becomes the real provisioning-intent
  path.

Reuse vs. new (per tech spec §28.1): `DeploymentGraph` is a versioned
projection of `DeploymentManifest`. `DeploymentManifest` remains the frozen
input contract. `DeployzIR` is the authoritative provisioning intent.
`DeploymentSpecV2` is the frozen envelope. The capability registry
generalizes `INFRASTRUCTURE_COMPONENTS` + footprint handlers + pricing
adapters.

Phase 2 refinements:

- `capabilityKey` moves from the graph builder into the resolver/planner.
  The graph describes need (kind/engine); the planner selects the AWS
  capability.
- Planner sizing/config switches migrate into per-capability compile
  handlers where they remain.

# Phase 2 --- Dynamic Compiler Parity & Operational Foundation

## Objective

Build compiler v2 and make it the sole MVP infrastructure-generation path.
Because Deployz is pre-launch, runtime-v1 backward compatibility and
migration support are not required.

## Compiler

Introduce a dedicated compiler boundary.

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

Implement only current capabilities: - ECS web; - RDS PostgreSQL; -
Redis/Valkey; - S3; - ALB; - Secrets Manager; - current networking.

Do not preserve runtime-v1 template selection or the four static
variants. The compiler composes these capabilities from `DeployzIR`.

## Determinism

Equivalent IR/compiler/capability/profile/region rules must produce
equivalent infrastructure.

No random IDs, timestamps, unstable iteration, AI-generated IDs,
synth-time AWS discovery, or repository-controlled logical IDs.

## Stable Resource Identity

Derive logical identity from:

``` text
componentId + capability + resourceRole
```

Add stability tests, especially for stateful resources.

Do not preserve runtime-v1 CDK auto-hashed logical IDs; semantic identity
is the source of truth for the MVP.

## Resource Placement

Introduce:

``` text
REGIONAL
GLOBAL
FIXED_REGION
```

even though current capabilities are mostly regional.

## Lifecycle Metadata

Every capability explicitly defines: - statefulness; - retention; -
replacement policy; - backup/restore support; - purge; - verification.

## Resource Ownership

Track managed resources by
installation/component/capability/logical/physical identity and
lifecycle metadata.

Use it as the basis for verification, destroy, purge, recovery, and
diagnostics.

## Generic Verification

Move toward compiler-generated verification contracts covering: -
resource health; - workload health; - binding health where practical.

## Durable Relay Idempotency

The relay already has durable idempotency: the SSM pending-command marker
(`packages/relay/src/pending.ts`), durable per-operation idempotency keys
(`createOrReuseJob`), and describe-before-create executors. Phase 2 must
harden and generalize this, not replace it.

Retries and Lambda cold starts must not duplicate side effects.

## Preflight

Implement only the checks materially required for safe compiler-v2
deployments of current capabilities: - permissions; - region/service
availability; - quota/resource constraints; - networking constraints; -
CloudFormation/compiler limits.

Fail safely where a check cannot be performed. Do not build a speculative
generalized quota framework.

## Stateful Safety

Implement explicit retention/replacement policies.

Unsafe stateful replacement fails closed.

Full semantic diffing, Change Sets and migration workflows remain
deferred.

## Immutable Artifacts

Persist graph/IR/compiler/capability/template hashes and immutable
compiled artifact metadata.

Never regenerate an old deployment with a new compiler and assume
equivalence. The deployment spec freezes the artifact that was used at
install time.

## Capability-Composition Testing

Test compiler invariants instead of static topology variants:

- adding a capability adds only its required resources/bindings/verification;
- removing a capability has predictable effects;
- unrelated component logical identities remain stable;
- IR ordering does not affect compiled infrastructure;
- identical inputs produce equivalent graph/template/hash;
- sizing changes affect only relevant resources;
- every managed resource maps to `componentId + capability + resourceRole`;
- no static topology-selection logic exists in compiler-v2.

Keep runtime-v1 template comparisons only as a regression safety-net, not
as a compatibility contract.

## Real AWS Lifecycle

Test representative real-AWS scenarios:

- simple: web + storage + ingress + secrets;
- composite: web + postgres + redis + storage + ingress + secrets;
- control-plane/relay day-2: DEPLOY_RELEASE, RESTART, ROLLBACK;
- retry/idempotency: install retry, command redelivery, relay cold start,
  destroy retry, purge retry.

## HARD GATE A --- Compiler Parity (revised for pre-launch MVP)

Do not add new capabilities until:

1. Graph → Resolver/Planner → IR → Compiler boundaries are clean;
2. compiler is capability-compositional;
3. compilation is deterministic;
4. stable semantic logical identities are proven;
5. stateful retention/replacement behavior is safe;
6. unsupported destructive infrastructure changes fail closed;
7. lifecycle and verification are component/capability-driven;
8. ownership supports verify/destroy/purge/recovery;
9. retry/idempotency is safe across redelivery/cold starts;
10. required MVP preflight checks work or fail safely;
11. simple and composite/stateful real-AWS validation passes;
12. real control-plane/relay day-2 lifecycle works with compiler-v2;
13. temporary AWS resources are fully cleaned;
14. intended MVP production path does not retain unnecessary
    runtime-v1/dual-architecture complexity.

Exact v1 template parity and migration support are not required.

## Phase 2 Result

The compiler-v2 pipeline (Graph → Resolver/Planner → IR → Compiler) is
implemented and proven on real AWS. The relay cutover and runtime-v1
removal are the remaining Phase 2 work (see the known-gap list below).

What landed:

- **Clean boundaries**: `ApplicationGraph` describes need (kind/engine);
  capability selection lives in the resolver/planner; `DeployzIR` is the
  authoritative provisioning intent; `packages/infrastructure-compiler`
  is the deterministic CloudFormation source.
- **Stable logical identity**: every managed resource id derives from
  `componentId + capability + resourceRole`, pinned by golden tests.
- **Capability composition**: the compiler is tested for compositional
  invariants (add/remove capability, stable unrelated identities,
  ordering independence, deterministic hash) rather than static topology
  selection.
- **Determinism**: no timestamps, random ids, AI, or synth-time AWS
  lookups.
- **Stateful safety**: retention/replacement policies are explicit;
  `safety.ts#assertNoDestructiveStatefulChanges` fails closed on any
  change that would replace or delete a retained resource.
- **MVP preflight**: targeted checks for region/capability availability,
  CloudFormation limits, NAT/VPC constraints and quota heuristics
  (`packages/analysis/src/compiler-preflight.ts`).
- **Real AWS**: the stateless canary and the composite (web + postgres +
  redis + storage + ingress + secrets) canary pass INSTALL → VERIFY →
  retention → DESTROY → retained-resource handling → PURGE → cleanup.
  Retention is proven: the RDS instance, its secrets and the bucket
  survive DESTROY and are removed by PURGE.

Known gaps (remaining Phase 2 cutover, not silent):

- **Relay cutover**: the relay still resolves one of the four runtime-v1
  template URLs from the manifest profile. Persisting the compiled
  `DeploymentSpecV2` artifact and pointing the relay at it — including
  aligning the template parameter contract (the runtime-v1 template is
  Documenso-shaped; compiler-v2 uses generic app secrets) — is not yet
  done.
- **Relay day-2**: DEPLOY_RELEASE / RESTART / ROLLBACK are not yet
  exercised against a compiler-v2-provisioned stack through the live
  control plane/relay; they are validated against the runtime-v1 path.
- **Runtime-v1 removal**: the runtime-v1 CDK application stack, the four
  committed artifacts and the profile→URL resolution remain on the
  production path until the cutover; they are retained because removing
  them first would break provisioning, not for backward compatibility.

# Phase 3 --- Generic UI & Cleanup

## Objective

Make the UI capability-driven and remove any remaining runtime-v1
machinery that is no longer needed once the relay cutover is complete.

## Vendor UI

Keep: - Overview; - Configuration; - Releases.

Do not add an infrastructure-builder.

Overview: compact architecture summary and readiness.

Configuration: generic architecture sections and focused unresolved
questions.

Use statuses such as: - Detected automatically; - Confirmed; - Needs
input.

Do not expose raw confidence by default.

## Customer UI

Preserve the current install flow.

Group infrastructure by: - Application; - Data; - Messaging; -
Storage; - Networking; - Edge.

Continue: - region; - estimated cost; - required/recommended/optional
choices; - lifecycle explanation.

Frontend never derives dependency rules.

## Progress

Replace hard-coded AWS-resource presentation with:

``` text
CFN logical resource
 → component ID
 → capability presentation metadata
 → friendly activity
```

Keep raw AWS events behind progressive disclosure.

## Diagnostics

Customer errors reference understandable components.

Vendor diagnostics may show component, capability, failed check, logs,
likely cause, and suggested action.

## Exit Criteria

-   UI is graph/plan/capability-driven;
-   simple PostgreSQL deployment is no more complicated;
-   full real-AWS lifecycle passes;
-   no runtime-v1-only code remains on the production path.

# Phase 4 --- Core MVP Expansion

## Objective

Add: - MySQL; - multiple workers; - private services; - migration
workloads.

## MySQL

Add `aws.rds-mysql`.

Reuse generic network, credentials, secrets, retention, backup policy,
purge, verification, and pricing.

Keep engine-specific connection/version/migration behavior isolated.

## Multiple Workers

Use `workloads[]`.

Initially allow multiple workload commands to share one build artifact.

Each workload gets independent command, bindings, IAM, sizing/count, and
health.

Never add numbered worker fields.

## Private Services

Support ECS services without public ingress and with internal
networking/service discovery where needed.

## Migration Workload

Model migrations as first-class one-shot workloads:

``` text
infrastructure ready
 → migration
 → success → services
 → failure → stop rollout + diagnostics
```

## Tests

Cover representative combinations: - web + MySQL; - web + Postgres +
worker; - web + MySQL + worker; - multiple workers + Redis; - private
service; - database + migration.

Run real AWS canaries.

## HARD GATE B --- Core Architecture

Review whether MySQL/workloads were added primarily through generalized
capability/graph/compiler behavior.

Unexpected proliferation of API/relay/UI/pricing/progress/destroy/purge
switches is an architecture failure signal.

Fix before continuing.

# Phase 5 --- SQS, EventBridge Scheduler & Scheduled Jobs

## Objective

Prove Deployz can compose infrastructure relationships.

## SQS

Add `aws.sqs`.

Initial support: - standard queue; - optional DLQ; - visibility
timeout; - retention; - producer/consumer IAM; - URL/ARN bindings; -
verification; - pricing; - destroy.

## EventBridge Scheduler

Prefer Scheduler.

Support: - cron/rate; - timezone where needed; - target; - retry
policy; - maximum event age; - DLQ.

Initial target: scheduled ECS task.

Lambda can follow later.

## Bindings/IAM

Graph relationships derive queue permissions, environment bindings,
scheduler roles, target permissions, and DLQ permissions.

Avoid broad shared workload IAM.

## Tests

Cover: - web → SQS → worker; - multiple queues/workers; - scheduler →
ECS task; - scheduled task → database; - DLQ; - missing IAM; - binding
failure; - worker failure; - schedule retry; - destroy/purge.

Run real AWS canaries.

## HARD GATE C --- Capability Extensibility

Review every subsystem changed to add SQS/EventBridge.

Desired:

``` text
capability
detector/evidence
planner mapping
bindings/IAM
pricing
verification
presentation
tests
```

Undesired:

``` text
API switch
relay switch
destroy switch
purge switch
pricing switch
UI switch
progress switch
diagnostics switch
health switch
```

If the undesired pattern is significant, refactor before Phase 6.

# Phase 6 --- Extended Capability Program

After Gate C, treat new infrastructure primarily as capability
additions.

Recommended order:

## 6A Generic Stateless Containers

Support bounded private stateless services/workers, then validated
public HTTP services.

Initially prohibit database-like persistent containers, distributed
clusters, privileged containers, host networking, and arbitrary EC2/user
data.

## 6B Multiple Build Artifacts

Support independent build artifacts such as:

``` text
web → Dockerfile.web
worker → Dockerfile.worker
service → Dockerfile.service
```

Freeze multiple immutable image digests.

## 6C EFS / Persistent Generic Containers

Add EFS and keep persistent generic containers `PREVIEW` initially.

Require explicit mount/network/IAM/retention/backup/purge behavior.

## 6D Lambda

Add explicit runtime/image, handler, architecture, memory, timeout,
environment, IAM, SQS trigger, and Scheduler trigger.

Do not automatically convert ordinary web apps to Lambda.

## 6E DynamoDB

Require sufficiently strong schema evidence/configuration.

Support keys, indexes, billing mode, retention, and IAM bindings.

Do not invent schema from weak AI inference.

## 6F DocumentDB

Build compatibility analysis first.

Mongo dependency detection alone is insufficient.

Uncertain apps remain configuration-required or unsupported.

## 6G OpenSearch

Explicitly model engine, network, sizing, storage, encryption, access,
cost, and replacement/upgrade behavior.

Keep maturity conservative until lifecycle testing is strong.

## 6H CloudFront

Provision in the customer's account.

Exercise global/fixed-region placement without changing the Graph/IR
architecture.

# Deferred Post-MVP --- Infrastructure Upgrades

Do not make automatic topology upgrades a blocker for
dynamic-infrastructure MVP.

Initially allow code/config releases when topology is unchanged.

If a new release requires infrastructure changes, detect and display the
semantic diff but do not automatically execute unsupported changes.

Future flow:

``` text
DeploymentSpec A
 → DeploymentSpec B
 → semantic IR diff
 → CloudFormation Change Set
 → replacement analysis
 → safety policy
 → safe update / migration required
```

Classify: - SAFE; - UPDATE; - REPLACEMENT; - DESTRUCTIVE; -
UNSUPPORTED_MIGRATION.

Never hide stateful replacement behind a normal release.

# Shared UI Principle

Do not build an AWS infrastructure designer.

Vendor goal:

> Confirm Deployz understood the application.

Customer goal:

> Understand what Deployz will create, choose permitted options, connect
> AWS, and deploy.

Use progressive disclosure.

UI consumes backend planning data:

``` text
ApplicationGraph
 → Planner
 → DeploymentPlan API
 → Vendor UI / Customer UI / Diagnostics
```

Frontend does not independently infer infrastructure dependencies or AWS
mappings.

# Architecture Fitness Tests

Add CI protection for invariants such as: - AI analysis cannot invoke
AWS provisioning; - planner cannot invoke AWS; - compiler cannot invoke
AI; - frontend does not own dependency logic; - relay does not expose
arbitrary AWS commands; - every capability defines lifecycle metadata; -
every managed resource maps to a component; - stateful capabilities
define retention/replacement; - equivalent IR/compiler produces
equivalent infrastructure; - stable component identity produces
stable logical identity; - unknown capabilities fail closed; - secrets
do not enter generated artifacts in plaintext; - ApplicationGraph does
not contain AWS capability decisions; - compiler-v2 contains no static
topology-selection logic.

# PR Strategy

A phase is not necessarily one PR.

Prefer focused, reviewable PRs that leave `main` green.

For compiler parity, natural PR boundaries may include: - compiler
contracts/skeleton; - stable resource identity; - network/IAM; - current
capabilities; - verification/lifecycle; - ownership/idempotency; -
preflight/safety; - artifact publication; - parity/canary integration.

Combine closely related work where clearer. Avoid mechanical PR
fragmentation.

# Agent Parallelism

Use one primary orchestrator per phase.

It may use focused subagents for: - reconnaissance; - contracts; -
analysis; - compiler/CDK; - relay/lifecycle; - API/data; - frontend; -
testing; - architecture review.

One orchestrator owns integration and shared contracts.

Parallelize work within the current phase rather than starting future
phases early.

# Testing Escalation

Use the cheapest useful test first:

``` text
type/lint/schema
 → unit
 → contract
 → compiler/fixture
 → integration/simulator
 → targeted AWS canary
 → full lifecycle AWS canary
```

Do not run expensive AWS tests for every small change.

Do run them before crossing infrastructure phase gates.

# Definition of Done

A phase is complete only when: - required code is implemented; -
contracts are versioned where needed; - relevant tests pass; -
architecture fitness tests pass; - CI passes; - required AWS canaries
pass; - temporary AWS resources are cleaned; - failure/retry behavior is
tested; - relevant UI states are tested; - documentation is updated; -
no unresolved critical/high-severity issue remains; - implementation has
been reviewed against the tech spec; - PR(s) are merged.

Backward compatibility is not required for the pre-launch MVP because
there are no live customer deployments on runtime-v1.

# Program Success Criterion

The most valuable initial milestone is after Phase 5.

Deployz should then safely understand and deploy combinations of:

``` text
web
multiple workers
private services
migration task
PostgreSQL
MySQL
Redis/Valkey
S3
SQS
scheduled jobs
ALB/private networking
```

with automatic analysis, bounded AI assistance, vendor clarification
where needed, customer choices, cost estimation, deterministic
infrastructure generation, least-privilege bindings, friendly progress,
verification, retry, destroy, retention, purge, and diagnostics.

The ultimate architecture test is:

> Adding the next safe capability should feel like adding a
> capability---not modifying Deployz everywhere.
