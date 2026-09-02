import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

// §24 production-safety guards. These are ADDITIVE to e2e/e2e-modes.spec.ts,
// which already covers: default mode is simulated, canary/fresh require the
// real-AWS opt-in, and simulated mode scrubs AWS credentials. This file pins
// the remaining §24 properties — all of them true "by construction" per
// docs/testing/discovery/phase1-design-decisions.md D1/D2/D3 — as static
// regression guards, so a future change can't quietly reintroduce a
// production-facing scenario-control surface, a leaked fixture-mode env var,
// a real AWS SDK dependency in the simulator, or a product-code import of
// test-only code.
//
// Deliberately browserless: no `page` fixture is used anywhere in this file,
// only plain `fetch` and filesystem reads — none of these properties need a
// browser to observe.

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

function listFiles(dir: string, extensions: readonly string[], skipDirs: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full, extensions, skipDirs));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

// ---------------------------------------------------------------------------
// D2: "production cannot expose scenario controls" is true by construction —
// scenario selection happens entirely in the test process (a Playwright
// fixture), and the API defines no scenario-control endpoint at all. Asserts
// the absence directly against the real running API, plus a couple of
// plausible variant paths, so the property stays pinned if anyone is ever
// tempted to add one "just for E2E convenience".
// ---------------------------------------------------------------------------

const SCENARIO_CONTROL_PATHS = [
  '/internal/e2e/scenario',
  '/api/internal/e2e/scenario',
  '/__e2e__/scenario',
  '/internal/scenario',
];

for (const scenarioPath of SCENARIO_CONTROL_PATHS) {
  test(`GET ${scenarioPath} does not exist (D2: no scenario-control surface)`, async () => {
    const response = await fetch(`${API_URL}${scenarioPath}`);
    expect(response.status).toBe(404);
  });

  test(`POST ${scenarioPath} does not exist (D2: no scenario-control surface)`, async () => {
    const response = await fetch(`${API_URL}${scenarioPath}`, { method: 'POST' });
    expect(response.status).toBe(404);
  });
}

// ---------------------------------------------------------------------------
// D1: "the simulator cannot construct a real AWS client because it never
// imports the AWS SDK" — verified file-by-file rather than trusting the
// module comments. Type-only imports from `@deployz/relay/*` are the allowed
// pattern for pulling in the relay's client-interface shapes; a VALUE import
// from `@aws-sdk/*` would mean the simulator could actually construct a real
// client, which is exactly what this guards against.
// ---------------------------------------------------------------------------

const AWS_SDK_IMPORT = /import\s+(type\s+)?[\s\S]*?from\s+['"](@aws-sdk\/[^'"]+)['"]/g;

test('no file under e2e/simulation/ has a value import from @aws-sdk/* (D1)', () => {
  const simulationDir = path.join(REPO_ROOT, 'e2e', 'simulation');
  const offenders: string[] = [];
  for (const file of listFiles(simulationDir, ['.ts', '.tsx'], new Set())) {
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(AWS_SDK_IMPORT)) {
      const isTypeOnly = match[1] !== undefined;
      if (!isTypeOnly) {
        const line = lineOf(content, match.index ?? 0);
        offenders.push(`${path.relative(REPO_ROOT, file)}:${line} — value import of "${match[2]}"`);
      }
    }
  }
  expect(offenders, `AWS SDK value imports found:\n${offenders.join('\n')}`).toEqual([]);
});

// ---------------------------------------------------------------------------
// The deploy workflow's job-level `env:` block becomes the deployed Lambda's
// ENTIRE environment (packages/cdk's collectEnvVars builds it from exactly
// what's present there) — so a fixture-mode variable's absence here is its
// absence in production, and its presence here would mean it ships live. This
// guards the workflow file text directly rather than the runtime, since the
// runtime has no way to observe what CI would have injected.
// ---------------------------------------------------------------------------

const FIXTURE_ENV_VARS = [
  'GITHUB_FIXTURE_MODE',
  'AI_FIXTURE_MODE',
  'DOMAIN_FIXTURE_MODE',
  'BUILD_FIXTURE_MODE',
  'DEPLOYZ_E2E_MODE',
  'DEPLOYZ_E2E_SCENARIO',
];

test('deploy-api.yml deployed-environment block sets none of the fixture-mode vars (D2/D3)', () => {
  const workflowPath = path.join(REPO_ROOT, '.github', 'workflows', 'deploy-api.yml');
  // Normalise line endings first — this file is checked out CRLF on Windows.
  const content = readFileSync(workflowPath, 'utf8').replace(/\r\n/g, '\n');

  const envStart = content.indexOf('\n    env:\n');
  const envEnd = content.indexOf('\n    steps:\n', envStart);
  expect(envStart, 'could not locate the job-level env: block in deploy-api.yml').toBeGreaterThan(-1);
  expect(envEnd, 'could not locate the steps: block after env: in deploy-api.yml').toBeGreaterThan(envStart);
  const envBlock = content.slice(envStart, envEnd);

  const present = FIXTURE_ENV_VARS.filter((name) => new RegExp(`\\b${name}\\b`).test(envBlock));
  expect(present, `fixture-mode vars leaked into the deploy env block: ${present.join(', ')}`).toEqual([]);
});

// ---------------------------------------------------------------------------
// D2: the simulator is test-only "by construction" — verify nothing under
// product code (apps/, packages/) actually reaches into e2e/. A pragmatic
// text-pattern check (not a full module-resolution walk), matching the two
// ways test-only code could be pulled in: an ES import or a require().
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.turbo', 'coverage', 'cdk.out']);
const IMPORT_FROM_E2E = /from\s+['"][^'"]*\be2e\/simulation[^'"]*['"]/;
const REQUIRE_FROM_E2E = /require\(\s*['"][^'"]*\be2e\/[^'"]*['"]\s*\)/;

test('no file under apps/ or packages/ imports from e2e/ (D2: test-only boundary)', () => {
  const offenders: string[] = [];
  for (const root of ['apps', 'packages']) {
    for (const file of listFiles(
      path.join(REPO_ROOT, root),
      ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
      SKIP_DIRS,
    )) {
      const content = readFileSync(file, 'utf8');
      if (IMPORT_FROM_E2E.test(content) || REQUIRE_FROM_E2E.test(content)) {
        offenders.push(path.relative(REPO_ROOT, file));
      }
    }
  }
  expect(offenders, `product code importing from e2e/:\n${offenders.join('\n')}`).toEqual([]);
});
