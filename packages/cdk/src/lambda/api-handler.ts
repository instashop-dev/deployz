/**
 * Lambda handler for the Deployz Fastify API.
 *
 * This is the entry point bundled by esbuild (NodejsFunction). It imports
 * the Fastify app from @deployz/api and uses app.inject() to handle API
 * Gateway v2 events — no HTTP server needed inside Lambda.
 *
 * The Fastify instance is cached across warm invocations (module-level
 * singleton). Cold starts pay the full bootstrap cost once.
 *
 * DB credentials are fetched from Secrets Manager at runtime (DB_SECRET_ARN).
 * Drizzle migrations are bundled as text via esbuild's text loader, written
 * to /tmp/drizzle at cold start, and run through the drizzle migrator before
 * the Fastify app is built. The connection URL uses sslmode=require with
 * uselibpqcompat=true because RDS has rds.force_ssl=1 and pg v9 treats
 * sslmode=require as verify-full (rejecting the RDS self-signed cert).
 */
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildServer } from '@deployz/api/server';
import { createAuth } from '@deployz/api/auth';
import type { FastifyInstance } from 'fastify';
import * as schema from '@deployz/db/schema';

// Migration SQL files bundled via esbuild text loader (declared as strings).
// The _journal.json is bundled via esbuild's JSON loader.
import migration0 from '../../../db/drizzle/0000_parallel_triton.sql';
import migration1 from '../../../db/drizzle/0001_event_logs_immutable.sql';
import journal from '../../../db/drizzle/meta/_journal.json';

let appPromise: Promise<FastifyInstance> | null = null;

interface RdsSecret {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly dbname: string;
}

/** Fetch RDS credentials from Secrets Manager at runtime. */
async function fetchDbSecret(secretArn: string): Promise<RdsSecret> {
  const client = new SecretsManagerClient({});
  const response = await client.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  const parsed = JSON.parse(response.SecretString ?? '{}') as RdsSecret;
  return parsed;
}

/** Write bundled migration files to /tmp/drizzle so the migrator can read them. */
function writeMigrationsToTmp(): string {
  const migrationsDir = '/tmp/drizzle';
  const metaDir = join(migrationsDir, 'meta');
  mkdirSync(metaDir, { recursive: true });

  writeFileSync(join(migrationsDir, '0000_parallel_triton.sql'), migration0);
  writeFileSync(join(migrationsDir, '0001_event_logs_immutable.sql'), migration1);
  writeFileSync(join(metaDir, '_journal.json'), JSON.stringify(journal));

  return migrationsDir;
}

function getApp(): Promise<FastifyInstance> {
  if (!appPromise) {
    appPromise = (async () => {
      const secretArn = process.env.DB_SECRET_ARN;
      if (!secretArn) {
        throw new Error('DB_SECRET_ARN is not set');
      }

      const secret = await fetchDbSecret(secretArn);
      // sslmode=require + uselibpqcompat=true: RDS has rds.force_ssl=1, and
      // pg v9 treats sslmode=require as verify-full (rejecting the RDS
      // self-signed cert). uselibpqcompat restores libpq semantics where
      // require means "use SSL, do not verify".
      const databaseUrl = `postgres://${secret.username}:${secret.password}@${secret.host}:${secret.port}/${secret.dbname}?sslmode=require&uselibpqcompat=true`;

      // Run migrations before the app starts.
      const migrationsDir = writeMigrationsToTmp();
      const pool = new Pool({ connectionString: databaseUrl });
      const db = drizzle({ client: pool, schema });
      await migrate(db, { migrationsFolder: migrationsDir });

      // Create auth and Fastify app with the DB connection.
      process.env.DATABASE_URL = databaseUrl;
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
