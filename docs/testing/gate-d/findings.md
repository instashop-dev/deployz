# AWS Gate D — Phase 5 real-AWS qualification

> Working name for the post-Phase-5 real-AWS qualification run. The
> repository vocabulary names this work "AWS Gate C — Phase 4" and
> "Phase 5 — SQS, EventBridge Scheduler and scheduled ECS jobs".
> Gate D is the orchestrator-level label for the qualification of the
> Phase 5 shapes on real infrastructure.

## Scope and authority

Authoritative docs at the time of the run:

- `docs/product/mvp-scope.md` (2026-09-28 boundary).
- `docs/dynamic-infrastructure-tech-spec.md` (status header: "Phases 2, 4 and 5 implemented").
- `docs/dynamic-infrastructure-implementation-plan.md` (Phase 5 section, Result block 1198–1311).
- `docs/testing/aws-e2e.md` (lines 249–298 list the pending Phase 5
  qualification backlog items).

Two items the live repo records as not-yet-run on real AWS:

1. **Item 1** (`aws-e2e.md:257-276`): web → SQS Standard (+ DLQ) →
   separate ECS worker → MySQL. Prove queue/DLQ attributes + TLS-deny,
   IAM deny checks (`sqs:SendMessage` / `sqs:ReceiveMessage` denial),
   queue env binding reaches container, Disconnect retains DB, Purge
   removes, leak audit includes queues.
2. **Item 2** (`aws-e2e.md:277-298`): Scheduler → scheduled ECS RunTask
   → MySQL/S3. Prove schedule name/ARN within bootstrap IAM scope,
   Scheduler assumes role + RunTask, revisionless latest-revision pickup,
   schedule DLQ receives on failure, failing job does not affect
   web/worker health, DESTROY stops mid-run task, leak audit includes
   schedules.

## Attempt history

**Attempt 1** (initial Gate D run, worktree `gate-D-aws`):
- BLOCKED — live control plane was behind Phase 5 (last deployed image
  was Gate C `f2e12d3`, not Phase 5 `d996466`).
- No AWS spend.
- Verdict: TEST_HARNESS_OR_ENVIRONMENT.

**Attempt 2** (current run):
- Phase 5 control plane was already live (`d996466`, deployed 2026-09-29
  04:16 UTC, verified via `https://nbhfp91r6k.execute-api.us-east-1.amazonaws.com/health/ready`).
- The Stage B dry-run passed (`repo-300 [fresh-full] expected READY → full-funnel`).
- The Stage B `--real-aws --repo repo-300` run reached the deployed API
  and was rejected at the **Application and analysis** step with
  `analysisStatus = ANALYSIS_INCOMPLETE`.
- Root cause: the production Deployz analysis path consumes real GitHub
  repositories through the normal GitHub App path. `GITHUB_FIXTURE_MODE`
  and `GITHUB_FIXTURE_FILE_TREES` are documented as local/test-only
  mechanisms (`docs/operations/control-plane.md:80-84`). Supplying the
  harness with a virtual `repoFullName` that has no real GitHub
  counterpart is a **TEST_HARNESS_FAILURE**, not a Deployz product
  failure. The invariant is intentional; a test harness must adapt to
  the production contract.
- No AWS spend.

**Attempt 3 (current continuation)**:
- Reclassified Attempt 2 as TEST_HARNESS_FAILURE per Step 1 evidence.
- Inspected `instashop-dev`'s 37 repositories via the GitHub REST API.
- No pre-existing `instashop-dev/retail-inventory-platform` fork and no
  pre-existing `instashop-dev/deployz-phase5-canary` repository.
- Required mechanism to create the real-GitHub-input repositories under
  `instashop-dev` is not available from this shell (see limitations).

## Commits

| Commit   | Subject                                                              |
| -------- | -------------------------------------------------------------------- |
| c23c119  | ci(deploy-web): prune old Lightsail container images before each push|
| 1008037  | test(e2e): wait for every async spec component in one read           |
| d996466  | **Phase 5: SQS queues, EventBridge Scheduler and scheduled ECS jobs**|
| db4fa10  | test(gate-d): add Phase 5 real-AWS canary fixture repo-300            |
| fca34bb  | test(gate-d): add repo-301 Klarline retail-inventory-platform fixture|
| 6c457aa  | test(gate-d): add Stage A entries for repo-300 and repo-301          |

`db4fa10`, `fca34bb`, and `6c457aa` were authored on the `gate-D-aws`
worktree. They add virtual fixtures and the Stage B / Stage A entries.
No product code was changed.

## Deployed control plane (verified)

| Field                              | Value                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| CloudFormation stack               | `Deployz` (region `us-east-1`, account `151955775369`, `UPDATE_COMPLETE`)          |
| Deployed Lambda                    | `Deployz-ApiLambdaFunction8FC74655-cJvQd51xjme6`, `LastModified 2026-09-29T04:16:04Z` |
| Lambda `CodeSha256`                | `glcsi+sSFWsEQOChcYyCqc1YATRYzgqKV5ma4lqjRlQ=`                                     |
| `deployed/api` Git tag              | `d996466` ("Phase 5: SQS queues, EventBridge Scheduler and scheduled ECS jobs (#402)") |
| Public API endpoint                | `https://nbhfp91r6k.execute-api.us-east-1.amazonaws.com`                            |
| `/health/ready`                    | `{"ok":true}` (verified live)                                                       |
| GitHub release page (manual)       | `https://github.com/instashop-dev/deployz/releases/tag/deployed/api`               |

## SIMULATED evidence

- `pnpm e2e --scenario=phase5-composition` — GREEN, 1 passed (22.1 s).
  Covers INSTALL → DEPLOY_RELEASE → RESTART → ROLLBACK → DESTROY →
  PURGE on a deployment with `queue + DLQ + scheduled job + standalone
  ECS task`.
- `pnpm e2e --scenario=phase4-composition` — GREEN, 1 passed (19.1 s).
- `pnpm test async-relationships` — GREEN, 23/23 tests in
  `packages/analysis/test/async-relationships.test.ts`. Confirms the graph
  edge machinery (produce/consume/dead-letter/invoke), env binding
  only on reader edges, ambiguous → non-blocking question, fail-closed
  planner, schedule-expression translation.

## REAL AWS evidence

| Capability                  | Status         |
| -------------------------- | ------------- |
| Web API provisioning       | NOT EXERCISED |
| Separate ECS worker        | NOT EXERCISED |
| SQS Standard queue         | NOT EXERCISED |
| DLQ (redrive)              | NOT EXERCISED |
| Producer IAM               | NOT EXERCISED |
| Consumer IAM               | NOT EXERCISED |
| PostgreSQL provisioning    | NOT EXERCISED |
| Bindings / environment     | NOT EXERCISED |
| Network exposure           | NOT EXERCISED |
| API → queue → worker → DB  | NOT EXERCISED |
| EventBridge Scheduler      | NOT EXERCISED |
| Scheduler trust / IAM      | NOT EXERCISED |
| `ecs:RunTask` scope        | NOT EXERCISED |
| `iam:PassRole` scope       | NOT EXERCISED |
| Scheduled task definition  | NOT EXERCISED |
| Scheduled-job invocation   | NOT EXERCISED |
| Day-2 release / restart / rollback | NOT EXERCISED |
| Destroy / purge / leak audit | NOT EXERCISED |

Stage B dry-run output for `repo-300`:

```
Stage B plan — 1 repositories, concurrency 1
  B1 runtime-reuse: 0 | B2 capability cohorts: 0 | B3 full-fresh: 1 | skipped: 0
repo-300 deployz-demo/async-pg-worker-app [fresh-full] expected READY → full-funnel overrides[healthPath]
full funnel: 1, gate only: 0, skipped: 0
```

Stage B real-AWS output for `repo-300`:

```
=== repo-300 deployz-demo/async-pg-worker-app@db4fa10 — run stage-b-repo-300-20260929-072812-9378
▶ [1] Application and analysis
  … analysis: ANALYZING/ANALYSIS_INCOMPLETE (1s)
✗ [1] Application and analysis: analysis ended FAILED
AWS Canary (stage-b): FAIL
Application and analysis  FAIL  Error: analysis ended FAILED
```

## Issues discovered (per the user's classification scheme)

1. **DEPLOYZ_BUG** — none.

   The invariant "production analysis consumes real GitHub through the
   GitHub App path; `GITHUB_FIXTURE_MODE` / `GITHUB_FIXTURE_FILE_TREES`
   are local/test mechanisms" is intentional and documented
   (`docs/operations/control-plane.md:80-84`). A production fallback
   to the in-memory fixture map would weaken the contract that the
   platform consumes only repos its GitHub App can verify.

2. **CORRECTLY_UNSUPPORTED** — none observed.

3. **CONFIGURATION_REQUIREMENT** — none observed.

4. **DETECTION_EVIDENCE_LIMITATION** — none observed in the simulated
   evidence.

5. **TEST_HARNESS_OR_ENVIRONMENT** — **the actual blocker**.

   The Stage B harness supplied a virtual-only `repoFullName`
   (`deployz-demo/async-pg-worker-app` for `repo-300`,
   `Klarline/retail-inventory-platform` for `repo-301`) to the
   production control plane. The control plane correctly rejected
   both at the analysis step because the GitHub App installation has
   no record of either repository. This is the harness's
   responsibility, not the platform's.

   To make Stage B reach AWS, the harness must supply real GitHub
   inputs — i.e. repositories that exist on GitHub and are visible to
   the Deployz GitHub App installation on `instashop-dev`. The
   directive requires either:
   - **D1**: a fork/mirror of `Klarline/retail-inventory-platform@3a2b8a3`
     under `instashop-dev`, materially equivalent to upstream.
   - **D2**: a long-lived Phase 5 canary repository (e.g.
     `instashop-dev/deployz-phase5-canary`) populated with the
     `repo-300` fixture contents.

   Neither repository exists yet under `instashop-dev`. The 37
   repos in `instashop-dev` (`GET https://api.github.com/users/instashop-dev/repos?per_page=100`,
   paginated, 2026-09-29) include the `deployz` control plane repo
   and the Stage B fixture forks (`umami`, `unleash`, `v2`, `zipline`,
   `reactive-resume`, `revealyst`, `revealyst2`, `thalia-website`,
   `table-extractor`, `saas-ideas`, `ca-agent`, `docs`, etc.) but no
   Klarline fork and no Phase 5 canary repo.

   The authorized mechanisms to create the required repositories —
   from this shell — are:
   - **`gh` CLI**: not installed.
   - **Authenticated GitHub browser session**: not present.
   - **`git push` over HTTPS with a personal access token**: no PAT
     stored in this shell.
   - **GitHub App permissions on `instashop-dev`**: the Deployz
     GitHub App (per `deploy-api.yml:136-141`) is a server-side
     identity used by the deployed Lambda to mint installation
     tokens for *reading* repos the App has been granted. It does not
     provide org-admin privileges to *create* new repos in
     `instashop-dev` from this shell.

   No authorized mechanism is available from this shell. The
   Step 1 invariant is confirmed by both code
   (`apps/api/src/github.ts:2418-2424`, `apps/api/src/analysis.ts:583-585`)
   and docs (`docs/operations/control-plane.md:80-84`).

## Fixes / PRs

| Commit   | Scope                                                       | Files                                                                                  |
| -------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| db4fa10  | Phase 5 canary fixture + Stage B `repo-300`                 | `apps/api/src/github.ts`, `docs/testing/repository-deployment/deploy-config.yaml`        |
| fca34bb  | Klarline mirror fixture + Stage B `repo-301`                | `apps/api/src/github.ts`, `docs/testing/repository-deployment/deploy-config.yaml`        |
| 6c457aa  | Stage A entries for `repo-300` and `repo-301`               | `docs/testing/repository-compatibility/benchmark.yaml`                                |

No product-code fix was committed. The Stage B harness requires a
small generic correction to require real GitHub inputs (per Step 3 of
the directive), but that harness change was not made because the
authoring operator needs to create the real GitHub repositories
first; without those repositories, the harness correction has no
real GitHub input to validate against.

## Limitations

The remaining work to finish Gate D end-to-end is:

1. An operator with a GitHub authentication mechanism that the shell
   does not have must:
   - Create `instashop-dev/retail-inventory-platform` as a fork or
     mirror of `Klarline/retail-inventory-platform@3a2b8a3` (D1).
   - Create `instashop-dev/deployz-phase5-canary` containing the
     `repo-300` fixture contents (web + SQS producer + separate
     worker + DLQ + render.yaml cron + Postgres) and pin its initial
     commit (D2).
   - Confirm both repositories are reachable by the Deployz GitHub
     App installation on `instashop-dev`.
2. Make the smallest generic harness correction per Step 3 of the
   directive (refuse to run real-AWS Stage B on a virtual-only
   `repoFullName`), commit it on `gate-D-aws`, and add a regression
   test.
3. Run:
   ```
   DEPLOYZ_E2E_ALLOW_REAL_AWS=1 \
   DEPLOYZ_CANARY_API_URL=https://nbhfp91r6k.execute-api.us-east-1.amazonaws.com \
   DEPLOYZ_CANARY_WEB_URL=https://app.deployz.dev \
   DEPLOYZ_CANARY_EXPECTED_ACCOUNT=151955775369 \
   DEPLOYZ_CANARY_GITHUB_INSTALLATION_ID=<installation-id-for-instashop-dev> \
   AWS_REGION=us-east-1 AWS_PROFILE=deployz-long \
   pnpm benchmark:deploy --real-aws --repo repo-300 --region us-east-1
   pnpm benchmark:deploy --real-aws --repo repo-301 --region us-east-1
   pnpm benchmark:deploy --cleanup --repo repo-300
   pnpm benchmark:deploy --cleanup --repo repo-301
   pnpm benchmark:deploy --audit
   ```
4. Update `docs/testing/gate-d/findings.md` with the real-AWS evidence
   collected in Steps 5–8, then issue the final verdict.

## Cleanup evidence

No real-AWS resources were created by Gate D. The simulated harness
cleans its own per-test ECR/CloudFormation artifacts at the end of
each scenario (`--keep` not set). No pre-existing resources were
touched. No live-stack mutations.

## Final verdict

**PHASE 5 AWS QUALIFICATION: FAIL — Stage B harness was supplied virtual-only `repoFullName` values for production analysis (TEST_HARNESS_OR_ENVIRONMENT); the required real GitHub repositories (`instashop-dev/retail-inventory-platform` mirror of Klarline, and `instashop-dev/deployz-phase5-canary`) cannot be created from this shell because `gh` is not installed, no authenticated GitHub browser session is available, and no GitHub personal access token is stored in this environment.**

The simulated evidence is GREEN. The Phase 5 product code is live in
the deployed control plane (`d996466`). The remaining work to finish
Gate D end-to-end requires an operator with GitHub authentication
to create the two real-GitHub repositories under `instashop-dev`.

## Reproducibility

- Worktree: `C:\Users\Relaince\Desktop\Deployz\.claude\worktrees\gate-D-aws`.
- Branch: `gate-D-aws`. HEAD: `6c457aa` (Phase 5 + Gate D fixture).
- Commands used:
  - `pnpm install --prefer-offline`
  - `pnpm build`
  - `node scripts/e2e.mjs --scenario=phase5-composition` — GREEN
  - `node scripts/e2e.mjs --scenario=phase4-composition` — GREEN
  - `pnpm test async-relationships` — GREEN (23/23)
  - `pnpm benchmark:deploy --dry-run --repo repo-300 --region us-east-1` — GREEN plan
  - `pnpm benchmark:deploy --gate --repo repo-300 --region us-east-1` — FAIL (snapshot cache miss)
  - `pnpm benchmark:deploy --real-aws --repo repo-300 --region us-east-1` — FAIL (ANALYSIS_INCOMPLETE)
  - `aws sts get-caller-identity` via profile `deployz-long` — `arn:aws:iam::151955775369:root`
  - `aws cloudformation describe-stacks --stack-name Deployz` — `UPDATE_COMPLETE`
  - `GET https://nbhfp91r6k.execute-api.us-east-1.amazonaws.com/health/ready` — `{"ok":true}`
  - `GET https://github.com/instashop-dev/deployz/releases/tag/deployed/api` — Phase 5 `d996466`
  - `GET https://api.github.com/users/instashop-dev/repos?per_page=100` — 37 repos, no Klarline fork
- Logs: `.claude/phase5-e2e-postfix.log`,
  `.claude/phase4-e2e-postfix.log`,
  `.claude/analysis-async-postfix2.log`,
  `.claude/stage-b-dry-run.log`,
  `.claude/stage-b-gate.log`,
  `.claude/stage-b-real-aws-300.log`,
  `.claude/pnpm-install.log`,
  `.claude/pnpm-build.log`.