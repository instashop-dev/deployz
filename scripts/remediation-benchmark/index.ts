/**
 * Remediation (fix-instructions) benchmark runner.
 *
 *   pnpm benchmark:remediation                    deterministic plan + document checks (no model)
 *   pnpm benchmark:remediation --case RB-01       one (or several --case) cases
 *   pnpm benchmark:remediation --prompts <dir>    also write each case's model prompt
 *   pnpm benchmark:remediation --replay <dir>     grade recorded model answers (<dir>/<case>.json)
 *   pnpm benchmark:remediation --live             call the configured fix-instructions model
 *   pnpm benchmark:remediation --no-write         print the summary, write nothing
 *
 * The live mode reads FIX_INSTRUCTIONS_AI_PROVIDER / FIX_INSTRUCTIONS_AI_MODEL /
 * OPENROUTER_API_KEY like the API does (apps/api/src/ai-config.ts), records
 * every answer under runs/live/ so it can be replayed for free, and reports
 * latency, tokens, cost and the served model. Exit code 1 when a case fails.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import {
  assembleFixInstructions,
  buildFixInstructionsAiPrompt,
  createAiGateway,
  fixInstructionsAiSchema,
  generateFixInstructions,
  planRemediation,
  FIX_INSTRUCTIONS_TIMEOUT_MS,
  type AiGateway,
  type FixInstructionsAiOutput,
  type FixInstructionsContext,
} from '@deployz/analysis';
import { describeFixInstructionsAiConfig } from '@deployz/api/ai-config';
import { buildFixInstructionsContext } from '@deployz/api/fix-instructions';

import { RUNS_DIR, caseSource, loadBenchmark, loadSnapshot, type BenchmarkCase } from './cases.js';
import { evaluateCase, type CaseResult } from './evaluate.js';

export interface LiveMetrics {
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number | null;
  servedModel: string | null;
  error: string | null;
}

export interface RunResult extends CaseResult {
  live?: LiveMetrics;
}

export function caseContext(entry: BenchmarkCase): FixInstructionsContext | null {
  return buildFixInstructionsContext(caseSource(entry, loadSnapshot(entry.snapshot)));
}

/** Grade one case without a model, or with a recorded answer. */
export function runCase(entry: BenchmarkCase, ai: FixInstructionsAiOutput | null = null): RunResult {
  const context = caseContext(entry);
  if (!context) {
    return {
      id: entry.id, snapshot: entry.snapshot, tags: entry.tags, classes: [], truth: [], unsafe: [],
      structureProblems: ['no unresolved findings: no document'], includeMissing: [], excludePresent: [],
      noFixesViolated: false, guidance: null, documentChars: 0, promptChars: 0,
      pass: Object.keys(entry.expect.classes).length === 0,
    };
  }
  const plan = planRemediation(context);
  const document = assembleFixInstructions(context, ai ?? { items: [] });
  return evaluateCase({ entry, plan, document, prompt: buildFixInstructionsAiPrompt(context), ai });
}

interface Summary {
  generatedAt: string;
  mode: 'deterministic' | 'replay' | 'live';
  cases: number;
  passed: number;
  classification: { correct: number; total: number };
  truthAgreement: { correct: number; total: number };
  unsafeDocuments: number;
  structureProblems: number;
  expectationMisses: number;
  guidance: { answers: number; schemaValid: number; returned: number; rendered: number; dropped: number } | null;
  live: { calls: number; failed: number; p50LatencyMs: number; p95LatencyMs: number; promptTokens: number; completionTokens: number; costUsd: number; servedModels: string[] } | null;
  failures: { id: string; reasons: string[] }[];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

export function failureReasons(result: RunResult): string[] {
  return [
    ...result.classes.filter((c) => !c.correct).map((c) => `${c.findingId}: expected ${c.expected}, got ${c.actual ?? 'none'}`),
    ...result.unsafe.map((id) => `unsafe instruction: ${id}`),
    ...result.structureProblems,
    ...result.includeMissing.map((text) => `missing: ${text}`),
    ...result.excludePresent.map((text) => `present: ${text}`),
    ...(result.noFixesViolated ? ['asks for a change in a correctly configured app'] : []),
    ...(result.live?.error ? [`model call failed: ${result.live.error}`] : []),
  ];
}

export function summarise(results: RunResult[], mode: Summary['mode'], schemaValid: number | null): Summary {
  const classes = results.flatMap((r) => r.classes);
  const live = results.map((r) => r.live).filter((m): m is LiveMetrics => m !== undefined);
  const guided = results.map((r) => r.guidance).filter((g): g is NonNullable<CaseResult['guidance']> => g !== null);
  return {
    generatedAt: new Date().toISOString(),
    mode,
    cases: results.length,
    passed: results.filter((r) => r.pass).length,
    classification: { correct: classes.filter((c) => c.correct).length, total: classes.length },
    truthAgreement: {
      correct: results.flatMap((r) => r.truth).filter((c) => c.correct).length,
      total: results.flatMap((r) => r.truth).length,
    },
    unsafeDocuments: results.filter((r) => r.unsafe.length > 0).length,
    structureProblems: results.reduce((n, r) => n + r.structureProblems.length, 0),
    expectationMisses: results.reduce((n, r) => n + r.includeMissing.length + r.excludePresent.length + (r.noFixesViolated ? 1 : 0), 0),
    guidance: mode === 'deterministic' ? null : {
      answers: guided.length,
      schemaValid: schemaValid ?? guided.length,
      returned: guided.reduce((n, g) => n + g.returned, 0),
      rendered: guided.reduce((n, g) => n + g.rendered, 0),
      dropped: guided.reduce((n, g) => n + g.dropped, 0),
    },
    live: mode !== 'live' ? null : {
      calls: live.length,
      failed: live.filter((m) => m.error !== null).length,
      p50LatencyMs: percentile(live.map((m) => m.latencyMs), 50),
      p95LatencyMs: percentile(live.map((m) => m.latencyMs), 95),
      promptTokens: live.reduce((n, m) => n + m.promptTokens, 0),
      completionTokens: live.reduce((n, m) => n + m.completionTokens, 0),
      costUsd: Number(live.reduce((n, m) => n + (m.costUsd ?? 0), 0).toFixed(4)),
      servedModels: [...new Set(live.map((m) => m.servedModel).filter((m): m is string => m !== null))],
    },
    failures: results.filter((r) => !r.pass).map((r) => ({ id: r.id, reasons: failureReasons(r) })),
  };
}

export function renderSummary(summary: Summary): string {
  const pct = (a: number, b: number) => (b === 0 ? 'n/a' : `${((100 * a) / b).toFixed(1)}%`);
  const lines = [
    '# Remediation benchmark summary',
    '',
    `Generated by \`pnpm benchmark:remediation\` (${summary.mode}). Do not edit by hand.`,
    '',
    '| Metric | Result |',
    '| --- | --- |',
    `| Cases passed | ${summary.passed}/${summary.cases} (${pct(summary.passed, summary.cases)}) |`,
    `| Classification | ${summary.classification.correct}/${summary.classification.total} (${pct(summary.classification.correct, summary.classification.total)}) |`,
    `| Agreement with repository truth (analysis accuracy, not gated) | ${summary.truthAgreement.correct}/${summary.truthAgreement.total} (${pct(summary.truthAgreement.correct, summary.truthAgreement.total)}) |`,
    `| Documents with a critical unsafe instruction | ${summary.unsafeDocuments} |`,
    `| Structure / actionability problems | ${summary.structureProblems} |`,
    `| Expected-content misses | ${summary.expectationMisses} |`,
  ];
  if (summary.guidance) {
    lines.push(
      `| Schema-valid model answers | ${summary.guidance.schemaValid}/${summary.guidance.answers} |`,
      `| Guidance rendered / dropped by the safety filter | ${summary.guidance.rendered} / ${summary.guidance.dropped} |`,
    );
  }
  if (summary.live) {
    lines.push(
      `| Model calls (failed) | ${summary.live.calls} (${summary.live.failed}) |`,
      `| Served model | ${summary.live.servedModels.join(', ') || 'none'} |`,
      `| Latency p50 / p95 | ${summary.live.p50LatencyMs} ms / ${summary.live.p95LatencyMs} ms |`,
      `| Tokens (prompt / completion) | ${summary.live.promptTokens} / ${summary.live.completionTokens} |`,
      `| Cost | $${summary.live.costUsd} |`,
    );
  }
  if (summary.failures.length > 0) {
    lines.push('', '## Failures', '');
    for (const failure of summary.failures) lines.push(`- ${failure.id}: ${failure.reasons.join('; ')}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Call the configured model for one case, timing and recording it. */
async function runLive(entry: BenchmarkCase, gateway: AiGateway, recordDir: string): Promise<RunResult> {
  const context = caseContext(entry);
  if (!context) return runCase(entry);
  let answer: FixInstructionsAiOutput | null = null;
  const metrics: LiveMetrics = { latencyMs: 0, promptTokens: 0, completionTokens: 0, costUsd: null, servedModel: null, error: null };
  const recording: AiGateway = {
    async generate(prompt, schema, options) {
      const response = await gateway.generate(prompt, schema, options);
      answer = fixInstructionsAiSchema.parse(response.object);
      metrics.promptTokens = response.usage.promptTokens;
      metrics.completionTokens = response.usage.completionTokens;
      metrics.costUsd = response.usage.costUsd ?? null;
      metrics.servedModel = response.model ?? null;
      return response;
    },
  };
  const start = Date.now();
  try {
    const document = await generateFixInstructions(context, recording, { abortSignal: AbortSignal.timeout(FIX_INSTRUCTIONS_TIMEOUT_MS) });
    writeFileSync(join(recordDir, `${entry.id}.md`), document);
  } catch (error) {
    metrics.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  metrics.latencyMs = Date.now() - start;
  if (answer) writeFileSync(join(recordDir, `${entry.id}.json`), `${JSON.stringify(answer, null, 2)}\n`);
  return { ...runCase(entry, answer), live: metrics };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      case: { type: 'string', multiple: true },
      prompts: { type: 'string' },
      replay: { type: 'string' },
      live: { type: 'boolean', default: false },
      'no-write': { type: 'boolean', default: false },
      concurrency: { type: 'string', default: '3' },
    },
  });
  const benchmark = loadBenchmark();
  const selected = values.case?.length ? benchmark.cases.filter((c) => values.case!.includes(c.id)) : benchmark.cases;
  const write = !values['no-write'];

  if (values.prompts) {
    mkdirSync(values.prompts, { recursive: true });
    for (const entry of selected) {
      const context = caseContext(entry);
      if (context) writeFileSync(join(values.prompts, `${entry.id}.txt`), buildFixInstructionsAiPrompt(context));
    }
  }

  let results: RunResult[];
  let mode: Summary['mode'] = 'deterministic';
  let schemaValid: number | null = null;
  if (values.live) {
    mode = 'live';
    const { config, problem } = describeFixInstructionsAiConfig(process.env);
    if (!config) throw new Error(`The fix-instructions model is not configured (${problem}). Set OPENROUTER_API_KEY, or FIX_INSTRUCTIONS_AI_PROVIDER=gateway with the shared gateway.`);
    const gateway = createAiGateway(config);
    const recordDir = join(RUNS_DIR, 'live');
    mkdirSync(recordDir, { recursive: true });
    results = [];
    const queue = [...selected];
    const workers = Array.from({ length: Math.max(1, Number(values.concurrency)) }, async () => {
      for (let entry = queue.shift(); entry; entry = queue.shift()) results.push(await runLive(entry, gateway, recordDir));
    });
    await Promise.all(workers);
    results.sort((a, b) => a.id.localeCompare(b.id));
  } else if (values.replay) {
    mode = 'replay';
    schemaValid = 0;
    results = [];
    for (const entry of selected) {
      let answer: FixInstructionsAiOutput | null = null;
      try {
        answer = fixInstructionsAiSchema.parse(JSON.parse(readFileSync(join(values.replay, `${entry.id}.json`), 'utf8')));
        schemaValid += 1;
      } catch {
        answer = { items: [] };
      }
      results.push(runCase(entry, answer));
    }
  } else {
    results = selected.map((entry) => runCase(entry));
  }

  const summary = summarise(results, mode, schemaValid);
  const rendered = renderSummary(summary);
  process.stdout.write(rendered);
  if (write) {
    const dir = mode === 'deterministic' ? RUNS_DIR : join(RUNS_DIR, mode);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'summary.json'), `${JSON.stringify({ ...summary, results }, null, 2)}\n`);
    writeFileSync(join(dir, 'summary.md'), rendered);
  }
  if (summary.passed !== summary.cases) process.exitCode = 1;
}

if (process.argv[1] && /remediation-benchmark[\\/]index\.ts$/.test(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
