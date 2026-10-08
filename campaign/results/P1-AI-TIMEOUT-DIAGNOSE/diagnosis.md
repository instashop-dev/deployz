# P1-AI-TIMEOUT-DIAGNOSE

Tested commit: `18c06ea7` (product code equal to baseline `e164b7af`; only campaign files differ).
Configuration: worktree `.env`, equal to the deployed production API Lambda for `AI_GATEWAY_BASE_URL`, `AI_PROVIDER_API_KEY` and `AI_MODEL`. Values were loaded by the process and never printed.
Probe: `packages/analysis/dist` (`createAiGateway`, `analyseRepositoryWithAi`, `explainDiagnostic`) with a timing `fetch` wrapper. Input: the same monorepo-shaped input as `packages/analysis/test/ai-live.test.ts`. Data: `timings.json`.

## Result

| Run | Options | Outcome | Total | Per attempt (HTTP status, time, finish reason, completion tokens, content chars) |
|---|---|---|---|---|
| control `explainDiagnostic` | default | ok | 17.1 s | 200, 16.9 s, stop, 397, 468 |
| repo AI 1 | production (reasoning on, 2500 tokens, 2 attempts), 120 s cap | `AI_NoObjectGeneratedError` | 66.7 s | 200, 33.4 s, length, 2500, 0 · 200, 32.8 s, length, 2500, 0 |
| repo AI 2 | same | `AI_NoObjectGeneratedError` | 73.1 s | 200, 34.8 s, length, 2500, 0 · 200, 37.8 s, length, 2500, 0 |
| repo AI 3 | same | `AI_NoObjectGeneratedError` | 68.4 s | 200, 34.3 s, length, 2500, 0 · 200, 33.6 s, length, 2500, 0 |
| repo AI budget | production options, 30 s cap (`REPO_AI_TIMEOUT_MS`) | `TimeoutError` (abort) | 30.0 s | aborted during attempt 1 |
| repo AI reasoning off 1 | `reasoning: false`, 120 s cap | ok | 15.8 s | 200, 15.8 s, stop, 522, 1908 |
| repo AI reasoning off 2 | `reasoning: false`, 120 s cap | ok | 19.8 s | 200, 10.2 s, stop, 547, 2005 (rejected, retried) · 200, 9.0 s, stop, 547, 2006 |

The gateway log line reported the configured model in every run.

## Classification

- **Authentication: ruled out.** Every request returned HTTP 200. The control call and the reasoning-off calls succeeded with the same key.
- **Routing / URL: ruled out.** All requests reached the gateway host and the configured model answered.
- **Provider latency: contributing, not the root cause.** With reasoning on, each attempt takes 33–38 s. This is longer than the whole 30 s budget, so production can never finish even one attempt.
- **Response parsing: the root cause.** With reasoning on, the model spends all 2500 completion tokens on `reasoning_content` (`finish_reason: length`, 0 content characters). No JSON is produced, so `generateObject` throws `AI_NoObjectGeneratedError`. This happened in 6 of 6 attempts. A longer timeout does not help: unbounded runs failed after 67–73 s.
- **Cancellation: symptom only.** The 30 s abort works as designed (`TimeoutError` at 30.0 s). It hides the parsing failure because the first attempt has not returned yet.

Consequence for production: the repository AI fallback probably never succeeds now. Every analysis that has an unresolved question waits 30 s, then falls back to deterministic metadata with a warning.

With `reasoning: false` the same call succeeds in 9–16 s per attempt with about 550 completion tokens. In one run the first answer was rejected (schema or parse) and the retry passed; the total was still 19.8 s.

## Production budget chain

- Analysis runs on the worker Lambda through the job queue (`ANALYSE_APPLICATION`; `apps/api/src/server.ts:3798`). Worker timeout 15 min (`packages/cdk/src/worker-lambda.ts:48`); queue visibility 15 min (`packages/cdk/src/deployz-stack.ts:117`). The API Lambda (30 s) runs analysis inline only when no queue exists (local development).
- The AI fallback has a total budget of `REPO_AI_TIMEOUT_MS = 30_000` (`packages/analysis/src/repository-ai.ts:53`), set in `applyAiFallback` (`apps/api/src/analysis.ts:757`).
- Gateway: 2 attempts by default (`DEFAULT_MAX_ATTEMPTS`), 500 ms backoff. No `attemptTimeoutMs` and no `reasoning` option for repository analysis. `fix-instructions.ts` and `release-build-failure.ts` already pass `reasoning: false`.
- `packages/analysis/test/ai-live.test.ts` uses the same 30 s test timeout.

## Recommendation for P1-AI-TIMEOUT-FIX

1. Pass `reasoning: false` for the repository-analysis call in `analyseRepositoryWithAi`, the same pattern as the other synchronous AI calls. This is one root cause: the reasoning budget uses up the output tokens.
2. Keep `REPO_AI_TIMEOUT_MS` at 30 s. The measured 9–16 s per attempt (19.8 s with one retry) fits inside it. A larger budget is not necessary and does not fix the reasoning-on failure.
3. Add a deterministic unit test that `analyseRepositoryWithAi` sends `thinking: false` (request-body assertion with an injected `fetch`, as in the existing gateway tests). Then the live test must pass 2/2.
4. Update the authoritative AI doc (`docs/ai-analysis.md`). AI fallback output can change (it can now succeed), so apply the ANALYSIS_VERSION bump rule.
5. Check the answer quality without reasoning on the live test and in Phase 3. If quality is not good enough, that is a separate finding, not a reason to restore a setting that always fails.
