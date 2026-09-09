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

- **Phase 0** (this PR): revalidation complete; all 20 findings confirmed present; baseline recorded.
