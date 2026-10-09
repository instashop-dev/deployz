# Local Docker run summary

Repositories: 10

## Classification

- build: 1
- gate: 5
- local-success: 1
- probes: 1
- source: 2

## Stages

| Stage | Attempted | PASS | FAIL | SKIPPED | IN_PROGRESS |
| --- | ---: | ---: | ---: | ---: | ---: |
| gate | 10 | 5 | 5 | 0 | 0 |
| source | 10 | 5 | 3 | 2 | 0 |
| build | 10 | 3 | 2 | 5 | 0 |
| run | 10 | 3 | 0 | 7 | 0 |
| probes | 10 | 1 | 2 | 7 | 0 |
| cleanup | 10 | 5 | 0 | 5 | 0 |

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
| repo-536 | InvoiceShelf/InvoiceShelf | build | 47.4 |
| repo-540 | excalidraw/excalidraw | local-success | 1630.3 |
