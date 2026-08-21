/**
 * Deployz fixture application — a minimal Node.js/Express app deployed by
 * the integration suite to prove the INSTALL flow reaches HEALTHY.
 *
 * Endpoints:
 *   GET /health — returns 200 { "status": "ok" }
 *
 * Environment:
 *   DATABASE_URL — PostgreSQL connection string (connects on startup)
 *   PORT         — listen port (default 3000)
 */

import express from 'express';
import type { Express, Request, Response } from 'express';
import pg from 'pg';

const { Pool } = pg;

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);
const DATABASE_URL = process.env['DATABASE_URL'];

// ── PostgreSQL connection ────────────────────────────────────────────────

let pool: pg.Pool | null = null;

if (DATABASE_URL) {
  pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
  // Verify connectivity on startup (best-effort; don't crash the server)
  pool.connect().then((client) => {
    console.log('[fixture] PostgreSQL connected');
    client.release();
  }).catch((err: unknown) => {
    console.warn('[fixture] PostgreSQL connection failed:', err);
  });
} else {
  console.warn('[fixture] DATABASE_URL not set — running without database');
}

// ── Express app ──────────────────────────────────────────────────────────

const app: Express = express();

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`[fixture] listening on port ${PORT}`);
});

export default app;