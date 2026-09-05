# Repository deployment audit (Stage B)

Stage B answers the question Stage A stops short of: **when a repository is
inside the Deployz MVP support boundary, can Deployz build it, deploy it into
a real customer AWS account, make it healthy over HTTPS, and remove it
cleanly afterwards?** It runs the same 100 pinned repositories through the
real production path — analysis, configuration, CodeBuild, ECR, the
published templates, the relay, CloudFormation, ECS, the ALB, RDS,
ElastiCache, S3, the heartbeat health gates, default HTTPS, Disconnect and
Purge — and records one result per repository.

Stage A ([`../repository-compatibility/README.md`](../repository-compatibility/README.md))
measures whether the analyser *understands* a repository. Stage B measures
whether the product *deploys* it. A repository that Stage A expects to be
unsupported must stop at the deployment gate and must never consume AWS
deployment resources.

> Naming note. The analyser hardening batch recorded as "Stage B" in
> `../repository-compatibility/implementation-notes.md` (analysis version
> 11) is analysis-side work. This directory is the deployment audit.

## Source of truth

- The corpus is [`../repository-compatibility/benchmark.yaml`](../repository-compatibility/benchmark.yaml).
  Stage B reads it, never copies it, and never changes a commit SHA.
- Every Stage B result carries the Stage A id (`repo-001` … `repo-100`,
  plus the `unseen2` set `repo-201` … `repo-220`), the pinned commit, the
  Stage A `expected.compatibility`, cohort, set and realism.
- Stage A's `expected.compatibility` decides what Stage B expects:
  `READY` / `NEEDS_CONFIGURATION` → *expected deployable*;
  `NOT_COMPATIBLE` → *expected unsupported* (`EXPECTED_UNSUPPORTED`).
- Stage B adds only what a vendor would add through the product: vendor
  configuration per repository (port, health path, Dockerfile path, start
  command, required values, binding names) in
  [`deploy-config.yaml`](deploy-config.yaml). Application source is never
  patched. Repository-specific data lives here, never in product code.

## The funnel

| Stage | What runs | Deployz component | Stops the funnel when |
| --- | --- | --- | --- |
| B1 Gate | `runApplicationAnalysis` → `normalizeDeploymentManifest` + `evaluateManifestReadiness` over the pinned snapshot, then the same gate on the deployed control plane at `POST /api/deployments` | `apps/api/src/analysis.ts`, `packages/analysis/src/manifest.ts`, `apps/api/src/preflight.ts` | expected unsupported and rejected (`EXPECTED_UNSUPPORTED`); expected deployable but rejected (`GATE_ERROR`, a false rejection) |
| B2 Configuration | vendor overrides (`PATCH /api/applications/:id`) and configuration values (`PUT /api/applications/:id/config`) from `deploy-config.yaml`; secret values are generated at run time and never committed | `apps/api/src/manifest.ts`, `apps/api/src/config.ts` | the gate still refuses (`CONFIG_ERROR`) |
| B3 Build | `POST /api/applications/:id/releases {version, gitSha: <pinned sha>}` → worker fetches the tarball at that SHA → CodeBuild → ECR digest | `packages/cdk/src/lambda/worker.ts`, `packages/cdk/src/pipeline/*` | release `FAILED` (`SOURCE_FETCH_ERROR`, `BUILD_ERROR`, `IMAGE_ERROR`) — no AWS infrastructure is created |
| B4 Runtime preflight | none on this machine (no Docker); the ECS task stop reasons and log tails of the real deployment supply the container-start evidence | — | — |
| B5 Deployment | customer + deployment (`isTestDeployment: true`), install link launched, bootstrap stack created exactly as Quick Create would, relay enrolls, INSTALL provisions the application stack, INSTALL success auto-deploys the newest READY release | `packages/relay/src/install.ts`, `deploy.ts`, `packages/cdk/src/application/*` | stack failure (`INFRA_ERROR`), task failure (`CONTAINER_START_ERROR`, `PORT_ERROR`, `ENV_BINDING_ERROR`, …), `TIMEOUT` |
| B6 Health | heartbeat gates (rollout COMPLETED, full counts, healthy targets, HTTP probe), `currentReleaseId` promoted, default HTTPS ACTIVE, independent probes of the health path and `/` over HTTP and HTTPS, a short observation window | `apps/api/src/deployment-status.ts`, `default-https.ts`, `packages/relay/src/ecs-health.ts`, `http-probe.ts` | `HEALTH_PATH_ERROR`, `TLS_ERROR`, `APPLICATION_ERROR`, `DATABASE_ERROR`, `REDIS_ERROR`, `MIGRATION_ERROR`, `STORAGE_ERROR` |
| Cleanup | Disconnect (DESTROY) → Purge → the customer-owned leftovers (bootstrap stack, relay log groups, SSM marker, run ECR tags, task definitions, Stage B template objects) → leak audit | `packages/relay/src/destroy.ts`, `purge.ts`, `scripts/version-canary/teardown.ts` | `DESTROY_ERROR`, `CLEANUP_LEAK` |

`CloudFormation CREATE_COMPLETE` is never a pass. A repository passes only
when it reaches a stable application-level healthy state through the
production path and its resources are gone afterwards.

## What is reused (anti-duplication map)

| Need | Existing component | Used how |
| --- | --- | --- |
| Corpus, selection, snapshot cache, in-process analysis session, gate | `scripts/repository-compatibility/{manifest,snapshot,analyse,normalize}.ts` | imported by the Stage B harness for B1; the `.cache/` snapshots make the gate audit offline and deterministic |
| Vendor-side control-plane client (sign-up, GitHub binding, applications, releases, customers, deployments, deploy/destroy/purge, events, infrastructure, diagnostics) | `scripts/version-canary/control-plane.ts` | imported as is |
| Customer-side AWS view through the `aws` CLI (stacks, ECS, ALB, ECR, tags, leak audit, id-keyed deletions) | `scripts/version-canary/aws.ts` | imported as is; Stage B adds only the reads it needs (task stop reasons, log tails, RDS/ElastiCache/S3 presence) |
| Quick Create URL parsing, install wait logic, release build wait | `scripts/version-canary/steps.ts` | patterns reused; Stage B has its own per-repository step functions because the assertions differ (any app, not the fixture) |
| Product teardown + leftovers + leak audit | `scripts/version-canary/teardown.ts` | imported as is |
| Real-AWS opt-in, account guard, tags | `scripts/e2e.mjs`, `scripts/version-canary/config.ts` | same guard (`DEPLOYZ_E2E_ALLOW_REAL_AWS=1`), same account refusal, Stage B tags added |
| Application template publishing | `packages/cdk/scripts/publish-application.mjs` | publishes one generic template per Deployz commit under a Stage B key prefix (see DEPLOY-001) |
| Operator-level customer wipe | `scripts/customer-reset` | never part of a run; documented only as the last-resort recovery for a leak the id-keyed cleanup cannot reach |

Nothing in Stage B re-implements analysis, the build, the relay, or the
templates. A local `docker build` is not a build; a handcrafted stack is not
a deployment.

## Execution model

- **Control plane**: the deployed production control plane
  (`https://api.deployz.dev`, `https://app.deployz.dev`), exactly as the
  version canary uses it. A product fix therefore reaches Stage B only after
  it is merged and `deploy-api.yml` / `deploy-web.yml` have run; the
  harness records the Deployz commit it drove.
- **Customer account**: the test account `151955775369`, region
  `us-east-1`. The harness refuses any other account
  (`DEPLOYZ_CANARY_EXPECTED_ACCOUNT`).
- **Vendor**: one throwaway Stage B vendor organization per run series,
  bound to the GitHub App installation `156387233` (`instashop-dev`).
- **Repository access**: Deployz reads repositories only through the
  vendor's GitHub App installation, which has selected-repository access
  and cannot see third-party repositories. Each repository that reaches
  the real-AWS phases is therefore a fork in `instashop-dev` whose default
  branch is pinned to the Stage A commit — a fork keeps commit SHAs, the
  release is created with `gitSha` = that SHA, and the tarball CodeBuild
  receives is the Stage A snapshot. The installation's repository access
  must include the forks (an operator setting; see
  `implementation-notes.md`). The result records the form used.
- **Per repository**: one application, one customer, one deployment
  (`isTestDeployment: true`), one bootstrap stack
  (`deployz-bootstrap-<app>-<8 chars>`), one application stack
  (`deployz-app-<installation prefix>`). Nothing is shared between
  repositories except the vendor organization and the published Stage B
  template.
- **Serial by default.** The account's VPC quota is 5 (control plane + one
  pre-existing orphan + at most three installs). Concurrency 2 is allowed
  only after Wave 1 proves isolation and cleanup.
- **Tags**: the bootstrap stack Stage B creates carries the version
  canary's test tags (`DeployzCanary=true`, `DeployzTestMode=canary`,
  `DeployzEnvironment=e2e`) with `DeployzCanaryRun=stage-b-<repo id>-<stamp>`,
  so the canary's tag-based audit applies unchanged and the run tag names
  the repository. Resources the product creates carry the product's own
  `deployz:installation` tag; the ledger records the installation id the
  moment the bootstrap stack outputs it.

## Safety and cleanup

1. Real AWS needs `DEPLOYZ_E2E_ALLOW_REAL_AWS=1` **and** `--real-aws`.
   Without both, the harness runs the gate audit only or a dry run.
2. Preflight refuses any AWS account other than the test account.
3. Every identifier is written to the attempt's ledger
   (`runs/evidence/<run id>/run.json` plus one file per step, gitignored;
   the committed result summarizes it) at creation time: organization,
   application, customer, deployment, install link, bootstrap stack,
   installation id, application stack, Lambda names, release versions,
   image digests, template objects. The vendor session and the published
   Stage B templates live in `runs/evidence/series.json`.
4. Cleanup runs in `finally`: Disconnect → Purge → leftovers → leak audit.
   An interrupted run is resumed from the ledger (`--resume`), which first
   finishes the cleanup of anything it finds still alive.
5. After each wave and at the end of Stage B, an account-level scan for the
   Stage B tags and the product's installation tags must return nothing
   disposable. INACTIVE ECS cluster/task-definition ARNs that the tagging
   API keeps listing are the documented exception.
6. Control-plane resources (`Deployz` stack, its RDS, `deployz-images`, the
   template buckets, `deployz-e2e-usw2-progress`) are never Stage B-owned
   and are never deleted.

Cost control follows from the funnel: unsupported repositories stop at the
gate, build failures stop before infrastructure, each deployment is
destroyed as soon as its verification window closes, and no environment
outlives its repository.

## Result model

One committed file per repository, `runs/<id>.json`:

```json
{
  "id": "repo-001",
  "repository": "owner/repo",
  "commit": "<pinned sha>",
  "deployzCommit": "<sha>",
  "stageAExpected": "READY",
  "expectedDeployable": true,
  "gate": { "status": "PASS", "verdict": "NEEDS_CONFIGURATION", "requiredKeys": ["APP_SECRET"] },
  "configuration": { "status": "PASS", "overrides": {}, "keys": ["APP_SECRET"] },
  "build": { "status": "PASS", "releaseId": "…", "imageDigest": "sha256:…", "durationMs": 0 },
  "deployment": { "status": "PASS", "installationId": "…", "stack": "deployz-app-…", "durationMs": 0 },
  "runtime": { "ecs": "HEALTHY", "alb": "HEALTHY", "https": "PASS", "healthPath": "/api/health", "observation": {} },
  "dependencies": { "postgres": "PASS", "redis": "NOT_REQUIRED", "storage": "NOT_REQUIRED", "migration": "PASS" },
  "cleanup": { "status": "PASS", "leaks": [] },
  "classification": "PASS",
  "failureStage": null,
  "rootCause": null,
  "findingIds": [],
  "timing": {},
  "evidence": {}
}
```

`classification` is `PASS`, `EXPECTED_UNSUPPORTED`, or the failure stage.
The failure-stage vocabulary and the root-cause vocabulary are fixed in
`scripts/repository-deployment/results.ts`; no other label is accepted:

```
GATE_ERROR CONFIG_ERROR SOURCE_FETCH_ERROR BUILD_ERROR IMAGE_ERROR INFRA_ERROR
CONTAINER_START_ERROR ENV_BINDING_ERROR DATABASE_ERROR REDIS_ERROR
MIGRATION_ERROR STORAGE_ERROR PORT_ERROR HEALTH_PATH_ERROR TLS_ERROR
APPLICATION_ERROR TIMEOUT DESTROY_ERROR CLEANUP_LEAK EXPECTED_UNSUPPORTED
REPOSITORY_BROKEN TEST_HARNESS_ERROR

DEPLOYZ_BUG ANALYSIS_BUG ANALYSIS_MISSING_SIGNAL MVP_CAPABILITY_GAP
CORRECTLY_UNSUPPORTED REPO_CONFIGURATION UPSTREAM_REPO_FAILURE
AWS_TRANSIENT_FAILURE TEST_HARNESS_FAILURE
```

`runs/summary.json` and `runs/summary.md` aggregate the corpus; a partial
run never overwrites them. A completed result is never overwritten by a
rerun unless `--force` is given; the frozen first-run results of the unseen
set are preserved under `runs/unseen-frozen/` and never overwritten.

Findings are systemic (`DEPLOY-001`, `DEPLOY-002`, …) and live in
[`findings.md`](findings.md); a result references the findings that explain
its failure. Evidence is summarized (job ids, build ids, stack status
reasons, task stop reasons, sanitized log tails, probe results), never raw
AWS logs and never secrets.

## Health-path precedence

1. the Stage B vendor configuration (`deploy-config.yaml`);
2. the analyser's manifest `health.path` (mode `explicit` or `root`);
3. an evidence-backed repository endpoint recorded in the Stage A notes;
4. `/` only as a fallback.

When the analyser's path is wrong and the configured one is right, the
result is `HEALTH_PATH_ERROR` with an `ANALYSIS_BUG` or
`ANALYSIS_MISSING_SIGNAL` root cause, never an AWS failure.

## Commands

```bash
pnpm build                                     # the harness imports the built packages
pnpm benchmark:deploy --gate                   # B1 (+ offline B2) over every repository, no AWS
pnpm benchmark:deploy --gate --repo repo-001   # one repository (repeat --repo for several)
pnpm benchmark:deploy --dry-run --wave wave-1  # print the plan, touch nothing
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm benchmark:deploy --real-aws --repo repo-001
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm benchmark:deploy --real-aws --wave wave-1
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm benchmark:deploy --real-aws --resume
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm benchmark:deploy --cleanup --repo repo-001
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm benchmark:deploy --audit
```

Selection: `--repo` (repeatable), `--set`, `--cohort`, `--wave` (membership
and order in `deploy-config.yaml`), `--finding DEPLOY-nnn` (every result
that references it). Modes are exclusive: `--gate`, `--dry-run`,
`--real-aws`, `--cleanup`, `--audit`; `--resume` may precede `--real-aws`.
Other flags: `--force` (replace a protected deployment result, the old one
goes to `runs/history/`), `--keep` (leave the environment for
investigation; run `--cleanup` later), `--concurrency 1|2`, `--template
pinned|generic|production` (see `implementation-notes.md`, "Stage B
decision on the template"; `pinned` until DEPLOY-001 is fixed), `--online`
(let the gate audit fetch snapshots that are not cached), `--cache`,
`--evidence-dir`, `--runs-dir`.

The gate audit is offline by default and needs the Stage A snapshot cache
(`../repository-compatibility/.cache/`, 100 repositories; copy it from a
machine that has run `pnpm benchmark:compat`). A real-AWS run needs the
`aws` CLI authenticated to the test account, `pnpm build`, and the vendor
GitHub App installation able to read the forks.

## How to

- **Rerun one repository after a product change**: wait for the merge to
  deploy (`gh run list --workflow deploy-api.yml`), republish the Stage B
  template if `packages/cdk/src/application` or `packages/relay/src`
  changed, then `--real-aws --repo <id> --force`. The previous result is
  kept under `runs/history/`.
- **Rerun the repositories a finding affects**: `--finding DEPLOY-007`
  selects every result that references it.
- **Add a repository**: add it to Stage A first (pin, expected facts, two
  inspections); Stage B needs only a `deploy-config.yaml` entry when vendor
  configuration is required.
- **Interpret Stage A vs Stage B**: Stage A says what the analyser
  concluded and whether that matched the repository; Stage B says what
  happened when the product acted on it. A Stage B `GATE_ERROR` on an
  expected-deployable repository is a Stage A false rejection seen from the
  product side; a `HEALTH_PATH_ERROR` is a Stage A `healthPath` mismatch
  that became a failed deployment.
- **Resume**: `--resume` reads every in-flight ledger, finishes cleanup for
  anything still alive, then continues the selected wave from the first
  repository without a result.
- **Clean a leak**: `--cleanup --repo <id>` reruns Disconnect/Purge/
  leftovers for the recorded ids; `--audit` scans the account for the Stage
  B tags and the recorded installation ids. Only if an id-keyed cleanup
  cannot reach a resource does the operator tool
  (`pnpm admin:customer-cleanup inventory`) come into play, by hand.

## Documents

| Document | Contents |
| --- | --- |
| [`implementation-notes.md`](implementation-notes.md) | Phase 0 architecture map, the production install path as it is, the reuse decisions, the phase plan and its status |
| [`findings.md`](findings.md) | The systemic findings registry (`DEPLOY-nnn`) with evidence, affected repositories, root cause and resolution |
| [`deploy-config.yaml`](deploy-config.yaml) | Per-repository vendor configuration and wave membership (Phase 1) |
| `runs/` | Per-repository results, summaries, the frozen unseen baseline |
| [`final-report.md`](final-report.md) | The Stage B decision report (Phase 8) |
