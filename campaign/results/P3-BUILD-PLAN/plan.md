# P3-BUILD-PLAN

- Executor: Opus coordinator, routine run 2026-10-09T01:43Z.
- Tested commit (baseline): `e6a3b58e`. Inputs: the 80 first-run Stage A files in `campaign/results/first-run/compat/` and the labels in `campaign/corpus/benchmark.yaml`. No holdout input.

## Eligibility rule

An improvement app is build-eligible when its label or its first-run gate is READY or NEEDS_CONFIGURATION (deployable with normal vendor configuration). Apps where Deployz says deployable but the label says NOT_COMPATIBLE stay in: their build and run show what a vendor would get after a false positive.

Result: 56 of 80 eligible, 24 ineligible.

## Vendor configuration

`campaign/corpus/deploy-config.yaml` has one entry per eligible app. The overrides are the readiness answers a vendor gives for its own app: the labelled appRoot, Dockerfile path, container port, health path and managed services (Postgres, Redis, storage). There are no secret values. The harness parser (`loadDeployConfig`) accepts the file. A P3-BUILD-nn worker can add documented config keys and generated secret keys for its own apps only, with the source of each addition.

## Tasks (2 apps each, timebox 30, resumable with --resume)

| Task | Apps |
| --- | --- |
| P3-BUILD-01 | repo-540 (excalidraw/excalidraw; label READY, gate READY); repo-536 (InvoiceShelf/InvoiceShelf; label NEEDS_CONFIGURATION, gate NEEDS_CONFIGURATION) |
| P3-BUILD-02 | repo-501 (fastapi/full-stack-fastapi-template; label NEEDS_CONFIGURATION, gate NEEDS_CONFIGURATION); repo-502 (getredash/redash; label NEEDS_CONFIGURATION, gate NEEDS_CONFIGURATION) |
| P3-BUILD-03 | repo-503 (HumanSignal/label-studio; label NEEDS_CONFIGURATION, gate NOT_COMPATIBLE); repo-505 (spring-projects/spring-petclinic; label NOT_COMPATIBLE, gate NEEDS_CONFIGURATION) |
| P3-BUILD-04 | repo-507 (payloadcms/payload; label NOT_COMPATIBLE, gate NEEDS_CONFIGURATION); repo-508 (gotenberg/gotenberg; label NEEDS_CONFIGURATION, gate NEEDS_CONFIGURATION) |
| P3-BUILD-05 | repo-509 (elie222/inbox-zero; label NEEDS_CONFIGURATION, gate NOT_COMPATIBLE); repo-510 (basecamp/once-campfire; label NOT_COMPATIBLE, gate NEEDS_CONFIGURATION) |
| P3-BUILD-06 | repo-511 (discourse/discourse; label NOT_COMPATIBLE, gate NEEDS_CONFIGURATION); repo-513 (saleor/saleor; label NEEDS_CONFIGURATION, gate NEEDS_CONFIGURATION) |
| P3-BUILD-07 | repo-514 (hexpm/hexpm; label NEEDS_CONFIGURATION, gate NEEDS_CONFIGURATION); repo-515 (dotnet/eShop; label NOT_COMPATIBLE, gate NEEDS_CONFIGURATION) |
| P3-BUILD-08 | repo-516 (ente/ente; label NEEDS_CONFIGURATION, gate NOT_COMPATIBLE); repo-517 (DependencyTrack/dependency-track; label NOT_COMPATIBLE, gate NEEDS_CONFIGURATION) |
| P3-BUILD-09 | repo-518 (cachethq/cachet; label NOT_COMPATIBLE, gate NEEDS_CONFIGURATION); repo-520 (mathesar-foundation/mathesar; label NEEDS_CONFIGURATION, gate NOT_COMPATIBLE) |
| P3-BUILD-10 | repo-522 (sigoden/dufs; label NOT_COMPATIBLE, gate NEEDS_CONFIGURATION); repo-523 (Freika/dawarich; label NEEDS_CONFIGURATION, gate NEEDS_CONFIGURATION) |
| P3-BUILD-11 | repo-524 (miguelgrinberg/microblog; label READY, gate NEEDS_CONFIGURATION); repo-525 (gotson/komga; label NOT_COMPATIBLE, gate NEEDS_CONFIGURATION) |
| P3-BUILD-12 | repo-528 (electric-sql/electric; label NOT_COMPATIBLE, gate NEEDS_CONFIGURATION); repo-529 (grokability/snipe-it; label NOT_COMPATIBLE, gate NEEDS_CONFIGURATION) |
| P3-BUILD-13 | repo-530 (hibiken/asynqmon; label READY, gate NEEDS_CONFIGURATION); repo-534 (hapifhir/hapi-fhir-jpaserver-starter; label NEEDS_CONFIGURATION, gate NEEDS_CONFIGURATION) |
| P3-BUILD-14 | repo-543 (teslamate-org/teslamate; label NEEDS_CONFIGURATION, gate NEEDS_CONFIGURATION); repo-544 (Kareadita/Kavita; label NOT_COMPATIBLE, gate NEEDS_CONFIGURATION) |
| P3-BUILD-15 | repo-547 (wagtail/bakerydemo; label NEEDS_CONFIGURATION, gate NOT_COMPATIBLE); repo-548 (Leantime/leantime; label NOT_COMPATIBLE, gate NEEDS_CONFIGURATION) |
| P3-BUILD-16 | repo-549 (zammad/zammad; label NOT_COMPATIBLE, gate NEEDS_CONFIGURATION); repo-550 (binwiederhier/ntfy; label NEEDS_CONFIGURATION, gate NEEDS_CONFIGURATION) |
| P3-BUILD-17 | repo-551 (spliit-app/spliit; label READY, gate NEEDS_CONFIGURATION); repo-552 (misskey-dev/misskey; label NOT_COMPATIBLE, gate READY) |
| P3-BUILD-18 | repo-555 (msgbyte/tianji; label READY, gate NEEDS_CONFIGURATION); repo-556 (muety/wakapi; label NEEDS_CONFIGURATION, gate NEEDS_CONFIGURATION) |
| P3-BUILD-19 | repo-557 (sqlpage/SQLPage; label NOT_COMPATIBLE, gate NEEDS_CONFIGURATION); repo-559 (sebadob/rauthy; label NOT_COMPATIBLE, gate NEEDS_CONFIGURATION) |
| P3-BUILD-20 | repo-560 (rajnandan1/kener; label NEEDS_CONFIGURATION, gate NEEDS_CONFIGURATION); repo-563 (LycheeOrg/Lychee; label NEEDS_CONFIGURATION, gate NOT_COMPATIBLE) |
| P3-BUILD-21 | repo-564 (getlago/lago-api; label NEEDS_CONFIGURATION, gate NEEDS_CONFIGURATION); repo-565 (open-webui/open-webui; label NEEDS_CONFIGURATION, gate NEEDS_CONFIGURATION) |
| P3-BUILD-22 | repo-566 (openfga/openfga; label NEEDS_CONFIGURATION, gate NEEDS_CONFIGURATION); repo-569 (activepieces/activepieces; label NEEDS_CONFIGURATION, gate NOT_COMPATIBLE) |
| P3-BUILD-23 | repo-573 (mem0ai/mem0; label NEEDS_CONFIGURATION, gate NEEDS_CONFIGURATION); repo-574 (lobsters/lobsters; label NOT_COMPATIBLE, gate NEEDS_CONFIGURATION) |
| P3-BUILD-24 | repo-575 (traccar/traccar; label NOT_COMPATIBLE, gate NEEDS_CONFIGURATION); repo-577 (woodpecker-ci/woodpecker; label NOT_COMPATIBLE, gate NEEDS_CONFIGURATION) |
| P3-BUILD-25 | repo-579 (akaunting/akaunting; label NOT_COMPATIBLE, gate NEEDS_CONFIGURATION); repo-580 (ridafkih/keeper.sh; label NOT_COMPATIBLE, gate NEEDS_CONFIGURATION) |
| P3-BUILD-26 | repo-585 (janeczku/calibre-web; label NOT_COMPATIBLE, gate NEEDS_CONFIGURATION); repo-588 (mautic/mautic; label NOT_COMPATIBLE, gate NEEDS_CONFIGURATION) |
| P3-BUILD-27 | repo-590 (grocy/grocy; label NOT_COMPATIBLE, gate NEEDS_CONFIGURATION); repo-593 (glanceapp/glance; label NOT_COMPATIBLE, gate READY) |
| P3-BUILD-28 | repo-596 (dnnsoftware/Dnn.Platform; label NOT_COMPATIBLE, gate NEEDS_CONFIGURATION); repo-599 (opensearch-project/OpenSearch-Dashboards; label NOT_COMPATIBLE, gate NEEDS_CONFIGURATION) |

P3-BUILD-01 has repo-536 (InvoiceShelf, storage label true): the first real SeaweedFS probe. Every P3-BUILD-nn requires `docker`, `dependencies-installed`, `disk>=10GB` and `ai-gateway`, uses `--local --ai live` with `--deploy-config campaign/corpus/deploy-config.yaml` and the default cache, retries a build once for registry network timeouts only, and prunes its labelled images. None needs push, PR, merge or publication, so none lists `publicationPolicyConfirmed`. P3-GATE now lists all 28 tasks as prerequisites.

## Ineligible apps (label and first-run gate both NOT_COMPATIBLE)

| App | Repository | Label reason (unsupported) |
| --- | --- | --- |
| repo-519 | triggerdotdev/trigger.dev | other-database, background-worker |
| repo-537 | actualbudget/actual | local-filesystem |
| repo-538 | pocketbase/pocketbase | local-filesystem |
| repo-539 | navidrome/navidrome | local-filesystem |
| repo-541 | Dictionarry-Hub/profilarr | local-filesystem |
| repo-542 | C4illin/ConvertX | local-filesystem |
| repo-545 | umputun/remark42 | other-database, local-filesystem |
| repo-554 | axllent/mailpit | local-filesystem |
| repo-558 | orhun/rustypaste | local-filesystem |
| repo-561 | kestra-io/kestra | NOT_COMPATIBLE (see label notes) |
| repo-562 | Part-DB/Part-DB-server | local-filesystem |
| repo-570 | dexidp/dex | local-filesystem |
| repo-572 | Mintplex-Labs/anything-llm | local-filesystem |
| repo-576 | btcpayserver/btcpayserver | local-filesystem, background-worker |
| repo-582 | TriliumNext/Trilium | local-filesystem |
| repo-583 | TryGhost/Ghost | local-filesystem |
| repo-586 | appsmithorg/appsmith | mongodb |
| repo-587 | rybbit-io/rybbit | other-database |
| repo-589 | opf/openproject | local-filesystem |
| repo-591 | nightscout/cgm-remote-monitor | mongodb |
| repo-592 | advplyr/audiobookshelf | local-filesystem |
| repo-594 | invoke-ai/InvokeAI | local-filesystem |
| repo-597 | Openpanel-dev/openpanel | other-database |
| repo-600 | rancher/rancher | kubernetes, local-filesystem |

## Blocker

`disk>=10GB` is UNAVAILABLE (6.4 GiB free on C: at 2026-10-09T01:45Z). No P3-BUILD task is eligible until the user frees disk space.
