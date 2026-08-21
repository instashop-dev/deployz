import cors from '@fastify/cors';
import { setupFastifyErrorHandler } from '@sentry/node';
import { fromNodeHeaders } from 'better-auth/node';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import type { Auth } from './auth.js';
import { createStripe, handleWebhookEvent, constructWebhookEvent } from './billing.js';
import {
  createConfigStore,
  createRelaySecretWriter,
  getConfig,
  setConfig,
  setConfigBodySchema,
} from './config.js';
import { env } from './env.js';
import { ApiError, toErrorEnvelope } from './errors.js';
import {
  createGithubStore,
  handleInstallationWebhook,
  listInstallations,
  listRepositories,
  mintInstallationToken,
  verifyWebhookSignature,
  type FetchFn,
  type GithubWebhookEvent,
  type ResolveOrganization,
} from './github.js';
import { createRequireAuth } from './require-auth.js';

export interface ServerDeps {
  auth: Auth;
  db: RuntimeDb;
  // Injectable GitHub seams for tests (the real values come from env). The
  // webhook secret is required to verify signatures; fixtureMode flips the
  // repo/installations routes to the fixture store.
  githubWebhookSecret?: string | undefined;
  githubFixtureMode?: boolean | undefined;
}

// Control-plane surface: /health, /api/me, /api/auth/*.
// Errors cross the boundary as structured envelopes via toErrorEnvelope;
// Sentry capture lives in its onError hook (never in the render path).
export async function buildServer({
  auth,
  db,
  githubWebhookSecret,
  githubFixtureMode,
}: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Sentry owns capture via the onError hook this registers. Capture filter:
  // ApiError 4xx are expected client errors — not reportable; everything else
  // (5xx ApiError, unknown throws) is. Do NOT captureException in the custom
  // error handler below — that would double-report.
  setupFastifyErrorHandler(app, {
    shouldHandleError: (error) => !(error instanceof ApiError) || error.statusCode >= 500,
  });

  // Single render path for every thrown error: structured envelope, no stack
  // traces, no internal messages.
  app.setErrorHandler((error, _request, reply) => {
    const { statusCode, body } = toErrorEnvelope(error);
    return reply.code(statusCode).send(body);
  });

  // Browser origin differs by port; cookies are host-scoped, so credentialed
  // CORS + trustedOrigins is the whole cookie story.
  await app.register(cors, { origin: [env.webUrl], credentials: true });

  app.get('/health', () => ({ ok: true }));

  // Webhook signature verification (Stripe + GitHub) needs the RAW body, so
  // register a raw-json parser for those routes before the JSON parser
  // consumes it. A bad signature -> 400 structured envelope.
  const stripe = createStripe();
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: 1048576 },
    (request, body, done) => {
      const rawWebhook =
        request.raw.url?.startsWith('/api/billing/webhook') ||
        request.raw.url?.startsWith('/api/github/webhook');
      if (rawWebhook) {
        done(null, body);
        return;
      }
      try {
        done(null, JSON.parse(body as string));
      } catch (error) {
        done(error as Error);
      }
    },
  );
  app.post('/api/billing/webhook', async (request, reply) => {
    const signature = request.headers['stripe-signature'];
    const event = constructWebhookEvent(
      stripe,
      request.body as string,
      Array.isArray(signature) ? signature[0] : signature,
    );
    const handled = await handleWebhookEvent({ db, stripe }, event);
    return reply.code(200).send({ received: true, handled });
  });

  // GitHub App webhook: signature-verified via X-Hub-Signature-256 over the
  // raw body. The account->org resolver (#13) matches the GitHub login to
  // the organization slug — sufficient for the MVP since vendor orgs are
  // created with their GitHub org name as the slug.
  const githubStore = createGithubStore();
  const githubFetch: FetchFn = globalThis.fetch.bind(globalThis);
  const resolveGithubOrganization: ResolveOrganization = async (accountLogin) => {
    const rows = await db
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.slug, accountLogin))
      .limit(1);
    return rows[0]?.id ?? null;
  };

  app.post('/api/github/webhook', async (request, reply) => {
    const webhookSecret = githubWebhookSecret ?? env.githubWebhookSecret;
    if (!webhookSecret) {
      throw new ApiError(503, 'GITHUB_DISABLED', 'GitHub App is not configured');
    }
    const signature = request.headers['x-hub-signature-256'];
    const rawBody = request.body as string;
    if (!verifyWebhookSignature(rawBody, Array.isArray(signature) ? signature[0] : signature, webhookSecret)) {
      throw new ApiError(400, 'WEBHOOK_SIGNATURE_INVALID', 'Webhook signature verification failed');
    }
    const body = JSON.parse(rawBody) as {
      action?: string | undefined;
      installation?: { id: number; account?: { login: string; type?: string } | undefined } | undefined;
      sender?: { login: string } | undefined;
    };
    const event: GithubWebhookEvent = {
      type: String(request.headers['x-github-event'] ?? ''),
      action: body.action,
      installation: body.installation,
      sender: body.sender,
    };
    const handled = await handleInstallationWebhook(githubStore, event, resolveGithubOrganization);
    return reply.code(200).send({ received: true, handled });
  });

  const requireAuth = createRequireAuth({ auth, db });

  app.get('/api/me', { preHandler: requireAuth }, async (request) => ({
    user: request.user ?? null,
    organization: request.organization ?? null,
  }));

  // §31 application configuration surface (auth-gated). Vendor defaults are
  // customer_id NULL rows; customer overrides are scoped by ?customerId.
  // Secrets are write-only: GET masks them (value: null, never plaintext) and
  // PUT writes them through the relay to the customer's Secrets Manager
  // before persisting the masked placeholder in the control plane.
  const configStore = createConfigStore(db);
  const configSecretWriter = createRelaySecretWriter();

  app.get('/api/applications/:id/config', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const { customerId } = request.query as { customerId?: string | undefined };
    return getConfig(id, customerId ?? null, configStore);
  });

  app.put('/api/applications/:id/config', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const body = setConfigBodySchema.parse(request.body);
    return setConfig(id, body.customerId ?? null, body.entries, {
      store: configStore,
      secretWriter: configSecretWriter,
    });
  });

  // GitHub repo-selection surface (auth-gated). Fixture mode serves the
  // fixture org/repos so the dashboard renders test data without a real App;
  // otherwise the installation store (populated by the webhook) is the source
  // of truth, and repo listing needs a minted installation token.
  app.get('/api/github/installations', { preHandler: requireAuth }, async (request) => {
    const organizationId = request.organization?.id;
    if (!organizationId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'An organization is required');
    }
    const fixtureMode = githubFixtureMode ?? env.githubFixtureMode;
    const installations = await listInstallations(githubStore, organizationId, { fixtureMode });
    return {
      installations,
      connectUrl: env.githubAppInstallUrl ?? null,
    };
  });

  app.get('/api/github/repos', { preHandler: requireAuth }, async (request) => {
    const { installationId } = request.query as { installationId?: string | undefined };
    if (!installationId) {
      throw new ApiError(400, 'INSTALLATION_ID_REQUIRED', 'installationId query parameter is required');
    }
    const fixtureMode = githubFixtureMode ?? env.githubFixtureMode;
    if (fixtureMode) {
      const repositories = await listRepositories(installationId, { fixtureMode: true });
      return { repositories };
    }
    const appId = env.githubAppId;
    const privateKey = env.githubAppPrivateKey;
    if (!appId || !privateKey) {
      throw new ApiError(503, 'GITHUB_DISABLED', 'GitHub App is not configured');
    }
    const { token } = await mintInstallationToken(installationId, appId, privateKey, Date.now(), githubFetch);
    const repositories = await listRepositories(installationId, {
      fixtureMode: false,
      installationToken: token,
      fetchFn: githubFetch,
    });
    return { repositories };
  });

  // Better Auth over Fastify: construct a Fetch Request, call auth.handler,
  // forward status/headers/body. Official recipe from the docs.
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: async (request, reply) => {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const headers = fromNodeHeaders(request.headers);
      const init: RequestInit = {
        method: request.method,
        headers,
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      };

      const response = await auth.handler(new Request(url.toString(), init));

      reply.status(response.status);
      // set-cookie must survive as separate header lines (squashing breaks the
      // browser); content-length is recomputed by Fastify.
      response.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (lower !== 'set-cookie' && lower !== 'content-length') {
          reply.header(key, value);
        }
      });
      const setCookies =
        typeof response.headers.getSetCookie === 'function'
          ? response.headers.getSetCookie()
          : [];
      if (setCookies.length > 0) {
        reply.header('set-cookie', setCookies);
      }
      return reply.send(response.body ? await response.text() : null);
    },
  });

  return app;
}
