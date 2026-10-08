# P1-AI-TIMEOUT-FIX review (Opus)

PR: https://github.com/instashop-dev/deployz/pull/498
Reviewed head SHA: `366d3f5b9eefc1cedd3cfcfa8675d7f1232d8122` (base `origin/main` `e164b7af`).
A merge is valid only for this SHA. Any new push needs a new review.

## Diff (5 files, +43/-11)

- `packages/analysis/src/repository-ai.ts`: `reasoning: false` on the repository-analysis `generate` call. One root cause (reasoning used all output tokens). Same option as `fix-instructions.ts` and `release-build-failure.ts`. `REPO_AI_TIMEOUT_MS` (30 s), output budget and retry count are unchanged.
- `packages/analysis/test/repository-ai.test.ts`: one test asserts `reasoning === false` on the gateway options. Only the new test is added; no other line changed (non-UTF-8 comment bytes kept).
- `packages/analysis/test/ai-live.test.ts`: env-gated test only; assertions follow the current `repositoryAiSchema` field objects (from #187). It still asserts structure, not wording. It is skipped in CI.
- `apps/api/src/analysis.ts`: `ANALYSIS_VERSION` 44 → 45 with a version note. Effect: stored rows show `analysisOutdated`; nothing re-runs by itself (docs/ai-analysis.md commit-cache rule).
- `docs/ai-analysis.md`: AI fallback section states thinking off and the 30 s budget.

## Checks

- No secret, URL or key in the diff. No change to relay, compiler, CDK or templates.
- Deployment effect: Deploy API runs after merge (path filter `apps/api/*`, `packages/analysis/*`). No AWS escalation required (`test-affected --escalation`).
- Risk: lower answer quality without reasoning is possible; Phase 3 measures it. First-answer rejection and retry was seen in some live runs; tracked separately, not a blocker for this fix.

Verdict: APPROVED for merge at `366d3f5b`, when every required check on that SHA is SUCCESS (policy.publication.mergeProcedure).
