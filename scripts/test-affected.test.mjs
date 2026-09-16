// Selector tests for scripts/test-affected.mjs — run with:
//   node --test scripts/test-affected.test.mjs   (or: pnpm test:selector)
// Node's built-in runner keeps this out of the root Vitest project list.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { collectChangedFiles, commandsFor, parseArgs, planFromFiles } from './test-affected.mjs';

const plan = (files) => planFromFiles(files);
const CORE_SPECS = ['e2e/admin.spec.ts', 'e2e/deployment-detail.spec.ts', 'e2e/e2e-modes.spec.ts'];

test('1. documentation-only change selects the minimal gate', () => {
  const p = plan(['README.md', 'docs/testing/e2e-testing.md', 'AGENTS.md']);
  assert.equal(p.risk, 'minimal');
  assert.deepEqual(commandsFor(p), []);
});

test('2. web-only component change selects web unit plus the full Playwright PR suite', () => {
  const p = plan(['apps/web/components/deployment-hero.tsx']);
  assert.equal(p.risk, 'targeted-web');
  assert.deepEqual(p.unitPackages, ['@deployz/web']);
  assert.deepEqual(p.playwrightFiles, CORE_SPECS);
  assert.equal(p.scenarioIds, 'ALL');
  assert.equal(p.defaultHttps, true);
  // Honest label: the full suite is reported as such, never as targeted specs.
  assert.ok(p.reasons.some(r => r.includes('full non-visual Playwright PR suite')));
});

test('2b. web test-only change stays targeted without Playwright', () => {
  const p = plan(['apps/web/test/home-state.test.ts']);
  assert.equal(p.risk, 'targeted');
  assert.deepEqual(p.unitPackages, ['@deployz/web']);
  assert.deepEqual(p.scenarioIds, []);
  assert.equal(p.e2eScenarios, false);
  assert.equal(p.defaultHttps, false);
});

test('3. API-only non-lifecycle change stays targeted', () => {
  const p = plan(['apps/api/src/billing-portal.ts']);
  assert.equal(p.risk, 'targeted');
  assert.deepEqual(p.unitPackages, ['@deployz/api']);
  assert.equal(p.e2eScenarios, false);
  assert.deepEqual(p.playwrightFiles, []);
});

test('3b. API admin change adds the Team Admin spec', () => {
  const p = plan(['apps/api/src/admin/admin-actions.ts']);
  assert.equal(p.risk, 'targeted');
  assert.deepEqual(p.playwrightFiles, ['e2e/admin.spec.ts']);
});

test('4. API lifecycle change is critical with the full pre-merge set', () => {
  const p = plan(['apps/api/src/manifest.ts']);
  assert.equal(p.risk, 'critical');
  assert.equal(p.e2eScenarios, true);
  assert.equal(p.defaultHttps, true);
  assert.deepEqual(p.playwrightFiles, CORE_SPECS);
  const cmds = commandsFor(p);
  assert.ok(cmds.some(c => c.label === 'full unit suite'));
});

test('5. contract change fans out to every verified consumer', () => {
  const critical = plan(['packages/contracts/src/manifest.ts']);
  assert.equal(critical.risk, 'critical');

  const targeted = plan(['packages/contracts/src/application-analysis.ts']);
  assert.equal(targeted.risk, 'targeted');
  for (const pkg of ['@deployz/contracts', '@deployz/api', '@deployz/web', '@deployz/analysis', '@deployz/db', '@deployz/relay', '@deployz/cdk']) {
    assert.ok(targeted.unitPackages.includes(pkg), `${pkg} missing from consumer fan-out`);
  }
});

test('6. DB schema or migration change is critical; billing schema targets the billing spec', () => {
  assert.equal(plan(['packages/db/src/schema/deployments.ts']).risk, 'critical');
  assert.equal(plan(['packages/db/drizzle/0040_next.sql']).risk, 'critical');

  const billing = plan(['packages/db/src/schema/billing.ts']);
  assert.equal(billing.risk, 'targeted');
  assert.ok(billing.unitPackages.includes('@deployz/db'));
  assert.ok(billing.unitPackages.includes('@deployz/api'));
  assert.ok(billing.playwrightFiles.includes('e2e/billing.spec.ts'));
});

test('7. relay lifecycle change is critical; other relay files stay targeted with scenarios', () => {
  assert.equal(plan(['packages/relay/src/commands.ts']).risk, 'critical');

  const targeted = plan(['packages/relay/src/auth.ts']);
  assert.equal(targeted.risk, 'targeted');
  assert.deepEqual(targeted.unitPackages, ['@deployz/relay']);
});

test('8. CDK provisioning change is critical with reported escalations', () => {
  const p = plan(['packages/cdk/bootstrap/stack.ts']);
  assert.equal(p.risk, 'critical');
  assert.ok(p.awsEscalation.some(c => c.includes('pnpm e2e:canary')));
  assert.ok(p.awsEscalation.some(c => c.includes('pnpm e2e:fresh')));

  assert.equal(plan(['packages/cdk/src/constructs.ts']).risk, 'targeted');
});

test('9. root package or lockfile change falls back to the full safe suite', () => {
  for (const f of ['pnpm-lock.yaml', 'package.json', 'turbo.json', 'vitest.config.ts', 'playwright.config.ts', 'pnpm-workspace.yaml']) {
    const p = plan([f]);
    assert.equal(p.risk, 'critical', f);
    assert.ok(p.reasons.some(r => r.includes('root configuration')));
  }
});

test('10. GitHub workflow change falls back to the full safe suite', () => {
  const p = plan(['.github/workflows/ci.yml']);
  assert.equal(p.risk, 'critical');
  assert.equal(p.e2eScenarios, true);
});

test('11. unknown executable path selects the full safe suite, never zero tests', () => {
  const p = plan(['packages/new-package/src/index.ts', 'mystery-dir/tool.ts']);
  assert.equal(p.risk, 'critical');
  assert.ok(p.reasons.some(r => r.includes('unknown executable path')));
  assert.equal(p.e2eScenarios, true);
});

test('12. failed or missing base reference falls back to the full safe suite', () => {
  const r = collectChangedFiles(process.cwd(), 'definitely-not-a-ref');
  assert.ok(r.error, 'expected a detection error for a bogus base ref');

  const p = planFromFiles(null);
  assert.equal(p.risk, 'critical');
  assert.equal(p.fallback, true);
  assert.ok(p.fallbackReasons.includes('change detection failed'));
  assert.equal(p.e2eScenarios, true);
});

test('13. multiple changed areas combine layers and keep the highest risk', () => {
  const p = plan(['apps/web/test/home-state.test.ts', 'packages/relay/src/deploy.ts', 'docs/x.md']);
  assert.equal(p.risk, 'critical');
  assert.ok(p.unitPackages.includes('@deployz/web'));
  assert.ok(p.unitPackages.includes('@deployz/relay'));
});

test('14. real AWS escalation is reported but never executed', () => {
  const p = plan(['packages/relay/src/deploy.ts']);
  assert.ok(p.awsEscalation.length > 0);
  for (const c of commandsFor(p)) {
    const rendered = `${c.cmd} ${(c.args ?? []).join(' ')}`;
    assert.ok(!rendered.includes('canary'), `AWS command leaked into execution: ${rendered}`);
    assert.ok(!rendered.includes('fresh'), `AWS command leaked into execution: ${rendered}`);
    assert.ok(!rendered.includes('DEPLOYZ_E2E_ALLOW_REAL_AWS'), 'real-AWS opt-in leaked into execution');
  }
});

test('15. fixture or simulation-harness change selects the full simulated regression', () => {
  assert.equal(plan(['packages/fixture/src/server.ts']).risk, 'critical');
  assert.equal(plan(['e2e/simulation/simulated-account.ts']).risk, 'critical');
  assert.equal(plan(['packages/fixture/src/server.test.ts']).risk, 'targeted');
});

test('CLI: --format=json emits a parseable plan for a docs-only list', () => {
  const result = run(['--files=README.md,docs/a.md', '--format=json']);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.risk, 'minimal');
  assert.equal(parsed.ok, true);
});

test('CLI: unknown flag exits non-zero', () => {
  const result = run(['--bogus']);
  assert.notEqual(result.status, 0);
});

test('CLI: bogus --base reports the fallback plan and stays exit 0', () => {
  const result = run(['--base=definitely-not-a-ref', '--format=json']);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.risk, 'critical');
  assert.equal(parsed.fallback, true);
});

test('parseArgs: rejects unknown arguments, accepts the documented set', () => {
  assert.deepEqual(parseArgs(['--run']).invalid, []);
  assert.deepEqual(parseArgs(['--base=abc', '--files=x,y', '--format=json', '--escalation']).invalid, []);
  assert.deepEqual(parseArgs(['--nope']).invalid, ['--nope']);
});

test('CLI: --github-output publishes validated step outputs', () => {
  const outFile = path.join(os.tmpdir(), `gh-out-${process.pid}.txt`);
  writeFileSync(outFile, '');
  const result = run(['--files=README.md', '--format=json', '--github-output'], { GITHUB_OUTPUT: outFile });
  assert.equal(result.status, 0);
  const content = readFileSync(outFile, 'utf8');
  assert.ok(content.includes('risk=minimal\n'));
  assert.ok(content.includes('unit_packages=\n'));
});

test('CLI: --github-output without GITHUB_OUTPUT is invalid input', () => {
  const result = run(['--files=README.md', '--github-output'], { GITHUB_OUTPUT: undefined });
  assert.notEqual(result.status, 0);
});

function run(args, envOverrides = {}) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const env = { ...process.env, ...envOverrides };
  for (const [k, v] of Object.entries(envOverrides)) if (v === undefined) delete env[k];
  return spawnSync(process.execPath, [path.join(here, 'test-affected.mjs'), ...args], { encoding: 'utf8', env });
}
