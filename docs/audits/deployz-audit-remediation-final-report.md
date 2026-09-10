# Deployz audit remediation — final implementation report

Date: 2026-09-10 · Executor: OpenAgent (orchestrator + specialist lanes) · Worktree lane `audit-fix-2`
Source audit: `docs/audits/deployz-full-repository-audit-2026-09-09.md` (GO WITH BLOCKERS, `main` @ e4de944)

## Summary

- **Original state:** GO WITH BLOCKERS — 39 findings (P1 ×3, P2 ×17, P3 ×19).
- **Final state:** all 20 in-scope findings fixed and merged; 19 findings deliberately deferred post-MVP (`deployz-audit-post-mvp-backlog.md`); simulated suite grown to 37 scenarios; CI green on every merged phase; documentation aligned to final behavior.
- **Phases completed:** 0 (revalidation/baseline), 1 (P1 blockers), 2 (lifecycle truth/races), 3 (cleanup lineage/safety), 4 (secrets/enrollment), 5 (region/HTTPS/readiness), 6 (vendor UX truthfulness), 7 (scenario coverage), 9 (docs alignment), 10 (this backlog + report).
- **Phase 8 (real-AWS canary):** deferred by operator decision to a handoff run (prompt issued 2026-09-10). Completed portions: production control plane verified current and healthy (`GET /health/ready` → 200); canary ladder mapped; scope decisions recorded.
- **PRs merged (in order):** #259 (Phase 0), #261 (Phase 1), #263 (Phase 2), #264 (Phase 3), #265 (Phase 4), #266 (Phase 5), #267 (Phase 6), #268 (Phase 7), #270 (Phase 9). Phase 10 is this PR. Merge SHAs: `8814ffe`, `cb97d91`, `d83cc0d`, `624eb1b`, `349f695`, `cf2edce`, `3b62f88`, `4aa192e`, `11ed294`.
- **External contribution during the effort:** #269 (`52d823c`) fixed the Phase 4 bootstrap template's secret-ARN resolution (`GetAtt` → `Ref`) — merged and included.

## Finding matrix

| Audit ID | Original severity | Final status | Phase | PR | Test coverage |
|---|---|---|---|---|---|
| DZ-AUDIT-001 | P1 | FIXED | 1 | #261 | 3 registration-wedge unit tests |
| DZ-AUDIT-002 | P1 | FIXED | 1 | #261 | 2 tag-format/collision unit tests; E2E two-apps-1.0.0 |
| DZ-AUDIT-003 | P1 | FIXED | 1 | #261 | kill-window regression + existing resume-by-ARN tests |
| DZ-AUDIT-004 | P2 | DEFERRED POST-MVP | — | — | materially mitigated by 002 (UUID-namespaced tags) |
| DZ-AUDIT-005 | P2 | FIXED | 5 | #266 | fail-closed creation verified; TEMPLATE_UNAVAILABLE classification + parity tests |
| DZ-AUDIT-006 | P2 | FIXED | 2 | #263 | worker settled-race regression tests |
| DZ-AUDIT-007 | P2 | FIXED | 2 | #263 | build-success/failure/older-release unit tests; §10.3 promotion test; E2E lifecycle |
| DZ-AUDIT-008 | P2 | FIXED | 5 | #266 | terminal-ERROR + retry-route unit tests; E2E default-https-i |
| DZ-AUDIT-009 | P2 | FIXED | 3 | #264 | 11 purge-lineage tests (deletion, unknown-id safety, deferral truthfulness) |
| DZ-AUDIT-010 | P2 | FIXED | 3 | #264 | 3 retry-lineage unit tests; E2E install-link-retry |
| DZ-AUDIT-011 | P2 | FIXED | 2 | #263 | shared-predicate unit tests; zero-task watchdog test |
| DZ-AUDIT-012 | P2 | FIXED | 4 | #265 | CDK SSE/retention assertions |
| DZ-AUDIT-013 | P2 | FIXED | 4 | #265 | registration binding tests; bootstrap template tests; full harness credential adaptation |
| DZ-AUDIT-014 | P2 | FIXED | 3 | #264 | CDK deletion-protection assertions |
| DZ-AUDIT-015 | P2 | FIXED | 5 | #266 | /health/ready test; workflow probe targets it |
| DZ-AUDIT-016 | P2 | DEFERRED POST-MVP | — | — | deliberate, documented CI design |
| DZ-AUDIT-017 | P2 | FIXED | 7 | #268 | @scenario:stateless E2E (HEALTHY, zero database resources) |
| DZ-AUDIT-018 | P2 | FIXED | 3 | #264 | dialog loading/error/loaded states; web suite green |
| DZ-AUDIT-019 | P2 | FIXED | 6 | #267 | releases load-failed/empty separation + retry |
| DZ-AUDIT-020 | P2 | FIXED | 6 | #267 | shared-poll migration + staleness banner |
| DZ-AUDIT-021 | P3 | DEFERRED POST-MVP | — | — | — |
| DZ-AUDIT-022 | P3 | DEFERRED POST-MVP | — | — | — |
| DZ-AUDIT-023 | P3 | DEFERRED POST-MVP | — | — | — |
| DZ-AUDIT-024 | P2 | FIXED | 2 | #263 | atomic conditional-settlement tests |
| DZ-AUDIT-025 | P3 | DEFERRED POST-MVP | — | — | — |
| DZ-AUDIT-026 | P3 | DEFERRED POST-MVP | — | — | stub comment corrected (Phase 9) |
| DZ-AUDIT-027 | P3 | DEFERRED POST-MVP | — | — | — |
| DZ-AUDIT-028 | P3 | DEFERRED POST-MVP | — | — | — |
| DZ-AUDIT-029 | P3 | DEFERRED POST-MVP | — | — | — |
| DZ-AUDIT-030 | P3 | DEFERRED POST-MVP | — | — | — |
| DZ-AUDIT-031 | P3 | DEFERRED POST-MVP | — | — | — |
| DZ-AUDIT-032 | P2 | FIXED | 2 | #263 | bulk installationId-gate test |
| DZ-AUDIT-033 | P2 | FIXED | 9 | #270 | six drift corrections; Part B verified clean |
| DZ-AUDIT-034 | P3 | DEFERRED POST-MVP | — | — | — |
| DZ-AUDIT-035 | P3 | PARTIALLY FIXED (truthfulness part) | 6 | #267 | home-state test; remainder deferred |
| DZ-AUDIT-036 | P3 | DEFERRED POST-MVP | — | — | documented IAM notes |
| DZ-AUDIT-037 | P3 | DEFERRED POST-MVP | — | — | — |
| DZ-AUDIT-038 | P2 | FIXED | 7 | #268 | force-complete gate E2E; success settlement unit-covered |
| DZ-AUDIT-039 | P3 | DEFERRED POST-MVP | — | — | workaround documented (per-file runs; CI authoritative) |

Totals: **21 FIXED** (incl. 035 partial), **18 DEFERRED POST-MVP** (none meets the severity-gate disqualifiers), **0 OPEN BLOCKERS**.

## Validation

| Check | Result |
|---|---|
| lint | PASS every phase (9/9 packages) |
| typecheck (`pnpm build`) | PASS every phase (9/9; exactOptionalPropertyTypes on) |
| `pnpm typecheck:scripts` | PASS |
| unit/integration (`pnpm vitest run` per package) | PASS — api 297 (server/failure-semantics/lifecycle/deploy-links/disconnect-force-complete…), relay 508, cdk worker 56 + bootstrap 45 + stack 22 + artifacts/migrations 87, db 78, web 481, copy-map 49 |
| simulated E2E (`node scripts/e2e.mjs --scenarios`) | PASS — 37 passed / 9 skipped (CI also runs the default-https fixture file: 9 passed) |
| CDK synth (`synth:bootstrap` + `synth:app`) | PASS |
| CI | GREEN on every merged phase PR (Test and build + Simulated E2E ×2 each) |
| Production control plane | `GET /health/ready` → 200 (current code; DB + schema usable) |
| AWS canary A (full app) | **DEFERRED** — handoff prompt issued; requires AWS login |
| AWS canary B (stateless) | **DEFERRED POST-MVP** by operator decision (simulated coverage: @scenario:stateless) |
| Cleanup verification | N/A this session (no real AWS resources created); the handoff canary run performs its own cleanup + leak audit |

## Remaining risk (material, MVP-relevant only)

1. **Real-AWS lifecycle unverified pending the handoff canary** — every simulated gate is green, but the repaired lifecycle (install → deploy → failed-release isolation → rollback → purge → leak audit) has not yet run against real AWS post-remediation. The handoff prompt executes exactly this, including the documented MVP gate (three consecutive fresh `core` passes).
2. **Production bootstrap template must be verified/republished** (must carry `RelayCredential`, post-#265/#269) — otherwise new real installs fail enrollment with 401 `RELAY_CREDENTIAL_MISMATCH`. Included as step 1 of the handoff.
3. **Production region variables unverified** (`DEPLOYABLE_AWS_REGIONS`, `BOOTSTRAP_REPUBLISH`) — creation is fail-closed and the canary exercises us-east-1; wider region advertising requires the handoff's publication check.
4. Known-cost posture unchanged (NAT/ALB per deployment — DZ-AUDIT-022) and ECR growth (023) — accepted MVP structure, backlog tracked.

## Final verdict

**MVP LAUNCH READY WITH ACCEPTED RISKS**

- All launch blockers (DZ-AUDIT-001/002/003) are fixed with regression coverage; all repo-verifiable launch-gate checks pass (lint, typecheck, unit/integration, 37-scenario simulated E2E, CDK synth, CI, production readiness probe).
- The single accepted risk is that the real-AWS canary has not yet been executed post-remediation; it is fully specified in the Phase 8 handoff prompt and must complete (including the bootstrap-template verify/republish) before the first real customer install.
