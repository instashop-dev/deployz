# Local Docker run summary

Repositories: 18

## Classification

- build: 1
- gate: 11
- local-success: 1
- probes: 2
- run: 1
- source: 2

## Stages

| Stage | Attempted | PASS | FAIL | SKIPPED | IN_PROGRESS |
| --- | ---: | ---: | ---: | ---: | ---: |
| gate | 18 | 7 | 11 | 0 | 0 |
| source | 18 | 10 | 4 | 4 | 0 |
| build | 18 | 5 | 5 | 8 | 0 |
| run | 18 | 4 | 1 | 13 | 0 |
| probes | 18 | 1 | 3 | 14 | 0 |
| cleanup | 18 | 10 | 0 | 8 | 0 |

## Probes

| Probe | Attempted | PASS | FAIL | UNVERIFIED | NOT_APPLICABLE |
| --- | ---: | ---: | ---: | ---: | ---: |
| start | 4 | 1 | 3 | 0 | 0 |
| health | 4 | 1 | 3 | 0 | 0 |
| migration | 4 | 0 | 0 | 0 | 4 |
| dbWrite | 4 | 0 | 2 | 0 | 2 |
| redis | 4 | 0 | 2 | 0 | 2 |
| storage | 4 | 0 | 0 | 1 | 3 |

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
| repo-536 | InvoiceShelf/InvoiceShelf | build | 47.4 |
| repo-540 | excalidraw/excalidraw | local-success | 1630.3 |
