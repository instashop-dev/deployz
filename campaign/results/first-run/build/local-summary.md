# Local Docker run summary

Repositories: 36

## Classification

- build: 4
- gate: 20
- local-success: 1
- probes: 7
- run: 2
- source: 2

## Stages

| Stage | Attempted | PASS | FAIL | SKIPPED | IN_PROGRESS |
| --- | ---: | ---: | ---: | ---: | ---: |
| gate | 36 | 16 | 20 | 0 | 0 |
| source | 36 | 26 | 5 | 5 | 0 |
| build | 36 | 14 | 12 | 10 | 0 |
| run | 36 | 11 | 3 | 22 | 0 |
| probes | 36 | 2 | 9 | 25 | 0 |
| cleanup | 36 | 26 | 0 | 10 | 0 |

## Probes

| Probe | Attempted | PASS | FAIL | UNVERIFIED | NOT_APPLICABLE |
| --- | ---: | ---: | ---: | ---: | ---: |
| start | 11 | 5 | 6 | 0 | 0 |
| health | 11 | 5 | 6 | 0 | 0 |
| migration | 11 | 0 | 0 | 0 | 11 |
| dbWrite | 11 | 0 | 6 | 0 | 5 |
| redis | 11 | 0 | 4 | 0 | 7 |
| storage | 11 | 0 | 0 | 3 | 8 |

## Duration per repository

| Id | Repository | Classification | Total seconds |
| --- | --- | --- | ---: |
| repo-501 | fastapi/full-stack-fastapi-template | source | 1.6 |
| repo-502 | getredash/redash | probes | 1089.5 |
| repo-503 | HumanSignal/label-studio | gate | 0.0 |
| repo-505 | spring-projects/spring-petclinic | gate | 4.9 |
| repo-507 | payloadcms/payload | gate | 18.7 |
| repo-508 | gotenberg/gotenberg | source | 1.6 |
| repo-509 | elie222/inbox-zero | gate | 0.0 |
| repo-510 | basecamp/once-campfire | gate | 852.0 |
| repo-511 | discourse/discourse | gate | 71.3 |
| repo-513 | saleor/saleor | run | 547.4 |
| repo-514 | hexpm/hexpm | probes | 590.4 |
| repo-515 | dotnet/eShop | gate | 6.0 |
| repo-516 | ente/ente | gate | 0.0 |
| repo-517 | DependencyTrack/dependency-track | gate | 11.7 |
| repo-518 | cachethq/cachet | gate | 3.0 |
| repo-520 | mathesar-foundation/mathesar | gate | 0.0 |
| repo-522 | sigoden/dufs | gate | 535.0 |
| repo-523 | Freika/dawarich | probes | 896.1 |
| repo-524 | miguelgrinberg/microblog | build | 42.1 |
| repo-525 | gotson/komga | gate | 11.7 |
| repo-528 | electric-sql/electric | gate | 41.8 |
| repo-529 | grokability/snipe-it | gate | 578.2 |
| repo-530 | hibiken/asynqmon | probes | 486.8 |
| repo-534 | hapifhir/hapi-fhir-jpaserver-starter | probes | 637.8 |
| repo-536 | InvoiceShelf/InvoiceShelf | build | 47.4 |
| repo-540 | excalidraw/excalidraw | local-success | 1630.3 |
| repo-543 | teslamate-org/teslamate | probes | 592.6 |
| repo-544 | Kareadita/Kavita | gate | 27.2 |
| repo-547 | wagtail/bakerydemo | gate | 0.0 |
| repo-548 | Leantime/leantime | gate | 807.1 |
| repo-549 | zammad/zammad | gate | 828.6 |
| repo-550 | binwiederhier/ntfy | build | 250.6 |
| repo-551 | spliit-app/spliit | run | 392.3 |
| repo-552 | misskey-dev/misskey | gate | 1060.2 |
| repo-555 | msgbyte/tianji | build | 986.9 |
| repo-556 | muety/wakapi | probes | 308.9 |
