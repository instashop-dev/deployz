# Compatibility

The corpus-benchmark layer (`strategy.md`'s **compat** row): how accurately
Deployz analyses and deploys a large, fixed set of real open-source
repositories. It measures analyser and product accuracy against realistic
customer code — it is not a product regression check, it never gates a merge,
and it never runs on a pull request. See [`strategy.md`](strategy.md#the-layers)
for how this differs from the AWS E2E layers, and
[`aws-e2e.md`](aws-e2e.md) for the version canary this shares its test
account and its harness building blocks with.

Two stages measure two different questions:

| Stage | Question | AWS | Corpus source |
| --- | --- | --- | --- |
| A — `pnpm benchmark:compat` | Does the analyser *understand* a repository? | None | `benchmark.yaml` (owns the corpus) |
| B — `pnpm benchmark:deploy` | Can Deployz actually *deploy* it, end to end? | Real, test account | reads `benchmark.yaml` by id, never copies it |

## Stage A — repository-compatibility audit

Runs the production repository-analysis path against 120 real repositories
pinned to immutable commits, and compares the result with independently
validated expected facts. Nothing in the corpus is ever executed — repository
content is read-only, untrusted data, exactly as it is in production.

```bash
pnpm build                               # the harness imports the built packages
pnpm benchmark:compat                    # every repository in benchmark.yaml
pnpm benchmark:compat --repo repo-001    # one entry (repeat --repo for several)
pnpm benchmark:compat --set unseen       # one benchmark set
pnpm benchmark:compat --offline          # cached snapshots only, no GitHub
pnpm benchmark:compat --no-write         # print the summary, write nothing
pnpm benchmark:compat --benchmark <path> --runs-dir <dir>   # another corpus file, results into <dir>
pnpm benchmark:compat --ai live          # production AI gateway from the environment
```

`--benchmark <path>` reads any corpus file instead of `benchmark.yaml`, and
`--runs-dir <dir>` writes the result files and the summary to any directory
instead of `repository-compatibility/runs/`. A non-default `--benchmark` needs
`--runs-dir` unless `--no-write` is set, so another corpus never writes into
the committed runs. A partial run (`--repo` or `--set`) still writes no summary.

**AI mode.** `--ai off` (the default) leaves the AI gateway unconfigured: the
fallback degrades deterministically and no AI request is made. This is a
diagnostic mode, not production behavior. `--ai live` builds the gateway from
`AI_GATEWAY_BASE_URL`, `AI_PROVIDER_API_KEY`, `AI_MODEL` and the optional
`AI_GATEWAY_TOKEN` through the same reader and `createAiGateway` path as
`apps/api`, and keeps the production `REPO_AI_TIMEOUT_MS`. It fails before the
first repository and names the missing variables. Each result records
`ai: { mode, model, requests, outcome, error }` (Stage B gate results record it
in `evidence.ai`); `outcome` is `completed`, `timeout`, `auth-error`,
`routing-error`, `parse-error`, `fallback` or `not-requested`, and `error` is
sanitized (no key, token or URL). One runs directory never mixes modes: a result
file written in the other mode is not replaced. `pnpm benchmark:deploy --gate`
takes the same `--ai` flag.

**The corpus** (`benchmark.yaml`) has 120 entries across three cohorts
(`realistic`, `messy`, `boundary` — repositories that fall outside the MVP by
design) and three sets (`improvement`, the 80 used to find and fix analyser
defects; `unseen` and `unseen2`, 20 each, frozen once the analyser baseline
is set — their first results are never used to change the analyser). Every
entry pins a 40-character commit SHA and an `expected` block: the
**deployment-gate** outcome (`READY` / `NEEDS_CONFIGURATION` /
`NOT_COMPATIBLE`) a freshly imported application with no configured values
would get, plus descriptive facts (postgres/redis/storage/migration
requirements, port, health path, `unsupported` families). Expected facts are
written from repository evidence (manifests, Dockerfiles, compose files,
route code), checked by a second independent inspection, and reconciled
against the files — never against the analyser's own output, and never
edited to match it.

**GitHub access.** `GITHUB_TOKEN`, else the `gh` CLI's token, else
unauthenticated requests (60/hour — too few for a full run). Every fetched
snapshot is cached under `docs/testing/repository-compatibility/.cache/`
(gitignored), keyed by git object SHA, so a repository is fetched from GitHub
at most once and reruns are offline and deterministic (`--offline` refuses to
fetch anything not already cached).

**Findings.** A mismatch is classified `ANALYSIS_BUG` or
`ANALYSIS_MISSING_SIGNAL` (fixed, with a regression test, and recorded in
[`repository-compatibility/findings.md`](repository-compatibility/findings.md)
as `COMP-nnn`), `MVP_CAPABILITY_GAP` (recorded, ranked, not fixed),
`CORRECTLY_UNSUPPORTED` (confirms the MVP boundary), or `REPO_INVALID`
(the corpus entry is replaced). Expected facts are never edited to match a
disagreeing analyser result.

## Stage B — repository-deployment audit

Answers what Stage A stops short of: when a repository is inside the MVP
support boundary, can Deployz build it, deploy it into a real customer AWS
account, make it healthy over HTTPS, and remove it cleanly afterwards? It
runs the pinned repositories through the real production path — analysis,
configuration, CodeBuild, ECR, the published templates, the relay,
CloudFormation, ECS, the ALB, RDS, ElastiCache, S3, the heartbeat health
gates, default HTTPS, Disconnect and Purge — and records one result per
repository. `CloudFormation CREATE_COMPLETE` is never a pass; a repository
passes only when it reaches a stable application-level healthy state and its
resources are gone afterwards.

### Classes B2 and B3

An earlier third class, **B1 runtime-reuse** (deploy every repository onto
one shared standing installation, to avoid fresh AWS per attempt), is
withdrawn (`DEPLOY-017`): a deployment owns its installation
(`deployments.installation_id` is UNIQUE, the enrollment code is single-use,
the relay token binds to the deployment that traded it), so a standing
installation can never serve a second deployment. There is no
`--runtime-reuse` CLI mode any more. Every repository Stage B actually runs
now goes through one of:

| Class | Infrastructure | Coverage | Repositories |
| --- | --- | --- | --- |
| **B2 capability-cohort** | Fresh per attempt | Infrastructure capability cohorts (PostgreSQL, Redis, PostgreSQL+Redis, storage, custom Dockerfile, custom port, custom health check, special topology) | Explicit list in `deploy-config.yaml` (`b2Repos`) |
| **B3 fresh-full** | Fresh per attempt | Full funnel through fresh AWS (build → ECR → bootstrap → install → healthy → destroy → cleanup audit) | 10-15 representative repos in `deploy-config.yaml` (`b3Repos`) |

A repository not listed in either defaults to `capability-cohort` in its
result (`deploymentClass`, `deploymentClassFor`'s default) — it runs the
same fresh-AWS `--real-aws` funnel as an explicit B2 entry, so that is the
honest default now. `'runtime-reuse'` stays a valid `deploymentClass` value
only because the committed `runs/*.json` history (40 result files) recorded
it before the removal; `deploymentClassFor` never assigns it to a new
result. `--gate` audits any repository offline regardless of class (the
deployment gate only, no AWS). To make a retry cheap without a fresh
CodeBuild run, use `--reuse-application` (redeploys the release the
repository already built).

Override a repository's class with `deploymentClass: fresh-full` (or
`capability-cohort`) in its `deploy-config.yaml` entry — it takes precedence
over the `b2Repos`/`b3Repos` lists.

### The funnel and its gates

| Stage | What runs | Stops the funnel when |
| --- | --- | --- |
| Gate | `runApplicationAnalysis` → `normalizeDeploymentManifest` + `evaluateManifestReadiness`, then the same gate on the deployed control plane | expected unsupported and rejected (`EXPECTED_UNSUPPORTED`); expected deployable but rejected (`GATE_ERROR`, a false rejection) |
| Configuration | Vendor overrides and configuration values from `deploy-config.yaml`; secrets generated at run time, or read from the environment (`fromEnv`) for a credential the harness cannot generate — never committed | the gate still refuses (`CONFIG_ERROR`) |
| Build | A release is created at the pinned SHA; CodeBuild → ECR digest | release `FAILED` (`SOURCE_FETCH_ERROR`, `BUILD_ERROR`, `IMAGE_ERROR`) — no AWS infrastructure created |
| Deployment | Customer + deployment, install link launched, bootstrap stack created exactly as Quick Create would, relay enrolls, INSTALL provisions the application stack | stack failure (`INFRA_ERROR`), task failure (`CONTAINER_START_ERROR`, `PORT_ERROR`, `ENV_BINDING_ERROR`, …), `TIMEOUT` |
| Health | Heartbeat gates, `currentReleaseId` promoted, default HTTPS ACTIVE, independent probes over HTTP and HTTPS | `HEALTH_PATH_ERROR`, `TLS_ERROR`, `APPLICATION_ERROR`, `DATABASE_ERROR`, `REDIS_ERROR`, `MIGRATION_ERROR`, `STORAGE_ERROR` |
| Cleanup | Disconnect → Purge → customer-owned leftovers → leak audit | `DESTROY_ERROR`, `CLEANUP_LEAK` |

Stage B reuses the version canary's building blocks rather than
reimplementing them: the vendor-side control-plane client
(`scripts/version-canary/control-plane.ts`), the AWS view and leak audit
(`scripts/version-canary/aws.ts`), and product teardown
(`scripts/version-canary/teardown.ts`) are all imported as is; only the
per-repository step functions and result model are Stage B's own, because
the assertions differ (any application, not one fixture).

### Classification vocabulary

`classification` (`scripts/repository-deployment/results.ts`) is `PASS` or
one of `FAILURE_STAGES`; `rootCause` is one of `ROOT_CAUSES`. No other label
is accepted — the schema refuses anything else, and
`harness.test.ts` asserts every one of these ids is documented here:

```
GATE_ERROR CONFIG_ERROR SOURCE_FETCH_ERROR BUILD_ERROR IMAGE_ERROR INFRA_ERROR
CONTAINER_START_ERROR ENV_BINDING_ERROR DATABASE_ERROR REDIS_ERROR
MIGRATION_ERROR STORAGE_ERROR PORT_ERROR HEALTH_PATH_ERROR TLS_ERROR
APPLICATION_ERROR TIMEOUT DESTROY_ERROR CLEANUP_LEAK EXPECTED_UNSUPPORTED
REPOSITORY_BROKEN TEST_HARNESS_ERROR

DEPLOYZ_BUG ANALYSIS_BUG ANALYSIS_MISSING_SIGNAL MVP_CAPABILITY_GAP
CORRECTLY_UNSUPPORTED REPO_CONFIGURATION UPSTREAM_REPO_FAILURE
AWS_TRANSIENT_FAILURE TEST_HARNESS_FAILURE
```

`REPOSITORY_BROKEN` and `TEST_HARNESS_ERROR` are failure stages for a corpus
snapshot that cannot be attempted at all and a harness-side fault, neither a
product nor an analyser problem. `DEPLOYZ_BUG`, `REPO_CONFIGURATION`,
`UPSTREAM_REPO_FAILURE` and `AWS_TRANSIENT_FAILURE` are root causes with no
Stage A equivalent: a genuine product defect, a `deploy-config.yaml`
mistake, a fault in the third-party repository itself, and a transient AWS
error a retry would clear.

### Cleanup rules and the leak audit

1. Real AWS needs `DEPLOYZ_E2E_ALLOW_REAL_AWS=1` **and** `--real-aws`.
2. Preflight refuses any AWS account other than the test account.
3. Every identifier is written to the attempt's ledger
   (`runs/evidence/<run id>/run.json`, gitignored) at creation time. Cleanup
   runs in `finally`: Disconnect → Purge → leftovers → leak audit. An
   interrupted run is resumed with `--resume`, which finishes cleanup for
   anything still alive before continuing the selection.
4. The connector (bootstrap) stack is never removed while an application
   stack was ever created unless the product's `cleanupState` is
   `COMPLETE` — Purge runs inside the connector's relay, so removing it
   earlier strands whatever the sweep had not reached yet.
5. After each wave, and at the end of Stage B, an account-level scan for the
   Stage B tags and the product's installation tags must return nothing
   disposable (the same INACTIVE-ECS exception the canary's leak audit has).
6. The global real-AWS concurrency guard (`--max-active`, default 2) refuses
   a new attempt before it creates anything when the evidence dir already
   holds that many unfinished runs.
7. **Concurrency with the canary: never overlap in the test account.**
   Stage B and the version canary (`aws-e2e.md`) share the same test
   account and the same VPC quota (5 per Region). Do not run a Stage B wave
   and a version-canary run against the same Region at the same time.

```bash
pnpm benchmark:deploy --gate                                          # offline gate audit, every repository
pnpm benchmark:deploy --dry-run --wave wave-1                         # print the plan, touch nothing
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm benchmark:deploy --real-aws --repo repo-001
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm benchmark:deploy --real-aws --resume
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm benchmark:deploy --cleanup --repo repo-001
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm benchmark:deploy --audit
pnpm benchmark:deploy --gate --benchmark <path> --deploy-config <path> --runs-dir <dir> --evidence-dir <dir>
pnpm benchmark:deploy --local --repo repo-001 --benchmark <path> --runs-dir <dir> --evidence-dir <dir>
pnpm benchmark:deploy --local --resume [--keep-image] --benchmark <path> --runs-dir <dir> --evidence-dir <dir>
pnpm benchmark:compat --resume --benchmark <path> --runs-dir <dir>
```

**Local Docker build (`--local`, no AWS).** For each selected repository:
the gate (as `--gate`), then the source, then `docker build`. The source is
the GitHub tarball of the pinned commit (`GET /repos/{owner}/{repo}/tarball/{commit}`,
cached under `<--cache>/source/`), extracted with `tar xzf … --strip-components=1`
as the buildspec does. The Dockerfile and the build context follow
`buildRelease` in `packages/cdk/src/lambda/worker.ts`: a vendor override
(`overrides.dockerfilePath`, `overrides.buildContext`) wins, then the detected
Dockerfile and context, then the top-level `docker/` rule, then the Dockerfile's
directory; a test fails when those product lines change. When neither an override
nor the analysis gives a Dockerfile, production preflight blocks
`dockerfile-missing` and never builds: the build stage records FAIL with
`production preflight blocks: dockerfile-missing` and runs no `docker build`
(there is no `Dockerfile` default). The build runs with
`--platform linux/amd64`, the labels `deployz-campaign=fresh-100` and
`deployz-campaign-repo=<id>`, the tag `deployz-campaign/<id>:<commit12>` and a
30-minute timeout. The child environment is an allowlist (`PATH`, `SYSTEMROOT`,
`HOME`, `USERPROFILE`, `DOCKER_*`) plus the values of `buildVariables`
(`--build-arg NAME`); no host environment or credential reaches Docker. A
repository without a Dockerfile fails the build as in production; the harness
never adds one. A Docker Hub rate limit is recorded as `infrastructure`.

**Local run stage and probes.** After a passing build, the image runs in one
disposable bridge network per repository (`deployz-campaign-<id>-<run id>`).
Egress is open as in production; no port is published and probes run from a
disposable `curl` container on the same network. Every container and network
has the labels `deployz-campaign=fresh-100` and `deployz-campaign-repo=<id>`.
There is no bind mount, no Docker socket, no `--privileged`, no host network,
no host environment and no host credential; the app gets `--memory 1g --cpus 1`.
Dependencies start only when the gate manifest needs them, pinned by digest in
`local-run.ts`: `postgres:16-alpine` (the engine major version the compiler
plans), `valkey/valkey:8-alpine` and a SeaweedFS S3 stand-in (MinIO images are no
longer published). Passwords are generated per run. The app environment has the
deploy-config values and secrets (`${DEPLOYZ_APP_URL}` becomes `http://app`),
`PORT`, and the binding names of `packages/contracts/src/capability-registry.ts`
(`DATABASE_URL`, `DB_*`, `REDIS_URL`, `S3_BUCKET`, …) with local endpoints; a test
guards the names. A manifest `migrationCommand` runs once with `sh -c` in a
one-off container of the same image before the app starts.

Probes, each `PASS`, `FAIL`, `NOT_APPLICABLE` or `UNVERIFIED` (UNVERIFIED is never
success; a run whose probes all pass but one is UNVERIFIED is `local-unverified`):
`health` (200–399 from the manifest health path within 5 minutes), `start` (the
container still runs 60 s after start), `migration` (exit 0 and more tables in
the public schema), `dbWrite` (rows above 0 outside migration bookkeeping tables,
counted with `psql`), `redis` (a client or a key from the app) and `storage` (an
object in the bucket; otherwise UNVERIFIED). The run stage has a 10-minute
timeout. Cleanup runs in `finally` after any build attempt: it removes the labelled
containers (`rm -f -v`), networks and volumes, the image and the Docker build
cache (`docker builder prune -f`), then lists the three resource types by label;
a leftover fails the cleanup stage. `--keep-image` keeps the image and the build
cache. A failed run stage (migration, dependency, start, timeout) skips the
probes. A non-zero migration is a run-stage failure, not a probe.

`<runs-dir>/<id>.local.json` records the stages `gate`, `source`, `build`,
`run`, `probes` and `cleanup` (`NOT_ATTEMPTED`, `IN_PROGRESS`, `PASS`, `FAIL`,
`SKIPPED`) and is written atomically at the start and end of each stage. The
`classification` is `local-success`, `local-unverified`, the first failing stage, or
null while a stage is open. The build evidence has the Dockerfile, context,
platform, exit code, duration, image id and size, and the last 40 sanitized log
lines; the full logs are `<--evidence-dir>/<id>-build.log` and `<id>-run.log`.
`<runs-dir>/local-summary.{json,md}` count attempted, PASS, FAIL, SKIPPED per
stage, PASS, FAIL, UNVERIFIED, NOT_APPLICABLE per probe, and the duration of each
repository. `--local --resume` first removes the labelled containers, networks
and volumes of the selected repositories, then per repository: a changed
`inputsHash` (Deployz commit, repository commit, AI mode, deploy-config entry and
the dependency image digests) starts again; otherwise finished stages are kept
(a repository with no open stage is skipped, even if its image was removed), a
build PASS whose image is gone is rebuilt while later stages are open, and an
open stage re-runs. `run` and `probes` are one unit: an open one redoes both.
`--local` is exclusive with `--gate`, `--real-aws`, `--cleanup` and `--audit`.

`pnpm benchmark:compat --resume` reuses a recorded `<runs-dir>/<id>.json` whose
Deployz commit, analysis version, repository commit and AI mode all match the
current run, and analyses the other entries.

`--benchmark <path>` and `--deploy-config <path>` read any corpus and
deploy-config file instead of the committed ones; `--runs-dir` and
`--evidence-dir` move the results and the evidence. A non-default `--benchmark`
needs both `--runs-dir` and `--evidence-dir`, so another corpus never writes
into the committed runs. A repository with no entry in the deploy-config file
keeps the empty configuration. The deploy-config file must not name a
repository id that the benchmark file lacks.

**Findings** are systemic (`DEPLOY-nnn`, in
[`repository-deployment/findings.md`](repository-deployment/findings.md)),
distinct from Stage A's `COMP-nnn` analyser-accuracy findings — a Stage B
`GATE_ERROR` on an expected-deployable repository is a Stage A false
rejection seen from the product side; a `HEALTH_PATH_ERROR` is a Stage A
`healthPath` mismatch that became a failed deployment.

## `pnpm jev:eval`

An offline evaluation harness for a shadow-mode second opinion: it runs the
requirements-shadow verifier and the UNKNOWN-failure classifier across the
Stage A corpus and the Stage B failure records, and compares the result
against the same `benchmark.yaml` expected facts Stage A uses — labels never
come from the analyser. `--fixture` runs with deterministic canned answers
and needs no credentials; the default mode needs
`JEV_ENABLED`/`JEV_GATEWAY_URL`/`JEV_API_KEY` and fails fast without them.
`--max-calls` (default 150) and `--delay-ms` (default 250) guard cost and
rate; a repository whose run file already carries the same evidence
fingerprint and schema versions is resumed, not re-asked.

```bash
pnpm jev:eval                     # every corpus repository
pnpm jev:eval --repo repo-001     # one (or several --repo) entries
pnpm jev:eval --failures          # replay the Stage B failure records
pnpm jev:eval --plan              # dry-run: selection, sizes, call count
```

As of 2026-09-20 a full evaluation (360 labelled decisions across 120
repositories) found the shadow model produced no discriminative signal and
misclassified every verifiable failure case — Jev shadow analysis is not
adopted (`docs/decisions/README.md`). The code stays behind `JEV_ENABLED`
(unset in production) with zero runtime effect, and `pnpm jev:eval` remains
a one-command re-evaluation if a future model version warrants it. Its
resume cache and result files moved from `docs/testing/jev-shadow/runs/` to
`scripts/jev-eval/runs/` (`EVAL_DIR` in `scripts/jev-eval/index.ts`) — next
to the harness that reads it, alongside the `version-canary`,
`repository-compatibility` and `repository-deployment` harness directories.

## The manual full-product walk

Everything above is repeatable and scriptable. What it cannot prove is
whether the product, as a whole, is pleasant and correct to use with an
**arbitrary third-party application** driven by a **human** through the real
dashboard — Documenso is the standing choice, because it needs PostgreSQL, a
migration command, and a real health path, and is not a Deployz-controlled
fixture. The written checklist for this walk is
[`manual-checklist.md`](manual-checklist.md).

Run it:

- **Manually**, on demand.
- **Periodically**, as a standing hygiene check independent of any specific
  change.
- **Before a significant release** — the same standard the version canary's
  three-consecutive-`core`-passes gate applies to the fixture ladder, applied
  once to a real application.
- **After an analyser, build, or platform change** that the automated layers
  above cannot exercise directly (a change to the analyser's detectors, the
  CodeBuild/ECR build pipeline, or the published templates).
- **Never on a pull request.** Like the rest of this document, it is not a
  merge gate.

## What is kept where

Nothing under `runs/` moved except `jev-shadow` (above).
`repository-compatibility/findings.md`, `benchmark.yaml`, `.cache/` and
`runs/` stay where the Stage A harness reads them
(`docs/testing/repository-compatibility/`).
`repository-deployment/findings.md`, `deploy-config.yaml` and `runs/` stay
where the Stage B harness reads them
(`docs/testing/repository-deployment/`). This document replaces
`repository-compatibility/README.md` and `repository-deployment/README.md`,
which are deleted — the harness code, `findings.md` registries and YAML
configuration are the source of truth for anything not covered here (corpus
entry format, finding categories, the full result-record schema, the
multi-region campaign flags).
