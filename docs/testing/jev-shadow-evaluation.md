# Jev Shadow Evaluation — Final Report

Date: 2026-09-20 · Branch: `omos/jev` · PRs: #331 (foundation), #332 (requirements verifier), #333 (failure classifier), #33x (this evaluation)
Implementation notes: [`jev-shadow-implementation-notes.md`](./jev-shadow-implementation-notes.md) · Run evidence: [`jev-shadow/runs/`](./jev-shadow/runs/)

## Verdict

**REMOVE / DO NOT ADOPT.**

Jev duplicated the deterministic Deployz analyzer on every labelled decision (0 disagreements in 360 decisions across 120 repositories), produced non-discriminative consistency signals, and misclassified every ground-truth-verifiable failure case — most of them with high confidence. It added latency, routing complexity, and one operational incident, and provided no reliability signal in return. Recommendation: keep the merged code with `JEV_ENABLED=false` (default; zero runtime impact), remove the Cloudflare custom providers if desired, and do not wire Jev into any production decision path.

## Architecture implemented

Exactly as planned in the implementation notes — facts, inference, then shadow-only Jev verification:

- Deterministic analyser output → canonical sanitized evidence (`evidenceSchemaVersion` 1) → Jev typed questions (`decisionSetVersion` 1) → normalized result → append-only telemetry. Jev may interpret evidence; it never determines policy, mutates state, or faces customers.
- Failures: deterministic `refineFailureCode` first; only codes that stay `UNKNOWN` reach the Jev shadow classifier (fire-and-forget after settlement, settle-once guarded; watchdog hook for timeout failures).
- Shadow safety proven by tests: with JEV enabled (fixture client returning maximally wrong answers), persisted analysis results, manifests, plans, deployment state, and event payloads are byte-identical to a disabled run; Jev errors of every kind (timeout, malformed, gateway, unavailable) leave production state identical (`apps/api/src/jev-shadow.test.ts`, `apps/api/src/jev-failure-shadow.test.ts`, `packages/cdk/test/worker.test.ts`).

## Jev / Cloudflare AI Gateway configuration

Every Jev request went through the existing Cloudflare AI Gateway — no direct path was used for any recorded evaluation traffic. The working configuration:

- Gateway custom provider `typesafe-ai` (base `https://api.typesafe.ai`), request `POST {gateway}/custom-typesafe-ai/v1/systemone`, model `jev-latest` (resolves to `jev-1.13.0`).
- Auth: `Authorization: Bearer <TypeSafe API key>` + `cf-aig-authorization` (the account's existing gateway token).

Routing findings (documented for the future):

1. The gateway's built-in `openrouter` provider prefix maps paths to `openrouter.ai/api/v1/…` — it cannot reach OpenRouter's Decisions endpoint (`/api/alpha/decisions`).
2. A custom provider rooted at `https://openrouter.ai` proxies `/api/v1/*` correctly but misroutes `/api/alpha/*` to OpenRouter's website (Cloudflare custom-provider beta limitation, reproduced with clean bodies; provider `openrouter-decisions` remains registered but unused).
3. BYOK-stored keys do not inject for custom providers; the key must be sent as `Authorization`.

## Corpus tested (offline, live Jev)

All 120 pinned repositories from `repository-compatibility/benchmark.yaml` (sets `improvement` + `unseen2`), analysed through the production analysis path at Deployz commit `4c34c84`, one live Jev call each: **120/120 successful, 0 errors**. Latency p50/p90/p99 = **490 / 1415 / 1901 ms**. Tokens: **538,513 input / 32,772 output** ≈ **$0.023** (input-only pricing; output free).

### Decisions evaluated

- Capability noul questions (labelled against corpus `expected` facts): postgres, redis, storage. Unlabelled informational: publicHttp, worker.
- Consistency questions: missing dependency (choice), evidence conflict (choice), internal consistency (choice), plan consistency (choice), deserves-deeper-review (score).

### Confusion per requirement — Jev vs Deployz vs ground truth

| Decision | Deployz TP/FP/FN/TN | Jev TP/FP/FN/TN | Agree / Disagree / Uncertain |
| --- | --- | --- | --- |
| postgres | 82 / 7 / 9 / 22 | 82 / 7 / 9 / 22 (identical) | 120 / 0 / 0 |
| redis | 22 / 28 / 4 / 66 | 22 / 28 / 4 / 66 (identical) | 120 / 0 / 0 |
| storage | 31 / 19 / 11 / 59 | 31 / 19 / 11 / 59 (identical) | 119 / 0 / 1 |

**Jev is an echo.** It repeats every Deployz error against ground truth — including all 28 redis false positives (e.g. umami, kutt, automatically: Deployz provisions Redis the corpus says is not needed; Jev agrees with probability 0.94). The single non-agreement is one `uncertain` (repo-079, storage probability 0.44).

### Consistency signals — no discrimination

| Signal | Repos flagged (of 120) | Assessment |
| --- | --- | --- |
| possibleMissingRequirements | 7 | unverified precision; no overlap with actual failures observed |
| evidenceConflict ≠ none | 0 | never fires |
| requirementsConsistency = contradictory | 3 | no correlation with the 60 mismatch repos |
| planConsistency ≠ consistent | 42 | noise — the plan is a pure function of the requirements and cannot genuinely contradict them |
| reviewSignal = needed / worth-review | 114 / 6 | flags 95% of repos; 60/60 mismatch repos flagged but base-rate lift ≈ 0 (prevalence 50%) — a review signal that fires everywhere selects nothing |

Stratification: A=11, **B (meaningful disagreement)=0**, C=1, D=95, E=13.

### Missing requirements caught; incorrect warnings

Zero missing deployment-critical requirements were caught (none flagged on the 9 postgres-FN / 4 redis-FN repos where Deployz under-provisions). Incorrect warnings: the 7 `possibleMissingRequirements` flags and 114 `reviewSignal=needed` flags carry no measurable precision; nothing was confirmed by ground truth.

## Real AWS E2E

Scope reduced from 5–8 to 2 repositories (user decision, 2026-09-20). Max-2-concurrency respected (2 concurrent).

Selection and why:

- **repo-001 (umami)** — PostgreSQL + Redis, high realism, and the highest-information requirements case: Deployz provisions Redis while the corpus label says it is not required; Jev agreed with Deployz (0.94).
- **repo-004 (miniflux)** — custom Dockerfile + custom port + health path overrides; clean baseline variant.

Outcome comparison: historical full-funnel Stage B records at the same pinned commits show both repositories deploy **PASS** end-to-end (build → install → HTTPS-healthy → destroy → zero leaks), including umami healthy with the (arguably unnecessary) Redis provisioned — i.e. Deployz's redis FP is benign-but-costly, and Jev's agreement provides no additional information about deployment success. My re-run reached `CREATE_COMPLETE` installs for both and then **the Stage-B runner crashed during the VERIFYING phase** (existing tooling, unmodified by this experiment), skipping health verdicts and cleanup. Consequences were contained:

- repo-001: destroyed cleanly through the product's `--cleanup` (Disconnect/Purge, leak audit clean).
- repo-004: the control plane no longer had the deployment row (404), orphaning its stacks; manual dependency-ordered teardown followed (RDS deletion protection disabled, DB instance and subnet group removed, the stack's dead CloudFormation creation role recreated via a temporary helper stack so the stack delete could run, then the helper removed). Final inventory: **zero live stacks from this experiment** (only the shared `Deployz` control-plane stack remains).
- Flagged, not deleted (pre-date this experiment, us-east-2, from the 2026-09-18 campaign): `deployz-app-b22e643c` (ROLLBACK_COMPLETE), `deployz-bootstrap-crypto-bf6919b4`. One automated RDS snapshot (repo-004 database) self-expires.

Operational lessons recorded: the Stage-B runner must run its cleanup `finally` even when verification crashes; orphaned application stacks whose creation role lived in the bootstrap stack cannot be deleted without recreating that role (product deletion-flow gap worth a backlog item).

## Failure-classification results (131 historical cases, live Jev)

110 "interesting" (deterministic code stayed UNKNOWN — the exact population the classifier exists for) + 21 reference (known codes). All calls successful; latency p50/p90 = **376 / 448 ms**; tokens 107,739 / 20,326 ≈ **$0.005**.

- On the target population, Jev answered **UNKNOWN itself for 67/110 (61%)** and marked 75/110 `classificationUnclear` — no information exactly where signal was needed.
- Where it did name a domain: CUSTOMER_CONFIGURATION=21, DEPLOYZ=8, APPLICATION=8, NETWORK=4, AWS=1, DEPENDENCY=1 — unverifiable against ground truth (these were unknowns), but the reference cases calibrate how much to trust them:
- **Ground-truth check (7 cases with Stage-B root cause `DEPLOYZ_BUG`): 0/7 correct.** Four were confidently wrong (`APPLICATION`, confidence 0.93–0.95); three low-confidence wrong (`AWS`, 0.28–0.35). Confidently-wrong classifications are the worst failure mode for an escalation path.
- `likelyTransient` = false in 131/131 cases — never flags transients.

## Gateway / model failures

None during recorded runs (251/251 calls successful). During setup, routing failures were configuration-stage (documented above): 404s from the openrouter provider path insertion, the custom-provider alpha-path misroute, and 401/403 probe errors — all diagnosed before any evaluation traffic; the circuit breaker and fail-open paths were exercised only in tests, where they behaved as designed.

## Privacy observations

Evidence sent to Jev: normalized facts only — env-var NAMES (never values), dependency names, Docker/DB/cache/storage/worker signals, capped and redacted (`redactText`), mean state ≈ 10k characters, no raw repository content, no secrets (asserted by tests; verified by inspecting recorded states). Requests transited only the Cloudflare gateway. Telemetry tables store fingerprints and probabilities, never prompts.

## Cost summary

Jev API ≈ **$0.03** total (251 calls). AWS E2E: 2 fresh funnels with partial lifetime + destroys (single-digit dollars). The evaluation harness itself is reusable (`pnpm jev:eval --plan|--fixture|--offline`) at ~$0.02 per full corpus pass.

## Why not "continue shadow testing"

The three things shadow testing could still measure — agreement (measured: echo), escalation signal (measured: none; review signal non-discriminative), failure insight (measured: 0/7 on verifiable cases, 61% UNKNOWN on target cases) — are all negative with narrow error bars for the current Jev version (1.13). The deterministic analyzer plus the existing AI fallback already covers the one place a model adds value today (unresolved analysis questions). Re-evaluate only if a future Jev release demonstrates independent calibration on these tasks; the harness makes that a one-command check.
