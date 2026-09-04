# Stage A — capability-gap analysis and MVP decision report

Corpus: 100 pinned open-source repositories (80 improvement, 20 unseen),
analysed by the production analysis path (`runApplicationAnalysis` → the
deployment gate) at analysis version 9, Deployz main `2266c14`. Expected
facts were written from repository evidence by one inspector and checked by
a second independent inspector for every entry (2 corrections on the pilot,
0 on the phase-3 corpus, 1 on the unseen set). Method: [`README.md`](README.md);
per-finding evidence: [`findings.md`](findings.md); per-repository results:
[`runs/summary.md`](runs/summary.md).

Vocabulary. A repository is **deployable** when its expected verdict is
READY or NEEDS_CONFIGURATION. A **false rejection** is a deployable
repository the gate returns NOT_COMPATIBLE for. A **false acceptance** is a
NOT_COMPATIBLE repository the gate returns READY or NEEDS_CONFIGURATION for.
**Verdict accuracy** is the exact three-way match; **boundary accuracy** is
the deployable/not-deployable match (1 − false rejections − false
acceptances). `realistic` is the cohort of plausible Deployz customers
(59 repositories, 54 of them with `customer_realism: high`).

## 1. Results

| Set | n | Verdict accuracy | Boundary accuracy | False rejections | False acceptances | All facts match |
| --- | --- | --- | --- | --- | --- | --- |
| Improvement (80) | 80 | 39 (48.8%) | 62 (77.5%) | 8 of 46 deployable (17.4%) | 10 of 34 rejected (29.4%) | 4 |
| Unseen (20) | 20 | 10 (50.0%) | 11 (55.0%) | 4 of 9 deployable (44.4%) | 5 of 11 rejected (45.5%) | 1 |
| **Whole corpus** | 100 | **49 (49.0%)** | **73 (73.0%)** | **12 of 55 (21.8%)** | **15 of 45 (33.3%)** | 5 |
| `realistic` cohort | 59 | 29 (49.2%) | 45 (76.3%) | 8 of 38 (21.1%) | 6 of 21 (28.6%) | 3 |
| `realistic` + high realism | 54 | 26 (48.1%) | 41 (75.9%) | 8 of 36 (22.2%) | 5 of 18 (27.8%) | 2 |
| `messy` cohort | 22 | 7 (31.8%) | 15 (68.2%) | 4 of 17 (23.5%) | 3 of 5 (60.0%) | 1 |
| `boundary` cohort | 19 | 13 (68.4%) | 13 (68.4%) | 0 of 0 | 6 of 19 (31.6%) | 1 |

Trajectory of the 80-repository improvement set across the audit:

| Analyser | Verdict accuracy | False rejections | False acceptances | Unexplained mismatches |
| --- | --- | --- | --- | --- |
| Version 6 (pilot baseline, 15 repos) | 8 / 15 | 5 | 0 | 0 |
| Version 8 on the 80 (before phase 3) | 36 / 80 | 24 | 8 | 277 |
| Version 9 on the 80 (after phase 3) | 39 / 80 | 8 | 10 | 0 |

The gap between verdict accuracy (49%) and boundary accuracy (73%) is the
READY / NEEDS_CONFIGURATION line: 24 repositories sit on the right side of
the rejection boundary but on the wrong side of the configuration line, 16
of them because their required secrets are declared in code the
environment model does not read (COMP-017).

Every one of the 352 remaining fact and verdict mismatches on the 100
snapshots carries a finding id. By classification:

| Classification | Findings | Repositories with at least one mismatch of this type |
| --- | --- | --- |
| ANALYSIS_BUG | 24 findings (22 fixed, 2 open); 121 mismatches | 62 |
| ANALYSIS_MISSING_SIGNAL | 14 findings (2 fixed, 12 open); 231 mismatches | 88 |
| MVP_CAPABILITY_GAP | 0 recorded as findings — capability gaps are the expected `unsupported` families (section 3), not analyser mismatches | — |
| CORRECTLY_UNSUPPORTED | 45 repositories expected NOT_COMPATIBLE; 30 of them rejected by the analyser | — |
| REPO_INVALID | 0 in the final corpus (2 planned repositories were replaced before inspection: redmine → docuseal, ajnart/homarr → homarr-labs/homarr) | — |

## 2. Analyser mistakes, ranked by repositories affected

Repositories carrying the finding in the final run (whole corpus); "flips"
counts repositories whose verdict is wrong because of it.

| Finding | Type | Status | Repos | High realism | Realistic | Verdict flips | What it is |
| --- | --- | --- | --- | --- | --- | --- | --- |
| COMP-014 | MISSING_SIGNAL | open | 55 | 46 | 30 | 1 | Migrations that run at boot or through a non-npm CLI are not seen; the gate warns "no migration command" on 55% of apps |
| COMP-005 | MISSING_SIGNAL | open | 49 | 40 | 26 | 0 | Health paths outside JS route conventions (`/up`, `/status`, `/actuator/health`, `/api/ping`, `/-/ping`) |
| COMP-015 | MISSING_SIGNAL | open | 41 | 32 | 23 | 2 | Worker code outside Node (sidekiq, celery, rq, Laravel queues, Go schedulers); the `background-worker` rejection fired on 1 of the 10 repositories that need it |
| COMP-011 | BUG | fixed, residual | 26 | 18 | 16 | 0 | Redis provisioned for apps that only use it when configured |
| COMP-012 | BUG | fixed, residual | 25 | 20 | 14 | 0 | S3 seen for optional exports, not seen behind PHP/Kotlin/Django storage abstractions |
| COMP-017 | MISSING_SIGNAL | open | 16 | 15 | 11 | 16 | Required secrets declared in Go/JVM/.NET/Python settings or schema libraries → READY instead of NEEDS_CONFIGURATION |
| COMP-030 | MISSING_SIGNAL | open | 13 | 8 | 5 | 0 | No port when the image has no `EXPOSE` |
| COMP-029 | MISSING_SIGNAL | fixed, residual | 12 | 10 | 6 | 0 | PostgreSQL through PHP base images, project files the cap drops, `diesel-async` |
| COMP-020 | BUG | fixed, residual | 9 | 8 | 6 | 0 | App root vs build context in monorepos |
| COMP-027 | BUG | fixed, residual | 9 | 7 | 5 | 0 | Dockerfile ranking on genuinely ambiguous multi-image repositories |
| COMP-024 | BUG | fixed, residual | 8 | 7 | 3 | 4 | Declared volumes whose S3 alternative or PostgreSQL driver the analyser cannot see |
| COMP-028 | BUG | fixed, residual | 6 | 5 | 4 | 0 | Wrong port from a sibling image or an undefaulted `EXPOSE` variable |
| COMP-010, 025, 002, 026, 023, 033, 037, 031, 038, 009, 016, 021, 022, 007, 036 | mixed | see findings.md | ≤ 5 each | | | 24 together | The long tail: optional second processes in reference files, undeclared data directories, embedded engines next to PostgreSQL, deployment descriptors the fetch drops, secret-named bare reads |

Fixed during the audit (24 findings): COMP-001, 002, 003, 004, 006, 007,
008, 009, 011, 012, 013, 016, 018, 019, 020, 023, 024, 026, 027, 028, 029,
032, 034, 035. Open (14): COMP-005, 010, 014, 015, 017, 021, 022, 025, 030,
031, 033, 036, 037, 038. Regression tests added: 51 in
`packages/analysis/test/stage-a.test.ts` and `stage-a-phase3.test.ts`, plus
5 in `apps/api` (`github.test.ts`, `analysis.test.ts`) and `phase7.test.ts`.

## 3. Capability gaps, as the corpus experiences them

Counts are repositories whose expected `unsupported` list names the family,
whether or not the analyser detects it ("detected" is the analyser's own
count today). "Realistic unlocked" is the number of `realistic`-cohort
repositories that would become deployable if Deployz supported the family
and nothing else blocked them.

| Gap | Repos | High realism | Realistic unlocked | Detected today | Representative | Current Deployz reason | Product value | Complexity | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 Persistent local disk (data directory, no S3 option) | 13 (+1 `persistent-volume`) | 12 | 9 | 8 | homepage, mealie, paperless-ngx, answer, kanboard, halo, vaultwarden, firefly-iii | `local-file-storage`: containers are wiped on every deploy; only S3 is offered | high — the default shape of self-hosted apps | high — an EFS/ECS volume per app, backups, single-task placement | DEFER |
| G2 Separate background worker process | 10 | 6 | 5 | 1 | twenty, chatwoot, mastodon, netbox, monica, nango | Phase 8 boundary: one web process per application | high | high — a second ECS service from the same image, scaling, the deploy/rollback contract | DEFER |
| G3 Multi-container application stacks | 12 | 10 | 6 | 11 | formbricks, typebot, hedgedoc 2.x, penpot, lemmy, immich | one application container per deployment | medium — most are frontend+backend splits an image could merge | high — service graphs, networking, per-service health | KEEP_UNSUPPORTED (MVP) |
| G4 Required application secrets before the first deploy | 24 of the 47 NEEDS_CONFIGURATION repositories (18 realistic) | 21 | 0 (they are deployable; the cost is friction) | n/a | outline, docmost, planka, reactive-resume, infisical, homarr (`SECRET_ENCRYPTION_KEY`, `AUTH_SECRET`, `SECRET_KEY`) | the gate refuses until the vendor types a value | high — 47% of the corpus stops here; generated secrets are what every PaaS does | low-medium — generate a value for secret-named required variables, vendor override kept | CONSIDER_FOR_MVP |
| G5 Injected variable names differ from the app's names | 41 repositories' notes mention their own database/storage variable names (`DB_URL`, `DB_HOST`, `PAPERLESS_DBHOST`, `MEMOS_DSN`, `GF_DATABASE_*`, `SQLALCHEMY_DATABASE_URI`, `S3_ATTACHMENTS_BUCKET`) | ~34 | 0 directly (they are deployable) — but the injected `DATABASE_URL` is unused by at least 25 of them, so the first deploy fails at runtime | n/a | homarr, paperless-ngx, coder, memos, grafana, docuseal, teable, infisical | Deployz injects fixed names (`DATABASE_URL`, `DATABASE_HOST/…`, `REDIS_URL`, `AWS_S3_BUCKET`) | high — without it "postgres: true" is not a working database for most non-Node apps | low — let the vendor alias each injected binding to the app's variable name(s) on the configuration screen; the analyser already lists the app's candidate names | FIX_BEFORE_MVP |
| G6 No Dockerfile in the repository | 7 (papermark, heroku sample, nocodb, nextcloud, netbox, thelounge, firefly-iii) | 6 | 3 | 7 (as `dockerfile-missing`) | — | the vendor supplies a Dockerfile path or writes one | medium | medium-high — buildpacks or generated Dockerfiles per runtime | DEFER |
| G7 SQLite as the sole database | 4 (+2 embedded document stores) | 3 | 0 | 2 | uptime-kuma, karakeep, grist-core, openstatus | PostgreSQL only | low — SQLite apps are personal-scale | high (a persistent volume, G1) | KEEP_UNSUPPORTED |
| G8 MySQL/MariaDB-only | 2 | 2 | 1 | 0 | CTFd, BookStack | PostgreSQL only | low-medium | medium — a second RDS engine through the same bindings | DEFER |
| G9 MongoDB, ClickHouse, H2, a required PostgreSQL extension (`pg_search`) | 5 | 5 | 1 | 2 | LibreChat, wekan, plausible, Stirling-PDF, lobehub | PostgreSQL only; managed PostgreSQL has no ParadeDB | low | high | KEEP_UNSUPPORTED |
| G10 Kubernetes-native, IaC-managed, cloud-specific, GPU, message brokers | 7 | 1 | 0 | 2 | argo-cd, microservices-demo, azure-search, vllm, kafdrop, zulip | outside a single container on AWS | none for Deployz's customer | — | KEEP_UNSUPPORTED (correctly unsupported) |

Analyser-side gaps that behave like capability gaps for the customer
(the product works, the analysis misreports it) are ranked with the same
formula in section 4.

## 4. Ranked recommendations

Rank = realistic repositories affected × customer relevance ÷
implementation complexity (relevance high = 3, medium = 2, low = 1;
complexity low = 1, medium = 2, high = 3). "Affected" counts realistic
repositories whose first deploy or verdict changes.

| # | Item | Kind | Realistic affected | Relevance | Complexity | Score | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | G5 — alias injected bindings to the app's variable names | product (configuration screen) | ~25 | high | low | 75 | FIX_BEFORE_MVP |
| 2 | COMP-015 — worker-code detection outside Node (makes the Phase 8 rejection fire: 1 of 10 today) | analyser | 23 (facts), 5 (verdicts) | high | low | 69 | FIX_BEFORE_MVP |
| 3 | COMP-014 — recognise migrations that run at boot / non-npm CLIs; stop warning on 55% of apps | analyser + gate wording | 30 | medium | low | 60 | FIX_BEFORE_MVP |
| 4 | COMP-005 — health paths outside JS conventions (the ALB health check fails on a wrong path) | analyser | 26 | high | low-medium | 52 | FIX_BEFORE_MVP |
| 5 | G4 — generate values for secret-named required variables | product | 18 | high | low-medium | 36 | CONSIDER_FOR_MVP |
| 6 | COMP-017 — read env schemas (zod/envalid/Pydantic/Spring `@Value`/Go struct tags) for required values | analyser | 11 | high | medium | 17 | CONSIDER_FOR_MVP |
| 7 | COMP-011 — Redis "required" only for unguarded clients; optional Redis becomes a vendor toggle | analyser + product | 16 | medium | medium | 16 | CONSIDER_FOR_MVP |
| 8 | COMP-030 — per-runtime default ports when no `EXPOSE` | analyser | 5 | medium | low | 10 | CONSIDER_FOR_MVP |
| 9 | COMP-036/037/038 — the three unseen-set defects (IaC in benchmarks/, non-Node engine tokens, tier-0 cap) | analyser | 3 | medium | low | 6 | FIX_BEFORE_MVP (phase 6, within the boundary) |
| 10 | COMP-025 — data directories with no VOLUME (a README volumes table, `*_DATA_DIR` defaults) | analyser | 3 | medium | medium | 3 | DEFER |
| 11 | G1 — persistent volumes | product | 9 | high | high | 9 | DEFER (first post-MVP capability) |
| 12 | G2 — background worker as a second process | product | 5 | high | high | 5 | DEFER (Phase 8 stays) |
| 13 | G6 — repositories without a Dockerfile | product | 3 | medium | high | 2 | DEFER |
| 14 | G3, G7, G8, G9, G10 | product | ≤ 6 | low-medium | high | ≤ 4 | KEEP_UNSUPPORTED |

Items 2, 3, 4 and 9 are analyser work inside the present boundary; item 1
is a small product change on the configuration screen that the analyser
already feeds (it lists the app's own connection variables); item 5 is a
product decision. Nothing in the FIX_BEFORE_MVP set expands the runtime
architecture.

## 5. Answers

1. **How many realistic repos does Deployz correctly classify?** 29 of 59
   on the exact verdict (49%); 45 of 59 on the deployable/not-deployable
   boundary (76%). 30 of the 38 deployable realistic repositories are
   accepted; 15 of the 21 non-deployable ones are rejected.
2. **What is the false-rejection rate?** 12 of 55 deployable repositories
   (21.8%) over the whole corpus; 8 of 38 (21.1%) in the realistic cohort;
   17.4% on the improvement set and 44.4% (4 of 9) on the unseen set. It
   was 52% (24 of 46) on the improvement set before the phase-3 fixes.
   Eight of the twelve are optional second processes or content volumes
   declared in reference files (COMP-010, COMP-024), the rest are single
   defects with a finding each.
3. **What is the false-acceptance rate?** 15 of 45 non-deployable
   repositories (33.3%); 6 of 21 (28.6%) in the realistic cohort; 29.4% on
   the improvement set and 45.5% (5 of 11) on the unseen set. The rate rose
   from 8 to 10 on the improvement set during phase 3 because the removed
   write-call rule had rejected several apps for the wrong reason; the
   real causes are now recorded (COMP-025 undeclared data directories,
   COMP-015 workers outside Node, COMP-033 deployment descriptors the fetch
   drops, COMP-037 engines outside Node manifests).
4. **Which analyser mistakes were most common?** By repositories:
   migration commands outside package.json (55), health paths outside JS
   conventions (49), worker code outside Node (41), Redis provisioning from
   optional clients (26), S3 in both directions (25), required values in
   env schemas (16, all verdict flips). By verdict impact the order is:
   env schemas (16 flips), then the long tail of rejection-precision
   residuals (24 flips across 15 findings). The single most damaging class
   during the audit — presence of a dependency or file treated as an
   architectural requirement — accounted for 24 of the 26 false rejections
   seen across phases 2 and 3 and is fixed (COMP-002, 008, 009, 011, 019,
   024, 026, 032) with regression tests.
5. **Which capability gaps affect the most plausible customers?** Injected
   variable names that the app does not read (G5: ~34 high-realism
   repositories), required secrets before the first deploy (G4: 21),
   persistent local disk (G1: 12), multi-container stacks (G3: 10), a
   separate worker process (G2: 6). Everything else touches at most 3
   high-realism repositories.
6. **Which missing capabilities are low-effort / high-impact?** Binding
   aliases (G5), worker detection breadth (COMP-015), boot-time migration
   recognition (COMP-014), health-path breadth (COMP-005), generated
   secrets (G4), default ports (COMP-030). All are days, not weeks, and
   none changes the runtime architecture.
7. **Which features should remain outside MVP?** Persistent volumes (G1),
   a second worker process (G2), multi-container stacks (G3), SQLite,
   MySQL, MongoDB, ClickHouse, H2 and PostgreSQL extensions (G7–G9),
   Kubernetes-native apps, IaC-managed and cloud-specific deployments,
   GPU, Kafka/RabbitMQ (G10), repositories without a Dockerfile (G6). G1
   and G2 are the first two to revisit after MVP: together they cover 14
   realistic repositories and their rejection reason is honest.
8. **Which current MVP assumptions are validated?** (a) One container on
   ECS with managed PostgreSQL covers 55 of 100 repositories and 38 of 59
   realistic ones (64%). (b) PostgreSQL is the right single engine: 78 of
   100 apps run on it (51 of 59 realistic); MySQL-only, MongoDB and others
   are 9 in total. (c) Redis is correctly optional: only 20 of 100 need it.
   (d) S3 is the right object-storage answer: 40 apps offer it and none
   asks for another provider. (e) A Dockerfile in the repository is the
   norm: 93 of 100 ship one. (f) The Phase 8 worker boundary is a real
   boundary, not a theoretical one: 55 apps have worker code but only 10
   need a separate process — rejecting only the declared process is the
   correct rule, provided the detector sees the declaration (COMP-015).
9. **Which current MVP assumptions should be reconsidered?** (a) That the
   injected variable names are enough: for most non-Node apps they are
   not read (G5). (b) That NEEDS_CONFIGURATION is a rare state: it is the
   expected verdict for 47 of 100 repositories and for 31 of 59 realistic
   ones, mostly for one secret; the product experience must treat it as
   the normal path and remove the friction (G4). (c) That a migration
   command is a deploy-time step: 82 of 100 apps have migrations and most
   run them at boot; the gate's "no migration command" warning is noise for
   55 of them (COMP-014). (d) That local disk means "not a Deployz app":
   13 apps (9 in the realistic cohort) need a data directory and have no S3 option;
   they are honest rejections today but the largest post-MVP unlock (G1).
   (e) That `READY` is the goal state of analysis: only 8 of 100
   repositories are READY with no configuration at all; the readiness
   report's value is in naming the one or two values that stand between a
   repository and its first deploy.
10. **What is the result on the 20 fresh unseen repos?** With the analyser
    frozen at the phase-3 merge: 10 of 20 verdicts (50%), 11 of 20 on the
    deployable boundary, 4 false rejections (mattermost, windmill,
    TandoorRecipes, homarr), 5 false acceptances (nango, netbox,
    Stirling-PDF, thelounge, plausible), 1 configuration-detection
    mismatch (dashy), 0 failed analyses, 0 unexplained mismatches. The
    verdict rate equals the improvement set's (49%), so the phase-3 rules
    generalise. Three new defects were found (COMP-036 IaC packages in
    non-runtime directories, COMP-037 unsupported engines in JVM/Elixir/PHP
    manifests, COMP-038 workspace manifests filling the file cap) and are
    left for the phase-6 hardening batch; the other unseen mismatches are
    residuals of findings already known.

## 6. Correctly unsupported

Rejections the audit confirms as intended and correctly detected today:
multi-container stacks (11 of 12 detected), MongoDB (2 of 2), Kafka (1 of
1), GPU (1 of 1), SQLite where the driver is explicit (2 of 4), local disk
with a declared volume (8 of 13). Intended but not detected today, and
therefore product risk rather than product scope: a declared worker
process outside Node (1 of 10), MySQL-only PHP apps (0 of 2), ClickHouse/H2
(0 of 2), Kubernetes-native apps and cloud descriptors (0 of 4), RabbitMQ
read with a default (0 of 1).

## 7. Post-hardening addendum (Phase 6)

After this report was written, the phase-6 hardening batch (analysis
version 10) fixed COMP-015, 036, 037 and 038. Whole-corpus verdict accuracy
moved from 49 to 51 of 100, false acceptances from 15 to 14, false
rejections stayed at 12, and the unseen set stayed at 10 of 20 — its
remaining mismatches each have a second, product-level cause. The
before/after table and the remaining-gap list are in
[`findings.md`](findings.md#post-hardening-summary-phase-6-analysis-version-10);
the rankings and decisions in sections 3–5 stand.
