# P1-GATE review

**Verdict: PASS.** Phase 1 is complete. Phase advances to 2.
Reviewer: Opus coordinator, run 2026-10-08 21:17Z (attempt 1). testedCommit `e6a3b58e`.

## Gate criteria

| Criterion | Result | Evidence |
|---|---|---|
| 100 fresh families | PASS | `corpus.json`: 100 entries, 100 distinct repositories, cohorts 70 realistic / 20 messy / 10 boundary. No repository is in `excluded-families.json` (143 entries); checked by script for both sets. |
| Source-backed labels | PASS | `labels/final-01.yaml` .. `final-10.yaml` (P1-RECONCILE-01..05, rule set R1). Each final file passed the Opus validator `v-07.mts` (schema, pins, every citation path in the pinned tree) and an unrecorded-difference check (0 unrecorded). No labeler or verifier got Deployz output. |
| Separate label and verify steps | PASS | P1-LABEL-01..10 and P1-VERIFY-01..10 were separate worker invocations; reconcile used both plus pinned source. |
| REPO_INVALID handled | PASS | 0 REPO_INVALID in all final files, so no replacement selection was necessary. |
| Stratified 80/20 split | PASS | `split.json` (P1-FREEZE-CORPUS, seeded hash per cohort): improvement 56/16/8, holdout 14/4/2. |
| `benchmark.yaml` | PASS | `campaign/corpus/benchmark.yaml`: `parseBenchmark` OK, 80 entries, all `set: improvement`. |
| `holdout.yaml` | PASS | `campaign/corpus/holdout.yaml`: `parseBenchmark` OK, 20 entries with final labels, all `set: unseen`. No holdout id is in `benchmark.yaml`; 100 distinct pins in total. |

Label distribution (cohort:compatibility):

- improvement: realistic 5 READY / 22 NEEDS_CONFIGURATION / 29 NOT_COMPATIBLE; messy 1 NEEDS_CONFIGURATION / 15 NOT_COMPATIBLE; boundary 8 NOT_COMPATIBLE.
- holdout: realistic 1 / 6 / 7; messy 1 READY / 1 NEEDS_CONFIGURATION / 2 NOT_COMPATIBLE; boundary 2 NOT_COMPATIBLE.

Observation (no gate effect): 63 of 100 apps are NOT_COMPATIBLE and only 7 are READY. Most
realistic self-hosted apps keep local disk state or need a value. Phase 3 metrics must report
per verdict class, because an analyser that always says NOT_COMPATIBLE gets 63% compatibility
accuracy.

## Metadata fields

`benchmarkEntrySchema` requires `customer_realism` and `difficulty`. No earlier step recorded them,
so the gate sets them by a fixed rule (written in the file header): realism realistic = high,
messy = medium, boundary = low; difficulty READY 2, otherwise 3, +1 messy, +1 monorepo, max 5.
These fields are reporting metadata only; the audit does not compare them.

## Open rule questions (settled, no label change)

1. **monorepo** and **runtime** (including `bun` on 542 vs `node` on 580): these facts are not in
   `COMPARED_FACTS` (`scripts/repository-compatibility/normalize.ts`); the manifest records them for
   corpus distribution only. The judgement calls stay as labeled. No rule is added.
2. **`windows` (596) and GPU (594)**: R1 lists Windows and GPU as non-goals. R6 "others" uses the
   lowercase product name, so `windows` is valid. 594 has a CPU build, so no GPU family; its verdict
   rests on `local-filesystem`. `kubernetes` (595, 600) and `kafka` (598) follow the R6 table.
3. **Env switch vs local default** (563 Lychee, 565 open-webui NEEDS_CONFIGURATION; 531 linkding,
   532 pretix, 583 Ghost, 588 Mautic, 589 OpenProject NOT_COMPATIBLE): R1 text decides. An
   environment switch that removes all local state gives NEEDS_CONFIGURATION; local state with no
   supported switch (or a switch that needs an installed adapter or plugin) gives NOT_COMPATIBLE.
   The final files apply this consistently according to their citations. 589 rests on the default
   `all-in-one` stage (embedded PostgreSQL data directory, EXPOSE 80; Opus checked the pinned
   `docker/prod/Dockerfile`).
4. **R5 migration**: named tools and migrate commands = true; opaque in-app migrations = omitted.
   The final files follow R5 as written. `migration` is compared, so Phase 3 findings on it are
   real signal.
5. **R6 with two causes**: R6 lists only non-goal families; missing-Dockerfile and prebuilt-artifact
   causes get no entry. The final files follow this.
6. **Non-standard database URL names** (551 spliit `POSTGRES_PRISMA_URL`, READY): the docs
   (`docs/product/mvp-scope.md`) do not name the variables Deployz binds. The label stays READY.
   If Phase 3 shows a mismatch on 551, classify it from source and docs, not by changing the label.

## Holdout handling

`holdout.yaml` existed as the P1-FREEZE-CORPUS pin list. The gate replaced it with the labeled
schema form, generated from `split.json` and the final files, without reading the old content.
From now on only Phase 6 tasks may read `holdout.yaml`.
