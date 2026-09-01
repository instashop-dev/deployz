# E2E testing architecture

See [`README.md`](README.md) for when to reach for this versus unit/integration
tests. See [`e2e-scenarios.md`](e2e-scenarios.md) for the scenario catalogue.

## The three modes

`DEPLOYZ_E2E_MODE` selects one of:

- **`simulated`** (default) — Playwright drives the real Fastify API and
  real Next.js dev server; a simulated customer AWS account answers the
  relay's CloudFormation/ECS/ELB calls. No AWS credentials used or required.
- **`canary`** — a real-AWS Vitest suite that read-only verifies a standing,
  persistent installation. See [`aws-canary.md`](aws-canary.md).
- **`fresh`** — a real-AWS Vitest suite that deploys and destroys a
  throwaway bootstrap stack. See [`aws-fresh.md`](aws-fresh.md).

`canary` and `fresh` both refuse to run unless `DEPLOYZ_E2E_ALLOW_REAL_AWS=1`
is set — see [Environment variables](#environment-variables) below.

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

Full rationale: [`discovery/phase1-design-decisions.md`](discovery/phase1-design-decisions.md)
(D1/D2). Summary:

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
```

On Windows PowerShell, set the env var first rather than inline:

```powershell
$env:DEPLOYZ_E2E_ALLOW_REAL_AWS = '1'
pnpm e2e:canary
```

Without the opt-in, `canary`/`fresh` refuse immediately, before spawning
anything:

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
| `DEPLOYZ_E2E_MODE` | `simulated` (default) \| `canary` \| `fresh` | Selects the mode. Set by `scripts/e2e.mjs`; also read directly by `playwright.config.ts` as a second guard layer if Playwright is invoked without the runner. |
| `DEPLOYZ_E2E_SCENARIO` | a scenario id | Set by the runner when `--scenario=<id>` is passed. Informational only — actual scenario selection is the Playwright `test.use({ deployzScenario })` fixture value / `--grep` filter, not this variable. |
| `DEPLOYZ_E2E_ALLOW_REAL_AWS` | `1` | Required opt-in for `canary`/`fresh`. Checked before anything is spawned, in both `scripts/e2e.mjs` and `playwright.config.ts`. |
| `DEPLOYZ_E2E_CANARY_INSTALLATION_ID` | a UUID | Overrides which standing installation the canary suite verifies (see `aws-canary.md`). |
| Scrub list (simulated mode only) | — | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE`, `AWS_DEFAULT_PROFILE`, `JOB_QUEUE_URL`, `EMAIL_FROM`, `AWS_SES_ACCESS_KEY_ID`, `AWS_SES_SECRET_ACCESS_KEY` — removed from the API's environment before it boots (`scripts/e2e-env.mjs`'s `scrubEnv`), so credentials or config present in a developer's shell can't leak real AWS/email behaviour into a default run. |
| `GITHUB_FIXTURE_MODE` | `true` | GitHub routes serve a fixture org/repo set instead of calling GitHub. Always set by `playwright.config.ts`'s `webServer` env, in every mode. |
| `AI_FIXTURE_MODE` | `true` | A canned AI gateway response set, for deterministic fix-instructions generation. Always set by `playwright.config.ts`. |
| `BUILD_FIXTURE_MODE` | `true` | A new release is marked built (READY, fixture digest) immediately instead of enqueuing `BUILD_RELEASE` (which no-ops locally anyway). Always set by `playwright.config.ts`. |
| `DOMAIN_FIXTURE_MODE` | `true` | DNS/HTTPS domain checks pass only for `*.deployz-fixture.test` hostnames, with no throttle. Always set by `playwright.config.ts`. |

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

## CI behaviour

- **`.github/workflows/ci.yml`, job `e2e-simulated`** (runs on every push and
  PR): installs Playwright's Chromium, then runs the mode-guard tests
  (`node scripts/e2e.mjs e2e/e2e-modes.spec.ts`) followed by the full
  simulated scenario suite (`node scripts/e2e.mjs --scenarios`). The workflow
  sets real-looking `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION`
  at the workflow level — this doubles as a live proof that simulated mode's
  env-scrubbing actually strips them from the API under test. Uploads
  `test-results/` on failure. The visual-regression suite is excluded (its
  committed snapshots are Windows-generated).
- **`.github/workflows/e2e.yml`** (`workflow_dispatch` only, not part of the
  PR check set): the full Playwright suite except `visual.spec.ts`.
- **No CI job runs `canary` or `fresh`.** Real-AWS E2E remains a manual/local
  escalation in Phase 1 — see `aws-canary.md`/`aws-fresh.md`.

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

## Test-data cleanup

- **Per-test orgs.** Every scenario test signs up a fresh vendor account
  (`crypto.randomUUID().slice(0, 8)`-suffixed email) and creates its own
  application/customer/deployment — there are no shared fixture users, and
  nothing needs cleaning up between runs.
- **Local dev DB.** Without `DATABASE_URL` set, the API falls back to a
  file-backed PGlite store at `packages/db/.pgdata` (gitignored). Repeated
  local `pnpm e2e` runs accumulate test orgs/deployments there; delete the
  directory to start from a clean database.
