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

const apiPort = Number(process.env.API_PORT ?? 3001);
const webPort = Number(process.env.WEB_PORT ?? 3000);

/** Origins are compared as strings (CORS, trustedOrigins), so a stray trailing
 *  slash silently stops matching. Normalise once, here. */
function origin(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, '') : undefined;
}

// The auth server's own origin. In production this is the API's public
// hostname (api.deployz.dev) — Better Auth builds OAuth callback URLs from it,
// so it must be the externally reachable origin, never the Lambda's internal
// one. BETTER_AUTH_URL is the historical name for exactly this value.
const apiUrl = origin(process.env.API_URL) ?? origin(process.env.BETTER_AUTH_URL) ?? `http://localhost:${apiPort}`;

// The dashboard origin (app.deployz.dev) and the marketing origin
// (deployz.dev). They are the same host in local dev, and both are browser
// origins that must pass CORS and Better Auth's origin check.
const webUrl = origin(process.env.WEB_URL) ?? `http://localhost:${webPort}`;
const marketingUrl = origin(process.env.MARKETING_URL) ?? webUrl;

// Set in production only (e.g. '.deployz.dev'). When present, session cookies
// are widened from host-scoped to domain-scoped so a cookie set by the API on
// api.deployz.dev is readable by app.deployz.dev. Left undefined in dev, where
// both sides are localhost and host-scoped cookies already work.
const cookieDomain = process.env.COOKIE_DOMAIN?.trim() || undefined;

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
if (cookieDomain && !apiUrl.startsWith('https://')) {
  console.warn(
    `[auth] COOKIE_DOMAIN is set but API_URL is ${apiUrl} — domain-scoped cookies are marked Secure and browsers drop them over http.`,
  );
}

export const env = {
  apiPort,
  apiUrl,
  webUrl,
  marketingUrl,
  // Every browser origin allowed to call the API with credentials. Deduped
  // because dev (and any single-host deployment) has marketing === web.
  webOrigins: [...new Set([webUrl, marketingUrl])],
  cookieDomain,
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
