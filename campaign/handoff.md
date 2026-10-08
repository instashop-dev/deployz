# Fresh-100 campaign handoff

**Status:** CONTINUE. Phase 1. P0-GATE PASS on 2026-10-08.
**Checkout:** `C:/Users/Tejas/Desktop/deployz-mvp-test`, branch `campaign/fresh-100`, tested commit `e164b7af` (equal to `origin/main` on 2026-10-08).
**Eligible now:** `P1-SELECT-REALISTIC-02` (campaign-worker).

## Done

- Setup created `tasks.json` (74 tasks after setup fixes on 2026-10-08, Phases 0–8), `state.json`, this file, `results/` and `.claude/agents/campaign-worker.md`.
- 2026-10-08: `P0-SMOKE` COMPLETE (attempt 1). campaign-worker ran in the foreground with model sonnet. Opus computed the package.json SHA-256 (`fba48ae6…a2ae`) and package name (`deployz`) again; both match. The worker changed only `campaign/results/P0-SMOKE/result.json`. Evidence: `campaign/results/P0-SMOKE/result.json`.
- 2026-10-08: `P0-ENV-SETUP` COMPLETE (attempt 1). `pnpm install --frozen-lockfile` exit 0 (246 s), `pnpm build` exit 0 (385 s, 10/10 turbo tasks). Opus checked again: HEAD is `e164b7af`, `pnpm-lock.yaml` is unchanged, 8 `packages/*/dist` directories exist. Free disk 14.3 GiB before, 13.94 GiB after. Warning only: turbo found no outputs for `@deployz/web#build`. Evidence: `campaign/results/P0-ENV-SETUP/result.json`; raw logs in `campaign/logs/P0-ENV-SETUP/` (ignored).
- 2026-10-08: `P0-BASELINE-CHECKS` COMPLETE (attempt 1). `pnpm typecheck:scripts` exit 0, `pnpm test:static` 13/13, vitest `repository-compatibility` 19/19, `repository-deployment` 131/131, `version-canary` 72/72. No failures. CI on origin/main for `e164b7af` is green. Opus checked the logs again. Note: `vitest --project` takes the directory basename (for example `repository-deployment`), not `scripts/repository-deployment`. Evidence: `campaign/results/P0-BASELINE-CHECKS/`; raw logs in `campaign/logs/P0-BASELINE-CHECKS/` (ignored).
- 2026-10-08: `P0-HARDENING-VERIFY` COMPLETE (attempt 1). All five commits (3c927afb, 38b2d472, 3bc65f9c, 1e639cd9, e164b7af) are ancestors of HEAD; Opus checked this again. 11 targeted vitest files pass, 299/299 tests (relay deploy/config-update/first-start, compiler compile/safety, contracts profile/footprint, analysis compiler-preflight/dockerfile-missing-sources, api compiler-artifact/public-install). The form `pnpm exec vitest run <path>` from the repo root works. Evidence: `campaign/results/P0-HARDENING-VERIFY/result.json`; raw logs in `campaign/logs/P0-HARDENING-VERIFY/` (ignored).
- 2026-10-08: `P0-FREEZE` COMPLETE (Opus). `campaign/baseline.json`: commit `e164b7af`, ANALYSIS_VERSION 44, compiler `dynamic-compiler-v2-5`, profile `small` v2, AI mode `diagnostic-ai-off`, Node v24.14.0, pnpm 10.12.4, Docker 29.8.2 (4 CPU, 3.76 GiB).
- 2026-10-08: `P0-GATE` PASS (Opus). Evidence: `campaign/results/P0-GATE/review.md`. Phase advanced to 1.
- 2026-10-08: `P1-EXCLUDE` COMPLETE (attempt 1, worker sonnet). `campaign/corpus/excluded-families.json` has 143 entries: all 123 benchmark repositories, 19 `instashop-dev` forks and the canary fixture. The check text said 124; the 124th grep hit is a prose line (benchmark.yaml:3092), Opus checked this. Worker family names are unverified; selection must also compare project names, not only owner/repo.
- 2026-10-08: `P1-SELECT-REALISTIC-01` COMPLETE (attempt 1, worker sonnet). `campaign/corpus/candidates/realistic-01.json`: fastapi-fullstack, redash, label-studio, koel, spring-petclinic, shiori, payload (templates/with-postgres), gotenberg, inbox-zero, once-campfire. Opus checked all 10 SHAs again with `gh api` and found no owner/repo or family match in the excluded list. The only gotenberg hit in benchmark.yaml is a Documenso dev-sidecar note. Labeling risks: campfire is SQLite-only (possible boundary case), payload is a subdirectory, koel has no Dockerfile, inbox-zero license is NOASSERTION.
- Phase 3–7 execution tasks are queued by the planning tasks `P3-BUILD-PLAN`, `P4-GROUP`, `P5-PLAN`, `P6-HOLDOUT-BUILD-PLAN` and `P7-PLAN` from measured results.

## Blockers and pending prerequisites

- `ai-gateway` BLOCKED. Correction: the worktree `.env` (ignored) values `AI_GATEWAY_BASE_URL`, `AI_PROVIDER_API_KEY` and `AI_MODEL` are equal to the deployed production API Lambda (read-only check on 2026-10-08). `AI_MODEL` is the deployed production value, not only the code default. `AI_GATEWAY_TOKEN` is not set in production. The configuration is production-equivalent; live validation is pending:
  - The live test (`DEPLOYZ_LIVE_AI=1`, `.env` loaded) gave 1 passed, 1 failed in 3 runs. `explainDiagnostic` passes. `analyseRepositoryWithAi` times out at 30 s. Production uses the same 30 s budget (`REPO_AI_TIMEOUT_MS`), so production repository AI analysis probably times out and falls back too.
  - The Stage A harness uses `createAiGateway(undefined)` (`scripts/repository-compatibility/analyse.ts:76`), so it runs without AI.
  - `P2-IMPL-AI-MODE` connects the harness. The new task `P2-AI-LIVE-VALIDATE` must show 2/2 live tests passing and measure the latency. Only then Opus sets `ai-gateway` AVAILABLE and changes `baseline.aiMode`. Phase 3 first-run and Phase 6 holdout tasks wait for this.
- Phase 7 still needs `deployed-candidate` (the deployed control plane must run the tested candidate).
- Disk: 13.94 GiB free after P0-ENV-SETUP. Prune campaign images after each build batch.

## Publication scope (user authorization, 2026-10-08)

`gates.publicationPolicyConfirmed` is true. Full text: `state.json` `policy.publication`.

- Granted: push `campaign/fresh-100` and `campaign/fix-*`; create and update focused PRs to `main`; publish redacted campaign reports and artifacts through a PR.
- Merge: mandatory coordinator procedure in `policy.publication.mergeProcedure`, because GitHub requires no checks on `main` (the ruleset blocks only deletion and force-push; do not change it). Required check runs on the current PR head: `Plan tests`, `Test and build`, `Simulated E2E (fixture-1/2/3, scenarios)`, `PR Gate`. `Plan tests` and `PR Gate` must be SUCCESS. Others must be SUCCESS, or SKIPPED only when `PR Gate` passed. Missing, pending or failed counts as not passing. Opus reviews the diff of that head SHA and writes `review.md`. Merge with `gh api ... /merge -f sha=<head>`.
- Fix tasks: every generated task that needs push, PR, merge or publication lists gate `publicationPolicyConfirmed` (`tasks.json` `generatedTaskRules`). `P4-GATE`, `P6-FREEZE-CANDIDATE`, `P7-PLAN` and `P8-REPORT` list it now.
- Production: a merge to `main` starts CI, then `Deploy API` (stack `Deployz`, api.deployz.dev, plus bootstrap template republish because `BOOTSTRAP_REPUBLISH=on`) and/or `Deploy web` (app.deployz.dev), when their path filters match. The user authorized these merge-triggered production deploys for approved campaign fixes. Watch these runs after each merge and record the result. If one fails, stop merges and report a release blocker.
- Not granted: force-push, push to `main`, manual `workflow_dispatch` of deploy-api/deploy-web/aws-canary, local `cdk deploy`, local `publish:bootstrap`, repository variable/secret changes, `--production` canary, and any change not from the campaign.
- Staging: none exists.

## AWS scope (user authorization, 2026-10-08)

`gates.awsAuthorized` is true for the planned Phase 7 deployments, day-2 tests and cleanup. Full text: `state.json` `policy.aws`.

- Account `151955775369` (the harness allowlist account) and Region `us-east-1`. `aws sts get-caller-identity` returned this account on 2026-10-08 (root user through `aws login`). Every AWS task checks the identity again first. An expired login is BLOCKED; only the user can log in.
- This account also holds the production control plane (stack `Deployz`) and other installations. Touch only resources that the campaign created and recorded in its ledger. See `policy.aws.protectedResources`.
- No AWS work before `P7-PLAN` queues the AWS tasks. No AWS resources were created during setup.
- Never publish credentials, `.env` values, evidence ledgers, cached corpus source or raw logs. Check the staged diff before each push.

## Next action

The next routine run: delegate `P1-SELECT-REALISTIC-02` to campaign-worker (10 more realistic candidates, `gh api` reads only). Give the worker the excluded list and `campaign/corpus/candidates/realistic-01.json` so it skips those families. Tell it to compare project names too. Ask for more Postgres/Redis/worker apps and fewer SQLite-only apps.
