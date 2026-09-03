# Repository compatibility findings

Every mismatch between an expected fact in [`benchmark.yaml`](benchmark.yaml)
and what the production analysis path produced is recorded here once, under
a stable `COMP-xxx` id, with the classification the audit assigned it. The
`findings` section of `benchmark.yaml` mirrors the id and type of every entry
below; a test keeps the two in step.

Types (defined in [`README.md`](README.md#finding-categories)):
`ANALYSIS_BUG`, `ANALYSIS_MISSING_SIGNAL`, `MVP_CAPABILITY_GAP`,
`CORRECTLY_UNSUPPORTED`, `REPO_INVALID`.

Status vocabulary: `open` (mismatch stands), `fixed` (analyser changed, regression
test added, affected repositories rerun), `accepted` (a documented boundary or a
gap deferred by decision — the mismatch stands by design).

## Findings

No findings yet — the corpus is populated from Phase 2 onwards.
