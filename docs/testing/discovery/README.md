# E2E architecture discovery (Phase A)

Point-in-time investigation reports, produced 2026-09-01 on branch
`claude/deployz-phase1-e2e-testing-d6512e` (base `1c712f9`), before the Phase 1
E2E testing architecture (simulated / canary / fresh modes) was implemented.

These documents record **what the codebase looked like** when the design was
chosen. They are reference material for future testing work (for example, the
Phase 2 record/replay design) — they are not maintained documentation. File
paths and line numbers drift; verify before relying on them. The maintained
description of the E2E architecture lives in `../e2e-testing.md`.

| Report | Contents |
| --- | --- |
| [aws-boundary.md](aws-boundary.md) | Every AWS SDK call site (relay vs control plane), the relay protocol and command paths, bootstrap/publish operations, stack polling, resource-inventory persistence, health probing, and the existing fixture-mode/injection seams. |
| [deployment-lifecycle.md](deployment-lifecycle.md) | DB schema, the persisted deployment state machine and derived 6-stage status model, jobs/background processing, progress/step/ETA derivation, install/update/rollback/destroy/purge flows, and clock injection points. |
| [test-infrastructure.md](test-infrastructure.md) | How the existing Playwright suite drives the real API+DB, PGlite wiring, fixture env flags, the `packages/fixture` app, CI workflows, and the pre-existing `DEPLOYZ_LIVE_AWS=1` live-AWS suite. |

## Findings that shaped the Phase 1 design

1. **The AWS boundary is the relay, and it is already seamed.** The relay is the
   only code that touches a customer's AWS account, and every relay module
   already defines a narrow injectable interface (`CloudFormationReader`,
   `StackInstaller`, `EcsDeployClient`, ...) with a `toX(sdkClient)` adapter
   separated from a `createRealX()` constructor. A simulated mode implements
   these existing interfaces; it does not need a new grand abstraction.
2. **The control plane already treats the relay as an external HTTP client.**
   `e2e/deployment-progress.spec.ts` and `e2e/stack-events.spec.ts` already
   drive installs by speaking the real relay HTTP protocol (`register` →
   `commands` → `progress`/`result` → `health`). The control plane cannot tell
   a simulated relay from a real one — the protocol *is* a seam.
3. **A fixture-mode convention exists.** `GITHUB_FIXTURE_MODE`,
   `AI_FIXTURE_MODE`, `DOMAIN_FIXTURE_MODE`: env flag read once in
   `apps/api/src/env.ts`, `create{Real,Fixture}X()` factory pair, chosen via a
   default parameter on `buildServer`, always overridable for tests.
4. **A live-AWS opt-in gate exists.** `DEPLOYZ_LIVE_AWS=1` already gates
   `packages/cdk/test/golden-path-live-aws.test.ts`; `audit-deployment.mjs` is
   an existing on-demand canary-style verifier.
5. **The synthetic test app exists.** `packages/fixture` is a tiny Express app
   with `/` and `/health`, already the image real installs run.
6. **Timing is injectable where it matters.** The relay install loop takes
   `now`/`sleep`; status derivation takes `now`; simulated CFN event
   *timestamps* are data, so realistic elapsed timelines can be replayed
   quickly without a time framework.
