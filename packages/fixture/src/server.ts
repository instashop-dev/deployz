/**
 * Deployz fixture application — the container a fresh installation runs.
 *
 * A customer deployment has no release when it is first installed, so the
 * application stack still needs something to run: CloudFormation does not
 * report an ECS service complete until it stabilises, which means a real
 * image that starts and answers its health check. This is that image.
 *
 * It is deliberately close to nothing. Its whole job is to be honest about
 * two things:
 *
 * - **`/health` answers 200 as soon as the process is listening.** It is
 *   the ALB target-group check and the container health check, and both are
 *   asking whether the container is up — not whether the application is
 *   fully wired. A `/health` that failed while the database was still
 *   coming up would fail the install for a reason the install did not
 *   cause.
 * - **The database probe is reported, not enforced.** The body says what
 *   the connection is doing so an operator can see it; it never changes the
 *   status code. `GET /` carries the same detail for a human.
 */

import express, { type Express } from 'express';
import { Pool, type PoolConfig } from 'pg';

const PORT = Number(process.env['PORT'] ?? 3000);

type DatabaseState = 'connected' | 'unavailable' | 'not-configured';

/**
 * The stack injects DATABASE_HOST and friends; a bare `docker run` does
 * not. Absent configuration is `null`, which is a different answer from
 * "configured and not reachable" and worth keeping distinct.
 *
 * Exported and taking its environment as an argument so the connection
 * settings can be asserted without opening a socket.
 */
export function poolConfigFromEnv(env: NodeJS.ProcessEnv): PoolConfig | null {
  const host = env['DATABASE_HOST'];
  if (!host) return null;

  return {
    host,
    port: Number(env['DATABASE_PORT'] ?? 5432),
    database: env['DATABASE_NAME'] ?? 'deployz',
    user: env['DATABASE_USER'] ?? 'deployz_app',
    password: env['DATABASE_PASSWORD'] ?? '',
    // The stack's RDS runs on the default postgres16 parameter group, where
    // `rds.force_ssl` is 1 — an unencrypted connection is refused outright.
    // Without this the container comes up healthy and reports its database
    // permanently unavailable, which reads like a networking fault and is
    // not one.
    //
    // `rejectUnauthorized: false` encrypts without verifying the server
    // certificate. That is the wrong trade for a real application, which
    // should pin the RDS CA bundle; it is the right one here, where the
    // point is to prove the wiring reaches the database and shipping a CA
    // bundle in a fixture would obscure that.
    ssl: { rejectUnauthorized: false },
    // Short, because this only ever backs a status field. A slow database
    // must not make the health endpoint slow enough to look like a timeout.
    connectionTimeoutMillis: 2_000,
    max: 2,
  };
}

const poolConfig = poolConfigFromEnv(process.env);
const pool = poolConfig === null ? null : new Pool(poolConfig);

async function probeDatabase(): Promise<DatabaseState> {
  if (!pool) return 'not-configured';
  try {
    await pool.query('SELECT 1');
    return 'connected';
  } catch {
    return 'unavailable';
  }
}

export function createApp(probe: () => Promise<DatabaseState> = probeDatabase): Express {
  const app = express();

  app.get('/health', async (_request, response) => {
    response.status(200).json({ status: 'ok', database: await probe() });
  });

  app.get('/', async (_request, response) => {
    response.status(200).json({
      application: 'deployz-fixture',
      status: 'ok',
      database: await probe(),
    });
  });

  return app;
}

// Only when run as the container's entry point — importing this module in a
// test must not bind a port.
if (process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts')) {
  createApp().listen(PORT, () => {
    console.log(JSON.stringify({ event: 'fixture:listening', port: PORT }));
  });
}
