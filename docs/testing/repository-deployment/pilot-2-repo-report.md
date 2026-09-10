# 2-repository pilot report — 2026-09-09/10

## Purpose

Not "can two applications deploy", but: **can Deployz now test diverse
applications quickly and reliably** using real build diversity, a reusable
AWS runtime, limited fresh provisioning and simulator-first debugging?

## Repository selection

Both drawn from the pinned corpus in
`../repository-compatibility/benchmark.yaml`. No new list was created.

| | Stage A id | Repository @ pinned SHA | Capabilities | Why |
| --- | --- | --- | --- | --- |
| 1 | repo-008 | `TwiN/gatus` @ `4d15cb7` | Go, scratch image, **no database, no Redis**, custom health path | The only zero-dependency repository with prior real-AWS evidence; the simple baseline for the fresh lane. Carries open finding DEPLOY-002. |
| 2 | repo-007 | `ghostfolio/ghostfolio` @ `73e4f03` | Node/NestJS + Prisma, **PostgreSQL + Redis + worker** | The widest MVP capability surface, and the **only** Redis-capable repository among all 120 corpus entries with any real deployment evidence. |

The requested passed/failed/unseen mix could not be met at n=2 without
weakening capability diversity, which was ranked higher: only 10 of 120
corpus entries have ever touched real AWS and only one of those has Redis.
Both picks had previously passed under the **old** fresh-per-repo approach,
which makes them the right control — known-good ground truth isolates
testing-architecture defects from repository defects. That is exactly what
happened: every defect found was in the harness or the product.

## Results

```
2 total
1 PASS                    repo-007
1 PASS_WITH_LIMITATION    repo-008
0 EXPECTED_UNSUPPORTED
0 FAIL_DEPLOYZ
0 FAIL_REPOSITORY
0 BLOCKED_EXTERNAL
```

### repo-008 — TwiN/gatus @ 4d15cb7 — PASS_WITH_LIMITATION

| Field | Value |
| --- | --- |
| Capabilities | Go, no database, no Redis, custom health path `/health` |
| Build result | PASS — **image reused, no CodeBuild run** |
| Image digest | `sha256:967ec924f9abe375c34668ea29b46f88143161f0ef390d049d0fab6c417d3d7b` |
| ECR tag | `326f33cf-…-repo-008-4d15cb7-5ca84474-r2` |
| AWS mode | Fresh (B3) — the reusable lane does not exist (DEPLOY-017) |
| Deployment result | Both stacks CREATE_COMPLETE; installation `21597bbc-…` |
| Health result | **HEALTHY** — `https://d-11eb78fb-….deployz.dev/health` returned `200 {"status":"UP"}`, ALB target healthy, and the control plane itself reported `health=HEALTHY relay=CONNECTED` |
| Root cause of the limitation | The harness lost DNS to `api.deployz.dev` mid-poll when the machine slept, so its recorded classification is `TEST_HARNESS_ERROR`. The limitation is in the observation, not the deployment. |
| Total runtime | ~17 min start to healthy HTTPS, with the image reused |
| Cleanup result | **PASS**, `leaks: []`, bootstrap `DELETE_COMPLETE` (95.3 min, dominated by the retained-database purge) |

### repo-007 — ghostfolio/ghostfolio @ 73e4f03 — PASS

| Field | Value |
| --- | --- |
| Capabilities | Node/NestJS + Prisma, PostgreSQL + Redis + worker, migrations at boot |
| Build result | PASS — real CodeBuild over the full monorepo, 334s |
| Image digest | `sha256:ef481ebf6c418cc0cbe9d93a314b9bd5ac498fabd09b5f52be3d5f3274c8625c` |
| AWS mode | Fresh (B3) |
| Deployment result | bootstrap + `deployz-app-e4f46fe4` CREATE_COMPLETE; installation `e4f46fe4-…` |
| Health result | **HEALTHY** — ecs HEALTHY, alb HEALTHY, https PASS, `releaseServing: true`, 6 samples over a 180s window, at `https://d-15224ca0-….deployz.dev` `/api/v1/health` |
| Dependencies | postgres **PASS**, redis **PASS**, migration **PASS**, storage NOT_REQUIRED |
| Root cause if failed | n/a. Earlier attempts failed on DEPLOY-018/019/021/024 — all product or harness defects, none attributable to ghostfolio |
| Total runtime | **48.4 min** end to end |
| Cleanup result | Disconnect + Purge through the product |

`runningImageDigest` equals `imageDigest`, so the application served the
image Deployz built rather than a template-pinned stand-in — the DEPLOY-001
class of failure, verified absent.

### A note on the committed run records

`runs/repo-007.json` carries this pilot's result (PASS, with the full runtime
and dependency evidence). `runs/repo-008.json` still carries its **Wave-1**
record: the pilot's own attempt record was discarded during a branch reset,
and the later cleanup pass rewrote only the cleanup section. Read repo-008's
result from this report and its evidence ledger, not from that file.

## Timing

### Measured in this pilot

| Stage | repo-008 (image reused) | repo-007 (real build) |
| --- | --- | --- |
| analysis | 0.3 min | 0.8 min |
| build | 0.05 min (reused) | 5.6 min |
| deployment (bootstrap + install) | 11.8 min | 28.5 min |
| health / HTTPS / observation | included above | 12.5 min |
| **funnel total** | **~17 min** | **48.4 min** |
| cleanup | 95.3 min | ~90 min (retained database + Redis) |

### The old approach, from the committed Wave-1 results

| id | build | deploy | cleanup | funnel |
| --- | --- | --- | --- | --- |
| repo-007 | 5.5 | 22.4 | 94.2 | 43.2 |
| repo-008 | 1.7 | 17.5 | 79.5 | 34.7 |
| repo-035 | 1.4 | 17.9 | 89.5 | 33.3 |
| repo-039 | 2.1 | 23.0 | 94.5 | 44.5 |

Means over the four passes: build 2.7, deploy 20.2, **cleanup 89.4**,
funnel 38.9 (minutes).

### What the comparison actually shows

- **Fresh-AWS funnel time is unchanged** (repo-007: 43.2 min then, 48.4 min
  now). It could not improve — the reusable runtime that was supposed to
  remove provisioning does not exist.
- **Image reuse works and is real, but small**: 1.7 → 0.05 min on gatus,
  about 5.6 min saved per ghostfolio retry.
- **Cleanup is the bottleneck — roughly 90 min per repository, two to three
  times the entire funnel.** Build caching is not the lever.
- **Pipelining cleanup is the lever that does work.** repo-008's Disconnect
  and Purge ran concurrently with repo-007's build and install, so N
  repositories need not cost N × 90 min: `--keep` now, `--cleanup` later.
- Fresh vs reusable runtime: **not measurable** — no reusable runtime exists.
- Image built vs reused: 2 reused, 3 built.
- AWS retries: repo-008 four attempts, repo-007 five. Every extra attempt was
  caused by a harness or product defect; none by the repository.
- Simulator-only fix iterations: DEPLOY-019 and DEPLOY-020 were both
  reproduced and fixed with deterministic tests in seconds, no AWS in the
  loop.

## Findings

### Systemic defects found — eight, none of them a repository defect

| Id | Severity | Status |
| --- | --- | --- |
| DEPLOY-017 | Test architecture invalid | FIXED, merged #260 |
| DEPLOY-018 | P1 build infrastructure | **OPEN** — needs a Docker Hub credential |
| DEPLOY-019 | Harness — retries wedged permanently | FIXED, merged #262 |
| DEPLOY-020 | Harness/product drift, plus silent ECR leaks | FIXED, merged #262 |
| DEPLOY-021 | **P0 — every customer install failed** | FIXED, merged #269 |
| DEPLOY-022 | Analysis error with real cost | OPEN, tracked as COMP-029 |
| DEPLOY-023 | Harness — two-hour dead wait per failed repository | **OPEN** |
| DEPLOY-024 | **P0 — install looks fine, relay never enrols** | FIXED, merged #273 |

Two P0 outages shipped to production *during* the pilot (both from PR #265)
and were caught only because real AWS installs were running. Neither was
detected by the full unit suite, by CI, or by the simulated E2E scenarios.
DEPLOY-021 also masked DEPLOY-024: fixing the first is what exposed the
second.

### Bugs fixed

Four, across four PRs, each with a regression test: #260, #262, #269, #273.

### Deterministic regressions added

- `--runtime-reuse` refuses with the reason (DEPLOY-017).
- The `createRelease` fake now models the version-uniqueness constraint, and
  a test asserts a retry after a failed build reaches PASS on `-r2`
  (DEPLOY-019). The pre-existing test passed while production answered 409
  precisely because the fake did not model that constraint.
- The funnel looks the image up under the namespaced tag and never the bare
  version, plus a contracts test pinning the tag rule (DEPLOY-020).
- The bootstrap template never reads an `Arn` attribute off a SecretsManager
  secret — verified to fail on the pre-fix code with 4 offending references
  (DEPLOY-021).
- The template never stores the credential bare and both variants carry a
  `token`, and the relay rejects a bare credential — both halves of the
  contract (DEPLOY-024).

### Unsupported gaps

None encountered. Both repositories are inside the MVP boundary and both
deployed.

### Cleanup problems

- Cleanup itself is **correct**: Disconnect and Purge swept the retained
  database and the orphaned VPC, and the final audit shows **zero pilot
  leaks**, with account state identical to the pre-run baseline.
- DEPLOY-023: a purge waits the full 120 minutes when the relay never
  enrolled and nothing can execute it.
- DEPLOY-022: most of the ~90 min teardown removes a database the
  application never needed.
- `--audit` over-attributes. It scans account-wide on
  `DeployzTestMode=canary`, so a concurrent version-canary run made it report
  "7 resource(s) still attributable to Stage B" when none were. Filtering on
  the `stage-b-` run-tag prefix would make it precise.

### Test-harness problems

- `--keep` together with `--reuse-application` wedges the next retry (409,
  one test deployment per application) and misattributes it as `INFRA_ERROR`
  against the repository.
- Long polls do not survive a sleeping laptop or a transient DNS loss; an
  8.5-hour dead wait was recorded. Corpus runs need a host that stays awake
  (CI or an EC2/CodeBuild runner).
- No analysis-stage duration is recorded in the result schema, though it is
  recoverable from the evidence ledger's per-step durations.

### Remaining P0/P1 MVP blockers

1. **DEPLOY-018** (P1, open) — the build pulls base images from Docker Hub
   anonymously. Two of this pilot's build attempts died on HTTP 429, on two
   different repositories and two different base images within one hour. At
   100 repositories × 1–3 base images, a corpus run needs 100–300 pulls
   against a roughly 100-per-6-hours allowance in a single account. **This
   alone blocks scaling.**
2. **DEPLOY-023** (open) — two hours of dead polling for every repository
   whose install fails before enrolment. Historically most Stage B attempts
   failed at or before install.
3. **COMP-029 / DEPLOY-022** (open) — a false `postgres: true` bills
   customers for unused databases and turns a minutes-long teardown into a
   ~90 minute one.

## Decision

```
NO-GO → fix testing/deployment blockers before scaling
```

### Why

The pilot did its job. It found eight systemic defects, including two P0
production outages, and it never once blamed a repository for a product
defect. The simulator-first half of the strategy works well: two harness bugs
were reproduced deterministically and fixed in seconds without AWS, and the
two P0s each gained a deterministic CDK regression that fails on the pre-fix
code.

But the acceptance gate does not pass:

| Gate item | Result |
| --- | --- |
| Both repositories have defensible final results | **PASS** |
| Reusable AWS path works | **FAIL** — architecturally impossible (DEPLOY-017) |
| No cross-repo state contamination | **PASS** |
| Image reuse works on retry | **PASS**, after fixing DEPLOY-019 and DEPLOY-020 |
| Simulator-first bug fixing works | **PASS** |
| Cleanup and leak audit pass | **PASS** — zero leaks, with the caveats above |
| At least one fresh AWS case passes | **PASS** — repo-007 fully, repo-008 healthy |
| Timings show meaningful improvement | **PARTIAL** — reuse is real but small; cleanup still dominates |
| No unresolved P0 test-harness defect | **FAIL** — DEPLOY-018 and DEPLOY-023 open |

The pilot's central premise — one reusable AWS runtime shared across
repositories — is invalid against the current data model, so the headline
speed-up does not exist. What remains is the old fresh-per-repo cost plus two
open defects that would make a 10-repository run unreliable (Docker Hub 429s)
and slow (two-hour dead waits). Scaling now would burn hours to produce
results that misattribute product and harness failures to repositories —
which is exactly what the corpus already suffers from. Only 4 of 120 entries
have ever been verified, and these defects are much of the reason.

### What to fix first, all cheap relative to their cost

1. **DEPLOY-018** — authenticate Docker Hub in the buildspec from a secret,
   or add an ECR pull-through cache. One credential decision. Without it a
   10-repository run will fail unpredictably.
2. **DEPLOY-023** — skip the purge wait when the ledger shows no relay ever
   bound. The ledger already records everything needed to decide.
3. **COMP-029** — the analyser's false `postgres: true`. Removes most of the
   teardown cost for the many corpus repositories that need no database.
4. Re-cut the deployment classes: B1 was the default for 107 of 120 entries
   and no longer exists.

With items 1–3 done, re-run this same two-repository pilot to confirm, then
scale to 10. The harness is otherwise sound — it classified every failure
correctly, never blamed a repository for a product defect, and cleaned up
without leaking.
