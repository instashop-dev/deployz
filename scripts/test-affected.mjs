#!/usr/bin/env node
// Risk-based affected-test selector. Maps changed files to test layers and
// one risk level: minimal (docs-only), targeted (affected builds/tests/specs),
// targeted-web (web unit + the full non-visual Playwright PR suite), or
// critical (full pre-merge validation). Never provisions AWS: --run executes
// simulated layers only; real-AWS commands are printed as escalations.
// Fail-safe: unknown executable paths, root config changes, and failed change
// detection always select the full safe suite — never zero tests.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── Scenario mapping (relay executor/health files → simulated scenarios) ────
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

// Relay AWS client interface files (changes here report a canary escalation)
const RELAY_AWS_INTERFACE = new Set([
  'verify.ts', 'install.ts', 'stack-events.ts', 'ecs-health.ts',
  'deploy.ts', 'ecs-observe.ts', 'destroy.ts', 'purge.ts', 'domain.ts',
]);

// Relay protocol core — command lifecycle needs the full simulated regression
const RELAY_PROTOCOL = new Set([
  'commands.ts', 'poll.ts', 'pending.ts', 'recover.ts', 'provision-progress.ts',
]);

// CDK provisioning-semantic paths (bootstrap stack, synth, template artifacts)
const CDK_PROVISIONING_PATTERNS = [
  /\/bootstrap\//,
  /\/cdk\/bin\//,
  /\/cdk\/artifacts\//,
  /\/cdk\/scripts\/synth-/,
];

// apps/api source files that can affect a customer deployment
const API_CRITICAL = new Set([
  'manifest.ts', 'jobs.ts', 'lifecycle.ts', 'install-parameters.ts', 'install-config.ts',
  'deployment-status.ts', 'deploy-contract.ts', 'disconnect.ts', 'disconnect-force-complete.ts',
  'relay-store.ts', 'relay-liveness.ts', 'relay-identity.ts', 'digest-reconciliation.ts',
  'health-transitions.ts', 'stack-event-progress.ts', 'stack-progress.ts', 'queue.ts',
  'release-images.ts', 'ecr-grants.ts', 'ecr-pull-grants.ts', 'default-https.ts',
  'default-https-fixture.ts', 'preflight.ts', 'requirements-contract.ts', 'server.ts', 'index.ts',
]);

// packages/contracts schemas that shape deployment behavior
const CONTRACTS_CRITICAL = new Set(['manifest.ts', 'infrastructure.ts', 'index.ts']);

// packages/db persisted-state schema areas (billing has a dedicated spec)
const DB_CRITICAL_SCHEMA = new Set([
  'deployments.ts', 'jobs.ts', 'events.ts', 'stack-events.ts', 'deployment-resources.ts',
  'deploy-links.ts', 'custom-domains.ts', 'core.ts', 'common.ts', 'auth.ts', 'index.ts',
]);

// Root files whose change falls back to the full safe suite
const ROOT_CONFIG = [
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^turbo\.json$/,
  /^vitest\.config\.ts$/,
  /^playwright\.config\.ts$/,
  /^tsconfig\.base\.json$/,
  /^eslint\.config\.mjs$/,
  /^\.github\/workflows\//,
  /^scripts\/e2e\.mjs$/,
  /^scripts\/e2e-env\.mjs$/,
  /^scripts\/test-affected\.mjs$/,
  /^scripts\/test-affected\.test\.mjs$/,
  /^\.env/,
];

// Documentation and non-executable text → minimal gate
const DOC_FILE = [
  /^docs\//,
  /\.md$/i,
  /\.txt$/,
  /\.png$/,
  /^LICENSE$/,
  /^\.gitignore$/,
  /^\.gitattributes$/,
  /^\.editorconfig$/,
];

// packages/<dir> → workspace package (verified from package manifests)
const UNIT_PACKAGES = {
  'contracts': '@deployz/contracts',
  'db': '@deployz/db',
  'copy-map': '@deployz/copy-map',
  'fixture': '@deployz/fixture',
  'analysis': '@deployz/analysis',
  'relay': '@deployz/relay',
  'cdk': '@deployz/cdk',
};

// scripts/<dir> test projects (run with vitest inside the directory)
const SCRIPT_UNITS = {
  'version-canary': 'scripts/version-canary',
  'repository-compatibility': 'scripts/repository-compatibility',
  'repository-deployment': 'scripts/repository-deployment',
};

// Whole-file specs the CI simulated job runs in one consolidated invocation
const PR_CORE_SPECS = ['e2e/e2e-modes.spec.ts', 'e2e/admin.spec.ts', 'e2e/deployment-detail.spec.ts'];

// ── Helpers ──────────────────────────────────────────────────────────────────

function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: opts.cwd ?? process.cwd(), encoding: 'utf8', ...opts });
  if (r.error) throw new Error(`git ${args[0]}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || `exit ${r.status}`}`);
  return r.stdout.trim().split('\n').filter(Boolean);
}

function toForwardSlash(p) { return p.split(sep).join('/'); }

// ── Change collection ────────────────────────────────────────────────────────

// Returns { files } on success or { error } — callers turn error into the
// full-safe-suite fallback instead of silently diffing against the wrong base.
export function collectChangedFiles(cwd, baseRef) {
  try {
    let base;
    if (baseRef) {
      base = git(['merge-base', 'HEAD', baseRef], { cwd })[0];
      if (!base) return { error: `no merge-base with ${baseRef}` };
    } else {
      base = git(['merge-base', 'HEAD', 'origin/main'], { cwd })[0];
      if (!base) return { error: 'origin/main is not available' };
    }
    const committed = git(['diff', '--name-only', `${base}...HEAD`], { cwd });
    const unstaged = git(['diff', '--name-only'], { cwd });
    const staged = git(['diff', '--name-only', '--cached'], { cwd });
    const all = [...new Set([...committed, ...unstaged, ...staged])].filter(Boolean);
    return { files: all.map(toForwardSlash) };
  } catch (e) {
    return { error: e.message };
  }
}

// ── Mapping rules ────────────────────────────────────────────────────────────

function classifyPackage(dir, f, base, isTest, layers) {
  switch (dir) {
    case 'contracts': {
      if (!isTest && f.startsWith('packages/contracts/src/') && CONTRACTS_CRITICAL.has(base)) {
        layers.criticalReasons.push(`deployment contract schema changed: ${f}`);
        break;
      }
      // Verified direct consumers of @deployz/contracts
      for (const p of ['@deployz/api', '@deployz/web', '@deployz/analysis', '@deployz/db', '@deployz/relay', '@deployz/cdk']) {
        layers.unitPackages.add(p);
      }
      break;
    }
    case 'db': {
      layers.unitPackages.add('@deployz/api'); // the API consumes the db contracts
      const schema = /^packages\/db\/src\/schema\/([^/]+)$/.exec(f);
      if (f.startsWith('packages/db/drizzle/')) {
        layers.criticalReasons.push(`database migration changed: ${f}`);
      } else if (schema && !isTest && DB_CRITICAL_SCHEMA.has(schema[1])) {
        layers.criticalReasons.push(`database persisted-state schema changed: ${f}`);
      } else if (schema && schema[1] === 'billing.ts') {
        layers.specFiles.add('e2e/billing.spec.ts');
      }
      break;
    }
    case 'fixture': {
      if (!isTest && f.startsWith('packages/fixture/src/')) {
        // The fixture server backs every simulated scenario
        layers.criticalReasons.push(`fixture server changed (backs every simulated scenario): ${f}`);
      }
      break;
    }
    case 'analysis': {
      layers.unitPackages.add('@deployz/api'); // the API consumes analysis
      break;
    }
    case 'relay': {
      if (RELAY_AWS_INTERFACE.has(base)) {
        layers.criticalReasons.push(`relay AWS executor changed: ${f}`);
        layers.awsEscalation.add('pnpm e2e:canary');
      } else if (!isTest && RELAY_PROTOCOL.has(base)) {
        layers.criticalReasons.push(`relay protocol core changed: ${f}`);
      } else {
        for (const m of SCENARIO_MAP) {
          if (m.files.some(p => p.test(f))) m.ids.forEach(id => layers.scenarios.add(id));
        }
        if (/lifecycle|provision/.test(f) && !isTest) {
          layers.criticalReasons.push(`relay lifecycle area changed: ${f}`);
        }
      }
      break;
    }
    case 'cdk': {
      if (CDK_PROVISIONING_PATTERNS.some(p => p.test(f))) {
        layers.criticalReasons.push(`CDK provisioning semantics changed: ${f}`);
        layers.awsEscalation.add('pnpm e2e:canary');
        layers.awsEscalation.add('pnpm e2e:fresh');
      }
      break;
    }
  }
}

function classify(f, layers) {
  const base = f.split('/').pop();
  const isTest = /\.test\.[tjm]sx?$/.test(base);
  let matched = false;

  if (ROOT_CONFIG.some(p => p.test(f))) {
    layers.criticalReasons.push(`root configuration changed (full safe suite): ${f}`);
    return;
  }

  if (f.startsWith('apps/web/')) {
    matched = true;
    layers.unitPackages.add('@deployz/web');
    if (!f.startsWith('apps/web/test/')) {
      // No reliable file→spec mapping exists for web runtime code, so the
      // full non-visual Playwright PR suite runs — reported as targeted-web,
      // never as targeted specs.
      layers.fullPlaywright = true;
    }
  }

  if (f.startsWith('apps/api/')) {
    matched = true;
    layers.unitPackages.add('@deployz/api');
    if (f.startsWith('apps/api/src/admin/')) layers.specFiles.add('e2e/admin.spec.ts');
    if (!isTest && f.startsWith('apps/api/src/') && API_CRITICAL.has(base)) {
      layers.criticalReasons.push(`API deployment-critical file changed: ${f}`);
    }
  }

  const pkg = /^packages\/([^/]+)\//.exec(f);
  if (pkg) {
    const dir = pkg[1];
    if (dir === 'copy-map') {
      matched = true; // consumers of @deployz/copy-map
      layers.unitPackages.add('@deployz/web');
      layers.unitPackages.add('@deployz/api');
    } else if (UNIT_PACKAGES[dir]) {
      matched = true;
      layers.unitPackages.add(UNIT_PACKAGES[dir]);
      classifyPackage(dir, f, base, isTest, layers);
    }
    // Unknown package directory: matched stays false → full safe suite below.
  }

  const script = /^scripts\/([^/]+)\//.exec(f);
  if (script) {
    const dir = script[1];
    if (SCRIPT_UNITS[dir]) {
      matched = true;
      layers.scriptUnits.add(dir);
      layers.typecheckScripts = true;
    } else if (dir === 'customer-reset') {
      matched = true; // AWS harness: typecheck pre-merge, canary as escalation
      layers.typecheckScripts = true;
      layers.awsEscalation.add('pnpm e2e:canary');
    }
  }

  if (f.startsWith('e2e/')) {
    matched = true;
    if (f.startsWith('e2e/simulation/')) {
      // The simulation harness defines every scenario's behaviour
      layers.criticalReasons.push(`e2e simulation harness changed: ${f}`);
    } else if (/\.spec\.ts$/.test(f) && !f.endsWith('e2e/visual.spec.ts')) {
      layers.specFiles.add(f);
    }
  }

  if (!matched) {
    layers.criticalReasons.push(`unknown executable path (full safe suite): ${f}`);
  }
}

// ── Plan assembly ────────────────────────────────────────────────────────────

// files === null means change detection failed → full safe suite.
export function planFromFiles(files) {
  const layers = {
    unitPackages: new Set(),
    scriptUnits: new Set(),
    scenarios: new Set(),
    specFiles: new Set(),
    fullPlaywright: false,
    e2eScenarios: false,
    defaultHttps: false,
    typecheckScripts: false,
    awsEscalation: new Set(),
    criticalReasons: [],
    fallbackReasons: [],
  };

  if (files === null) {
    layers.fallbackReasons.push('change detection failed');
    return finalize(layers, 0);
  }

  const list = files.map(toForwardSlash);
  let docOnly = true;
  for (const f of list) {
    if (DOC_FILE.some(p => p.test(f))) continue;
    docOnly = false;
    classify(f, layers);
  }

  if (docOnly) layers.minimalReason = list.length === 0
    ? 'no changed files detected'
    : 'documentation-only change';
  return finalize(layers, list.length);
}

function finalize(layers, fileCount) {
  const critical = layers.criticalReasons.length > 0 || layers.fallbackReasons.length > 0;
  let risk;
  if (critical) {
    risk = 'critical';
    layers.e2eScenarios = true;
    layers.defaultHttps = true;
    layers.typecheckScripts = true;
    for (const s of PR_CORE_SPECS) layers.specFiles.add(s);
  } else if (layers.minimalReason) {
    risk = 'minimal';
  } else if (layers.fullPlaywright) {
    risk = 'targeted-web';
    layers.e2eScenarios = true;
    layers.defaultHttps = true;
    for (const s of PR_CORE_SPECS) layers.specFiles.add(s);
  } else {
    risk = 'targeted';
  }

  const reasons = [...layers.criticalReasons];
  if (layers.minimalReason) reasons.push(layers.minimalReason);
  if (risk === 'targeted-web') reasons.push('web runtime change: full non-visual Playwright PR suite (no reliable file-to-spec mapping)');

  return {
    ok: true,
    risk,
    fallback: layers.fallbackReasons.length > 0,
    fallbackReasons: [...layers.fallbackReasons],
    reasons,
    changedFileCount: fileCount,
    lintAll: risk === 'critical',
    typecheckScripts: layers.typecheckScripts,
    unitPackages: [...layers.unitPackages].sort(),
    scriptUnits: [...layers.scriptUnits].sort(),
    playwrightFiles: [...layers.specFiles].sort(),
    scenarioIds: layers.e2eScenarios ? 'ALL' : [...layers.scenarios].sort(),
    e2eScenarios: layers.e2eScenarios,
    defaultHttps: layers.defaultHttps,
    awsEscalation: [...layers.awsEscalation].sort().map(c => `DEPLOYZ_E2E_ALLOW_REAL_AWS=1 ${c}`),
  };
}

// ── Commands (mirrored by CI; --run executes only these) ─────────────────────

export function commandsFor(plan) {
  const cmds = [];
  if (plan.risk === 'minimal') return cmds;

  if (plan.risk === 'critical') {
    cmds.push({ label: 'full unit suite', cmd: 'pnpm', args: ['vitest', 'run'] });
  } else {
    // One invocation from the workspace root runs the selected projects in
    // parallel (the scripts/* harnesses are root projects too); CI mirrors
    // this. A per-project loop would serialise them.
    const projects = [...plan.unitPackages, ...plan.scriptUnits];
    if (projects.length > 0) {
      cmds.push({ label: `unit ${projects.join(' ')}`, cmd: 'pnpm', args: ['vitest', 'run', ...projects.flatMap(p => ['--project', p])] });
    }
  }
  if (plan.typecheckScripts) {
    cmds.push({ label: 'typecheck AWS harnesses', cmd: 'pnpm', args: ['typecheck:scripts'] });
  }
  if (plan.playwrightFiles.length > 0) {
    cmds.push({ label: 'Playwright specs', cmd: 'node', args: ['scripts/e2e.mjs', ...plan.playwrightFiles] });
  }
  if (plan.scenarioIds === 'ALL') {
    cmds.push({ label: 'full simulated scenario suite', cmd: 'node', args: ['scripts/e2e.mjs', '--scenarios'] });
  } else {
    for (const id of plan.scenarioIds) {
      cmds.push({ label: `scenario ${id}`, cmd: 'node', args: ['scripts/e2e.mjs', `--scenario=${id}`] });
    }
  }
  if (plan.defaultHttps) {
    cmds.push({ label: 'default-HTTPS scenarios', cmd: 'node', args: ['scripts/e2e.mjs', 'e2e/scenario-default-https.spec.ts'], env: { DEPLOYZ_DEFAULT_HTTPS_FIXTURE: 'true' } });
  }
  return cmds;
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
    const groups = {};
    for (const f of files) {
      const dir = f.includes('/') ? f.split('/').slice(0, -1).join('/') : '(root)';
      (groups[dir] ??= []).push(f.split('/').pop());
    }
    for (const [dir, items] of Object.entries(groups)) {
      console.log(`  ${dir}/ (${items.length} file${items.length > 1 ? 's' : ''})`);
      for (const item of items.slice(0, 5)) console.log(`    ${item}`);
      if (items.length > 5) console.log(`    ... and ${items.length - 5} more`);
    }
  }
  console.log();
}

function printPlan(plan) {
  console.log(`${BOLD}Risk level:${RESET} ${plan.risk}`);
  if (plan.fallbackReasons.length > 0) {
    console.log(`${YELLOW}Fail-safe engaged:${RESET}`);
    for (const r of plan.fallbackReasons) console.log(`  ${r}`);
  }
  for (const r of plan.reasons) console.log(`  reason: ${r}`);
  console.log(`\n${BOLD}Required:${RESET}`);
  let has = false;
  if (plan.risk === 'minimal') {
    console.log(`  ${YELLOW}(minimal gate — no executable layers for documentation-only changes)${RESET}`);
  } else {
    console.log(`  ${GREEN}✓${RESET} build workspace packages (turbo cache): pnpm build`);
    if (plan.risk === 'critical') console.log(`  ${GREEN}✓${RESET} full unit suite: pnpm vitest run`);
    if (plan.risk !== 'critical' && plan.unitPackages.length + plan.scriptUnits.length === 0 && plan.risk !== 'targeted-web') {
      console.log(`  ${YELLOW}(no unit layers mapped)${RESET}`);
    }
    has = true;
  }
  for (const c of commandsFor(plan)) {
    console.log(`  ${GREEN}✓${RESET} ${c.label}: ${c.cmd} ${(c.args ?? []).join(' ')}${c.env ? ` (env ${Object.entries(c.env).map(([k, v]) => `${k}=${v}`).join(' ')})` : ''}`);
    has = true;
  }
  if (plan.lintAll) console.log(`  ${GREEN}✓${RESET} lint workspace: pnpm lint`);
  else if (plan.risk !== 'minimal' && plan.unitPackages.length > 0) console.log(`  ${GREEN}✓${RESET} lint affected: pnpm turbo run lint --filter=${plan.unitPackages.join(' --filter=')}`);
  if (plan.typecheckScripts) console.log(`  ${GREEN}✓${RESET} typecheck AWS harnesses: pnpm typecheck:scripts`);
  if (!has && plan.risk !== 'minimal') {
    console.log(`  ${YELLOW}(none — no mapped test layers triggered)${RESET}`);
  }
  console.log(`\n${BOLD}Not required:${RESET}`);
  if (!plan.e2eScenarios) console.log(`  ${RED}✗${RESET} full simulated suite`);
  console.log(`  ${RED}✗${RESET} fresh AWS (provisioning only — pnpm e2e:fresh)`);
  console.log(`  ${RED}✗${RESET} full-product canary (escalation only)`);
  if (plan.awsEscalation.length > 0) {
    console.log(`\n${BOLD}AWS escalation (manual only, never run by --run or CI):${RESET}`);
    for (const c of plan.awsEscalation) console.log(`  ${YELLOW}${c}${RESET}`);
  }
}

// ── Escalation mode ──────────────────────────────────────────────────────────

function printEscalation(plan) {
  console.log(`${BOLD}AWS Escalation Assessment${RESET}\n`);
  const triggering = plan.reasons.filter(r => /relay AWS executor|CDK provisioning/.test(r));
  if (plan.awsEscalation.length === 0) {
    console.log('  No AWS layer requirements detected for the current changes.\n');
    console.log('  Real AWS is an escalation, not the debugging loop. Run targeted');
    console.log('  vitest and simulated E2E scenarios first.');
    return;
  }
  console.log('  Required AWS layers:');
  for (const r of triggering.length > 0 ? triggering : plan.reasons) console.log(`    • ${r}`);
  console.log();
  for (const c of plan.awsEscalation) {
    console.log(`  ${c}`);
  }
  console.log();
  console.log(`${BOLD}⚠  Reminder:${RESET} real AWS is an escalation, not the debugging loop.`);
  console.log('   Run targeted vitest and simulated E2E scenarios first. Copy these');
  console.log('   commands manually — --run will not execute them.');
  console.log(`   Set ${YELLOW}DEPLOYZ_E2E_ALLOW_REAL_AWS=1${RESET} in your shell before running.`);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const out = { run: false, filesOverride: null, base: null, format: 'text', escalation: false, githubOutput: false, invalid: [] };
  for (const arg of argv) {
    if (arg === '--run') out.run = true;
    else if (arg.startsWith('--files=')) out.filesOverride = arg.slice('--files='.length).split(/[, ]+/).map(s => s.trim()).filter(Boolean);
    else if (arg.startsWith('--base=')) out.base = arg.slice('--base='.length);
    else if (arg === '--format=json' || arg === '--json') out.format = 'json';
    else if (arg === '--format=text') out.format = 'text';
    else if (arg === '--escalation') out.escalation = true;
    else if (arg === '--github-output') out.githubOutput = true;
    else out.invalid.push(arg);
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.invalid.length > 0) {
    console.error(`Unknown argument(s): ${opts.invalid.join(' ')}\nUsage: test-affected.mjs [--base=<ref>] [--files=<csv>] [--format=json] [--run] [--escalation]`);
    process.exit(1);
  }

  let files;
  let detectionError = null;
  if (opts.filesOverride) {
    files = opts.filesOverride;
  } else {
    const r = collectChangedFiles(process.cwd(), opts.base);
    if (r.error) detectionError = r.error;
    else files = r.files;
  }

  const plan = planFromFiles(detectionError ? null : files);
  if (detectionError) console.error(`Warning: change detection failed (${detectionError}); selected the full safe suite.`);

  if (opts.githubOutput) {
    const outPath = process.env.GITHUB_OUTPUT;
    if (!outPath) {
      console.error('--github-output requires the GITHUB_OUTPUT step-output path (GitHub Actions).');
      process.exit(1);
    }
    if (!plan.ok || (plan.fallback && plan.risk !== 'critical')) {
      console.error(`Refusing to publish an invalid plan: ok=${plan.ok} fallback=${plan.fallback} risk=${plan.risk}`);
      process.exit(1);
    }
    const set = (k, v) => appendFileSync(outPath, `${k}=${v}\n`);
    set('risk', plan.risk);
    set('unit_packages', plan.unitPackages.join(' '));
    set('script_units', plan.scriptUnits.join(' '));
    set('playwright_files', plan.playwrightFiles.join(' '));
    set('scenario_ids', plan.scenarioIds === 'ALL' ? 'ALL' : plan.scenarioIds.join(' '));
    set('default_https', String(plan.defaultHttps));
    set('typecheck_scripts', String(plan.typecheckScripts));
  }

  if (opts.format === 'json') {
    console.log(JSON.stringify(plan));
  } else {
    printChanged(files ?? []);
    printPlan(plan);
  }
  if (opts.escalation) {
    if (opts.format === 'json') console.log(JSON.stringify({ awsEscalation: plan.awsEscalation, reasons: plan.reasons }));
    else printEscalation(plan);
    process.exit(0);
  }
  if (detectionError) process.exit(0); // fallback plan emitted; CI gates on its validity

  if (opts.run) {
    console.log(`\n${BOLD}Executing simulated layers...${RESET}\n`);
    const commands = commandsFor(plan);
    if (plan.risk !== 'minimal') {
      const build = { label: 'build', cmd: 'pnpm', args: ['build'] };
      commands.unshift(build);
    }
    if (commands.length === 0) {
      console.log('  No simulated layers to execute.');
      process.exit(0);
    }
    for (const c of commands) {
      const dir = c.cwd ? relative(process.cwd(), c.cwd) : '.';
      console.log(`  ${YELLOW}>${RESET} ${c.cmd} ${c.args.join(' ')}  (in ${dir})`);
      const result = spawnSync(c.cmd, c.args, {
        cwd: c.cwd ? `${process.cwd()}/${c.cwd}` : process.cwd(),
        stdio: 'inherit',
        shell: true,
        env: { ...process.env, ...c.env },
      });
      if (result.status !== 0) {
        console.error(`\n  Command failed with exit code ${result.status}, aborting.`);
        process.exit(result.status ?? 1);
      }
    }
    if (plan.awsEscalation.length > 0) {
      console.log(`\n  ${YELLOW}Skipped AWS commands (must be run manually):${RESET}`);
      for (const c of plan.awsEscalation) console.log(`    ${c}`);
      console.log(`  ${BOLD}Real AWS is an escalation, not the debugging loop.${RESET}`);
    }
    console.log(`\n  ${GREEN}All simulated layers passed.${RESET}`);
  }
}

const isCli = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isCli) main();
