# Deployz MVP — scope, principles and non-goals

The canonical statement of what Deployz is, what the current MVP supports, and
what it deliberately does not do. For how the pieces fit together, see
[`../architecture.md`](../architecture.md). For the step-by-step vendor and
customer journeys, see [`user-flows.md`](user-flows.md).

## What Deployz is

Deployz lets a small B2B software vendor run its web application inside each
customer's own AWS account, without building a private-deployment platform.
The vendor connects a GitHub repository once. Deployz analyzes it, builds
immutable releases, and gives the vendor an install link per customer. The
customer opens the link, reviews what will be created and what it costs, and
approves one CloudFormation Quick Create stack in their own account. From
then on the vendor operates every customer deployment (deploy, roll back,
restart, reconfigure, diagnose, disconnect, purge) from one dashboard.

Deployz is a **software distribution platform for customer-owned AWS
accounts**. It is not a Terraform generator, a Kubernetes platform, a generic
AWS deployment tool, a cloud console, or a DevOps consulting service. The
product is the recurring lifecycle of *vendor × application × version ×
customer × AWS deployment*.

**Target vendor:** a software company of roughly 5–20 people with a working
SaaS product and customers who ask "can this run in our AWS account?".
**End customer:** an organisation that wants data control, AWS billing
ownership and infrastructure visibility, and that will not hand a third party
permanent AWS credentials.

## Product principles

1. **Opinionated beats flexible.** Deployz supports one architecture
   exceptionally well and says "we don't support that" rather than "we can
   probably make that work". Every variation adds failure modes, support load
   and security surface.
2. **Deterministic infrastructure.** Provisioning comes from versioned,
   pre-published templates and known IAM policies. AI helps understand
   applications and explain failures; it never invents production
   infrastructure.
3. **Customer credentials never leave the customer's AWS.** Deployz never
   asks for access keys or administrator credentials. Everything that touches
   the customer's account runs inside it (the relay), egress-only.
4. **Zero professional services.** A deployment that needs custom
   infrastructure work is unsupported, not a support ticket.
5. **Application portability before deployment magic.** Incompatibilities
   are detected early, with evidence and fix instructions, instead of being
   worked around.
6. **Infrastructure complexity stays invisible.** Vendors and customers see
   applications, releases, customers, deployments and health, never raw
   CloudFormation or ECS vocabulary in the primary UI.
7. **Human support minutes per active deployment per month** is the
   operational north star. At the MVP price point, prevention,
   classification and deterministic fixes beat architectural flexibility.

## The supported application architecture

One deployment is one application stack in one AWS Region of the customer's
account:

| Component | What Deployz provisions | Notes |
| --- | --- | --- |
| Compute | One Linux x86-64 container on ECS Fargate behind an Application Load Balancer | Needs a Dockerfile. `small-v1`: 0.25 vCPU / 512 MiB. |
| Database (optional) | RDS PostgreSQL 16, `db.t4g.micro`, 20 GB (autoscaling to 100 GB), 7-day backups, deletion protection | Provisioned only when the analysis manifest requires PostgreSQL. **Retained** on disconnect. |
| Cache (optional) | ElastiCache Valkey (Redis-compatible), single `cache.t4g.micro` node, no TLS, no cluster mode | Provisioned only when the manifest requires Redis. Deleted on disconnect. |
| Storage | One S3 bucket, always created | **Retained** on disconnect. |
| Network | Dedicated VPC, public/private subnets, NAT, security groups | Deleted on disconnect. |
| Endpoint | Permanent `https://d-<deployment-id>.deployz.dev` URL, plus an optional vendor-managed custom domain | See [`../networking-and-https.md`](../networking-and-https.md). |

The four pre-published template variants (PostgreSQL × Redis) are selected
from the deployment manifest; see
[`../architecture.md#application-template-selection`](../architecture.md#application-template-selection).
Sizing is frozen per deployment in an immutable profile registry
([`../infrastructure-profiles.md`](../infrastructure-profiles.md)); today
only `small-v1` exists and the customer is not offered a choice.

Deployz supports **17 AWS Regions** (`SUPPORTED_AWS_REGIONS` in
`packages/contracts/src/index.ts`). Production advertises only the Regions
listed in `DEPLOYABLE_AWS_REGIONS`, for which regional bootstrap artifacts are
published. The Region is chosen when a deployment is created and is immutable
afterwards; see [`user-flows.md#who-chooses-the-aws-region`](user-flows.md#who-chooses-the-aws-region).

## What the MVP does

- **Repository analysis**: deterministic detectors (runtime, Dockerfile, port,
  health path, environment variables, PostgreSQL/Redis/S3 requirements,
  unsupported-architecture rejections) with an AI fallback that only fills
  genuinely open questions. Output: the application manifest, a readiness
  report and, on request, fix instructions for a coding agent
  ([`../ai-analysis.md`](../ai-analysis.md)).
- **Configuration**: container port, health path, migration command and
  requirement overrides; per-variable environment-variable classification
  (managed by Deployz / set by vendor / set by customer / optional) with
  KMS-encrypted vendor and customer values
  ([`../environment-variables.md`](../environment-variables.md)).
- **Releases**: CodeBuild builds a commit from the application's branch into
  an immutable ECR image digest. Failed builds expose redacted log evidence
  and an on-request AI explanation.
- **Test deployment**: one free TEST deployment per application into the
  vendor's own AWS account, using the same install flow customers use.
- **Customer install**: a reusable public install link or a targeted
  invitation, a no-account customer page that shows the plan, the AWS
  resources and a Region-priced monthly cost estimate, one Quick Create
  stack, live install progress, automatic first deploy and a permanent HTTPS
  URL.
- **Day-2 operations**: deploy a release (migration command runs first as a
  one-off task), roll back (never re-runs migrations), restart, update
  configuration, retry a failed install, reset the relay, retry default
  HTTPS.
- **Health and status**: CloudFormation success never means healthy. The
  relay's heartbeat verifies ECS counts, ALB target health, the HTTP probe and
  the running image digest before a release is promoted
  ([`../deployment-resilience.md`](../deployment-resilience.md)).
- **Failure handling**: deterministic failure codes with a recoverability
  class, safe retry eligibility, and AI explanation only for codes the
  classifier cannot resolve.
- **Disconnect and purge**: Disconnect removes the application, network and
  cache but retains the database, its credentials and the bucket; Purge
  deletes the retained items. The customer deletes the connector (bootstrap)
  stack themselves.
- **Billing**: Paddle subscription, $49/month platform fee from the first
  production deployment plus $19/month per live production deployment; the
  evaluation (analysis, configuration, releases, one TEST deployment) is
  free. See [`../billing/paddle-billing.md`](../billing/paddle-billing.md).
- **Team Admin**: an internal support and recovery console with read-only
  "view as vendor" sessions and audited recovery actions
  ([`../admin/team-admin.md`](../admin/team-admin.md)).

## Explicit MVP non-goals

Rejected at analysis time, with evidence, never silently adapted:

- A second process per application: background workers, job runners, and
  platform cron or scheduled tasks. (In-process schedulers inside the web
  container are fine and are not flagged.)
- Databases other than PostgreSQL: MySQL/MariaDB, MongoDB, SQLite,
  Elasticsearch/OpenSearch, ClickHouse, embedded JVM databases.
- Message brokers and event consumers: Kafka, RabbitMQ, SQS consumers.
- Redis Cluster, Redis Stack modules, TLS Redis.
- Multi-container or Compose stacks, Kubernetes, Serverless/SAM, the
  repository's own Terraform/Pulumi/CloudFormation, Azure, GCP.
- Persistent volumes or local disk state, GPUs, Windows, ARM64 or privileged
  containers.

Not provided by the platform:

- Existing customer VPCs or databases, PrivateLink, Direct Connect, VPN,
  private-only applications, custom proxies or DNS architectures, custom IAM,
  accounts whose SCPs block the standard stack.
- Multi-Region or active-active deployments, on-premises, air-gapped
  environments.
- Customer-selectable size profiles, changing the topology of an existing
  deployment (a new requirement means a new deployment), per-customer builds,
  pushing changed vendor defaults to existing deployments.
- Customer-side controls inside Deployz: the customer approves the Quick
  Create and can only uninstall through the AWS console.
- Deployment notifications by email or Slack, vendor-branded install pages,
  customer-owned ECR, backup management, release approval workflows,
  scheduled releases, webhooks.
- Application-level observability. Customer runtime logs stay in the
  customer's account and Deployz never copies them out.

## Known limitations of the current implementation

Deliberate trade-offs that are documented rather than hidden:

- **Rollback never reverses schema migrations.** Vendors must write
  backward-compatible migrations.
- **Default-URL traffic passes through Deployz's Cloudflare edge.** The
  permanent `d-*` hostname is a proxied Cloudflare record; a custom domain
  routes directly to the customer's ALB.
- **Port-mismatch diagnosis is imprecise.** Deployz has no runtime log
  access by design, so a wrong container port surfaces as a health-check
  failure.
- **Retained resources cost money until purged.** After a disconnect the
  database, its credential secrets and the bucket remain in the customer's
  account until the vendor runs Purge or the customer deletes them.
- **A failed first install can leave empty credential secrets** in the
  customer account; they hold no customer data.
- **Per-deployment isolation is expensive.** A dedicated VPC with NAT and a
  dedicated ALB dominates the per-deployment AWS cost (roughly $77–114 per
  month before the application's own usage).
- **The shared control-plane ECR repository** is protected by unguessable
  UUID-namespaced tags, not per-application repositories.

## Deferred (post-MVP) items

Recorded so they are not mistaken for gaps:

- Background worker support (a real second process), cron and scheduled jobs.
- Additional infrastructure size profiles (`minimal`, `large`); each needs a
  new infrastructure version and a security/cost review.
- Removal of the legacy deploy-link flow
  ([`../deploy-links.md`](../deploy-links.md)).
- Customer-provided build-time values, Dockerfile `ARG` detection, format
  validation beyond `_URL`/`_EMAIL`/`_PORT` names.
- Deployment notifications, ECR lifecycle policies, per-application ECR
  repositories, an `ANALYZING` sweeper, a product exit for a DESTROY stuck in
  `DELETE_IN_PROGRESS`, and an `INSTALLING` timeout for an application that
  never becomes healthy.
