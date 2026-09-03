#!/usr/bin/env node
// Cross-platform E2E runner (docs/testing/discovery/phase1-design-decisions.md
// D3). Selects a mode, guards real-AWS modes behind an explicit opt-in, and —
// for simulated mode — scrubs AWS/queue/email env vars before spawning
// Playwright so locally-present credentials can't leak real behaviour into a
// default run.
import { spawn } from 'node:child_process';

import { scrubEnv } from './e2e-env.mjs';

const VALID_MODES = ['simulated', 'canary', 'fresh', 'canary-versions'];

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
if (
  (mode === 'canary' || mode === 'fresh' || mode === 'canary-versions') &&
  process.env.DEPLOYZ_E2E_ALLOW_REAL_AWS !== '1'
) {
  console.error(REFUSAL);
  process.exit(1);
}

if (mode === 'canary-versions') {
  // The version/rollback canary (docs/testing/version-rollback-canary.md):
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
    process.exit(code ?? (signal ? 1 : 0));
  });
  child.on('error', (err) => {
    console.error(err);
    process.exit(1);
  });
} else if (mode === 'canary' || mode === 'fresh') {
  // Guard already satisfied above. D5: canary/fresh wrap
  // packages/cdk/test/{canary,fresh}-e2e.live.test.ts — real-AWS vitest
  // suites, not Playwright — so they run through `pnpm --filter @deployz/cdk
  // exec vitest run <file>` instead of the simulated mode's Playwright path
  // below. AWS credentials/region are passed through unchanged: these modes
  // are the whole point of NOT scrubbing them (unlike simulated mode).
  const testFile = mode === 'canary' ? 'test/canary-e2e.live.test.ts' : 'test/fresh-e2e.live.test.ts';
  const vitestArgs = ['--filter', '@deployz/cdk', 'exec', 'vitest', 'run', testFile];
  const addedEnv = { DEPLOYZ_E2E_MODE: mode };

  if (dryRun) {
    console.log(JSON.stringify({ mode, command: 'pnpm', args: vitestArgs, envKeys: Object.keys(addedEnv) }));
    process.exit(0);
  }

  const childEnv = { ...process.env, ...addedEnv };
  // shell: true so Windows resolves the pnpm.cmd shim (same pattern as
  // packages/cdk/test/golden-path-live-aws.test.ts's spawnSync `cdk` helper).
  const child = spawn('pnpm', vitestArgs, { env: childEnv, stdio: 'inherit', shell: true });

  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
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
}
