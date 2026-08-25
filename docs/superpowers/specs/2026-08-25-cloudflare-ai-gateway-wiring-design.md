# Cloudflare AI Gateway wiring — design

Date: 2026-08-25

## Problem

The Cloudflare AI Gateway integration exists as code but is entirely unwired.

- `createCloudflareAiGateway()` has zero callers. `explainCompatibility` and
  `explainDiagnostic` have zero callers outside their own tests.
- `GET /api/deployments/:id/diagnostics` returns four hardcoded strings, so the
  web `DiagnosticCard` always renders `EXPLANATION_FALLBACK`.
- `CLOUDFLARE_AI_GATEWAY_ENDPOINT` / `_API_TOKEN` are shipped into the API
  Lambda's environment by `collectEnvVars()`, but `apps/api/src/env.ts` — the
  single place the API reads `process.env` — never reads them. The only reader
  lives in `@deployz/cdk`, which the Lambda bundle does not reach.
- Neither var is documented in `.env.example`.
- Only `Authorization: Bearer` is sent, so an authenticated gateway 401s.
- The "spend limit" caps nothing: `generateObject` receives no
  `maxOutputTokens`, and the prompt budget reuses the same number as the total
  budget, so a prompt truncated to the ceiling guarantees
  `SpendLimitExceededError` once any completion arrives.

## Decisions

| Question | Decision |
| --- | --- |
| When is the explanation generated? | Lazily, on the first diagnostics request for a FAILED deployment |
| Where is it stored? | On the immutable deployment attempt (`deployment_jobs`) |
| Concurrency | At most one model invocation, enforced by an atomic claim |
| First request | Awaits generation under a hard 10s timeout, falls back to deterministic text |
| Endpoint | Unified `/compat` endpoint |
| Model | `workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731` (config-driven default) |
| Auth | Authenticated gateway: two secrets on two headers |
| Gateway features | None for MVP — no `cf-aig-cache-ttl`, no `cf-aig-metadata` |

Deployment execution persists only deterministic failure evidence and never
depends on AI generation. A failed AI diagnostic never affects deployment
status and is retried on a later diagnostics request.

## 1. Package layout

`apps/api` cannot import `@deployz/cdk` — `cdk` already depends on `api`, so the
import would cycle. `@deployz/analysis` exists to break exactly this, and
`rules.ts` / `detectors.ts` / `analyser.ts` already follow the pattern: real
code in `@deployz/analysis`, a thin re-export barrel left in
`packages/cdk/src/analysis/`.

Four units move to `packages/analysis/src/`:

| File | Purpose | Source |
| --- | --- | --- |
| `failure-codes.ts` | `FAILURE_CODES`, `FailureCode`, `StructuredEvent` | top of `failure-classifier.ts` |
| `ai-gateway.ts` | Gateway seam, config, token budget, errors | `ai-explainer.ts` |
| `diagnostic-explainer.ts` | `explainDiagnostic`, schema, prompt builder | moved as-is |
| `remediation.ts` | `getRemediation()` deterministic fallback | moved as-is |

`failure-classifier.ts` stays in `@deployz/cdk`: it imports `jobs/preflight.js`
and is relay-side logic. The API reads a persisted failure code rather than
classifying one. It re-exports the vocabulary from `@deployz/analysis` so there
remains exactly one definition.

`@deployz/analysis` gains `ai`, `@ai-sdk/openai-compatible`, and `zod` as real
dependencies.

### Out of scope

`explainCompatibility` (the readiness path) is ported onto the fixed gateway
seam and keeps its tests, but is not wired into any route.
`apps/web/src/lib/readiness.ts` documents that omission as deliberate. Wiring it
is a follow-up, not part of this change.

## 2. Configuration

`apps/api/src/env.ts` gains an `aiConfig` block:

| Variable | Purpose |
| --- | --- |
| `AI_GATEWAY_BASE_URL` | `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/compat` |
| `AI_MODEL` | defaults to `workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731` |
| `AI_PROVIDER_API_KEY` | sent as `Authorization: Bearer …` (upstream provider key) |
| `AI_GATEWAY_TOKEN` | sent as `cf-aig-authorization: Bearer …` (gateway's own token) |

The two secrets are distinct and travel on distinct headers. `collectEnvVars()`
in `deployz-stack.ts` replaces the two `CLOUDFLARE_AI_GATEWAY_*` keys with these
four, and all four are documented in `.env.example`.

Missing configuration still produces the throwing stub, but the API logs one
warning at startup rather than degrading silently.

## 3. Persistence and single-flight

New columns on `deployment_jobs`, plus an `ai_explanation_state` pgEnum:

| Column | Type |
| --- | --- |
| `ai_explanation_state` | `PENDING` \| `GENERATING` \| `READY` \| `FAILED`, default `PENDING` |
| `ai_explanation_what` | text, nullable |
| `ai_explanation_why` | text, nullable |
| `ai_explanation_fix` | text, nullable |
| `ai_explanation_claimed_at` | timestamptz, nullable |
| `ai_explanation_generated_at` | timestamptz, nullable |

At-most-one-invocation comes from an atomic conditional UPDATE, which behaves
identically on Postgres and the PGlite dev database (unlike advisory locks):

```sql
UPDATE deployment_jobs
SET ai_explanation_state = 'GENERATING', ai_explanation_claimed_at = now()
WHERE id = $1
  AND (ai_explanation_state IN ('PENDING', 'FAILED')
       OR (ai_explanation_state = 'GENERATING'
           AND ai_explanation_claimed_at < now() - interval '5 minutes'))
RETURNING id
```

The winner generates. Losers receive zero rows and return deterministic text
immediately — no second model call and no waiting. The staleness clause
reclaims rows orphaned by a Lambda that died mid-generation, which would
otherwise pin `GENERATING` forever.

## 4. Request flow

`GET /api/deployments/:id/diagnostics`:

1. Deployment is not `FAILED` — unchanged null response.
2. State is `READY` — serve the stored what/why/fix. No gateway call.
3. Claim succeeds — build a `StructuredEvent` from the persisted `failureCode`
   and event-log rows, then `await explainDiagnostic(...)` under a 10s
   `AbortSignal`. On success persist the text and set `READY`. On any failure
   set `FAILED` and return `getRemediation()` text.
4. Claim fails — return `getRemediation()` text immediately.

No path writes the deployment's own state. Generation failure is retryable on
the next request. `getRemediation()` improves on the current
`'Deployment failed'` placeholder even when AI is disabled entirely.

## 5. Token budget

One number currently serves as both prompt budget and total budget, and nothing
caps the request upstream. Split into:

- `MAX_PROMPT_TOKENS` (700) — governs truncation only.
- `MAX_OUTPUT_TOKENS` (300) — passed to `generateObject` as `maxOutputTokens`,
  a real cap the provider enforces.
- The post-hoc total check remains as a backstop at the sum of the two.

## 6. Testing

Written test-first:

- Both auth headers are present and carry distinct values.
- Missing configuration yields a stub that throws `AiGatewayNotAvailableError`.
- Two concurrent diagnostics requests produce exactly one `generate` call.
- Gateway failure sets `FAILED`, leaves deployment state untouched, and the
  next request retries successfully.
- Timeout returns deterministic fallback text.
- A `READY` row serves stored text with zero gateway calls.
- A stale `GENERATING` row is reclaimed after the interval.
- `maxOutputTokens` reaches the SDK.
- An oversized prompt truncates to the prompt budget, not the total budget.
- The existing §20 verdict-guard and `.strict()` schema tests pass against the
  moved seam.

## Known risk

`@cf/deepseek-ai/deepseek-v4-flash-0731` could not be confirmed against the
Workers AI catalogue in the documentation snapshot consulted (which lists
`@cf/deepseek-ai/deepseek-r1-distill-qwen-32b`). The catalogue moves faster than
the docs, so the id may well be live. The model id is pure configuration, so a
wrong value is a one-variable fix, and the failure path degrades to
deterministic text rather than breaking the page.
