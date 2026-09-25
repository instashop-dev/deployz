# Decision log

Architecture and product decisions whose reasoning is still worth knowing.
Each entry states the decision, why, and what would change it. Completed
implementation plans and one-off reports are not kept; git history has them.
Two decisions with substantial detail have their own files:
[`deploy-gate.md`](deploy-gate.md) and
[`failed-install-recovery.md`](failed-install-recovery.md).

| Date | Decision | Status |
| --- | --- | --- |
| 2026-08-25 | Control-plane deploys run only from CI ([`deploy-gate.md`](deploy-gate.md)) | Active |
| 2026-08-25 | AI explanations are on-demand, cached, single-flight, and never change state | Active |
| 2026-08-26 | Installation is verified from CloudFormation, inside the relay, and fails closed | Active |
| 2026-08-27 | A failed first install is recovered by an explicit vendor retry ([`failed-install-recovery.md`](failed-install-recovery.md)) | Active |
| 2026-08-27 | Database passwords are alphanumeric; secret-backed `DATABASE_URL` | Active |
| 2026-08-30 | Valkey is a single-node replication group with TLS off | Active |
| 2026-09-02 | Background workers are deferred (Option B) | Active |
| 2026-09-02 | Disconnect retains data; no final snapshot (RETAIN, not SNAPSHOT) | Active |
| 2026-09-02 | The stored manifest is the only source of infrastructure intent | Active |
| 2026-09-03 | Default HTTPS uses a Deployz-owned hostname per deployment (Option A) | Active (Route 53 replaced by Cloudflare 2026-09-04) |
| 2026-09-03 | Infrastructure profiles are immutable and frozen per deployment | Active |
| 2026-09-20 | Jev shadow analysis is not adopted | Active |
| 2026-09-22 | Config secrets are KMS-encrypted; Lambdas fail closed without the key | Active |

## AI explanations are on-demand and never change state (2026-08-25)

A deployment diagnosis or a build-failure explanation is generated only when
a user asks, cached on the job or release row, and claimed with a
single-flight `UPDATE … WHERE state IN ('PENDING','FAILED') OR (state =
'GENERATING' AND claimed_at < now() - interval '5 minutes')` so two requests
never pay for two model calls. The pattern works identically on Postgres and
PGlite, which advisory locks do not. AI output is advisory copy; it never
sets deployment state, failure codes or retry eligibility. The gateway is
Cloudflare AI Gateway (`AI_GATEWAY_BASE_URL`, `AI_PROVIDER_API_KEY`, optional
`AI_GATEWAY_TOKEN` only for an authenticated gateway, `AI_MODEL`); with no
configuration the deterministic copy is served instead of an error. See
[`../ai-analysis.md`](../ai-analysis.md).

## Installation is verified from CloudFormation, inside the relay (2026-08-26)

A production install once reported success against an empty account. Since
then the relay's `verifyInstallation` reads the application stack
(exists, complete, carries the installation tag, and contains the components
the deployment's infrastructure profile requires) before an INSTALL, deploy
or rollback result counts, and the heartbeat reports the same checks.
Rejected: sweeping the account for resources (needs IAM the relay must not
have, mostly untaggable); verifying from the control plane (needs
cross-account credentials, which the trust model forbids); a new
`INSTALL_UNVERIFIED` failure code (the failure-code enum is mirrored in the
database and copy map; `STACK_CREATE_FAILED` already means "the stack is not
there"). Later hardening replaced the CloudFormation-only deploy gate with
the runtime promotion gates in
[`../deployment-resilience.md`](../deployment-resilience.md).

## Alphanumeric database passwords, secret-backed `DATABASE_URL` (2026-08-27)

The task's `DATABASE_URL` is assembled through a CloudFormation dynamic
reference to a Secrets Manager secret, and dynamic references are not
percent-encoded. A generated password containing a URL-reserved character
corrupts the URL and the install rolls back minutes in (seen live). The
generated password therefore excludes punctuation entirely. The same work
made the container contract (port, health path, task size, grace period,
secret parameters) overridable per application preset; the Documenso preset
also proved that an application which derives its cookie domain from a
public URL needs a non-empty URL from the first boot, so a domain-less
install falls back to the ALB's own URL.

## Valkey: single-node replication group, TLS off (2026-08-30)

ElastiCache's `CreateCacheCluster` rejects the Valkey engine, so the cache is
a `CfnReplicationGroup` with one node, no Multi-AZ and no automatic
failover. `transitEncryptionEnabled` is set to `false` explicitly because the
default enables TLS and breaks every `redis://` client; a repository that
requires `rediss://`, Redis Cluster or Redis Stack modules is rejected at
analysis instead. The relay's IAM must authorize the replication-group
actions against the default parameter group as well as the tagged resource,
or a denied create leaves an untagged group behind and the stack cannot roll
back.

## Background workers are deferred — Option B (2026-09-02)

A repository that declares a worker process is rated needs-adaptation, and
the worker-command configuration surface is disabled. Real worker support
(Option A) would need a per-application infrastructure model (the shared
published templates cannot bake a per-app worker command) and dual-service
semantics across every relay module that today takes the first
`AWS::ECS::Service`. The CDK construct still contains a worker branch; no
published template enables it. In-process schedulers inside the web
container are allowed.

## Disconnect retains data; no final snapshot (2026-09-02)

The application template sets `DeletionPolicy: Retain` on the RDS instance,
its subnet group, its credential secrets and the S3 bucket. Disconnect
(DESTROY) deletes the running application and network and leaves those
behind, with RDS automated backups continuing; Purge deletes them directly
with `SkipFinalSnapshot: true`. The earlier "final snapshot on delete" claim
was never implemented and was removed rather than built: a snapshot would
add a second retained artefact class to track, purge and bill, without
adding safety over the retained instance itself. The bootstrap stack is
never deleted by the relay (it cannot delete its own role); the customer
deletes it.

## The stored manifest is the only source of infrastructure intent (2026-09-02, reaffirmed 2026-09-17)

The analyzer writes a versioned `DeploymentManifest`; it is frozen on the
deployment at creation, and every consumer (template selection, the INSTALL
payload, relay verification, deployment plans, the resource inventory) reads
it rather than the live `applications` columns. Invalid or missing
requirements fail before provisioning; nothing defaults to PostgreSQL. An
existing deployment's topology never changes: a requirement change is
reported as drift and satisfied by a new deployment.

## Default HTTPS uses a Deployz-owned hostname per deployment (2026-09-03)

ACM certificates are Region- and account-bound and cannot be exported, so a
shared Deployz certificate cannot terminate TLS on a customer's ALB.
Option A: a per-deployment certificate requested in the customer account,
DNS-validated through a record the control plane writes into its own zone,
reusing the existing `CONFIGURE_DOMAIN` / `REMOVE_DOMAIN` relay vocabulary
unchanged. Option B (a CloudFront distribution in the Deployz account) was
rejected because it adds a cross-account resource lifecycle that the
customer-account teardown machinery cannot reach, and a second TLS hop. The
zone moved from Route 53 to Cloudflare the next day because `deployz.dev`
lives on Cloudflare; the trade-off is that default-URL traffic transits the
Cloudflare edge. See [`../networking-and-https.md`](../networking-and-https.md).

## Infrastructure profiles are immutable and frozen per deployment (2026-09-03, registry 2026-09-22)

Sizing lives in an immutable registry (`small-v1` today) and is frozen into
`desired_state.infrastructureProfile` at creation. A new size is a new
registry version plus republished templates; `small-v1` is never edited. A
topology-changing `minimal` profile (no NAT, fewer AZs) needs a new
infrastructure version and a security and cost review, not a registry row.
See [`../infrastructure-profiles.md`](../infrastructure-profiles.md).

## Jev shadow analysis is not adopted (2026-09-20)

A shadow-mode second opinion from the Jev model agreed with the deterministic
analyzer on all 360 labelled decisions across 120 repositories, produced no
discriminative signal, and misclassified every verifiable failure case, most
with high confidence. The code stays behind `JEV_ENABLED` (unset in
production; the deploy workflow never sets the `JEV_*` keys) with zero
runtime effect, and `pnpm jev:eval` remains a one-command re-evaluation if a
future model version warrants it (its evidence lives under
`scripts/jev-eval/runs/`, generated). Nothing routes a production
decision through Jev.

## Config secrets are KMS-encrypted; Lambdas fail closed (2026-09-22)

Vendor and customer secret values and pre-relay pending secrets are
encrypted with a dedicated KMS key (`alias/deployz-config-secrets`,
`RemovalPolicy.RETAIN`) using a fixed encryption-context purpose plus an
allowlisted context, enforced by IAM conditions. Inside Lambda a missing or
malformed key ARN fails initialization instead of falling back to a
reversible stub; outside Lambda the stub exists only for local development.
The worker may only decrypt. Legacy stub rows were migrated once and the
migration module removed; a rollback to pre-migration code would lose access
to stored secrets, so fixes go forward. See
[`../pending-secret-delivery.md`](../pending-secret-delivery.md).

## Raw CloudFormation events reach the customer page only behind a disclosure (2026-09-24)

The customer install page's live-activity feed keeps every customer-visible
field jargon-free (the stage headline, the step labels, the activity
messages, the friendly failure message), and puts the raw CloudFormation
events — including a failed resource's status reason — behind the collapsed
"View raw AWS events" disclosure and the technical-details facts. A
customer who opens the disclosure sees exactly what AWS reported; a
customer who does not never sees the jargon. `apps/api/src/customer-activity.test.ts`
pins both halves, and the E2E failure-path test asserts the raw reason is
hidden on the page, not absent from its payload.
