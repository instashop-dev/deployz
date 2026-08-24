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

import { toInjectOptions, toLambdaResult } from './api-gateway-adapter.js';
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
import migration0000 from '../../../db/drizzle/0000_parallel_triton.sql';
import migration0001 from '../../../db/drizzle/0001_event_logs_immutable.sql';
import migration0002 from '../../../db/drizzle/0002_dizzy_red_shift.sql';
import migration0003 from '../../../db/drizzle/0003_orange_phalanx.sql';
import migration0004 from '../../../db/drizzle/0004_married_blob.sql';
import migration0005 from '../../../db/drizzle/0005_deep_gambit.sql';
import migration0006 from '../../../db/drizzle/0006_funny_pete_wisdom.sql';
import migration0007 from '../../../db/drizzle/0007_relay_enrollment.sql';
import journal from '../../../db/drizzle/meta/_journal.json';

/**
 * Migration SQL keyed by journal tag.
 *
 * esbuild cannot glob-import, so every migration has to be listed by hand. A
 * migration added under packages/db/drizzle without a line here is invisible
 * until the deployed Lambda tries to apply it and drizzle fails with a bare
 * "No file ... found in /tmp/drizzle folder". writeMigrationsToTmp checks this
 * map against the journal up front and names what is missing instead;
 * packages/cdk/test/api-handler-migrations.test.ts fails the build even
 * earlier.
 */
const MIGRATION_SQL: Record<string, string> = {
  '0000_parallel_triton': migration0000,
  '0001_event_logs_immutable': migration0001,
  '0002_dizzy_red_shift': migration0002,
  '0003_orange_phalanx': migration0003,
  '0004_married_blob': migration0004,
  '0005_deep_gambit': migration0005,
  '0006_funny_pete_wisdom': migration0006,
  '0007_relay_enrollment': migration0007,
};

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

  const tags = (journal as { entries: readonly { tag: string }[] }).entries.map(
    (entry) => entry.tag,
  );

  const missing = tags.filter((tag) => MIGRATION_SQL[tag] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Migrations listed in the drizzle journal but not bundled into the Lambda: ${missing.join(', ')}. ` +
        'Add an import and a MIGRATION_SQL entry for each in packages/cdk/src/lambda/api-handler.ts.',
    );
  }

  for (const tag of tags) {
    writeFileSync(join(migrationsDir, `${tag}.sql`), MIGRATION_SQL[tag] as string);
  }
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
  const response = await app.inject(toInjectOptions(event));
  return toLambdaResult(response);
}
