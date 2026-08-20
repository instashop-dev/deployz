import { createRuntimeDb } from '@deployz/db';

import { createAuth } from './auth.js';
import { env } from './env.js';
import { buildServer } from './server.js';

const db = await createRuntimeDb();
const auth = createAuth(db);
const app = await buildServer({ auth, db });

try {
  await app.listen({ port: env.apiPort });
  console.log(`api listening on http://localhost:${env.apiPort}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
