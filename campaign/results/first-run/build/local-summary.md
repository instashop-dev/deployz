# Local Docker run summary

Repositories: 28

## Classification

- build: 2
- gate: 16
- local-success: 1
- probes: 6
- run: 1
- source: 2

## Stages

| Stage | Attempted | PASS | FAIL | SKIPPED | IN_PROGRESS |
| --- | ---: | ---: | ---: | ---: | ---: |
| gate | 28 | 12 | 16 | 0 | 0 |
| source | 28 | 19 | 5 | 4 | 0 |
| build | 28 | 11 | 8 | 9 | 0 |
| run | 28 | 10 | 1 | 17 | 0 |
| probes | 28 | 2 | 8 | 18 | 0 |
| cleanup | 28 | 19 | 0 | 9 | 0 |

## Probes

| Probe | Attempted | PASS | FAIL | UNVERIFIED | NOT_APPLICABLE |
| --- | ---: | ---: | ---: | ---: | ---: |
| start | 10 | 4 | 6 | 0 | 0 |
| health | 10 | 4 | 6 | 0 | 0 |
| migration | 10 | 0 | 0 | 0 | 10 |
| dbWrite | 10 | 0 | 5 | 0 | 5 |
| redis | 10 | 0 | 4 | 0 | 6 |
| storage | 10 | 0 | 0 | 3 | 7 |

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
