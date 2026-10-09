# Local Docker run summary

Repositories: 26

## Classification

- build: 2
- gate: 15
- local-success: 1
- probes: 5
- run: 1
- source: 2

## Stages

| Stage | Attempted | PASS | FAIL | SKIPPED | IN_PROGRESS |
| --- | ---: | ---: | ---: | ---: | ---: |
| gate | 26 | 11 | 15 | 0 | 0 |
| source | 26 | 17 | 5 | 4 | 0 |
| build | 26 | 10 | 7 | 9 | 0 |
| run | 26 | 9 | 1 | 16 | 0 |
| probes | 26 | 2 | 7 | 17 | 0 |
| cleanup | 26 | 17 | 0 | 9 | 0 |

## Probes

| Probe | Attempted | PASS | FAIL | UNVERIFIED | NOT_APPLICABLE |
| --- | ---: | ---: | ---: | ---: | ---: |
| start | 9 | 4 | 5 | 0 | 0 |
| health | 9 | 4 | 5 | 0 | 0 |
| migration | 9 | 0 | 0 | 0 | 9 |
| dbWrite | 9 | 0 | 4 | 0 | 5 |
| redis | 9 | 0 | 4 | 0 | 5 |
| storage | 9 | 0 | 0 | 3 | 6 |

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
