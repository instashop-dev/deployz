import { describe, expect, it } from 'vitest';

import { loadBenchmark, loadSnapshot } from './cases.js';
import { instructionLines, unsafeInstructions } from './evaluate.js';
import { failureReasons, runCase, summarise } from './index.js';

// The deterministic release gate over the pinned snapshots: every case's
// classes, safety, structure and expected content. No model is called; the
// live and replay modes run outside CI (`pnpm benchmark:remediation`).

const benchmark = loadBenchmark();

describe('remediation benchmark — cases', () => {
  it.each(benchmark.cases.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(failureReasons(runCase(entry))).toEqual([]);
  });
});

describe('remediation benchmark — release gates', () => {
  const summary = summarise(benchmark.cases.map((entry) => runCase(entry)), 'deterministic', null);

  it('classifies at least 95% of labelled findings correctly', () => {
    expect(summary.classification.correct / summary.classification.total).toBeGreaterThanOrEqual(0.95);
  });

  it('produces no document with a critical unsafe instruction', () => {
    expect(summary.unsafeDocuments).toBe(0);
  });

  it('covers 30-40 cases over at least three primary repositories and a holdout, at pinned commits', () => {
    expect(benchmark.cases.length).toBeGreaterThanOrEqual(30);
    expect(benchmark.cases.length).toBeLessThanOrEqual(40);
    const roles = benchmark.repositories.map((repo) => repo.role);
    expect(roles.filter((role) => role === 'primary').length).toBeGreaterThanOrEqual(3);
    expect(roles).toContain('holdout');
    for (const repo of benchmark.repositories) expect(loadSnapshot(repo.id).commit).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('evaluate — critical unsafe instructions', () => {
  it.each([
    ['worker-into-web', '   - Process background jobs inside the web process (an in-process scheduler or queue worker).'],
    ['queue-into-web', '   - Replace the queue with jobs that run inside the web process.'],
    ['delete-infrastructure', '   - Remove the self-managed infrastructure files and dependencies.'],
    ['unapproved-data-rewrite', '   - Inspect actual usage first. Move the data layer to PostgreSQL reusing the existing schema.'],
  ])('flags %s', (id, line) => {
    expect(unsafeInstructions(`## Fixes\n${line}`)).toContain(id);
  });

  it('does not flag the constraints and rules that forbid those changes', () => {
    const document = [
      '### 1. Worker',
      '- Do not:',
      '  - Do not move the worker into the web process, and do not remove worker, queue, or scheduler code.',
      '- Done when:',
      '  - One command starts the worker.',
      '## Rules for every change',
      '- Never delete working code, disable security, skip tests, or suppress errors to pass a Deployz check.',
    ].join('\n');
    expect(unsafeInstructions(document)).toEqual([]);
    expect(instructionLines(document)).toContain('  - One command starts the worker.');
  });
});
