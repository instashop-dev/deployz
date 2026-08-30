import { defineConfig } from '@playwright/test';

// Boots the real Fastify API and the real Next.js dev server; the spec drives
// a real Chromium browser through signup → session → API 200. API needs
// @deployz/db built (dist) — run `pnpm build` first (turbo dev dependsOn is
// also wired so `pnpm dev` works standalone).
const webPort = Number(process.env.WEB_PORT ?? 3000);
const apiPort = Number(process.env.API_PORT ?? 3001);

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  use: { baseURL: `http://localhost:${webPort}` },
  expect: {
    toHaveScreenshot: {
      // Small tolerance for cross-platform font rasterization; content itself
      // is fully mocked and deterministic (see e2e/visual.spec.ts).
      maxDiffPixelRatio: 0.02,
    },
  },
  webServer: [
    {
      command: 'pnpm --filter @deployz/api dev',
      url: `http://localhost:${apiPort}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: {
        ...process.env,
        // Fixture mode: the GitHub routes serve the fixture org/repos so the
        // repo-selection E2E renders without a real GitHub App.
        GITHUB_FIXTURE_MODE: 'true',
        // Fixture mode: DNS/HTTPS domain checks pass only for
        // *.deployz-fixture.test names, with no check throttle — lets the
        // custom-domain E2E drive the state machine without real DNS/network.
        DOMAIN_FIXTURE_MODE: 'true',
        // A published bootstrap template is what turns the install page's
        // "Deploy to AWS" button into a real Quick Create link. The value is
        // a stand-in for the URL `publish:bootstrap` prints; the E2E only
        // asserts the shape of the link built from it.
        BOOTSTRAP_TEMPLATE_URL:
          'https://deployz-templates.s3.us-east-1.amazonaws.com/bootstrap/v1/bootstrap-template-v1.json',
      },
    },
    {
      command: 'pnpm --filter @deployz/web dev',
      url: `http://localhost:${webPort}`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: {
        ...process.env,
        // `next dev` reads $PORT, not $WEB_PORT — without this, overriding
        // WEB_PORT to dodge a locally-running dev server silently no-ops:
        // Next keeps binding :3000 while Playwright waits on the isolated
        // port and eventually times out.
        PORT: String(webPort),
        // apps/web/src/lib/api-url.ts falls back to localhost:3001 for both
        // the browser (`NEXT_PUBLIC_API_URL`) and server-side (`API_URL`)
        // origins when these are unset — so overriding only API_PORT left
        // every fetch pointed at the wrong (or no) server instead of the
        // isolated one actually booted above.
        NEXT_PUBLIC_API_URL: `http://localhost:${apiPort}`,
        API_URL: `http://localhost:${apiPort}`,
      },
    },
  ],
});
