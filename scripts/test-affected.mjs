#!/usr/bin/env node
// Phase 7: deterministic affected-test selector.
// Prints a test plan from git diff vs origin/main. Never provisions AWS.
// Use --run to execute only simulated layers (vitest/Playwright).
// Use --files <csv> to override the change list (debug/testability).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { relative, sep } from 'node:path';

// ── Scenario mapping ────────────────────────────────────────────────────────
// device/health/ecs files          → scenarios
const SCENARIO_MAP = [
  // deploy/rollback/destroy/purge executors
  { files: [ /\/deploy\.ts$/, /\/rollback/, /\/destroy\.ts$/, /\/purge\.ts$/ ], ids: ['rollback-success', 'delete-failure', 'retained-resources', 'happy-path'] },
  // health/ecs files
  { files: [ /\/ecs-health\.ts$/, /\/ecs-observe\.ts$/, /\/health/ ],         ids: ['ecs-failure', 'healthcheck-failure'] },
  // install/verify/stack-events
  { files: [ /\/install\.ts$/, /\/verify\.ts$/ ],                             ids: ['happy-path'] },
  // domain
  { files: [ /\/domain\.ts$/ ],                                               ids: ['happy-path'] },
];

// Relay AWS client interface files (changes here trigger canary line)
const RELAY_AWS_INTERFACE = new Set([
  'verify.ts', 'install.ts', 'stack-events.ts', 'ecs-health.ts',
  'deploy.ts', 'ecs-observe.ts', 'destroy.ts', 'purge.ts', 'domain.ts',
]);

// CDK provisioning-semantic paths (bootstrap/**, cdk synth/bin, template artifacts)
const CDK_PROVISIONING_PATTERNS = [
  /\/bootstrap\//,
  /\/cdk\/bin\//,
  /\/cdk\/artifacts\//,
  /\/cdk\/scripts\/synth-/,
];

// Root config files that trigger full simulated suite
const ROOT_CONFIG = [
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^turbo\.json$/,
  /^playwright\.config\.ts$/,
  /^scripts\/e2e\.mjs$/,
  /^scripts\/e2e-env\.mjs$/,
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: opts.cwd ?? process.cwd(), encoding: 'utf8', ...opts });
  if (r.error) throw new Error(`git ${args[0]}: ${r.error.message}`);
  return r.stdout.trim().split('\n').filter(Boolean);
}

function toForwardSlash(p) { return p.split(sep).join('/'); }

// ── Change collection ────────────────────────────────────────────────────────

function collectChangedFiles(cwd) {
  // 1. merge-base with origin/main
  let base;
  try {
    base = git(['merge-base', 'HEAD', 'origin/main'], { cwd })[0];
  } catch {
    // fallback when origin/main doesn't exist (detached head, shallow clone)
    base = 'HEAD';
  }
  // 2. diff vs merge-base
  const committed = base === 'HEAD' ? [] : git(['diff', '--name-only', `${base}...HEAD`], { cwd });
  // 3. unstaged + staged
  const unstaged = git(['diff', '--name-only'], { cwd });
  const staged = git(['diff', '--name-only', '--cached'], { cwd });
  const all = [...new Set([...committed, ...unstaged, ...staged])].filter(Boolean);
  return all.map(toForwardSlash);
}

// ── Mapping rules ────────────────────────────────────────────────────────────

function mapChanges(files) {
  const layers = {
    webUnit: false,
    apiUnit: false,
    analysisUnit: false,
    relayUnit: false,
    cdkUnit: false,
    relayScenarios: new Set(),
    relayAwsInterface: false,
    cdkProvisioning: false,
    e2eSimulation: false,
    e2eSimFull: false,
    versionCanaryUnit: false,
    repoDeployUnit: false,
    playwrightAffected: false,
    rootConfigChanged: false,
  };

  for (const f of files) {
    // Root config
    if (ROOT_CONFIG.some(p => p.test(f))) {
      layers.rootConfigChanged = true;
      layers.e2eSimFull = true;
    }

    // apps/web
    if (f.startsWith('apps/web/')) {
      layers.webUnit = true;
      layers.playwrightAffected = true;
    }

    // apps/api
    if (f.startsWith('apps/api/')) {
      layers.apiUnit = true;
      // If deployment/product workflows affected, also simulated E2E
      if (/\/deploy|lifecycle|destroy|rollback|install/.test(f)) {
        layers.e2eSimFull = true;
      }
    }

    // packages/analysis
    if (f.startsWith('packages/analysis/')) {
      layers.analysisUnit = true;
    }

    // packages/relay
    if (f.startsWith('packages/relay/')) {
      layers.relayUnit = true;
      // Map scenarios
      for (const mapping of SCENARIO_MAP) {
        if (mapping.files.some(p => p.test(f))) {
          for (const id of mapping.ids) layers.relayScenarios.add(id);
        }
      }
      // Check AWS interface
      const basename = f.split('/').pop();
      if (RELAY_AWS_INTERFACE.has(basename)) {
        layers.relayAwsInterface = true;
      }
    }

    // packages/cdk
    if (f.startsWith('packages/cdk/')) {
      layers.cdkUnit = true;
      if (CDK_PROVISIONING_PATTERNS.some(p => p.test(f))) {
        layers.cdkProvisioning = true;
      }
    }

    // e2e
    if (f.startsWith('e2e/')) {
      layers.e2eSimFull = layers.e2eSimFull || f.startsWith('e2e/simulation/');
      layers.playwrightAffected = true;
    }

    // scripts/version-canary
    if (f.startsWith('scripts/version-canary/')) {
      layers.versionCanaryUnit = true;
    }

    // scripts/repository-deployment
    if (f.startsWith('scripts/repository-deployment/')) {
      layers.repoDeployUnit = true;
    }
  }

  return layers;
}

// ── Render ───────────────────────────────────────────────────────────────────

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

function printChanged(files) {
  console.log(`${BOLD}Changed areas:${RESET}`);
  if (files.length === 0) {
    console.log('  (no changes detected)');
    return;
  }
  if (files.length <= 20) {
    for (const f of files) console.log(`  ${f}`);
  } else {
    // Group by directory
    const groups = {};
    for (const f of files) {
      const dir = f.includes('/') ? f.split('/').slice(0, -1).join('/') : '(root)';
      if (!groups[dir]) groups[dir] = [];
      groups[dir].push(f.split('/').pop());
    }
    for (const [dir, items] of Object.entries(groups)) {
      console.log(`  ${dir}/ (${items.length} file${items.length > 1 ? 's' : ''})`);
      for (const item of items.slice(0, 5)) console.log(`    ${item}`);
      if (items.length > 5) console.log(`    ... and ${items.length - 5} more`);
    }
  }
  console.log();
}

function printPlan(layers) {
  console.log(`${BOLD}Required:${RESET}`);
  let hasRequired = false;

  // Targeted unit tests
  const units = [];
  if (layers.webUnit) units.push({ label: 'targeted unit: @deployz/web', cmd: 'pnpm --filter @deployz/web exec vitest run' });
  if (layers.apiUnit) units.push({ label: 'targeted unit: @deployz/api', cmd: 'pnpm --filter @deployz/api exec vitest run' });
  if (layers.analysisUnit) units.push({ label: 'targeted unit: @deployz/analysis', cmd: 'pnpm --filter @deployz/analysis exec vitest run' });
  if (layers.relayUnit) units.push({ label: 'targeted unit: @deployz/relay', cmd: 'pnpm --filter @deployz/relay exec vitest run' });
  if (layers.cdkUnit) units.push({ label: 'targeted unit: @deployz/cdk', cmd: 'pnpm --filter @deployz/cdk exec vitest run' });
  if (layers.versionCanaryUnit) units.push({ label: 'targeted unit: version-canary', cmd: 'cd scripts/version-canary && pnpm exec vitest run' });
  if (layers.repoDeployUnit) units.push({ label: 'targeted unit: repository-deployment', cmd: 'cd scripts/repository-deployment && pnpm exec vitest run' });

  for (const u of units) {
    console.log(`  ${GREEN}✓${RESET} ${u.label}: ${u.cmd}`);
    hasRequired = true;
  }

  // Playwright affected specs
  if (layers.playwrightAffected) {
    console.log(`  ${GREEN}✓${RESET} targeted Playwright: pnpm exec playwright test`);
    hasRequired = true;
  }

  // Scenarios
  if (layers.relayScenarios.size > 0) {
    for (const id of [...layers.relayScenarios].sort()) {
      console.log(`  ${GREEN}✓${RESET} scenario: ${id}  (pnpm e2e --scenario=${id})`);
      hasRequired = true;
    }
  }

  // Full simulated suite
  if (layers.e2eSimFull) {
    console.log(`  ${GREEN}✓${RESET} full simulated suite before merge: pnpm e2e:scenarios`);
    hasRequired = true;
  }

  // Read-only AWS canary
  if (layers.relayAwsInterface || layers.cdkProvisioning) {
    console.log(`  ${GREEN}✓${RESET} read-only AWS canary: pnpm e2e:canary`);
    hasRequired = true;
  }

  if (!hasRequired) {
    console.log(`  ${YELLOW}(none — no mapped test layers triggered)${RESET}`);
  }

  // Not required
  console.log(`\n${BOLD}Not required:${RESET}`);
  if (!layers.e2eSimFull) console.log(`  ${RED}✗${RESET} full simulated suite`);
  if (!layers.relayAwsInterface && !layers.cdkProvisioning) console.log(`  ${RED}✗${RESET} read-only AWS canary`);
  console.log(`  ${RED}✗${RESET} fresh AWS (provisioning only — pnpm e2e:fresh)`);
  console.log(`  ${RED}✗${RESET} full-product canary (escalation only)`);
}

// ── Escalation mode ──────────────────────────────────────────────────────────

function printEscalation(layers) {
  console.log(`${BOLD}AWS Escalation Assessment${RESET}\n`);

  const reasons = [];

  if (layers.relayAwsInterface) {
    reasons.push('Relay AWS client interface changed (verify, install, deploy, destroy, purge, domain, stack-events, ecs-health, ecs-observe)');
  }
  if (layers.cdkProvisioning) {
    reasons.push('CDK provisioning-semantic files changed (bootstrap stack, synth scripts, template artifacts)');
  }

  if (reasons.length === 0) {
    console.log('  No AWS layer requirements detected for the current changes.\n');
    console.log('  Real AWS is an escalation, not the debugging loop. Run targeted');
    console.log('  vitest and simulated E2E scenarios first.');
    return;
  }

  console.log('  Required AWS layers:');
  for (const r of reasons) {
    console.log(`    • ${r}`);
  }
  console.log();

  if (layers.relayAwsInterface) {
    console.log('  Read-only AWS canary:');
    console.log('    DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary');
    console.log();
  }
  if (layers.cdkProvisioning) {
    console.log('  Fresh AWS E2E (provisioning):');
    console.log('    DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:fresh');
    console.log();
  }

  console.log(`${BOLD}⚠  Reminder:${RESET} real AWS is an escalation, not the debugging loop.`);
  console.log('   Run targeted vitest and simulated E2E scenarios first. Copy these');
  console.log('   commands manually — --run will not execute them.');
  console.log(`   Set ${YELLOW}DEPLOYZ_E2E_ALLOW_REAL_AWS=1${RESET} in your shell before running.`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  let run = false;
  let filesOverride = null;
  const rest = [];
  for (const arg of argv) {
    if (arg === '--run') run = true;
    else if (arg.startsWith('--files=')) filesOverride = arg.slice('--files='.length).split(/[, ]+/).map(s => s.trim()).filter(Boolean);
    else if (arg === '--escalation') { /* handled by caller */ }
    else rest.push(arg);
  }
  return { run, filesOverride, rest };
}

const { run, filesOverride } = parseArgs(process.argv.slice(2));
const isEscalation = process.argv.includes('--escalation');
const cwd = process.cwd();

let files;
if (filesOverride) {
  files = filesOverride;
} else {
  try {
    files = collectChangedFiles(cwd);
  } catch (e) {
    console.error(`Error collecting changed files: ${e.message}`);
    process.exit(1);
  }
}

const layers = mapChanges(files);

if (isEscalation) {
  printEscalation(layers);
  process.exit(0);
}

// Normal plan mode
printChanged(files);
printPlan(layers);

// ── Run mode (only simulated layers) ─────────────────────────────────────────
if (run) {
  console.log(`\n${BOLD}Executing simulated layers...${RESET}\n`);
  const commands = [];

  // Unit tests
  if (layers.webUnit) commands.push(['pnpm', ['--filter', '@deployz/web', 'exec', 'vitest', 'run']]);
  if (layers.apiUnit) commands.push(['pnpm', ['--filter', '@deployz/api', 'exec', 'vitest', 'run']]);
  if (layers.analysisUnit) commands.push(['pnpm', ['--filter', '@deployz/analysis', 'exec', 'vitest', 'run']]);
  if (layers.relayUnit) commands.push(['pnpm', ['--filter', '@deployz/relay', 'exec', 'vitest', 'run']]);
  if (layers.cdkUnit) commands.push(['pnpm', ['--filter', '@deployz/cdk', 'exec', 'vitest', 'run']]);
  if (layers.versionCanaryUnit) commands.push(['pnpm', ['exec', 'vitest', 'run'], { cwd: cwd + '/scripts/version-canary', existsCheck: 'scripts/version-canary/vitest.config.ts' }]);
  if (layers.repoDeployUnit) commands.push(['pnpm', ['exec', 'vitest', 'run'], { cwd: cwd + '/scripts/repository-deployment', existsCheck: 'scripts/repository-deployment/vitest.config.ts' }]);

  // Playwright
  if (layers.playwrightAffected) {
    commands.push(['pnpm', ['exec', 'playwright', 'test']]);
  }

  // Scenarios
  if (layers.relayScenarios.size > 0) {
    for (const id of [...layers.relayScenarios].sort()) {
      commands.push(['pnpm', ['exec', 'playwright', 'test', '--grep', `@scenario:${id}\\b`]]);
    }
  }

  // Full simulated suite
  if (layers.e2eSimFull) {
    commands.push(['pnpm', ['exec', 'playwright', 'test', '--grep', '@scenario']]);
  }

  // Refuse AWS commands
  const awsLines = [];
  if (layers.relayAwsInterface || layers.cdkProvisioning) {
    awsLines.push('pnpm e2e:canary');
  }
  if (layers.cdkProvisioning) {
    awsLines.push('pnpm e2e:fresh');
  }

  if (commands.length === 0) {
    console.log('  No simulated layers to execute.');
    process.exit(0);
  }

  for (const [cmd, args, opts] of commands) {
    const dir = opts?.cwd ? relative(cwd, opts.cwd) : '.';
    console.log(`  ${YELLOW}>${RESET} ${cmd} ${args.join(' ')}  (in ${dir})`);
    const result = spawnSync(cmd, args, {
      cwd: opts?.cwd ?? cwd,
      stdio: 'inherit',
      shell: true,
      env: { ...process.env },
    });
    if (result.status !== 0) {
      console.error(`\n  Command failed with exit code ${result.status}, aborting.`);
      process.exit(result.status);
    }
  }

  if (awsLines.length > 0) {
    console.log(`\n  ${YELLOW}Skipped AWS commands (must be run manually):${RESET}`);
    for (const line of awsLines) {
      console.log(`    DEPLOYZ_E2E_ALLOW_REAL_AWS=1 ${line}`);
    }
    console.log(`  ${BOLD}Real AWS is an escalation, not the debugging loop.${RESET}`);
  }

  console.log(`\n  ${GREEN}All simulated layers passed.${RESET}`);
}