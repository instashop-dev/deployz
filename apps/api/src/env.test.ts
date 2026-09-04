import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Phase 1 Cloudflare runtime config. env.ts reads process.env once at import
// time and (via find-env-file.ts) dotenv-loads the nearest ancestor .env of
// process.cwd() — so assertions must not depend on a developer's own .env.
// Same isolation strategy as env-fixture-modes.test.ts: point process.cwd()
// at an empty temp dir before a fresh import, and delete the vars under test
// so a machine-wide export cannot leak into the default-value assertion.
const CLOUDFLARE_VARS = [
  'CLOUDFLARE_ZONE_ID',
  'CLOUDFLARE_ZONE_NAME',
  'DEPLOYZ_DEFAULT_HOSTNAME_PREFIX',
  'CLOUDFLARE_ZONE_EDIT_API_TOKEN',
];

describe('Cloudflare runtime config', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'deployz-env-cloudflare-'));
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
    for (const key of CLOUDFLARE_VARS) delete process.env[key];
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of CLOUDFLARE_VARS) delete process.env[key];
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('exposes the zone id, zone name and API token when set', async () => {
    process.env.CLOUDFLARE_ZONE_ID = 'test-zone';
    process.env.CLOUDFLARE_ZONE_NAME = 'example.test';
    process.env.CLOUDFLARE_ZONE_EDIT_API_TOKEN = 'test-token';

    const { env } = await import('./env.js');
    expect(env.cloudflareZoneId).toBe('test-zone');
    expect(env.cloudflareZoneName).toBe('example.test');
    expect(env.cloudflareZoneApiToken).toBe('test-token');
  });

  it('defaults the hostname prefix to d- when unset', async () => {
    const { env } = await import('./env.js');
    expect(env.defaultHostnamePrefix).toBe('d-');
  });

  it('honours an explicitly set hostname prefix', async () => {
    process.env.DEPLOYZ_DEFAULT_HOSTNAME_PREFIX = 'app-';

    const { env } = await import('./env.js');
    expect(env.defaultHostnamePrefix).toBe('app-');
  });

  // Server-only config: the Cloudflare zone id/token must never reach the
  // browser bundle. Anything under apps/web (src + root config files) that
  // names CLOUDFLARE — including a NEXT_PUBLIC_* inlining of it — is a leak.
  it('keeps Cloudflare out of apps/web entirely', () => {
    const webRoot = fileURLToPath(new URL('../../web', import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (['node_modules', '.next', '.turbo'].includes(entry.name)) continue;
          walk(full);
        } else if (
          entry.isFile() &&
          readFileSync(full, 'utf8').includes('CLOUDFLARE')
        ) {
          offenders.push(full);
        }
      }
    };
    walk(webRoot);
    expect(offenders).toEqual([]);
  });
});

// Phase 13 security guards — static scans over the workspace, mirroring the
// apps/web leak guard above. No network, no providers: pure filesystem reads.
describe('Phase 13 — zone id, token and probe provenance guards', () => {
  // apps/api/src is this file's directory; the workspace root is three levels up.
  const apiSrcRoot = fileURLToPath(new URL('.', import.meta.url));
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const ZONE_ID_HEX = 'bf69c0d8524ef2c5cfbc6e5d33fb7cae';

  const SKIP_DIRS = new Set(['node_modules', '.git', '.turbo', 'dist', '.next', '.slim', '.cache']);

  function filesUnder(dir: string, out: string[]): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        filesUnder(full, out);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }

  it('the production zone id hex never appears in any app/package/e2e source tree', () => {
    const offenders: string[] = [];
    for (const pattern of ['apps/*/src', 'apps/*/test', 'packages/*/src', 'packages/*/test', 'e2e']) {
      const segments = pattern.split('/');
      // Match 'apps/<name>/src' style globs by scanning each top dir's children.
      const top = join(repoRoot, segments[0]!);
      if (!(segments[0] === 'apps' || segments[0] === 'packages')) {
        // e2e — scan directly.
        const dir = join(repoRoot, pattern);
        if (existsSync(dir)) {
          const files: string[] = [];
          filesUnder(dir, files);
          for (const file of files) {
            // The guard's own fixture constants (this file) are not leaks.
            if (file.endsWith('.test.ts')) continue;
            if (readFileSync(file, 'utf8').includes(ZONE_ID_HEX)) offenders.push(relative(repoRoot, file));
          }
        }
        continue;
      }
      for (const child of readdirSync(top, { withFileTypes: true })) {
        if (!child.isDirectory()) continue;
        const dir = join(top, child.name, segments[2]!);
        if (!existsSync(dir)) continue;
        const files: string[] = [];
        filesUnder(dir, files);
        for (const file of files) {
          if (file.endsWith('.test.ts')) continue;
          if (readFileSync(file, 'utf8').includes(ZONE_ID_HEX)) offenders.push(relative(repoRoot, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the zone id appears only in repo-level configuration (.github, root .env.example)', () => {
    const offenders: string[] = [];
    const files: string[] = [];
    filesUnder(repoRoot, files);
    for (const file of files) {
      const rel = relative(repoRoot, file);
      if (file.endsWith('.test.ts')) continue; // guard fixtures are not leaks
      if (!readFileSync(file, 'utf8').includes(ZONE_ID_HEX)) continue;
      // docs/ legitimately quotes the production config (the plan's report
      // requirement); the guard's target is app/package/e2e source and tests.
      const allowed =
        rel.startsWith('.github') || rel === '.env.example' || rel.startsWith('docs');
      if (!allowed) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('the Cloudflare token value/variable are referenced only at the env + server assembly site', () => {
    const files: string[] = [];
    filesUnder(apiSrcRoot, files);
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith('.test.ts')) continue; // tests necessarily drive the env var
      const rel = relative(apiSrcRoot, file);
      const allowed = rel === 'env.ts' || rel === 'server.ts';
      const text = readFileSync(file, 'utf8');
      if (text.includes('cloudflareZoneApiToken') || text.includes('CLOUDFLARE_ZONE_EDIT_API_TOKEN')) {
        if (!allowed) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('probeHttps is only ever fed hostnames from machine state, never request bodies', () => {
    const offenders: string[] = [];
    const files: string[] = [];
    filesUnder(apiSrcRoot, files);
    for (const file of files) {
      if (file.endsWith('.test.ts')) continue;
      const rel = relative(apiSrcRoot, file);
      const text = readFileSync(file, 'utf8');
      if (!text.includes('.probeHttps(')) continue;
      if (rel === 'domains.ts') {
        // The custom-domain machine probes its own stored hostname.
        if (!text.includes('probeHttps(domain.hostname)')) offenders.push(rel);
        continue;
      }
      if (rel === 'default-https.ts') {
        // The default-HTTPS machine probes its own stored state hostname.
        if (!text.includes('probeHttps(working.hostname)')) offenders.push(rel);
        continue;
      }
      if (rel === 'server.ts') {
        // server.ts only forwards the seam for assembly (fixture/legacy/cloudflare
        // modes); a request-body or query value must never be probed.
        const bad = text.split('\n').some((line) => {
          if (!line.includes('.probeHttps(')) return false;
          return /request\.body|body\.|params\.|query\.|\.hostname\s*\)/.test(line);
        });
        if (bad) offenders.push(rel);
        continue;
      }
      offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});

// Phase 15 — static verification of the PRODUCTION Cloudflare configuration.
// Pure text scans of .github/workflows/deploy-api.yml: no network, no
// provider call, and no secret value is ever read or printed (the token is
// asserted only as the `${{ secrets.… }}` expression the workflow itself
// carries).
describe('Phase 15 — production Cloudflare deploy configuration', () => {
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const workflowPath = join(repoRoot, '.github', 'workflows', 'deploy-api.yml');
  // Normalise line endings — the file is checked out CRLF on Windows.
  const workflow = readFileSync(workflowPath, 'utf8').replace(/\r\n/g, '\n');
  const ZONE_ID_HEX = 'bf69c0d8524ef2c5cfbc6e5d33fb7cae';
  const CLOUDFLARE_KEYS = [
    'CLOUDFLARE_ZONE_ID',
    'CLOUDFLARE_ZONE_NAME',
    'DEPLOYZ_DEFAULT_HOSTNAME_PREFIX',
    'CLOUDFLARE_ZONE_EDIT_API_TOKEN',
  ];

  it('the Lambda env block binds all four Cloudflare keys with the plan-mandated values', () => {
    const envStart = workflow.indexOf('\n    env:\n');
    const envEnd = workflow.indexOf('\n    steps:\n', envStart);
    expect(envStart, 'could not locate the job-level env: block').toBeGreaterThan(-1);
    expect(envEnd, 'could not locate the steps: block after env:').toBeGreaterThan(envStart);
    const envBlock = workflow.slice(envStart, envEnd);

    expect(envBlock).toContain(`CLOUDFLARE_ZONE_ID: ${ZONE_ID_HEX}`);
    expect(envBlock).toContain('CLOUDFLARE_ZONE_NAME: deployz.dev');
    expect(envBlock).toContain('DEPLOYZ_DEFAULT_HOSTNAME_PREFIX: d-');
    expect(envBlock).toContain('CLOUDFLARE_ZONE_EDIT_API_TOKEN: ${{ secrets.CLOUDFLARE_ZONE_EDIT_API_TOKEN }}');
  });

  it('the deploy completeness-gate loop lists all four Cloudflare keys (a missing binding fails the deploy)', () => {
    // The gate is a `for key in …; do` loop; find the occurrence that carries
    // the Cloudflare keys (there is also a later Stripe-price loop).
    const loops = [...workflow.matchAll(/for key in ([\s\S]*?); do/g)];
    const completeness = loops.find((match) => match[1]!.includes('CLOUDFLARE_ZONE_EDIT_API_TOKEN'));
    expect(completeness, 'could not locate the completeness-gate key loop').toBeDefined();
    const loopBody = completeness![1]!;
    for (const key of CLOUDFLARE_KEYS) {
      expect(loopBody, `completeness gate must list ${key}`).toContain(key);
    }
  });
});
