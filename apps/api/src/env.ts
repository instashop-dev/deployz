import { config } from 'dotenv';

import type { AiGatewayConfig } from '@deployz/analysis';

import { describeAiGatewayConfig } from './ai-config.js';

import { findEnvFile } from './find-env-file.js';

// Lambda injects the environment directly and ships no .env, so skip the
// filesystem probe there entirely. dotenv also no-ops silently when the file
// is absent, so CI and any other real-env deployment are unaffected.
//
// findEnvFile walks up from the working directory to the filesystem root —
// deliberately not a fixed number of hops, and deliberately not
// `fileURLToPath(import.meta.url)`: the API is bundled to CJS for Lambda
// because pg uses dynamic require(), and esbuild compiles `import.meta` to
// `{}` in CJS output, so import.meta.url is undefined and fileURLToPath
// throws at module load, killing the function during INIT before any handler
// runs. packages/db/src/client.ts avoids the same trap by evaluating
// import.meta.url lazily inside a function.
if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  const envFile = findEnvFile(process.cwd());
  if (envFile) config({ path: envFile });
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

// §16/§29 AI explanations. The resolution rules (all credentials required, the
// two secrets must differ) live in ai-config.ts so they are testable without
// mutating process.env.
function readAiGatewayConfig(): AiGatewayConfig | undefined {
  const { config, problem } = describeAiGatewayConfig(process.env);
  if (problem === 'missing') {
    console.warn(
      '[ai] AI_GATEWAY_BASE_URL/AI_PROVIDER_API_KEY not both set — AI explanations ' +
        'are disabled and diagnostics fall back to deterministic remediation ' +
        'guidance. Set them in .env. (AI_GATEWAY_TOKEN is only needed for a ' +
        'gateway with authentication switched on.)',
    );
  }
  if (problem === 'reused-secret') {
    console.warn(
      '[ai] AI_PROVIDER_API_KEY and AI_GATEWAY_TOKEN are identical — they authenticate ' +
        'different hops (the upstream provider and the gateway itself). AI explanations ' +
        'are disabled until they are set to their two distinct values.',
    );
  }
  return config;
}

export const env = {
  aiGateway: readAiGatewayConfig(),
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
  sesAccessKeyId: process.env.AWS_SES_ACCESS_KEY_ID,
  sesSecretAccessKey: process.env.AWS_SES_SECRET_ACCESS_KEY,
  // Public HTTPS URL of the published bootstrap template. Written by the
  // publisher (`pnpm --filter @deployz/cdk run publish:bootstrap`) into the
  // control-plane stack's environment. Unset means no install link can be
  // handed out yet — GET /api/install/:id then returns quickCreateUrl null
  // and the install page says so, instead of pointing the customer at a
  // template that does not exist.
  bootstrapTemplateUrl: process.env.BOOTSTRAP_TEMPLATE_URL,
  awsRegion: process.env.AWS_REGION ?? 'us-east-1',
  githubFixtureMode:
    process.env.GITHUB_FIXTURE_MODE === 'true' || process.env.GITHUB_FIXTURE_MODE === '1',
  // Custom-domains MVP E2E fixture mode — see domain-check.ts's
  // createFixtureDomainCheckDeps. Mirrors githubFixtureMode.
  domainFixtureMode: process.env.DOMAIN_FIXTURE_MODE === 'true',
  // AI fixture mode — canned gateway responses so the E2E suite can drive
  // the fix-instructions flow without a live model. Mirrors githubFixtureMode.
  aiFixtureMode: process.env.AI_FIXTURE_MODE === 'true',
} as const;
