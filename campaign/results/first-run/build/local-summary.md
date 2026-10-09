# Local Docker run summary

Repositories: 12

## Classification

- build: 1
- gate: 6
- local-success: 1
- probes: 1
- run: 1
- source: 2

## Stages

| Stage | Attempted | PASS | FAIL | SKIPPED | IN_PROGRESS |
| --- | ---: | ---: | ---: | ---: | ---: |
| gate | 12 | 6 | 6 | 0 | 0 |
| source | 12 | 6 | 4 | 2 | 0 |
| build | 12 | 4 | 2 | 6 | 0 |
| run | 12 | 3 | 1 | 8 | 0 |
| probes | 12 | 1 | 2 | 9 | 0 |
| cleanup | 12 | 6 | 0 | 6 | 0 |

## Probes

| Probe | Attempted | PASS | FAIL | UNVERIFIED | NOT_APPLICABLE |
| --- | ---: | ---: | ---: | ---: | ---: |
| start | 3 | 1 | 2 | 0 | 0 |
| health | 3 | 1 | 2 | 0 | 0 |
| migration | 3 | 0 | 0 | 0 | 3 |
| dbWrite | 3 | 0 | 1 | 0 | 2 |
| redis | 3 | 0 | 2 | 0 | 1 |
| storage | 3 | 0 | 0 | 0 | 3 |

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
| repo-536 | InvoiceShelf/InvoiceShelf | build | 47.4 |
| repo-540 | excalidraw/excalidraw | local-success | 1630.3 |
