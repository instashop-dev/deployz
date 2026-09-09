# Deployz Full Repository Audit — 2026-09-09

Final pre-MVP-launch technical and product audit.
Audited tree: `main` @ `e4de944`. Report-only: no product code was changed by this audit.

---

## 1. Executive Summary

**Overall health: good.** Deployz is a coherent, well-documented MVP with an unusual degree of discipline: the documented invariants in `docs/deployment-resilience.md` are, with few exceptions, faithfully implemented and tested. CI is green on `main` (full unit/integration suite plus the simulated E2E scenario suite, ~7 minutes).

**MVP implementation quality: high.** The core deployment lifecycle — install, verify, health-gated promotion, failed-update semantics, destroy/retain/purge, dead-relay handling — matches the specification closely. The relay trust boundary (egress-only, zero control-plane credentials in customer accounts, tag-conditioned customer IAM) is implemented as documented.

**Launch readiness: GO WITH BLOCKERS.** Three P1 findings must be fixed before launch. None is architectural; each has a small, known fix. No P0 findings survived independent peer review.

| Dimension | Assessment |
|---|---|
| Architecture quality | Strong for MVP. DB-backed command queue + egress-only relay is the right simplification. |
| Deployment reliability | Good in the happy path; three genuine defects in recovery paths (P1 ×1, P2 ×4). |
| Security posture | Solid. Tenant isolation is structural (org-scoped queries), tokens hashed, webhooks verified, secrets redacted. One multi-tenant registry gap (P2) and two trust-model caveats (P2). |
| Testing maturity | High for an MVP: 18 simulated scenarios, real-AWS canaries, static production-safety assertions. Gaps: stateless apps untested, force-complete not E2E-driven. |
| Product/UX readiness | Good. Product vocabulary is clean; raw AWS states are confined to an advanced disclosure. Main risks are silent-failure UX patterns (P2 ×3). |
| Biggest technical risk | The install recovery seam: re-enrollment after a settled INSTALL job wedges the deployment in INSTALLING with no product recovery path (DZ-AUDIT-001). |
| Biggest product risk | Silent states that mislead the vendor: "Update available" that can never deploy (DZ-AUDIT-007), "No deployable releases" during a transient API failure (DZ-AUDIT-019), cost surprises from retained resources (existing docs mitigate). |

**Verdict: GO WITH BLOCKERS** — fix DZ-AUDIT-001/002/003 before first customer install; everything else can be scheduled.

---

## 2. Audit Scope and Methodology

**What was reviewed.** The entire repository at `main` @ `e4de944`: `apps/api`, `apps/web`, `packages/relay`, `packages/cdk`, `packages/analysis`, `packages/contracts`, `packages/db`, `e2e/`, `scripts/`, `.github/workflows/`, and the full `docs/` tree. All specification documents were read first; the implementation was then traced against them, component by component and end-to-end across components.

**How.** Eight parallel specialist workstreams (spec/MVP boundary; architecture + lifecycle; API/backend; relay + worker; AWS infrastructure; frontend/product; security; tests/CI), each producing evidence-cited findings with exact file/line references. The orchestrator then reconciled, deduplicated, and personally re-verified every contested finding; seven proposed findings were refuted and removed or reclassified during reconciliation. Every P1 candidate was independently peer-reviewed by a second reviewer who re-traced each code path before this report was written.

**Executed checks.** `pnpm lint` (9/9 tasks pass). `pnpm vitest run` passes green in CI on `main` (workflow run 34351766793, 2026-09-09). Local Windows runs of the full suite crash with a V8 OOM inside the `scripts/*` harness tests (see DZ-AUDIT-039); this is environment-specific and did not affect the audit's code-level conclusions. No real-AWS operations were performed.

**What could not be verified.**
- Live production configuration: the actual value of `DEPLOYABLE_AWS_REGIONS`, `BOOTSTRAP_REPUBLISH`, and published regional template buckets in the production AWS account and GitHub environment (DZ-AUDIT-005 is conditional on this).
- Live AWS behavior (installs, canaries, regional deploys) — static verification only, per audit rules.
- The SQS queue's effective encryption state (no explicit `encryption` prop in CDK; depends on CDK defaults).
- The web production deployment topology beyond `deploy-web.yml` (Lightsail), and any manual operational runbooks not in the repo.

---

## 3. Authoritative MVP Boundary

Derived from `docs/architecture.md` (live source of truth), `docs/deployment-resilience.md` (invariants), `docs/mvp-implementation-status.md` / `docs/mvp-boundary-implementation-report.md` (implementation record). Older documents (`docs/project-brief.md`, discovery reports) are historical.

**In scope (REQUIRED FOR MVP):**
- AWS only. One opinionated architecture: a single Linux web/API container on ECS/Fargate per deployment.
- Application shapes: full (PostgreSQL RDS), stateless (no DB), each optionally with ElastiCache Valkey (Redis) and S3 storage. Four pre-synthesized template variants.
- Deterministic repo analysis (14 detectors, 19 rejection checks) with AI fallback that never overrides a detector; manifest is the authoritative desired state.
- CodeBuild builds to immutable ECR digests; deploys always target `repository@sha256:…`.
- Customer account: bootstrap stack (relay Lambda, 5-min EventBridge poll) + application stack (VPC, ALB, ECS, S3, optional RDS/ElastiCache). Control plane never holds customer AWS credentials.
- Default HTTPS `https://d-<deployment-id>.deployz.dev` via Cloudflare; custom domains supported, preferred only when ACTIVE + healthy.
- Day-2 operations through one command queue: INSTALL, DEPLOY_RELEASE, ROLLBACK, RESTART, CONFIG_UPDATE, DESTROY, PURGE, domain jobs — with operation exclusivity, idempotency keys, two-clock watchdog, reconcile-before-fail, park-don't-fail on dead relay, force-complete escape hatch.
- Failed update returns the deployment to HEALTHY/UPDATE_AVAILABLE (previous release keeps serving); failed first install marks FAILED; DESTROY retains DB/credentials/files; PURGE removes retained resources.
- Paddle billing ($49 platform + $19 per active production deployment); payment state never touches running infrastructure.

**Out of scope (explicitly):** background worker processes (Option B deferral — a repo declaring a worker is NOT_COMPATIBLE), MySQL/SQLite/Kafka/RabbitMQ, Kubernetes, existing customer VPCs, multi-service Compose, persistent volumes, GPU, Azure/GCP/on-prem.

**Resolved contradictions (historical documents vs live specs):** the project brief's "optional worker" and 9-state model are superseded by the Phase 8 Option-B deferral and the 10-state model; the brief's §30 preflight (AWS quota/API checks) was never built — the implemented preflight is manifest+readiness only; `docs/mvp-implementation-status.md` contains three statements contradicted by code (see DZ-AUDIT-033). None of these affects the live MVP boundary; all are documentation drift.

---

## 4. Repository / System Map

| Plane | Component | Location | Role |
|---|---|---|---|
| Frontend | Next.js vendor dashboard | `apps/web` | Onboarding, applications, readiness, config, deployments, customers, admin console |
| Frontend | Public install/deploy-link pages | `apps/web` (`/install/[id]`, `/deploy/[publicId]`) | Customer-facing install + status |
| API | Fastify on Lambda (HTTP API GW) | `apps/api` (`server.ts`, ~6.7k lines + modules) | All vendor/customer/relay/admin/billing routes; state settlement; status derivation |
| Worker | Lambda, SQS consumer + 15-min watchdog | `packages/cdk/src/lambda/worker.ts`, `worker-handler.ts` | Build recording, analysis, stuck-job sweep, relay liveness, billing sweep |
| Relay | Lambda in customer account, 5-min poll, egress-only | `packages/relay` | Executes INSTALL/DEPLOY/ROLLBACK/RESTART/CONFIG/DESTROY/PURGE/domain via AWS APIs; heartbeat reporting |
| Infra | CDK control-plane stack | `packages/cdk` (`deployz-stack.ts`, `build-pipeline.ts`, `api-lambda.ts`, `worker-lambda.ts`) | VPC, RDS, SQS+DLQ, S3 sources/templates, ECR+CodeBuild, Lambda×2, API GW |
| Infra | Bootstrap stack (customer acct) | `packages/cdk/src/bootstrap/bootstrap-stack.ts` | Relay Lambda + schedule + scoped IAM (permissions boundary) + credential secret |
| Infra | Application templates ×4 | `packages/cdk/src/application/application-stack.ts` | Pre-synthesized CFN: VPC, ALB, ECS, S3, optional RDS/ElastiCache; RETAIN semantics |
| Persistence | Control-plane Postgres (Drizzle) | `packages/db` | Deployments, jobs (the queue), events, configs, billing, 38 migrations |
| Build | CodeBuild → ECR `deployz-images` | `packages/cdk/src/pipeline` | Docker builds from S3 tarballs; immutable tags; EventBridge result recording |
| Jobs | `deployment_jobs` table as queue | `apps/api/src/jobs.ts` | Idempotency keys, atomic relay claim, partial-unique exclusivity index |
| E2E | Simulated AWS + real relay/protocol/API | `e2e/` | 18 scenarios; production-safety static assertions; real-AWS canaries (opt-in) |

Job lifecycle: `REQUESTED/QUEUED → RUNNING → SUCCEEDED/FAILED` (+`WAITING` parked, +legacy `SUCCESS`). Deployment states: `NOT_INSTALLED → (WAITING_FOR_RELAY) → INSTALLING → HEALTHY ⇄ UPDATE_AVAILABLE/UPDATING → FAILED / DELETING → DELETED` + `cleanupState`.

---

## 5. Top Findings

| ID | Severity | Category | Component | Finding | Impact | Confidence |
|---|---|---|---|---|---|---|
| DZ-AUDIT-001 | P1 | RELIABILITY | Relay enrollment / recovery | Re-enrollment after any settled INSTALL job wedges the deployment in INSTALLING forever; the product's own recovery flow triggers it | Standard "first install failed → retry" path permanently wedges; only escape is destroy + full re-onboarding | CONFIRMED (peer-reviewed) |
| DZ-AUDIT-002 | P1 | BUILD | ECR / CodeBuild | Release image tags are raw version strings in one shared immutable repo — cross-application version collisions fail builds deterministically | Any two apps releasing e.g. `1.0.0` → second build always fails; retry can never succeed | CONFIRMED (peer-reviewed) |
| DZ-AUDIT-003 | P1 | RELIABILITY | Relay migrations | Relay Lambda killed mid-poll loses the migration task ARN; automatic re-offer runs the migration a second time | Non-idempotent migrations can execute twice against a customer database | CONFIRMED (peer-reviewed, MED-HIGH) |
| DZ-AUDIT-004 | P2 | SECURITY | ECR pull grants | Shared repo + account-root pull grants let any customer account pull other tenants' images by guessing common version tags | Cross-tenant container image read (no enumeration possible; read-only) | CONFIRMED mechanics |
| DZ-AUDIT-005 | P2 | RELIABILITY | Regions / templates | UI offers regions from `DEPLOYABLE_AWS_REGIONS` but regional template publication is gated OFF; a wide var publishes nothing | Installs outside us-east-1 fail silently in CFN if the var is wider than what was published | CONFIRMED mechanics; prod var unverified |
| DZ-AUDIT-006 | P2 | RELIABILITY | Watchdog | Watchdog job writes are not state-guarded; can overwrite a just-settled SUCCEEDED INSTALL → spurious FAILED | Vendor-visible false failure; manual retry recovers | CONFIRMED mechanics |
| DZ-AUDIT-007 | P2 | STATE | Release lifecycle | Release *creation* flips fleet to UPDATE_AVAILABLE before build outcome; a failed build never reverts it | Permanent "Update available" badge for deployments whose build failed | CONFIRMED |
| DZ-AUDIT-008 | P2 | RELIABILITY | Default HTTPS | ERROR branch resets the configure-cycle budget every heartbeat → unbounded CONFIGURE_DOMAIN churn | Endless job growth + customer-account API hammering when HTTPS can never activate | CONFIRMED |
| DZ-AUDIT-009 | P2 | CLEANUP | PURGE | PURGE payload carries `previousInstallationId` but no relay code reads it → prior-attempt orphans reported COMPLETE | Retained RDS/secrets from a pre-reset attempt keep billing; purge falsely claims complete | CONFIRMED |
| DZ-AUDIT-010 | P2 | CLEANUP | Public retries | Install/deploy-link retry nulls `installationId` without recording it; in-flight stack creation completes orphaned | Whole orphaned stack (VPC/NAT/RDS/ALB) unreachable by destroy or purge | CONFIRMED |
| DZ-AUDIT-011 | P2 | STATE | Failure semantics | Watchdog uses `hasSucceededInstall`; result route uses `hasStartedInstall` — DEPLOY-009 first-start timeout settles as HEALTHY with zero tasks | UI shows a live app that does not exist | CONFIRMED |
| DZ-AUDIT-012 | P2 | SECURITY | Secrets | Config secret values transit SQS in plaintext and can rest in the DLQ 14 days; no explicit SSE config | Secret disclosure to anyone with queue receive rights | HIGH-CONFIDENCE RISK |
| DZ-AUDIT-013 | P2 | SECURITY | Relay enrollment | First registration accepts any bearer token; enrollment code is served on the public install page | A link-holder can race-register a rogue relay and receive the command stream (incl. INSTALL secrets) | HIGH-CONFIDENCE RISK |
| DZ-AUDIT-014 | P2 | RELIABILITY | Control plane RDS | Control-plane database has `deletionProtection: false` | One accidental stack delete = total control-plane data loss (backups only) | CONFIRMED |
| DZ-AUDIT-015 | P2 | CI/CD | Deploy pipeline | Post-deploy health check only verifies HTTP 200 on `/health` | Silent migration failure = "successful" deploy with a dead API (has happened per workflow comment) | CONFIRMED |
| DZ-AUDIT-016 | P2 | CI/CD | CI secrets | Production AWS keys set as workflow-level env in a PR-triggered workflow (deliberate, documented; forks get no secrets) | Insider/accident exfiltration surface; unnecessary privilege in CI | CONFIRMED |
| DZ-AUDIT-017 | P2 | TESTING | E2E scenarios | No test scenario deploys a stateless (no-database) app | A regression in stateless paths would ship undetected | CONFIRMED (absence) |
| DZ-AUDIT-018 | P2 | UX | Disconnect dialog | Retained-resources warning hidden when infrastructure data is loading/errored | Vendor disconnects without seeing "database keeps running" | HIGH-CONFIDENCE RISK |
| DZ-AUDIT-019 | P2 | UX | Deploy dialog | `fetchReleases` failure silently renders "No deployable releases" | Vendor believes releases are gone during transient API errors | CONFIRMED |
| DZ-AUDIT-020 | P2 | UX | Homepage | Homepage polling has no staleness handling (unlike the shared hook) | Fleet data silently stale during API outages | CONFIRMED |

Full list: 39 findings — P0 ×0, P1 ×3, P2 ×17, P3 ×19 (§6).

---

## 6. Complete Findings

Confidence legend: CONFIRMED = full code path traced; HIGH-CONFIDENCE RISK = mechanism traced, trigger/production state unverified.

### DZ-AUDIT-001 — Re-enrollment after a settled INSTALL wedges the deployment in INSTALLING forever
**Severity** P1 · **Category** RELIABILITY · **Confidence** CONFIRMED (independent peer review, all six links re-verified) · **MVP relevance** breaks the documented first-install recovery flow.

**Expected.** `docs/deployment-resilience.md`: recovery paths (retry-install, "Reconnect relay", customer retry) must let a failed first install converge. Any transition into INSTALLING must have a job that a relay can claim or a watchdog that can act.
**Actual.** Registration mints the INSTALL job under the fixed key `` `${deployment.id}:INSTALL` `` (`apps/api/src/server.ts:5765-5776`). `createOrReuseJob` replays the existing row regardless of state, never reopening FAILED/CANCELLED (`apps/api/src/jobs.ts:55,68-82`). The deployment is still flipped to INSTALLING (`server.ts:5793-5795`), but the claim endpoint only serves REQUESTED/QUEUED/WAITING (`server.ts:5880`) — a settled job is never re-executed. Every reset/retry path produces a settled INSTALL row and returns the deployment to NOT_INSTALLED: relay/reset (`server.ts:4623-4634,4658`), install-link retry (`:2259-2268,2272`), deploy-link retry (`:3379-3388,3392`); a plain first-install failure leaves FAILED. `retry-install` then refuses with `INSTALL_NOT_RETRYABLE` because state is not FAILED and nothing is in flight (`server.ts:4760-4767`). The watchdog scans only active jobs (`packages/cdk/src/lambda/worker.ts:625-631`); heartbeats cannot heal (`stateRecovered` needs FAILED + `currentReleaseId`, `installVerifiedHealthy` needs a succeeded install — both false here, `server.ts:6493-6516`). The codebase already built the cure — `retryAwareIdempotencyKey` (`server.ts:753-797`, its comment describes this exact trap "observed live") — and uses it in retry-install and destroy, but not in register.
**Evidence.** As cited above; no test covers re-register-after-settled-INSTALL (`server.test.ts:3438` is fresh-only; `e2e/scenario-sweep.spec.ts:285-325` resets only a HEALTHY deployment).
**Impact.** The standard recovery for a failed first install (the single most likely early-customer failure mode) permanently wedges the deployment; the vendor must destroy the deployment and re-onboard the customer.
**Failure scenario.** Install fails (stack rollback) → vendor follows product guidance: relay/reset → customer re-runs Quick Create → new relay registers → register replays the FAILED INSTALL row → deployment sits INSTALLING forever.
**Recommended resolution (high level).** Use `retryAwareIdempotencyKey` (or reopen/re-mint the INSTALL job) at registration when a previous INSTALL has settled; add the missing regression test.

### DZ-AUDIT-002 — Cross-application image-tag collisions fail builds deterministically
**Severity** P1 · **Category** BUILD/RELIABILITY · **Confidence** CONFIRMED (peer-reviewed) · **MVP relevance** the build pipeline is core.

**Expected.** Multiple applications (multiple vendors) share one control plane; release builds must be independent.
**Actual.** One shared ECR repository with `TagMutability.IMMUTABLE` (`packages/cdk/src/pipeline/build-pipeline.ts:60-64`); `IMAGE_TAG=${RELEASE_VERSION:-$CODEBUILD_TAG}` is the raw version string (`build-pipeline.ts:116`) supplied from `release.version` (`packages/cdk/src/lambda/worker.ts:254`); version uniqueness is enforced only per application (`apps/api/src/server.ts:3687-3691`). The version-tag push hard-fails (`build-pipeline.ts:151`); only the GIT_SHA tag tolerates collision (`:158`).
**Impact.** The second application (any vendor) to release `1.0.0` — near-certain in a multi-tenant product — fails at `docker push` with `ImageTagAlreadyExists`; the release is FAILED and every retry deterministically fails.
**Failure scenario.** Vendor A ships app `1.0.0`; vendor B creates app release `1.0.0` → build fails → B cannot deploy that version until they bump the string, with a confusing docker error.
**Recommended resolution.** Namespace the tag (application id / slug + version); deploys already use the digest (`packages/contracts/src/index.ts:1219-1222`), so the change is contained to build/push and registry display.

### DZ-AUDIT-003 — Relay Lambda killed mid-poll can run a migration twice
**Severity** P1 · **Category** RELIABILITY/DATA · **Confidence** CONFIRMED (peer-reviewed; occurrence MED-HIGH) · **MVP relevance** customer data integrity.

**Expected.** `docs/deployment-resilience.md:125-128`: every relay executor reads before it writes and converges instead of duplicating a mutation. The code's own comments: a migration "is resumed by ARN on a later poll, **never re-run**" (`packages/relay/src/deploy.ts:471-472`).
**Actual.** `RunTask` starts the migration (`deploy.ts:545-564`); the in-invocation poll runs up to 240 s (`:573-614`); the pending marker carrying `migration.taskArn` is written only after `settleEcsDeploy` returns (`:871-887`). The relay Lambda times out at 5 minutes (`packages/cdk/src/bootstrap/bootstrap-stack.ts:1369`) and the same invocation already spent ~40-60 s on registration/describe work. A kill inside that window writes no marker; the watchdog re-offers after the runtime bound (`worker.ts:655-664`); the fresh attempt finds no marker (`deploy.ts:825-826`) and starts a second migration. The already-running short-circuit cannot help: it requires the completed rollout (`:334-336`), and the migration runs before `updateService` (`:367-368`).
**Impact.** Non-idempotent migrations (seed inserts, destructive ALTERs) execute twice against the customer's production database.
**Failure scenario.** A ~4-minute migration + AWS throttling pushes the invocation past 5:00 → marker lost → automatic re-offer → migration re-runs.
**Recommended resolution.** Write the pending marker (or the task ARN) immediately after `RunTask` returns, before polling; keep the rest of the resume machinery unchanged.

### DZ-AUDIT-004 — Shared ECR repository lets customer accounts pull other tenants' images by tag guess
**Severity** P2 · **Category** SECURITY · **Confidence** CONFIRMED mechanics / MEDIUM class · **MVP relevance** multi-tenant isolation at a trust boundary.

**Expected.** A customer account should be able to pull only the images of its own deployment's application.
**Actual.** `ECR_PULL_ACTIONS` is exactly `BatchGetImage`, `GetDownloadUrlForLayer`, `BatchCheckLayerAvailability` (`apps/api/src/ecr-grants.ts:35-39`) granted to `arn:aws:iam::<account>:root` with no Condition, on the single shared `deployz-images` repository (`:146-151`). No enumerate/list actions are granted, so bulk discovery is impossible — but `BatchGetImage` accepts an `imageTag`, tags are raw version strings (DZ-AUDIT-002), and every customer knows the registry URI from its own task definitions. `GetAuthorizationToken` is self-grantable by the customer's own admin identity.
**Impact.** Read-only cross-tenant image access gated on guessing a common version string (`docker pull …/deployz-images:1.0.0`). Contains other vendors' compiled code and any image-baked secrets.
**Recommended resolution.** Per-application repositories, or namespaced tags (same fix as DZ-AUDIT-002) once tags are not guessable. Also correct the false "verified via STS getCallerIdentity" comment (`ecr-grants.ts:15-16` — no STS call exists; the account id is self-reported, `server.ts:5789`).

### DZ-AUDIT-005 — Offered regions vs published regional templates (configuration trap)
**Severity** P2 · **Category** RELIABILITY/PRODUCT · **Confidence** CONFIRMED mechanics; production variable value UNVERIFIED · **MVP relevance** every non-us-east-1 install.

**Expected.** Every region offered by `POST /api/deployments` must have a published bootstrap template.
**Actual.** `/api/regions` returns `SUPPORTED_AWS_REGIONS (17) ∩ env.DEPLOYABLE_AWS_REGIONS` (`apps/api/src/server.ts:3520-3522`; default `['us-east-1']`, `apps/api/src/env.ts:219`). The only production publisher is gated: `if: vars.BOOTSTRAP_REPUBLISH == 'on'` — commented "Gated, and OFF" (`.github/workflows/deploy-api.yml:234-251`). Template resolution trusts the env list as publication confirmation (`packages/contracts/src/index.ts:1243-1248`). If the production variable is wider than what was ever published, Quick Create in that region fails with an S3 404/`PermanentRedirect` and the deployment sits silently in WAITING_FOR_RELAY — no control-plane-side failure signal.
**Impact.** Conditional: every install outside us-east-1 dead-on-arrival, with a silent customer-facing symptom. If the var is unset/narrow, behavior is consistent.
**Recommended resolution.** Verify/set the production variable; add a startup or CI assertion that every advertised region resolves to a published template (the local test `env.test.ts:523-529` already asserts the wiring — extend it to live verification); surface a control-plane event when a bootstrap template fetch fails.

### DZ-AUDIT-006 — Watchdog job writes are not state-guarded (can clobber a settled result)
**Severity** P2 · **Category** RELIABILITY · **Confidence** CONFIRMED mechanics · **MVP relevance** spurious failures in the core loop.

**Actual.** `sweepStuckJobs` reads a snapshot of the active set (`packages/cdk/src/lambda/worker.ts:625-631`) then updates rows by id with no `state IN (active)` predicate — requeue `:656-664`, `failStuckJob` `:789-805` — racing the result route's settlement (`apps/api/src/server.ts:5961-5967`, whose own guard protects only the route). A result POST landing inside the window can be overwritten: a SUCCEEDED INSTALL can be flipped to FAILED and the deployment marked FAILED. Recovery exists (retry-install passes once the job is FAILED; the rerun describe-first installer re-succeeds; day-2 rows self-heal via `stateRecovered`), so the damage is a spurious vendor-visible failure plus corrupted job history.
**Recommended resolution.** Add the state predicate to both watchdog writes (the claim route already demonstrates the pattern, `server.ts:5877-5882`).

### DZ-AUDIT-007 — Release creation flips the fleet to UPDATE_AVAILABLE before the build outcome; failure never reverts
**Severity** P2 · **Category** STATE/SPEC MISMATCH · **Confidence** CONFIRMED.
**Actual.** `UPDATE_AVAILABLE` is written at release-row creation while `releaseStatus` is still BUILDING (`apps/api/src/server.ts:3746-3758`), contradicting "a newer READY release exists" (`docs/deployment-resilience.md:23-24`). No writer returns the deployment to HEALTHY when `buildRelease` fails (`worker.ts:299-337` touches only `releases`). Symmetric drift: deploying an older release sets HEALTHY without checking `newerReadyReleaseExists` (`server.ts:6044`).
**Impact.** Every live deployment of an application whose release build failed shows a permanent "Update available" badge and deploy CTA for a release that can never deploy — until some unrelated future deploy succeeds.
**Recommended resolution.** Derive UPDATE_AVAILABLE at read time from READY-release existence, or move the write to build success and revert on build failure.

### DZ-AUDIT-008 — Default-HTTPS ERROR branch defeats its own retry budget
**Severity** P2 · **Category** RELIABILITY · **Confidence** CONFIRMED.
**Actual.** At `configureAttempts >= 5` the machine enters ERROR (`apps/api/src/default-https.ts:584-594`); the next heartbeat-driven pass resets `configureAttempts: 0` and starts a fresh cycle (`:680-695`), driven every ~5 minutes from `server.ts:6643-6649`. The custom-domain machine has the same unbounded pattern (`apps/api/src/domains.ts:531-540`).
**Impact.** A deployment whose HTTPS can never activate (e.g. customer SCP denies `acm:RequestCertificate`) generates ~5 CONFIGURE_DOMAIN jobs per cycle forever — unbounded `deployment_jobs` growth and repeated customer-account API calls, with no terminal "gave up" state.
**Recommended resolution.** Make ERROR terminal (or escalating backoff with a hard cap and a vendor-visible state).

### DZ-AUDIT-009 — PURGE cannot see resources from a previous installation attempt
**Severity** P2 · **Category** CLEANUP/SPEC MISMATCH · **Confidence** CONFIRMED.
**Actual.** The PURGE payload carries `previousInstallationId`/`previousBootstrapStackName` with the comment "so the purge can find and account for that stack's retained resources" (`apps/api/src/server.ts:4513-4524`), but no relay code reads them (repo-wide: writers only). `settlePurge` sweeps exclusively by the current installation tag (`packages/relay/src/purge.ts:207,262-514,694-700`), then reports COMPLETE (`server.ts:6135-6140`).
**Impact.** After a relay reset, attempt-1 resources (RETAIN'd RDS with deletion protection, secrets, S3) are invisible to purge; PURGE asserts COMPLETE while orphans keep billing with no product path to remove them.
**Recommended resolution.** Sweep both current and previous installation tags in the purge passes, or reject purge with an explicit "orphaned attempt" state until supported.

### DZ-AUDIT-010 — Public retry routes orphan an in-flight application stack
**Severity** P2 · **Category** CLEANUP · **Confidence** CONFIRMED.
**Actual.** Install-link retry and deploy-link retry null `installationId`/`relayTokenHash` without recording `previousInstallationId` (`apps/api/src/server.ts:2269-2283`, `:3389-3403`; the vendor reset route does record it, `:4642-4650`). The in-flight INSTALL executor's `CreateStack` continues AWS-side; the stack carries the now-forgotten installation tag (`packages/relay/src/install.ts:268`), and destroy refuses stacks whose tag mismatches (`packages/relay/src/destroy.ts:98`).
**Impact.** A customer clicking "Retry" during PROVISIONING can leave a fully running, billing, unreachable stack that neither destroy (tag refusal) nor purge (DZ-AUDIT-009) can ever reach.
**Recommended resolution.** Record `previousInstallationId` in the public retry paths (mirror the vendor route) and include it in purge sweeps (with DZ-AUDIT-009).

### DZ-AUDIT-011 — Watchdog and result route disagree on "running workload" for DEPLOY-009 first starts
**Severity** P2 · **Category** STATE/SPEC MISMATCH · **Confidence** CONFIRMED.
**Actual.** Result route uses `hasStartedInstall` (`apps/api/src/server.ts:1033-1048,6037`); the watchdog's duplicated predicate `hasSucceededInstall` counts a configured-but-zero-task install as running (`worker.ts:742-753,779-781`). Spec (`docs/deployment-resilience.md:70-81`) requires `hasStartedInstall`.
**Impact.** A DEPLOY-009 install whose first deploy times out via the watchdog settles the deployment HEALTHY with zero running tasks — the UI claims a live app that does not exist.
**Recommended resolution.** Export one shared predicate and use it in both paths (the copy already diverged).

### DZ-AUDIT-012 — Plaintext config secrets transit SQS and can rest in the DLQ for 14 days
**Severity** P2 · **Category** SECURITY · **Confidence** HIGH-CONFIDENCE RISK (path CONFIRMED; queue encryption state unverified).
**Actual.** CONFIG_UPDATE queue messages carry `secrets: {key, value}[]` (`apps/api/src/queue.ts:30-39`; `config.ts:413-422`). Queues are declared without an explicit `encryption` prop (`packages/cdk/src/deployz-stack.ts:105-114`); the DLQ retains 14 days. Nothing scrubs the DLQ.
**Impact.** Anyone with `sqs:ReceiveMessage` on the queue/DLQ reads vendor-entered customer secrets — beyond the "never stored" contract (control-plane DB stores masks only, verified correct).
**Recommended resolution.** Set SSE-SQS (or KMS) explicitly on both queues; prefer short DLQ retention for secret-bearing message types or strip secrets from DLQ-destined messages.

### DZ-AUDIT-013 — First relay registration accepts any bearer token; the enrollment code is public
**Severity** P2 · **Category** SECURITY · **Confidence** HIGH-CONFIDENCE RISK · **MVP relevance** documented trust model leans on install-link secrecy.
**Actual.** On first registration the server hashes and stores whatever bearer token the caller presents (`apps/api/src/server.ts:5683,5783`) — the token is bootstrap-generated (`generateSecretString`, `bootstrap-stack.ts:689-700`) but is not verified against any server-side expectation. The enrollment code — the only deployment identifier required — is returned by the public install page (`server.ts:2041`, by design: it is the Quick Create parameter).
**Impact.** Anyone who obtains the install-link URL can race the legitimate relay's first poll, bind their own token, and receive the deployment's command stream (INSTALL payloads include secret parameter values) and deny the real install (409). The link is already the de-facto credential (email distribution), which bounds the practical risk; takeover after binding is properly refused (`server.ts:5685-5713`).
**Recommended resolution.** Carry the bootstrap-generated token (or a hash of it) into the deployment record at Quick Create so first registration verifies instead of adopting; or treat the enrollment code as secret and stop serving it pre-launch.

### DZ-AUDIT-014 — Control-plane database lacks deletion protection
**Severity** P2 · **Category** RELIABILITY · **Confidence** CONFIRMED.
**Actual.** `deletionProtection: false` on the control-plane RDS (`packages/cdk/src/deployz-stack.ts:99`) — inconsistent with application RDS, which sets `true`.
**Impact.** An accidental control-plane stack/CFN delete destroys all vendor/customer/deploys/billing metadata; recovery is restore-from-backup, manually.
**Recommended resolution.** Enable deletion protection; add a final-snapshot policy.

### DZ-AUDIT-015 — Post-deploy health check cannot detect a dead API
**Severity** P2 · **Category** CI/CD · **Confidence** CONFIRMED.
**Actual.** The API deploy verifies only HTTP 200 on `/health` (20 × 15 s poll, `.github/workflows/deploy-api.yml:211-225`); the workflow's own comment records the past incident this caused ("a migration that cannot apply does exactly that"; "the API sat two releases behind without anyone noticing", `:208-209`).
**Recommended resolution.** Probe an authenticated, DB-touching route (e.g. `GET /api/health` readiness with a migration-version assertion) before declaring success.

### DZ-AUDIT-016 — Production AWS credentials injected as workflow-level env in a PR-triggered workflow
**Severity** P2 · **Category** CI/CD · **Confidence** CONFIRMED (deliberate and commented, `.github/workflows/ci.yml:42-46,103-106`).
**Impact.** Fork PRs receive no secrets (GitHub default), but any same-repo branch CI run carries the keys in the environment of every step, including test code; a malicious or careless PR can print them. Least-privilege scoped keys (or scrubbing outside the single step that needs the live proof) would remove the surface.
**Recommended resolution.** Scope to the one e2e-mode-guard step, or use a dedicated zero-privilege key pair for the scrub proof.

### DZ-AUDIT-017 — Stateless (no-database) applications are never exercised by tests
**Severity** P2 · **Category** TESTING · **Confidence** CONFIRMED (absence verified across `e2e/`).
**Actual.** Every scenario manifest/stack includes RDS (`e2e/simulation/fixtures.ts:129`; all scenario templates provision `AWS::RDS::DBInstance`); no `postgres:false`/stateless deployment exists in any test despite the shipped stateless template variant.
**Impact.** Status derivation, provisioning ladder, and inventory code paths specific to database-less deployments (e.g. missing `database` category) are unexercised; a regression ships silently.
**Recommended resolution.** Add one stateless happy-path scenario to the simulated suite.

### DZ-AUDIT-018 — Disconnect dialog can hide the retained-resources warning
**Severity** P2 · **Category** UX · **Confidence** HIGH-CONFIDENCE RISK.
**Actual.** The disconnect dialog builds its "removed" vs "retained" lists from the infrastructure endpoint's data; while that request is loading or has errored, both lists are empty and no "database keeps running" warning is shown (`apps/web/src/app/dashboard/deployments/[id]/page.tsx:1402-1407`).
**Impact.** A vendor can confirm a disconnect without ever seeing the cost-bearing retention warning — a classic surprise-bill support ticket. The DELETED-state page does warn afterwards.
**Recommended resolution.** Block confirmation (or force the warning) until infrastructure data is resolved, or render a static fallback warning.

### DZ-AUDIT-019 — Release-list failure silently renders "No deployable releases"
**Severity** P2 · **Category** UX · **Confidence** CONFIRMED.
**Actual.** `fetchReleases(...).catch((): Release[] => [])` on the deployment detail page (`page.tsx:194-198`); the deploy dialog then shows the no-releases copy (`:849`).
**Impact.** A transient API error makes a vendor believe no releases exist; only a page refresh recovers.
**Recommended resolution.** Distinguish "load failed" from "empty" and offer retry, matching the pattern already used for events.

### DZ-AUDIT-020 — Homepage polling lacks staleness handling
**Severity** P2 · **Category** UX · **Confidence** CONFIRMED.
**Actual.** The dashboard home uses a hand-rolled 5 s `setInterval` with silent catch (`apps/web/src/app/dashboard/page.tsx:68-91`) instead of the shared `useStatusPoll` hook (which has backoff + `stale` signaling, `apps/web/src/lib/use-status-poll.ts`).
**Impact.** During an API outage the fleet view silently freezes on stale data with no "updates unavailable" indicator.
**Recommended resolution.** Reuse `useStatusPoll`.

### P3 findings (summary form)

| ID | Finding | Evidence |
|---|---|---|
| DZ-AUDIT-021 | ECR repository-policy grant/revoke is an unguarded read-modify-write; `policyRevision` optimistic-lock field declared but never used; concurrent installs can lose a grant (self-heals on retry) | `apps/api/src/ecr-grants.ts:49,186-287` |
| DZ-AUDIT-022 | NAT Gateway (~$32/mo) + dedicated ALB (~$22-32/mo) per application stack; correct for MVP isolation but dominates per-deployment cost (~$77-114/mo customer-side) | `application-stack.ts:591-598,1262-1265` |
| DZ-AUDIT-023 | ECR repo has no lifecycle policy; immutable tags + RETAIN → unbounded image storage growth in the vendor account | `build-pipeline.ts:62-66` |
| DZ-AUDIT-024 | Result-route settled guard is check-then-act, not atomic (duplicate result POSTs can double-emit events; side effects idempotent) | `server.ts:5961-5967,6064-6074` |
| DZ-AUDIT-025 | Relay token-rotation machinery is dead (no `X-Deployz-New-Token` sender); commands route omits the rotation header its siblings accept | `packages/relay/src/poll.ts:237`; `server.ts:5866` |
| DZ-AUDIT-026 | Vocabulary drift: `deployments.state='DISCONNECTED'` never written; DB job types the relay cannot execute (`MIGRATION`); noop executors; stale "FOUR OF THESE ARE STILL STUBS" comment | `packages/db/src/enums.ts:76`; `relay/commands.ts:15-28`; `relay/index.ts:1401-1404` |
| DZ-AUDIT-027 | `analysisStatus='ANALYZING'` has no sweeper; a killed worker strands the app at "Analysing" until manual re-analyse | `apps/api/src/analysis.ts:375-379`; `worker.ts:892-905` |
| DZ-AUDIT-028 | Claim-time scrubbing + re-offer can install `'***'` as a secret parameter value (requires lost claim response + re-offer) | `server.ts:5886-5898`; `install.ts:1182-1185` |
| DZ-AUDIT-029 | RESTART reports success without observing rollout (contrast the four-gate deploy settle); bounded by honest heartbeats | `packages/relay/src/deploy.ts:1008-1016` |
| DZ-AUDIT-030 | DESTROY stuck in `DELETE_IN_PROGRESS` on a CONNECTED relay has no product exit; force-complete requires DISCONNECTED or 2×FAILED; undocumented relay/reset two-step is the only path | `server.ts:4315,4348-4355`; `destroy.ts:171-173` |
| DZ-AUDIT-031 | INSTALLING has no timeout when the app never becomes healthy; endless "Running health checks" (actionable exits exist) | `server.ts:6498-6516`; `deployment-status.ts:1002-1005` |
| DZ-AUDIT-032 | deploy-bulk skips the `installationId` gate the single deploy enforces; doomed jobs queue after relay/reset | `server.ts:3967-3985` vs `:985-991` |
| DZ-AUDIT-033 | Documentation contradictions: status doc says INSTALL result ⇒ HEALTHY (code: heartbeat only); status doc says purge removes the bootstrap stack (code: retained by design); `server.ts:1403-1408` claims Lightsail LB while CDK ships API GW+Lambda (trustProxy); `ecr-grants.ts:15-16` claims STS verification that does not exist; project-brief superseded sections | `docs/mvp-implementation-status.md:118-119,149-153` |
| DZ-AUDIT-034 | UI-system conformance: native `<select>` on deployments/new, `<details>` and native checkbox on config page instead of shadcn `Select`/`Collapsible`/`Checkbox` | `apps/web/src/app/dashboard/deployments/new/page.tsx:65-66`; `applications/[id]/config/page.tsx:264-276,976-984` |
| DZ-AUDIT-035 | Minor UX set: generic deployment-list error messages (no envelope parsing); `observedState.url` fragile cast for "Open application"; deployments table lacks a health column; "All deployments healthy" counts UPDATE_AVAILABLE | `apps/web/src/lib/deployments.ts:260-275`; `deployment-list.tsx:27-33`; `home-state.ts:77` |
| DZ-AUDIT-036 | IAM containment notes (all bounded by role trust policy + published-template architecture; documented): S3 bucket actions unscoped by tag; ElastiCache RG actions untaggable (live-verified rationale in code); two-phase IAM is cosmetic (boundary is the real ceiling); public template bucket is bucket-wide public-read | `bootstrap-stack.ts:522-546,564-593,1186-1194`; `deployz-stack.ts:140-151` |
| DZ-AUDIT-037 | CI hygiene: third-party actions pinned to major tags only (not SHAs); e2e.yml uses older action versions than ci.yml; e2e-simulated job lacks concurrency grouping | `.github/workflows/*.yml` |
| DZ-AUDIT-038 | Force-complete (dead-relay DESTROY escape) has no end-to-end test; only the settlement half is unit-tested | `failure-semantics.test.ts:412-422` |
| DZ-AUDIT-039 | `pnpm vitest run` OOMs on Windows (V8 zone allocation) inside `scripts/*` harness tests — reproducible locally 3/3; CI (Linux) green | Local runs 2026-09-09 |

---

## 7. Spec ↔ Implementation Matrix

| Capability | Required behavior (source) | Actual implementation | Status | Findings |
|---|---|---|---|---|
| Repo analysis | Deterministic detectors; AI never overrides; typed output with evidence (`ai-analysis.md`) | 14 detectors + gated AI fallback; SHA-cached | OK | 027 (stuck ANALYZING) |
| Preflight gates | Refuse non-READY at all provisioning boundaries (`mvp-implementation-status.md`) | Enforced at deployment creation, both link launches, relay registration | OK | — |
| Build pipeline | Immutable digest deploys (`architecture.md:47-48`) | Digest-pinned deploys; build correlation + stale sweep | PARTIAL | 002, 021 |
| Install | Bootstrap → relay registers → INSTALL job → stack → verify → auto-deploy | Implemented end-to-end; describe-first; recovery pass for ROLLBACK_COMPLETE | OK | 001 (re-enrollment), 005 (regions) |
| Health verification | Release pointer advances only on gated heartbeat observation (`§10.3`) | Four promotion gates + exactly-one-digest rule | OK | 006 (race) |
| Default HTTPS | Permanent `d-<id>.deployz.dev`; probe-gated ACTIVE | Machine + relay ACM sweep + teardown backstops | PARTIAL | 008 (unbounded retry) |
| Custom domains | Preferred only when ACTIVE + healthy | Domain jobs, never fail deployment | OK | — |
| Failed update | Returns to UPDATE_AVAILABLE/HEALTHY; previous release serving (`resilience.md:53-62`) | Shared `deploymentStateAfterFailedJob` in both settlement paths | OK | 011 (DEPLOY-009 divergence) |
| Failed first install | Deployment FAILED; recovery paths work | FAILED marking correct; recovery wedge | PARTIAL | 001 |
| Update availability | "Newer READY release exists" | Written at build start; never reverted | PARTIAL | 007 |
| Rollback | Previous digest, never migrations | Implemented; bookkeeping separate | OK | — |
| Destroy/retain | Retains DB/credentials/files; bootstrap customer-deleted | RETAIN + deletion protection + authorized-data-deletion split | OK | 009, 010 (orphans) |
| Purge | Deletes retained resources, verified ownership | Tag-verified, phased, resumable | PARTIAL | 009 (previous attempt) |
| Dead relay / disconnect | Park-don't-fail; WAITING reclaimed; 24h grace; force-complete | Implemented exactly as documented | OK | 030 (DELETE_IN_PROGRESS exit), 038 (test gap) |
| Operation exclusivity | One active mutating job; idempotency keys | Partial unique index + `createOrReuseJob` + `requireDeploymentIdle` | OK | 024 (guard atomicity) |
| Watchdog | Two clocks; reconcile-before-fail; DESTROY exempt | Implemented as documented | PARTIAL | 006, 011 |
| Relay trust boundary | Zero CP credentials; egress-only; tag-conditioned IAM; no log reads | Verified across all IAM surfaces + code | OK | 013 (first-token adoption) |
| Secrets | Never stored CP-side; redaction at ingest | Masks in DB; claim-time scrubbing; redaction on all ingest points | PARTIAL | 012 (SQS transit), 028 |
| Tenant isolation | Org-scoped access on every route | Structural `loadOwned*` pattern; 404 not 403 | OK | 004 (registry layer) |
| Billing | $49 + $19; entitlements gate deployments; Paddle webhooks verified | Implemented; billing sweep; support-session read-only | OK | — |
| Admin/support | Cross-tenant gated; audited | `requireTeamAdmin`; audit events; recovery actions | OK | — |
| Default domain | `d-<id>.deployz.dev` URLs | Implemented via Cloudflare driver | OK | — |
| Regional behavior | All advertised regions deployable | Fail-closed default; conditional trap | PARTIAL | 005, 017, 038 |

---

## 8. Deployment Lifecycle Assessment

Stage-by-stage verdicts (full table held in the audit workpapers): stages 1-2 (creation, GitHub) **OK**; stage 3 (analysis) weak — no stuck-state sweeper (027); stages 4-6 (manifest, config, deployment creation) **OK**; stage 7 (links/launch) weak — retry bookkeeping (010); stage 8 (build) broken for tag collisions (002); stage 9 (enrollment) broken on re-enrollment (001), trust caveat (013); stages 10-11 (provisioning, post-install) **OK** — describe-first, deferral durability, auto-deploy guards; stage 12 (deploy/migration) weak — migration double-run window (003); stage 13 (health/promotion) **OK**; stage 14 (HTTPS) weak — retry budget (008); stages 15, 17, 20, 22-24 (status, settlement, disconnect, watchdog, inventory, grants) mixed — 006, 007, 009, 011; stages 16 (update availability) broken semantics (007); stages 18-19 (destroy, purge) **OK** structurally, orphan gaps (009, 010, 030).

Impossible states found: INSTALLING-with-settled-job (001) is a true dead state; UPDATE_AVAILABLE-with-no-deployable-release (007) is a permanent lie; HEALTHY-with-zero-tasks (011) is a false positive reachable via the watchdog path only.

---

## 9. AWS Resource / Cost Assessment

Per full application (DB + Redis), customer account: VPC+1 NAT (~$32), ALB (~$22-32), Fargate 256/512 (~$15), RDS t4g.micro (~$15), ElastiCache t4g.micro (~$14), S3/logs/alarms (~$3) ≈ **$100-115/mo**. Stateless ≈ **$77-82/mo**. Control plane ≈ **$95-120/mo + ECR growth + ~$0.50/build**. Resources are the minimum for the chosen per-deployment-isolation architecture; nothing speculative was found (no Route53 zone, no CloudFront, no unused clusters). Cost concerns are structural (DZ-AUDIT-022) plus leakage paths: orphaned RETAIN'd RDS/buckets via 009/010, unbounded ECR growth (023), unbounded job/ACM churn via 008. Bootstrap/relay Lambda ~$2-5/mo per installation. 17-region template fan-out exists in code and is verified by tests, but publication is operationally gated (005).

---

## 10. Architecture Assessment

**Good decisions (keep).**
- The DB-backed command queue (`deployment_jobs` as queue + audit record) with atomic claim, idempotency keys, and a partial-unique exclusivity index is the right MVP simplification — one source of truth, no broker, no durable-execution engine.
- The two-clock watchdog (staleness vs runtime) with re-offer-before-fail, park-WAITING, and describe-first executors converges correctly for a relay whose invocations die silently.
- Trust-boundary discipline is consistent and shapes the whole design: enrollment-code binding, hash-only tokens, tag-conditioned customer IAM, server-side failure refinement (because relay code is immutable in the field), redaction at every ingest.
- Read-time status derivation (`deriveDeploymentStatus`) keeps persisted state minimal; verification as a second question (`verify.ts`), promotion gates, and the uncertain-result rule are the load-bearing anti-false-healthy mechanisms — all implemented as documented.

**Weak decisions (contain or fix).**
- The recovery triad (`relay/reset`, install-link retry, deploy-link retry) is triplicated with divergent bookkeeping, and none reconciles with the fixed `:INSTALL` idempotency key — the seam containing DZ-AUDIT-001/009/010.
- `deployments.state` has six writers and no transition validator; release lifecycle writing deployment lifecycle (007), dead DISCONNECTED (026) are symptoms.
- One shared ECR repository is the wrong tenancy boundary for a multi-vendor product (002 + 004 are both consequences).
- Settlement logic mirrored by copy between API and watchdog (011) already diverged.
- Unconditional watchdog UPDATEs (006) — one predicate away from race-free.

**Excessive complexity for MVP.** Dead token-rotation machinery across two packages; noop relay vocabulary; the unused `policyRevision` field; two nearly-parallel domain state machines; `server.ts` at ~6,700 lines (the extraction pattern already exists and should continue).

Not penalized (deliberate MVP simplicity, working as intended): per-deployment VPC/ALB isolation, PGlite-based tests, simulated-AWS E2E seam, no pagination on fleet lists, no CloudFront/Route53.

---

## 11. Reliability Assessment

- **Install:** golden path solid (describe-before-create, AlreadyExists adopted, DELETE_IN_PROGRESS recovery, ROLLBACK_COMPLETE cleanup pass, preflight at all boundaries). Broken edge: re-enrollment after any settled INSTALL (001). Region trap conditional on config (005).
- **Update:** digest short-circuit, circuit-breaker rollback detection, crash-loop detection, gated promotion — solid. Update-availability semantics lie on build failure (007). Migration double-run window (003).
- **Rollback:** never runs migrations; bookkeeping separate; verified correct in simulation and unit suites.
- **Destroy/purge:** DESTROY never watchdog-failed; force-complete is honest (`SKIPPED_RELAY_OFFLINE`); purge tag-verified and resumable. Orphan gaps via previous-installation blindness (009/010); DELETE_IN_PROGRESS escape hatch undocumented (030).
- **Relay loss:** first-class states end-to-end (WAITING park, 24h grace, DISCONNECTED sweep, force-complete) — matches `deployment-resilience.md` exactly.
- **Retries:** bounded re-offers (×3), retry-aware keys, stale-build sweep, lost-event recovery — good. Watchdog write races (006) and guard asymmetry (032) are the residual defects.
- **AWS failures:** transient errors absorbed in relay wait loops with budgets; uncertain-result rule respected everywhere we traced; 24 instances verified correct.
- **Does everything eventually reach a correct terminal state?** Yes for every traced path *except*: DZ-AUDIT-001 (permanent INSTALLING) and the practical dead ends in 009/010 (orphaned resources with no product path) and 030 (undocumented exit).

---

## 12. Security Assessment

**No security issue blocks launch.** The core controls are genuinely sound: structural tenant isolation (org-scoped queries on every route, 404 not 403), timing-safe hashed tokens, single-use enrollment with takeover refusal, verified GitHub/Paddle webhook signatures, secrets masked at rest and redacted at ingest (25 controls verified correct across two independent reviews), no XSS/SSRF/SQLi vectors found, CSRF mitigated (SameSite + CORS), admin support-mode read-only and audited, fixture routes env-gated.

Trust-boundary notes (all P2/P3, bounded): shared-registry cross-tenant pull by tag guess (004); unverified first registration + public enrollment code (013); plaintext secrets in SQS/DLQ (012); IAM containment relies on role trust policy in three documented spots (036); relay can forge its own observations by design (documented trust boundary — the control plane has no independent channel; the promotion gates check internal consistency only). Relay compromise blast radius is one deployment — no cross-deployment pivot is possible.

---

## 13. Testing Coverage Matrix

| Critical behavior | Coverage | Gap | Risk | Finding |
|---|---|---|---|---|
| No-database deploy | **MISSING** — every scenario provisions RDS | stateless path never exercised | Medium | 017 |
| PostgreSQL | COVERED (all scenarios + failure classifications) | — | Low | — |
| Redis | COVERED (success + failure + browser tests) | — | Low | — |
| Storage (S3) | COVERED (retained-resources scenario) | — | Low | — |
| HTTPS / custom domain | COVERED (12-step lifecycle + fixture scenarios + 925-line unit suite) | unbounded-retry not asserted | Low | 008 |
| First install | COVERED | re-enrollment-after-failure untested | High | 001 |
| Failed first install | COVERED (rollback/failure scenarios, failure codes) | — | Low | — |
| Update / failed update | COVERED (lifecycle scenario asserts UPDATE_AVAILABLE invariant) | build-failure revert untested | Medium | 007 |
| Rollback | COVERED (success + failure + digest reconciliation) | — | Low | — |
| Destroy / retained resources | COVERED | — | Low | — |
| Dead relay / disconnect / force-complete | PARTIAL — park/grace/reset covered; force-complete only unit-half | no E2E drive of the route | Medium | 038 |
| Regional behavior | PARTIAL — 17-region publish code tested; no non-us-east-1 scenario; republish never runs in CI | Medium | 005 |
| Reconciliation / watchdog | COVERED (1,265-line worker suite; two clocks; re-offer bounds) | write races unasserted | Medium | 006 |
| Operation exclusivity | COVERED (route + index + atomic claim) | — | Low | — |
| Production safety | COVERED (static assertions: no scenario-control endpoints, no AWS value imports, no fixture env leakage) | — | Low | — |
| Simulated E2E harness | 18 scenarios in CI (`e2e-simulated` job) | Windows OOM in `scripts/*` harnesses | Low | 039 |

Test quality is high: assertions target behavior (states, events, invariants), the simulator boundary is statically enforced, and negative-path tests genuinely fail when the property breaks.

---

## 14. UX / Product Assessment

The product language is a real strength: a complete deployment-vocabulary module maps all 10 states and every event/action-gating reason into vendor-facing copy; raw AWS/CloudFormation states appear only inside an "Advanced details" disclosure, as the UI system requires. The five-state homepage, readiness page, config merge UX, and install/deploy-link customer pages are coherent and complete, with type-to-confirm destructive flows and an honest force-complete/purge story.

Main product risks (all P2, all silent-failure patterns): a disconnect dialog that can hide the retention warning (018), "No deployable releases" on transient errors (019), a frozen fleet view during outages (020), and the permanent "Update available" lie (007). Support-burden prediction, in order: "I deleted it but AWS is still billing" (mitigated by docs + DELETED-page warnings; worsened by 009/010), "the deploy button says no releases" (019), "it's stuck installing" (001 — currently catastrophic, the single worst ticket generator), "update available but deploy fails" (007/002).

Verdict for the target user (small SaaS vendor, limited DevOps): with DZ-AUDIT-001 fixed, a vendor can successfully understand and operate Deployz.

---

## 15. Documentation Drift

Meaningful mismatches (consolidated in DZ-AUDIT-033):
1. `docs/mvp-implementation-status.md:118-119` — INSTALL result ⇒ HEALTHY is false (heartbeat-only by design, correctly documented elsewhere).
2. `docs/mvp-implementation-status.md:149-153` — purge does not remove the bootstrap stack (retained by design; the doc and the module header contradict the code).
3. `apps/api/src/server.ts:1403-1408` — claims a Lightsail LB in front of the API; CDK ships API Gateway + Lambda. `trustProxy` correctness depends on which is true.
4. `apps/api/src/ecr-grants.ts:15-16` — claims STS verification of the account id; no such call exists.
5. `docs/project-brief.md` — superseded sections (optional worker, 9-state model, §30 preflight) still read as current.
6. Relay-side comment `relay/index.ts:1401-1404` claims CONFIG_UPDATE/DESTROY are stubs; both are implemented.
7. Dead vocabulary documented as live (`DISCONNECTED` state, `MIGRATION` job type, token rotation).

---

## 16. Technical Debt Inventory

Material only: dead relay token-rotation machinery (025); unreachable `DISCONNECTED` state + unexecutable job types + stale stub comment (026); `server.ts` monolith with copy-divergence risk between API and watchdog settlement logic (011, 006, 024 share this root); unused `policyRevision` optimistic-lock placeholder (021); duplicated recovery-triad route bodies (001/010 root). Cosmetic lint/style issues are excluded by policy.

---

## 17. MVP Scope Assessment

**Required but missing/incomplete:** none at the capability level — every required MVP capability exists. Completeness defects: first-install retry flow (001), build independence across apps (002), migration idempotence (003), regional advertisement guarantee (005).

**Implemented but unnecessary for MVP:** relay token rotation (dead); `MIGRATE`/`REFRESH_METADATA`/`REPORT_HEALTH` noop vocabulary; `SUCCESS` legacy job state; the second domain state machine's parallel budget logic. All are small and contained — candidate deletions, not urgent.

**Undocumented but implemented:** heartbeat-driven default-HTTPS driver side effects; force-complete's two-step escape via relay/reset (030); STS-verification claim (inverted — documented but not implemented).

**Founder decisions required:**
1. Approve the region posture: publish all advertised regions operationally, or advertise only us-east-1 until then (005).
2. Approve the install-link trust model: keep the enrollment code public-with-race-acceptance (013) or adopt the bootstrap token server-side.
3. Approve the shared-ECR tenancy: accept tag-guess pull risk short-term (bounded by 002's fix) or move to per-app repositories now.
4. Confirm the actual production value of `DEPLOYABLE_AWS_REGIONS` / `BOOTSTRAP_REPUBLISH` (not verifiable from the repository).

---

## 18. Prioritized Remediation Plan

### Before launch (P0/P1)
| # | Findings | Work | Impact | Complexity |
|---|---|---|---|---|
| 1 | 001 | Use `retryAwareIdempotencyKey` (or reopen) for INSTALL at registration + regression test | Unblocks the primary recovery flow | S |
| 2 | 002 (also shrinks 004) | Namespace image tags (app id + version) at build/push | Fixes deterministic build failures; reduces cross-tenant guessability | S |
| 3 | 003 | Write the migration pending marker immediately after `RunTask` | Restores the "never re-run" invariant | S |

### Immediately after MVP (high-value P2)
| # | Findings | Work | Impact | Complexity |
|---|---|---|---|---|
| 4 | 005 | Verify production region vars; add live publication assertion + control-plane event on template fetch failure | Kills the silent region trap | M |
| 5 | 007 | Derive UPDATE_AVAILABLE at read time (or revert on build failure) | Ends the permanent "update available" lie | S |
| 6 | 006, 024 | State-predicated watchdog/result writes; atomic settled guard | Removes the last race class in the core loop | S |
| 7 | 008, 026 | Terminal ERROR states for HTTPS/domain machines; delete dead vocabulary | Bounded jobs; honest presentation | M |
| 8 | 009, 010 | Record `previousInstallationId` in public retries; sweep previous tags in purge | Closes the orphan-resource class | M |
| 9 | 011, 032 | Share one settlement predicate; align bulk-deploy gates | Consistent failure semantics | S |
| 10 | 012, 014 | SSE-SQS explicit; control-plane RDS deletion protection | Data-protection hygiene | S |
| 11 | 015, 016 | DB-touching post-deploy probe; scope CI AWS keys | Deploy truthfulness; smaller CI blast radius | S |
| 12 | 013, 004 | Founder decision + server-side token adoption (or keep documented); per-app repos | Trust-model closure | M–L |
| 13 | 017, 018, 019, 020 | Stateless scenario; dialog/poll/release-list UX fixes | Removes the top silent-failure UX set | M |

### Later (P3)
021–023, 025–039: RMW lock, cost structure review (NAT/ALB sharing post-MVP), ECR lifecycle policy, dead-code deletion, ANALYZING sweeper, `***` reinstall guard, RESTART verification, DELETE_IN_PROGRESS exit, INSTALLING timeout, bulk gate alignment, documentation corrections (033), UI conformance (034), minor UX set (035), IAM notes (036), CI hygiene (037), force-complete E2E (038), Windows OOM triage (039).

---

## 19. Launch Checklist

| Item | Class |
|---|---|
| Fix DZ-AUDIT-001 (re-enrollment wedge) + regression test | **BLOCKER** |
| Fix DZ-AUDIT-002 (image tag namespacing) | **BLOCKER** |
| Fix DZ-AUDIT-003 (migration marker ordering) | **BLOCKER** |
| Verify production `DEPLOYABLE_AWS_REGIONS` vs published templates (005) | **REQUIRED** |
| Control-plane RDS deletion protection (014) | **REQUIRED** |
| SSE on job queues / DLQ secret policy (012) | **REQUIRED** |
| Truthful post-deploy health probe (015) | **REQUIRED** |
| One stateless E2E scenario (017) | **REQUIRED** |
| Disconnect-dialog retained-resources guarantee (018) | **REQUIRED** |
| Release-list error state (019); homepage staleness (020); UPDATE_AVAILABLE truthfulness (007) | **REQUIRED** |
| Watchdog state predicates (006, 024); settlement predicate unification (011); bulk gates (032) | **RECOMMENDED** |
| HTTPS/domain retry budgets (008); purge/retry orphan bookkeeping (009, 010) | **RECOMMENDED** |
| ECR lifecycle policy (023); CI key scoping (016); CI action pinning (037) | **RECOMMENDED** |
| Documentation corrections (033); UI conformance (034); force-complete E2E (038) | **RECOMMENDED** |
| NAT/ALB sharing, per-app ECR repos, dead-code deletion, INSTALLING timeout, DELETE_IN_PROGRESS exit | **OPTIONAL (post-MVP)** |

---

## 20. Final Verdict

1. **Does the repository implement the intended Deployz MVP?** Yes. Every capability in the authoritative MVP boundary exists and, with the exceptions in this report, behaves as specified. The documented resilience invariants are implemented with unusual fidelity.
2. **Is it safe enough for real customer deployment?** Almost. No P0; data-protection and isolation are solid at the trust boundaries that matter. The three P1s are reliability defects in recovery/build paths, not security holes; with 005's config verified, first customers would mostly succeed — but the install-retry wedge (001) would become the dominant support ticket.
3. **What blocks launch?** DZ-AUDIT-001 (re-enrollment INSTALLING wedge), DZ-AUDIT-002 (cross-app image tag collisions), DZ-AUDIT-003 (migration double-run). All three have small, well-understood fixes.
4. **What can wait?** Everything in §18 "Immediately after MVP" and "Later" — including all 17 P2s except 005's config verification, which is a REQUIRED pre-launch check.
5. **What should be removed/deferred?** Delete the dead relay token-rotation machinery, noop relay vocabulary, legacy `SUCCESS` state, and the unused `policyRevision` placeholder. NAT/ALB sharing and per-app ECR repositories are post-MVP architectural items, not MVP scope.
6. **Single biggest technical risk:** the install recovery seam — a wedged INSTALLING state (001) converts the product's own recovery guidance into a dead end during exactly the scenarios early customers will hit most.
7. **Single biggest product risk:** silent mistruths in the UI (permanent "Update available", empty release lists, hidden retention warnings) that erode vendor trust and convert into support tickets — each with a small fix.

**Verdict: GO WITH BLOCKERS.**

---

*Audit conducted 2026-09-09 against `main` @ e4de944. Report-only; no product code was modified. Peer review: all P1 findings independently re-verified; 7 proposed findings refuted and excluded during reconciliation.*

