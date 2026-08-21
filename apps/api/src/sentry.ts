import * as Sentry from '@sentry/node';

// Sentry wiring. MUST be imported before anything that loads Fastify
// (index.ts imports this module first): auto-instrumentation hooks module
// load, so init has to run before the fastify module is evaluated.
// No SENTRY_DSN (tests, local dev) -> enabled: false, a safe no-op.
const dsn = process.env.SENTRY_DSN;

Sentry.init({
  ...(dsn ? { dsn } : {}),
  enabled: Boolean(dsn),
  integrations: [Sentry.fastifyIntegration()],
});
