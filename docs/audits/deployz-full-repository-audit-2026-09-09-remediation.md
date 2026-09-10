# Audit Remediation Tracking — DZ-AUDIT 2026-09-09

Implementation tracking for `docs/audits/deployz-full-repository-audit-2026-09-09.md`.
Goal: move from **GO WITH BLOCKERS** to **MVP LAUNCH READY** without expanding the MVP boundary.

## Phase 0 — Revalidation against current `main` (@ 7019229)

Audited tree was `e4de944`; only docs commits landed since (the audit itself). All 20 in-scope
findings were re-verified against current code with fresh line evidence. **All 20: STILL PRESENT.**

| Audit ID | Sev | Status (Phase 0) | Phase | Notes |
|---|---|---|---|---|
| DZ-AUDIT-001 | P1 | STILL PRESENT | 1A | `retryAwareIdempotencyKey` exists (`server.ts:764-795`) and is used by 6 routes — not by register (`server.ts:5771`) |
| DZ-AUDIT-002 | P1 | STILL PRESENT | 1B | Raw version tag in one shared IMMUTABLE repo; deploys already digest-only |
| DZ-AUDIT-003 | P1 | STILL PRESENT | 1C | Pending marker (SSM) written only after settle; resume-by-ARN machinery already exists + tested |
| DZ-AUDIT-005 | P2 | STILL PRESENT | 5 | Mechanics fail-closed (`['us-east-1']` default); risk = GH var vs runtime env divergence + silent template-fetch failure |
| DZ-AUDIT-006 | P2 | STILL PRESENT | 2 | Watchdog requeue/failStuckJob UPDATEs lack state predicates |
| DZ-AUDIT-007 | P2 | STILL PRESENT | 2 | UPDATE_AVAILABLE written at release creation; never reverted on build failure |
| DZ-AUDIT-008 | P2 | STILL PRESENT | 5 | ERROR branch resets configureAttempts each heartbeat |
| DZ-AUDIT-009 | P2 | STILL PRESENT | 3 | PURGE sweeps only current installation tag; payload fields unread by relay |
| DZ-AUDIT-010 | P2 | STILL PRESENT | 3 | Public retries null installationId without recording previousInstallationId |
| DZ-AUDIT-011 | P2 | STILL PRESENT | 2 | Result route uses `hasStartedInstall`; watchdog copy uses `hasSucceededInstall` |
| DZ-AUDIT-012 | P2 | STILL PRESENT | 4 | Queues/DLQ lack explicit encryption prop; secrets transit CONFIG_UPDATE |
| DZ-AUDIT-013 | P2 | STILL PRESENT | 4 | First registration adopts any bearer token; bootstrap token never reaches control plane |
| DZ-AUDIT-014 | P2 | STILL PRESENT | 3 | Control-plane RDS `deletionProtection: false` (app RDS is `true`+RETAIN) |
| DZ-AUDIT-015 | P2 | STILL PRESENT | 5 | `/health` is a static 200; no DB-touching readiness route; probe is shallow |
| DZ-AUDIT-017 | P2 | STILL PRESENT | 7 | No stateless scenario; fixtures hardcode `databaseRequired: true` |
| DZ-AUDIT-018 | P2 | STILL PRESENT | 6 | Disconnect dialog hides retention warning while infrastructure loading/errored |
| DZ-AUDIT-019 | P2 | STILL PRESENT | 6 | `fetchReleases().catch(() => [])` renders "No deployable releases" on API failure |
| DZ-AUDIT-020 | P2 | STILL PRESENT | 6 | Homepage hand-rolled polling ignores shared `useStatusPoll` (backoff + stale) |
| DZ-AUDIT-024 | P2 | STILL PRESENT | 2 | Result-route settled guard is check-then-act outside the settlement tx |
| DZ-AUDIT-032 | P2 | STILL PRESENT | 2 | deploy-bulk lacks the `installationId` gate single deploy enforces |
| DZ-AUDIT-038 | P2 | STILL PRESENT | 7 | Force-complete has no E2E drive (unit settlement half only) |

## Baseline (Phase 0, local Windows worktree @ 7019229)

| Check | Result |
|---|---|
| `pnpm build` | PASS |
| `pnpm lint` | PASS (9/9) |
| `pnpm typecheck:scripts` | PASS |
| CDK `synth:bootstrap` + `synth:app` | PASS |
| Simulated E2E (`node scripts/e2e.mjs --scenarios`) | PASS (32 passed, 8 skipped, ~4.7 min) |
| `pnpm vitest run` (full, local) | KNOWN FAIL — Windows V8 OOM in scripts/* harness projects (DZ-AUDIT-039, reproduced; CI Linux green is authoritative). Targeted per-file vitest runs work locally (`--maxWorkers=1`). |

CI on `main` (audit reference run) is green: build, vitest, lint, typecheck:scripts, simulated E2E jobs.

## Phase plan

| Phase | Findings | Scope |
|---|---|---|
| 1 | 001, 002, 003 | P1 launch blockers: INSTALL recovery wedge; ECR tag namespacing; migration marker persistence |
| 2 | 006, 007, 011, 024, 032 | Truthful, race-safe lifecycle state (watchdog predicates, UPDATE_AVAILABLE semantics, settlement predicate convergence, atomic settlement, bulk gates) |
| 3 | 009, 010, 014, 018 | Cleanup lineage + resource safety (previous-attempt tracking, purge coverage, deletion protection, disconnect UX) |
| 4 | 012, 013 | Secrets/queue encryption; first-relay-registration binding |
| 5 | 005, 008, 015 | Region contract; bounded HTTPS retry; deploy readiness verification |
| 6 | 019, 020 (+035 rel.) | Misleading vendor UX (releases error state; fleet polling staleness; lifecycle truthfulness review incl. 018 dialog states) |
| 7 | 017, 038 (+ regression scenarios) | Simulated E2E coverage: stateless happy path; force-complete; phase 1-6 regressions |
| 8 | — | Focused real-AWS canary (A: full app; B: stateless) per existing canary policy |
| 9 | 033 | Documentation alignment to final behavior |
| 10 | remainder | Post-MVP backlog only (no implementation): 004, 021-023, 025-031, 034-037, 039 |

## Status log

- **Phase 0** (PR #259): revalidation complete; all 20 findings confirmed present; baseline recorded.
- **Phase 1** (PR #261, merge cb97d91): DZ-AUDIT-001 FIXED (retry-aware INSTALL key at registration, `apps/api/src/server.ts`), DZ-AUDIT-002 FIXED (application-namespaced release tags, `packages/cdk/src/lambda/worker.ts`; also shrinks DZ-AUDIT-004's tag-guess surface), DZ-AUDIT-003 FIXED (migration ARN persisted immediately after RunTask, `packages/relay/src/deploy.ts`). Regression tests: registration wedge ×3 (server.test.ts), cross-app tag collision ×2 (worker.test.ts), migration kill-window ×1 (deploy.test.ts). Gates: relay 499/499, api settlement suites 45/45 + server.test.ts 196/196, cdk worker+pipeline 76/76, build/lint/synth green, simulated E2E 32 passed / 8 skipped.
- **Phase 3** (this PR): DZ-AUDIT-009 FIXED (purge sweeps resources tagged with the current OR recorded previous installation id — ownership-safe knownIds check; previous-attempt RDS/secrets/S3/ElastiCache no longer invisible to purge; 11 new relay tests incl. unknown-id safety + deferral truthfulness), DZ-AUDIT-010 FIXED (install-link and deploy-link retries record previousInstallationId/previousBootstrapStackName exactly like the vendor reset; 3 new tests incl. the retry-during-in-flight-install race), DZ-AUDIT-014 FIXED (control-plane RDS deletionProtection: true + deleteAutomatedBackups: false; no workflow impact on normal releases; CDK assertions added), DZ-AUDIT-018 FIXED (disconnect dialog renders loading ("Checking retained resources…", confirm blocked) / error (conservative destructive warning) / loaded states; retention warning can no longer silently disappear). Gates: relay 508/508, api server 198/198 + deploy-links 37/37, cdk deployz-stack 21/21, web 481 tests + lint + build, build 9/9, lint clean, simulated E2E 32 passed / 8 skipped.
- **Phase 4** (this PR): DZ-AUDIT-012 FIXED (explicit SQS-managed SSE on job queue + DLQ; DLQ retention bounded 14d→3d so failed secret-bearing messages do not persist; redaction/mask/no-DLQ-consumer verified report-only), DZ-AUDIT-013 FIXED (server-established relay credential: control plane mints it at creation and every reset/retry, delivers it as the RelayCredential bootstrap template parameter inside the Quick Create URL, verifies the presented bearer against the stored hash at first registration (401 RELAY_CREDENTIAL_MISMATCH on mismatch), nulls the plaintext on binding; legacy deployments keep the adopt path; bootstrap template gains a NoEcho parameter with mutually exclusive conditional secrets of identical physical name; relay code unchanged; takeover protection preserved). E2E harness updated so every simulated relay presents the credential exactly like a real relay reads it from the stack secret. Shared `flipHealthyDeploymentsToUpdateAvailable` used by both the worker and the fixture build path (no duplicated settlement logic). Gates: api 222 unit tests, cdk bootstrap 45 + stack 22 + worker 56, db 78, web 481, build 9/9, lints green, simulated E2E 32 passed / 8 skipped.
- **Phase 5** (this PR): DZ-AUDIT-005 ADDRESSED (region validation at creation was already fail-closed (422 REGION_NOT_SUPPORTED, both creation routes) — verified; republish workflow already fails visibly; NEW: server-side classification refines regional template-fetch errors (S3 404/PermanentRedirect) to TEMPLATE_UNAVAILABLE (DEPLOYZ_ACTION, critical copy) across contracts/copy-map/db enum/status mapping, so a missing regional artifact can no longer masquerade as a generic failure). DZ-AUDIT-008 FIXED (default-HTTPS and custom-domain ERROR states are terminal — no automatic budget reset, no new configure jobs; new vendor route POST /api/deployments/:id/default-https/retry (409 NOT_IN_ERROR otherwise); custom-domain recovery is remove+re-add). DZ-AUDIT-015 FIXED (new unauthenticated GET /health/ready proves process + DB reachable + migrated schema queryable; deploy-api.yml probe now targets /health/ready so a dead or mis-migrated API fails the deploy visibly). Ops follow-up (not repo-verifiable): confirm production DEPLOYABLE_AWS_REGIONS value and BOOTSTRAP_REPUBLISH state (Phase 8 canary exercises us-east-1). Gates: api 297 unit tests, build 9/9, lints green, simulated E2E 32 passed / 8 skipped.
- **Phase 6** (this PR): DZ-AUDIT-019 FIXED (releases fetch failures render a distinct load-failed state with a Try-again affordance in the deploy dialog — never "No deployable releases" during an API outage), DZ-AUDIT-020 FIXED (homepage on the shared useStatusPoll hook with a "Updates unavailable — showing last known state" staleness banner), DZ-AUDIT-035 (relevant part) FIXED ("All deployments healthy" no longer counts UPDATE_AVAILABLE — the homepage summary shows a separate "Update(s) available" count). Lifecycle truthfulness review: no false HEALTHY, no fake UPDATE_AVAILABLE, retention warnings present (018), no AWS jargon; new "Retry HTTPS setup" affordance wired to the DZ-AUDIT-008 retry route on the failed HTTPS row. Gates: web 481 tests + lint + build, UI e2e specs 38/38, simulated E2E 32 passed / 8 skipped.
- **Phase 7** (this PR): DZ-AUDIT-017 CLOSED (new @scenario:stateless happy path — installs HEALTHY with zero database resources; fixtures now drive databaseRequired from the scenario manifest). DZ-AUDIT-038 CLOSED (force-complete exercised E2E: relay-death-destroy extended with the gate assertions and force-complete-repeated-failures drives the route's staleness/refusal path; the full success settlement remains unit-covered — the one-shot scenario timeline cannot replay a second outcome, documented honestly). Regression scenarios added: two-apps-both-1.0.0 (002), retry-install recovery control-plane path + install-link-retry fresh-install arc (001/010 lineage), mid-flight public retry records previousInstallationId (010), HTTPS budget exhaustion → terminal ERROR → vendor retry (008). Suite grew 32→37 passed (+6 new tests, docs/testing/e2e-scenarios.md updated to 24 scenarios); also fixed a pre-existing duplicate-request timing race (busy check now fires concurrently — deterministic) and a harness gap (recovery-mode stack deletion now modeled; recover seam wired). Skipped with reasons: failed-build E2E knob (infeasible in BUILD_FIXTURE_MODE — unit-covered), migration kill-window E2E (relay unit tests prove resume-exactly-once), watchdog settlement races (worker not booted in simulation — unit-covered). Gates: full simulated suite 37 passed / 9 skipped / 0 failures (resilience spec 3x stable), runtime ~2.6min.
- **Phase 2** (this PR): DZ-AUDIT-024 FIXED (result settlement is one conditional UPDATE WHERE state IN (active) RETURNING inside the tx; settled jobs skip all side effects), DZ-AUDIT-006 FIXED (watchdog requeue + failStuckJob writes state-predicated, side-effect-gated via returning()), DZ-AUDIT-007 FIXED (UPDATE_AVAILABLE only when a newer READY release exists: write moved from release creation to build success; build failure reverts; deploy/rollback success and §10.3 promotion resolve via one newerReadyReleaseExists rule), DZ-AUDIT-011 FIXED (single shared hasStartedInstall in apps/api/src/jobs.ts used by result route and watchdog — zero-task installs can no longer settle HEALTHY), DZ-AUDIT-032 FIXED (deploy-bulk enforces the installationId gate). E2E specs updated from the old wrong semantics to the new invariant. Gates: api 220 unit tests, cdk worker 56, build 9/9, lints green, simulated E2E 32 passed / 8 skipped.
