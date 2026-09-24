# Deployz architecture

The authoritative description of the live Deployz MVP: what runs where, the
flow a deployment follows, how the customer's infrastructure is chosen and
built, and where the trust boundaries sit. Product scope and non-goals are
in [`product/mvp-scope.md`](product/mvp-scope.md); the actor journeys are in
[`product/user-flows.md`](product/user-flows.md). For how the lifecycle stays
recoverable, read [`deployment-resilience.md`](deployment-resilience.md)
before changing deployment, job, relay, worker or watchdog logic. Decision
rationale lives in [`decisions/README.md`](decisions/README.md).

## The two sides

**Control plane (the Deployz AWS account, `us-east-1`)** —
`packages/cdk/src/deployz-stack.ts`:

| Component | Code | Role |
| --- | --- | --- |
| API Lambda (Fastify, Node 22, behind HTTP API Gateway at `api.deployz.dev`) | `apps/api` | Auth (Better Auth), GitHub App, analysis, releases, deployments, invitations, relay channel, billing, Team Admin |
| Worker Lambda (SQS consumer + 15-minute schedule) | `packages/cdk/src/lambda/worker.ts` | Analysis and release-build jobs, CONFIG_UPDATE fan-out, CodeBuild result handling, the reconcile watchdog and the other sweeps |
| RDS PostgreSQL 16 (`db.t4g.micro`, isolated subnets) | `packages/db` (drizzle) | All control-plane state |
| SQS job queue + dead-letter queue | `apps/api/src/queue.ts` | API → worker messages |
| CodeBuild project + ECR repository `deployz-images` | `packages/cdk/src/pipeline/build-pipeline.ts` | Release builds; immutable tags, digest-pinned deploys |
| Source bucket (private, 30-day expiry) | | Repository tarballs staged for CodeBuild |
| Template bucket (public read) + regional `deployz-templates-<region>` buckets | `packages/cdk/scripts/publish-*.mjs` | The customer bootstrap and application templates |
| KMS key `alias/deployz-config-secrets` | | Config-secret and pending-secret encryption |
| Cloudflare zone `deployz.dev` (external) | `apps/api/src/cloudflare-records.ts` | Default-HTTPS DNS records |
| Web app on Lightsail (`app.deployz.dev`) | `apps/web` | Vendor dashboard, public install pages, Team Admin |

Everything in the control plane is deployed by CI only; see
[`operations/control-plane.md`](operations/control-plane.md).

**Customer side (the customer's AWS account and chosen Region)**:

| Stack | Created by | Contents |
| --- | --- | --- |
| Bootstrap ("connector") stack `deployz-bootstrap-…` | The customer's Quick Create | The relay Lambda (Node 22, 5-minute timeout) on a 5-minute EventBridge schedule, its role with a permissions boundary, the CloudFormation execution role, the relay credential in Secrets Manager, an SSM pending-command marker |
| Application stack `deployz-app-<installation-id-prefix>` | The relay, from one of four published templates | VPC, ALB, ECS Fargate service, S3 bucket, optional RDS PostgreSQL, optional Valkey cache, app config secret, roles, log group, alarm |

The relay talks to the control plane **egress-only** and is the only code
that ever touches the customer's AWS account.

## The live flow

1. **Repository** — the vendor installs the Deployz GitHub App and creates an
   application from a repository (`apps/api/src/github.ts`). Webhooks handle
   installation events only; a push never builds anything.
2. **Analysis** — `@deployz/analysis` runs deterministic detectors (runtime,
   Dockerfile, port, bind address, health path, environment-variable model,
   external services, PostgreSQL / storage / Redis requirements, the
   unsupported-architecture rejections). An AI fallback resolves only
   genuinely open questions and can never override a detector. Output: the
   canonical `ApplicationAnalysis`, the readiness report and the versioned
   deployment manifest (`packages/analysis/src/{manifest,readiness-report,application-analysis}.ts`).
   See [`ai-analysis.md`](ai-analysis.md). Detected variable names become a
   vendor setup task ([`environment-variables.md`](environment-variables.md)).
3. **Manifest** — the READY manifest is frozen on each deployment as its
   desired state and is the **only** source of infrastructure intent for
   everything downstream (template selection, the INSTALL payload, relay
   verification, plans, inventory). Gates refuse to move a non-READY
   deployment toward provisioning.
4. **Preflight** — `apps/api/src/preflight.ts` combines the manifest gate
   (unsupported architecture, container setup, port, start command, required
   variables against the saved configuration) with the readiness warnings.
   It runs at deployment creation, at invitation confirm, before an install
   or deploy link launches, and again at relay registration. Warnings never
   block; a missing required value does.
5. **Release** — the vendor picks a commit from the configured branch (or a
   full SHA) and a version. The worker fetches the tarball with a GitHub App
   token, stages it in S3, and starts CodeBuild, which pushes to ECR; the
   `IMAGE_DIGEST` from the build event is pinned on the release, and a deploy
   always targets `repository@sha256:…`. Release states: BUILDING, READY,
   FAILED, plus the derived sticky `UNAVAILABLE` when the image is later
   found missing. For a FAILED build the API serves the last 3000 lines of
   the CodeBuild log, redacted, with an optional on-request AI explanation.
   Deployment creation and install links are refused until a READY release
   exists (`RELEASE_NOT_PUBLISHED`).
6. **Install** — the customer opens the install page, confirms (public link
   or invitation) or opens a vendor-created deployment's link, and runs the
   Quick Create. The relay registers with a single-use enrollment code and
   the credential minted for that link, preflight re-runs, the INSTALL job is
   created, and the relay provisions the application stack in the customer
   account with the newest READY release's image reference. Cross-account
   ECR pull is granted control-plane-side for the customer account id the
   relay reports. When configuration must precede the first start, the
   install creates the service with zero tasks and the post-install
   CONFIG_UPDATE plus auto-deploy start it. INSTALL success auto-deploys the
   newest READY release.
7. **Deploy** — DEPLOY_RELEASE runs the migration command (if any) as a
   one-off ECS task, then updates the service to the pinned digest. Before a
   deploy, rollback or bulk deploy is queued the API asks the registry
   whether the image still exists (`apps/api/src/release-images.ts`); a
   deleted image refuses with `RELEASE_UNAVAILABLE` and never touches the
   running release. Rollback never runs migrations.
8. **Health and promotion** — the relay's heartbeat reports ECS counts,
   rollout state, ALB target health, the HTTP probe, the running digest, the
   component verification and the stack inventory. The control plane
   promotes the release pointer only when every gate passes (rollout
   COMPLETED, full counts, healthy targets, successful probe).
   `GET /api/deployments/:id/infrastructure` compares the components the
   manifest requires against the persisted CloudFormation inventory and
   reports anything missing or unexpected; it never scans AWS itself and
   never repairs anything.
9. **Default HTTPS** — every deployment gets `https://d-<deployment-id>.deployz.dev`
   with no customer DNS work; a custom domain, once ACTIVE, takes precedence
   and the default URL stays as the permanent fallback. See
   [`networking-and-https.md`](networking-and-https.md).
10. **Day 2** — config updates, further deploys, rollback, restart, relay
    re-enrollment, retry of a failed first install and default-HTTPS retry
    run through the same command queue, gated on relay connectivity and
    operation exclusivity.
11. **Disconnect and purge** — DESTROY removes the application stack but
    retains the database, its credential secrets and the bucket (no final
    snapshot is ever taken); PURGE deletes the retained items, the ACM
    certificates and the network orphans; the customer deletes the bootstrap
    stack. Details below.

## Application template selection

The relay resolves one of four published template variants from the frozen
manifest through a deterministic chain:

**`DeploymentManifest` → `InfrastructureProfile` → template URL**

1. **DeploymentManifest** (`database.postgres`, `redis.required`,
   `schemaVersion` = 1) is the single infrastructure source of truth. The
   top-level `databaseRequired` / `redisRequired` wire fields are transitional
   relay-compatibility fields, always derived from the manifest by the
   control plane; the relay reads them only when a resumed install's
   compacted SSM marker has dropped the manifest to fit the 4 KB limit. A
   manifest with an unknown `schemaVersion` fails to parse, so the relay
   fails before provisioning instead of guessing.
2. **InfrastructureProfile** (`packages/contracts`) is `{ postgres, redis }`,
   the graph-shaping requirements only. Port, health path, domain and
   ordinary variables are CloudFormation parameters, not variants.
   `infrastructureProfileForManifest` is the only function that derives it.
3. **`resolveApplicationTemplateUrl`** is pure string derivation: it replaces
   the base template key with the profile's key. All four templates are
   published side by side under the same S3 prefix.

| PostgreSQL | Redis | Template key |
| --- | --- | --- |
| true | false | `application-template-v1.json` |
| true | true | `application-template-redis-v1.json` |
| false | false | `application-template-stateless-v1.json` |
| false | true | `application-template-stateless-redis-v1.json` |

Rules: the manifest is authoritative and an invalid or missing requirement
fails before provisioning; the relay refuses an INSTALL without a manifest;
the heartbeat's expected components come from the stored manifest and are
omitted together when it is missing, so the relay skips verification rather
than assuming a database; there is no runtime CDK synthesis and no
CloudFormation `Conditions` for RDS (the four artifacts are pre-synthesized
and committed under `packages/cdk/artifacts/`); an existing deployment keeps
its original template until its normal destroy/purge lifecycle.

## What the application stack contains

Common to all four variants: a VPC (two public and two private subnets, one
NAT gateway), an ECS cluster and Fargate service (`small-v1`: 0.25 vCPU /
512 MiB, one task, deployment circuit breaker with rollback), a task
definition, an internet-facing ALB with one HTTP listener and a target
group, an unhealthy-target alarm, a log group, the `AppStorage` S3 bucket
(**Retain**), the `AppConfigSecret` (Delete), and the task execution and
task roles. Parameters: desired count, image reference, container port,
health-check path, and the generated application secrets.

| Variant adds | Lifecycle on destroy |
| --- | --- |
| RDS PostgreSQL 16 instance (`db.t4g.micro`, 20→100 GB, 7-day backups, deletion protection), subnet group, `DatabaseSecret` + `DatabaseUrlSecret` | **Retain** |
| ElastiCache Valkey replication group (one `cache.t4g.micro` node, no Multi-AZ, TLS off), cache subnet group and security group | Delete |

Redis details: the app receives `REDIS_URL` (`redis://<endpoint>:6379`),
`REDIS_HOST` and `REDIS_PORT`; other detected alias names are bound after
install by the relay. `REDIS_PASSWORD` is never resolved (no AUTH in the
MVP). The cache security group allows 6379 from the whole VPC CIDR, wider
than the database rule. Detection tiers and the supported/unsupported
matrix are in [`ai-analysis.md`](ai-analysis.md).

Database details: the task's `DATABASE_URL` (`sslmode=require`) is assembled
through a CloudFormation dynamic reference, so the generated password is
alphanumeric only; an init container mounts the RDS CA bundle for clients
that verify the chain. Aliases such as `DB_HOST` / `DB_USER` are bound from
the analysis manifest.

The HTTPS listener and its certificate are **not** in the template; the
relay adds them after install. The CDK construct still contains an ECS
Express-mode branch and a background-worker service; neither is in any
published artifact.

### Infrastructure components and AWS resources

`INFRASTRUCTURE_COMPONENTS` (`packages/contracts/src/components.ts`) is the
shared list of the five components a deployment can have: application,
endpoint, database, cache and storage. Each row names the profile rule that
requires it, its `lifecycle` (`delete` or `retain`) on destroy, the
CloudFormation `primaryResourceType` that proves it exists, and the relay
`checkName` that verifies it. It is the one semantic catalog for relay
verification, lifecycle presentation and deployment plans; CDK owns how each
component is constructed and CloudFormation owns the real lifecycle.

`AWS_RESOURCES` (`packages/contracts/src/aws-resources.ts`) is the
customer-facing resource catalog: every meaningful AWS resource the stack
creates, with a customer name, purpose, display group, the component it
binds to, its CloudFormation type and its lifecycle. It omits objects with
no customer meaning (route tables, listeners).

`packages/cdk/test/lifecycle-parity.test.ts` fails when either catalog
disagrees with the four committed templates (lifecycle, presence, component
binding); `sizing-parity.test.ts` pins the `small-v1` sizes to the same
artifacts.

### Deployment plans

A plan (`packages/contracts/src/plan.ts`) states what INSTALL, UPDATE or
DESTROY does to a deployment's infrastructure. It is derived from the
manifest and the component catalog, never from AWS or an LLM, and is
deterministic. INSTALL: every required component is CREATE. UPDATE: only
the application component is UPDATE; the topology never changes, and a
difference between the deployed and current requirements is reported as
`requirementDrift`, never as a CREATE or DELETE. DESTROY: each component is
DELETE or RETAIN per its lifecycle; it never represents PURGE. Plans carry
the filtered `awsResources`, the resolved footprint and a Region-priced cost
estimate ([`infrastructure-profiles.md`](infrastructure-profiles.md)).
`GET /api/applications/:id/plan`, `GET /api/deployments/:id/plan?action=…`
and `GET /api/public-install/:id/plan?region=…&profile=…` serve the same
derivation, so the vendor page and the customer page can never disagree.

## Regions and sizing

- 17 supported Regions (`SUPPORTED_AWS_REGIONS`, mirrored in the database
  enum). Installable Regions are `DEPLOYABLE_AWS_REGIONS`, for which the
  regional bootstrap artifacts are published; the resolver fails closed.
- The Region is chosen at deployment creation and is immutable
  ([`product/user-flows.md#who-chooses-the-aws-region`](product/user-flows.md#who-chooses-the-aws-region)).
- Sizing is frozen per deployment from the immutable profile registry
  (`small-v1` today) — [`infrastructure-profiles.md`](infrastructure-profiles.md).

## Installation invitations and links

The `public_install_links` table holds two kinds of link: a **reusable
public link** (no token; any customer who opens it can confirm) and a
**targeted invitation** (bound to one customer, secured by a one-time token
presented in the `x-deployz-token` header; only its hash is stored). In both
cases the deployment is created only when the customer confirms
(`POST /api/public-install/:id/confirm`): the server re-validates the link,
the subscription gate, preflight, Region and profile, then creates exactly
one deployment (idempotent per key; a used invitation answers `410`).

Two older entry points still exist: a **vendor-created deployment** with a
vendor-chosen Region and a per-deployment install link (the dashboard's
primary "Create deployment" path today), and the legacy **deploy link**
([`deploy-links.md`](deploy-links.md)). The targeted-invitation path is not
currently completed by the web app; see
[`installation-invitations.md`](installation-invitations.md).

## Secrets and configuration values

- **Vendor values and secrets** (`application_configs`) and **customer values
  typed before the relay connects** (`pending_secrets`) are stored as KMS
  ciphertext (`kms1:` format, key `alias/deployz-config-secrets`, encryption
  context bound to organisation / application / key and, for pending rows,
  customer and deployment). Inside Lambda the cipher fails closed: no key,
  no start, and no plaintext fallback anywhere. Decryption happens in the
  API (the authenticated `GET /api/relay/config` response and the
  materialization of staged rows when a deployment is created) and in the
  worker (vendor build-time values). Full threat model and cipher contract:
  [`pending-secret-delivery.md`](pending-secret-delivery.md).
- **Deployz-generated secrets** are minted by the relay with
  `crypto.randomBytes` inside the customer account and written to the
  application's Secrets Manager secret; the control plane never sees them.
- **Managed bindings** (`DATABASE_*`, Redis, S3, `AWS_REGION`, `PORT`) are
  template parameters and dynamic references in the customer account.
- **Plaintext that still exists in the control plane**, by design and worth
  knowing: a CONFIG_UPDATE for a deployment whose relay is already connected
  carries the values through SQS (server-side encrypted) and the job row
  until the relay claims it, after which the payload is redacted; the relay
  credential sits in the deployment row until the relay first registers;
  vendor build-time secrets are passed to CodeBuild as plaintext environment
  overrides visible to anyone with `codebuild:BatchGetBuilds` in the Deployz
  account.

## Trust and ownership boundaries

| Party | Owns | Holds |
| --- | --- | --- |
| Deployz | The control plane, the ECR repository and build logs, the template buckets, the KMS key, the `deployz.dev` zone | GitHub App key, OAuth and SES keys, the Cloudflare zone-edit token, Paddle and AI keys — all Lambda environment from CI secrets |
| Customer | Both stacks, the retained data, the ACM certificates, the SSM marker, the relay credential, the application secrets, the runtime logs | The relay bearer token; the customer's own AWS credentials, which Deployz never asks for |
| Vendor | Applications, releases, configuration values | A Better Auth session |

- The control plane holds **no** customer AWS credentials and never calls
  into a customer account. It can queue commands from the relay's fixed
  vocabulary (INSTALL, DEPLOY_RELEASE, ROLLBACK, RESTART, CONFIG_UPDATE,
  DESTROY, PURGE, CONFIGURE_DOMAIN, REMOVE_DOMAIN), grant or revoke ECR pull
  for the customer's account id, and write `d-*` records in its own zone. It
  cannot read customer logs, describe customer AWS, or update relay code in
  place: a relay fix reaches a customer only after the bootstrap template is
  republished and the customer's stack is recreated.
- The relay's IAM is a permissions boundary scoped to the
  `deployz:installation` tag, with documented condition-free exceptions for
  actions AWS cannot tag-condition (reads, S3 bucket actions,
  `GetRandomPassword`, log retention, task-definition deregistration,
  ElastiCache replication-group lifecycle, `ecs:RunTask`). The relay has no
  log-reading permissions. Relay-created resources (listener, certificate)
  must carry the installation tag or the relay cannot modify them later.
- Relay authentication: a per-link credential minted by the API (hash
  stored; plaintext until first registration), presented as a bearer token;
  the enrollment code is single-use; a second party registering the same
  installation gets `409`. Tokens do not rotate except through a relay
  reset, which is a new Quick Create.
- Every application stack and its resources are tagged
  `deployz:installation`, `deployz:application`, `deployz:vendor`,
  `deployz:component`; the relay verifies ownership by tag before it deletes
  anything and skips mismatches.
- Team Admin sessions are read-only outside `/api/admin/*`; recovery actions
  are audited ([`admin/team-admin.md`](admin/team-admin.md)).

## Disconnect, purge and retained data

| Operation | What happens | What remains |
| --- | --- | --- |
| **Disconnect** (`POST …/destroy`, job DESTROY) | A never-installed deployment is marked DELETED immediately. Otherwise the relay verifies the stack tag and deletes the stack; CloudFormation's policies decide what stays. On `DELETE_FAILED` the relay clears RDS / cache blockers only for a never-installed deployment; otherwise it finishes with `RetainResources`. Custom-domain and default-HTTPS removal jobs are queued; DNS records are deleted on success; the ECR pull grant is revoked; billing stops. | RDS instance (deletion protection on, automated backups continue), its subnet group, `DatabaseSecret` and `DatabaseUrlSecret`, the S3 bucket, and the network objects the database ENI pins (a private subnet, the DB security group, the VPC). Charges continue. |
| **Force-complete** (`POST …/disconnect/force-complete`) | Control-plane-only settlement for a dead relay: `cleanupState: SKIPPED_RELAY_OFFLINE`, pending secrets and DNS records deleted. Never claims AWS resources were removed. | Everything in the customer account. |
| **Purge** (`POST …/purge`, job PURGE; allowed while `cleanupState ≠ COMPLETE`) | The relay deletes, one kind per poll and only what carries its tags: the application stack (clearing blockers on `DELETE_FAILED`), owned RDS instances (`SkipFinalSnapshot`), caches, buckets (every version), DB credential secrets, ACM certificates, subnet groups, then the VPC network. Failure → `PURGE_FAILED` (retryable); success → `COMPLETE`, ECR grant revoked, DNS orphans reconciled. | The bootstrap stack. |
| **Customer deletes the bootstrap stack** | In the CloudFormation console, after purge. The relay cannot delete its own role. | Nothing. |

The `finalSnapshot` flag that the API and web still send on destroy is
ignored by the relay; no final snapshot is ever taken. `DELETE /api/customers/:id`
refuses a customer that still has any deployment row, including a DELETED
one, so removing a record can never remove infrastructure.

## The MVP support boundary

Deployz supports one opinionated architecture: a single Linux web/API
container on ECS Fargate behind an ALB, S3, and optional RDS PostgreSQL and
ElastiCache Valkey, installed only from fixed published templates. Anything
that does not fit is rejected at analysis time with evidence, never silently
adapted. The full list of non-goals, known limitations and deferred items is
in [`product/mvp-scope.md`](product/mvp-scope.md).

## Where the details live

| Topic | Document |
| --- | --- |
| Lifecycle invariants, states, watchdog, retry | [`deployment-resilience.md`](deployment-resilience.md) |
| Analysis, readiness, preflight, diagnosis | [`ai-analysis.md`](ai-analysis.md) |
| Environment variables | [`environment-variables.md`](environment-variables.md) |
| Secrets and KMS | [`pending-secret-delivery.md`](pending-secret-delivery.md) |
| Networking, DNS, HTTPS, custom domains | [`networking-and-https.md`](networking-and-https.md) |
| Sizing and cost | [`infrastructure-profiles.md`](infrastructure-profiles.md) |
| Invitations and links | [`installation-invitations.md`](installation-invitations.md), [`deploy-links.md`](deploy-links.md) |
| Operating the control plane, publishing templates, Regions | [`operations/control-plane.md`](operations/control-plane.md) |
| Diagnosing failures | [`operations/troubleshooting.md`](operations/troubleshooting.md) |
| Testing | [`testing/README.md`](testing/README.md) |
| Billing | [`billing/paddle-billing.md`](billing/paddle-billing.md) |
| Team Admin | [`admin/team-admin.md`](admin/team-admin.md) |
| UI system | [`ui-system.md`](ui-system.md) |
