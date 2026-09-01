# Phase 1 E2E architecture — frozen design decisions

Decided 2026-09-01 after the Phase A discovery (see [README.md](README.md)).
This records *why* the architecture is shaped the way it is, so future rounds
do not re-litigate it. The maintained how-to lives in `../e2e-testing.md`.

## D1. The simulation seam is the relay's existing client interfaces

The relay (`packages/relay`) is the only code that touches a customer's AWS
account, and every relay module already defines a narrow injectable client
interface (`CloudFormationReader`, `StackInstaller`'s CFN client,
`StackEventsReader`, `StackDeleter`, `EcsDeployClient`, `EcsServiceReader`,
`TargetHealthReader`, `PendingStore`, ...) with `toX(sdkClient)` adapters kept
separate from `createRealX()` constructors.

Simulated mode therefore runs the **real relay code** — `pollOnce`, the real
executors, real `verifyInstallation`, real `provision-progress`, real
`stack-events` collector — in the Playwright test process, speaking the real
relay HTTP protocol to the real local API, with only the AWS *client*
interfaces replaced by an in-memory simulated customer account. Everything
downstream (API routes, DB, state transitions, stack-event ingest, status
derivation, step timings, resource-inventory persistence, both UIs) is
production code.

Rejected alternatives:
- *Mock at the relay-HTTP level* (what `deployment-progress.spec.ts` does):
  skips the relay's install/verify/progress logic and would encode
  hand-written relay payloads instead of AWS-shaped responses.
- *A new `DeploymentInfrastructure` facade in the control plane*: the control
  plane makes no customer-account AWS calls; a facade there would abstract
  nothing real (spec §7's "smallest practical interface" is the existing relay
  seams).

## D2. The simulator is test-only code, not a product mode

The simulated account, relay harness, and scenario engine live under
`e2e/simulation/` (plus typed scenario fixtures in `e2e/simulation/scenarios/`).
Nothing ships in any production bundle and the API has **no** scenario-control
endpoint — scenario selection happens entirely in the test process via a
Playwright fixture (`test.use({ deployzScenario })`). This makes spec §13/§24
("production cannot expose scenario controls") true by construction, which is
the highest-preference option in §13 (test configuration/context).

## D3. Mode selection and the real-AWS guard

- `DEPLOYZ_E2E_MODE` ∈ `simulated` (default) | `canary` | `fresh`, set by the
  runner `scripts/e2e.mjs` (Node, cross-platform — this repo develops on
  Windows).
- `canary`/`fresh` refuse to run unless `DEPLOYZ_E2E_ALLOW_REAL_AWS=1`, failing
  with the exact message from the spec, before anything is spawned.
- In simulated mode the runner launches the API with a **scrubbed environment**:
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`,
  `AWS_PROFILE`, `JOB_QUEUE_URL`, and email/SES configuration are removed, so
  locally-present AWS credentials cannot leak real behaviour into a default
  run (spec §4). The API's AWS touchpoints (SQS enqueue, SES) are already
  no-ops when unconfigured.
- The existing `DEPLOYZ_LIVE_AWS=1` vitest gate
  (`packages/cdk/test/golden-path-live-aws.test.ts`) stays as-is; the new
  canary/fresh modes are the product-level wrapper around real-AWS execution.

## D4. Scenario format

Typed fixtures (`ScenarioDefinition`) describing a CloudFormation event
timeline: each event has a **real reveal offset** (`afterMs`, 50–500 ms scale —
wall-clock test speed) and a **virtual timestamp offset** (simulated elapsed
time, minutes scale — what `Timestamp` fields report), so ETA/step-timing logic
sees realistic durations while tests stay fast. The simulated CFN store answers
`DescribeStacks` / `DescribeStackEvents` / `DescribeStackResources`
consistently from the revealed portion of the timeline; ECS/ELB/target-health
answers are also scenario-controlled (for health/update/rollback scenarios).

## D5. Canary and fresh reuse the existing live-AWS machinery

`packages/cdk/test/golden-path-live-aws.test.ts` (bootstrap deploy, application
stack provisioning, `verifyInstallation`) and
`packages/cdk/scripts/audit-deployment.mjs` are the substrate. Phase 1 wraps
them behind `pnpm e2e:canary` / `pnpm e2e:fresh` with the opt-in guard, unique
test identifiers, `deployz:` tag-based isolation, and best-effort cleanup —
rather than inventing a parallel real-AWS harness.

Concrete scope frozen 2026-09-02 (after
[live-aws-machinery.md](live-aws-machinery.md)):

- **Canary is read-only verification of a persistent installation.** A vitest
  suite in `packages/cdk/test/` verifies the standing canary installation
  (`DEPLOYZ_E2E_CANARY_INSTALLATION_ID`, defaulting to the same standing
  installation `DEPLOYZ_LIVE_INSTALLATION_ID` uses) via the relay's own
  `verifyInstallation` check ladder, live runtime health
  (`observeRuntimeHealth` over real ECS/ELB reads), and a non-null resource
  inventory (`listAllStackResources`). It creates and deletes nothing, fails
  fast with a clear message when credentials are absent, and refuses to look
  past a failed `stack-tagged` check. Driving a real update/rollback through
  canary requires the full live-install workflow against a control plane and
  stays a documented manual escalation in Phase 1.
- **Fresh wraps the existing create/destroy golden path.** `pnpm e2e:fresh`
  runs the bootstrap lifecycle (deploy → verify relay Active + tags →
  destroy → verify gone), hardened with: a per-run unique bootstrap stack
  name (env-var override consumed by `bin/bootstrap.ts`, `deployz-fresh-<id>`),
  a pre-existing-stack refusal instead of a collision, try/finally best-effort
  teardown, and test-identifying tags at create time. The application/Redis
  provisioning block stays opt-in via its existing
  `DEPLOYZ_LIVE_IMAGE_REPOSITORY`/`DIGEST` requirement. The full product-flow
  fresh install (install link → customer account → HEALTHY → update → delete)
  remains the documented manual live-install workflow in Phase 1 — wrapping,
  not redesigning, the existing capability.

## D6. Explicit non-goals honoured

No record/replay, no diff-based escalation, no LocalStack, no multi-cloud
interface, no full AWS API emulation. The simulated account implements only
the calls the relay actually makes, returning AWS-shaped structures.
