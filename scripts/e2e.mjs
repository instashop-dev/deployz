#!/usr/bin/env node
// Cross-platform E2E runner (docs/testing/simulated-e2e.md
// D3). Selects a mode, guards real-AWS modes behind an explicit opt-in, and —
// for simulated mode — scrubs AWS/queue/email env vars before spawning
// Playwright so locally-present credentials can't leak real behaviour into a
// default run.
import { spawn } from 'node:child_process';

import { scrubEnv } from './e2e-env.mjs';

const VALID_MODES = ['simulated', 'fresh', 'canary-versions'];

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

const startTime = Date.now();

function finishWithDuration(code, signal) {
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`\ndeployz test summary\n  mode: ${mode.padEnd(16)} ${elapsed}s`);
  process.exit(code ?? (signal ? 1 : 0));
}

// Guard runs before dry-run handling — dry-run must not be a way to peek at
// what a real-AWS run would do without the opt-in.
if ((mode === 'fresh' || mode === 'canary-versions') && process.env.DEPLOYZ_E2E_ALLOW_REAL_AWS !== '1') {
  console.error(REFUSAL);
  process.exit(1);
}

if (mode === 'canary-versions') {
  // The version/rollback canary (docs/testing/aws-e2e.md):
  // a tsx script that drives the deployed control plane and the test AWS
  // account end to end. Subcommand and flags pass straight through.
  const scriptArgs = ['tsx', 'scripts/version-canary/index.ts', ...passthrough];
  const addedEnv = { DEPLOYZ_E2E_MODE: mode };
  if (dryRun) {
    console.log(JSON.stringify({ mode, command: 'pnpm', args: ['exec', ...scriptArgs], envKeys: Object.keys(addedEnv) }));
    process.exit(0);
  }
  const child = spawn('pnpm', ['exec', ...scriptArgs], {
    env: { ...process.env, ...addedEnv },
    stdio: 'inherit',
    shell: true,
  });
  child.on('exit', (code, signal) => {
    finishWithDuration(code, signal);
  });
  child.on('error', (err) => {
    console.error(err);
    process.exit(1);
  });
} else if (mode === 'fresh') {
  // Guard already satisfied above. D5: fresh wraps
  // packages/cdk/test/fresh-e2e.live.test.ts — a real-AWS vitest suite, not
  // Playwright — so it runs through `pnpm --filter @deployz/cdk exec vitest
  // run <file>` instead of the simulated mode's Playwright path below. AWS
  // credentials/region are passed through unchanged: fresh mode is the whole
  // point of NOT scrubbing them (unlike simulated mode).
  const vitestArgs = ['--filter', '@deployz/cdk', 'exec', 'vitest', 'run', 'test/fresh-e2e.live.test.ts'];
  const addedEnv = { DEPLOYZ_E2E_MODE: mode };

  if (dryRun) {
    console.log(JSON.stringify({ mode, command: 'pnpm', args: vitestArgs, envKeys: Object.keys(addedEnv) }));
    process.exit(0);
  }

  const childEnv = { ...process.env, ...addedEnv };
  // shell: true so Windows resolves the pnpm.cmd shim.
  const child = spawn('pnpm', vitestArgs, { env: childEnv, stdio: 'inherit', shell: true });

  child.on('exit', (code, signal) => {
    finishWithDuration(code, signal);
  });
  child.on('error', (err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  const playwrightArgs = [...passthrough];
  if (scenario) {
    playwrightArgs.push('--grep', `@scenario:${scenario}\\b`);
  } else if (scenarios) {
    playwrightArgs.push('--grep', '@scenario');
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

  // shell: true so Windows resolves the pnpm.cmd shim. The shell also parses
  // the arguments, so a grep pattern such as `@scenario|visual` must be
  // quoted or `|visual` becomes a pipe to a command named visual. Plain
  // double quotes, not JSON: both cmd.exe and sh keep `` intact inside
  // them, where a JSON-escaped `\b` would reach Playwright doubled on Windows.
  const quoted = playwrightArgs.map((arg) => (/^[\w./:=@-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`));
  const child = spawn('pnpm', ['exec', 'playwright', 'test', ...quoted], {
    env: childEnv,
    stdio: 'inherit',
    shell: true,
  });

  child.on('exit', (code, signal) => {
    finishWithDuration(code, signal);
  });
  child.on('error', (err) => {
    console.error(err);
    process.exit(1);
  });
}
