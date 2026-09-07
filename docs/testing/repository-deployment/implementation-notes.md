# Stage B — implementation notes

Phase 0 record: what the production deployment path is on `main` at the
time of the audit, what Stage B reuses, what it must build, and the phase
plan with its status. This is the anti-duplication map for every later
phase. Baseline: Deployz `main` at `c97c218` (2026-09-05, after the P0 hardening
PRs #189/#194), analysis version 15, Stage A run artifacts refreshed at
version 15 on `5d99c3e` (120 of 120 analysed, 72 verdict matches, 6 false
acceptances, 18 false rejections).

## 1. The production path, as inspected

Every step a vendor's customer deployment takes today, with the code that
runs it. Stage B drives exactly these steps.

| Step | Code | What it does |
| --- | --- | --- |
| Application | `POST /api/applications` (`apps/api/src/server.ts`) | `repoFullName`, `githubInstallationId`, `defaultBranch` (a ref; a commit SHA works — the Stage A harness and the version canary both pass one) |
| Analysis | `POST /api/applications/:id/analyse` → worker `ANALYSE_APPLICATION` → `runApplicationAnalysis` (`apps/api/src/analysis.ts`) | tree fetch through the installation token, `analyseRepo`, AI fallback, readiness report, persisted metadata + manifest overrides |
| Vendor overrides | `PATCH /api/applications/:id` (`applicationToManifestOverrides`, `apps/api/src/manifest.ts`) | port, health path, Dockerfile path, build context, start/migration command, database/redis/storage flags |
| Configuration values | `PUT /api/applications/:id/config` (`apps/api/src/config.ts`) | vendor defaults and per-customer overrides; secret values go to the control plane's secret writer, never the DB |
| Gate | `POST /api/deployments` → `createDeploymentRecord` (`apps/api/src/deploy-links.ts`) → `evaluateManifestReadiness` + `apps/api/src/preflight.ts` | 422 `MANIFEST_NEEDS_CONFIGURATION` / `MANIFEST_NOT_COMPATIBLE`; the READY manifest is frozen into `deployments.desired_state.manifest` |
| Release | `POST /api/applications/:id/releases {version, gitSha}` → worker `BUILD_RELEASE` (`packages/cdk/src/lambda/worker.ts`) | `fetchRepoArchive(token, repo, ref=gitSha)` → S3 → CodeBuild (`packages/cdk/src/pipeline/build-pipeline.ts`: `DOCKERFILE_PATH`, `BUILD_CONTEXT` from the manifest/overrides, `RELEASE_VERSION` = immutable ECR tag) → `IMAGE_DIGEST` exported → `releases.image_digest`, READY |
| Install link | `GET /api/install/:linkId` → Quick Create URL (`packages/cdk/src/quick-create/install-link.ts`); `POST /api/install/:linkId/launched` | bootstrap template URL from `BOOTSTRAP_TEMPLATE_URL`, stack name `deployz-bootstrap-<app>-<8>`, `ControlPlaneUrl` + `EnrollmentCode` parameters |
| Bootstrap | customer `CreateStack` of the published bootstrap template | relay Lambda on a 5-minute EventBridge schedule, execution role, `InstallationId` output |
| Enroll + INSTALL | `POST /api/relay/register` (`server.ts`) creates the INSTALL job with `parameters` (`buildInstallParameters`), `redisRequired`, `manifest` | relay `settleInstall` (`packages/relay/src/index.ts`): picks the redis template variant, merges manifest parameters (`param_ContainerPort`, `param_HealthCheckPath`), drops parameters the template does not declare, `CreateStack` with the `deployz:installation` tag, 3-minute watch budget, SSM pending marker, resumes on later polls |
| Auto-deploy | INSTALL success → newest READY release → `DEPLOY_RELEASE` (`packages/relay/src/deploy.ts`) | migration one-off task (`sh -c <command>`) when the release/manifest has one, task-definition revision with the release digest, `UpdateService`, circuit breaker |
| Post-install config | `queuePostInstallConfig` (`apps/api/src/install-config.ts`) → `CONFIG_UPDATE` | vendor/customer values and `deployz_generated` secrets minted in the customer account; binding aliases registered (`packages/relay/src/binding-alias.ts`) |
| Health | `POST /api/relay/health` → `apps/api/src/deployment-status.ts` | HEALTHY only with rollout COMPLETED, full counts, healthy targets, HTTP probe; `currentReleaseId` promoted by digest reconciliation |
| Default HTTPS | `apps/api/src/default-https.ts` + relay `domain.ts` | ACM certificate, Cloudflare CNAMEs in the deployz.dev zone, 443 listener, `https://d-<deployment-id>.deployz.dev` |
| Disconnect / Purge | `POST /api/deployments/:id/destroy`, `/purge` → relay `destroy.ts`, `purge.ts` | DESTROY deletes the application stack, retains RDS + credentials + bucket; PURGE deletes those and the network orphans; the bootstrap stack is the customer's to delete |

### What the published templates are today

Checked on 2026-09-05 against the deployed API Lambda
(`Deployz-ApiLambdaFunction8FC74655-cJvQd51xjme6`):

- `BOOTSTRAP_TEMPLATE_URL` → `bootstrap/v1/bootstrap-template-v1.json`,
  relay asset `8a93b127…`.
- Its `ApplicationTemplateUrl` default →
  `application/v1/application-template-v1.json`: 47 resources, container
  image pinned to `deployz-images@sha256:a61054b3…` (a Documenso build),
  Documenso preset (`NEXT_PRIVATE_*` bindings and health command,
  `param_NextauthSecret` … `param_SmtpFromName`).
- The committed artifact `packages/cdk/artifacts/application-template-v1.json`
  is the generic synth (placeholder image, no preset). The production
  publish used `APP_PRESET=documenso`.

Consequences, recorded as **DEPLOY-001** in [`findings.md`](findings.md):

1. The image a fresh install runs is fixed at template-publish time. For
   any application other than the one the template was published for, the
   ECS service starts the wrong image with the manifest's port and health
   path, cannot stabilise, and CloudFormation rolls the install back
   before the auto-deploy of the real release can happen.
2. The Documenso preset's container health command probes
   `localhost:3000/api/health` regardless of `param_ContainerPort` /
   `param_HealthCheckPath`.
3. The generic template's container health command is
   `curl -f http://localhost:<port><path>`; images without `curl` (or
   without a shell) cannot pass it. This is a hypothesis until Wave 1
   produces evidence; it is listed here so it is looked for, not assumed.

The version canary sidesteps (1) and (2) by publishing a per-run template
pinned to its own v1 image and passing the bootstrap template's
`ApplicationTemplateUrl` parameter. That is a product-supported parameter,
but a customer's Quick Create never sets it.

### Stage B decision on the template

Stage B does not hand-craft CloudFormation and does not publish a
per-repository template. It uses the product's own publisher
(`publish-application.mjs`) once per Deployz commit under test, with no
preset, under a Stage B key prefix (`application/stage-b-<commit>/`), and
passes that URL through the bootstrap `ApplicationTemplateUrl` parameter —
the one deviation from a customer's Quick Create, recorded on every
result as `deployment.templateSource: "stage-b-generic"`.

For the install to run the repository's own image, the generic fix for
DEPLOY-001 is implemented before Wave 1 (Phase 3a): the application
template declares an image parameter whose default is the publish-time
image, the INSTALL payload carries the newest READY release's image
reference, and the relay passes it (the existing undeclared-parameter drop
keeps older templates working). Whether the production default template
should become the generic one, and whether an install without a READY
release should be refused at launch, are product decisions the final
report carries as FIX_BEFORE_MVP / CONSIDER_FOR_MVP items with evidence.

### Repository access (blocker for the real-AWS phases)

The vendor GitHub App installation `156387233` (`deployz-dev` on
`instashop-dev`) has **selected-repository access** (11 repositories). The
P0 hardening session forked `docuseal`, `ghostfolio`, `kutt`, `v2`
(miniflux) and `rallly` into `instashop-dev` and pinned their default
branches to the corpus commits, and Deployz could not list, analyse or
build them. Deployz reads repositories only through that installation
(`buildFileTreeForAnalysis`, `fetchRepoArchive`), so Stage B's real
phases need the operator to extend the installation's repository access
(all repositories, or each Stage B fork). Until then Phases 1 and 2 (the
harness and the offline gate audit) proceed; Phase 3 is blocked on that
setting. The per-repository form is a fork in `instashop-dev` whose
default branch is pinned to the Stage A commit — the fork keeps the commit
SHA, the release is created with `gitSha` = that SHA, and the result
records `repositoryForm: "fork"`.

## 2. Reuse map

| Stage B concern | Reused from | Notes |
| --- | --- | --- |
| Benchmark parsing, selection, expected facts | `scripts/repository-compatibility/manifest.ts` | `loadBenchmark`, `selectEntries`; Stage B adds `--cohort`, `--wave`, `--finding` on top |
| Offline snapshots + in-process production analysis + gate | `scripts/repository-compatibility/{snapshot,analyse,normalize}.ts` | B1 uses `openAnalysisSession` unchanged; the Stage A `.cache/` (100 snapshots, in the Stage A worktree) is copied into this worktree's `.cache/` (gitignored) |
| Vendor HTTP client with the better-auth cookie jar and Origin handling | `scripts/version-canary/control-plane.ts` | unchanged; Stage B adds `getInfrastructure`/`preflight` reads where missing |
| AWS CLI wrappers, `createBootstrapStack`, `describeRunningService`, `targetHealth`, `auditLeaks`, id-keyed deletions | `scripts/version-canary/aws.ts` | unchanged; Stage B adds `describeStoppedTasks` (stop reasons), `tailLogGroup` (sanitised tail), RDS/ElastiCache/S3 presence reads, and a tag-based Stage B scan |
| Product Disconnect/Purge, leftovers, leak audit | `scripts/version-canary/teardown.ts` | called with a Stage B `Canary`-shaped context |
| Real-AWS opt-in and account refusal | `scripts/e2e.mjs`, `scripts/version-canary/config.ts` | `requireRealAwsOptIn` reused; Stage B adds `--real-aws` |
| Evidence pattern (`run.json`, per-step files, summary) | `scripts/version-canary/evidence.ts` | pattern reused for the per-repository ledger; the committed result is a separate, schema-validated document |
| Generic application template publish | `packages/cdk/scripts/publish-application.mjs` | invoked once per Deployz commit |
| Failure vocabulary for job/relay failures | `packages/contracts` failure codes, `apps/api/src/failure-classification.ts` | mapped onto the Stage B failure stages; never a parallel taxonomy |

## 3. What Stage B builds (Phase 1)

`scripts/repository-deployment/`:

- `index.ts` — `pnpm benchmark:deploy` CLI: selection, `--gate`,
  `--dry-run`, `--real-aws`, `--resume`, `--cleanup`, `--audit`, `--force`,
  `--concurrency` (default 1, max 2).
- `config.ts` — `deploy-config.yaml` schema (zod, strict): per-repository
  vendor overrides, configuration keys (non-secret values inline; secret
  keys named only, generated at run time), health/response expectations,
  dependency verification hints, wave membership, notes.
- `results.ts` — the result schema (zod, strict), the two vocabularies,
  write/protect rules (`--force`, `runs/history/`, `runs/unseen-frozen/`),
  summary generation.
- `ledger.ts` — the per-repository in-flight ledger (gitignored), resume
  discovery.
- `gate.ts` — B1 over the Stage A analysis session; Stage B view of the
  gate (expected deployable vs verdict, required keys, false acceptance /
  rejection).
- `deploy.ts` — B2–B6 steps against the deployed control plane and the
  test account, each recording evidence; classification of a failure into
  a stage + root cause with the evidence that decided it.
- `cleanup.ts` — Disconnect/Purge/leftovers/audit around
  `scripts/version-canary/teardown.ts`, always in `finally`.
- `*.test.ts` — parsing, schema, selection, resume, dry-run, opt-in,
  cleanup-on-failure, classification, summary; never the network.

## 4. Phase plan and status

| Phase | Deliverable | Status |
| --- | --- | --- |
| 0 Audit + architecture | this note, `README.md`, `findings.md` with DEPLOY-001 | Done — this PR |
| 1 Harness | `scripts/repository-deployment/`, `pnpm benchmark:deploy`, tests, `deploy-config.yaml` skeleton | Done — 37 harness tests (`pnpm vitest run --project repository-deployment`); the gate audit smoke-ran offline on repo-001/repo-013 |
| 2 B1 gate audit, all 100 | `runs/*.json` gate sections, `summary.*`, gate findings, analyser fixes with regression tests where in scope | Done — 120 of 120 analysed offline at analysis version 15; gate 47 correct accepts / 49 correct rejects / 6 false acceptances / 18 false rejections (identical to the Stage A v15 run); deterministic on rerun; DEPLOY-002/003/004 recorded, DEPLOY-005 predicted; no analyser change (all mistakes are open Stage A findings, deferred with reason) |
| 3a DEPLOY-001 fix | image parameter + INSTALL payload + relay pass-through + tests + republish recipe | Done — PR #197 (main `1f85974`); API deployed; templates republished 2026-09-05 |
| 3 Wave 1 (10) | full funnel, serial, systemic fixes | In progress — see section 7; 6 of 10 attempted (gatus PASS, ihatemoney PASS, umami CONTAINER_START_ERROR rerun in flight, docuseal harness-false-fail rerun pending, miniflux BUILD_ERROR rerun pending, kutt ENV_BINDING_ERROR); DEPLOY-006 fixed (#200); DEPLOY-007 withdrawn; DEPLOY-008 fixed and deployed (#206); DEPLOY-009 fix in review (#207) — wave stopped before ghostfolio under the systemic-bug rule; harness fixes #199/#201/#202/#204/#205 |
| 4 Wave 2 (15) | full funnel, wave-wide cleanup audit | Pending |
| 5 Remaining improvement set | every improvement repository has an outcome; findings resolved | Pending |
| 6 Freeze | green `main`, freeze SHA recorded here | Pending |
| 7 Unseen 20 (+ unseen2 20 when time allows) | frozen baseline preserved, post-fix reruns separate | Pending |
| 8 Final verification + report | `final-report.md`, docs, zero leaks | Pending |

## 5. Watch list (evidence needed before anything is changed)

Areas Stage A flagged that Stage B must observe rather than pre-empt:
database env aliasing (binding aliases are registered post-install, after
the first task start — an app that needs its alias to boot may crash once
before the alias revision arrives), optional-vs-required Redis, S3 binding
names, health endpoint detection, migrations that run at boot versus the
pre-deploy command, ports without `EXPOSE`, monorepo Docker build context,
generated secrets reaching the task before the first request, non-Node
environment schemas, container health commands that need `curl`, and the
RDS `rds.force_ssl` default for clients that connect without TLS.

## 6. Phase 2 record — the gate audit

`pnpm benchmark:deploy --gate` over all 120 entries (100 + `unseen2`),
offline on the Stage A snapshot cache, at analysis version 15 on Deployz
`3be8bb8`. Every entry analysed; nothing failed. The Stage B view of the
gate matches the Stage A v15 run exactly (6 false acceptances, 18 false
rejections), which is the expected result: the harness drives the same
`runApplicationAnalysis` → `evaluateManifestReadiness` path and adds only
the Stage B reading (expected deployable vs verdict) and the offline B2
evaluation with `deploy-config.yaml` applied.

What the audit decided:

- **No analyser change in Phase 2.** All 24 gate mistakes are attributed
  to open Stage A findings (COMP-002/009/010/015/017/024/025/026/037/040);
  they are recorded as DEPLOY-003 (false rejections) and DEPLOY-004
  (false acceptances) and deferred to the Stage A plan so the baseline
  does not move mid-audit.
- **Configuration over-demands** (DEPLOY-002): six READY expectations
  become NEEDS_CONFIGURATION on keys the app does not need; the wave
  configuration provides them so the deployment path is still measured.
- **Predicted binding gap** (DEPLOY-005): the manifests of kutt, directus,
  ihatemoney and memos carry no alias for the names those apps read the
  database under. Wave 1 confirms or refutes it before any fix.
- **Wave 1 configuration validated offline:** all ten Wave 1 entries are
  READY once `deploy-config.yaml` is applied (`gate.configuredVerdict`),
  so no Wave 1 attempt can stop at CONFIG_ERROR for a known reason.
- **Two harness traps** found and fixed on the way: the Stage A cache
  copied from the older Stage A worktree lacked the blobs the COMP-033
  descriptor fetch reads (three cloud-descriptor repositories came out as
  false acceptances until the 120-repository cache from the v15 run was
  used), and the harness imports the built `dist`, so `pnpm build` must
  precede a run (analysis version 14 was reported until rebuilt).

## 7. Phase 3 record — Wave 1 (in progress, paused 2026-09-06)

Order: gatus, umami, docuseal, miniflux, ihatemoney, kutt, ghostfolio,
directus, memos, outline (`deploy-config.yaml`, `wave-1`). Serial, pinned
template mode, one throwaway organization per attempt, the Stage B vendor
in `runs/evidence/series.json` (gitignored).

| Repository | Attempt | Outcome | Notes |
| --- | --- | --- | --- |
| repo-008 gatus | 1 (2026-09-05) | HEALTH_PATH_ERROR / DEPLOYZ_BUG | Every task exit 0, "Task failed container health checks", no ALB target, circuit breaker, ROLLBACK → **DEPLOY-006** (in-container `curl` probe on a scratch image); fixed in PR #200 |
| repo-008 gatus | 2 (2026-09-06) | **PASS** (true deployment success) | Install 8 min, release serving, ECS/ALB healthy, HTTPS ACTIVE, 3-minute window clean. Purge cut short by the harness at 30 min (fixed, #202); VPC + NAT swept by id; installation re-audited clean; recorded on the result |
| repo-001 umami | 1 | interrupted (build) | The wave was stopped after gatus's first failure; ledger cleaned (release tag) |
| repo-001 umami | 2 | interrupted (install) | Paused by the operator during INSTALL; product cleanup (Disconnect → Purge) launched detached, finished after an `aws login` re-auth (the session expired mid-cleanup; only the AWS-side steps failed and a `--cleanup` rerun completed them) |
| repo-001 umami | 3 (2026-09-06) | CONTAINER_START_ERROR (root cause open) | Build, template, Quick Create, enrolment PASS; the ECS service never stabilised (circuit breaker after ~20 min) → ROLLBACK, then ROLLBACK_FAILED because the retained RDS keeps its ENI in the DB security group and private subnet 2 (structural on a failed create; Disconnect + Purge removed it). Product code CONTAINER_START_FAILED. An external watcher saw the App container exit 1 after ~5 min in three consecutive tasks; the rollback deleted the log group before the harness's post-failure fetch, so no log line — harness gap fixed in PR #204 (evidence snapshot during the install wait). Hypothesis under test: node-postgres treats the issued `DATABASE_URL` `sslmode=require` as `verify-full`, and the RDS CA is not in Node's trust store (Documenso passes because Prisma's engine does not verify); would also touch kutt, directus, outline. Rerun once a Node app fails with a log line |
| repo-051 docuseal | 1 (2026-09-06) | APPLICATION_ERROR (harness verdict, rerun pending) | Install 12 min, release serving, ECS/ALB healthy, HTTPS ACTIVE, HTTPS health 200 on every sample after the first; the window's first HTTPS sample was a 521 from the edge right after ACTIVE (HTTP samples 301 = the app's force-SSL redirect, accepted). Harness gap fixed in PR #205 (bounded wait for the health path after ACTIVE, lag recorded); `--repo repo-051 --force` rerun after the wave. Cleanup clean (NAT gateway echo re-checked gone) |
| repo-004 miniflux | 1 (2026-09-06) | BUILD_ERROR → **DEPLOY-008** | Analysis READY with the overrides PATCHed; the release recorded no build context; CodeBuild built `packaging/docker/alpine/Dockerfile` with context `packaging/docker/alpine` and `make miniflux` found no Makefile. Cause: the analysis write drops `manifestOverrides` (fix PR #206, API only). No infrastructure created; cleanup clean. Rerun after deploy-api |
| repo-035 ihatemoney | 1 (2026-09-06) | **PASS** (true deployment success) | Flask; the injected database URL reached `SQLALCHEMY_DATABASE_URI` (v15 binding), migrations at boot, HTTPS ACTIVE, window clean, dependencies bound. DEPLOY-005 did not materialise for it |
| repo-003 kutt | 1 (2026-09-06) | CONTAINER_START_ERROR → **DEPLOY-009** | Build, template, Quick Create, enrolment PASS; the first task ran its migrations (10, over TLS — which withdraws DEPLOY-007's mechanism) and exited 1 on `Missing environment variables: JWT_SECRET`; the vendor secret is applied only by the post-install CONFIG_UPDATE, which never runs because INSTALL fails. Circuit breaker → ROLLBACK_FAILED; cleanup through the product |
| repo-001 umami | 4 (2026-09-06, PR #204 harness) | CONTAINER_START_ERROR (cause still open) | Same shape as attempt 3: five tasks exit 1; the install-wait snapshot AND the external watcher both saw **zero log events** from the App container — the process emits nothing before exiting. The template's awslogs configuration captured kutt's output the same day, so this is the container, not the pipeline. Next: a `--keep` attempt and a one-off ECS task with a command override (`node --version; node scripts/check-db.js`) in the kept environment, after the wave |
| repo-003 kutt | 2 (2026-09-06, PR #207 product) | ENV_BINDING_ERROR → **DEPLOY-010**, **DEPLOY-011** | Zero-task install worked (`paramDesiredCount=0`, `startAfterConfig`); CONFIG_UPDATE failed "no AppConfigSecret" (exact logical-id match, DEPLOY-010, PR #208); the auto-deploy started the unconfigured task, which crash-looped and the DEPLOY_RELEASE never settled (DEPLOY-011, PR #209); the harness's install wait timed out at 60 min, Disconnect 409, and the `aws login` session expired mid-cleanup. Operator: service scaled to 0 and the app stack deleted by hand, orphan target group removed, `--cleanup` closed the ledger |
| repo-003 kutt | 3 (2026-09-07, relay with #208/#209) | ENV_BINDING_ERROR → **DEPLOY-012** | CONFIG_UPDATE found the secret and was denied `secretsmanager:GetSecretValue` (the grant sat on the CloudFormation execution role, not the relay's — PR #210); the deploy then settled `CONTAINER_START_FAILED` in 12 min with "4 tasks of the new revision exited with code 1" (DEPLOY-011 verified) and Disconnect was accepted at once. Cleanup through the product |
| repo-007, repo-021, repo-016, repo-039 | — | not attempted — wave stopped | Systemic-bug rule: ghostfolio, directus and outline need vendor/generated secrets at boot (DEPLOY-009); memos would boot against SQLite until the post-install pass. The product owner chose the generic fix: PR #207 merged (main `b83e6f7`), API deployed (run 34048622229), application templates (Documenso preset, 17 parameters) and the bootstrap template (new relay) republished 2026-09-06 ~17:55Z. Resume: kutt `--repo repo-003 --force`, then `--resume --wave wave-1`, then docuseal and miniflux `--force` reruns |

Harness defects found by real AWS and fixed (all merged): the install wait
gave up during a stack rollback (#199); Disconnect was called against a
running INSTALL and the wave continued past a failed cleanup (#199); a
deleted NAT gateway the tagging API still listed counted as a leak (#201);
an interrupted attempt with a created release was not an unfinished ledger
(#201); the purge wait was 30 minutes for a ~95-minute purge and the
connector was deleted mid-sweep (#202).

Traps for the next operator: launch multi-hour runs detached (PowerShell
`Start-Process`; the Bash tool caps background commands at ten minutes);
Git Bash mangles `/aws/lambda/...` log-group names (use PowerShell for
those); a PowerShell process filter on the harness's path matches the
PowerShell process itself (filter on `Name -eq 'node.exe'` too); the
product's PURGE job of an interrupted attempt stays RUNNING once its relay
is gone — the cleanup's idle wait then runs its full 60 minutes.

Resume: `DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm benchmark:deploy --real-aws --resume --wave wave-1`
(the resume finishes any unfinished ledger first, skips gatus, and continues
from umami).
