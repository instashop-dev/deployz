# Deployz MVP — final architecture

The authoritative description of the live Deployz MVP as built through the
boundary-mvp phases (PRs #72–#125, 2026-09-02/03). This document states what
the product does now and where the MVP boundary sits. For the per-phase
record, tests, and verification evidence, see
`docs/mvp-implementation-status.md`. For how the lifecycle stays recoverable,
see `docs/deployment-resilience.md`. For the launch recommendation, see
`docs/mvp-boundary-implementation-report.md`.

## The two actors

- **Control plane** (vendor AWS account): Fastify API (`apps/api`), the worker
  Lambda with the reconcile watchdog, the SQS job queue, the CodeBuild release
  pipeline, the public template bucket, and the Cloudflare DNS writer for the
  deployz.dev zone (the default-HTTPS records live there; see the runtime flow
  below). The vendor surfaces (`apps/web`) and Team Admin
  (`docs/admin/team-admin.md`) live on top of it.
- **Customer side** (the customer's AWS account): the bootstrap stack created
  from the customer's Quick Create, containing the relay Lambda on a 5-minute
  EventBridge schedule. The relay talks to the control plane **egress-only**
  and is the only code that ever touches the customer's AWS account.

## The live flow

The flow a deployment follows, end to end:

1. **Repository** — the vendor connects a GitHub repository
   (`apps/api/src/github.ts`).
2. **Analyzer** — `@deployz/analysis` runs deterministic detectors over the
   repository: runtime, language/framework, Dockerfile, port, bind address,
   health path, env-var model with classification, external services,
   database/storage/Redis requirements, and the unsupported-architecture
   rejections. An AI fallback resolves only genuinely open questions and
   can never override a detector. The canonical `ApplicationAnalysis`,
   the readiness report and the manifest are the output
   (`packages/analysis/src/manifest.ts`, `readiness-report.ts`,
   `application-analysis.ts`); see `docs/ai-analysis.md`. Detected env-var
   names become a vendor setup task; see `docs/environment-variables.md`.
3. **Deployment Manifest** — the READY manifest is stored as the deployment's
   desired state. Phase 3 gates refuse to move a non-READY deployment toward
   provisioning. HTTPS/the public endpoint is not a manifest field: every
   MVP deployment gets the default HTTPS URL unconditionally (see step 10
   below), so there is nothing for the manifest to express.
4. **Readiness and preflight** — one preflight (`apps/api/src/preflight.ts`:
   the manifest gate against the customer's configuration plus the
   readiness warnings) is enforced server-side at deployment creation,
   before an install link or deploy link can launch, and before a relay can
   enroll. Warnings never block; a missing customer-required value does.
5. **Release Build** — a release is built by CodeBuild into an immutable
   ECR image digest; a deploy always targets `repository@sha256:…`.
    For a FAILED release the API reads that build's CodeBuild log
    (`logs:GetLogEvents` on `/aws/codebuild/<project>` only, the last
    3000 lines at most), redacts it, and serves the evidence to the owning
    organization (`GET /api/applications/:id/releases/:releaseId/build-failure`
    and `/build-log`). These are logs of the vendor's own source build in
    the Deployz account, not customer runtime logs, which stay in the
    customer's account.
    The vendor picks the commit from the application's configured branch
    (`GET /api/applications/:id/commits`, 30 per page, at most 10 pages) or
    enters a SHA that `GET /api/applications/:id/commits/:sha` resolves. The
    release always stores the full commit SHA, never a branch name. A GitHub
    failure does not block a release: a full 40-character SHA is accepted
    without the GitHub check.
 6. **Install Infrastructure** — the customer opens the deployment's install
    link (`/install/:installLinkId`, reached after the invitation confirm
    creates the deployment — see *Installation invitations* below) and runs
    the Quick Create. The bootstrap stack brings the relay up; the relay claims
    the INSTALL job, resolves the correct published application template variant
    from the deployment manifest's infrastructure requirements, and provisions
    it (VPC, ALB, ECS/Fargate service, and S3 — plus RDS PostgreSQL when the
    manifest requires a database, plus the ElastiCache Valkey cache when the
    application requires Redis) in the customer account. Cross-account ECR pull
   is granted control-plane-side. The INSTALL job carries the deployment's
   newest READY release's image reference as the template's image parameter,
   so a fresh install runs the application's own release (the template
   default is the publish-time image). INSTALL success auto-deploys the
   newest READY release.
7. **Deploy Release** — DEPLOY_RELEASE runs the migration command (if any) as
   a one-off ECS task and then updates the service to the pinned digest.
   Before a deploy, rollback or bulk deploy is queued, the API asks the
   control-plane registry whether the release's image still exists
   (`apps/api/src/release-images.ts`); a deleted image refuses the request
   with `RELEASE_UNAVAILABLE`, marks the release `UNAVAILABLE` (sticky) and
   never touches the running release. The release list re-checks READY
   releases at most every ten minutes; there is no background polling.
8. **Migration** — the migration stage runs before the service update,
   only for a DEPLOY_RELEASE with a migration command. Rollback never runs
   migrations.
9. **Runtime Health** — the relay's heartbeat reports ECS counts, rollout
   state, ALB target health, the HTTP probe, and the running digest. The
   control plane promotes the release pointer only when every gate passes
   (rollout COMPLETED, full counts, healthy targets, successful probe).
   `GET /api/deployments/:id/infrastructure` also compares the infrastructure
   components the stored manifest requires (the catalog) against the
   persisted CloudFormation inventory. The API reports any missing or
   unexpected component; it never scans AWS itself and never repairs
   anything.
10. **HTTPS (default URL)** — every deployment gets a permanent Deployz-owned
    URL. The runtime flow: the deployment's ALB exists in the customer account
    after INSTALL; the control plane's default-HTTPS machine reconciles two
    CNAMEs into the deployz.dev Cloudflare zone (an unproxied ACM DNS-01
    validation record and a proxied routing record `d-<deployment-id>.deployz.dev`
    → the ALB), the customer-account ACM certificate is DNS-validated through
    that record, and once the HTTPS probe verifies the endpoint the machine is
    ACTIVE and the deployment is READY behind
    `https://d-<deployment-id>.deployz.dev` — zero customer DNS input. URL
    model: `defaultUrl` is the permanent `d-*` address once the machine starts
    (any status); `resolveAppUrl` surfaces the preferred URL — the custom
    domain only once it is ACTIVE and healthy, otherwise the default URL once
    ACTIVE/CONFIGURING, otherwise the bare ALB endpoint. The infrastructure
    inventory's *Secure endpoint* row reads the same machine (`httpsState`:
    Setting up → Waiting for certificate → Activating HTTPS → Ready /
    Failed) and is Ready only once a custom domain or the default address is
    ACTIVE — never from the load balancer's CloudFormation status alone. See
    `docs/mvp-default-https-status.md` for the full phase record.
11. **Day-2 Operations** — config updates, further deploys, rollback, restart,
    and relay re-enrollment run through the same command queue, gated on relay
    connectivity and operation exclusivity.
12. **Delete / Purge** — Disconnect (DESTROY) removes the application stack but
    **retains** the database, its credentials, and the stored files (Phase 9
    RETAIN decision — no final snapshot is ever taken). Purge (PURGE) deletes
    the retained database, credentials, stored files, and network orphans; the
    customer deletes the bootstrap stack itself in CloudFormation
    (CANARY-014). Default-HTTPS teardown removes both deployz-zone CNAMEs
    (routing + validation) as the deployment is destroyed, and the purge
    backstop reconciles any orphaned records.

## Application template selection

The relay does not install a single fixed template. It resolves one of four
published template variants from the deployment manifest's infrastructure
requirements, through a deterministic chain:

**`DeploymentManifest` → `InfrastructureProfile` → template URL**

1. **DeploymentManifest** (`database.postgres`, `redis.required`) is the
   single infrastructure source of truth. The analyzer writes it; the relay
   reads it. The top-level `databaseRequired`/`redisRequired` wire fields are
   now transitional relay-compatibility fields ONLY: the control plane always
   derives their values from the stored manifest (never the live
   `applications` columns), and the relay reads them only when a RESUMED
   install's compacted pending marker has already dropped the manifest to
   fit SSM's size limit — those flags were themselves derived from the same
   manifest when the marker was written, so this never disagrees with
   template selection. The manifest carries a `schemaVersion` field
   (currently 1). A stored manifest with an unknown `schemaVersion` fails to
   parse, so the relay fails before provisioning instead of guessing at an
   unknown shape.
2. **InfrastructureProfile** (`@deployz/contracts/src/index.ts`) is a shared
   type `{ postgres: boolean, redis: boolean }` that captures only the
   infrastructure graph-shaping requirements. Port, health path, domain, and
   normal env vars are CloudFormation parameters passed into the template,
   not variants. `infrastructureProfileForManifest` is the only function that
   derives this profile from a manifest; every caller (the relay included)
   uses it instead of reading `database.postgres` / `redis.required` again.
3. **`resolveApplicationTemplateUrl`** (pure string derivation, no network)
   computes the exact template URL by replacing the base template's key with
   the profile's deterministic key. All four templates are always published
   side by side under the same S3 key prefix.

**The four published template variants:**

| PostgreSQL | Redis | Template key |
|---|---|---|
| true | false | `application-template-v1.json` |
| true | true | `application-template-redis-v1.json` |
| false | false | `application-template-stateless-v1.json` |
| false | true | `application-template-stateless-redis-v1.json` |

The first two rows keep the original keys so existing deployments continue
to resolve the same objects. The stateless variants (rows 3–4) contain zero
RDS instances, DB credential secrets, or database-env footprint.

**Rules:**
- **Manifest is authoritative.** Invalid or missing manifest requirements
  fail before provisioning (the relay returns an error, never silently
  defaults to PostgreSQL).
- **The relay refuses an INSTALL without a manifest.** A fresh INSTALL
  payload always carries the manifest (the API refuses to mint one
  otherwise); `settleInstall` fails fast, before any AWS call, if neither
  the manifest nor a resumed marker's already-derived flags are present. It
  never falls back to a guessed default.
- **The heartbeat/poll meta comes from the stored manifest.** `GET
  /api/relay/commands`' `deployment` field (which the relay's observe hook
  reads on every poll, outside any command) derives `databaseRequired`/
  `redisRequired` from the deployment's stored manifest. When the manifest
  is missing or invalid, both fields are omitted together — the relay skips
  verification for that poll rather than assuming a database.
- **Only infrastructure graph-shaping requirements are variants.** Port,
  health path, domain, and application env vars are CloudFormation
  parameters, not template variants.
- **No runtime CDK synthesis.** The four templates are pre-synthesized and
  published by the release pipeline. The relay never runs `cdk synth`.
- **No CloudFormation Conditions for RDS.** The conditional resource set is
  materialized at publish time, not evaluated at deploy time.
- **Existing deployments are untouched.** Previously published stacks keep
  their original PostgreSQL template until their normal destroy/purge
  lifecycle.

### Infrastructure components

`INFRASTRUCTURE_COMPONENTS` (`packages/contracts/src/components.ts`) is the
shared list of the five components a deployment can have: application,
endpoint, database, cache, and storage. Each entry names its `kind`, the
`InfrastructureProfile` rule that says when it is required, its `lifecycle`
(`delete` or `retain`) on destroy, the CloudFormation `primaryResourceType`
that proves it exists, and the relay `checkName` that verifies it.
`requiredInfrastructureComponents(profile)` returns the components a given
profile has. This flat table is the MVP's binding registry — one row per
component rather than per-resource binding objects; CDK, not the catalog,
owns how each component is actually constructed.

This one list is the shared semantic catalog for three things: relay
verification (what must exist), lifecycle presentation (what the customer
sees after a destroy), and deployment plans. CDK creates the AWS resources.
CloudFormation, not the catalog, owns their real lifecycle state — the
catalog only describes CDK's removal policy in a form other code can read.

`packages/cdk/test/lifecycle-parity.test.ts` checks that the catalog agrees
with the four committed application templates: each `primaryResourceType`'s
catalog `lifecycle` must match its `DeletionPolicy` in the template, and
each template must contain exactly the components its infrastructure
profile predicts. The test fails when the catalog and the templates
disagree.

`AWS_RESOURCES` (`packages/contracts/src/aws-resources.ts`) is the
customer-facing AWS resource catalog. It lists the meaningful AWS resources
a deployment's application stack creates. Each row has a customer name, a
one-sentence purpose, a display `group`, the `componentKind` it binds to,
its CloudFormation `resourceType`, and its `lifecycle` on destroy.
It leaves out CloudFormation objects with no customer meaning, such as route
tables and listeners. `requiredAwsResources(profile)` returns the rows one
infrastructure profile creates, in catalog order.
`packages/cdk/test/lifecycle-parity.test.ts` also guards this catalog: each
row must appear in the four committed templates exactly where its
`requiredBy` rule predicts, with the same lifecycle and the same
`componentKind` as `classifyResource` reports. The one exception is the
security-groups row: it spans every security group in the stack, which
`classifyResource` binds per component.

### Deployment plans

A deployment plan (`packages/contracts/src/plan.ts`) states what one action
— INSTALL, UPDATE, or DESTROY — does to a deployment's infrastructure. It is
derived data only: built from the deployment manifest and
`INFRASTRUCTURE_COMPONENTS`, never from AWS and never from an LLM. Two calls
with the same input always return the same plan.

- **INSTALL** — every component the manifest's infrastructure profile
  requires is CREATE.
- **UPDATE** — the MVP architecture never changes an existing deployment's
  topology (see "The MVP support boundary" below): the application
  component is UPDATE when a newer release exists, every other component
  stays UNCHANGED, and any difference between the deployed and the
  application's current effective requirements is reported as
  `requirementDrift` — never as a CREATE or DELETE. A vendor who needs the
  new requirement must create a new deployment.
- **DESTROY** — each required component is DELETE (its lifecycle is
  `delete`) or RETAIN (its lifecycle is `retain`), matching the Delete/Purge
  rule above. A plan's DESTROY action is the disconnect step only — it never
  represents PURGE, which stays a separate, later operation.

`GET /api/applications/:id/plan` (an INSTALL plan from the application's
current effective manifest) and `GET /api/deployments/:id/plan?action=…`
(a plan for an existing deployment) serve this to the vendor. The public
install page's "Deployz will create" list is derived from the same INSTALL
plan, so the two can never disagree.

Every plan also carries `awsResources` (`AWS_RESOURCES`, filtered by the
same infrastructure profile as `components`). The vendor application page
and the customer install pages both render their "AWS infrastructure
details" section from this list.

## Installation invitations (MVP Readiness 2)

The customer enters the install flow through an **invitation**, not through
a vendor-created deployment. The `public_install_links` table holds two
kinds of link under one model:

- **Reusable public link** — no token, no customer id; the vendor shares
  the URL and any customer who opens it can confirm and create a
  deployment.
- **Targeted invitation** — bound to one `customer_id`, secured by a
  one-time token the customer presents in the `x-deployz-token` header
  (only its sha256 is stored; it is never in URLs or logs).

In both cases, **the deployment is created only when the customer
confirms** (`POST /api/public-install/:id/confirm`), never when the vendor
creates the invitation. The vendor flow is: create invitation → copy link
(and one-time token for targeted) → customer opens → customer selects
Region → customer reviews the region-specific plan and cost
(`GET /api/public-install/:id/plan?region=…&profile=…`) → customer
confirms → exactly one deployment is created (idempotent per idempotency
key; a used invitation refuses further confirms with `410 USED`).

**Region ownership:** the vendor **recommends** a Region (optional, stored
as `recommended_region`); the customer **selects** the Region at confirm
time. The Region is **immutable at creation**: once the deployment exists,
its `region` column never changes. A customer who needs a different Region
creates a new invitation and a new deployment. `region_selection` records
ownership — `'customer'` for everything new; `'legacy_publisher_fixed'`
marks the legacy `deploy_links` flow, which keeps working unchanged until a
post-MVP removal.

**Profile frozen at creation:** every new deployment freezes its
infrastructure size profile in `desired_state.infrastructureProfile` as
`{ id, version }` (today `small-v1`). The profile is resolved from the
frozen manifest + Region + profile id/version + infra version; it never
changes for the life of the deployment. See
`docs/infrastructure-profiles.md`.

Invitation states: active, expired, revoked, used. The full lifecycle,
token security rules, legacy compatibility, and audit events are in
`docs/installation-invitations.md`.

## Secret delivery (pre-relay staging, DEPLOY-027)

A secret value the customer types **before** the relay has connected is no
longer write-only. The `pending_secrets` table stores KMS-encrypted
ciphertext only (never plaintext); the encryption context binds the row to
`{org, deployment, key}`; the TTL is 24 hours. The delivery sequence:

1. **Stage** — the API encrypts the value and inserts the ciphertext row.
2. **Materialize at deployment creation** — when the invitation confirms
   and the deployment row is created, the pending secrets are associated
   with the new deployment.
3. **Relay-config decrypt** — the relay's authenticated
   `GET /api/relay/config` call decrypts the values and returns them
   alongside the effective config. Decryption happens only inside this
   authenticated response.
4. **Delete on ack** — once the relay acknowledges the CONFIG_UPDATE, the
   rows are deleted. They are also deleted on DESTROY, force-complete,
   purge, and by the watchdog sweep when the TTL expires.

The threat model (defend against: DB attacker, stolen relay token, log
readers, SQS readers; accept: relay-host and vendor-account compromise,
TTL loss), the KMS key selection (`DEPLOYZ_KMS_KEY_ARN`), and the
redaction guarantees are in `docs/pending-secret-delivery.md`.

## The MVP support boundary

Deployz supports one opinionated architecture: a single Linux web/API
container on ECS/Fargate with a published application template, S3, and
optional RDS PostgreSQL and ElastiCache Valkey cache. The relay installs
only from fixed, published templates. Everything that does not fit is
rejected at analysis time with evidence, never silently adapted.

**Explicit deferrals and exclusions (the MVP boundary):**

- **Background worker (Option B, Phase 8)** — a repository that declares a
  worker process is needs-adaptation (NOT_COMPATIBLE); the worker-command
  config surface is disabled. This is an explicit deferral, not a gap.
- **Cron / scheduled jobs** — not supported at MVP.
- **MySQL, MongoDB, and other database provisioning** — PostgreSQL is the only
  provisioned database; anything else is an unsupported-architecture
  rejection.
- **Phase 15 100-repository benchmark** — removed from scope by operator
  decision; it is not part of the MVP gate.
- **Transient live-AWS verification** — no real AWS was touched during this
  implementation effort; every verification was simulated. The transient
  live-AWS lifecycle check is the canary runbook's domain
  (`docs/testing/aws-full-product-canary.md`,
  `docs/testing/version-rollback-canary.md`), to be run before launch.

## Teardown and the customer relationship

The control plane never holds permanent customer AWS credentials. The relay
stack is the customer's to delete; the pages and the runbook say so. The
customer-facing surfaces show product state (installed / healthy / updating /
removed), never raw CloudFormation enums.

## Where the details live

- Per-phase record, tests, live verification: `docs/mvp-implementation-status.md`
- AI analysis, env-var intelligence, preflight, failure diagnosis:
  `docs/ai-analysis.md` (reference) and `docs/ai-mvp-implementation-status.md`
  (per-phase record)
- Failure/recovery invariants: `docs/deployment-resilience.md`
- Test hierarchy and canary escalation: `docs/testing/README.md`,
  `docs/testing/ai-agent-testing-guide.md`
- Redis support details: `docs/redis-mvp-implementation.md`
- Application template selection and variants: this document's
  *Application template selection* section
- The infrastructure component catalog and its lifecycle parity test: this
  document's *Infrastructure components* section
- Team Admin: `docs/admin/team-admin.md`
