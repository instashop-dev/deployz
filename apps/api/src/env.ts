import { config } from 'dotenv';

import { findEnvFile, moduleDirectory } from './find-env-file.js';

// The repo-root .env, found by walking up from this file (see findEnvFile for
// why it searches). dotenv is skipped entirely when there is none —
// production / CI rely on real environment variables.
const envFile = findEnvFile(moduleDirectory(import.meta.url));
if (envFile) {
  config({ path: envFile });
}

// Single place that reads process.env for the API. Anything undefined falls
// back to localhost dev defaults; degraded capabilities warn, never crash.

const webPort = Number(process.env.WEB_PORT ?? 3000);

if (!process.env.BETTER_AUTH_SECRET) {
  console.warn(
    '[auth] BETTER_AUTH_SECRET not set — Better Auth will use an ephemeral dev secret. Set it in .env.',
  );
}
if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) {
  console.warn(
    '[auth] GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET not set — GitHub OAuth is configured with empty credentials and will fail until set.',
  );
}
if (!process.env.STRIPE_SECRET_KEY) {
  console.warn(
    '[billing] STRIPE_SECRET_KEY not set — Stripe billing is disabled (checkout/webhook/usage reporting no-op). Set it in .env.',
  );
}
if (!process.env.EMAIL_FROM) {
  console.warn(
    '[email] EMAIL_FROM not set — transactional email (team invitations, membership changes) is logged instead of sent. Set it in .env.',
  );
}
if (!process.env.GITHUB_APP_ID || !process.env.GITHUB_APP_PRIVATE_KEY) {
  console.warn(
    '[github] GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY not set — the GitHub App is not configured (installation-token vending + repo listing no-op). Set them in .env.',
  );
}

export const env = {
  apiPort: Number(process.env.API_PORT ?? 3001),
  apiUrl: `http://localhost:${Number(process.env.API_PORT ?? 3001)}`,
  webUrl: `http://localhost:${webPort}`,
  databaseUrl: process.env.DATABASE_URL,
  betterAuthSecret: process.env.BETTER_AUTH_SECRET,
  githubClientId: process.env.GITHUB_CLIENT_ID ?? '',
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
  stripeSecretKey: process.env.STRIPE_SECRET_KEY,
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  stripePriceBase: process.env.STRIPE_PRICE_BASE,
  stripePriceMetered: process.env.STRIPE_PRICE_METERED,
  githubAppId: process.env.GITHUB_APP_ID,
  githubAppPrivateKey: process.env.GITHUB_APP_PRIVATE_KEY,
  githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
  githubAppInstallUrl: process.env.GITHUB_APP_INSTALL_URL,
  emailFrom: process.env.EMAIL_FROM,
  awsRegion: process.env.AWS_REGION ?? 'us-east-1',
  githubFixtureMode:
    process.env.GITHUB_FIXTURE_MODE === 'true' || process.env.GITHUB_FIXTURE_MODE === '1',
} as const;
