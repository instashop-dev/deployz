// Static production-safety guards (docs/testing/simulated-e2e.md, decisions
// D1/D2/D3) — run with:
//   node --test scripts/production-safety.test.mjs   (or: pnpm test:static)
// No server and no browser: filesystem reads only, so every non-docs PR
// runs them in seconds. The one runtime property — the API defines no
// scenario-control route — lives in apps/api/src/server.test.ts.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function listFiles(dir, extensions, skipDirs) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, extensions, skipDirs));
    else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

// D1: the simulator cannot construct a real AWS client because it never
// value-imports the AWS SDK. Type-only imports of the relay's client
// interfaces are the allowed pattern.
const AWS_SDK_IMPORT = /import\s+(type\s+)?[\s\S]*?from\s+['"](@aws-sdk\/[^'"]+)['"]/g;

test('no file under e2e/simulation/ has a value import from @aws-sdk/* (D1)', () => {
  const offenders = [];
  for (const file of listFiles(path.join(REPO_ROOT, 'e2e', 'simulation'), ['.ts', '.tsx'], new Set())) {
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(AWS_SDK_IMPORT)) {
      if (match[1] === undefined) {
        offenders.push(`${path.relative(REPO_ROOT, file)}:${lineOf(content, match.index ?? 0)} — value import of "${match[2]}"`);
      }
    }
  }
  assert.deepEqual(offenders, [], `AWS SDK value imports found:\n${offenders.join('\n')}`);
});

// The deploy workflow's job-level env: block becomes the deployed Lambda's
// ENTIRE environment (collectEnvVars in packages/cdk), so a fixture-mode
// variable present there would ship live.
const FIXTURE_ENV_VARS = [
  'GITHUB_FIXTURE_MODE',
  'AI_FIXTURE_MODE',
  'DOMAIN_FIXTURE_MODE',
  'BUILD_FIXTURE_MODE',
  'BILLING_FIXTURE_MODE',
  'DEPLOYZ_DEFAULT_HTTPS_FIXTURE',
  'DEPLOYZ_E2E_MODE',
  'DEPLOYZ_E2E_SCENARIO',
];

test('deploy-api.yml deployed-environment block sets none of the fixture-mode vars (D2/D3)', () => {
  const content = readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'deploy-api.yml'), 'utf8').replace(/\r\n/g, '\n');
  const envStart = content.indexOf('\n    env:\n');
  const envEnd = content.indexOf('\n    steps:\n', envStart);
  assert.ok(envStart > -1, 'could not locate the job-level env: block in deploy-api.yml');
  assert.ok(envEnd > envStart, 'could not locate the steps: block after env: in deploy-api.yml');
  const envBlock = content.slice(envStart, envEnd);
  const present = FIXTURE_ENV_VARS.filter((name) => new RegExp(`\\b${name}\\b`).test(envBlock));
  assert.deepEqual(present, [], `fixture-mode vars leaked into the deploy env block: ${present.join(', ')}`);
});

// D2: the simulator is test-only — nothing under apps/ or packages/ reaches
// into e2e/ (an ES import or a require()).
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.turbo', 'coverage', 'cdk.out']);
const IMPORT_FROM_E2E = /from\s+['"][^'"]*\be2e\/simulation[^'"]*['"]/;
const REQUIRE_FROM_E2E = /require\(\s*['"][^'"]*\be2e\/[^'"]*['"]\s*\)/;

test('no file under apps/ or packages/ imports from e2e/ (D2: test-only boundary)', () => {
  const offenders = [];
  for (const root of ['apps', 'packages']) {
    for (const file of listFiles(path.join(REPO_ROOT, root), ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'], SKIP_DIRS)) {
      const content = readFileSync(file, 'utf8');
      if (IMPORT_FROM_E2E.test(content) || REQUIRE_FROM_E2E.test(content)) offenders.push(path.relative(REPO_ROOT, file));
    }
  }
  assert.deepEqual(offenders, [], `product code importing from e2e/:\n${offenders.join('\n')}`);
});
