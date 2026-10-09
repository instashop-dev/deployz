# P3-GATE review

- Executor: Opus coordinator, routine run 2026-10-09T17:38Z. Tested commit: baseline `e6a3b58e`. No holdout input.
- Gate (plan.md Phase 3): evidence for every attempt; unsupported and unverified results reported honestly.
- Verdict: **PASS**.

## Completion checks

1. Every one of the 80 apps has first-run analysis evidence and either build/run evidence or a recorded ineligibility reason: **PASS**.
   - `campaign/results/first-run/compat/` has 80 files, all `status: analysed`, all `set: improvement`, AI mode live.
   - `campaign/results/first-run/build/` has 56 `*.local.json` files. Each has all six stage outcomes (gate, source, build, run, probes, cleanup); a FAIL or SKIPPED stage has its reason.
   - The other 24 apps are listed in `campaign/results/P3-BUILD-PLAN/plan.md` with label reasons. Opus checked that each has label and first-run verdict NOT_COMPATIBLE, and that the 56 + 24 ids equal the 80 Stage A ids.
   - All 28 P3-BUILD tasks and 8 P3-COMPAT tasks are COMPLETE with an Opus verification note.
2. Summary uses explicit denominators per stage: **PASS**. `campaign/results/first-run/summary.md` gives a denominator for each stage, probe and cause, and has no overall pass percentage.

## Honest reporting

- Remediated and rerun results (repo-536, repo-513, repo-580) are kept apart and are not in the first-run numbers.
- Harness and environment failures are named and not counted as app results: 6 source FAIL (Windows tar symlinks), repo-513 run FAIL (readiness window), repo-555 and repo-565 build FAIL (Docker environment).
- Unverified items are stated: storage probe 0 verified (4 UNVERIFIED), migration probe never applicable, dbWrite/redis probe failures partly from manifest values the local run did not pass.
- 10 Stage A files stamp analysisVersion 44 (stale `apps/api/dist`); the equivalence check is recorded in P3-COMPAT-01.
- 0 Docker resources with label `deployz-campaign=fresh-100` remain.

## Inputs for Phase 4 (P4-GROUP)

The open findings list in `campaign/handoff.md` ("Next action") and the cause tables in `summary.md` are the input. Main families:

1. Gate false acceptance 28 / 52 NOT_COMPATIBLE labels (many apps with no root Dockerfile or with Dockerfiles that need prebuilt artifacts get NEEDS_CONFIGURATION or READY).
2. Gate false rejection 7 / 28 deployable labels.
3. Live repository AI: 10 timeouts and 13 parse errors in 67 requests.
4. Dockerfile path and build context: harness default `./Dockerfile` when dockerfilePath is null; context differs from what the Dockerfile expects (repo-536, 580, 517); manifest and harness differ (repo-548, 577); template Dockerfile chosen (repo-599).
5. Manifest values not passed to the local run (generatedKeys, database bindings): repo-529, 534, 543, 551; check whether this is a harness defect or a product defect.
6. Migration failures in the run stage (repo-551, 552, 560) and app start failures (repo-502, 510, 514, 523, 564, 566, 573).
7. Harness defects that need a USER DECISION: (a) Windows tar symlinks in the source stage; (b) 90 s dependency readiness window includes the first image pull.
