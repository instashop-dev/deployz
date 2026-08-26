import { describe, expect, it } from 'vitest';

import { createApp } from './server.js';

/** Start the app on an ephemeral port and hand back a base URL. */
async function serve(app: ReturnType<typeof createApp>) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP address');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe('fixture server', () => {
  it('answers 200 on /health — the ALB and container health check', async () => {
    const { url, close } = await serve(createApp(async () => 'not-configured'));
    try {
      const response = await fetch(`${url}/health`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ status: 'ok' });
    } finally {
      await close();
    }
  });

  it('still answers 200 while the database is unreachable', async () => {
    const { url, close } = await serve(createApp(async () => 'unavailable'));
    try {
      const response = await fetch(`${url}/health`);

      // The health check asks whether the container is up. Failing it
      // because RDS is still coming up would roll the install back for a
      // reason the install did not cause.
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        status: 'ok',
        database: 'unavailable',
      });
    } finally {
      await close();
    }
  });

  it('reports the database state so an operator can see it', async () => {
    const { url, close } = await serve(createApp(async () => 'connected'));
    try {
      await expect((await fetch(`${url}/`)).json()).resolves.toMatchObject({
        application: 'deployz-fixture',
        database: 'connected',
      });
    } finally {
      await close();
    }
  });
});
