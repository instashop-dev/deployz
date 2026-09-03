# Repository compatibility audit — run summary

Deployz commit: `5b1816790641fe37cd1ecb3fcc9c72be0f1a2abe` · analysis version: 6

| Metric | Value |
| --- | --- |
| Repositories | 1 |
| Analysed | 1 |
| Failed to analyse | 0 |
| Verdict matches | 0 / 1 (0%) |
| All facts match | 0 |
| False acceptances | 0 |
| False rejections | 1 |
| Configuration-detection mismatches | 0 |
| Unexplained mismatches | 3 |

## Mismatches by finding type

| Type | Mismatches |
| --- | --- |
| ANALYSIS_BUG | 0 |
| ANALYSIS_MISSING_SIGNAL | 0 |
| MVP_CAPABILITY_GAP | 0 |
| CORRECTLY_UNSUPPORTED | 0 |
| REPO_INVALID | 0 |

## By set

| Set | Repositories | Analysed | Verdict matches | All facts match |
| --- | --- | --- | --- | --- |
| improvement | 1 | 1 | 0 | 0 |

## By cohort

| Cohort | Repositories | Analysed | Verdict matches | All facts match |
| --- | --- | --- | --- | --- |
| realistic | 1 | 1 | 0 | 0 |

## Repositories

| Id | Repository | Cohort | Expected | Actual | Result |
| --- | --- | --- | --- | --- | --- |
| repo-001 | umami-software/umami@ca661c7 | realistic | NEEDS_CONFIGURATION | NOT_COMPATIBLE | compatibility (expected "NEEDS_CONFIGURATION", actual "NOT_COMPATIBLE") → UNEXPLAINED<br>redis (expected false, actual true) → UNEXPLAINED<br>unsupported (expected [], actual ["kafka","local-filesystem"]) → UNEXPLAINED |
