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
  pipeline, the public template bucket, and the Route53 DNS zone writer. The
  vendor surfaces (`apps/web`) and Team Admin (`docs/admin/team-admin.md`)
  live on top of it.
- **Customer side** (the customer's AWS account): the bootstrap stack created
  from the customer's Quick Create, containing the relay Lambda on a 5-minute
  EventBridge schedule. The relay talks to the control plane **egress-only**
  and is the only code that ever touches the customer's AWS account.

## The live flow

The flow a deployment follows, end to end:

1. **Repository** — the vendor connects a GitHub repository
   (`apps/api/src/github.ts`).
2. **Analyzer** — `@deployz/analysis` runs deterministic detectors over the
   repository: language/framework, Dockerfile, port, health path, env-var
   model, external services, database/storage/Redis requirements, and the
   unsupported-architecture rejections. Readiness and the manifest are the
   output (`packages/analysis/src/manifest.ts`, `readiness-report.ts`).
3. **Deployment Manifest** — the READY manifest is stored as the deployment's
   desired state. Phase 3 gates refuse to move a non-READY deployment toward
   provisioning.
4. **Readiness** — the readiness verdict (READY / NEEDS_CONFIGURATION /
   NOT_COMPATIBLE) is enforced server-side before an install link can launch
   and before a relay can enroll.
5. **Release Build** — a release is built by CodeBuild into an immutable
   ECR image digest; a deploy always targets `repository@sha256:…`.
6. **Install Infrastructure** — the customer opens the install link and runs
   the Quick Create. The bootstrap stack brings the relay up; the relay claims
   the INSTALL job and provisions the published application template
   (VPC, ALB, ECS/Fargate service, RDS PostgreSQL, and S3 — the template always
   carries them — plus the ElastiCache Valkey cache when the application
   requires Redis) in the customer account. Cross-account ECR pull
   is granted control-plane-side. INSTALL success auto-deploys the newest
   READY release.
7. **Deploy Release** — DEPLOY_RELEASE runs the migration command (if any) as
   a one-off ECS task and then updates the service to the pinned digest.
8. **Migration** — the migration stage runs before the service update,
   only for a DEPLOY_RELEASE with a migration command. Rollback never runs
   migrations.
9. **Runtime Health** — the relay's heartbeat reports ECS counts, rollout
   state, ALB target health, the HTTP probe, and the running digest. The
   control plane promotes the release pointer only when every gate passes
   (rollout COMPLETED, full counts, healthy targets, successful probe).
10. **HTTPS** — every successful deployment gets the Deployz default hostname
    (`<deploymentId>.apps.deployz.dev`) with a customer-account ACM
    certificate DNS-validated through the Deployz Route53 zone — zero customer
    DNS input. A customer custom domain, when added, keeps precedence.
11. **Day-2 Operations** — config updates, further deploys, rollback, restart,
    and relay re-enrollment run through the same command queue, gated on relay
    connectivity and operation exclusivity.
12. **Delete / Purge** — Disconnect (DESTROY) removes the application stack but
    **retains** the database, its credentials, and the stored files (Phase 9
    RETAIN decision — no final snapshot is ever taken). Purge (PURGE) deletes
    the retained database, credentials, stored files, and network orphans; the
    customer deletes the bootstrap stack itself in CloudFormation
    (CANARY-014).

## The MVP support boundary

Deployz supports one opinionated architecture: a single Linux web/API
container on ECS/Fargate with a published application template, RDS
PostgreSQL, S3, and an optional ElastiCache Valkey cache. The relay installs
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
- Failure/recovery invariants: `docs/deployment-resilience.md`
- Test hierarchy and canary escalation: `docs/testing/README.md`,
  `docs/testing/ai-agent-testing-guide.md`
- Redis support details: `docs/redis-mvp-implementation.md`
- Team Admin: `docs/admin/team-admin.md`
