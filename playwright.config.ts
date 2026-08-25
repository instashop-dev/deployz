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
      env: {
        ...process.env,
        // Fixture mode: the GitHub routes serve the fixture org/repos so the
        // repo-selection E2E renders without a real GitHub App.
        GITHUB_FIXTURE_MODE: 'true',
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
    },
  ],
});
