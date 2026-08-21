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
  webServer: [
    {
      command: 'pnpm --filter @deployz/api dev',
      url: `http://localhost:${apiPort}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      // Fixture mode: the GitHub routes serve the fixture org/repos so the
      // repo-selection E2E renders without a real GitHub App.
      env: { ...process.env, GITHUB_FIXTURE_MODE: 'true' },
    },
    {
      command: 'pnpm --filter @deployz/web dev',
      url: `http://localhost:${webPort}`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
