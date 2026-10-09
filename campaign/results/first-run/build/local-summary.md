# Local Docker run summary

Repositories: 8

## Classification

- build: 1
- gate: 3
- local-success: 1
- probes: 1
- source: 2

## Stages

| Stage | Attempted | PASS | FAIL | SKIPPED | IN_PROGRESS |
| --- | ---: | ---: | ---: | ---: | ---: |
| gate | 8 | 5 | 3 | 0 | 0 |
| source | 8 | 4 | 3 | 1 | 0 |
| build | 8 | 2 | 2 | 4 | 0 |
| run | 8 | 2 | 0 | 6 | 0 |
| probes | 8 | 1 | 1 | 6 | 0 |
| cleanup | 8 | 4 | 0 | 4 | 0 |

## Probes

| Probe | Attempted | PASS | FAIL | UNVERIFIED | NOT_APPLICABLE |
| --- | ---: | ---: | ---: | ---: | ---: |
| start | 2 | 1 | 1 | 0 | 0 |
| health | 2 | 1 | 1 | 0 | 0 |
| migration | 2 | 0 | 0 | 0 | 2 |
| dbWrite | 2 | 0 | 1 | 0 | 1 |
| redis | 2 | 0 | 1 | 0 | 1 |
| storage | 2 | 0 | 0 | 0 | 2 |

## Duration per repository

| Id | Repository | Classification | Total seconds |
| --- | --- | --- | ---: |
| repo-501 | fastapi/full-stack-fastapi-template | source | 1.6 |
| repo-502 | getredash/redash | probes | 1089.5 |
| repo-503 | HumanSignal/label-studio | gate | 0.0 |
| repo-505 | spring-projects/spring-petclinic | gate | 4.9 |
| repo-507 | payloadcms/payload | gate | 18.7 |
| repo-508 | gotenberg/gotenberg | source | 1.6 |
| repo-536 | InvoiceShelf/InvoiceShelf | build | 47.4 |
| repo-540 | excalidraw/excalidraw | local-success | 1630.3 |
