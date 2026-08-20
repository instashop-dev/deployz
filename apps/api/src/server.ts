import cors from '@fastify/cors';
import { fromNodeHeaders } from 'better-auth/node';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import type { Auth } from './auth.js';
import { env } from './env.js';

export interface ServerDeps {
  auth: Auth;
  db: RuntimeDb;
}

// Control-plane surface for this todo ONLY: /health, /api/me, /api/auth/*.
// (Todo 4 builds the rest of the API on top of this server.)
export async function buildServer({ auth, db }: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Browser origin differs by port; cookies are host-scoped, so credentialed
  // CORS + trustedOrigins is the whole cookie story.
  await app.register(cors, { origin: [env.webUrl], credentials: true });

  app.get('/health', () => ({ ok: true }));

  app.get('/api/me', async (request, reply) => {
    const result = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!result) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const { activeOrganizationId } = result.session;
    const organizations = activeOrganizationId
      ? await db
          .select()
          .from(schema.organization)
          .where(eq(schema.organization.id, activeOrganizationId))
          .limit(1)
      : [];
    return reply.send({ user: result.user, organization: organizations[0] ?? null });
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
