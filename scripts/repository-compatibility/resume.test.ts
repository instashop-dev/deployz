import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseRunArgs, resumableResult } from './index.js';
import { writeRunFiles, type RunResult } from './report.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'compat-resume-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const COMMIT = 'a'.repeat(40);
const context = { deployzSha: 'd'.repeat(40), analysisVersion: 45 };

function recorded(overrides: Partial<RunResult> = {}): RunResult {
  return { id: 'repo-001', commit: COMMIT, deployzSha: context.deployzSha, analysisVersion: 45, ai: { mode: 'off' }, ...overrides } as unknown as RunResult;
}

describe('--resume', () => {
  it('is off by default', () => {
    expect(parseRunArgs([]).resume).toBe(false);
    expect(parseRunArgs(['--resume']).resume).toBe(true);
  });

  it('reuses a result with the same Deployz commit, analysis version, commit and AI mode', () => {
    writeRunFiles(dir, [recorded()]);
    expect(resumableResult(dir, { id: 'repo-001', commit: COMMIT }, context, 'off')).toMatchObject({ id: 'repo-001' });
  });

  it('re-runs the entry when any of the four values differs, or when no result exists', () => {
    writeRunFiles(dir, [recorded()]);
    const entry = { id: 'repo-001', commit: COMMIT };
    expect(resumableResult(dir, { ...entry, commit: 'b'.repeat(40) }, context, 'off')).toBeNull();
    expect(resumableResult(dir, entry, { ...context, deployzSha: 'e'.repeat(40) }, 'off')).toBeNull();
    expect(resumableResult(dir, entry, { ...context, analysisVersion: 46 }, 'off')).toBeNull();
    expect(resumableResult(dir, entry, context, 'live')).toBeNull();
    expect(resumableResult(dir, { id: 'repo-002', commit: COMMIT }, context, 'off')).toBeNull();
  });
});
