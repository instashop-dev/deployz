import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

// Guards for scripts/e2e.mjs (docs/testing/discovery/phase1-design-decisions.md
// D3). Runs the runner as a child process rather than importing it, so the
// process-exit / stdout-stream behaviour under test is exercised directly.
// No browser needed — this only spawns Node.

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'e2e.mjs');
const REFUSAL = 'Real AWS E2E is disabled.';

function runCli(args: string[], envOverrides: Record<string, string | undefined> = {}) {
  const env = { ...process.env, ...envOverrides };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete env[key];
  }
  return spawnSync(process.execPath, [RUNNER, ...args], { encoding: 'utf8', env });
}

test('canary mode refuses without the real-AWS opt-in', () => {
  const result = runCli(['--mode=canary', '--dry-run'], { DEPLOYZ_E2E_ALLOW_REAL_AWS: undefined });
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toContain(REFUSAL);
});

test('fresh mode refuses without the real-AWS opt-in', () => {
  const result = runCli(['--mode=fresh', '--dry-run'], { DEPLOYZ_E2E_ALLOW_REAL_AWS: undefined });
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toContain(REFUSAL);
});

test('canary mode with the opt-in set does not print the refusal', () => {
  const result = runCli(['--mode=canary', '--dry-run'], { DEPLOYZ_E2E_ALLOW_REAL_AWS: '1' });
  // The real canary suite is not wired up yet (later phase) — this asserts
  // only that the guard itself did not fire.
  expect(result.stdout + result.stderr).not.toContain(REFUSAL);
});

test('default (simulated) mode dry-run reports mode simulated', () => {
  const result = runCli(['--dry-run']);
  expect(result.status).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.mode).toBe('simulated');
});

test('simulated mode dry-run scrubs AWS credentials from the child env', () => {
  const result = runCli(['--dry-run'], { AWS_ACCESS_KEY_ID: 'dummy' });
  expect(result.status).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.scrubbedVars).toContain('AWS_ACCESS_KEY_ID');
});

test('an unknown mode exits non-zero', () => {
  const result = runCli(['--mode=bogus', '--dry-run']);
  expect(result.status).not.toBe(0);
});
