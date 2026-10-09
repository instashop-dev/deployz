# P4-MERGE-UNBUILDABLE-DOCKERFILE review

- PR: https://github.com/instashop-dev/deployz/pull/502 (branch `campaign/fix-unbuildable-dockerfile`)
- Reviewed headRefOid: `4de9cc796776fdf5ab931ceced415d618b4a41fb`
- Base: origin/main `8f14fddf496de3cb0223842c614a1286cf2b1d45` (unchanged at review time)
- Reviewer: Opus coordinator, routine run started 2026-10-09T19:18:56Z

## mergeProcedure

1. `gh pr view 502 --json headRefOid,statusCheckRollup,mergeable`: head `4de9cc79…`, state OPEN, mergeable MERGEABLE.
2. `Plan tests` SUCCESS and `PR Gate` SUCCESS on the head (also confirmed with `gh api .../commits/<head>/check-runs`).
3. Other check runs on the head: `Test and build`, `Simulated E2E (fixture-1)`, `(fixture-2)`, `(fixture-3)`, `(scenarios)`: all completed/SUCCESS. No skipped check. CI run 37980181617.
4. No missing, pending, failed, cancelled, timed-out, neutral or action-required check.
5. Full diff `8f14fddf..4de9cc79` reviewed (13 files, +224/-7); findings below.
6. Merge with `gh api -X PUT repos/instashop-dev/deployz/pulls/502/merge -f sha=4de9cc79…` (result recorded in state.json mergedPullRequests).
7. CI on main and Deploy API / Deploy web watched; results recorded in state.json and handoff.md.

## Diff review

- Scope: only the F1 fix (`detectUnbuildableDockerfile`, `checkNoBuildableDockerfile`, template detection in `isUnusableDockerfile`, readiness copy `unsupported-no-dockerfile`, `container-setup` suppressed when rejected), the regression test (fixtures, no repository names), the api fixture update, ANALYSIS_VERSION 45 -> 46 with a version note, and docs. No repository-name special case.
- COMP-021 respected: rejection needs the full tracked path list (`TREE_PATHS`), every tracked Dockerfile fetched and no `.gitmodules`; a second candidate Dockerfile, `COPY --from=` and generated top-level directories never reject. Tests cover each guard.
- MVP boundary: the verdict meaning changes (missing/unbuildable Dockerfile NEEDS_CONFIGURATION -> NOT_COMPATIBLE with complete evidence). `docs/product/mvp-scope.md` (Compute row) and `docs/decisions/README.md` (index row and section with "what would change it") are updated. `docs/ai-analysis.md` and findings COMP-042 (COMP-021 marked superseded) are updated; benchmark.yaml registry has COMP-042. COMP-042 is not used on origin/main.
- Vendor copy: new blocking finding title "Has no Dockerfile that builds the app"; web vocabulary test passed in CI.

## Non-blocking notes (follow-up candidates, not merge blockers)

1. `DEV_ONLY_DOCKERFILE_REGEX` matches `dev`/`test`/`ci` as substrings in `*.dockerfile` basenames (for example `social.dockerfile`, `device.dockerfile`). It rejects only when every tracked Dockerfile is dev-only or unusable with complete evidence, so the risk is small; P4-RERUN-COMPAT will show any false rejection on the corpus.
2. `fix-instructions.ts` has no dedicated `unsupported-no-dockerfile` entry; it falls back to the finding title and generic guidance.

Verdict: APPROVE for merge at `4de9cc796776fdf5ab931ceced415d618b4a41fb`.

## Result

- Merged 2026-10-09T19:35Z (squash) as `a197032313e315414a28e1269e4946233dcd5604`; the API accepted the merge only at sha `4de9cc79…`.
- CI on main: run 37981209431 success.
- Deploy web: run 37981932365 success (Build and deploy to Lightsail skipped by path filter).
- Deploy API: run 37981932220 success (Deploy control plane success; bootstrap republish inside that job).
