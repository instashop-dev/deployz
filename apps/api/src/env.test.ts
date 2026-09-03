import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
