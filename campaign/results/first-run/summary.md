# First-run summary (Phase 3, improvement set)

- Scope: the 80 improvement apps. No holdout input. Tested commit: baseline `e6a3b58e` (ANALYSIS_VERSION 45, compiler `dynamic-compiler-v2-5`, profile small v2, AI mode production-equivalent = live).
- Stage A evidence: `campaign/results/first-run/compat/` (80 files). Local build/run evidence: `campaign/results/first-run/build/` (56 `*.local.json` files and `local-summary.json`).
- Remediated and rerun results are not in these numbers: `P3-BUILD-01/repo-536.remediated-buildcontext.local.json`, `P3-BUILD-06/repo-513.rerun-source-tar.local.json`, `P3-BUILD-25/remediated/repo-580.local.json`.
- Every number below has its own denominator. There is no single overall pass percentage.

## Stage A: analysis and compatibility (denominator 80)

| Measure | Count |
| --- | --- |
| Analysed | 80 / 80 |
| Label READY / NEEDS_CONFIGURATION / NOT_COMPATIBLE | 5 / 23 / 52 |
| Cohort realistic / messy / boundary | 56 / 16 / 8 |
| Exact verdict match | 41 / 80 |
| Deployable label (28): correct accept / false rejection | 21 / 7 |
| NOT_COMPATIBLE label (52): correct reject / false acceptance | 24 / 28 |

Verdict matrix (label -> Deployz): NEEDS_CONFIGURATION -> NEEDS_CONFIGURATION 16; NEEDS_CONFIGURATION -> NOT_COMPATIBLE 7; READY -> NEEDS_CONFIGURATION 4; READY -> READY 1; NOT_COMPATIBLE -> NOT_COMPATIBLE 24; NOT_COMPATIBLE -> NEEDS_CONFIGURATION 26; NOT_COMPATIBLE -> READY 2.

Live repository AI (denominator 80): completed 44, parse-error 13, timeout (30 s) 10, not requested (deterministic path) 13. Of the 67 requests, 23 did not give a usable AI result.

Note: 10 Stage A files (repo-501..513, P3-COMPAT-01) stamp analysisVersion 44 because `apps/api/dist` was stale. Opus confirmed that the behavior equals the baseline (P3-COMPAT-01 notes). They stay as the first-run sample.

## Build eligibility (denominator 80)

- Eligible: 56 (label or first-run gate READY/NEEDS_CONFIGURATION).
- Ineligible: 24 (label and gate both NOT_COMPATIBLE; reasons in `campaign/results/P3-BUILD-PLAN/plan.md`: local filesystem 18, other database or MongoDB 6, background worker 2, Kubernetes 1, other 1 (repo-561, see its label notes); some apps have more than one reason).

## Local build/run stages (eligible apps)

| Stage | Denominator | PASS | FAIL | Notes |
| --- | --- | --- | --- | --- |
| Gate | 56 | 21 correct accept | 35 (28 false acceptance, 7 false rejection) | False rejections stop at the gate; false acceptances continue |
| Source | 49 (gate accepted) | 43 | 6 | All 6 are the harness Windows tar symlink defect (repo-501, 507, 508, 511, 528, 574), not app results |
| Build | 43 (source PASS) | 19 | 24 | 2 environment failures (repo-555 builder EOF, repo-565 JS heap OOM; Docker memory 3.8 GB) |
| Run | 19 (build PASS) | 15 | 4 | repo-513 harness readiness window (SeaweedFS pull); repo-551, 552, 560 pre-deploy migration exit non-zero |
| Probes | 15 (run PASS) | 2 | 13 | PASS: repo-540, repo-522 |
| Cleanup | 43 (resources created) | 43 | 0 | 13 SKIPPED: nothing created; 0 labelled resources remain |

Split by gate outcome:

| Path | Apps | Build attempted | Build PASS | Run PASS | Probes PASS |
| --- | --- | --- | --- | --- | --- |
| Correct accept | 21 | 19 | 14 | 11 | 1 (repo-540) |
| False acceptance | 28 | 24 | 5 | 4 | 1 (repo-522) |

Full local success (gate, source, build, run, probes all PASS) on a deployable label: 1 / 28 (repo-540).

## Probes (denominator 15 runs)

| Probe | PASS | FAIL | UNVERIFIED | NOT_APPLICABLE |
| --- | --- | --- | --- | --- |
| start | 7 | 8 | 0 | 0 |
| health | 6 | 9 | 0 | 0 |
| migration | 0 | 0 | 0 | 15 |
| dbWrite | 0 | 10 | 0 | 5 |
| redis | 0 | 5 | 0 | 10 |
| storage | 0 | 0 | 4 | 11 |

- No storage probe was verified (4 UNVERIFIED; repo-536, the first planned SeaweedFS probe, failed its build).
- The migration probe is NOT_APPLICABLE in all 15 runs. Migration failures show in the run stage (3 of 19).
- dbWrite 0 / 10 and redis 0 / 5 are not yet app verdicts. Some failures come from manifest values that the local run did not pass (repo-529 APP_KEY, repo-534 SPRING_DATASOURCE_*, repo-543 DATABASE_*), and some from probe applicability (repo-530 lazy Redis connect, repo-557 no tables). Phase 4 must separate harness defects from product defects.

## Build failure causes (denominator 24)

| Cause | Apps |
| --- | --- |
| No Dockerfile at the path built (manifest dockerfilePath null, harness built `./Dockerfile`) | 505, 515, 518, 525, 579, 585, 588, 590, 596 |
| Dockerfile needs prebuilt artifacts | 517, 544, 559, 575, 577 |
| Build context differs from what the Dockerfile expects | 536, 580 |
| Required build argument not supplied | 548, 549 |
| Dockerfile is a template | 599 |
| Base image tag does not exist | 593 |
| Toolchain version (go >= 1.26) | 550 |
| Native dependency (psycopg2 needs pg_config) | 524 |
| Environment (separate denominator) | 555, 565 |

Harness Dockerfile selection differs from the manifest for repo-548 and repo-577; repo-517 build context differs from the manifest.
