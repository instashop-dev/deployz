# Local Docker run summary

Repositories: 4

## Classification

- build: 1
- local-success: 1
- probes: 1
- source: 1

## Stages

| Stage | Attempted | PASS | FAIL | SKIPPED | IN_PROGRESS |
| --- | ---: | ---: | ---: | ---: | ---: |
| gate | 4 | 4 | 0 | 0 | 0 |
| source | 4 | 3 | 1 | 0 | 0 |
| build | 4 | 2 | 1 | 1 | 0 |
| run | 4 | 2 | 0 | 2 | 0 |
| probes | 4 | 1 | 1 | 2 | 0 |
| cleanup | 4 | 3 | 0 | 1 | 0 |

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
| repo-536 | InvoiceShelf/InvoiceShelf | build | 47.4 |
| repo-540 | excalidraw/excalidraw | local-success | 1630.3 |
