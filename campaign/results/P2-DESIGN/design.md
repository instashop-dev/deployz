# P2-DESIGN — minimal harness extensions for the fresh-100 campaign

Task: `P2-DESIGN` (Opus). Tested commit: `e6a3b58e` (baseline, ANALYSIS_VERSION 45).
Inputs read: `scripts/repository-compatibility/` (index, analyse, snapshot, manifest, report),
`scripts/repository-deployment/` (index, gate, config, results), `packages/cdk/src/pipeline/build-pipeline.ts`,
`docs/testing/compatibility.md`. To trace the build inputs, Opus also read the callers that the build
pipeline names: `packages/cdk/src/lambda/worker.ts` (`buildRelease`, `resolveBuildContext`),
`packages/cdk/src/pipeline/source-fetch.ts` (`fetchRepoArchive`), `apps/api/src/ai-config.ts`
and `packages/contracts/src/capability-registry.ts`. No holdout path was read.

## Rules for every change

- Extend the two existing harnesses (Stage A `pnpm benchmark:compat`, Stage B `pnpm benchmark:deploy`).
  No new framework, no new pnpm script, no Python, no new paid service, no new npm dependency.
  Docker is driven with the `docker` CLI through `execFile` (the harnesses already use `execFileSync`).
- No product code change. Harness code is under `scripts/` only. If a task finds that it needs a
  product change, it stops and reports it (Phase 4 root-cause family), it does not patch product code.
- Every new default keeps the current behavior. Existing `docs/testing/*/runs/` files do not change.
  Existing harness tests pass without edits.
- All new tests are deterministic vitest tests in the existing `harness.test.ts` files (or a new
  `*.test.ts` beside them, picked up by the same `vitest.config.ts`). No network, no Docker, no AWS
  in unit tests: Docker and fetch are injected as fakes.
- Document each new flag in `docs/testing/compatibility.md` (the authoritative harness document).
- Campaign output goes under `campaign/results/` only. Raw logs and caches go under ignored paths
  (`campaign/logs/`, `campaign/.cache/`, the existing `docs/testing/repository-compatibility/.cache`).

## (a) Corpus and runs-dir flags — `P2-IMPL-CORPUS-FLAGS`

Stage A, `scripts/repository-compatibility/index.ts`:
- Add `--benchmark <path>` (default `BENCHMARK_PATH`) and `--runs-dir <path>` (default `RUNS_DIR`) to
  `parseRunArgs`; `RunOptions` gets `benchmarkPath` and `runsDir`. `main` uses them for
  `loadBenchmark`, `writeRunFiles` and `writeSummaryFiles`.
- Guard: when `--benchmark` is not the default path and writing is on, `--runs-dir` is required
  (error: "a non-default --benchmark needs --runs-dir"). This stops campaign results from going into
  `docs/testing/repository-compatibility/runs/`.
- The summary rule stays: a partial run (`--repo` or `--set`) does not write the summary.

Stage B, `scripts/repository-deployment/index.ts`:
- Add `--benchmark <path>` (default `BENCHMARK_PATH`) and `--deploy-config <path>` (default
  `DEPLOY_CONFIG_PATH`); `--runs-dir` and `--evidence-dir` exist already. `main` uses them in place of
  the constants (line 653–654).
- Same guard: a non-default `--benchmark` requires `--runs-dir` and `--evidence-dir`.
- A repository without an entry in the deploy config keeps today's behavior (`configFor` returns an
  empty config, so B2 offline evaluates with no provided keys). The campaign deploy config
  (`campaign/corpus/deploy-config.yaml`) is a Phase 3 artifact, not a Phase 2 one.

Campaign paths (convention, written in `docs/testing/compatibility.md` only as "any path"):
`--benchmark campaign/corpus/benchmark.yaml`, Stage A `--runs-dir campaign/results/stage-a/<label>-<aiMode>/`,
Stage B / local `--runs-dir campaign/results/stage-b/<label>-<aiMode>/` and
`--evidence-dir campaign/logs/stage-b/<label>/` (ignored). `<label>` is `first-run`, `remediated` or
`final`; holdout uses `campaign/results/holdout/` only in Phase 6. Separate directories keep
first-run, remediated, final and holdout results apart.

Tests (deterministic): `parseRunArgs([])` gives the same defaults as before for both harnesses;
the new flags resolve to absolute paths; the guard throws for a non-default benchmark without a
runs dir; a Stage A run over a two-entry temporary benchmark with a fake session writes only into the
given runs dir (temporary directory) and no file under `docs/testing/`.

## (b) AI mode recorded per result — `P2-IMPL-AI-MODE`

Flag `--ai off|live` on both harnesses. Default `off` (today's behavior: `createAiGateway(undefined)`,
no network AI request).

- `scripts/repository-compatibility/analyse.ts`: `openAnalysisSession(fetchFn, { ai })`.
  - `off`: `createAiGateway(undefined)`, as now.
  - `live`: read the environment with `describeAiGatewayConfig` from `@deployz/api/ai-config` (the
    same reader `apps/api/src/env.ts` uses), then `createAiGateway(config)`. When `config` is
    undefined, fail fast before the first entry. The message names the missing variables
    (`AI_GATEWAY_BASE_URL`, `AI_PROVIDER_API_KEY`) or the `reused-secret` problem. It never prints a value.
  - The production timeout stays: the harness calls `runApplicationAnalysis`, which applies
    `REPO_AI_TIMEOUT_MS` (30 s) itself. The harness adds no timeout of its own around AI.
  - Instrumentation: wrap the gateway in a counting proxy (`instrumentGateway(gateway)`) that counts
    `generate` calls and classifies the last error of each entry into
    `completed | timeout | auth-error | routing-error | parse-error | fallback | not-requested`
    (abort/timeout error → timeout; HTTP 401/403 → auth-error; 404/unknown model → routing-error;
    `AI_NoObjectGeneratedError` or schema failure → parse-error; any other error with a completed
    analysis → fallback). The error text is sanitized: no header, URL query, key or token; at most
    300 characters.
- Result record: Stage A `RunResult` gets
  `ai: { mode: 'off' | 'live', model: string | null, requests: number, outcome: <above>, error: string | null }`.
  `model` is the configured model name in `live` and null in `off`. Stage B / local results put the
  same object in `evidence.ai` (the Stage B schema is strict, but `evidence` is a free record, so the
  schema does not change).
- Summary: `buildSummary` adds counts by `ai.mode` and `ai.outcome`. `writeRunFiles` refuses to replace
  a result file whose `ai.mode` differs from the new one (error names the file), so one runs dir
  never mixes modes.
- `baseline.aiMode` in `state.json` changes to production-equivalent only after `P2-AI-LIVE-VALIDATE`
  is COMPLETE (Opus).

Tests: mode parsing and default; `off` makes zero gateway calls (fake fetch records no request);
missing configuration fails with the variable names and no value; outcome classification for each
error class with a fake gateway; the sanitizer removes a planted key and a bearer token; the
refusal to mix modes in one runs dir.

## (c) Local Docker build stage — `P2-IMPL-LOCAL-BUILD`

New file `scripts/repository-deployment/local-build.ts`; flag `--local` on `pnpm benchmark:deploy`
(mutually exclusive with `--real-aws`, `--cleanup` and `--audit`). Per repository the order is:
gate (existing B1/B2 path through `openAnalysisSession`) → source → build → run → probes → cleanup.

Source packaging, as production does it (`fetchRepoArchive` + buildspec `install`/`pre_build`):
- Download the GitHub tarball of the pinned commit (`GET /repos/{owner}/{repo}/tarball/{commit}`,
  token from the existing `resolveGithubToken`) into `campaign/.cache/source/<owner>__<repo>/<commit>.tar.gz`
  (ignored; reused when present, the commit makes it immutable).
- Extract into a new temporary directory with `tar xzf <file> -C <dir> --strip-components=1`, the same
  command as the buildspec. No other file is added to the source.

Dockerfile and context selection, `selectBuildInputs(detectedMetadata)`: a copy of the precedence in
`worker.ts buildRelease` — vendor override `manifestOverrides.dockerfilePath` → detected
`dockerfilePath` → `Dockerfile`; context: override `buildContext` → detected `dockerfileBuildContext`
(only when the Dockerfile is not overridden) → `resolveBuildContext` rule (top-level `docker/` → `.`)
→ the Dockerfile's directory (the buildspec fallback `dirname`). Scripts do not import
`packages/cdk` today, and `worker.ts` loads AWS clients at import, so the harness keeps a copy.
Drift guard (deterministic test): the test reads `packages/cdk/src/lambda/worker.ts` and
`build-pipeline.ts` as text and asserts that the precedence lines and the
`BUILD_CONTEXT=${BUILD_CONTEXT:-$(dirname "$DOCKERFILE_PATH")}` line are present unchanged; a product
change fails the test and forces a harness update. A table test covers root, `backend/Dockerfile`,
`docker/Dockerfile`, nested `foo/docker/Dockerfile`, override Dockerfile, override context.

No Dockerfile: production fails the build. The harness does the same (it records the docker error);
it never writes a Dockerfile. A Dockerfile added later is a remediation and goes into a separate
`remediated` runs dir.

Build command (argument list, no shell):
`docker build --platform linux/amd64 -f <dockerfile> --label deployz-campaign=fresh-100
--label deployz-campaign-repo=<id> -t deployz-campaign/<id>:<commit12> [--build-arg NAME ...] <context>`.
`linux/amd64` matches CodeBuild `STANDARD_7_0` (x86_64). Build args come only from the deploy-config
build variables (names on the command line, values in the child environment, as the buildspec does).
No host environment, no `.env`, no credentials go to the child: the child environment is an
allowlist (`PATH`, `SYSTEMROOT`, `DOCKER_*` connection variables, the build-arg values).
Timeout: 30 minutes, the CodeBuild default `timeoutMinutes` in `build-pipeline.ts`; on timeout the
process tree is killed and the stage is FAIL with `timeout`. A Docker Hub rate-limit error
(the `DOCKER_HUB_RATE_LIMIT_PATTERN` text of `build-pipeline.ts`; it is not exported, so the harness copies it and the drift guard checks the copy) is recorded as `infrastructure`, not as an app failure.
Evidence: Dockerfile path, context, platform, exit code, duration, image id and size, and the last
40 log lines after sanitizing; the full log goes to `campaign/logs/` (ignored).

Tests: argument composition with a fake runner (platform flag, labels, no `-v`, no `--network host`,
no `--privileged`, no `--secret`, no host env leak), `selectBuildInputs` table and drift guard,
timeout and rate-limit classification, sanitizer on the log tail.

## (d) Isolated local run stage and probes — `P2-IMPL-LOCAL-RUN`

New file `scripts/repository-deployment/local-run.ts`.

Isolation (every container, network and volume has label `deployz-campaign=fresh-100` and
`deployz-campaign-repo=<id>`):
- One user-defined bridge network per repository run, `deployz-campaign-<id>-<runId>`. Egress is
  allowed, as in production (ECS tasks reach the internet). No published host port: probes run from a
  disposable probe container on the same network.
- No bind mount and no named host path; only anonymous volumes, removed with the container.
  No `--privileged`, no Docker socket, no host network, no host environment, no credentials.
  `--memory 1g --cpus 1` for the app (fits the 3.76 GiB Docker VM with the dependencies).
- Dependencies, only when the gate manifest needs them: `postgres:16-alpine` (the engine version the
  compiler plans), `valkey/valkey:8-alpine` (ElastiCache Valkey) and `minio/minio` as the S3 stand-in
  for storage. Each gets a random per-run password, generated by the harness and never written to a
  tracked file. Images are pinned by digest in `local-run.ts`.
- Runtime environment: the variable names the production compiler injects, taken from
  `packages/contracts/src/capability-registry.ts` (for example `DATABASE_URL`, `REDIS_URL`,
  `S3_BUCKET`), with local endpoints as values, plus the deploy-config values and generated secrets
  (`providedKeys`). The port and health path come from the gate manifest.
- Migration: when the manifest has a `migrationCommand`, run it once in a one-off container from the
  same image and environment before the app starts, as the production migration task does.

Probes (each one PASS, FAIL, NOT_APPLICABLE or UNVERIFIED; UNVERIFIED never counts as success):
1. `start`: the app container is still running 60 s after start.
2. `health`: `GET http://<app>:<port><healthPath>` from the probe container returns 200–399 within
   5 minutes (the readiness window), same matcher range as the production target group.
3. `migration`: the migration container exits 0, and the public schema has more tables after it than
   before (read with `psql` inside the postgres container).
4. `dbWrite`: total live rows in the public schema are above 0 after health and the migration
   (read with `psql`); NOT_APPLICABLE without a database.
5. `redis`: the Valkey server shows a client connection or a key from the app (`CLIENT LIST`, `DBSIZE`);
   for a worker, the worker container also stays running 60 s. NOT_APPLICABLE without Redis.
6. `storage`: the app can reach the bucket (MinIO access log shows a request for the bucket);
   otherwise UNVERIFIED.
Total run-stage timeout: 10 minutes after the build. On timeout the stage is FAIL with `timeout`.

Cleanup (always, in `finally`): `docker rm -f -v` of every container with the repo label, then
`docker network rm` and `docker volume rm` of the labelled resources; the image is removed unless
`--keep-image`. The leak check lists `docker ps -a`, `docker network ls` and `docker volume ls`
filtered by `deployz-campaign=fresh-100,deployz-campaign-repo=<id>` and records the result; a
leftover makes the cleanup stage FAIL.

Tests: fake runner asserts the container arguments (labels, no mount, no published port, no
privileged, memory and cpu limits, env names from the registry, no host env), probe classification
for each outcome, migration ordering, cleanup runs after a failed probe and after a timeout.

## (e) Per-stage evidence and `--resume`

- Local result file: `<runs-dir>/<id>.local.json`, schema in a new `scripts/repository-deployment/local-results.ts`
  (zod, strict): identity (id, repository, commit, set, cohort, deployzCommit, analysisVersion,
  `ai`), `inputsHash` (sha256 of deployz commit, repository commit, AI mode, deploy-config entry and
  local image digests), and `stages.{gate,source,build,run,probes,cleanup}` each with
  `status` (`NOT_ATTEMPTED | IN_PROGRESS | PASS | FAIL | SKIPPED`), `startedAt`, `finishedAt`,
  `durationMs`, `detail`, `evidence`. A `classification` (`local-success` only when gate, build,
  start, health and every applicable probe PASS; otherwise the first failing stage) and
  `remediation: null | { kind, description }` (null in a pristine run).
- The file is written atomically (`<file>.tmp` + rename) when each stage starts (`IN_PROGRESS`) and
  ends, so an interrupted run leaves an exact marker.
- `--resume` (local mode and Stage A): before any work, reconcile — remove labelled containers,
  networks and volumes of the selected repositories (a `--resume` never repeats a stage on top of
  leftovers). Then, per repository: when `inputsHash` differs, start again; else skip the stages that
  are PASS or FAIL and restart from the first `IN_PROGRESS` or `NOT_ATTEMPTED` stage. A build PASS
  whose image is gone is rebuilt and the rebuild is recorded. Stage A `--resume` skips an entry whose
  `<runs-dir>/<id>.json` has the same `deployzSha`, `analysisVersion`, `commit` and `ai.mode`.
- Summary: `<runs-dir>/local-summary.{json,md}` with explicit denominators per stage (attempted,
  PASS, FAIL, UNVERIFIED, NOT_APPLICABLE) and per-app durations, so `P2-GATE` and Phase 3 can size batches.
- Sanitizer (shared, one function in `local-results.ts`): removes values of generated secrets,
  `Bearer` tokens, AWS key ids, private key blocks and email addresses from every `detail` and log tail
  before it is written.

Tests: atomic write; an `IN_PROGRESS` stage resumes at that stage; PASS/FAIL stages are skipped with
the same `inputsHash`; a changed hash restarts; a missing image forces a rebuild; reconcile runs before
the first stage; Stage A resume skip rule; summary denominators.

## Order and size

1. `P2-IMPL-CORPUS-FLAGS`: (a) only. Touches the two `index.ts` files, their tests, the doc.
2. `P2-IMPL-AI-MODE`: (b). Touches `analyse.ts`, Stage A `index.ts`/`report.ts`, Stage B `index.ts`
   (flag pass-through and `evidence.ai`), tests, the doc.
3. `P2-IMPL-LOCAL-BUILD`: (c) and the `local-results.ts` part of (e) needed by the build
   (stage record, atomic write, sanitizer). Touches new `local-build.ts`, `local-results.ts`, Stage B
   `index.ts` (`--local`), tests, the doc.
4. `P2-IMPL-LOCAL-RUN`: (d) and the rest of (e) (`--resume`, reconcile, summary). Touches new
   `local-run.ts`, `local-results.ts`, Stage B `index.ts`, Stage A `index.ts` (`--resume`), tests, the doc.

## Not in scope (post-MVP or a later phase)

- A real AWS run of the campaign corpus: Phase 7 uses the existing `--real-aws` path with `--benchmark`.
- A generic HTTP functional crawler, browser checks or app-specific probes: no repository-name cases.
- Caching built images across runs, parallel builds, or a job queue: one repository at a time.
