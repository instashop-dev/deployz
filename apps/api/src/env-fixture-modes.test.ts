import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// §24 production safety: every fixture-mode flag is an explicit opt-in — with
// none of GITHUB_FIXTURE_MODE/AI_FIXTURE_MODE/DOMAIN_FIXTURE_MODE/
// BUILD_FIXTURE_MODE set, all four flags in env.ts must parse false, so a
// deployment that forgets to set them (e.g. because CI's deploy-api.yml
// legitimately never sets any of them — see e2e/production-safety.spec.ts)
// never silently runs in fixture mode instead of failing closed.
//
// env.ts reads process.env once at import time, AND (per find-env-file.ts)
// dotenv-loads the nearest ancestor .env of process.cwd() if the vars aren't
// already set — which on this machine's main checkout is
// GITHUB_FIXTURE_MODE=true (a deliberate local-dev convenience, see
// find-env-file.test.ts). A plain `import { env } from './env.js'` would
// therefore assert against whatever the developer's own .env happens to
// contain instead of the actual unset default. This test sidesteps that by
// pointing process.cwd() at an empty temp directory (no .env anywhere in its
// ancestry) before a fresh import, the same isolation strategy
// find-env-file.test.ts uses for the same reason — via vi.spyOn rather than
// process.chdir(), which Node disallows inside a worker thread.
describe('fixture-mode flags default to false when unset', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'deployz-env-fixture-'));
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('all four fixture-mode flags parse false', async () => {
    const { env } = await import('./env.js');
    expect(env.githubFixtureMode).toBe(false);
    expect(env.domainFixtureMode).toBe(false);
    expect(env.aiFixtureMode).toBe(false);
    expect(env.buildFixtureMode).toBe(false);
  });
});
