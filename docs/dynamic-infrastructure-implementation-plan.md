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
                    cutover + operational                  New deployments use
                    foundation                             compiler-v2

  3                 Generic UX +         Yes               Current deployments
                    product integration                    unchanged or better

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
`docs/deployment-resilience.md` is preserved. (Phase 0 state only:
Phase 2 cut provisioning over to compiler-v2, made `infra_version`
default to `dynamic-compiler-v2`, and removed the four templates and
`InfrastructureProfile`; the lifecycle invariants are preserved.)

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
    ownership (`DEPLOYZ_MANAGED` … `UNRESOLVED`), relationship types
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
  → spec pipeline. Phase 2 made this pipeline the production provisioning
  path and removed the shadow runner with the rest of the dual-generation
  machinery.

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
(`createOrReuseJob`), and describe-before-create executors. Phase 2 hardened
and generalized this rather than replacing it.

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

The runtime-v1 template comparisons and their parity tests were removed
with runtime-v1; capability composition is the primary testing model.

## Real AWS Lifecycle

Test representative real-AWS scenarios:

- simple: web + storage + ingress + secrets;
- composite: web + postgres + redis + storage + ingress + secrets;
- control-plane/relay day-2: DEPLOY_RELEASE, RESTART, ROLLBACK;
- retry/idempotency: install retry, command redelivery, relay cold start,
  destroy retry, purge retry.

## HARD GATE A --- Compiler Cutover (final implementation)

Do not add new capabilities until:

1.  Graph → Resolver/Planner → IR → Compiler boundaries are clean;
2.  compiler is capability-compositional;
3.  compilation is deterministic;
4.  stable semantic logical identities are proven;
5.  stateful retention/replacement behavior is safe;
6.  unsupported destructive infrastructure changes fail closed;
7.  lifecycle and verification are component/capability-driven, and the
    relay's verification booleans and inventory classification derive from
    the spec's verification contract and ownership records;
8.  ownership supports verify/destroy/purge/recovery;
9.  retry/idempotency is safe across redelivery/cold starts, reusing the
    frozen artifact;
10. required MVP preflight checks work or fail safely;
11. deployment creation compiles the frozen manifest, publishes the
    artifact content-addressed (`compiler-v2/<hash>.json`, `412` = dedup)
    before the spec row is written;
12. the relay executes only the payload's frozen `templateUrl` and fails
    closed without it;
13. INSTALL parameters are typed: digest-pinned image reference, desired
    count 0 for configured-first-start installs, generated `NoEcho`
    application secrets redacted after the claim, manifest-derived port and
    health path, undeclared parameters filtered;
14. simple and composite/stateful real-AWS validation passes;
15. DESTROY settles truthfully: a retained-data `DELETE_FAILED` converges
    through the relay's multi-pass `RetainResources` retry to
    `DELETE_COMPLETE` and the deployment becomes `DELETED`;
16. PURGE removes all retained data, including every owned application
    secret regardless of generation;
17. release semantics hold: releases never recompile infrastructure, and
    requirement drift is reported, never silently applied;
18. real control-plane/relay day-2 lifecycle (DEPLOY_RELEASE, RESTART,
    ROLLBACK) works with compiler-v2;
19. temporary AWS resources are fully cleaned (leak audit passes);
20. no runtime-v1/dual-architecture complexity remains on the production
    path.

Exact v1 template parity and migration support were never required.

## Phase 2 Result

Phase 2 is complete: compiler-v2 is the single provisioning path, the
relay/runtime cutover is done, and DESTROY/PURGE behave correctly. The
remaining Phase 2 work is two real-AWS validations (listed under the exit
bar below), not code.

What landed:

- **Clean boundaries, identity, determinism, safety, preflight.**
  `ApplicationGraph` describes need; capability selection lives in the
  resolver/planner; `DeployzIR` is the authoritative provisioning intent;
  `packages/infrastructure-compiler` is the deterministic CloudFormation
  source (stable `componentId + capability + resourceRole` logical ids,
  golden-pinned; composition, ordering-independence and determinism
  tests; `safety.ts#assertNoDestructiveStatefulChanges` fails closed;
  targeted preflight in `packages/analysis/src/compiler-preflight.ts`).
- **Cutover.** Deployment creation compiles the frozen manifest
  (`manifestToApplicationGraph` → `planApplicationGraphWithSpec` →
  `compileDeployzInfrastructure`), publishes the template to the region's
  public-read template bucket at `compiler-v2/<templateHash>.json`
  (`PutObject` with `IfNoneMatch: '*'`; `412 PreconditionFailed` is dedup
  success — byte-identical by construction), and persists the completed
  `DeploymentSpecV2` in `deployments.spec_v2` with
  `infra_version = 'dynamic-compiler-v2'`. The publish happens before the
  DB insert (fail closed: no compile/publish, no row); outside the deployed
  Lambda the publisher is an injectable no-op behind
  `env.releaseImageRegistryEnabled`.
- **Runtime execution contract.** INSTALL payloads carry `templateUrl`
  (the frozen artifact) plus API-generated parameters: `paramImageReference`
  (digest-pinned newest READY release), `paramDesiredCount` (`'0'` when
  `configPrecedesFirstStart`), `paramAppApiKey` and `paramAppSigningSecret`
  (random 32-byte base64url, `NoEcho`, redacted post-claim via
  `INSTALL_SECRET_PARAMETER_IDS`). The relay manifest-derives
  `paramContainerPort`/`paramHealthCheckPath`, filters undeclared
  parameters against one template fetch, and executes **only**
  `payload.templateUrl` — it fails closed without it; there is no
  env/profile fallback.
- **Spec consumers.** Requirement drift compares the spec's `graphHash`;
  the relay's poll-meta verification booleans (`databaseRequired` /
  `redisRequired`) derive from the spec's verification contract; heartbeat
  inventory classification joins CFN stack resources with the spec's
  ownership records by logicalId (with a `classifyResource` fallback);
  plans and footprint derive through the graph→planner chain (the compiler
  footprint when present; storage is always expected — the compiler always
  emits the bucket and the app-config secret).
- **Runtime-v1 removal.** The four application template constants and
  artifacts, the profile→URL resolution, `InfrastructureProfile`
  (`{ postgres, redis }`), `DOCUMENSO_PARAMETERS`, the CDK application
  stack and Documenso preset, the synth/publish application scripts, the
  lifecycle/sizing parity tests, the bootstrap `ApplicationTemplateUrl`
  param/env, and the shadow runner (`dynamic-infrastructure-shadow.ts`)
  and its wiring are removed. The version canary's app-template
  publish/override step (step 5) is removed; the bootstrap override and
  the rest of the ladder stay.
- **DESTROY/PURGE.** On `DELETE_FAILED`, the relay lists the failed
  resources and re-issues `delete-stack` with `RetainResources`, repeating
  the pass until the stack reaches `DELETE_COMPLETE`; the deployment
  settles `DELETED` (truthful success) while the RDS instance, its
  secrets, the bucket and the pinned network objects survive. PURGE
  deletes the retained data — RDS (protection off, skip-final-snapshot),
  every owned application secret regardless of generation (anything except
  `deployz:component=bootstrap`), buckets, ACM, subnet groups, network
  orphans — and stays retryable via `cleanupState: PURGE_FAILED`. The
  simulated `retained-delete-recovery` scenario proves it; the composite
  canary mirrors the relay's multi-pass retain-retry and asserts a clean
  account.
- **Real-AWS evidence** (api.deployz.dev ran this branch via CI
  `workflow_dispatch`): `profile --profile stateless` PASS all 17 steps
  (install → HEALTHY → HTTPS → bindings → disconnect → retained-verify →
  purge → leak audit); `profile --profile pg` PASS all 17 steps (stateful:
  retention verified between Disconnect and Purge; purge removed the RDS,
  secrets and bucket; leak audit PASS); the direct composite canary
  (`canary-compiler-v2-composite.mjs`) PASS (multi-pass retain-retry →
  `DELETE_COMPLETE` → retention → purge → network island gone).

Pending real-AWS validations (Phase 2 exit bar, not passed):

- **`core` completion**: the day-2 ladder passed 19 of its steps (install,
  v1 serving, HTTPS, bindings, data seeding, deploy v2, data + infra
  survive, rollback v1, second deploy v2) and was interrupted at step 20
  (`v3-bad-health`) by operator credential expiry. The remaining steps
  (`v3` failure isolation through cleanup) must complete.
- **The `resilience` subcommand** and RESTART-through-relay real-AWS
  validation against a compiler-v2-provisioned stack.

# Phase 3 --- Generic UX & Product Integration

## Objective

Make the UX capability-driven end to end. Phase 3 no longer owns a
cutover or runtime-v1 removal --- compiler-v2 is already the single
provisioning path and the dual-generation machinery is gone. Phase 3
turns the generic graph/plan/capability foundation into product:
progress, diagnostics, plans and lifecycle presentation that read the
frozen spec instead of hard-coded topology.

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

-   UI is graph/plan/capability-driven, derived from the frozen spec and
    the compiler's presentation metadata;
-   simple PostgreSQL deployment is no more complicated;
-   the two pending Phase 2 real-AWS validations (`core` completion,
    `resilience` + RESTART-through-relay) have been completed;
-   full real-AWS lifecycle passes from a clean account.

The last two criteria are deferred, not dropped. Product decision:
Phase 3 passes without an AWS run. They join the two pending Phase 2
validations on the **Final AWS Qualification backlog**, to run after
the Phase 3 merge:

-   `core` day-2 ladder completion (interrupted at step 20,
    `v3-bad-health`, by operator credential expiry);
-   `resilience` subcommand + RESTART-through-relay against a
    compiler-v2-provisioned stack;
-   full real-AWS lifecycle from a clean account.

## Phase 3 Result

Phase 3 is complete: the UX reads the frozen spec instead of hard-coded
topology, and every change is additive. Deployments created before
Phase 3 render unchanged through the legacy fallbacks, and no lifecycle
behavior changed — Disconnect/Purge keep their Phase 2 semantics.

What landed:

- **Contracts** (`packages/contracts/src/`): plan component kinds widen
  to `worker`/`queue`/`schedule` (schema-level only — no provisioning
  capability exists behind them yet), plan components carry optional
  `componentId` and `group` (application, data, cache, storage,
  messaging, networking, edge, security), and update plans carry an
  optional `infrastructureChange` (`{ status: 'none' }`, or
  `{ status: 'unsupported', reason: 'topology_changed' }` — it fails
  closed). A pure `derivePlanComponentsFromSpec` and one
  `PLAN_COMPONENT_GROUP_BY_KIND` map own the derivation; status schemas
  declare additive `specComponents`.
- **API.** Deployments with a frozen specV2 serve spec-derived plan
  components (catalog kinds keep their legacy names, actions and
  lifecycles — byte-parity for today's deployments, only additive
  fields). Readiness responses carry an optional `architecture` block
  (groups with per-node detected|confirmed state plus unresolved
  questions; external and non-DEPLOYZ_MANAGED services are excluded).
  Customer and vendor status payloads carry `specComponents`
  (componentId, label, state, detail) derived from stack events through
  the spec's ownership records; unknown logicalIds bucket as `other`
  with a neutral detail, so raw AWS types stay off customer surfaces.
  Diagnostics failure context carries an optional
  `componentId`/`componentLabel`. The release update-plan always
  reports `infrastructureChange` from requirement drift.
- **Vendor UI.** Overview gains a compact "Architecture detected" card:
  components grouped by plan group, each marked Detected
  automatically / Confirmed / Needs input, with the grouped detail
  under a "View architecture" disclosure — an explanation, not an
  editor; hidden when the readiness payload has no architecture block.
  Configuration reorganizes into Environment variables / Application
  architecture / Data & infrastructure / Deployment preferences, with
  focused unresolved-question cards that reuse FixInstructionsDialog
  and EditDialog. Releases gains an Infrastructure line: "No
  infrastructure changes", or the warning "This release requires
  infrastructure changes. Automatic infrastructure upgrades are not
  supported yet."
- **Customer UI.** "What Deployz will create" groups by the eight
  groups (fallback chain component.group → kind map → Application;
  only non-empty groups render) with multi-workload sizing lines.
  Region and cost stay backend-driven, with an explicit "Estimate
  unavailable" state. The retention note derives from the plan's RETAIN
  rows, and the charges warning shows on the install page and the token
  flow.
- **Progress and diagnostics.** The customer Resources summary and the
  vendor progress card list components from `specComponents`, with a
  byte-identical legacy fallback when the payload carries none; raw AWS
  events stay behind the existing progressive disclosure. The vendor
  diagnostic card names the affected component. Phase 4 presentation
  fixtures (web + 2 workers + MySQL + Redis + storage; web + worker +
  queue + scheduled job) already render through the production
  components with no source changes.

Phase 3 passed on the simulated suites (unit, contracts, web, E2E)
alone; the real-AWS validations are on the Final AWS Qualification
backlog (see the Exit Criteria above).

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

## Phase 4 Result (2026-09-28)

Phase 4 delivered three of its four items: multiple workers (4A), RDS
MySQL (4B) and first-class one-shot migration workloads (4C). Private
services did NOT ship. Under the delivered workload model they fall out
naturally (a workload kind plus internal networking), so they are a
Phase 6 recommendation, not implemented code.

Landed:

- **Multi-workload (4A).** `workloads[]` is first-class in the graph,
  the IR and the spec. One build artifact is shared by the web service,
  N workers and the optional migration workload. One ECS service per
  persistent workload, each with a frozen command, its own log group
  and its own security group. Workers are private (no ingress, no ALB,
  no HTTP health check), run one task each, and verify through service
  stability. Declared run processes (Procfile non-web entries, Compose
  application services, npm-script workers) provision. Weak evidence
  sets `worker.needsCommand` — an unresolved needs-input question that
  is never provisioned. No numbered worker fields; the legacy single
  slot stays compatible. The web UI renders generic per-workload
  footprint rows.
- **MySQL (4B).** `aws.rds-mysql` resolves from the
  `relational_database` kind plus `engine: mysql` and shares the
  PostgreSQL network/credential/retention/purge/verification machinery.
  RDS MySQL 8.0 (Deployz-pinned), managed master and URL secrets,
  generic bindings (`DATABASE_URL` with the `mysql://` scheme,
  `MYSQL_URL`, `DB_*`), CA bundle environment shared by all workloads,
  DESTROY retains, PURGE deletes (no final snapshot). PostgreSQL output
  is byte-identical.
- **Migrations (4C).** One `MigrationTaskDefinition` (family
  `DeployzAppMigration`) with the frozen command baked in. The relay
  runs only that named family and rejects any command string. Identity
  = sha256(frozen command + image digest), confirmed by a SUCCEEDED
  `DEPLOY_RELEASE` job row; a retry of a confirmed identity skips the
  run. Ordering: install/database ready → migration exit 0 → services
  roll. Failure → `MIGRATION_FAILED` diagnostics, no service update,
  the deployment returns to `UPDATE_AVAILABLE`. ROLLBACK and RESTART
  never run migrations; every rollback affordance carries the migration
  warning.
- **Composition.** web→MySQL+Redis, email-worker→MySQL+Redis,
  import-worker→MySQL, migration→MySQL across the full chain
  (evidence→graph→resolver→IR→compiler→frozen spec→simulated
  relay→verify→progress/diagnostics→release/restart/rollback→destroy/
  retain/purge), proven in simulated E2E (the `phase4-composition`
  scenario over the `deployz-demo/composed-app` fixture).

Hard Gate B criteria status (the gate verdict itself stays a review
outcome; it is not claimed here):

- MySQL and the workers were added through generalized
  capability/graph/compiler behavior: the resolver maps kind+engine,
  the compiler composes every resource from the IR, and destroy, purge,
  pricing, verification and progress stay shared and generic.
- No numbered worker fields and no per-worker API, relay, UI, pricing,
  progress, destroy or purge switches were added.
- Real-AWS qualification for the Phase 4 shapes is recorded as pending
  (see `docs/testing/aws-e2e.md`); the simulated E2E set is the
  completed evidence.

## AWS Gate C --- Phase 4 real-AWS qualification (2026-09-28)

AWS Gate C is a one-repository, real-AWS qualification of Phase 1--4
behavior. It is not HARD GATE C (the Phase 5 capability-extensibility
review below). Repository: `Synapsr/Hovod@333683e` (v1.0.4), an
independent open-source video platform, used unmodified through an
unmodified fork (`instashop-dev/Hovod`). Environment: production
control plane `api.deployz.dev` at main `34a7db2` (#393) at the start,
`08617f2` (#399) at the end; test account `151955775369`, `us-east-1`;
Stage B harness (`repo-221`, `docs/testing/repository-deployment`).

**Expected topology (repository evidence, derived before analysis).**
One image (s6-overlay `ENTRYPOINT /init`) runs the Fastify API (public,
port 3000, `/health/live`, `/health/ready`, serves the dashboard) and a
BullMQ + ffmpeg worker (private). `HOVOD_ROLE=api|worker|allinone`
(environment only) selects the processes; Compose splits api/worker by
environment, with no `command:`. MySQL (`drizzle-orm` + `mysql2`,
`DATABASE_URL`), Redis (BullMQ only, `REDIS_URL`), S3 with REQUIRED
static keys (no default credential chain). SQL migrations run inside
API startup (advisory lock). Required values: `JWT_SECRET`, `S3_*`.

**Detected (after fixes).** Graph: one public `web` workload (image
default command), `relational_database` engine `mysql` →
`aws.rds-mysql` 8.0, Valkey cache, S3 bucket, ALB. Worker:
`worker.needsCommand` (Needs input, not provisioned). Migration: none
detected (non-blocking `migration_strategy` question). Health
`/health/live`, port 3000. IR/frozen spec: the same one workload and
four resources; 50 ownership records, which match the 50 stack
resources one-to-one.

**Mismatches and dispositions.** The analysis of main `34a7db2` rated
MySQL as PostgreSQL (dialect-neutral `drizzle-orm` counted as a
PostgreSQL driver), blocked the Compose api/worker pair as
`unsupported-multi-service`, and truncated `/health/live` to `/health`.
All three are generic analysis bugs, fixed in #394 (ANALYSIS_VERSION
26). The real-AWS runs found six more Deployz bugs, all fixed with
regression tests:

| PR | Defect | Found at |
| --- | --- | --- |
| #394 | MySQL behind a dialect-neutral ORM rated PostgreSQL; command-less Compose worker blocked; health path truncated | analysis |
| #395 | Preflight database check and missing-migration warning said PostgreSQL for MySQL | analysis re-run |
| #396 | **Relay regression**: CONFIG_UPDATE looked for the runtime-v1 `AppConfigSecret`; compiler-v2 names it `ApplicationConfigSecret`, so no vendor/customer value reached any compiler-v2 task | install attempt 1 (app exited at boot) |
| #397 | Vendor repository picker listed only GitHub's first page (30 repositories) | vendor UI |
| #398 | Plan listed `aws.rds-mysql` as an "Application" component and named it "RDS PostgreSQL database" | customer plan, Stage B inventory |
| #399 | `DATABASE_PORT` bound to 5432 for MySQL | live AWS audit |
| #400 | The API deploy gate skipped compiler-only merges (`packages/infrastructure-compiler` missing from `PATHS`), so #399 passed CI and did not deploy | production verification |

Not fixed, by classification: the worker cannot be provisioned for
this repository (a vendor cannot declare a worker command, and
per-workload environment is not modeled: correctly unsupported,
post-MVP); static S3 keys are customer configuration (a Gate C IAM user
scoped to the run's bucket); public-read playback objects are
correctly unsupported (the bucket blocks public access, so
`S3_PUBLIC_ACL=false`); in-code startup migrations and zod-required
variables are detection gaps (Needs input / optional); the Valkey
cache runs `volatile-lru` while BullMQ asks for `noeviction` (backlog).

**Real-AWS run.** Attempt 1 (`stage-b-repo-221-20260928-133814-2ade`)
provisioned the full stack and found #396; it was torn down through
Disconnect → Purge → leak audit (PASS). Attempt 2
(`stage-b-repo-221-20260928-145615-7f34`, deployment `6eb48c14`,
installation `a05a9295`) ran on the fixed relay:

| Stage | Result | Time |
| --- | --- | --- |
| Analysis → preflight | READY_WITH_WARNINGS, no blockers | 19 s |
| CodeBuild release | READY | 2.5 min |
| Bootstrap + relay enrollment | CREATE_COMPLETE | 7.6 min |
| INSTALL → CONFIG_UPDATE → first start → HEALTHY | all SUCCEEDED; 5 SQL migrations applied to RDS MySQL at startup | 15.4 min |
| Default HTTPS | ACTIVE, valid certificate, HTTP 301 → HTTPS | — |
| DEPLOY_RELEASE v1.0.3 → v1.0.4 | SUCCEEDED | 10 min |
| RESTART | SUCCEEDED, one new task, same revision | 4 min |
| ROLLBACK → v1.0.3 | SUCCEEDED, no migration run | 10 min |
| DESTROY → retained check → PURGE → leak audit | all PASS | 52 min |

AWS state matched the frozen spec: one ECS service in private subnets
(no public IP), RDS MySQL 8.0.46 (private, encrypted, deletion
protection, 7-day backups, ingress only from the web security group),
Valkey (private), S3 (public access blocked, TLS-only policy,
versioned), ALB (the only resource open to 0.0.0.0/0, on 80/443 only),
three secrets, 7-day log retention, `deployz:*` ownership tags, task
role scoped to the one bucket and its secrets.

**Functional acceptance (the application is the oracle).** Through the
live HTTPS endpoint: sign-up (MySQL write) → create asset → presigned
PUT to the Deployz bucket → upload-complete (S3 HeadObject) → process
(BullMQ enqueue on Valkey) → the worker downloaded the source from S3,
transcoded it with ffmpeg and wrote HLS playlists, a segment, an MP4,
a thumbnail and a VTT back to S3 → asset `ready` with a 360p rendition
(16--17 s). Passed after install, after DEPLOY_RELEASE, after RESTART
and after ROLLBACK. A release oracle in the application itself (v1.0.4
accepts re-processing a `ready` asset, v1.0.3 answers 409) proved the
serving release after each operation; data created on v1.0.4 survived
RESTART and ROLLBACK. The worker ran as a second process inside the
web task (Hovod's `allinone` role), not as a separate ECS service.

**Phase 3 UX (production UI, after the fixes).** Vendor: the repository
picker lists all 66 repositories; Architecture detected groups Web
service / MySQL database / Valkey cache / S3 bucket / Application load
balancer, each "Detected automatically", with six Needs-input cards
(migration strategy, worker command, four external-service owners);
Configuration shows four Deployz-managed variables and the planned
infrastructure (MySQL 8.0 kept on uninstall). Customer, before launch:
region, "~$65--95/month" with "Estimate incomplete — some resources
could not be priced" (no MySQL price yet), the grouped "What Deployz
will create" list with "RDS database" under Data, and the retention
note; during and after install: the stage list and Web service / MySQL
database / S3 bucket / Valkey cache / Secure endpoint all complete, the
HTTPS address, and no raw CloudFormation states. Because Hovod's
required variables are declared through a zod schema, the analysis
rates them optional ("Nothing for you to provide"); the vendor has to
know them (a detection gap, COMP-017 family).

**Revalidation of the fixes merged after attempt 2.** A deployment
created on the fixed control plane (and closed before launch, so
nothing was provisioned) compiled a frozen artifact whose web task
binds `DATABASE_PORT=3306` next to `MYSQL_PORT=3306` (#399), and its
plan presents the MySQL instance as a Database in the Data group
(#398).

**Destroy / retain / purge.** DESTROY removed the stack and kept the
RDS MySQL instance (deletion protection on), the bucket (28 objects)
and the two database secrets; the application config secret, ECS,
ALB, Valkey and NAT were removed. PURGE removed the retained set. The
Stage B leak audit and an independent tag/identifier scan of both runs
found no leftovers (INACTIVE ECS clusters and deregistered task
definitions only — the documented exception); both
`d-<deployment>.deployz.dev` records are gone.

**Migrations.** Hovod applies its migrations inside API startup, so
Deployz correctly detects no migration workload: **first-class
migration AWS qualification remains pending.** Startup migrations ran
once per schema change against RDS MySQL ("5 applied", then "schema
up to date" on every later start, including the rollback); nothing was
down-migrated.

**Qualification backlog after Gate C.** Satisfied for this shape:
RESTART through the relay on a compiler-v2 stack, and a full real-AWS
lifecycle from a clean account. Still pending: a separate worker ECS
service (needs a repository that declares a worker command), the
migration workload (success, failure, retry of a confirmed identity),
the combined `phase4-composition` topology, the `core` ladder
completion and the `resilience` subcommand, and a fresh MySQL install
that shows `DATABASE_PORT=3306` in a live task (the compiled artifact
is verified; see `docs/testing/aws-e2e.md`). Capability gaps found, not
fixed: MySQL has no price in the cost estimate; the Valkey eviction
policy is not chosen from the Redis purpose (DEPLOY-037); the cache
security group admits the VPC CIDR rather than the workload security
groups; a vendor cannot declare a worker command, and per-workload
environment is not modeled.

**Verdict: AWS GATE C — PASS** (reviewed against the tech spec, this plan
and the Gate C criteria). Every capability Deployz claims for this
repository — the public web workload, RDS MySQL, Valkey, S3, ALB with
default HTTPS, configuration and generated secrets, DEPLOY_RELEASE,
RESTART, ROLLBACK, DESTROY, PURGE — worked end to end on real AWS,
with the application as the oracle. Each defect found on the way was
fixed generically, with a regression test, and re-checked in
production. The worker and the migration workload are not claimed
for this repository (Needs input / not detected), so Gate C neither
passes nor fails them; they stay on the backlog above.

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

## Phase 5 Result (2026-09-29)

Phase 5 delivered SQS queues, EventBridge Scheduler schedules and
scheduled ECS jobs as relationships in the AWS-independent graph, from
the manifest through the planner, the compiler, the frozen spec and the
relay.

Landed, by the sub-phase labels used in the code comments:

- **5A — Standard queues.** `aws.sqs` resolves from the `queue` graph
  kind with `engine: standard`; FIFO and any other engine resolve
  nothing and fail closed. Defaults: 4-day message retention, 30-second
  visibility timeout; a dead-letter queue (reached by a `dead-letter`
  edge) keeps 14 days of retention. Every queue gets a TLS-deny queue
  policy and SQS-managed encryption; a queue with a `dead-letter` edge
  also gets a redrive policy. Maturity is `PREVIEW`.
- **5B — Relationship edges and edge-specific IAM.** Graph edges are
  now typed by access (`produce`, `consume`, `dead-letter`, `invoke`).
  The planner fails closed on: a redrive edge whose `maxReceiveCount`
  is set anywhere but a queue's own dead-letter edge; more than one DLQ
  per source; a DLQ that itself redrives; a `DEPLOYZ_MANAGED` queue
  missing either a producer or a consumer (unless it is a DLQ target); a
  schedule that does not invoke exactly one job, or a job invoked by
  more than one schedule; a scheduled job with no command. The capability
  registry carries one IAM intent per access role, so permissions are
  edge-derived rather than inherited.
- **5C — EventBridge Scheduler.** Every graph schedule resolves to
  `aws.eventbridge-scheduler`. Cron/rate expressions translate to
  the AWS Scheduler syntax; the schedule targets its job's task family
  without a revision suffix, so it always invokes the latest revision.
  The execution role is confused-deputy guarded and scoped to the one
  family, cluster, job roles and DLQ. Maturity is `PREVIEW`.
- **5D — Scheduled-job workloads.** A scheduled job compiles to a
  one-shot task definition (frozen command, own security group), with
  no ECS service and no verification/readiness check of its own — it is
  never deployment-gating. It is a separate concept from the migration
  workload: a migration is a one-shot pre-deploy step tied to
  `DEPLOY_RELEASE`/`ROLLBACK`; a scheduled job is a recurring,
  independent one-shot task invoked by Scheduler on its own timing. The
  one link to release timing is image registration: the relay registers
  the newest release image into a scheduled job's task family only
  after a `DEPLOY_RELEASE`/`ROLLBACK` rollout has otherwise settled,
  never before, and a registration error keeps the deploy command in
  progress rather than failing it. The same registration call, run
  synchronously right before `RunTask`, also fixed a real Phase 4
  defect: the migration family's latest revision used to keep running
  whatever image the last stack operation had baked in.
- **5E — Composition and hardening.** Web → orders-queue (+ DLQ, redrive
  after 5 receives) → worker → MySQL, and a render.yaml `cleanup` job →
  schedule → scheduled ECS task → MySQL + S3, run across the full chain
  (evidence → graph → resolver → IR → compiler → frozen spec → simulated
  install → generic `queue`/`schedule` verification → progress →
  DEPLOY_RELEASE/RESTART/ROLLBACK with family image registration → a
  failed job leaves health unchanged → DESTROY with a running job task →
  PURGE) in the `phase5-composition` simulated scenario over the
  `deployz-demo/async-app` fixture. Hardening: manifest normalization
  turns id collisions and unknown workload references into questions;
  the infrastructure expectations compare contract-verified kinds
  (queue, schedule) as well as the catalog kinds.
- **Detection.** `async-detection.ts` recognizes SQS usage only behind
  an SDK dependency precondition, attributes producer/consumer
  operations to a workload through bounded (depth-4) import
  reachability, and never trusts a consumer operation attributed to
  `web`. A queue provisions only when both a producer and a consumer
  resolve; ambiguous evidence becomes a question, never a guess. Python
  boto3 usage always becomes a question, never provisioned. SQS is no
  longer rejected outright. Schedules are recognized only from
  `render.yaml` `type: cron` services and Kubernetes `CronJob`
  manifests; in-process cron libraries, CI schedules and bare cron
  strings are ignored; Vercel crons and crontab files always become a
  question. `ANALYSIS_VERSION` is 27.

Hard Gate C criteria status (the gate verdict itself stays a review
outcome; it is not claimed here):

- **Desired pattern followed.** SQS/Scheduler-specific knowledge landed
  only in the capability registry (`aws.sqs`, `aws.eventbridge-scheduler`
  and their edge-specific IAM intents), the resolver
  (`packages/analysis/src/resolver.ts`), the compiler
  (`packages/infrastructure-compiler/src/compile.ts` and
  `schedule-expression.ts`), the detection module
  (`packages/analysis/src/async-detection.ts`), and two presentation
  tables in `packages/contracts` (the capability → plan-kind map in
  `plan-components.ts`, and the inventory classification fallback plus
  `INFRASTRUCTURE_COMPONENT_DISPLAY` in `infrastructure.ts`).
- **No undesired switches.** The relay gained no queue/schedule-specific
  logic. Its three additions are generic mechanisms that any future
  resource-shaped capability can reuse: contract-check verification
  (`resourceChecks` in `packages/relay/src/verify.ts`, a generic
  logical-id/type/status match against whatever checks the spec
  carries), release-image registration into spec-named task families
  (`registerReleaseImageIntoFamily`/`registerScheduledJobFamilies` in
  `packages/relay/src/deploy.ts`, driven only by the frozen infra
  spec), and stopping standalone `group: family:...` tasks before
  destroy (`stopStandaloneTasks` in `packages/relay/src/destroy.ts`).
  No queue/schedule-aware logic was added to destroy purge, pricing,
  UI, deploy progress reporting, diagnostics, or health-check
  switches — the cost estimator has no SQS/Scheduler pricing key, so a
  footprint item for either hits the generic "unavailable" path instead
  of an invented number.
- **Real-AWS qualification: PENDING.** Phase 5 shipped through
  simulated E2E, unit and compiler-fixture tests only; no real-AWS
  canary ran as part of this phase. `aws.sqs` and
  `aws.eventbridge-scheduler` stay at `PREVIEW` maturity until one does
  (see `docs/testing/aws-e2e.md`).

**Verdict:** the capability-locality property this gate exists to check
held for SQS and EventBridge Scheduler — the additions above are
capability, detector/evidence, planner mapping, bindings/IAM, pricing,
verification and presentation, not API/relay/destroy/purge/pricing/UI/
progress/diagnostics/health switches. This is a code-review finding
recorded here for the next reviewer to confirm, not a self-declared
pass; real-AWS qualification remains outstanding and is not represented
as having occurred.

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

For compiler work, natural PR boundaries may include: - compiler
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
