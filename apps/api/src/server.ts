import cors from '@fastify/cors';
import { setupFastifyErrorHandler } from '@sentry/node';
import { fromNodeHeaders } from 'better-auth/node';
import Fastify, { type FastifyInstance } from 'fastify';

import type { RuntimeDb } from '@deployz/db';

import type { Auth } from './auth.js';
import { env } from './env.js';
import { ApiError, toErrorEnvelope } from './errors.js';
import { createRequireAuth } from './require-auth.js';

export interface ServerDeps {
  auth: Auth;
  db: RuntimeDb;
}

// Control-plane surface: /health, /api/me, /api/auth/*.
// Errors cross the boundary as structured envelopes via toErrorEnvelope;
// Sentry capture lives in its onError hook (never in the render path).
export async function buildServer({ auth, db }: ServerDeps): Promise<FastifyInstance> {
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

  const requireAuth = createRequireAuth({ auth, db });

  app.get('/api/me', { preHandler: requireAuth }, async (request) => ({
    user: request.user ?? null,
    organization: request.organization ?? null,
  }));

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
