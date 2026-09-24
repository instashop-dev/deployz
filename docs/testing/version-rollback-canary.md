# Version deployment + rollback canary (real AWS)

The release gate for Deployz's version deployment, failed-release
isolation, rollback, recovery, persistence and cleanup — run against the
**deployed control plane** and the **test AWS account**, through the same
routes a vendor and a customer use. Nothing in it writes to the database or
to AWS directly on the product's behalf; it only drives the product and then
looks at AWS independently.

See [`README.md`](README.md) for where this sits in the test hierarchy, and
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
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary:versions core [--keep] [--existing-image=<digest>] [--reuse-stack]
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary:versions resilience [--keep]
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary:versions profile --profile <pg|stateless|redis> [--run-id <id>] [--production]
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

### Core flags

| Flag | Env var | Effect |
| --- | --- | --- |
| `--keep` | — | Leave the environment in place for investigation; run `cleanup --run-id` afterwards. |
| `--existing-image=<digest>` | `DEPLOYZ_E2E_EXISTING_IMAGE_DIGEST` | Skip CodeBuild/GitHub-source rebuilds and use the supplied digest for every release version. The digest must match `sha256:[0-9a-f]{64}`. All versions (v1, v2, v3, v4) share the same digest — version verification relies on release and deployment records, not image changes. Use this flag during deployment-engine iteration when the image is already published and the ~20-minute build wait is unnecessary. The default path (no `--existing-image`) builds each release through CodeBuild and is required for full build-pipeline validation. |
| `--reuse-stack` | — | Skip bootstrap stack creation, application stack provisioning, and final infrastructure teardown. Reuse a standing stack that is already tagged `DeployzPersistent=true` and `DeployzTestMode=canary`. The stack name defaults to the legacy `deployz-app`; set `DEPLOYZ_E2E_CANARY_STACK_NAME` to the real `deployz-app-<installation-id-prefix>` name (no standing stack exists today, so this flag needs one to be provisioned first). The canary hard-fails if the stack does not exist or the tags are wrong. Per-run resources (customer, deployment, releases) are still created and cleaned. Infrastructure is left standing. Do not use this flag when testing bootstrap or teardown logic. |
| `--production` | `DEPLOYZ_CANARY_PRODUCTION=1` | `profile` scenario only. Skips publishing a template from the checkout and skips the `ApplicationTemplateUrl` override — the bootstrap stack installs with whatever template production already published, exactly what a customer's Quick Create uses. The default (unset) stays branch-testing mode: the checkout's own template, published and pinned to the run's v1 image. |

`--keep` and `--reuse-stack` can be combined: the environment stays running
for investigation, and the infrastructure stays standing for the next
reuse-stack run.

## The core scenario

```
preflight → vendor + application → build v1 → publish canary template
→ create deployment → launch → CreateStack (bootstrap) → relay enrolls
→ INSTALL → HEALTHY → v1 serving (auto-deploy + reconciliation)
→ default HTTPS reaches ACTIVE, health path answers over it
→ application bindings (DATABASE_URL/storage) present
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
live app (`/version`, `/health`, markers) sampled several times. Any of
these steps failing attaches a best-effort diagnostics snapshot to its own
evidence file — see [Evidence](#evidence).

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

## The profile scenario

`pnpm e2e:canary:versions profile --profile <pg|stateless|redis>` certifies
one infrastructure shape rather than the full version ladder: vendor +
application (under that profile's `databaseRequired`/`redisRequired`) →
build v1 → publish the canary template (skipped with `--production`, see
below) → install to HEALTHY with the plan-vs-inventory gate → default HTTPS
ACTIVE → application bindings (`DATABASE_URL` when the profile requires
postgres, storage always, a working `REDIS_URL`/`REDIS_HOST` PING when the
profile requires redis — skipped, not asserted absent, when it does not) →
full teardown with its retained-state checks. No markers, no update/rollback
ladder — `core` already proves that logic once; `profile` proves the product
provisions and tears down each certified shape.

`--production` (`DEPLOYZ_CANARY_PRODUCTION=1`) installs with whatever
template production has already published, instead of synthesizing one from
the checkout and overriding `ApplicationTemplateUrl` — the same path a real
customer's Quick Create takes. Preflight records what `GET /health` and
`GET /health/ready` answered into `run.json`'s `controlPlaneHealth`, the
closest thing to a deployed control-plane identifier those routes expose
today.

## Teardown pacing

Disconnect and Purge are executed by the relay inside the customer account,
on its 5-minute EventBridge schedule, and Purge sweeps one orphan kind per
poll — so most of a teardown's wall clock is waiting for the next tick. The
teardown steps therefore invoke the relay once between polls (the same
handler the schedule invokes, synchronously, so nudges cannot overlap).

The deploy and rollback ladder is deliberately NOT nudged: the canary keeps
proving that a scheduled poll delivers release work. Enrollment and the
resilience scenario's missed-poll test cover the schedule itself.

## Evidence

`canary-results/<run-id>/run.json` (identities, releases, jobs, steps —
never the vendor password), `steps/NN-<name>.json` (per-step facts and
error), `summary.md` (PASS/FAIL table). A failed run keeps its environment;
`cleanup --run-id` tears it down from the recorded ids.

The vendor password lives only in `canary-results/<run-id>/credentials.json`
(`{email, password}`), written once at sign-up. It is never written to
`run.json`, and the workflow's evidence upload excludes it — `cleanup
--run-id` reads it back to sign back in. Deleting a run's evidence directory
deletes the credentials with it; nothing else needs it.

A failing install/deploy/destroy step attaches a best-effort diagnostics
snapshot to its own step file under `details.diagnostics`: the CloudFormation
stack status and `*_FAILED` events for the bootstrap/application stacks, the
failed release's CodeBuild build info (whatever `GET
.../releases/:id/build-failure` exposes), the deployment's relay/health/
cleanup state and the control plane's own `/diagnostics` projection. Capture
failures are recorded alongside (`diagnosticsError`) rather than masking the
original failure.

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
  `workflow_dispatch`, scenario `preflight` / `core` / `resilience` /
  `profile`, with a `production` and a `keep_on_failure` checkbox). It needs
  `AWS_CANARY_ACCESS_KEY_ID` / `AWS_CANARY_SECRET_ACCESS_KEY` repository
  secrets for an identity with administrative access to the **test account
  only**; the harness refuses any other account. A run id is minted (or the
  supplied one reused) before the canary step runs, so cleanup and the leak
  audit can still find the run's evidence when the canary step itself fails
  or times out. On failure/cancellation the workflow runs `cleanup --run-id`
  automatically unless `keep_on_failure` is checked; the leak audit always
  runs last. Evidence is uploaded as a workflow artifact (never the
  `credentials.json` password file). One run at a time (concurrency group).
  A `schedule` trigger (weekly `profile --profile stateless --production`,
  filing one tracking issue titled "Production canary failed" on failure) is
  in the workflow file but commented out — enable it only after three
  consecutive green manual `profile --profile stateless --production` runs.
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
- **`live /version answered , expected vN` while every other layer is
  green** — the probe could not read the app at all. The canary probes the
  URL the control plane advertises (`appUrl`), falling back to the ALB
  endpoint recorded at install. Before that fallback existed, the default
  HTTPS flow's 301 on the ALB's port-80 listener (which preserves `#{host}`)
  redirected the raw ALB DNS name to itself over TLS, where the certificate
  covers only `d-<deployment>.deployz.dev`.
- **Failed-release step exceeds 50 minutes** — the ECS circuit breaker needs
  several task launches; check the deploy job's `reconcileCount` and the
  relay log group for repeated `UpdateService` calls (a known slow path,
  not a defect).
