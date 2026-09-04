# Repository compatibility audit (Stage A)

The Stage A audit runs the production repository-analysis path against a
fixed corpus of real open-source repositories, pinned to immutable commits,
and compares the result with validated expected facts. It measures how the
current analyser and MVP boundary treat real code; it does not build a new
analyser, a benchmark platform, or a deployment path. Nothing in the corpus
is ever executed on the control plane — repository content is read-only,
untrusted data, exactly as it is in production.

## Purpose

- Measure verdict accuracy on realistic customer repositories: how many are
  classified correctly, how many are falsely rejected, how many are falsely
  accepted.
- Separate analyser defects (fixable now, with a regression test) from MVP
  capability gaps (a product decision) and deliberate exclusions.
- Leave a durable record — corpus, expected facts, findings, results — that
  a future agent can rerun and extend.

## Scope

Stage A covers analysis only: the file-tree fetch, the deterministic
detectors and rejection checks, the readiness report, and the
deployment-creation gate. It stops before any AWS execution. The AI fallback
is not exercised: the harness runs with an unconfigured AI gateway, so the
questions the §15 fallback would have asked are recorded on each result
(`actual.unresolvedQuestions`) rather than answered.

Two verdict layers exist in Deployz, and both are captured:

| Layer | Produced by | Vocabulary | Recorded as |
| --- | --- | --- | --- |
| Analysis verdict | `buildReadinessReport` → `applications.compatibility_status` | READY / NEEDS_ATTENTION / NOT_COMPATIBLE | `actual.analysisVerdict`, `actual.readinessState` |
| Deployment gate | `normalizeDeploymentManifest` + `evaluateManifestReadiness` (`POST /api/deployments`) | READY / NEEDS_CONFIGURATION / NOT_COMPATIBLE | `actual.compatibility` |

`expected.compatibility` states the **deployment gate** outcome for a freshly
imported application with no configured values (`providedEnvKeys: []`), because
that is the state a customer deployment is gated on:

- `READY` — deployable as-is.
- `NEEDS_CONFIGURATION` — deployable once the vendor supplies configuration
  (a port, a start command, a Dockerfile path, a required environment value).
- `NOT_COMPATIBLE` — rejected: the repository needs code or architecture
  changes Deployz cannot provision around.

Expected facts describe the repository **as a vendor would configure it for
Deployz through environment variables alone, with no code change**. An app
that selects its database or storage backend by configuration (PostgreSQL
among several engines, S3 as an alternative to local disk) is deployable
and its expectation names the Deployz-compatible configuration
(`postgres: true`, `storage: true`, `NEEDS_CONFIGURATION` when a value must
be set). Only an intrinsic requirement — SQLite as the sole database, a
declared separate worker process (the Phase 8 boundary in
`docs/architecture.md`), a second application service — makes a repository
`NOT_COMPATIBLE`. A Dockerfile that cannot build from
the repository alone (it copies an artifact no build step produces) counts
as a missing Dockerfile: `NEEDS_CONFIGURATION`.

## Selection methodology

Repositories are chosen for customer realism and architecture diversity, not
popularity. Priority order: architecture diversity, coverage of the MVP
compatibility boundaries, deployment-pattern diversity, dependency diversity,
repository messiness, runtime/framework diversity, then popularity. Language
diversity is soft — a low-realism repository is never added to fill a quota.

Cohorts:

- `realistic` — plausible Deployz customers expected to be supported (single
  HTTP apps, PostgreSQL/Redis-backed apps, migration-based apps, monorepos
  with one deployable service, varied Dockerfile locations and health paths).
- `messy` — plausible but untidy (several Dockerfiles, dev Compose alongside
  a production Dockerfile, nested monorepos, mixed package managers, sparse
  or conflicting documentation, sub-directory apps).
- `boundary` — repositories that fall outside the MVP by design (SQLite,
  background workers, Kafka/RabbitMQ/SQS consumers, multi-service Compose,
  persistent volumes, Kubernetes, Terraform/Pulumi, serverless, GPU,
  Azure/GCP-specific deployments).

Sets:

- `improvement` — the 80 repositories used to find and fix analyser defects.
- `unseen` — 20 repositories selected after the improvement corpus was
  complete and the analyser baseline frozen; their first results are never
  used to change the analyser before the whole set is reported.

Every entry pins an immutable 40-character commit SHA. Expected facts are
written from repository evidence (manifests, Dockerfiles, compose files,
route code, env samples), checked independently, and reconciled before an
entry is accepted. Expected facts are never copied from analyser output.

## Benchmark entry format

```yaml
- id: repo-001
  repository: owner/repo
  commit: <40-hex immutable sha>
  cohort: realistic          # realistic | messy | boundary
  set: improvement           # improvement | unseen
  expected:
    compatibility: READY     # READY | NEEDS_CONFIGURATION | NOT_COMPATIBLE
    runtime: [node]          # descriptive only (see below)
    monorepo: false          # descriptive only (see below)
    postgres: true           # Deployz should provision PostgreSQL
    redis: false             # Deployz should provision Redis
    worker: false            # worker-like code is present
    # optional, compared only when stated:
    storage: false           # object storage required
    migration: true          # a deploy-safe migration command resolves
    appRoot: apps/api        # manifest application root
    dockerfilePath: apps/api/Dockerfile
    port: 3000
    healthPath: /healthz     # detected health path (null when none)
    unsupported: [sqlite]    # unsupported families that must reject
  customer_realism: high     # high | medium | low
  difficulty: 2              # 1 (trivial) .. 5 (hostile)
  findings: [COMP-001]       # findings that explain this entry's known mismatches
  notes: []
```

`runtime` and `monorepo` are recorded for corpus distribution and are not
compared: the manifest runtime model is `node | unknown`, and Deployz has no
monorepo flag (a monorepo target is measured through `appRoot` /
`dockerfilePath`). The compared facts are listed in `COMPARED_FACTS`
(`scripts/repository-compatibility/normalize.ts`).

`unsupported` uses family ids: `mysql`, `mongodb`, `elasticsearch`,
`other-database`, `sqlite`, `redis-unsupported`, `kafka`, `rabbitmq`,
`sqs-event-consumer`, `kubernetes`, `serverless`,
`docker-compose-multi-service`, `persistent-volume`, `terraform`, `pulumi`,
`cloudformation`, `azure`, `gcp`, `gpu`, plus the two non-rejection blockers
`local-filesystem` and `background-worker` (worker code with a resolved
worker start command).

## Finding categories

| Type | Meaning | Action |
| --- | --- | --- |
| `ANALYSIS_BUG` | The analyser had the evidence and drew the wrong conclusion. | Fix, with a regression test. |
| `ANALYSIS_MISSING_SIGNAL` | The analyser does not read a signal the repository plainly carries, and reading it is within the current MVP. | Fix, with a regression test. |
| `MVP_CAPABILITY_GAP` | The repository needs something the MVP does not provide; the analyser is right to stop. | Record; rank in the final report. |
| `CORRECTLY_UNSUPPORTED` | The repository sits outside the MVP boundary by decision and is rejected with evidence. | Record; confirms the boundary. |
| `REPO_INVALID` | The snapshot is unusable as a benchmark member (not an application, broken, misleading). | Replace it. |

A behaviour learning counts as fixed only once a regression test protects it.

## How to run the audit

Build once (the harness imports the built `@deployz/api` and
`@deployz/analysis`), then:

```bash
pnpm build
pnpm benchmark:compat                    # every repository in benchmark.yaml
pnpm benchmark:compat --repo repo-001    # one entry (repeat --repo for several)
pnpm benchmark:compat --set unseen       # one benchmark set
pnpm benchmark:compat --offline          # cached snapshots only, no GitHub
pnpm benchmark:compat --no-write         # print the summary, write nothing
```

GitHub access uses `GITHUB_TOKEN`, else the `gh` CLI's token, else
unauthenticated requests (60 per hour — too few for a full run). Snapshots
are cached under `docs/testing/repository-compatibility/.cache/` (ignored by
git) keyed by git object sha, so every repository is fetched from GitHub at
most once and reruns are offline and deterministic.

The harness tests (`pnpm vitest run --project repository-compatibility` or
`pnpm vitest run scripts/repository-compatibility`) cover manifest parsing,
the snapshot fetch, normalization, comparison, classification, and
determinism; they never reach the network.

## How a repository is analysed

For each entry the harness inserts an application row into an in-process
PGlite database with the real migrations and calls
`runApplicationAnalysis` from `apps/api` — the same function the
`POST /api/applications/:id/analyse` route runs — with:

- the production file-tree fetch (`buildFileTreeForAnalysis`: relevance
  filter, 200-file / 200 KB caps, priority order, lockfile handling),
  reading GitHub through the snapshot fetch;
- the deterministic analyser (`analyseRepo`), the AI fallback (degraded, as
  described above), the contract-field backfill, and the readiness report;
- then the deployment-creation gate over the persisted row:
  `normalizeDeploymentManifest(metadata, applicationToManifestOverrides(row))`
  and `evaluateManifestReadiness(manifest, { providedEnvKeys: [] })`.

The pure analyser is run once more over the same cached tree to recover the
rejection ids the row does not persist. No analysis logic lives in the
harness.

## How expected facts are validated

1. Pin the commit SHA and inspect the snapshot's files (manifests,
   Dockerfiles, compose files, env samples, route code).
2. Write the expected facts from that evidence. Note the evidence in
   `notes` when it is not obvious.
3. Have a second, independent inspection of the same snapshot produce its
   own facts; reconcile disagreements against the files, never against the
   analyser's output.
4. Only then run the analyser. A mismatch is a finding about the analyser or
   the boundary, not a reason to edit the expectation — unless the
   re-inspection shows the expectation was wrong, in which case the fix is
   recorded in `notes`.

## How results are interpreted

`runs/<id>.json` holds one result per repository: the pin, the Deployz commit
and analysis version, the tree statistics, the expected and normalized actual
facts, every comparison, and every mismatch with its classification.
`runs/summary.json` and `runs/summary.md` aggregate a full run (a partial
`--repo`/`--set` run never overwrites them).

- **Verdict accuracy** — the share of analysed repositories whose
  `compatibility` matched.
- **False rejection** — expected READY or NEEDS_CONFIGURATION, actual
  NOT_COMPATIBLE. The costliest error: a plausible customer is turned away.
- **False acceptance** — expected NOT_COMPATIBLE, actual READY or
  NEEDS_CONFIGURATION. A deployment that would fail later.
- **Configuration-detection mismatch** — READY vs NEEDS_CONFIGURATION: the
  verdict family is right, the configuration detection is not.
- **Fact mismatch** — any other compared fact.

A mismatch is *explained* when an entry's `findings` reference a registry
finding whose `facts` cover it; the summary counts explained mismatches by
finding type. An *unexplained* mismatch is the audit's open work: it must
become a finding (and a fix, or a documented gap) before the phase closes.

## Rules for fixing bugs vs recording capability gaps

- Fix only `ANALYSIS_BUG` and `ANALYSIS_MISSING_SIGNAL`. The fix sequence is
  fixed: finding → regression fixture → failing test → analyser change →
  passing test → rerun of the affected repositories.
- Never add an MVP capability because several repositories need it. Record
  it as `MVP_CAPABILITY_GAP` with the affected repositories; the final report
  ranks it.
- A deliberate exclusion (`docs/architecture.md`, "The MVP support boundary")
  is `CORRECTLY_UNSUPPORTED`, never a bug, even when the rejection reads
  harshly.
- Expected facts are never edited to match the analyser.
- Bump `ANALYSIS_VERSION` (`apps/api/src/analysis.ts`) whenever an analyser
  change would alter a stored verdict, so cached analyses rerun.
- During the unseen evaluation the analyser is frozen: no analyser change is
  made on the strength of an unseen repository until all twenty results are
  recorded.
