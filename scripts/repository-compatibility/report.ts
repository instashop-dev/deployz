/**
 * Run results: one JSON file per repository under `runs/`, plus a summary in
 * JSON and Markdown. Files carry no timestamps — the Deployz commit and the
 * analysis version identify a run, so a rerun on the same commit and
 * snapshots reproduces the files byte for byte.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BenchmarkEntry, ExpectedFacts, FindingType } from './manifest.js';
import { FINDING_TYPES } from './manifest.js';
import type { ActualFacts, ClassifiedMismatch, Comparison } from './normalize.js';

export interface RunResult {
  id: string;
  repository: string;
  commit: string;
  set: BenchmarkEntry['set'];
  cohort: BenchmarkEntry['cohort'];
  customerRealism: BenchmarkEntry['customer_realism'];
  difficulty: number;
  deployzSha: string;
  analysisVersion: number;
  status: 'analysed' | 'failed';
  failure: string | null;
  tree: { files: number; entries: number | null; truncated: boolean | null };
  expected: ExpectedFacts;
  actual: ActualFacts | null;
  comparisons: Comparison[];
  mismatches: ClassifiedMismatch[];
  /** Every compared fact matched. */
  match: boolean;
}

export interface RunSummary {
  deployzSha: string;
  analysisVersion: number;
  total: number;
  analysed: number;
  failed: number;
  fullMatch: number;
  verdictMatch: number;
  /** verdictMatch / analysed, percent with one decimal. */
  verdictAccuracy: number;
  falseAcceptances: number;
  falseRejections: number;
  configurationMismatches: number;
  factMismatches: Record<string, number>;
  byFindingType: Record<FindingType, number>;
  unexplained: { id: string; fact: string; expected: unknown; actual: unknown }[];
  bySet: Record<string, { total: number; analysed: number; verdictMatch: number; fullMatch: number }>;
  byCohort: Record<string, { total: number; analysed: number; verdictMatch: number; fullMatch: number }>;
}

function percent(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 1000) / 10;
}

export function buildSummary(results: readonly RunResult[], deployzSha: string, analysisVersion: number): RunSummary {
  const analysed = results.filter((result) => result.status === 'analysed');
  const verdictMatch = analysed.filter((result) => result.comparisons.find((c) => c.fact === 'compatibility')?.match === true);
  const mismatches = analysed.flatMap((result) => result.mismatches.map((mismatch) => ({ id: result.id, mismatch })));

  const factMismatches: Record<string, number> = {};
  const byFindingType = Object.fromEntries(FINDING_TYPES.map((type) => [type, 0])) as Record<FindingType, number>;
  const unexplained: RunSummary['unexplained'] = [];
  for (const { id, mismatch } of mismatches) {
    factMismatches[mismatch.fact] = (factMismatches[mismatch.fact] ?? 0) + 1;
    if (mismatch.finding) byFindingType[mismatch.finding.type] += 1;
    else unexplained.push({ id, fact: mismatch.fact, expected: mismatch.expected, actual: mismatch.actual });
  }

  const group = (key: (result: RunResult) => string) => {
    const groups: RunSummary['bySet'] = {};
    for (const result of results) {
      const bucket = (groups[key(result)] ??= { total: 0, analysed: 0, verdictMatch: 0, fullMatch: 0 });
      bucket.total += 1;
      if (result.status === 'analysed') bucket.analysed += 1;
      if (verdictMatch.includes(result)) bucket.verdictMatch += 1;
      if (result.match) bucket.fullMatch += 1;
    }
    return Object.fromEntries(Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)));
  };

  return {
    deployzSha,
    analysisVersion,
    total: results.length,
    analysed: analysed.length,
    failed: results.length - analysed.length,
    fullMatch: analysed.filter((result) => result.match).length,
    verdictMatch: verdictMatch.length,
    verdictAccuracy: percent(verdictMatch.length, analysed.length),
    falseAcceptances: mismatches.filter(({ mismatch }) => mismatch.kind === 'false-acceptance').length,
    falseRejections: mismatches.filter(({ mismatch }) => mismatch.kind === 'false-rejection').length,
    configurationMismatches: mismatches.filter(({ mismatch }) => mismatch.kind === 'configuration-detection').length,
    factMismatches: Object.fromEntries(Object.entries(factMismatches).sort(([a], [b]) => a.localeCompare(b))),
    byFindingType,
    unexplained,
    bySet: group((result) => result.set),
    byCohort: group((result) => result.cohort),
  };
}

function describeMismatch(mismatch: ClassifiedMismatch): string {
  const attribution = mismatch.finding ? `${mismatch.finding.id} ${mismatch.finding.type}` : 'UNEXPLAINED';
  return `${mismatch.fact} (expected ${JSON.stringify(mismatch.expected)}, actual ${JSON.stringify(mismatch.actual)}) → ${attribution}`;
}

export function renderSummary(results: readonly RunResult[], summary: RunSummary): string {
  const lines: string[] = [
    '# Repository compatibility audit — run summary',
    '',
    `Deployz commit: \`${summary.deployzSha}\` · analysis version: ${summary.analysisVersion}`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Repositories | ${summary.total} |`,
    `| Analysed | ${summary.analysed} |`,
    `| Failed to analyse | ${summary.failed} |`,
    `| Verdict matches | ${summary.verdictMatch} / ${summary.analysed} (${summary.verdictAccuracy}%) |`,
    `| All facts match | ${summary.fullMatch} |`,
    `| False acceptances | ${summary.falseAcceptances} |`,
    `| False rejections | ${summary.falseRejections} |`,
    `| Configuration-detection mismatches | ${summary.configurationMismatches} |`,
    `| Unexplained mismatches | ${summary.unexplained.length} |`,
    '',
    '## Mismatches by finding type',
    '',
    '| Type | Mismatches |',
    '| --- | --- |',
    ...FINDING_TYPES.map((type) => `| ${type} | ${summary.byFindingType[type]} |`),
    '',
    '## By set',
    '',
    '| Set | Repositories | Analysed | Verdict matches | All facts match |',
    '| --- | --- | --- | --- | --- |',
    ...Object.entries(summary.bySet).map(
      ([set, b]) => `| ${set} | ${b.total} | ${b.analysed} | ${b.verdictMatch} | ${b.fullMatch} |`,
    ),
    '',
    '## By cohort',
    '',
    '| Cohort | Repositories | Analysed | Verdict matches | All facts match |',
    '| --- | --- | --- | --- | --- |',
    ...Object.entries(summary.byCohort).map(
      ([cohort, b]) => `| ${cohort} | ${b.total} | ${b.analysed} | ${b.verdictMatch} | ${b.fullMatch} |`,
    ),
    '',
    '## Repositories',
    '',
    '| Id | Repository | Cohort | Expected | Actual | Result |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const result of results) {
    const actual = result.status === 'analysed' ? (result.actual?.compatibility ?? '—') : `FAILED: ${result.failure ?? 'unknown'}`;
    const detail =
      result.status !== 'analysed' ? 'not analysed' : result.match ? 'match' : result.mismatches.map(describeMismatch).join('<br>');
    lines.push(
      `| ${result.id} | ${result.repository}@${result.commit.slice(0, 7)} | ${result.cohort} | ${result.expected.compatibility} | ${actual} | ${detail} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

export function writeRunFiles(dir: string, results: readonly RunResult[]): void {
  mkdirSync(dir, { recursive: true });
  for (const result of results) {
    writeFileSync(join(dir, `${result.id}.json`), `${JSON.stringify(result, null, 2)}\n`);
  }
}

export function writeSummaryFiles(dir: string, results: readonly RunResult[], summary: RunSummary): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(dir, 'summary.md'), renderSummary(results, summary));
}
