# E2E testing architecture

See [`README.md`](README.md) for when to reach for this versus unit/integration
tests. See [`e2e-scenarios.md`](e2e-scenarios.md) for the scenario catalogue.

## The four modes

`DEPLOYZ_E2E_MODE` selects one of:

- **`simulated`** (default) — Playwright drives the real Fastify API and
  real Next.js dev server; a simulated customer AWS account answers the
  relay's CloudFormation/ECS/ELB calls. No AWS credentials used or required.
- **`canary`** — a real-AWS Vitest suite that read-only verifies a standing,
  persistent installation. See [`aws-canary.md`](aws-canary.md).
- **`fresh`** — a real-AWS Vitest suite that deploys and destroys a
  throwaway bootstrap stack. See [`aws-fresh.md`](aws-fresh.md).
- **`canary-versions`** — a real-AWS tsx script that drives the deployed
  control plane and a transient customer install through the full version
  deployment, rollback, failed-release isolation, and cleanup lifecycle.
  See [`version-rollback-canary.md`](version-rollback-canary.md).

`canary`, `fresh`, and `canary-versions` all refuse to run unless
`DEPLOYZ_E2E_ALLOW_REAL_AWS=1` is set — see
[Environment variables](#environment-variables) below.

## Mode responsibilities

Each mode has a single responsibility. Use the cheapest mode that proves the
change.

| Mode | Responsibility | AWS cost | Duration |
| --- | --- | --- | --- |
| `simulated` (`pnpm e2e`) | Proves the full relay/API/DB/UI pipeline against a simulated AWS account | None | Seconds |
| `simulated` (`pnpm e2e:scenarios`) | Regression suite for all scenario contracts | None | Minutes |
| `canary` (`pnpm e2e:canary`) | Read-only verification that the relay's real AWS SDK calls still work against a persistent installation | Negligible (reads only) | ~1 minute |
| `canary:versions` core (`pnpm e2e:canary:versions core`) | Version deployment, failed-release isolation, rollback, recovery, persistence, and cleanup through the deployed control plane | Real (transient ECS/ALB/RDS for the run) | 60–90 minutes |
| `canary:versions` core `--existing-image=<digest>` | Same as above, but skips CodeBuild rebuilds — all versions share one image digest; version verification relies on release/deployment records | Real (same, minus CodeBuild) | ~40 minutes |
| `canary:versions` core `--reuse-stack` | Same as default core, but reuses a standing stack tagged `DeployzPersistent=true` + `DeployzTestMode=canary`; skips bootstrap create and infrastructure teardown | Real (reuses existing stack) | ~40 minutes |
| `canary:versions` resilience (`pnpm e2e:canary:versions resilience`) | Duplicate/concurrent request handling and relay interruption resilience | Real | ~60 minutes |
| `fresh` (`pnpm e2e:fresh`) | Bootstrap stack create/destroy golden path against a real AWS account | Negligible (~5 min) | ~5 minutes |
| Stage B repository deployments | Full 100-repository production-path audit (CodeBuild, ECR, relay, CloudFormation, ECS, ALB, RDS/S3, HTTPS, Disconnect/Purge) | Real | Hours |
| Full-product canary | Manual end-to-end product walk against the deployed control plane for arbitrary applications | Real | Manual |

The runner (`scripts/e2e.mjs`) prints a per-mode duration summary at the end
of every run. The version canary (`scripts/version-canary/evidence.ts`) also
prints per-step durations in its evidence output.

### Fixture-app policy

- **`instashop-dev/deployz-canary-app`** is the canonical fast test
  application for routine canary and version-canary work. It is an external
  GitHub repository generated from `packages/fixture` by
  `pnpm canary:fixture-repo`.
- **Documenso and other real applications** are reserved for the Stage B
  repository-deployment audit and the manual full-product canary
  (`aws-full-product-canary.md`). They exercise compatibility and real-world
  build complexity that the fixture app deliberately avoids.

## Architecture

```
Browser (Playwright / Chromium)
   │
   ▼
Web (Next.js — apps/web)
   │  HTTP
   ▼
API (Fastify control plane — apps/api)
   │            ▲
   │ jobs        │ reads/writes
   ▼            │
Deployment engine (deployment_jobs, deployment-status.ts,          DB
step-timings.ts, stack-event-progress.ts)  ◀───────────────────────┘
   │  relay HTTP protocol
   │  (register → commands → progress/result → health)
   ▼
Infrastructure interface (packages/relay's own client seams —
CloudFormationReader, StackInstaller, StackEventsReader, StackDeleter,
EcsDeployClient, EcsServiceReader, TargetHealthReader, PendingStore, ...)
   │
   ├──▶ Simulated AWS   (e2e/simulation/simulated-account.ts — `pnpm e2e`)
   └──▶ AWS             (a real customer account — `pnpm e2e:canary` /
                          `pnpm e2e:fresh`, DEPLOYZ_E2E_ALLOW_REAL_AWS=1)
```

Everything above the infrastructure interface — API routes, the DB, stack-event
ingest, status derivation, step timings, resource-inventory persistence, both
UIs — is production code, unchanged between simulated and real-AWS runs.

## The simulation seam

Design decisions frozen on 2026-09-01, recorded here so they are not
re-litigated:

- **D1 — the seam is the relay's existing client interfaces.** The relay
  (`packages/relay`) is the only code that ever touches a customer's AWS
  account, and every relay module already defines a narrow client interface
  (`CloudFormationReader`, `EcsDeployClient`, `TargetHealthReader`, ...) with
  a `toX(sdkClient)` adapter kept separate from a `createRealX()`
  SDK-constructing wrapper. Simulated mode runs the **real relay code** —
  `pollOnce`, the real install/deploy/rollback/destroy executors, real
  `verifyInstallation`, real `provision-progress`, the real stack-events
  collector — in the Playwright test process, speaking the real relay HTTP
  protocol to the real local API. Only the AWS *client* objects are replaced
  by an in-memory `SimulatedCustomerAccount`
  (`e2e/simulation/simulated-account.ts`).
- **D2 — the simulator is test-only, not a product mode.** It lives entirely
  under `e2e/simulation/`. Nothing ships in any production bundle, and the
  API exposes **no scenario-control endpoint** — scenario selection happens
  only inside the Playwright test process, via a fixture. This makes
  "production cannot expose scenario controls" true by construction rather
  than by policy.
- **D3 — mode selection and the real-AWS guard.** `DEPLOYZ_E2E_MODE` is set
  by the cross-platform runner `scripts/e2e.mjs`; every real-AWS mode
  refuses to run without `DEPLOYZ_E2E_ALLOW_REAL_AWS=1`, before anything is
  spawned; simulated mode launches the API with a scrubbed environment so
  locally present AWS credentials cannot leak real behaviour into a default
  run.
- **D4 — scenario format.** Typed fixtures describe a CloudFormation event
  timeline with a real reveal offset (milliseconds, for test speed) and a
  virtual timestamp offset (minutes, for what `Timestamp` fields report), so
  ETA and step-timing logic sees realistic durations while tests stay fast;
  ECS/ELB/target-health answers are scenario-controlled too.
- **D5 — real-AWS modes wrap existing machinery.** Canary and fresh reuse
  `packages/cdk/test/*.live.test.ts` and the relay's own verification ladder
  behind the opt-in guard, unique test identifiers and tag-based isolation,
  rather than a parallel harness.
- **D6 — non-goals.** No record/replay, no LocalStack, no full AWS API
  emulation: the simulated account implements only the calls the relay
  makes, returning AWS-shaped structures.

## Scenario selection

- **Test-side**: `test.use({ deployzScenario: 'happy-path' })` inside a
  `test.describe` block (see any file under `e2e/scenario-*.spec.ts`) — an
  option fixture defined in `e2e/simulation/fixtures.ts`, defaulting to
  `happy-path`.
- **CLI-side**: `--scenario=<id>` on `pnpm e2e`, which the runner translates
  into a Playwright `--grep "@scenario:<id>\b"` filter against test titles
  (every scenario test's title carries an `@scenario:<id>` tag).

## CLI commands

All verified working as shown (dry-run output included where useful):

```bash
# Full simulated suite (default mode) — every e2e/*.spec.ts file.
pnpm e2e

# Only the tests tagged for one scenario.
pnpm e2e --scenario=happy-path

# Every @scenario-tagged test — the full simulated regression suite.
pnpm e2e:scenarios

# Real-AWS canary (read-only) — requires the opt-in.
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary

# Real-AWS fresh (create + destroy) — requires the opt-in.
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:fresh

# Real-AWS version canary (full product lifecycle) — requires the opt-in.
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary:versions core
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary:versions core --existing-image=sha256:abc...
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary:versions core --reuse-stack
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary:versions resilience
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary:versions preflight
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary:versions cleanup --run-id <id>
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary:versions audit --run-id <id>
```

On Windows PowerShell, set the env var first rather than inline:

```powershell
$env:DEPLOYZ_E2E_ALLOW_REAL_AWS = '1'
pnpm e2e:canary
```

Without the opt-in, `canary`, `fresh`, and `canary-versions` all refuse
immediately, before spawning anything:

```
Real AWS E2E is disabled.
Set DEPLOYZ_E2E_ALLOW_REAL_AWS=1
only when intentionally running AWS-backed E2E tests.
```

Every `pnpm e2e*` invocation also accepts `--dry-run`, which prints the
resolved command/env as JSON instead of running it — useful for confirming
what a command would do without executing it (and without needing the
real-AWS opt-in to *see* the refusal).

## Environment variables

| Variable | Values | Purpose |
| --- | --- | --- |
| `DEPLOYZ_E2E_MODE` | `simulated` (default) \| `canary` \| `fresh` \| `canary-versions` | Selects the mode. Set by `scripts/e2e.mjs`; also read directly by `playwright.config.ts` as a second guard layer if Playwright is invoked without the runner. |
| `DEPLOYZ_E2E_SCENARIO` | a scenario id | Set by the runner when `--scenario=<id>` is passed. Informational only — actual scenario selection is the Playwright `test.use({ deployzScenario })` fixture value / `--grep` filter, not this variable. |
| `DEPLOYZ_E2E_ALLOW_REAL_AWS` | `1` | Required opt-in for `canary`/`fresh`/`canary-versions`. Checked before anything is spawned, in both `scripts/e2e.mjs` and `playwright.config.ts`. |
| `DEPLOYZ_E2E_CANARY_INSTALLATION_ID` | a UUID | Overrides which standing installation the canary suite verifies (see `aws-canary.md`). |
| `DEPLOYZ_E2E_EXISTING_IMAGE_DIGEST` | `sha256:...` | Skips CodeBuild rebuilds in the version canary — all versions share this digest (see `version-rollback-canary.md`). |
| Scrub list (simulated mode only) | — | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE`, `AWS_DEFAULT_PROFILE`, `JOB_QUEUE_URL`, `EMAIL_FROM`, `AWS_SES_ACCESS_KEY_ID`, `AWS_SES_SECRET_ACCESS_KEY` — removed from the API's environment before it boots (`scripts/e2e-env.mjs`'s `scrubEnv`), so credentials or config present in a developer's shell can't leak real AWS/email behaviour into a default run. |
| `GITHUB_FIXTURE_MODE` | `true` | GitHub routes serve a fixture org/repo set instead of calling GitHub. Always set by `playwright.config.ts`'s `webServer` env, in every mode. |
| `AI_FIXTURE_MODE` | `true` | A canned AI gateway response set, for deterministic fix-instructions generation. Always set by `playwright.config.ts`. |
| `BUILD_FIXTURE_MODE` | `true` | A new release is marked built (READY, fixture digest) immediately instead of enqueuing `BUILD_RELEASE` (which no-ops locally anyway). Always set by `playwright.config.ts`. |
| `DOMAIN_FIXTURE_MODE` | `true` | DNS/HTTPS domain checks pass only for `*.deployz-fixture.test` hostnames, with no throttle. Always set by `playwright.config.ts`. |
| `TEAM_ADMIN_EMAILS` | `*@admin-e2e.deployz.test` | Team Admin env-grant allowlist (`docs/admin/team-admin.md`). Always set by `playwright.config.ts`'s API `webServer` env, so `e2e/admin.spec.ts` can mint an admin account by simply signing up with a matching email — no DB seeding needed. |
| `BILLING_FIXTURE_MODE` | `true` | Canned billing states for the billing UI scenarios. Always set by `playwright.config.ts`. |
| `DEPLOYZ_DEFAULT_HTTPS_FIXTURE` | `true` | Turns on the fixture default-HTTPS machine (fake Cloudflare and probe). Off by default; required for `e2e/scenario-default-https.spec.ts`, which skips without it. |
| `WEB_PORT`, `API_PORT` | port numbers | Override the default 3000/3001 so a run does not reuse another worktree's dev servers. |

## Team Admin coverage

`e2e/admin.spec.ts` covers the Team Admin console (`docs/admin/team-admin.md`):
authorization (a normal vendor is redirected away and the admin API rejects
them; a `*@admin-e2e.deployz.test` account reaches `/admin`), global search
into the vendor 360° page, View as Vendor (banner, read-only enforcement,
exit, and both audit events), diagnosing + retrying a failed install
seeded through the `cloudformation-rollback` simulated scenario, and the
included production deployment allowance (set 0 → 2 with a reason from the
vendor 360° page, the preview dialog, the refreshed detail, and the audit-log
entry; reconciliation is SKIPPED in simulated mode because there is no Paddle
client). It follows
the same house conventions as every other browser spec (`uniqueEmail`,
`fillControlled`, data-testid assertions) — see `e2e/organization.spec.ts`.

## Local execution

- **Build first.** The API imports `@deployz/db` (and other workspace
  packages) from compiled `dist/`, so run `pnpm build` before `pnpm e2e` the
  first time, or after editing a package the API depends on.
- **Dev-server reuse.** `playwright.config.ts` sets
  `reuseExistingServer: !process.env.CI` — locally, if the API/web dev
  servers are already running on ports 3001/3000, Playwright reuses them
  instead of booting new ones; in CI it always boots fresh.
- **Never run `pnpm build` while a dev server is running.** Building while
  `next dev`/`tsx --watch` is active can corrupt `apps/web/.next`. Check that
  nothing is listening on 3000/3001 before building if you need a clean
  build.
- **Rebuild after editing the relay.** The relay harness imports
  `@deployz/relay` from its compiled `dist/`, so a relay source edit is not
  exercised by `pnpm e2e` until `pnpm build` has run.
- **Isolate ports when several worktrees are active.** With
  `reuseExistingServer` on, a dev server left running by another worktree
  on 3000/3001 would be reused and the specs would test the wrong code. Set
  `WEB_PORT` and `API_PORT` to unused ports for the run.
- **Default-HTTPS scenarios need the fixture machine on.**
  `e2e/scenario-default-https.spec.ts` skips unless
  `DEPLOYZ_DEFAULT_HTTPS_FIXTURE=true` is set for the API under test.

## CI behaviour

- **`.github/workflows/ci.yml`** (runs on PRs to `main` and pushes to
  `main`): a `Plan tests` job runs `scripts/test-affected.mjs` against the
  PR base and picks a risk level — minimal (docs-only), targeted (affected
  packages and specs), targeted-web (web unit plus the full non-visual
  Playwright PR suite), or critical (the full pre-merge validation). The
  `Test and build` and `Simulated E2E` jobs run the selected subset, and a
  final `PR Gate` job aggregates them: it fails when planning fails or a
  required job fails, and accepts intentionally skipped jobs. Every push to
  `main` and every critical pull request runs the core specs
  (`e2e-modes`, `admin`, `deployment-detail`), the full scenario suite and
  the default-HTTPS scenarios; the other Playwright specs run only when the
  plan selects them or through the manual `e2e.yml` workflow. The simulated
  job sets fake sentinel
  `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION` values — a live
  proof that simulated mode's env-scrubbing strips them from the API under
  test, without real credentials ever entering PR CI. The mode-guard, Team
  Admin, and deployment-detail specs share one Playwright invocation; the
  default-HTTPS suite stays separate because it boots its own server with
  the fixture flag on. Uploads `test-results/` on failure. The
  visual-regression suite is excluded (its committed snapshots are
  Windows-generated).
- **`.github/workflows/e2e.yml`** (`workflow_dispatch` only, not part of the
  PR check set): the full Playwright suite except `visual.spec.ts`.
- **`.github/workflows/aws-persistent-canary.yml`** (`workflow_dispatch` only):
  runs `pnpm e2e:canary` with the canary AWS credentials against the standing
  persistent installation. Not part of the PR check set.
- **`.github/workflows/aws-canary.yml`** (`workflow_dispatch` only): runs
  the version canary (`pnpm e2e:canary:versions <scenario>`) against the
  deployed control plane and the test account; 60–90 minutes, costs money,
  one at a time. See `version-rollback-canary.md`.
- **No CI job runs `fresh`.** It remains a manual/local escalation — see
  `aws-fresh.md`. The deploy workflows do not wait for any of these.

## Debugging failures

- **Traces and artifacts**: Playwright writes to `test-results/` on failure
  (screenshots, traces, an `error-context.md` per failed test); CI uploads
  this directory as the `e2e-simulated-results` artifact.
- **Scenario/deployment ids in the output**: the real relay code logs
  structured JSON events to stdout as it runs — `relay:command-executed`,
  `relay:stack-events-collected`, `relay:command-verified` — each carrying
  the `deploymentId`, `commandId`, and `stackName` involved, which is enough
  to correlate a failing assertion with the exact install it came from.
- **Server logs**: Playwright inherits the API/web dev servers' stdio
  (`[WebServer]`-prefixed lines in the same terminal), so application-level
  errors (e.g. a missing env var, an unhandled route error) show up inline
  with the test output.
- **A lone timeout during a full local run — in `e2e/scenario-ui.spec.ts`
  or in another spec's browser sign-up step — is usually load, not a
  regression.** Browser tests compete with the rest of the suite for the dev
  server's route compilation and CPU (the scenario-ui file runs serially and
  uses widened timeouts for exactly this reason). Before chasing it, rerun
  the failing spec in isolation — `pnpm e2e e2e/<file>.spec.ts` or
  `pnpm e2e --scenario=<id>` — and treat it as real only if it fails there
  too.

## Test-data cleanup

- **Per-test orgs.** Every scenario test signs up a fresh vendor account
  (`crypto.randomUUID().slice(0, 8)`-suffixed email) and creates its own
  application/customer/deployment — there are no shared fixture users, and
  nothing needs cleaning up between runs.
- **Local dev DB.** Without `DATABASE_URL` set, the API falls back to a
  file-backed PGlite store at `packages/db/.pgdata` (gitignored). Repeated
  local `pnpm e2e` runs accumulate test orgs/deployments there; delete the
  directory to start from a clean database.
