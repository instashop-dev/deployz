# Remediation benchmark

Measures the fix-instructions generator (`packages/analysis/src/fix-instructions.ts`)
over real repositories. The generator itself is described in
[`../../ai-analysis.md`](../../ai-analysis.md#fix-instructions).

## Inputs

- `snapshots/<repo-id>.json` — the generator input of a real repository at
  the pinned commit of the compatibility benchmark: the application row and
  its analysis metadata, written by `scripts/remediation-benchmark/capture.ts`
  through the production analysis path. Names of environment variables only,
  never values. Re-capture after an analysis change that alters findings.
- `cases.yaml` — 38 cases: 26 snapshots as analysed and 12 targeted
  mutations. Roles: three primary repositories (kutt, paperless-ngx, the
  Deployz phase-5 canary), one holdout (CTFd) that is never used to tune the
  generator, and support repositories.
- Labels: `classes` are blind labels by independent labellers who saw the
  taxonomy and the evidence, never the generator. `truth` are the labellers'
  classes after reading the repository; they measure the analysis, not the
  generator. Adjudicated labels are listed at the top of `cases.yaml`.

## Run

1. `pnpm benchmark:remediation` — deterministic: classes, critical unsafe
   instructions, structure and actionability, expected content. CI runs the
   same checks (`scripts/remediation-benchmark/benchmark.test.ts`); the gates
   are at least 95% of labels correct and no unsafe document.
2. `pnpm benchmark:remediation --prompts <dir>` — also write each model prompt.
3. `pnpm benchmark:remediation --replay <dir>` — grade recorded model answers
   (`<dir>/<case>.json`) without a model call.
4. `pnpm benchmark:remediation --live` — call the configured fix-instructions
   model (`OPENROUTER_API_KEY`, or `FIX_INSTRUCTIONS_AI_PROVIDER=gateway`).
   It records each answer and document under `runs/live/` and reports the
   served model, latency, tokens and cost. Do not run it in CI.

`runs/summary.md` and `runs/live/summary.md` are written by the runner; do not
edit them by hand. `runs/live/<case>.json` are the recorded model answers of
the last live run; grade them again with `--replay runs/live`.

## Coding-agent execution

The benchmark grades documents. Whether a coding agent resolves a blocker is
checked separately: run the document in a disposable worktree of the pinned
repository, then review the diff and the agent's report. A build alone is not
proof. Record a confirmed generator defect in `findings.md` with a
regression test.
