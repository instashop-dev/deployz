import 'dotenv/config';

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
} as const;
