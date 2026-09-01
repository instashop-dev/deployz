#!/usr/bin/env node
// Cross-platform E2E runner (docs/testing/discovery/phase1-design-decisions.md
// D3). Selects a mode, guards real-AWS modes behind an explicit opt-in, and —
// for simulated mode — scrubs AWS/queue/email env vars before spawning
// Playwright so locally-present credentials can't leak real behaviour into a
// default run.
import { spawn } from 'node:child_process';

import { scrubEnv } from './e2e-env.mjs';

const VALID_MODES = ['simulated', 'canary', 'fresh'];

const REFUSAL = `Real AWS E2E is disabled.
Set DEPLOYZ_E2E_ALLOW_REAL_AWS=1
only when intentionally running AWS-backed E2E tests.`;

function parseArgs(argv) {
  let mode = 'simulated';
  let scenario;
  let scenarios = false;
  let dryRun = false;
  const passthrough = [];
  for (const arg of argv) {
    if (arg.startsWith('--mode=')) {
      mode = arg.slice('--mode='.length);
    } else if (arg.startsWith('--scenario=')) {
      scenario = arg.slice('--scenario='.length);
    } else if (arg === '--scenarios') {
      scenarios = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else {
      passthrough.push(arg);
    }
  }
  return { mode, scenario, scenarios, dryRun, passthrough };
}

const { mode, scenario, scenarios, dryRun, passthrough } = parseArgs(process.argv.slice(2));

if (!VALID_MODES.includes(mode)) {
  console.error(`Unknown mode "${mode}". Valid modes: ${VALID_MODES.join(', ')}`);
  process.exit(1);
}

// Guard runs before dry-run handling — dry-run must not be a way to peek at
// what a real-AWS run would do without the opt-in.
if ((mode === 'canary' || mode === 'fresh') && process.env.DEPLOYZ_E2E_ALLOW_REAL_AWS !== '1') {
  console.error(REFUSAL);
  process.exit(1);
}

const playwrightArgs = [...passthrough];
if (scenario) {
  playwrightArgs.push('--grep', `@scenario:${scenario}\\b`);
} else if (scenarios) {
  playwrightArgs.push('--grep', '@scenario');
}

if (mode === 'canary' || mode === 'fresh') {
  // Guard already satisfied above. The real canary/fresh suites (D5: wrapping
  // packages/cdk/test/golden-path-live-aws.test.ts + audit-deployment.mjs)
  // arrive in a later phase — this branch is a deliberately obvious
  // placeholder to replace then.
  console.error(`"${mode}" mode's suite is not wired up yet — it arrives in a later phase.`);
  process.exit(1);
}

const { env: childEnv, scrubbed } = scrubEnv(process.env);
childEnv.DEPLOYZ_E2E_MODE = 'simulated';
if (scenario) childEnv.DEPLOYZ_E2E_SCENARIO = scenario;

if (dryRun) {
  console.log(
    JSON.stringify({ mode, scenario: scenario ?? null, playwrightArgs, scrubbedVars: scrubbed }),
  );
  process.exit(0);
}

// shell: true so Windows resolves the pnpm.cmd shim (same pattern as
// packages/cdk/test/golden-path-live-aws.test.ts's spawnSync `cdk` helper).
const child = spawn('pnpm', ['exec', 'playwright', 'test', ...playwrightArgs], {
  env: childEnv,
  stdio: 'inherit',
  shell: true,
});

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
child.on('error', (err) => {
  console.error(err);
  process.exit(1);
});
