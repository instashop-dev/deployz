# P2-GATE review

- Reviewer: Opus coordinator (routine run 2026-10-08T23:58:06Z).
- Tested commit (baseline): `e6a3b58e`. Harness commit: `64f3d534` (no `scripts/`, `docs/` or `package.json` change between `64f3d534` and HEAD `cbe59c0a`).
- Gate: "Smoke run works; no new testing framework".

## Verdict: PASS, with Phase 3 conditions

## Evidence checked

1. Smoke run works. `campaign/results/P2-SMOKE-RUN/result.json` (verified by Opus on 2026-10-08):
   - Stage A `--ai live` wrote 2 result files (repo-530, repo-540), 1 live AI request each, with the deployed model. `--resume` kept both entries without an AI call.
   - Local Stage B (`--local`) ran all stages for repo-556 (gate, source, build, run, probes, cleanup) and recorded a build failure for repo-530 with the log tail.
   - Interrupt during probes, then `--resume`: gate, source and build were skipped with identical timings; leftovers were reconciled; a second `--resume` gave a byte-identical file.
   - 0 labelled containers, networks, volumes or images remain. I checked again in this run: `docker image ls --filter label=deployz-campaign=fresh-100` returns 0.
2. No new testing framework. `git diff e6a3b58e..HEAD` outside `campaign/` changes only the existing harnesses `scripts/repository-compatibility/` and `scripts/repository-deployment/` (new modules `ai-mode.ts`, `local-build.ts`, `local-run.ts`, `local-results.ts` with vitest tests), `docs/testing/compatibility.md`, `.gitignore` and the worker definition. No `package.json` or `pnpm-lock.yaml` change, no new dependency, no new runner.

## Measured durations (used to size Phase 3)

| Stage | Measured | Source |
| --- | --- | --- |
| Stage A, live AI | 77 s for 2 apps (about 40 s per app); AI latency 11.3 s and 25.1 s | P2-SMOKE-RUN stage-a |
| Stage A, `--resume` of finished entries | 10 s for 2 apps | P2-SMOKE-RUN |
| Stage A, AI off (cache fill) | 20 s for 1 app | P2-SMOKE-RUN |
| Local gate + source | 2.5-4.5 s | repo-556, repo-530 |
| Local build | 321 s (FAIL, network) and 375 s (PASS) | repo-530, repo-556 |
| Local run | 15 s | repo-556 |
| Local probes | 301 s when health fails (300 s health timeout) | repo-556 |
| Local total per app | 332 s (build fail) to 697 s (full, health fail) | local-summary.md |

Sizing:
- `P3-COMPAT-nn` (10 apps each): about 7 min of Stage A with live AI. The 30 min timebox is sufficient. More than one batch can run in one routine run.
- `P3-BUILD-nn`: plan 2 apps per task (worst case 2 x 11.6 min = 23 min), timebox 30, resumable with `--resume` and a `stopBy`. Use 3 apps only when all 3 are small builds with no database.

## Gaps and decisions

1. `--deploy-config` with a non-default `--benchmark` (`scripts/repository-deployment/index.ts:769-772`; the guard at `:169-171` does not require it). The harness stops with exit 2 and a clear message, so this is not a silent error. Decision: no harness change now. `P3-BUILD-PLAN` creates `campaign/corpus/deploy-config.yaml` with the normal vendor configuration per eligible app (the values a vendor would enter after the readiness report; no secret values), and every `P3-BUILD-nn` passes `--deploy-config campaign/corpus/deploy-config.yaml`. The guard improvement is a post-MVP harness item.
2. `--local` reads Stage A snapshots offline. The cache is the default `CACHE_DIR`, which does not depend on `--runs-dir`. `P3-COMPAT-nn` fills it for all 80 apps. `P3-COMPAT-nn` and `P3-BUILD-nn` must not pass a different `--cache`.
3. The smoke local run used `--ai off`. Local mode runs the analysis again with the `--ai` mode, and the frozen baseline AI mode is production-equivalent. Decision: every `P3-BUILD-nn` uses `node --env-file=.env ... --local --ai live`. The harness refuses to mix AI modes in one runs directory.
4. repo-530 build failure: `ESOCKETTIMEDOUT` from `registry.yarnpkg.com` after 3 retries. The build has network access, so this is not a harness network block, but it is not clearly a repository defect. Decision: `P3-BUILD-nn` retries a build once when the log tail shows only registry network timeouts. If it fails again, classify it as an environment failure (separate denominator), not a repository or Deployz failure.
5. repo-556 probes FAIL (health 404 on `/heartbeat`, no database rows). The health path came from analysis because the deploy config was empty. This is a first-run result for Phase 4 triage, not a harness defect.
6. SeaweedFS storage path not exercised. The first improvement app with a storage probe in `P3-BUILD-nn` is the first real check. `P3-BUILD-PLAN` puts one storage app in an early build task and records the result. If the storage probe fails because of the harness, that is a harness defect for Phase 4.
7. Resume equality was checked against a second resume, not an uninterrupted run. Accepted: the skipped stages kept their timings and evidence, which is the property Phase 3 needs.

## New blocker for builds (not for Stage A)

Free disk on C: is 7.1 GiB on 2026-10-09T00:00Z (13.94 GiB after P0-ENV-SETUP). Docker reports 2.62 GB reclaimable build cache and 0.49 GB unused images, which are not campaign-labelled. The capability `disk>=10GB` is now UNAVAILABLE. `P3-COMPAT-nn` does not need it. `P3-BUILD-PLAN` must make every `P3-BUILD-nn` require `disk>=10GB`. Before Phase 3 builds, the user must free disk space on C: (the coordinator does not delete non-campaign Docker data or user files).
