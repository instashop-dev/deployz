/**
 * Lambda handler for the Deployz Fastify API.
 *
 * This is the entry point bundled by esbuild (NodejsFunction). It imports
 * the Fastify app from @deployz/api and uses app.inject() to handle API
 * Gateway v2 events — no HTTP server needed inside Lambda.
 *
 * The Fastify instance is cached across warm invocations (module-level
 * singleton). Cold starts pay the full bootstrap cost once.
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

import { createRuntimeDb } from '@deployz/db';
import { buildServer } from '@deployz/api/server';
import { createAuth } from '@deployz/api/auth';
import type { FastifyInstance } from 'fastify';

let appPromise: Promise<FastifyInstance> | null = null;

function getApp(): Promise<FastifyInstance> {
  if (!appPromise) {
    appPromise = (async () => {
      const db = await createRuntimeDb();
      const auth = createAuth(db);
      const app = await buildServer({ auth, db });
      await app.ready();
      return app;
    })();
  }
  return appPromise;
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const app = await getApp();

  const path = event.rawPath;
  const query = event.rawQueryString ? `?${event.rawQueryString}` : '';

  const response = await app.inject({
    method: event.requestContext.http.method as
      | 'GET'
      | 'POST'
      | 'PUT'
      | 'DELETE'
      | 'PATCH'
      | 'HEAD'
      | 'OPTIONS',
    url: `${path}${query}`,
    headers: (event.headers as Record<string, string>) ?? {},
    body: event.body ?? undefined,
  });

  // Build API Gateway v2 response. Fastify inject returns headers as
  // an object; multi-value headers (set-cookie) come as a joined string.
  const headers: Record<string, string> = {};
  if (response.headers) {
    for (const [key, value] of Object.entries(response.headers)) {
      if (value !== undefined) {
        headers[key] = String(value);
      }
    }
  }

  return {
    statusCode: response.statusCode,
    headers,
    body: response.body,
    isBase64Encoded: false,
  };
}