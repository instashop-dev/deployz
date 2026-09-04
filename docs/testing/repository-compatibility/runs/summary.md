# Repository compatibility audit — run summary

Deployz commit: `35bf06f914a14582bc336df0b90dc72e7e6294dd` · analysis version: 8

| Metric | Value |
| --- | --- |
| Repositories | 15 |
| Analysed | 15 |
| Failed to analyse | 0 |
| Verdict matches | 7 / 15 (46.7%) |
| All facts match | 3 |
| False acceptances | 0 |
| False rejections | 1 |
| Configuration-detection mismatches | 7 |
| Unexplained mismatches | 0 |

## Mismatches by finding type

| Type | Mismatches |
| --- | --- |
| ANALYSIS_BUG | 17 |
| ANALYSIS_MISSING_SIGNAL | 14 |
| MVP_CAPABILITY_GAP | 0 |
| CORRECTLY_UNSUPPORTED | 0 |
| REPO_INVALID | 0 |

## By set

| Set | Repositories | Analysed | Verdict matches | All facts match |
| --- | --- | --- | --- | --- |
| improvement | 15 | 15 | 7 | 3 |

## By cohort

| Cohort | Repositories | Analysed | Verdict matches | All facts match |
| --- | --- | --- | --- | --- |
| boundary | 3 | 3 | 3 | 1 |
| messy | 3 | 3 | 1 | 1 |
| realistic | 9 | 9 | 3 | 1 |

## Repositories

| Id | Repository | Cohort | Expected | Actual | Result |
| --- | --- | --- | --- | --- | --- |
| repo-001 | umami-software/umami@ca661c7 | realistic | READY | NEEDS_CONFIGURATION | compatibility (expected "READY", actual "NEEDS_CONFIGURATION") → COMP-023 ANALYSIS_BUG<br>redis (expected false, actual true) → COMP-011 ANALYSIS_BUG |
| repo-002 | Unleash/unleash@0429c29 | realistic | READY | NEEDS_CONFIGURATION | compatibility (expected "READY", actual "NEEDS_CONFIGURATION") → COMP-023 ANALYSIS_BUG |
| repo-003 | thedevs-network/kutt@279b491 | realistic | NEEDS_CONFIGURATION | NEEDS_CONFIGURATION | redis (expected false, actual true) → COMP-011 ANALYSIS_BUG<br>healthPath (expected "/api/health", actual "/health") → COMP-005 ANALYSIS_MISSING_SIGNAL |
| repo-004 | miniflux/v2@a84533d | realistic | NEEDS_CONFIGURATION | READY | compatibility (expected "NEEDS_CONFIGURATION", actual "READY") → COMP-014 ANALYSIS_MISSING_SIGNAL<br>migration (expected true, actual false) → COMP-014 ANALYSIS_MISSING_SIGNAL |
| repo-005 | Flagsmith/flagsmith@4a8a84a | realistic | NEEDS_CONFIGURATION | NOT_COMPATIBLE | compatibility (expected "NEEDS_CONFIGURATION", actual "NOT_COMPATIBLE") → COMP-009 ANALYSIS_BUG<br>redis (expected false, actual true) → COMP-011 ANALYSIS_BUG<br>worker (expected true, actual false) → COMP-015 ANALYSIS_MISSING_SIGNAL<br>migration (expected true, actual false) → COMP-014 ANALYSIS_MISSING_SIGNAL<br>healthPath (expected "/health/liveness", actual "/health") → COMP-005 ANALYSIS_MISSING_SIGNAL<br>unsupported (expected [], actual ["docker-compose-multi-service","local-filesystem"]) → COMP-009 ANALYSIS_BUG |
| repo-006 | documenso/documenso@3ec877a | realistic | NEEDS_CONFIGURATION | NEEDS_CONFIGURATION | redis (expected false, actual true) → COMP-011 ANALYSIS_BUG<br>storage (expected false, actual true) → COMP-012 ANALYSIS_BUG<br>appRoot (expected "apps/remix", actual ".") → COMP-020 ANALYSIS_BUG |
| repo-007 | ghostfolio/ghostfolio@73e4f03 | realistic | NEEDS_CONFIGURATION | READY | compatibility (expected "NEEDS_CONFIGURATION", actual "READY") → COMP-017 ANALYSIS_MISSING_SIGNAL |
| repo-008 | TwiN/gatus@4d15cb7 | realistic | READY | NEEDS_CONFIGURATION | compatibility (expected "READY", actual "NEEDS_CONFIGURATION") → COMP-016 ANALYSIS_BUG |
| repo-009 | heroku/node-js-getting-started@63c6674 | realistic | NEEDS_CONFIGURATION | NEEDS_CONFIGURATION | match |
| repo-010 | knadh/listmonk@670c017 | messy | NEEDS_CONFIGURATION | READY | compatibility (expected "NEEDS_CONFIGURATION", actual "READY") → COMP-021 ANALYSIS_MISSING_SIGNAL<br>storage (expected false, actual true) → COMP-012 ANALYSIS_BUG<br>migration (expected true, actual false) → COMP-014 ANALYSIS_MISSING_SIGNAL<br>healthPath (expected "/health", actual "/api/health") → COMP-005 ANALYSIS_MISSING_SIGNAL |
| repo-011 | healthchecks/healthchecks@69dbd2a | messy | NEEDS_CONFIGURATION | READY | compatibility (expected "NEEDS_CONFIGURATION", actual "READY") → COMP-022 ANALYSIS_MISSING_SIGNAL<br>worker (expected true, actual false) → COMP-015 ANALYSIS_MISSING_SIGNAL<br>migration (expected true, actual false) → COMP-014 ANALYSIS_MISSING_SIGNAL |
| repo-012 | diced/zipline@a2ac5f2 | messy | NEEDS_CONFIGURATION | NEEDS_CONFIGURATION | match |
| repo-013 | louislam/uptime-kuma@5df2a3c | boundary | NOT_COMPATIBLE | NOT_COMPATIBLE | redis (expected false, actual true) → COMP-011 ANALYSIS_BUG<br>unsupported (expected ["sqlite"], actual ["local-filesystem","mongodb"]) → COMP-002 ANALYSIS_BUG |
| repo-014 | automatisch/automatisch@41f3c56 | boundary | NOT_COMPATIBLE | NOT_COMPATIBLE | match |
| repo-015 | immich-app/immich@6d85f20 | boundary | NOT_COMPATIBLE | NOT_COMPATIBLE | appRoot (expected "server", actual "machine-learning") → COMP-007 ANALYSIS_BUG<br>dockerfilePath (expected "server/Dockerfile", actual "machine-learning/Dockerfile") → COMP-007 ANALYSIS_BUG<br>healthPath (expected "/api/server/ping", actual "/health") → COMP-005 ANALYSIS_MISSING_SIGNAL<br>unsupported (expected ["docker-compose-multi-service","local-filesystem"], actual ["docker-compose-multi-service","gpu"]) → COMP-007 ANALYSIS_BUG |
