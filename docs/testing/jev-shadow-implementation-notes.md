# Jev Shadow Evaluation — Implementation Notes (Phase 0)

Date: 2026-09-20 · Branch: `omos/jev` · Scope: shadow-mode Jev experiment, zero production impact.

## 1. Existing flow (verified against code)

- **Analysis**: `POST /api/applications/:id/analyse` (`apps/api/src/server.ts:3067`) sets `ANALYZING`, enqueues `ANALYSE_APPLICATION` (SQS; inline fallback without queue). Worker (`packages/cdk/src/lambda/worker.ts:602`) runs `runApplicationAnalysis` (`apps/api/src/analysis.ts:208`): GitHub tree/blob fetch (`apps/api/src/github.ts:980`) → deterministic detectors (`packages/analysis/src/analyser.ts`) → AI fallback fills only unresolved questions → readiness report → `buildApplicationAnalysis` projection → persist `COMPLETE`. Statuses: `PENDING|ANALYZING|COMPLETE|FAILED`.
- **Requirements**: there is no `ApplicationRequirements` type. Resource requirements are manifest booleans — `database.postgres`, `redis.required`, `storage.required` (`packages/contracts/src/manifest.ts:147-175`) plus vendor overrides (`deploymentManifestOverridesSchema`). Vendor summary is `ApplicationRequirementsSummary {detected, effective, overridden}` (`manifest.ts:243-268`, computed at `apps/api/src/server.ts:991`).
- **Plan**: pure builders `buildInstallPlan` / `buildUpdatePlan` / `buildDestroyPlan` (`packages/contracts/src/plan.ts:104+`). Plans are derived on demand at read routes and never stored.
- **Failure handling**: relay result route (`server.ts:6446`) → `refineFailureCode` (`apps/api/src/failure-classification.ts:71`) sharpens `REFINABLE_CODES`; unmatched input stays `UNKNOWN`. Watchdog `failStuckJob` (`worker.ts:808`) also produces `UNKNOWN` after exhausted re-offers. The diagnostics route calls the AI explainer only for `UNKNOWN` (`apps/api/src/ai-explanation.ts` — existing shadow-safe AI precedent).

## 2. Exact integration points

- **IP-1 Requirements/plan verifier**: fire-and-forget call after `buildApplicationAnalysis` inside `runApplicationAnalysis` (`apps/api/src/analysis.ts:318-331`), before the persist step. All inputs are in memory: findings, ambiguities, evidence, manifest requirements, bindings. For plan consistency, the shadow step calls the pure plan builders itself with the same inputs — no hook in the plan read path. Writes only to its own telemetry table.
- **IP-2 Unknown-failure classifier**: result route after `refineFailureCode` when the effective code stays `UNKNOWN` (`server.ts:6512`), guarded by settle-once (run only when the job actually settles). Secondary: watchdog `failStuckJob` for timeouts that never reach the result route. Writes only to its own telemetry table.
- **Never touched**: `analysisStatus`, `compatibilityStatus`, `detectedMetadata`, manifest, plan routes, deployment state machine, relay commands, retries, health, destroy, cleanup, customer copy.

## 3. Reusable components

- AI gateway conventions: `packages/analysis/src/ai-gateway.ts` (auth headers, retry/backoff, per-attempt timeout, token caps, one structured log line); fixture pattern `apps/api/src/ai-fixture.ts`.
- Env flag pattern: `apps/api/src/env.ts` (parse once into `env`, default off, warn on partial config). Env forwarding: `packages/cdk/src/deployz-stack.ts` `collectEnvVars`.
- Typed evidence read-model: `packages/analysis/src/evidence.ts` (`RepositoryEvidence`, `EvidenceItem`, ambiguities).
- Persistence pattern: drizzle `pgTable` + numbered SQL migration; `ai_explanation_cache` (migration 0009) as the precedent for a new AI telemetry table.
- Evaluation tooling: `pnpm benchmark:compat` 120-repo pinned corpus (`docs/testing/repository-compatibility/benchmark.yaml` + `runs/`), `packages/analysis/test/eval-corpus.test.ts`, simulated E2E scenario framework, `pnpm test:affected` escalation.

## 4. Minimum changes (PR 1)

- `packages/analysis/src/jev/`: `client.ts` (gateway custom-provider URL, `Authorization` + optional `cf-aig-authorization` headers, `AbortController` timeout, bounded retry on 429/529/5xx/network, latency + usage capture, single structured log line), `schemas.ts` (strict zod request/response), `errors.ts` (typed error kinds), `circuit-breaker.ts` (consecutive-failure bypass window), fixture client for tests.
- Config/flag: `JEV_ENABLED` (default false), `JEV_GATEWAY_URL`, `JEV_API_KEY`, `JEV_MODEL` (default `jev-latest`), `JEV_TIMEOUT_MS`; partial config ⇒ disabled with warning. `.env.example` + `collectEnvVars`.
- Evidence model: `packages/analysis/src/jev/evidence.ts` — normalized facts, sanitizer, sha256 fingerprint, `evidenceSchemaVersion`.
- Unit tests under `packages/analysis/test/`.

## 5. Adaptations vs the original task prompt

- **Jev routes through the existing OpenRouter-via-Cloudflare-AI-Gateway setup.** OpenRouter exposes Jev's native typed Decisions API (`POST /api/alpha/decisions`, model `typesafe/jev-1.13`, same noul/choice/score primitives as TypeSafe's direct `/v1/systemone`). The client targets `{gateway}/openrouter/alpha/decisions` (Cloudflare provider-native passthrough) — no TypeSafe custom-provider registration and no second API key; it reuses the OpenRouter key and the optional `cf-aig-authorization` gateway token. Response extras (`id`, `provider`, `usage.cost`) are captured; unknown fields stay rejected. Verified against OpenRouter's live model listing and API reference (2026-09-20); the gateway passthrough for the `/alpha/` path still needs one live confirmation call before the corpus run.
- **No required/recommended/optional tiers exist.** Deployz requirements are booleans. Jev answers `noul` (yes/no probability) per capability plus `choice`/`score` for consistency questions. Jev probabilities are telemetry only; Deployz policy stays the only place where requirement levels could ever be set — not done in this experiment.
- **Corpus is 120 pinned repos, not 100.** Stage A (`pnpm benchmark:compat`, offline, cached snapshots) is the primary offline evaluation vehicle; its `expected:` facts and historical `runs/` records ground the labelled set.
- **Real AWS E2E reduced from 5–8 to 2 repositories** (user decision, 2026-09-20). Max 2 concurrent deployments still applies.
- `decisionSetVersion` ships with PR 2 (requirements questions) and PR 3 (failure questions).
- **Jev API facts** (docs.typesafe.ai, 2026-09-20): request `{state, model, questions{id: {type: noul|choice|score, criteria, instructions}}}`; response `{model, answers{id: {type, noul?|choice?+probabilities+confidence|score?+legend+probabilities+confidence}, usage{input_tokens, output_tokens}}`; errors 401/422/429/529; `jev-latest` → `jev-1.13.0`; pricing $0.042/M input tokens, output free; state limit 32k tokens.
