# Local Docker run summary

Repositories: 14

## Classification

- build: 1
- gate: 7
- local-success: 1
- probes: 2
- run: 1
- source: 2

## Stages

| Stage | Attempted | PASS | FAIL | SKIPPED | IN_PROGRESS |
| --- | ---: | ---: | ---: | ---: | ---: |
| gate | 14 | 7 | 7 | 0 | 0 |
| source | 14 | 8 | 4 | 2 | 0 |
| build | 14 | 5 | 3 | 6 | 0 |
| run | 14 | 4 | 1 | 9 | 0 |
| probes | 14 | 1 | 3 | 10 | 0 |
| cleanup | 14 | 8 | 0 | 6 | 0 |

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
| repo-536 | InvoiceShelf/InvoiceShelf | build | 47.4 |
| repo-540 | excalidraw/excalidraw | local-success | 1630.3 |
