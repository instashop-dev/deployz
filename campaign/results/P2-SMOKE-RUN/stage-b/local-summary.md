# Local Docker run summary

Repositories: 2

## Classification

- build: 1
- probes: 1

## Stages

| Stage | Attempted | PASS | FAIL | SKIPPED | IN_PROGRESS |
| --- | ---: | ---: | ---: | ---: | ---: |
| gate | 2 | 2 | 0 | 0 | 0 |
| source | 2 | 2 | 0 | 0 | 0 |
| build | 2 | 1 | 1 | 0 | 0 |
| run | 2 | 1 | 0 | 1 | 0 |
| probes | 2 | 0 | 1 | 1 | 0 |
| cleanup | 2 | 2 | 0 | 0 | 0 |

## Probes

| Probe | Attempted | PASS | FAIL | UNVERIFIED | NOT_APPLICABLE |
| --- | ---: | ---: | ---: | ---: | ---: |
| start | 1 | 1 | 0 | 0 | 0 |
| health | 1 | 0 | 1 | 0 | 0 |
| migration | 1 | 0 | 0 | 0 | 1 |
| dbWrite | 1 | 0 | 1 | 0 | 0 |
| redis | 1 | 0 | 0 | 0 | 1 |
| storage | 1 | 0 | 0 | 0 | 1 |

## Duration per repository

| Id | Repository | Classification | Total seconds |
| --- | --- | --- | ---: |
| repo-530 | hibiken/asynqmon | build | 331.5 |
| repo-556 | muety/wakapi | probes | 697.0 |
