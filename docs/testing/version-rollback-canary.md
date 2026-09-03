# Version deployment + rollback canary (real AWS)

The release gate for Deployz's version deployment, failed-release
isolation, rollback, recovery, persistence and cleanup — run against the
**deployed control plane** and the **test AWS account**, through the same
routes a vendor and a customer use. Nothing in it writes to the database or
to AWS directly on the product's behalf; it only drives the product and then
looks at AWS independently.

See [`README.md`](README.md) for where this sits in the test hierarchy,
[`aws-canary.md`](aws-canary.md) for the read-only verify canary, and
[`aws-full-product-canary.md`](aws-full-product-canary.md) for the manual
full-product walk this automates the versioning half of.

## Product semantics this canary enforces

| Concept | Where it lives | Rule |
| --- | --- | --- |
| Release / artifact | `releases` row, `imageDigest` = `repository@sha256:…` | Immutable. The digest is the identity; tags are never used to deploy. |
| Deployment attempt | `deployment_jobs` row (`DEPLOY_RELEASE`, `ROLLBACK`) | Every deploy and every rollback is a new row; history is appended, never rewritten. |
| Currently serving release | `deployments.currentReleaseId` | Advances **only** when the relay heartbeat observes the new digest running, the rollout COMPLETED, all ALB targets healthy and the HTTP probe passing. It therefore also *is* the last successful release. |
| Latest attempted release | newest `DEPLOY_RELEASE`/`ROLLBACK` job | May be `FAILED` while the deployment stays live. |
| Failed release | job `FAILED` (`ECS_DEPLOYMENT_FAILED`, …) | Deployment returns to `UPDATE_AVAILABLE`/`HEALTHY`; pointer unchanged; the previous release keeps serving (ECS circuit breaker). Never `FAILED` for a day-2 operation. |
| Rollback | `POST /api/deployments/:id/rollback {releaseId}` | Deploys the *original* digest of a previously successful release via the same ECS executor. Runs no migrations. Customer data is not touched. |
| Persistent data | RDS / S3 in the application stack | Survives update, rollback and failed release. Disconnect retains it; Purge removes it. |

## Architecture

```
canary (tsx, scripts/version-canary)          test AWS account 151955775369
  │ sign-up, GitHub binding, application       ┌──────────────────────────────┐
  │ releases {version, gitSha=tag}             │ bootstrap stack (relay Lambda)│
  ├─▶ api.deployz.dev ──worker──▶ CodeBuild ──▶│ ECR deployz-images            │
  │   install link → launched                  │ application stack:            │
  ├─▶ CreateStack (Quick Create template,      │   ECS service ← digest        │
  │   ApplicationTemplateUrl = canary template)│   ALB → fixture /version      │
  │                                            │   RDS ← /canary/markers       │
  └─▶ reads: CFN, ECS tasks, ECR, ALB, tags    └──────────────────────────────┘
```

- **Fixture releases** come from `instashop-dev/deployz-canary-app`
  (generated from `packages/fixture` by `pnpm canary:fixture-repo`): tags
  `v1`, `v2`, `v3-bad-health`, `v4`. `/version` returns `{version, commit,
  healthMode}` baked into the image; `v3-bad-health` answers 500 on
  `/health` deterministically; `/canary/markers` is a write-once DB round
  trip; `v2` carries the migration command `node dist/migrate.js`.
- **Release versions are per run** (`v1-<run-id>`), because the shared ECR
  repository has immutable tags. The fixture tag stays the artifact identity.
- **The canary application template** is published under
  `application/canary-<run-id>/` pinned to the run's v1 image and handed to
  the bootstrap stack through its `ApplicationTemplateUrl` parameter. The
  production-published templates are never modified.
- **Releases are built just in time**: INSTALL success auto-deploys the
  newest READY release, so v2/v3/v4 are created only when the ladder reaches
  them.

## Safety

- Refuses without `DEPLOYZ_E2E_ALLOW_REAL_AWS=1` (both in `scripts/e2e.mjs`
  and in the script).
- Preflight hard-fails unless `sts get-caller-identity` returns the expected
  account (`DEPLOYZ_CANARY_EXPECTED_ACCOUNT`, default the test account).
- Every resource the canary itself creates carries `DeployzCanary=true`,
  `DeployzCanaryRun=<run-id>`, `DeployzTestMode=canary`,
  `DeployzEnvironment=e2e`.
- Every deletion is keyed on an identifier recorded in the run's `run.json`
  at creation time (stack names the control plane minted, the installation
  id from the bootstrap stack output, Lambda names from the stack's own
  resource list, the run's release versions). There is no pattern-based or
  account-wide cleanup path.

## How to run

```bash
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary:versions preflight
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary:versions core
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary:versions cleanup --run-id <id>
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary:versions audit --run-id <id>
```

On Windows PowerShell set `$env:DEPLOYZ_E2E_ALLOW_REAL_AWS = '1'` first.
Requirements: the `aws` CLI authenticated to the test account, `gh`
authenticated (fixture tag resolution), `pnpm build` done (the template
publisher imports the compiled CDK package), and the bootstrap template
published from a commit that includes the relay you want to test
(`aws-full-product-canary.md` §2).

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEPLOYZ_CANARY_API_URL` | `https://api.deployz.dev` | Control plane under test |
| `DEPLOYZ_CANARY_EXPECTED_ACCOUNT` | `151955775369` | Refuse any other account |
| `AWS_REGION` | `us-east-1` | Region of the customer deployment |
| `DEPLOYZ_CANARY_GITHUB_INSTALLATION_ID` | `156387233` | GitHub App installation bound to the canary org |
| `DEPLOYZ_CANARY_FIXTURE_REPO` | `instashop-dev/deployz-canary-app` | Fixture repository |
| `DEPLOYZ_CANARY_RESULTS_DIR` | `canary-results` | Evidence root (gitignored) |

`core --keep` leaves the environment in place for investigation; run
`cleanup --run-id` afterwards.

## The core scenario

```
preflight → vendor + application → build v1 → publish canary template
→ create deployment → launch → CreateStack (bootstrap) → relay enrolls
→ INSTALL → HEALTHY → v1 serving (auto-deploy + reconciliation)
→ seed CANARY_DATA_<run> → build v2 → deploy v2 → data + infra unchanged
→ rollback to v1 (digest chain) → data + infra unchanged
→ deploy v2 → build v3-bad-health → deploy v3 FAILS, v2 keeps serving
→ re-deploy of the running v2 is a fresh attempt that mutates nothing
→ rollback to v1 → build v4 → deploy v4
→ history keeps the failed v3 → Disconnect → Purge → connector stack,
  log groups, run images, task definitions, template objects → leak audit
```

Each deploy/rollback step verifies four layers: Deployz (`state`,
`currentReleaseId`, `previousReleaseId`, job state, `deploymentStatus`),
the job/relay (terminal state, payload digest), AWS (ECS running digest,
ECR digest for the version tag, ALB target health, stack status) and the
live app (`/version`, `/health`, markers) sampled several times.

## The resilience scenario

`pnpm e2e:canary:versions resilience` installs v1 the same way, then:

- sends two equivalent deploy requests for v2 at the same time and a retry
  after an "ambiguous" response — exactly one job may exist (202 once, 200
  replays after that);
- while that deploy is in flight, a rollback, a deploy of another release
  and a restart must all be refused `409 DEPLOYMENT_BUSY`, and ECS must show
  at most one rollout in progress;
- lets the v2 deploy settle and verifies it like the core scenario;
- requests v4, waits for the relay to claim it, then **disables the
  connector's EventBridge schedule** for two missed polls: the job must not
  be failed and the deployment must not be marked FAILED while the relay is
  merely silent; after the schedule is restored the same job resumes from
  its checkpoint and v4 becomes the serving release with no duplicate
  mutation;
- destroys, purges, removes leftovers and audits like the core scenario.

Browser refresh/close during a deploy needs no special step: every page
reads state from the API, which is what these assertions poll.

## Evidence

`canary-results/<run-id>/run.json` (identities, releases, jobs, steps),
`steps/NN-<name>.json` (per-step facts and error), `summary.md`
(PASS/FAIL table). A failed run keeps its environment; `cleanup --run-id`
tears it down from the recorded ids.

## Cleanup and leak audit

Normal Disconnect and Purge through the product first. Then the canary-only
leftovers a customer would remove by hand: the bootstrap stack (only after
the application stack is gone — its execution role lives in the bootstrap
stack), the Lambda log groups, the run's ECR tags, the installation's task
definitions, the SSM pending marker, the canary template objects. The audit
then lists everything still attributable to the run (installation tag, run
tag, stack names, RDS, ALB, S3, secrets, log groups, SSM, ACM, ECR) and
fails on anything disposable. INACTIVE ECS clusters/services/task
definitions that the tagging API keeps listing are ignored.

## Release gate and CI

The canary is never part of the PR check set: it creates a real customer
install, takes 60–90 minutes and costs money. Default CI keeps the fast
proofs of the same semantics — state transitions, release selection,
rollback logic, idempotency and health semantics live in
`apps/api/src/*.test.ts` (`deploy-contract`, `failure-semantics`,
`digest-reconciliation`), `packages/relay/src/*.test.ts`,
`packages/cdk/test/bootstrap-stack.test.ts` (IAM grants and the policy-size
quota) and the simulated scenario suite (`pnpm e2e:scenarios`).

Run the real canary on demand:

- **GitHub Actions**: `AWS version canary` (`.github/workflows/aws-canary.yml`,
  `workflow_dispatch`, scenario `preflight` / `core` / `resilience`). It needs
  `AWS_CANARY_ACCESS_KEY_ID` / `AWS_CANARY_SECRET_ACCESS_KEY` repository
  secrets for an identity with administrative access to the **test account
  only**; the harness refuses any other account. Evidence is uploaded as a
  workflow artifact. One run at a time (concurrency group).
- **Locally**: the commands above, with the `aws` CLI authenticated to the
  test account.

When to run it — before an MVP release, and for any change touching:
`packages/relay`, deployment orchestration (`apps/api/src/server.ts` job and
result routes, `jobs.ts`, `deployment-status.ts`), `packages/cdk`
(bootstrap/application stacks, CloudFormation templates), health
verification, release/version or rollback logic, polling/watchdog, or the
resource lifecycle (destroy/purge). Republish the templates from the commit
under test first (`aws-full-product-canary.md` §2).

The MVP gate is **three consecutive `core` passes from fresh transient
infrastructure**; any failure fixes the root cause and restarts the count.

## Troubleshooting

- **Preflight refuses the account** — you are not authenticated to the test
  account (`aws login` as its root/admin; the session expires).
- **Install link has no Quick Create URL** — the bootstrap template is not
  published for this control plane (`BOOTSTRAP_TEMPLATE_URL`).
- **`CreateStack` refuses parameters** — the relay must include #118
  (undeclared parameters are dropped); republish the bootstrap template.
- **Release build FAILED** — the release's `failureReason` names the
  CodeBuild phase; the fixture builds from its own directory.
- **Failed-release step exceeds 50 minutes** — the ECS circuit breaker needs
  several task launches; check the deploy job's `reconcileCount` and the
  relay log group for repeated `UpdateService` calls (hypothesis H1 in the
  canary report).
