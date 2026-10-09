# P4-GROUP: first-run failures grouped by root cause

- Executor: Opus coordinator, routine run 2026-10-09T17:52Z. Tested commit: baseline `e6a3b58e` (ANALYSIS_VERSION 45). No holdout input.
- Inputs: `campaign/results/first-run/compat/` (80), `campaign/results/first-run/build/` (56 `*.local.json`), `campaign/results/first-run/summary.md`, `campaign/results/P3-GATE/review.md`, the open findings in `campaign/handoff.md`, the final labels (`campaign/corpus/labels/final-*.yaml`, compatibility citations only) and `campaign/corpus/label-rules.md`.
- Classification uses the `docs/testing/compatibility.md` vocabulary: root causes `ANALYSIS_BUG`, `ANALYSIS_MISSING_SIGNAL`, `DEPLOYZ_BUG`, `MVP_CAPABILITY_GAP`, `UPSTREAM_REPO_FAILURE`, `REPO_CONFIGURATION`; failure stage `TEST_HARNESS_ERROR` for harness faults. "Environment" (Docker memory or builder EOF on this machine) keeps its own denominator and is not a family.
- A failure is one failed stage, one gate misclassification or one failed live AI request. An app can have more than one failure; each failure maps to exactly one family.

## Families

| Family | Root cause | Failures | Fix task | Regression location |
| --- | --- | --- | --- | --- |
| F1 Unbuildable Dockerfile accepted by the gate | `ANALYSIS_BUG` | 19 gate FA + 7 build | `P4-FIX-UNBUILDABLE-DOCKERFILE` | `packages/analysis/test/fresh-100-unbuildable-dockerfile.test.ts` |
| F2 Local state or mounted config not detected | `ANALYSIS_MISSING_SIGNAL` | 7 gate FA + 2 later-stage | `P4-FIX-LOCAL-STATE` | `packages/analysis/test/fresh-100-local-state.test.ts` |
| F3 Multi-process image or no default server command not detected | `ANALYSIS_MISSING_SIGNAL` | 2 gate FA + 1 probe | `P4-FIX-START-COMMAND` | `packages/analysis/test/fresh-100-start-command.test.ts` |
| F4 Gate false rejection when configuration removes the blocker | `ANALYSIS_BUG` | 7 gate FR | `P4-FIX-FALSE-REJECTION` | `packages/analysis/test/false-rejection-scoping.test.ts` (extend) |
| F5 Live repository AI gives no usable result | `DEPLOYZ_BUG` | 10 timeout + 13 parse-error | `P4-FIX-AI-RELIABILITY` | `packages/analysis/test/repository-ai.test.ts` (extend) |
| F6 Migration command not runnable in the runtime image | `ANALYSIS_BUG` | 1 run | `P4-FIX-MIGRATION-RUNTIME` | `packages/analysis/test/fresh-100-migration-runtime.test.ts` |
| F7 Harness build inputs differ from production | `TEST_HARNESS_ERROR` | 11 build | `P4-FIX-HARNESS-BUILD-INPUTS` | `scripts/repository-deployment/local-build.test.ts` (extend) |
| F8 Harness run environment differs from production | `TEST_HARNESS_ERROR` | 6 run/probe | `P4-FIX-HARNESS-RUN-ENV` | `scripts/repository-deployment/local-run.test.ts` (extend) |
| F9 Harness probe applicability | `TEST_HARNESS_ERROR` | 2 probe | `P4-FIX-HARNESS-PROBES` | `scripts/repository-deployment/local-run.test.ts` (extend) |
| F10 Start/health failure with no diagnosed cause | to be set by diagnosis | 4 probe | `P4-DIAG-START` (diagnosis; queues a fix only for a systemic defect) | set by the diagnosis |
| H-a Windows tar cannot create symlinks; extraction not deterministic | `TEST_HARNESS_ERROR` | 6 source | `P4-FIX-HARNESS-TAR` (BLOCKED: USER DECISION) | `scripts/repository-deployment/local-build.test.ts` |
| H-b Dependency readiness window includes the first image pull | `TEST_HARNESS_ERROR` | 1 run | `P4-FIX-HARNESS-READINESS` (BLOCKED: USER DECISION) | `scripts/repository-deployment/local-run.test.ts` |
| U Upstream repository fault | `UPSTREAM_REPO_FAILURE` | 4 build/probe | none (recorded) | none |
| G Build-time values (Dockerfile `ARG`) | `MVP_CAPABILITY_GAP` (post-MVP in mvp-scope.md "Deferred") | 1 build | none (recorded) | none |
| E Environment (Docker 3.8 GB memory, builder EOF) | environment, separate denominator | 2 build | none | none |

Gate totals: 28 false acceptance = F1 19 + F2 7 + F3 2; 7 false rejection = F4 (see "Count check").

### F1 Unbuildable Dockerfile accepted by the gate (`ANALYSIS_BUG`)

`evaluateManifestReadiness` (`packages/analysis/src/manifest.ts`) maps `dockerfile-missing` and `dockerfile-missing-sources` to NEEDS_CONFIGURATION. Label rules R1/R2 (from mvp-scope.md: compute "Needs a Dockerfile") make "no Dockerfile that builds a production image" NOT_COMPATIBLE: no configuration value in Deployz removes it, so the NEEDS_CONFIGURATION answer tells the vendor something false.

- No Dockerfile detected (`dockerfile-missing`): repo-505, 511, 515, 518, 525, 579, 585, 588, 590, 596.
- Dockerfile copies artifacts the repository does not contain (flagged `dockerfile-missing-sources`): repo-517, 544, 559; not flagged: repo-575 (`traccar-other-$VERSION.zip`), 577 (`dist/server/...`), 548 (downloads a release tarball, `ARG LEAN_VERSION` without default).
- Dockerfile is a template: repo-599 (mustache `{{#ubi}}`).
- Only a development Dockerfile: repo-574 (`Dockerfile.dev`).
- Dockerfile fails on the pinned source (no lockfile, no `output: standalone`): repo-507 (detect only if sound; else record as a limitation).
- Fix constraint (COMP-021): an absent COPY source proves nothing when the tree is truncated (200-file cap), and `COPY --from=` / generated directories must never reject. The fix may make these findings NOT_COMPATIBLE only when the evidence is complete (tree not truncated, no other candidate Dockerfile). This changes what the gate tells the vendor: update `docs/product/mvp-scope.md` and record the reason in `docs/decisions/README.md`.

### F2 Local state or mounted configuration not detected (`ANALYSIS_MISSING_SIGNAL`)

All have label NOT_COMPATIBLE with `local-filesystem`: repo-510 (SQLite in `config/database.yml`, Active Storage Disk), 522 (serves a mounted host directory), 528 (`ELECTRIC_STORAGE_DIR` default `./persistent`), 529 (`VOLUME /var/lib/snipeit` holding uploads and keys), 552 (needs mounted `.config/default.yml`), 557 (empty web root + local SQLite), 593 (`--config /app/config/glance.yml` not in the image). Later-stage effects: repo-510 probes (start/health/redis FAIL), repo-552 run (migration needs the config file). Fix only signals that are sound on more than one app; record the rest as a limitation in `docs/testing/repository-compatibility/findings.md`.

### F3 Multi-process image or no default server command (`ANALYSIS_MISSING_SIGNAL`)

repo-549 (ENTRYPOINT only, no CMD, five modes, websocket on its own port), repo-580 (s6 runs web, api, cron and worker; second public port), repo-566 (image has no default server command; the container prints CLI help and exits 0; start probe FAIL). `start-command-missing` and the multi-process signal were not raised.

### F4 Gate false rejection (`ANALYSIS_BUG`)

Label NEEDS_CONFIGURATION, Deployz NOT_COMPATIBLE: repo-503 and 520 (`docker-compose-multi-service`, `local-filesystem`; environment switches to PostgreSQL and S3), 516 and 547 (`local-filesystem`; S3 option exists), 563 (`docker-compose-multi-service`; self-contained Dockerfile, S3 option), 509 (`background-worker`, `redis-unsupported`; production Dockerfile not at the app root), 569 (`pulumi` file presence). Rejection must stay when no supported configuration removes the blocker.

### F5 Live repository AI (`DEPLOYZ_BUG`)

67 requests: 10 timeout at 30 s (repo-501, 509, 513, 517, 518, 552, 566, 576, 587, 589), 13 parse-error (repo-502, 503, 514, 516, 528, 536, 541, 545, 548, 555, 564, 573, 583). The deterministic path still gives a verdict, but 23/67 production analyses lose the AI signal. The fix task diagnoses parse errors from the redacted responses first (deterministic parser regression), and changes the timeout only with measured evidence.

### F6 Migration command not runnable in the runtime image (`ANALYSIS_BUG`)

repo-560: the selected pre-deploy migration command uses `vite-node`, which the runtime image does not contain (exit 127). The migration task runs the web image, so a command that needs a dev-only tool must not be selected (or must be flagged).

### F7 Harness build inputs differ from production (`TEST_HARNESS_ERROR`)

- Harness builds `./Dockerfile` when the manifest `dockerfilePath` is null; production preflight blocks `dockerfile-missing` and never builds: build FAIL of repo-505, 515, 518, 525, 579, 585, 588, 590, 596 (9).
- Build context differs from the manifest or what production uses: repo-536 (remediated rerun with the right context builds), 580 (context `docker/services`; rerun with `.` builds).
- Dockerfile selection differs from the manifest: repo-548, 577; context differs: repo-517. These builds fail for F1 causes; the harness must still use the manifest values (checked by the fix test).

### F8 Harness run environment differs from production (`TEST_HARNESS_ERROR`)

Production injects generated keys and the manifest database bindings (`packages/cdk` application stack). The local run did not: repo-529 (`APP_KEY` generated key; container exits), 534 (`SPRING_DATASOURCE_*`; dbWrite FAIL), 543 (`DATABASE_*`; container exits), 551 (`DATABASE_URL` empty at migration; run FAIL). Health path precedence: repo-556 (deploy-config `/api/health` vs manifest `/heartbeat`; dbWrite FAIL) must follow the production precedence; if deploy-config is wrong it is `REPO_CONFIGURATION` and the fix task corrects that entry from the app source.

### F9 Harness probe applicability (`TEST_HARNESS_ERROR`)

repo-530 (redis probe FAIL for a lazy-connect app that never touches Redis at start), repo-557 (dbWrite probe FAIL for an app that creates no tables). A probe that cannot apply must report NOT_APPLICABLE or UNVERIFIED with its reason, never FAIL and never PASS.

### F10 Start/health failure with no diagnosed cause

repo-502, 514, 523 (start/health FAIL; dbWrite/redis follow) and repo-573 (health FAIL; deploy-config health `/auth/setup-status` vs manifest `/v1/ping`; uvicorn startup traceback). `P4-DIAG-START` reads the redacted logs and evidence, maps each to F8, U, `REPO_CONFIGURATION` or a new systemic family, and Opus queues a fix only for a systemic MVP defect.

### H-a, H-b (USER DECISION open)

- H-a: repo-501, 507, 508, 511, 528, 574 source FAIL (Windows tar symlinks; repo-513 passed once, failed once).
- H-b: repo-513 run FAIL (SeaweedFS stand-in not ready within 90 s including the first image pull).
- The fix tasks are queued BLOCKED until the user decides. Until then the reruns record these stages as harness failures (not app results).

### U, G, E (recorded, no fix)

- U `UPSTREAM_REPO_FAILURE`: repo-524 (psycopg2 needs `pg_config` in the image), 550 (Dockerfile Go toolchain older than `go.mod` requires), 564 (production boot requires the development gem `annotate_rb`), 593 build (base image tag `golang:1.27.1-alpine3.24.1` does not exist).
- G `MVP_CAPABILITY_GAP`: repo-549 build (`COMMIT_SHA` build argument required); build-time values are post-MVP in mvp-scope.md.
- E environment: repo-555 (builder EOF during a long vite build), repo-565 (JS heap OOM, Docker memory 3.8 GB).

## Per-app failure map (eligible apps with a failure, and AI failures)

| App | Failures -> family |
| --- | --- |
| repo-501 | source H-a; AI timeout F5 |
| repo-502 | probes F10; AI parse F5 |
| repo-503 | gate FR F4; AI parse F5 |
| repo-505 | gate FA F1; build F7 |
| repo-507 | gate FA F1; source H-a |
| repo-508 | source H-a |
| repo-509 | gate FR F4; AI timeout F5 |
| repo-510 | gate FA F2; probes F2 |
| repo-511 | gate FA F1; source H-a |
| repo-513 | run H-b; AI timeout F5 |
| repo-514 | probes F10; AI parse F5 |
| repo-515 | gate FA F1; build F7 |
| repo-516 | gate FR F4; AI parse F5 |
| repo-517 | gate FA F1; build F1; AI timeout F5 |
| repo-518 | gate FA F1; build F7; AI timeout F5 |
| repo-520 | gate FR F4 |
| repo-522 | gate FA F2 |
| repo-523 | probes F10 |
| repo-524 | build U |
| repo-525 | gate FA F1; build F7 |
| repo-528 | gate FA F2; source H-a; AI parse F5 |
| repo-529 | gate FA F2; probes F8 |
| repo-530 | probes F9 |
| repo-534 | probes F8 |
| repo-536 | build F7; AI parse F5 |
| repo-543 | probes F8 |
| repo-544 | gate FA F1; build F1 |
| repo-547 | gate FR F4 |
| repo-548 | gate FA F1; build F1; AI parse F5 |
| repo-549 | gate FA F3; build G |
| repo-550 | build U |
| repo-551 | run F8 |
| repo-552 | gate FA F2; run F2; AI timeout F5 |
| repo-555 | build E; AI parse F5 |
| repo-556 | probes F8 |
| repo-557 | gate FA F2; probes F9 |
| repo-559 | gate FA F1; build F1 |
| repo-560 | run F6 |
| repo-563 | gate FR F4 |
| repo-564 | probes U; AI parse F5 |
| repo-565 | build E |
| repo-566 | probes F3; AI timeout F5 |
| repo-569 | gate FR F4 |
| repo-573 | probes F10; AI parse F5 |
| repo-574 | gate FA F1; source H-a |
| repo-575 | gate FA F1; build F1 |
| repo-577 | gate FA F1; build F1 |
| repo-579 | gate FA F1; build F7 |
| repo-580 | gate FA F3; build F7 |
| repo-585 | gate FA F1; build F7 |
| repo-588 | gate FA F1; build F7 |
| repo-590 | gate FA F1; build F7 |
| repo-593 | gate FA F2; build U |
| repo-596 | gate FA F1; build F7 |
| repo-599 | gate FA F1; build F1 |
| ineligible apps | AI only: repo-541, 545, 583 parse F5; repo-576, 587, 589 timeout F5 |

No failure: repo-540 (full local success), and the 18 other ineligible apps (correct rejection, AI completed or not requested).


## Count check

Gate false acceptance (28): F1 = 505, 507, 511, 515, 517, 518, 525, 544, 548, 559, 574, 575, 577, 579, 585, 588, 590, 596, 599 (19); F2 = 510, 522, 528, 529, 552, 557, 593 (7); F3 = 549, 580 (2). 19 + 7 + 2 = 28.
Gate false rejection (7): F4 = 503, 509, 516, 520, 547, 563, 569.
Source FAIL (6): H-a. Build FAIL (24): F7 11 (505, 515, 518, 525, 536, 579, 580, 585, 588, 590, 596), F1 7 (517, 544, 548, 559, 575, 577, 599), U 3 (524, 550, 593), G 1 (549), E 2 (555, 565). Run FAIL (4): H-b 513, F8 551, F2 552, F6 560. Probes FAIL (13): F10 4 (502, 514, 523, 573), F8 4 (529, 534, 543, 556), F9 2 (530, 557), F2 1 (510), F3 1 (566), U 1 (564). AI (23): F5.

## Queued work (tasks.json, before P4-GATE)

1. Product fixes, one PR per family, each followed by an Opus merge task (`policy.publication.mergeProcedure`): `P4-FIX-UNBUILDABLE-DOCKERFILE` / `P4-MERGE-UNBUILDABLE-DOCKERFILE`, `P4-FIX-FALSE-REJECTION` / `P4-MERGE-FALSE-REJECTION`, `P4-FIX-LOCAL-STATE` / `P4-MERGE-LOCAL-STATE`, `P4-FIX-START-COMMAND` / `P4-MERGE-START-COMMAND`, `P4-FIX-MIGRATION-RUNTIME` / `P4-MERGE-MIGRATION-RUNTIME`, `P4-FIX-AI-RELIABILITY` / `P4-MERGE-AI-RELIABILITY`. Each fix branches from the current `origin/main` after the previous merge (analysis fixes bump ANALYSIS_VERSION and would conflict if parallel).
2. Harness fixes on `campaign/fresh-100` (campaign harness; reach `main` through the campaign PR): `P4-FIX-HARNESS-BUILD-INPUTS`, `P4-FIX-HARNESS-RUN-ENV`, `P4-FIX-HARNESS-PROBES`; `P4-FIX-HARNESS-TAR` and `P4-FIX-HARNESS-READINESS` BLOCKED (USER DECISION).
3. `P4-DIAG-START` (diagnosis of F10).
4. `P4-SYNC-CANDIDATE` (Opus): merge `origin/main` into `campaign/fresh-100`, rebuild, record the new tested commit and ANALYSIS_VERSION.
5. Rerun: `P4-RERUN-COMPAT-01..08` (10 apps each, all 80, results in `campaign/results/final/compat/`), then `P4-RERUN-BUILD-PLAN` (Opus) queues `P4-RERUN-BUILD-nn` batches of 2-3 apps for every app that is build-eligible after the rerun (results in `campaign/results/final/build/`).
