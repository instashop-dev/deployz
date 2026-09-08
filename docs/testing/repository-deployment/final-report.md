# Stage B — repository deployment audit, decision report

Stage B asked one question of the production path: **when a repository is
inside the Deployz MVP boundary, can Deployz build it, deploy it into a real
customer AWS account, make it healthy over HTTPS, and remove it cleanly?**
Method: [`README.md`](README.md); per-finding evidence:
[`findings.md`](findings.md); phase record:
[`implementation-notes.md`](implementation-notes.md); per-repository
results: [`runs/summary.md`](runs/summary.md).

State of the audit at this report (2026-09-08): Phases 0–2 complete, Phase
3 (Wave 1, ten repositories) run to a verdict for every repository, with
sixteen systemic findings recorded and fourteen of them fixed in the
product and verified on real AWS. The product owner stopped the audit
after Wave 1: the six reruns that would turn Wave 1's fixed failures into
verdicts on the current product, Wave 2, the remaining improvement set,
the freeze and the unseen set were not run. Every number below is
therefore a Wave 1 number, and every "fixed" claim names the run that
verified it.

Versions: analysis 15 at the gate audit, 19 at the end of Wave 1 (four
bumps for DEPLOY-005 and DEPLOY-013); the relay, the application template
and the control plane at main `d8bb335` (the last Stage B change is
`9ddd10e`, #227). The test AWS account is `151955775369` in `us-east-1`;
the control plane is `api.deployz.dev`.

## 1. Results — Wave 1

Ten repositories, chosen in Phase 1 to span the boundary (a static Go
binary, three Node/Postgres applications, a Rails application, a Go
feed reader, a Python/Flask application, a Prisma monolith, a Go
note-taker, a Node knowledge base). Each ran the full funnel serially:
analysis → vendor configuration → CodeBuild → pinned template → customer
Quick Create → connector enrolment → INSTALL → release pointer → ECS/ALB
health → default HTTPS → observation window → dependency bindings →
Disconnect → Purge → connector removal → leak audit.

| Id | Repository | Attempts | Final verdict | What stopped it, or what it proved |
| --- | --- | --- | --- | --- |
| repo-008 | TwiN/gatus | 2 | **PASS** | First true success (attempt 2, after DEPLOY-006): no database, healthy over HTTPS, clean removal |
| repo-035 | spiral-project/ihatemoney | 1 | **PASS** | Python/Flask on Postgres; the v15 `SQLALCHEMY_DATABASE_URI` alias delivered the database |
| repo-007 | ghostfolio/ghostfolio | 3 | **PASS** | Prisma on Postgres + Redis; the configured first start (DEPLOY-009), the RDS CA bundle (DEPLOY-007), the essential-container gates (DEPLOY-014) and the alias bindings all exercised on one repository |
| repo-039 | usememos/memos | 3 | **PASS** | Go on Postgres; `MEMOS_DSN` bound through the viper env prefix (DEPLOY-005), the rollout-target gate (DEPLOY-015) exercised |
| repo-051 | docusealco/docuseal | 1 | healthy deployment, harness false-fail | Rails: install, HTTPS and health all passed; the harness's first HTTPS sample came back 521 from the edge and its window rule failed the run (fixed in the harness, #205); no rerun |
| repo-004 | miniflux/v2 | 1 | BUILD_ERROR → DEPLOY-008 | The analysis write dropped the vendor's build-context override; fixed (#206), no rerun |
| repo-001 | umami-software/umami | 4 | CONTAINER_START_ERROR → DEPLOY-007 | node-postgres refuses the RDS chain; fixed (#213), no rerun |
| repo-003 | thedevs-network/kutt | 6 | DATABASE_ERROR → DEPLOY-007 | Six attempts, each exposing one layer: DEPLOY-009, -010, -011, -012, -013, -005, then -007; every layer fixed; no rerun on the RDS CA template |
| repo-021 | directus/directus | 1 | ENV_BINDING_ERROR → DEPLOY-005 (second shape) | Reads through a local env object were invisible to the analyser; fixed (#224, v17; corrected in v19), no rerun |
| repo-016 | outline/outline | 1 | CONFIG_ERROR (v17 regression) | The v17 rule over-required keys outline defaults; corrected (#227, v19), no rerun |

Four true successes out of ten; six repositories whose last attempt failed
on a defect that has since been fixed and whose verdict on the current
product is unmeasured. Every environment was removed: each ledger closed
through the product (Disconnect, Purge, connector removal, leak audit),
and the two environments an operator incident and a control-plane outage
left behind were removed by hand and audited.

What the four successes prove about the funnel as it stands:

- **Configuration reaches the first task.** An install now creates zero
  tasks when configuration precedes the first start, the CONFIG_UPDATE
  writes the vendor values and mints the application's internal secrets,
  and the first deploy scales the configured revision up (DEPLOY-009/010/
  012/013; ghostfolio, memos).
- **Database bindings reach the application under its own names.**
  `DB_*`, `MEMOS_DSN`, `SQLALCHEMY_DATABASE_URI` and the `DATABASE_*`
  family are injected as aliases derived from what the code reads,
  through `process.env`, a local env object, or viper (DEPLOY-005; kutt,
  ghostfolio, memos, ihatemoney).
- **Node applications can verify the RDS certificate.** The init container
  delivers the regional CA bundle; Prisma migrations ran over TLS
  (DEPLOY-007; ghostfolio, memos).
- **A deploy settles honestly.** A crash-looping rollout fails with the
  exit code (DEPLOY-011), the running image and the migration verdict are
  read from the essential container (DEPLOY-014), and a circuit-breaker
  rollback onto a same-image revision is a failure, not a success
  (DEPLOY-015; memos attempt 3 passed on the fixed relay after attempt 1
  had shown the false success).
- **Removal is complete.** Disconnect on a healthy deployment with a
  retained database takes two or three CloudFormation rounds (the
  retained instance's ENI blocks its security group, subnet and VPC in
  turn) and about 45 minutes, then Purge removes the retained data; the
  leak audit found nothing attributable after every closed ledger.

## 2. Findings, ranked by what they blocked

| Id | What it blocked | Root cause | Resolution | Verified by |
| --- | --- | --- | --- | --- |
| DEPLOY-009 | Every application that needs a vendor value or a generated secret to boot could never install (the first task ran unconfigured) | DEPLOYZ_BUG | Fixed #207 (configured first start) | kutt 2–6, ghostfolio, memos, directus |
| DEPLOY-005 | Applications reading the database under their own names got no binding — three shapes: `process.env`, a local env object, viper's env prefix | ANALYSIS_MISSING_SIGNAL | Fixed #212 (v16), #224 (v17), #226 (v18), corrected #227 (v19) | kutt 6, ghostfolio, memos 3 |
| DEPLOY-007 | Every Node application on node-postgres failed the TLS handshake with RDS | DEPLOYZ_BUG | Fixed #213 (RDS CA bundle init container) | ghostfolio, memos (migrations over TLS) |
| DEPLOY-015 | A first start the circuit breaker rolled back to the unconfigured template revision was reported as a success (the app served from SQLite) | DEPLOYZ_BUG | Fixed #225 | memos 3 |
| DEPLOY-014 | With the init container present, no deploy of a database application ever settled (the relay read the init container's digest) | DEPLOYZ_BUG | Fixed #217 | ghostfolio 2–3, memos 3 |
| DEPLOY-011 | A rollout whose tasks start and then exit never settled | DEPLOYZ_BUG | Fixed #209 | kutt 3 |
| DEPLOY-013 | A vendor-typed app-internal secret never reached a later install and was not minted; the analyser called provisioned and mail credentials internal secrets | DEPLOYZ_BUG + ANALYSIS_BUG | Fixed #211, #212 | kutt 5–6 |
| DEPLOY-010 / DEPLOY-012 | The config pass could not find, then could not read, the application's config secret | DEPLOYZ_BUG | Fixed #208, #210 | kutt 3–4 |
| DEPLOY-008 | An analysis run forgot the vendor's manifest overrides (build context, Dockerfile path) | DEPLOYZ_BUG | Fixed #206 | memos (overrides honoured) |
| DEPLOY-006 | The generic template's container health command needed a shell and `curl` the image did not have | DEPLOYZ_BUG | Fixed #200 | gatus 2 |
| DEPLOY-001 | The published template pinned one Documenso image; every other application would have run Documenso | DEPLOYZ_BUG | Fixed #197 (image parameter) | every Wave 1 install |
| DEPLOY-016 | An unsafe billing migration took the whole API down for ten minutes mid-run | DEPLOYZ_BUG (another workstream) | Open, handed over; production restored by hand | — |
| DEPLOY-002 | The gate over-demands configuration keys on six READY repositories | ANALYSIS_BUG | Open (Stage A) | — |
| DEPLOY-003 / DEPLOY-004 | 18 false rejections and 6 false acceptances at the gate | ANALYSIS_MISSING_SIGNAL | Deferred to the Stage A plan | see §3 |

Pattern. Thirteen of the sixteen findings are in the deployment path
itself, not in the analyser, and none of them was visible from the
Documenso-only canaries that preceded Stage B: the first non-Documenso
application that needed configuration to boot (kutt) walked through six
of them one at a time, because each fix uncovered the next layer. The
audit's systemic-bug rule (stop the wave, fix generically, republish,
rerun) was applied fourteen times; every fix carries a regression test in
the package it changed, and no repository-specific code was added.

## 3. The gate, refreshed at analysis version 19

The Phase 2 gate audit ran offline over all 120 corpus entries at
analysis version 15 (47 correct accepts, 49 correct rejects, 6 false
acceptances, 18 false rejections — identical to Stage A's v15 run). After
the Wave 1 analyser changes (v16–v19) it was rerun the same way:

GATE_V19_PLACEHOLDER

## 4. Observations recorded but not turned into findings

- A **template-revision task boots beside the configured revision** for a
  few minutes on a first start (directus, memos): the relay's scale-up and
  the config pass's revision switch race in ECS. Harmless once DEPLOY-015
  settles the deploy on the right revision, but the unconfigured boot
  DEPLOY-009 exists to prevent still happens briefly.
- **Disconnect of a healthy deployment with a retained database** needs
  two or three CloudFormation delete rounds, each retaining the resources
  the retained instance's ENI blocks; about 45 minutes end to end.
- A **PURGE requested for a force-completed deployment** whose relay no
  longer exists is accepted and waits forever (ghostfolio attempt 2's
  ledger); the API could refuse it or settle it as skipped.
- The **`aws login` session** used by the harness lasts about ten hours;
  three expiries cost cleanups and one stopped the wave. The harness now
  checks the session before each repository.
- An **IAM sweep from another session on the operator machine** deleted a
  live installation's roles mid-Disconnect (ghostfolio attempt 2); the
  relay kept polling the control plane while unable to touch AWS. Not a
  product defect; the recovery recipe (execution role gone → delete the
  stack with the CDK execution role, retire retained resources by hand,
  force-complete once the relay is DISCONNECTED and the DESTROY is stale)
  is in the notes.

## 5. Recommendations

1. **Run the six reruns before any release decision** — docuseal,
   miniflux, umami, kutt, directus, outline — on the current product.
   Every one of their last failures has a fix that was verified on another
   repository, but "verified on another repository" is not a verdict for
   that one. About 2 hours each, serial, one `aws login` renewal.
2. **Wave 2 and the unseen set** stay the plan of record: Wave 1 found a
   new systemic defect in roughly every second repository, and the rate
   only fell in its last three runs. The unseen set is the honest measure
   of what a new customer meets.
3. **Make the DB alias families a product default**, not only an analyser
   inference: three analyser shapes were needed to reach `DB_HOST` and
   `MEMOS_DSN`, and each shape was found by a failed install. Injecting
   the common families (`DB_*`, `*_DSN`, `SQLALCHEMY_DATABASE_URI`) next to
   `DATABASE_*` would have made kutt, directus and memos install on their
   first attempt with no analyser change.
4. **Migrations must be safe on existing data and must not poison warm
   containers** (DEPLOY-016): a failed init should retry on the next
   invocation and the health route should say why.
5. **Freeze only after the reruns**: the freeze SHA is meaningful when
   every improvement repository has a verdict on it.

## 6. Answers

- *Can Deployz build, deploy, serve and remove an MVP-boundary
  repository?* Yes, for the four kinds Wave 1 reached a verdict on (a
  static Go binary, Flask/Postgres, Prisma/Postgres/Redis, Go/Postgres),
  through the production path with no repository-specific code, and with
  clean removal every time.
- *Does the product as first audited do that?* No. At the start of Wave 1
  every non-Documenso application ran the Documenso image (DEPLOY-001),
  every application that needed configuration to boot could not install
  (DEPLOY-009), and every Node application on node-postgres could not
  reach RDS (DEPLOY-007). Those three alone excluded most of the corpus.
- *What is still unmeasured?* Six of the ten Wave 1 repositories on the
  current product, and everything beyond Wave 1.
