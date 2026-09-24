# AWS E2E (real AWS, L4-L6)

The real-AWS layers (`strategy.md`'s L4-L6): a bootstrap-only smoke test, the
full-lifecycle version canary, and the scheduled production canary. All three
drive the deployed control plane and the test AWS account through the same
routes a vendor and a customer use — nothing here writes to the database or
to AWS directly on the product's behalf. See
[`strategy.md`](strategy.md#the-layers) for where these sit relative to the
simulated suite, and [`compatibility.md`](compatibility.md) for the separate
corpus-benchmark real-AWS layer (Stage B).

## L4 — fresh (bootstrap only)

`fresh` proves the bootstrap stack's real create/destroy path: stack
provisioning, IAM role creation, relay registration, resource tagging, and
destruction. It never installs an application — for that, use the version
canary's `profile`/`core` scenarios (L5), which reuse infrastructure per
profile and skip the 5+ minute bootstrap cycle.

Justified only after a change to
`packages/cdk/src/bootstrap/bootstrap-stack.ts`, `bin/bootstrap.ts`, or the
relay's registration/tagging behaviour. Not justified for copy, dashboard-only
changes, CSS, non-infrastructure API refactors, test-only changes, or
documentation — the simulated suite (`pnpm e2e`) covers those.

```bash
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:fresh
```

Preconditions: AWS credentials via the standard SDK v3 chain, the `aws` CLI
on `PATH`, `AWS_REGION` (defaults `us-east-1`). `--dry-run` prints the
resolved command without running it (works before the opt-in too, and makes
no AWS call).

Each run mints a sortable run id (`YYYYMMDD-HHMMSS-xxxx`), names its stack
`deployz-fresh-<runid>` (`DEPLOYZ_BOOTSTRAP_STACK_NAME`), and tags it
`DeployzTestMode=fresh`, `DeployzCanaryRun=<runId>`, `DeployzEnvironment=e2e`,
plus `DeployzCommit=<sha>` when resolvable — concurrent or un-torn-down runs
cannot collide with each other or a real customer's `deployz-bootstrap-…`
stack. A collision on the freshly minted name is refused, never treated as
recoverable. Teardown runs in a `try`/`finally`
(`CleanupRegistry`/`runWithTeardown`): an assertion failure mid-suite still
destroys the stack this run created. Only a killed process (no `finally`)
orphans a `deployz-fresh-<runid>` stack — destroy it by hand
(`cdk destroy --app "tsx bin/bootstrap.ts"` with `DEPLOYZ_BOOTSTRAP_STACK_NAME`
set, or the AWS Console).

Provisioning a real application stack (RDS + ElastiCache, 15-25 minutes) is
not part of `fresh`'s default run — the version canary's
`profile --profile redis` covers it through the product's own install path.

## L5 — AWS E2E (version canary)

The MVP release gate for version deployment, failed-release isolation,
rollback, recovery, persistence and cleanup. Runs against the **deployed
control plane** and the **test AWS account** (`151955775369`), through the
product's own routes.

```
canary (tsx, scripts/version-canary)          test AWS account
  sign-up, GitHub binding, application         bootstrap stack (relay Lambda)
  releases {version, gitSha=fixture tag}       ECR deployz-images
  install link → launched                      application stack:
  CreateStack (Quick Create template)             ECS service ← digest
                                                   ALB → fixture /version
  reads: CFN, ECS tasks, ECR, ALB, tags           RDS ← /canary/markers
```

### The fixture application

`packages/fixture` is the Deployz-controlled application every canary run
installs — deliberately close to nothing: `/health` answers 200 as soon as
the process is listening (the one exception is a release built with
`healthMode: broken`, which answers 500 on purpose), `/version` reports the
release identity baked into the image at build time, and `/canary/markers`
is a write-once database round trip the canary uses to prove persistence
across an update or a rollback.

`pnpm canary:fixture-repo` generates the public fixture repository
(`instashop-dev/deployz-canary-app`) from `packages/fixture` and pushes the
tag ladder a run needs: `v1`, `v2`, `v3-bad-health`, `v4`. Release *versions*
are minted per run (`v1-<run-id>`, since the shared ECR repository has
immutable tags); the fixture *tag* stays the artifact's identity.

`GET /canary/bindings` is what a `profile` run asks the running container
about its own environment, to prove the application stack actually injected
the env/secret bindings its manifest promised: `DATABASE_URL`,
`STORAGE_BUCKET`/`S3_BUCKET`/`AWS_S3_BUCKET`, `REDIS_URL` are checked
present/absent by a SHA-256 prefix (never the value itself), and when a
Redis binding is present the endpoint also does a raw-TCP `PING` and reports
whether it got `PONG`.

**Known trap:** `/canary/bindings` is new on this branch. The published
fixture repository (`instashop-dev/deployz-canary-app`) still carries
whatever image `pnpm canary:fixture-repo` last generated, which may predate
this endpoint — run `pnpm canary:fixture-repo` again before the next canary
so the fixture image actually answers `/canary/bindings` instead of 404ing.

**Fixture-application policy.** The canary never modifies the
production-published templates: it publishes its own application template
under `application/canary-<run-id>/` in the template bucket, pinned to the
run's v1 image, and hands it to the bootstrap stack through the
`ApplicationTemplateUrl` parameter (skipped entirely in `--production` mode
— see L6 below). Releases are built **just in time**: INSTALL success
auto-deploys the newest READY release, so v2/v3/v4 are only built once the
`core` ladder actually reaches them, not up front.

### Fixture A and Fixture B

- **Fixture A — the stateless profile** (`profile --profile stateless`):
  install, deploy, verify, teardown, no database. The fastest full-lifecycle
  proof; used for the production canary (L6) and as the default escalation
  for most relay/CDK changes.
- **Fixture B — the `core` ladder** (`pnpm e2e:canary:versions core`): the
  full release/rollback/failed-release/recovery/persistence/cleanup
  lifecycle described below, under the legacy PostgreSQL+Redis shape.
- **Other profiles** — `profile --profile pg` (PostgreSQL only) and
  `profile --profile redis` (Redis only) each certify one infrastructure
  shape: install to HEALTHY with the plan-vs-inventory gate, default HTTPS
  ACTIVE, bindings, then full teardown with its retained-state checks. No
  markers, no update/rollback ladder — `core` already proves that logic
  once; `profile` proves the product provisions and tears down that shape.

### Commands

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
authenticated (fixture tag resolution), `pnpm build` done, and the bootstrap
template published from a commit that includes the relay under test (see
Troubleshooting below).

| Flag | Effect |
| --- | --- |
| `--keep` | Leave the environment in place for investigation; run `cleanup --run-id` afterwards. |
| `--existing-image=<digest>` (env `DEPLOYZ_E2E_EXISTING_IMAGE_DIGEST`) | Skip CodeBuild/GitHub-source rebuilds and reuse the supplied digest (`sha256:[0-9a-f]{64}`) for every release version — v1, v2, v3 and v4 all share it, so version verification relies on release/deployment records, not image changes. Use during deployment-engine iteration when the image is already published and the ~20-minute build wait is unnecessary; the default path (no flag) builds each release through CodeBuild and is required for full build-pipeline validation. |
| `--reuse-stack` | Skip bootstrap stack creation, application stack provisioning, and final infrastructure teardown; reuse a standing stack tagged `DeployzPersistent=true` and `DeployzTestMode=canary` (name defaults to `deployz-app`, override with `DEPLOYZ_E2E_CANARY_STACK_NAME`). Per-run resources (customer, deployment, releases) are still created and cleaned; infrastructure is left standing. Combine with `--keep` to leave both standing for the next reuse-stack run. Do not use when testing bootstrap or teardown logic itself. |
| `--production` | `profile` only — see L6 below. |

### The `core` scenario

```
preflight → vendor + application → build v1 → publish canary template
→ install → HEALTHY → v1 serving → default HTTPS ACTIVE → bindings present
→ seed CANARY_DATA → build v2 → deploy v2 → data + infra unchanged
→ rollback to v1 → data + infra unchanged
→ deploy v2 → build v3-bad-health → deploy v3 FAILS, v2 keeps serving
→ re-deploy of the running v2 mutates nothing
→ rollback to v1 → build v4 → deploy v4 → history keeps the failed v3
→ Disconnect → Purge → leftovers → leak audit
```

Each deploy/rollback step verifies four layers: Deployz (`state`,
`currentReleaseId`, job state), the job/relay (terminal state, payload
digest), AWS (ECS running digest, ECR digest, ALB target health, stack
status) and the live app (`/version`, `/health`, markers). `resilience` adds
concurrent-request handling, a `409 DEPLOYMENT_BUSY` check, and a two-poll
EventBridge-schedule outage the job must survive without being marked
FAILED.

### Teardown pacing

Disconnect and Purge run inside the customer account, on the relay's
5-minute EventBridge schedule, and Purge sweeps one orphan kind per poll —
most of a teardown's wall clock is waiting for the next tick. Teardown steps
therefore invoke the relay once between polls (the same handler the schedule
invokes, synchronously, so nudges cannot overlap). The deploy/rollback
ladder itself is never nudged, so the canary keeps proving a scheduled poll
delivers release work.

### The MVP release gate

The MVP gate is **three consecutive `core` passes from fresh transient
infrastructure** (no `--reuse-stack`, no `--keep`). Any failure fixes the
root cause and restarts the count from zero — a flaky pass does not count
toward the three.

## L6 — production canary

The same L5 harness, run as `profile --profile stateless --production`
(`DEPLOYZ_CANARY_PRODUCTION=1`) against the deployed control plane. It
answers one question: **can production Deployz deploy right now?**

- **No template override.** `--production` skips `publishCanaryTemplate` and
  the `ApplicationTemplateUrl` override — the bootstrap stack installs with
  whatever the production-published template already is, exactly what a real
  customer's Quick Create uses.
- **HTTPS ACTIVE asserted** and **bindings asserted** the same way a branch
  run does.
- **Control-plane health recorded**: preflight writes what `GET /health` and
  `GET /health/ready` answered into `run.json`'s `controlPlaneHealth` — the
  closest thing to a deployed control-plane identifier those routes expose.

### When it runs

On demand (`workflow_dispatch` on `AWS version canary`,
`.github/workflows/aws-canary.yml`, scenario `profile`, profile `stateless`,
`production` checked). A weekly `schedule` trigger
(`profile --profile stateless --production`, Monday 06:00 UTC) is in the
workflow file but **commented out** — enable it only after three consecutive
green manual `profile --profile stateless --production` runs.

### On failure

- **Automatic cleanup** (`cleanup --run-id`) always runs when the canary
  step failed or was cancelled before its own teardown ran. There is no
  option to keep the environment: the vendor credentials never leave the
  runner, so a kept environment could not be cleaned through the product
  later. The failure diagnostics in the evidence replace it.
- **The leak audit always runs**, even on a clean pass and after a cleanup
  that could not finish.
- **One GitHub issue**, titled "Production canary failed", is created on the
  scheduled run's first failure and commented on for every later failure —
  never one issue per run.

## Safety

- **Real-AWS opt-in.** Every harness — the version canary, `fresh`, and
  `customer-reset` — refuses before touching AWS or the control plane unless
  `DEPLOYZ_E2E_ALLOW_REAL_AWS=1` is set. Never set it merely to get past a
  refusal you don't understand.
- **Account guard.** Every harness confirms `sts get-caller-identity`
  matches the expected test account (`DEPLOYZ_CANARY_EXPECTED_ACCOUNT`,
  default `151955775369`) before creating anything.
- **Tags and run ids.** Every resource a run creates carries
  `DeployzCanary=true`, `DeployzCanaryRun=<run-id>`, `DeployzTestMode=canary`
  (or `fresh`), `DeployzEnvironment=e2e`. Every deletion is keyed on an
  identifier the run recorded in its own evidence at creation time — there is
  no pattern-based or account-wide cleanup path inside the canary itself
  (that is what `customer-reset` is for; see Cleanup below).
- **Concurrency.** The GitHub Actions workflow runs one canary at a time
  (`concurrency: group: aws-version-canary`) — two installs in the same
  account would share connector-stack exports and race the leak audit.
- **Cost per run, and what a leak costs.** A `core`/`resilience` run
  provisions a full application stack (VPC, NAT gateway, ALB, ECS Fargate
  service, an RDS instance and, for the `redis` profile, an ElastiCache
  replication group) for the run's duration, plus one CodeBuild image build
  per release unless `--existing-image` is used — in practice 60-90 minutes
  end to end; the GitHub Actions job budgets 180 minutes total (120 for the
  canary step itself, the remaining 60 reserved so cleanup and the leak
  audit can still finish after a timeout). A `profile` run (including the
  scheduled production canary) provisions one install plus its retained-RDS
  teardown, budgeted 240 minutes total (180 for the canary step). `fresh`
  provisions only the bootstrap stack (a Lambda, its IAM role, a Secrets
  Manager secret, an EventBridge schedule) — negligible cost, a few minutes
  of runtime. A leak (a run whose teardown never completed) keeps billing
  for every hour the NAT gateway, ALB, RDS instance or ElastiCache node
  stays up — this is why the leak audit always runs and why `customer-reset`
  exists as the operator-level backstop.
- **Production-side effects.** A production canary run is a real customer
  install against the real control plane: it creates a throwaway vendor
  account and organization, a real `d-<deployment-id>.deployz.dev` Cloudflare
  DNS record for the run's lifetime, and `event_logs` rows like any other
  deployment. Cleanup removes the AWS resources and the DNS record; the
  vendor account and its `event_logs` history are not deleted (they are
  ordinary product data, not a leak).

## Evidence

`canary-results/<runId>/run.json` (identities, releases, jobs, steps — never
the vendor password), `steps/NN-<name>.json` (per-step facts and error),
`summary.md` (a PASS/FAIL table). A failed run keeps its environment for
inspection; `cleanup --run-id` tears it down from the recorded ids.

The vendor password lives only in `canary-results/<run-id>/credentials.json`
(`{email, password}`), written once at sign-up with file mode `0600`. It is
never written to `run.json`, and the GitHub Actions evidence upload excludes
it (`!canary-results/**/credentials.json`) — it never leaves the runner.
`cleanup --run-id` reads it back to sign in again; deleting a run's evidence
directory deletes the credentials with it.

### Diagnostics captured on failure

A failing install/deploy/destroy step attaches a best-effort diagnostics
snapshot to its own step file (`details.diagnostics`), read-only through the
same AWS/control-plane seams the rest of the canary uses: the CloudFormation
stack status and `*_FAILED` events for the bootstrap and application stacks,
the deployment's relay/health/cleanup state and the control plane's own
`/diagnostics` projection, and — when a release failed — its build failure
detail (`GET .../releases/:id/build-failure`). A capture failure is recorded
alongside (`diagnosticsError`) rather than masking the original error; each
piece of diagnostics is independently best-effort.

## Cleanup and the leak audit

Normal teardown runs the product's own Disconnect and Purge first (what a
customer gets), then the canary-only leftovers a customer would remove by
hand: the bootstrap stack (only once the application stack is gone — its
execution role lives in the bootstrap stack), the relay's Lambda log groups,
the run's ECR tags, the installation's task definitions, the SSM pending
marker, the canary template objects.

```bash
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary:versions cleanup --run-id <id>   # Disconnect/Purge/leftovers for one run
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary:versions audit --run-id <id>     # read-only leak audit for one run
```

The leak audit is an independent look at the account, keyed on the run's
recorded ids (installation tag, run tag, stack names, RDS, ALB, S3, secrets,
log groups, SSM, ACM, ECR) — it fails on anything disposable still found.
INACTIVE ECS clusters/services/task definitions that the tagging API keeps
listing after deletion are the one documented exception (they cost nothing).

**Known gap:** the leak audit does not yet check Cloudflare for a leftover
`d-<deployment-id>.deployz.dev` DNS record. Normal Disconnect/Purge removes
it through the product; a run that leaked before Disconnect completed can
leave the record behind with no automated check to catch it — verify by
hand (`dig d-<deployment-id>.deployz.dev` or the Cloudflare dashboard) after
an abnormal cleanup.

`scripts/customer-reset` (`pnpm admin:customer-cleanup`) is the operator's
bulk tool, not a canary command: `inventory` builds a manifest of every
customer installation, `execute --confirm FULL-CUSTOMER-RESET` wipes every
customer deployment's AWS resources and DB rows while preserving
control-plane data, and `verify` re-scans AWS and the DB to confirm nothing
customer-owned survived. Use it when an id-keyed `cleanup --run-id` cannot
reach a resource, or to reset the whole test account between campaigns —
never as a substitute for a run's own cleanup.

`packages/cdk/scripts/audit-deployment.mjs`
(`pnpm --filter @deployz/cdk audit:deployment --installation <uuid>`) is a
different, narrower tool: it asks AWS directly whether one installation
actually contains the application the control plane claims is deployed
(the same verification the relay itself would run), independent of any
canary run — useful when the control plane and the account seem to disagree.

## Escalation rules

These match the strings `scripts/test-affected.mjs` prints as (never runs)
AWS escalations, and the policy in
[`strategy.md`](strategy.md#the-escalation-policy-for-coding-agents). The
first rule below is **required**, learned from production outages that were
invisible to unit tests, CI and the simulator — not a judgment call:

- **Required.** A change to the relay's install/deploy/rollback/destroy/purge
  executors (`packages/relay/src`), the bootstrap template
  (`packages/cdk/src/bootstrap`), the application template
  (`packages/cdk/src/application`), or the relay's enrollment path needs a
  real-AWS run before the template is republished: `fresh` for a
  bootstrap-only change; the stateless `profile` otherwise; `core` for a
  release, rollback, deploy, destroy or purge change.
- **A `packages/relay/src` change** (non-test): `scripts/test-affected.mjs`
  prints `core` when the file is one of the relay's AWS-SDK-interface
  modules (`RELAY_AWS_INTERFACE`); the stateless `profile` otherwise —
  matching the rule above.
- **A `packages/cdk` customer-side change** (bootstrap, application stack,
  quick-create, the relay Lambda handler; non-test, non-`scripts/`): the
  stateless `profile`, plus `fresh` in addition when the change is under
  `packages/cdk/src/bootstrap/`, `bin/bootstrap.ts`, or
  `packages/cdk/artifacts/bootstrap-*`.
- **A `packages/fixture` change** (non-test):
  `pnpm canary:fixture-repo && DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary:versions profile --profile stateless`
  — the fixture repository must be regenerated before a canary can use it.
- **Escalate to `fresh` only when**: explicitly requested; fundamental
  provisioning behaviour changed; validating a release; validating
  cleanup/destruction; or the version canary cannot provide adequate
  confidence on its own.
- Judgment is still needed only for a change `scripts/test-affected.mjs`'s
  file-path rules do not cover — never to skip an escalation the required
  rule above already covers.

## Troubleshooting

- **Preflight refuses the account, or `aws login` expiry** — you are not
  authenticated to the test account, or the session expired mid-run
  (`aws login` as its root/admin user re-authenticates; re-run afterwards).
- **Install link has no Quick Create URL** — the bootstrap template is not
  published for this control plane (`BOOTSTRAP_TEMPLATE_URL` unset).
- **`CreateStack` refuses parameters** — the relay must include the fix for
  undeclared parameters being dropped; republish the bootstrap template.
- **Release build FAILED** — the release's `failureReason` names the
  CodeBuild phase; the fixture builds from its own directory.
- **`live /version answered <blank>, expected vN` while every other layer is
  green** — the probe could not read the app at all. The canary probes the
  URL the control plane advertises (`appUrl`), falling back to the ALB
  endpoint recorded at install. Before that fallback existed, the default
  HTTPS flow's 301 on the ALB's port-80 listener (which preserves the host
  header) redirected the raw ALB DNS name to itself over TLS, where the
  certificate covers only `d-<deployment>.deployz.dev`.
- **Failed-release step exceeds 50 minutes** — the ECS circuit breaker needs
  several task launches; check the deploy job's `reconcileCount` and the
  relay log group for repeated `UpdateService` calls (a known slow path, not
  a defect).
- **VPC quota is 5 per Region** — the control plane's own VPC plus one
  pre-existing orphan leave room for at most three concurrent installs in
  `us-east-1`; a `core`/`profile` run that hits `VpcLimitExceeded` needs an
  earlier run's infrastructure cleaned up first (`cleanup --run-id`, or
  `customer-reset inventory`/`execute` to find and remove it).
- **A retained RDS instance takes a while to purge.** Disconnect retains the
  database (deletion protection on); Purge turns protection off and deletes
  it, which can take tens of minutes end to end when default HTTPS is also
  active — do not treat a long-running Purge step as stuck before the
  teardown timeout is reached.
- **Republish the template before a canary of a bootstrap change.** A canary
  run installs from whatever the bootstrap template already publishes unless
  it synthesizes its own (branch-testing mode, the default for `core`/
  `resilience`/non-production `profile`); a `--production` run always uses
  whatever is already published. A merge that changed
  `packages/relay/src` or `packages/cdk/src/bootstrap`/`application` needs a
  fresh `publish:application`/`publish:bootstrap` before a `--production`
  canary can see it — see the deploy workflow's "Republish the bootstrap
  template" step in `.github/workflows/deploy-api.yml`.
