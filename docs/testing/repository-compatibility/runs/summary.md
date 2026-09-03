# Repository compatibility audit — run summary

Deployz commit: `3e630034509dbc7dee93f0635bab73f01ca7cae1` · analysis version: 6

| Metric | Value |
| --- | --- |
| Repositories | 15 |
| Analysed | 15 |
| Failed to analyse | 0 |
| Verdict matches | 8 / 15 (53.3%) |
| All facts match | 1 |
| False acceptances | 0 |
| False rejections | 5 |
| Configuration-detection mismatches | 2 |
| Unexplained mismatches | 0 |

## Mismatches by finding type

| Type | Mismatches |
| --- | --- |
| ANALYSIS_BUG | 42 |
| ANALYSIS_MISSING_SIGNAL | 18 |
| MVP_CAPABILITY_GAP | 0 |
| CORRECTLY_UNSUPPORTED | 0 |
| REPO_INVALID | 0 |

## By set

| Set | Repositories | Analysed | Verdict matches | All facts match |
| --- | --- | --- | --- | --- |
| improvement | 15 | 15 | 8 | 1 |

## By cohort

| Cohort | Repositories | Analysed | Verdict matches | All facts match |
| --- | --- | --- | --- | --- |
| boundary | 3 | 3 | 3 | 0 |
| messy | 3 | 3 | 3 | 0 |
| realistic | 9 | 9 | 2 | 1 |

## Repositories

| Id | Repository | Cohort | Expected | Actual | Result |
| --- | --- | --- | --- | --- | --- |
| repo-001 | umami-software/umami@ca661c7 | realistic | READY | NOT_COMPATIBLE | compatibility (expected "READY", actual "NOT_COMPATIBLE") → COMP-002 ANALYSIS_BUG<br>redis (expected false, actual true) → COMP-011 ANALYSIS_BUG<br>unsupported (expected [], actual ["kafka","local-filesystem"]) → COMP-002 ANALYSIS_BUG |
| repo-002 | Unleash/unleash@0429c29 | realistic | READY | NEEDS_CONFIGURATION | compatibility (expected "READY", actual "NEEDS_CONFIGURATION") → COMP-001 ANALYSIS_BUG<br>port (expected 4242, actual null) → COMP-001 ANALYSIS_BUG<br>healthPath (expected "/health", actual null) → COMP-018 ANALYSIS_BUG |
| repo-003 | thedevs-network/kutt@279b491 | realistic | NEEDS_CONFIGURATION | NOT_COMPATIBLE | compatibility (expected "NEEDS_CONFIGURATION", actual "NOT_COMPATIBLE") → COMP-002 ANALYSIS_BUG<br>postgres (expected true, actual false) → COMP-013 ANALYSIS_MISSING_SIGNAL<br>redis (expected false, actual true) → COMP-011 ANALYSIS_BUG<br>port (expected 3000, actual null) → COMP-001 ANALYSIS_BUG<br>healthPath (expected "/api/health", actual null) → COMP-005 ANALYSIS_MISSING_SIGNAL<br>unsupported (expected [], actual ["local-filesystem","mysql","sqlite"]) → COMP-002 ANALYSIS_BUG |
| repo-004 | miniflux/v2@a84533d | realistic | NEEDS_CONFIGURATION | NOT_COMPATIBLE | compatibility (expected "NEEDS_CONFIGURATION", actual "NOT_COMPATIBLE") → COMP-008 ANALYSIS_BUG<br>postgres (expected true, actual false) → COMP-013 ANALYSIS_MISSING_SIGNAL<br>migration (expected true, actual false) → COMP-014 ANALYSIS_MISSING_SIGNAL<br>appRoot (expected ".", actual "packaging/debian") → COMP-007 ANALYSIS_BUG<br>dockerfilePath (expected "packaging/docker/alpine/Dockerfile", actual "packaging/debian/Dockerfile") → COMP-007 ANALYSIS_BUG<br>port (expected 8080, actual null) → COMP-001 ANALYSIS_BUG<br>healthPath (expected "/healthcheck", actual null) → COMP-005 ANALYSIS_MISSING_SIGNAL<br>unsupported (expected [], actual ["gcp"]) → COMP-008 ANALYSIS_BUG |
| repo-005 | Flagsmith/flagsmith@4a8a84a | realistic | NEEDS_CONFIGURATION | NOT_COMPATIBLE | compatibility (expected "NEEDS_CONFIGURATION", actual "NOT_COMPATIBLE") → COMP-009 ANALYSIS_BUG<br>worker (expected true, actual false) → COMP-015 ANALYSIS_MISSING_SIGNAL<br>storage (expected false, actual true) → COMP-012 ANALYSIS_BUG<br>migration (expected true, actual false) → COMP-014 ANALYSIS_MISSING_SIGNAL<br>port (expected 8000, actual null) → COMP-001 ANALYSIS_BUG<br>healthPath (expected "/health/liveness", actual "/health") → COMP-005 ANALYSIS_MISSING_SIGNAL<br>unsupported (expected [], actual ["docker-compose-multi-service","local-filesystem","redis-unsupported"]) → COMP-009 ANALYSIS_BUG |
| repo-006 | documenso/documenso@3ec877a | realistic | NEEDS_CONFIGURATION | READY | compatibility (expected "NEEDS_CONFIGURATION", actual "READY") → COMP-017 ANALYSIS_MISSING_SIGNAL<br>redis (expected false, actual true) → COMP-011 ANALYSIS_BUG<br>storage (expected false, actual true) → COMP-012 ANALYSIS_BUG<br>appRoot (expected "apps/remix", actual "docker") → COMP-020 ANALYSIS_BUG |
| repo-007 | ghostfolio/ghostfolio@73e4f03 | realistic | NEEDS_CONFIGURATION | NEEDS_CONFIGURATION | port (expected 3333, actual null) → COMP-001 ANALYSIS_BUG<br>healthPath (expected "/api/v1/health", actual null) → COMP-005 ANALYSIS_MISSING_SIGNAL |
| repo-008 | TwiN/gatus@4d15cb7 | realistic | READY | NOT_COMPATIBLE | compatibility (expected "READY", actual "NOT_COMPATIBLE") → COMP-002 ANALYSIS_BUG<br>storage (expected false, actual true) → COMP-012 ANALYSIS_BUG<br>port (expected 8080, actual null) → COMP-001 ANALYSIS_BUG<br>healthPath (expected "/health", actual null) → COMP-005 ANALYSIS_MISSING_SIGNAL<br>unsupported (expected [], actual ["docker-compose-multi-service","sqlite"]) → COMP-002 ANALYSIS_BUG |
| repo-009 | heroku/node-js-getting-started@63c6674 | realistic | NEEDS_CONFIGURATION | NEEDS_CONFIGURATION | match |
| repo-010 | knadh/listmonk@670c017 | messy | NEEDS_CONFIGURATION | NEEDS_CONFIGURATION | migration (expected true, actual false) → COMP-014 ANALYSIS_MISSING_SIGNAL<br>port (expected 9000, actual null) → COMP-001 ANALYSIS_BUG<br>healthPath (expected "/health", actual null) → COMP-005 ANALYSIS_MISSING_SIGNAL |
| repo-011 | healthchecks/healthchecks@69dbd2a | messy | NEEDS_CONFIGURATION | NEEDS_CONFIGURATION | postgres (expected true, actual false) → COMP-013 ANALYSIS_MISSING_SIGNAL<br>worker (expected true, actual false) → COMP-015 ANALYSIS_MISSING_SIGNAL<br>migration (expected true, actual false) → COMP-014 ANALYSIS_MISSING_SIGNAL<br>appRoot (expected ".", actual "docker") → COMP-020 ANALYSIS_BUG<br>port (expected 8000, actual null) → COMP-001 ANALYSIS_BUG |
| repo-012 | diced/zipline@a2ac5f2 | messy | NEEDS_CONFIGURATION | NEEDS_CONFIGURATION | port (expected 3000, actual null) → COMP-001 ANALYSIS_BUG |
| repo-013 | louislam/uptime-kuma@5df2a3c | boundary | NOT_COMPATIBLE | NOT_COMPATIBLE | redis (expected false, actual true) → COMP-011 ANALYSIS_BUG<br>appRoot (expected ".", actual "docker") → COMP-020 ANALYSIS_BUG<br>unsupported (expected ["sqlite"], actual ["kafka","local-filesystem","mongodb","mysql"]) → COMP-002 ANALYSIS_BUG |
| repo-014 | automatisch/automatisch@41f3c56 | boundary | NOT_COMPATIBLE | NOT_COMPATIBLE | appRoot (expected ".", actual ".devcontainer") → COMP-007 ANALYSIS_BUG<br>dockerfilePath (expected "docker/Dockerfile", actual ".devcontainer/Dockerfile") → COMP-007 ANALYSIS_BUG<br>port (expected 3000, actual null) → COMP-001 ANALYSIS_BUG<br>healthPath (expected "/healthcheck", actual "/packages/backend/controllers/healthcheck") → COMP-004 ANALYSIS_BUG |
| repo-015 | immich-app/immich@6d85f20 | boundary | NOT_COMPATIBLE | NOT_COMPATIBLE | postgres (expected true, actual false) → COMP-013 ANALYSIS_MISSING_SIGNAL<br>appRoot (expected "server", actual "machine-learning") → COMP-007 ANALYSIS_BUG<br>dockerfilePath (expected "server/Dockerfile", actual "machine-learning/Dockerfile") → COMP-007 ANALYSIS_BUG<br>port (expected 2283, actual null) → COMP-001 ANALYSIS_BUG<br>healthPath (expected "/api/server/ping", actual "/health") → COMP-005 ANALYSIS_MISSING_SIGNAL<br>unsupported (expected ["docker-compose-multi-service","local-filesystem"], actual ["docker-compose-multi-service","gpu","local-filesystem"]) → COMP-007 ANALYSIS_BUG |
