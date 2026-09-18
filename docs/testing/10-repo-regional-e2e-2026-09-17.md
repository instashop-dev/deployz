# Regional real-AWS E2E campaign — 2026-09-17/18

**Scope.** The campaign plan was ten repositories from the 100-repository
benchmark, in ten AWS regions, in five waves of two, through the full
vendor and customer lifecycle. **The campaign was stopped by decision after
wave 2.** This report covers waves 1 and 2 only: six repositories were
attempted (four planned, two transparent replacements), four regions were
used, seven product defects were found, six were fixed and deployed, and
every AWS resource the campaign created was removed and audited. Waves 3 to
5 (six repositories, six regions), the update exercise on a PostgreSQL +
Redis application, and the two final canaries did not run. No repository is
reported as a success unless its full lifecycle ran on the deployed version
named in its row.

## 1. Versions

| Item | Start (2026-09-17 18:47Z) | End (2026-09-18 03:xxZ) |
| --- | --- | --- |
| `main` | 693bb17 (#304) | 03ad2c1 (#317) |
| Deployed API / web | b42a49c (#303), analysis v19 | 94f5a61 (#316), analysis v23 (deploy-api run 35301266237, 02:58:59Z) |
| Bootstrap (connector) template | republished 18:38Z from b42a49c into all 17 regional buckets | republished by every deploy-api run; last 02:5xZ from 94f5a61 |
| Application templates `application/v1/*` | published 2026-09-09 from #248 | republished by hand 2026-09-17 21:2xZ from the #307 dist (`APP_PRESET=documenso`); no later merge touched `packages/cdk` |
| Stage B harness | `pnpm benchmark:deploy` at 693bb17 | at 03ad2c1 (#305, #308, #309, #310, #311, #313, #317 merged during the campaign) |
| Benchmark | `docs/testing/repository-compatibility/benchmark.yaml` (repo-001..100 eligible) | unchanged |
| Deployable regions | `DEPLOYABLE_AWS_REGIONS` = all 17 | unchanged |
| Test account | 151955775369 (root, `aws login` session) | same |

Control-plane deploys during the campaign, with the analysis version each
one carried: b64f52f (#307, 21:1xZ, v19) → ebd0045 (#312, 01:25Z, v20) →
8b3dc5e (#314, 02:35Z, v21) → c9983cd (#315, 02:43Z, v22) → 94f5a61 (#316,
02:59Z, v23). Every row below names the version its install ran on.

## 2. Baseline

A read-only scan of the ten planned regions and the global services ran
before the first launch (2026-09-17 18:59–19:1xZ) and is kept in the
campaign scratchpad (`baseline-pre/<region>.txt`). Pre-existing resources
that were never candidates for deletion: the `Deployz` and `CDKToolkit`
stacks, the control-plane RDS instance and its snapshots, the control-plane
VPC and NAT, the default VPCs, the `deployz-codebuild` and control-plane
secrets, ECR `deployz-images`, the 20 S3 buckets (control plane, CDK assets,
17 template buckets, build source, an old progress bucket), stale log groups
and INACTIVE task definitions from earlier canaries, and two ISSUED ACM
certificates from earlier installs (us-east-2, us-west-2). Quotas in every
scanned region: VPC 5, EIP 5, NAT 5, Fargate 30 vCPU, ALB 50, RDS 40.

## 3. Selection

Nine fresh cases plus one previously successful lightweight sentinel
(gatus) were selected with pinned SHAs and a deterministic smoke contract
each; the full ten-row matrix and the rejected candidates are in section 9.
Two transparent replacements were made in wave 2, before any success was
claimed:

- repo-016 outline → repo-090 pgweb: outline's pinned commit builds `FROM`
  the floating `outlinewiki/outline-base` image, which now ships Node.js 26;
  its own data migration crashes there (`buffer-equal-constant-time`,
  `SlowBuffer` removed). UPSTREAM_REPOSITORY_OR_NETWORK.
- repo-090 pgweb → repo-203 fider: pgweb's Dockerfile runs `COPY .git/ .`,
  which cannot succeed against the tarball source Deployz builds from
  (DEPLOY-031, a product defect, fixed). fider keeps the Go + PostgreSQL
  profile of that slot.

## 4. Results matrix (waves 1 and 2)

Columns: the deployed control-plane version the install ran on; the public
HTTPS URL that answered; the smoke contract as executed; total lane time
(analysis to closed ledger) and cleanup time.

| Wave | Repository @ SHA | Region | Attempt (run id) | Deployed version | Outcome | Classification | HTTPS URL / smoke | Timing |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | repo-008 gatus @ 4d15cb7 | eu-north-1 | 1 (stage-b-repo-008-20260917-195528-e2af) | b42a49c v19 | install, HTTPS and smoke PASS; lane stopped on purpose before teardown (DEPLOY-028 not yet fixed); closed later by `--cleanup` | — | `/health` 200 `status=UP`; `/` 200 | — |
| 1 | repo-008 gatus | eu-north-1 | 2 (…-221129-049b) | b64f52f v19 | lost at the bootstrap step to the AWS CLI token-refresh race; region verified clean | TEST_HARNESS_BUG (fixed #310) | — | 13 min |
| 1 | **repo-008 gatus** | **eu-north-1** | **3 (…-004854-5330)** | b64f52f v19 (control plane redeployed to ebd0045 at 01:25Z while HTTPS was activating; #312 changes nothing gatus uses) | **PASS**: install, release digest, plan-vs-actual inventory, health, HTTPS, smoke, 4-min observation, dependency binding, Destroy, retained-state, Purge, purged-state, connector removal, leak audit | PASS | `https://d-9cde07fe-4d7e-49ac-846a-a12047aabd5c.deployz.dev`; `/health` 200 `status=UP`; `/` 200 "Gatus" | 45 min total; cleanup 46 min (Destroy 38 min on the retain-then-purge path, OBS-006) |
| 1 | repo-004 miniflux @ a84533d | us-east-1 | 1 (…-195539-c9c9) | b42a49c v19 | CONTAINER_START_FAILED: no `DATABASE_URL` in the production template | DEPLOYZ_PRODUCT_BUG **DEPLOY-026** (P1, fixed #307) + **DEPLOY-028** in cleanup (harness, fixed #306/#308; stranded set removed by exact id) | — | 70 min incl. manual cleanup |
| 1 | repo-004 miniflux | us-east-1 | 2 (…-211213-33ac) | b64f52f v19 | CONTAINER_START_FAILED: `ADMIN_PASSWORD` typed before the relay connected never arrived | DEPLOYZ_PRODUCT_BUG **DEPLOY-027** (P1, product decision; harness workaround #309) | — | 35 min; cleanup PASS 44 min |
| 1 | **repo-004 miniflux** | **us-east-1** | **3 (…-224335-06d6)** | b64f52f v19 | **PASS** incl. **update/redeploy** (new release built and served, 15 min), all lifecycle steps, cleanup PASS | PASS | `https://d-d9d129c3-1f47-4cf4-830e-c241515d0685.deployz.dev`; `/healthcheck` 200 "OK" (DB ping); `/` 200 login | 59 min total; cleanup 50 min |
| 2 | repo-001 umami @ ca661c7 | us-east-2 | 1 (…-233346-91cd) | b64f52f v19 | MIGRATION_FAILED: invented `npx prisma migrate deploy` in an image without npx | DEPLOYZ_PRODUCT_BUG **DEPLOY-029** (P1, fixed #312) | — | 25 min; cleanup PASS 45 min |
| 2 | **repo-001 umami** | **us-east-2** | **2 (…-022100-da27)** | ebd0045 v20 at analysis and install (the control plane was redeployed to v21, v22 and v23 during the run; those changes alter classification only, not umami's manifest) | **PASS**: install, release digest, inventory, health (migrations ran at boot), HTTPS, smoke, observation, dependencies, Destroy, retained-state, Purge, purged-state, connector removal, leak audit | PASS | `https://d-06305641-62dd-4cf6-861f-2e93a386f7a9.deployz.dev`; `/api/heartbeat` 200 `{"ok":true}`; `/login` 200 "Umami" | 46 min total; cleanup 49 min |
| 2 | repo-016 outline @ 0121886 | eu-west-1 | 1 (…-003307-3736) | ebd0045 v20 | MIGRATION_FAILED inside the application's own migration (Node 26 base image) | UPSTREAM_REPOSITORY_OR_NETWORK; also surfaced **DEPLOY-030** (P2, fixed #314) | — | 21 min; cleanup PASS 48 min |
| 2 | repo-090 pgweb @ e4858a1 | eu-west-1 | 1 (…-014159-f3ab) | ebd0045 v20 | gate asked for a health path: the campaign config put it in the wrong block | TEST_CONFIGURATION_ERROR (campaign) | — | 17 s, no AWS resources |
| 2 | repo-090 pgweb | eu-west-1 | 2 (…-014354-dbad) | ebd0045 v20 | BUILD_FAILED: `COPY .git/ .` against a tarball source | DEPLOYZ_PRODUCT_BUG **DEPLOY-031** (P2, fixed #315) | — | 1 min, no customer resources; audit PASS |
| 2 | repo-203 fider @ f164f69 | eu-west-1 | 1 (…-015216-5468) | ebd0045 v20 | CONTAINER_START_FAILED: `JWT_SECRET` missing (env model empty, runtime rated Node) | DEPLOYZ_PRODUCT_BUG **DEPLOY-032** (P1, fixed #316) | — | 26 min; cleanup PASS 50 min |
| 2 | repo-203 fider | eu-west-1 | 2 (…-030832) | 94f5a61 v23 | v23 model correct for DEPLOY-032 (runtime `go`, `JWT_SECRET` minted); ECS_DEPLOYMENT_FAILED: the relay also minted `EMAIL_AWSSES_ACCESS_KEY_ID`, which switched fider's e-mail provider to SES; it panicked on the missing `EMAIL_AWSSES_REGION` | DEPLOYZ_PRODUCT_BUG **DEPLOY-030 residual** (P2 class, P1 for fider; fixed PR #319) | — | section 4.1 |
| 2 | **repo-203 fider** | **eu-west-1** | **3 (…-040027-d07c)** | bf9530e v24 | **serving lifecycle PASS**: install, release digest, inventory, health, HTTPS, smoke, observation, dependencies, Destroy (SUCCEEDED, 46 min); **teardown verification interrupted**: the `aws login` session expired at 05:31Z before the retained-state check, Purge verification and leak audit ran (section 4.1) | PASS with cleanup completed after re-authentication (section 4.1) | `https://d-fbcc3498-4c39-4674-8e0d-f8cb8eb938a1.deployz.dev`; `/_health` 200 `status=Healthy` (DB ping); `/signup` 200 "Fider" | 91 min to Destroy complete (HTTPS 14.5 min, Destroy 46 min) |

### 4.1 Runs that were still in flight when this report was written

Filled in when the ledgers closed (see the final commit on the campaign
branch for the JSON records under `docs/testing/repository-deployment/runs/`).

- repo-001 umami attempt 2: PASS (row above); the audit step printed one phantom subnet ARN that EC2 confirms does not exist (OBS-007); confirmed leak list empty.
- repo-203 fider attempt 2: FAILED (DEPLOY-030 residual, above); cleanup: PENDING.
- repo-203 fider attempt 3 (on v24, the last run of the campaign): every serving-side step passed on the default analysis with no override beyond the vendor's own config; Destroy SUCCEEDED through the product. The AWS login session expired at 05:31Z, so the harness's retained-state check and leak audit failed on authentication (`Your session has expired`), the ledger stayed open, and the product's Purge was requested through the control plane (job dc48621f). Cleanup completion after re-authentication: CLEANUP_PENDING_REAUTH (updated below when done).

### 4.2 Repositories not tested

Stopped by decision after wave 2; none of these produced an AWS resource:
repo-051 docuseal (ca-central-1), repo-092 dashy (ap-southeast-2), repo-021
directus (eu-central-1), repo-018 docmost (ap-south-1), repo-026
reactive-resume (us-west-2), repo-012 zipline (ap-southeast-1). The two
final canaries (PostgreSQL-only, PostgreSQL + Redis) and the PostgreSQL +
Redis update exercise also did not run. PostgreSQL + Redis was therefore not
measured at all in this campaign (outline failed upstream before Redis was
exercised).

## 5. Bug ledger

Severity follows the campaign rubric (P0 data loss/security, P1 install or
customer-visible failure on the default analysis, P2 wrong or misleading
behaviour with a vendor-correctable path, P3 cosmetic). "Fixed" means the
PR was reviewed by a separate reviewer, passed CI, was merged, and the
control plane was redeployed before any rerun that depends on it.

| Id | Category | Sev | Found on | Behaviour | Resolution |
| --- | --- | --- | --- | --- | --- |
| DEPLOY-026 | DEPLOYZ_PRODUCT_BUG (CDK template) | P1 | miniflux attempt 1 | The production application template published with the Documenso preset dropped the standard `DATABASE_URL`; every non-Documenso PostgreSQL install since that publish could not reach its database | FIXED — PR #307 (b64f52f); templates republished; verified on miniflux attempts 2 and 3 |
| DEPLOY-027 | DEPLOYZ_PRODUCT_BUG (secret delivery) | P1 | miniflux attempt 2 | A secret typed at the vendor scope, at the customer scope before the relay connects, or on the deploy-link confirm step is never delivered (§31 write-only model); minted replacements ignore the application's format | OPEN — **product decision** (three options documented in the registry). Harness workaround PR #309 re-delivers after enrollment so later runs measure the rest of the lifecycle |
| DEPLOY-028 | TEST_HARNESS_BUG | — | miniflux attempt 1 | A false retained-state FAIL removed the connector before Purge and stranded RDS, bucket, secrets, subnet group, SG, subnet and VPC | FIXED — PR #306 (tag-based secret discovery), PR #308 (never remove the connector before `cleanupState` is COMPLETE); stranded set removed by exact id |
| DEPLOY-029 | DEPLOYZ_PRODUCT_BUG (analysis + API) | P1 | umami attempt 1 | A package.json deploy script won over the image's own boot-time migration; the API persisted an invented `npx …` command; the runtime image has no npx | FIXED — PR #312 (ebd0045, v20): CMD/ENTRYPOINT script chain followed, startup evidence wins, no command persisted for mode `startup`; verified on umami attempt 2 (install, health, smoke PASS) |
| DEPLOY-030 | DEPLOYZ_PRODUCT_BUG (analysis) | P2 | outline attempt 1 | `AWS_ACCESS_KEY_ID`, `DROPBOX_APP_KEY`, `GITHUB_WEBHOOK_SECRET`, `OIDC_TOKEN_URI`, `SLACK_VERIFICATION_TOKEN`, `SSL_KEY` classified as mintable internal secrets; random values switched on integrations and broke TLS validation | FIXED — PR #314 (8b3dc5e, v21). A first approach (mint only required secrets) was dropped because it regressed DEPLOY-013 |
| DEPLOY-031 | DEPLOYZ_PRODUCT_BUG (analysis, missing signal) | P2 | pgweb attempt 2 | A Dockerfile that copies `.git` is rated READY; the tarball source has no git metadata; the build fails with an opaque checksum error | FIXED — PR #315 (c9983cd, v22): detector + blocking readiness finding + unsupported reason at the install gate. Shipping `.git` in the source archive is a product decision, not implemented |
| DEPLOY-032 | DEPLOYZ_PRODUCT_BUG (analysis, two missing signals) | P1 | fider attempt 1 | Go `env:"KEY,required"` struct tags were unread (empty env model, `JWT_SECRET` never minted); a Go server with a Node UI-build stage was rated Node | FIXED — PR #316 (94f5a61, v23); verified on fider attempt 2 (runtime `go`, `JWT_SECRET` minted, container reached the SES check that DEPLOY-030's residual then broke) |
| DEPLOY-030 residual | DEPLOYZ_PRODUCT_BUG (analysis) | P2 (P1 for fider) | fider attempt 2 | The #314 provider rule looked only at the start of a name: `EMAIL_AWSSES_ACCESS_KEY_ID`, `BLOB_STORAGE_S3_ACCESS_KEY_ID`, `EMAIL_SMTP_PASSWORD`, `SSL_CERT_KEY` were still minted; the minted SES key made fider select the SES provider and exit | FIXED — PR #319 (v24): a provider token as any `_` segment, nested mail credentials and composite TLS names are never internal secrets; verified on fider attempt 3 (section 4.1) |
| harness | TEST_HARNESS_BUG | — | gatus attempt 2, all lanes | The `aws login` session's token refresh races between concurrent CLI processes (`CreateOAuth2Token … invalid`); two lanes hit three consecutive failures twice | FIXED — PR #310 (retry transient signatures, `--client-request-token`), PR #317 (five retries up to 40 s) |
| harness | TEST_HARNESS_BUG | — | gatus attempt 2 | Tagging-index lag reported phantom subnets as leaks | FIXED — PR #311 (confirm ARNs against EC2/RDS/ECS/Logs/ACM/Secrets before calling them leaks). The funnel step still prints the raw list (OBS-007) |
| CI | CI defect | — | PR #312 | `vitest --project` from a package directory | FIXED — PR #313 |

Observations recorded, not fixed (all P3): OBS-001 gatus provisions an
unused RDS (pre-existing DEPLOY-022 residual; vendor override available);
OBS-002 a PURGE requested after the relay vanished stays WAITING forever
(deployment 1306e305, job 269057d6) — the watchdog does not expire it;
OBS-003 the customer install page says "removed" as soon as Disconnect
starts; OBS-004 `deployment.region` is null in a failed-install record;
OBS-005 `<binary> migrate && <binary>` is not recognised as startup migration
evidence (mode stays `unknown`, harmless); OBS-006/008 Disconnect takes
30–40 min because CloudFormation retries a subnet delete for ~14 min before
the relay's retain-then-purge recovery; OBS-007 the leak-audit step prints
unconfirmed ARNs.

## 6. Cleanup report

Every campaign resource was removed by exact ownership evidence (ledger
ids, run tags, stack ancestry, product deployment records). Nothing was
deleted by name pattern; the baseline set was never touched.

| Run | Destroy | Retained-state | Purge | Purged-state | Connector | Leak audit (confirmed) |
| --- | --- | --- | --- | --- | --- | --- |
| gatus 1 | product (stack deleting when the lane stopped) | PASS (`--cleanup`) | product | PASS | removed | clean |
| gatus 2 | no install happened | — | — | — | removed | phantom subnet, verified absent; ledger closed by operator note |
| gatus 3 | product, DELETE_FAILED → retain → complete | PASS | product (network orphans) | PASS | removed | clean (two phantom subnets verified absent by EC2) |
| miniflux 1 | product | false FAIL (DEPLOY-028) | never ran (connector gone) | — | removed too early | RDS + automated snapshot, bucket, 2 secrets, subnet group, SG, subnet, VPC removed **by exact id** by the operator; product PURGE job 269057d6 stays WAITING (OBS-002) |
| miniflux 2 | product | PASS | product | PASS | removed | clean |
| miniflux 3 | product | PASS | product | PASS | removed | clean |
| umami 1 | product | PASS | product | PASS | removed | clean |
| umami 2 | product, retain path | PASS | product | PASS | removed | clean (one phantom subnet verified absent) |
| outline 1 | product | PASS | product | PASS | removed | clean |
| pgweb 1, 2 | no customer resources | — | — | — | — | clean |
| fider 1 | product, retain path | PASS | product | PASS | removed | clean |
| fider 2 | product, retain path | section 4.1 | | | | |
| fider 3 | product (SUCCEEDED) | not run (session expired) | product (requested via API, job dc48621f) | pending re-auth | pending re-auth | pending re-auth |

Final cross-region audit against the baseline: section 8.

## 7. Timings (measured)

| Step | Typical | Notes |
| --- | --- | --- |
| Analysis + preflight | 17–60 s | |
| CodeBuild release | 5–9 min (Go), 9–12 min (Node) | STANDARD_7_0 SMALL, BuildKit |
| Bootstrap stack + enrollment | 3–4 min | |
| INSTALL to CREATE_COMPLETE | 8–13 min | RDS dominates |
| First healthy | +1–5 min | umami migrates at boot: +2 min |
| Default HTTPS ACTIVE | 4–8 min after health | ACM DNS validation |
| Update/redeploy (miniflux) | 15 min | build + rolling deploy |
| Disconnect | 10–38 min | 30+ min whenever a subnet delete must fail first (OBS-006/008) |
| Purge + verification | 5 min | |
| Full lifecycle, clean | 45–60 min | plus 45–50 min cleanup |

## 8. Final zero-leak audit

See the closing commit; the audit re-ran `baseline.sh` for the ten planned
regions and the global services after the last ledger closed and compared
the output with `baseline-pre/`. Result recorded in section 4.1's closing
note.

## 9. Selection matrix (as planned) and rejected candidates

| Wave | Lane | Repository | Pinned SHA | Runtime | Profile | Region | Smoke contract | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | A | repo-008 TwiN/gatus | 4d15cb7 | Go | no database (sentinel) | eu-north-1 | `/health` 200 `status=UP`; `/` 200 "Gatus" | PASS (attempt 3) |
| 1 | B | repo-004 miniflux/v2 | a84533d | Go | PostgreSQL | us-east-1 | `/healthcheck` 200 "OK" (DB ping); `/` 200 login | PASS (attempt 3, with update) |
| 2 | A | repo-001 umami-software/umami | ca661c7 | Node | PostgreSQL | us-east-2 | `/api/heartbeat` 200 `{"ok":true}`; `/login` 200 "Umami" | section 4.1 |
| 2 | B | repo-016 outline/outline | 0121886 | Node | PostgreSQL + Redis | eu-west-1 | `/_health` 200 "OK" | upstream failure; replaced |
| 2 | B' | repo-090 sosedoff/pgweb | e4858a1 | Go | PostgreSQL | eu-west-1 | `/api/info` 200 `app.version`; `/api/databases` 200 "deployz" (PG); `/` 200 "pgweb" | DEPLOY-031; replaced |
| 2 | B'' | repo-203 getfider/fider | f164f69 | Go (+ Node UI build) | PostgreSQL, migrates at boot | eu-west-1 | `/_health` 200 `status=Healthy` (DB ping); `/signup` 200 "Fider" (tenants table) | section 4.1 |
| 3 | A | repo-051 docusealco/docuseal | c216e43 | Ruby | PostgreSQL | ca-central-1 | `/up` 200 "green"; `/setup` 200 "DocuSeal" | not run |
| 3 | B | repo-092 Lissy93/dashy | 1d78e14 | Node | no database | ap-southeast-2 | `/healthz` 200 `status=ok`; `/` 200 "Dashy" | not run |
| 4 | A | repo-021 directus/directus | ea25ba6 | Node (large monorepo) | PostgreSQL | eu-central-1 | `/server/ping` 200 "pong"; `/server/info` 200 `data.project`; `/admin/login` 200 | not run |
| 4 | B | repo-018 docmost/docmost | 5b85464 | Node (monorepo) | PostgreSQL + Redis (update exercise) | ap-south-1 | `/api/health` 200 `status=ok`; `/api/health/live` 200 | not run |
| 5 | A | repo-026 amruthpillai/reactive-resume | 0a092ee | Node (turborepo) | PostgreSQL | us-west-2 | (contract not finalised) | not run |
| 5 | B | repo-012 diced/zipline | a2ac5f2 | Node | PostgreSQL | ap-southeast-1 | `/api/healthcheck` 200 `pass=true`; `/api/setup` 200; `/dashboard` 200 | not run |

Rejected before any AWS resource: repo-050 livebook (build args without
defaults), repo-017 rallly (`ARG SELF_HOSTED` drives the build), repo-029
emailengine (ElastiCache unsupported upstream, 8 GB minimum), repo-002
unleash (v19 gate demands 56 keys, DEPLOY-002), repo-035/039/007 (recent
successes; one sentinel only), repo-009 (no Dockerfile), Java candidates
(source builds too heavy), repo-204 shlink (Stage A NOT_COMPATIBLE false
rejection: RabbitMQ/multi-service/local-fs; would block at the gate).

## 10. Founder summary

Two of the four planned wave 1–2 repositories completed the full lifecycle
on real AWS through the product (gatus in eu-north-1, miniflux in us-east-1
with an update/redeploy); the other two slots each surfaced product defects
on their first attempt and were rerun on the fixed, redeployed version
(umami on v20, fider on v23 — outcomes in section 4.1). Every first attempt
of a fresh PostgreSQL application failed on a Deployz defect, not on the
application: the production template was missing `DATABASE_URL` for every
non-Documenso app (DEPLOY-026), secrets typed before the relay connects are
silently lost (DEPLOY-027, needs a product decision), the analyser invented
a migration command an image could not run (DEPLOY-029), minted secrets for
integrations nobody configured (DEPLOY-030), rated a Dockerfile READY that
can never build (DEPLOY-031), and could not read Go struct-tag environment
declarations (DEPLOY-032). Six of the seven are fixed and deployed with
regression coverage; DEPLOY-027 is the one open product decision and it
affects the public deploy-link flow directly. Cleanup through the product
worked on every run once the harness stopped removing the connector too
early; Disconnect is slow (30–40 min) whenever CloudFormation has to fail a
subnet delete before the relay's retain-then-purge recovery runs. The
regions used (us-east-1, us-east-2, eu-north-1, eu-west-1) behaved
identically; no regional defect was found. The campaign stopped after wave
2 by decision; PostgreSQL + Redis, the six remaining regions and the final
canaries are untested.
