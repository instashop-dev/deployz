# Local Docker run summary

Repositories: 22

## Classification

- build: 2
- gate: 13
- local-success: 1
- probes: 3
- run: 1
- source: 2

## Stages

| Stage | Attempted | PASS | FAIL | SKIPPED | IN_PROGRESS |
| --- | ---: | ---: | ---: | ---: | ---: |
| gate | 22 | 9 | 13 | 0 | 0 |
| source | 22 | 14 | 4 | 4 | 0 |
| build | 22 | 7 | 7 | 8 | 0 |
| run | 22 | 6 | 1 | 15 | 0 |
| probes | 22 | 2 | 4 | 16 | 0 |
| cleanup | 22 | 14 | 0 | 8 | 0 |

## Probes

| Probe | Attempted | PASS | FAIL | UNVERIFIED | NOT_APPLICABLE |
| --- | ---: | ---: | ---: | ---: | ---: |
| start | 6 | 2 | 4 | 0 | 0 |
| health | 6 | 2 | 4 | 0 | 0 |
| migration | 6 | 0 | 0 | 0 | 6 |
| dbWrite | 6 | 0 | 3 | 0 | 3 |
| redis | 6 | 0 | 3 | 0 | 3 |
| storage | 6 | 0 | 0 | 2 | 4 |

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
| repo-536 | InvoiceShelf/InvoiceShelf | build | 47.4 |
| repo-540 | excalidraw/excalidraw | local-success | 1630.3 |
