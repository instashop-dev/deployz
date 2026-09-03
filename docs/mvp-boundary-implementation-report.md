# Deployz MVP — Boundary Implementation Report

- Branch: `omos/boundary-mvp-final` (== `origin/main` @ `90c75d9`)
- Report date: 2026-09-03
- Scope: the final phase (§24) of the Deployz MVP boundary plan, Phases 0–14
- Source of record: `docs/mvp-implementation-status.md`
- Environment note: Windows, Node 24, pnpm; vitest fakes only, no real AWS
  touched during this implementation effort

## 1. Executive Summary

Phases 0–14 of the Deployz MVP boundary plan are merged. The product now runs
one opinionated customer-AWS deployment architecture end to end through real
relay executors: repository analysis → readiness/manifest gates → install →
release build → gated migration + deploy → layered runtime health → default
HTTPS → day-2 operations → disconnect/purge. The dead orchestration layers
(`packages/cdk/src/jobs/*`, `durable/*`, `analysis/*`) that Phase 0 identified
were removed in Phase 13, and every capability audit through Phase 14 landed
at COMPLETE or an explicit DEFERRED/DETECTION-ONLY/KNOWN-LIMITATION verdict.

**Is the MVP boundary met?** Yes, as a code-and-simulated-verification
boundary. The one thing not executed is the transient live-AWS lifecycle
check, which is deferred by design to the canary runbook
(`docs/testing/aws-full-product-canary.md`, `docs/testing/version-rollback-canary.md`).

**Confidence.** High for the simulated surface (unit, integration, and
full-lifecycle simulated E2E all green, with the documented Windows
EBUSY/onTaskUpdate flakes re-run per the Phase-0 discipline). The live-AWS
half remains to be proven before paid-customer launch.

**Launch blockers.** None in code. The single gate item before launch is the
transient live-AWS canary run, which is DEFERRED BY DESIGN in this effort —
no real AWS was touched here.

## 2. Phase Completion

Phase numbering follows the boundary plan; each phase below lists its merged
PR, merged commit on `main`, what changed, tests run, and live verification.
All phases merged 2026-09-02/03.

| Phase | PR | Merged commit | Summary |
| --- | --- | --- | --- |
| 0 — Baseline | (no separate PR — baseline audit on the `omos/boundary-mvp` branch, first merged with PR #72) | `7b61b02` | Baseline test run, live-runtime map, dead/unwired subsystem audit, Phase-0 decisions. No product behavior changed; recorded in `docs/mvp-implementation-status.md`. |
| 1 — Real Deployment Correctness | #72 | `7b61b02` | Wired ECR cross-account pull grants (INSTALL grant / DESTROY+PURGE revoke), auto-deploy of the newest READY release on INSTALL success, scoped API ECR IAM, honest secret-delivery wiring. |
| 2 — Canonical Deployment Manifest | #73 | `f7ec12f` | Canonical deployment manifest (contracts schema, analysis normalization, install parameter interpolation into the published application template), deployment-creation gate on manifest readiness. |
| 3 — Real Readiness Enforcement | #75 | `b5b92ed` | Server-side readiness gates at the install-link `launched` route and at relay registration; stored-manifest re-evaluation (`requireReadyManifest`); fail-closed for pre-manifest deployments. |
| 4 — First-Class Database Migrations | #78 | `474a4bb` | Migration stage between cache and application: one-off ECS RunTask before the service update, `sh -c` command override, MIGRATION_FAILED semantics, resume-by-task-ARN, rollback never runs migrations. |
| 5 — Delete, Purge, Disconnect Lifecycle | #81 | `a96084d` | Purge ownership (bootstrap stack by name), `cleanup_state` PURGE_FAILED, domain-job watchdogs, force-complete for repeated DESTROY failure, relay-liveness gates on day-2 actions, relay-reset tracking columns. |
| 6 — Runtime Health and Promotion Correctness | #83 | `d72cf62` | HTTP probe, five-layer health derivation, promotion gated on heartbeat digest reconciliation (rollout COMPLETED + full counts + healthy targets + successful probe). |
| 7 — Repository Compatibility Expansion | #85 | `34dfc2b` | Env-var `{key,required,secret,source}` model, external-services detection, broader unsupported-architecture breadth, monorepo classification, vendor-corrected Dockerfile/build context. |
| 8 — Background Worker Decision (Option B: explicit defer) | #86 | `5ca1f29` | Worker support deferred: a declared worker command makes the repo needs-adaptation; worker-command config surface disabled; evidence recorded. |
| 9 — PostgreSQL and S3 Hardening | #87 | `86addee` | RETAIN lifecycle (no final snapshot anywhere), retained credential secrets, purge credential sweep, SG-scoped DB ingress, S3 lifecycle rules, truthful classification and customer copy. |
| 10 — Runtime Failure Classification and Diagnostics | #92 | `f2d68b1` | Migration-stage image-pull classification (IMAGE_PULL_FAILED), diagnostics technical-detail plumbing to the web card. |
| 11 — Default HTTPS Without Customer DNS | #115 | `0704eb2` | Per-deployment Deployz hostname (`<id>.apps.deployz.dev`), customer-account ACM cert DNS-validated via the Deployz Route53 zone, default-HTTPS state machine + teardown, URL precedence. |
| 12 — Resource Inventory and MVP UX Cleanup | #120 | `c4ffed5` | Customer-scoped install resource list, failed-install inventory visibility, disconnected-state day-2 gating, jargon-free stuck-relay copy. |
| 13 — Dead Code, State Model, Test Cleanup | #124 | `36b77f8` | Removed `packages/cdk/src/jobs/*`, `durable/*`, `analysis/*` and their 15 test files (458 test cases); state-model comments corrected (nine → ten states); SUCCESS/SUCCEEDED pair documented as load-bearing. |
| 14 — Full-Lifecycle E2E Hardening | #125 | `90c75d9` | Lifecycle-sweep scenario, B/C/D/E scenario matrix, fixture repos (config-required, mongodb, local-fs), relay-harness seams (account reuse, purge executor, migration counter). |

### Phase 0

- Status: COMPLETE (baseline record only)
- Tests run: `pnpm install`, `pnpm build`, `pnpm vitest run` — 1681 passed,
  2 skipped; 11 suites failed-to-collect on the Windows EBUSY flake and all
  11 passed serially on re-run.
- Live verification: none (audit-only phase).

### Phase 1

- Tests run: focused vitest suites — `apps/api` (server, ecr-grants,
  config-update relay, secret-delivery integration, deployz-stack synth),
  `packages/relay` config-update/pending/poll, `packages/cdk` worker and
  pipeline.
- Live verification: none (vitest fakes only).

### Phase 2

- Tests run: `packages/analysis` manifest tests, `packages/contracts` manifest
  tests, `apps/api` manifest/lifecycle/install-parameters tests,
  `packages/relay` install/index tests, `packages/cdk` application-stack synth
  tests; committed template artifacts regenerated.
- Live verification: none (vitest fakes only).

### Phase 3

- Tests run: focused suites on every gated endpoint (`apps/api/server.test.ts`,
  manifest tests); five DB-seeded fixture suites updated to carry a READY
  manifest.
- Live verification: none.

### Phase 4

- Tests run: vitest fakes for migration success/failure/no-command/rollback
  and the Migration ladder step (`packages/relay`, contracts, api derivation,
  web step copy).
- Live verification: none (migration stage also covered by later simulated
  E2E and the version canary's v2 migration fixture).

### Phase 5

- Tests run: one focused test per gap — relay purge, api failure-semantics,
  disconnect-force-complete, cdk worker watchdogs, server relay-liveness,
  web/copy-map failure-code mirrors. Full build + full vitest suite (93
  files).
- Live verification: none.

### Phase 6

- Tests run: relay http-probe/deploy/poll tests, api
  digest-reconciliation/deployment-status/server/deploy-contract tests.
- Live verification: none.

### Phase 7

- Tests run: full suite — 95 files / 2094 tests passed (Windows onTaskUpdate
  flake re-run per discipline); focused analysis (334, incl. phase7),
  contracts manifest, relay (417), api, cdk worker.
- Live verification: none.

### Phase 8

- Tests run: full build 9/9; focused suites — analysis (337), api (39
  files/926), web + contracts + copy-map (391).
- Live verification: none.

### Phase 9

- Tests run: cdk application-stack + bootstrap-stack synth assertions,
  artifacts regeneration, relay purge credential-sweep tests, snapshot
  updates eyeballed.
- Live verification: none.

### Phase 10

- Tests run: relay deploy (IMAGE_PULL_FAILED classification), web diagnostics
  (`toDiagnostics`), api failure-classification/semantics/status, copy-map.
- Live verification: none.

### Phase 11

- Tests run: api default-https state machine over PGlite (full migrations),
  route53 SigV4/XML semantics, deployment-status precedence, relay purge ACM
  sweep, cdk synth + artifacts regenerated.
- Live verification: none — a real (non-fixture) Route53 round trip is the
  canary runbook's domain.

### Phase 12

- Tests run: web unit tests (287), api server tests (172), `tsc --noEmit`
  green for web.
- Live verification: none.

### Phase 13

- Tests run: `pnpm build` 9/9, `pnpm lint` 9/9; full vitest measured 128
  files / 2454 tests (2449 passed, 3 skipped) on the most complete run, with
  every cdk suite re-run green in isolation (Windows worker flakes); 3
  Playwright DOM assertions added.
- Live verification: none.

### Phase 14

- Tests run: new Playwright specs green — `scenario-matrix.spec.ts` (4: D, E,
  B, C) and `scenario-sweep.spec.ts` (1 continuous lifecycle, ~30s); all
  pre-existing scenario specs re-run green; combined `--grep "@scenario"`
  run 27 passed. `pnpm build` green for relay and api; eslint green on every
  touched file.
- Live verification: none — transient live-AWS verification stays the canary
  runbook's job.

## 3. Final Architecture

See `docs/architecture.md` for the full description. Summary of the live flow:

Repo → Analyzer → Deployment Manifest → Readiness → Release Build → Install
Infrastructure → Deploy Release → Migration → Runtime Health → HTTPS (default
Deployz zone + custom domains) → Day-2 Operations → Delete/Purge.

Two actors: the control plane (API, worker/watchdog, SQS, CodeBuild, template
bucket, Route53 zone writer) and the customer-side relay Lambda (5-minute
poll, egress-only, the only code that touches the customer account). The relay
executes a fixed vocabulary over published application templates. Teardown is
retain-then-purge: Disconnect retains the database/credentials/storage; Purge
deletes them; the customer deletes the bootstrap stack itself.

## 4. MVP Capability Matrix

| Capability | Verdict | Evidence |
| --- | --- | --- |
| Repository analysis / readiness / manifest gates | COMPLETE | Phases 2, 3, 7; simulated scenarios + unit gates |
| Install to HEALTHY (real relay executors) | COMPLETE | Phases 1, 6, 14 (lifecycle-sweep install leg, redis-success) |
| Redis detection, provisioning, inventory | COMPLETE | Phase 7 + `redis-success` / `redis-failure` scenarios |
| Migration stage before deploy; no rollback migrations | COMPLETE | Phase 4; lifecycle-sweep migration counter |
| Runtime health + gated promotion | COMPLETE | Phase 6; `update-failure`/`rollback-*` scenarios |
| Rollback / failed-update isolation | COMPLETE | Phase 6; scenario matrix |
| Default HTTPS + custom domains | COMPLETE | Phase 11 + pre-existing custom-domain flow |
| Disconnect / Purge / retained-resource teardown | COMPLETE | Phases 5, 9; retained-resources + sweep scenarios |
| Team Admin support console | COMPLETE | merged workstream (#84) + `e2e/admin.spec.ts` |
| ECR cross-account pull grant lifecycle | COMPLETE | Phase 1 (grant on install, revoke on destroy/purge) |
| Background worker (Option A) | DEFERRED BY DESIGN | Phase 8 (Option B): needs-adaptation when declared |
| Cron / scheduled jobs | DEFERRED BY DESIGN | out of MVP scope |
| MySQL / MongoDB / other DB provisioning | DEFERRED BY DESIGN | rejected at analysis with evidence |
| Precise runtime port-mismatch diagnosis (PORT_MISMATCH) | KNOWN LIMITATION | audited gap (Phase 10): no log access by design; honest code is IMAGE_HEALTH_CHECK_FAILED |
| Transient live-AWS lifecycle run | KNOWN LIMITATION / DEFERRED BY DESIGN | canary runbook; not executed in this effort |

No unexplained BROKEN or MISSING P0 capability remains.

## 5. Test Results

- **Unit / integration (Vitest):** the most complete full run measured 128
  files / 2454 tests (2449 passed, 3 skipped). Environmental skips only:
  `ai-live` (needs `DEPLOYZ_LIVE_AI=1`) and `billing` (needs a real Stripe
  test-mode key). Windows EBUSY/onTaskUpdate suite-collection flakes are
  documented and re-run per the Phase-0 discipline; CI (Ubuntu) is
  authoritative.
- **Simulated E2E:** full simulated lifecycle proven end to end. Phase 14's
  lifecycle sweep (`@scenario:lifecycle-sweep`) covers analyse → readiness →
  required-config refused → value entered → install → healthy → config write →
  successful update → failed update (previous stays live) → rollback → relay
  reset → day-2 refusal until reconnected → successful update → delete →
  purge. The B/C/D/E matrix adds `redis-success`, `monorepo-deploy`,
  `unsupported-mongodb`, and `repairable-local-fs`. Combined
  `--grep "@scenario"` run: 27 passed.
- **Live AWS scenarios:** none executed in this implementation effort. The
  canary/fresh/version-canary harnesses exist and are documented
  (`docs/testing/`), but running them was not part of this phase and none was
  invoked.

## 6. AWS Verification and Cleanup

Be honest: no real AWS was touched in this implementation effort. All
verification was simulated (vitest fakes + the simulated E2E account). No AWS
resources were created, modified, or destroyed, so there is nothing to clean
up from this effort. The transient live-AWS lifecycle test — install link →
real customer account → HEALTHY → update → rollback → disconnect → purge,
plus cleanup/leak audit — remains to be executed via the canary runbook
(`docs/testing/aws-full-product-canary.md`; version/rollback automation in
`docs/testing/version-rollback-canary.md`) before launch.

## 7. Security Review

- **Secret handling (Phase 1.2 delivery, Phase 9 retained credentials + purge
  sweep):** the relay credential lives in the bootstrap stack's Secrets
  Manager secret; install/config secrets ride job payloads transiently;
  retained DB credentials now use `removalPolicy: RETAIN` so a retained
  database stays reachable, and PURGE deletes the retained credential secrets
  tag-verified (`deployz:installation` AND `deployz:component=application`).
- **Cross-account ECR:** control-plane-side grant on INSTALL, revoke on
  DESTROY/PURGE success (Phase 1); best-effort and idempotent; a missing
  grant surfaces as the customer task's IMAGE_PULL_FAILED.
- **IAM scoping:** relay permissions sit inside a permissions boundary; cache
  and purge actions are split create (RequestTag) / manage (ResourceTag) /
  describe (condition-free reads), never `elasticache:*` or `route53:*`
  (Phase 11 zones grant is scoped to one hosted-zone ARN).
- **Redaction:** no raw log bodies cross the boundary; the relay role has no
  `logs:GetLogEvents`; diagnostics carry structured events, and web/customer
  surfaces keep raw AWS states behind "Advanced details".
- **Connector cleanup:** purge stops pretending it deletes the customer's
  bootstrap stack (CANARY-014); the vendor page and install link tell the
  customer to delete `deployz-bootstrap-…`. Relay-reset records
  `previous_installation_id`/`previous_bootstrap_stack_name` so old-stack
  retained resources stay attributable.

## 8. Remaining Deferred Scope

- **Worker (Option B)** — real background-worker support deferred; declared
  workers are needs-adaptation (Phase 8).
- **Cron / scheduled jobs** — out of MVP scope.
- **Other database/Redis-adjacent provisioning** — MySQL, MongoDB, and other
  services are rejected at analysis, not provisioned.
- **Phase 15 100-repository benchmark** — removed from scope by operator
  decision.
- **Transient live-AWS verification** — deferred by design to the canary
  runbook (`pnpm e2e:canary`, `pnpm e2e:fresh`,
  `pnpm e2e:canary:versions core`).

## 9. Known Limitations (user-impact oriented)

- **First-run failure leaves retained empty credential secrets** behind on a
  failed-install retry (Phase 9 tradeoff; they hold no customer data and a
  follow-up sweep can remove them).
- **Express-mode database ingress is whole-VPC** (ECS manages task security
  groups; documented tradeoff, not silent).
- **Every published template provisions RDS** even for apps that do not need
  a database (explicit MVP tradeoff).
- **Rollback never reverses schema migrations** (documented; vendors must
  write backward-compatible migrations).
- **Port-mismatch diagnosis is imprecise** — no log access by design, so a
  misconfigured port surfaces as a health-check failure, not a PORT_MISMATCH
  code.
- **Redis with TLS or cluster mode is unsupported** and rejected at analysis;
  a repo whose only Redis signal is a Stack-module dependency slips past the
  gate as "not detected" (known detection gap).
- **The live AWS behavior of the full stack is not yet proven in this
  effort** — it requires the canary run.

## 10. MVP Launch Gate (plan §21 checklist)

Verdicts: PASS / FAIL / DEFERRED BY DESIGN. DEFERRED BY DESIGN items are not
failures of this implementation; they are items the boundary plan routes to
the canary runbook or explicitly excludes.

| # | Gate item | Verdict | Notes |
| --- | --- | --- | --- |
| 1 | Real deployment correctness (grants, auto-deploy, honest day-2 wiring) | PASS | Phase 1; simulated E2E |
| 2 | Canonical deployment manifest + readiness gates before provisioning | PASS | Phases 2, 3 |
| 3 | Migrations run before service update; rollback never runs them | PASS | Phase 4; lifecycle-sweep migration counter |
| 4 | Delete/purge/disconnect lifecycle truthful and recoverable | PASS | Phases 5, 9; retained-resources scenario |
| 5 | Runtime health verified, promotion gated on real gates | PASS | Phase 6 |
| 6 | Unsupported repos blocked with evidence; repairable repos guided | PASS | Phase 7; D/E matrix scenarios |
| 7 | Background worker decision made explicitly | PASS (deferral) | Phase 8 Option B documented |
| 8 | PostgreSQL/S3 lifecycle RETAIN (no final snapshot) | PASS | Phase 9; code and docs agree |
| 9 | Runtime failure taxonomy reaches customers/vendors usefully | PASS | Phase 10; copy-map exhaustive |
| 10 | Default HTTPS with zero customer DNS | PASS | Phase 11 |
| 11 | Resource inventory and MVP UX honest | PASS | Phase 12 |
| 12 | Dead code removed; no doc claims dead workflows are production | PASS | Phase 13 + this sweep (§22) |
| 13 | Full-lifecycle simulated E2E green (incl. B/C/D/E matrix) | PASS | Phase 14; 27 scenario tests |
| 14 | Documentation sweep complete and report filed | PASS | §22 + this report (§24) |
| 15 | Transient live-AWS lifecycle run | DEFERRED BY DESIGN | canary runbook; not executed here |
| 16 | 100-repository benchmark | DEFERRED BY DESIGN | removed from scope by operator decision |
| 17 | Worker (Option A) | DEFERRED BY DESIGN | Phase 8 Option B |
| 18 | Cron / other provisioning | DEFERRED BY DESIGN | out of MVP scope |

## 11. Recommendation

On the strength of the unit/integration and simulated full-lifecycle
evidence, the MVP boundary is met in code. The single unexecuted item —
transient live-AWS lifecycle verification — is deferred by design to the
canary runbook and is listed as a non-blocking limitation because it does not
change any product behavior already proven in simulation; it must be run
before the first paid-customer launch. No unexplained broken or missing P0
capability exists, and all remaining scope is either a documented deferral or
a listed limitation.

MVP READY WITH LISTED NON-BLOCKING LIMITATIONS
