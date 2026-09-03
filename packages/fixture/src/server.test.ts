import { describe, expect, it } from 'vitest';

import {
  createApp,
  poolConfigFromEnv,
  readReleaseInfo,
  type MarkerRecord,
  type MarkerStore,
  type ReleaseInfo,
} from './server.js';

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

const V1: ReleaseInfo = { version: 'v1', commit: 'aaaaaaa', healthMode: 'ok' };
const BROKEN: ReleaseInfo = { version: 'v3-bad-health', commit: 'ccccccc', healthMode: 'broken' };

/** An in-memory marker store with the same write-once semantics as the table. */
function memoryMarkers(): MarkerStore & { rows: Map<string, MarkerRecord> } {
  const rows = new Map<string, MarkerRecord>();
  return {
    rows,
    async write(key, value) {
      const existing = rows.get(key);
      if (existing) return existing;
      const record = { key, value, createdAt: new Date().toISOString() };
      rows.set(key, record);
      return record;
    },
    async read(key) {
      return rows.get(key) ?? null;
    },
  };
}

describe('fixture server', () => {
  it('answers 200 on /health — the ALB and container health check', async () => {
    const { url, close } = await serve(createApp({ probe: async () => 'not-configured', release: V1 }));
    try {
      const response = await fetch(`${url}/health`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ status: 'ok', version: 'v1' });
    } finally {
      await close();
    }
  });

  it('still answers 200 while the database is unreachable', async () => {
    const { url, close } = await serve(createApp({ probe: async () => 'unavailable', release: V1 }));
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

  it('answers 500 on /health for a broken-health release, deterministically', async () => {
    const { url, close } = await serve(createApp({ probe: async () => 'connected', release: BROKEN }));
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await fetch(`${url}/health`);
        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toMatchObject({
          status: 'unhealthy',
          reason: 'health-mode-broken',
          version: 'v3-bad-health',
        });
      }
      // The rest of the application still runs — only the health verdict
      // is broken, which is what makes the failure a health failure and
      // not a crash.
      expect((await fetch(`${url}/version`)).status).toBe(200);
    } finally {
      await close();
    }
  });

  it('reports the baked-in release identity on /version', async () => {
    const { url, close } = await serve(createApp({ probe: async () => 'connected', release: V1 }));
    try {
      await expect((await fetch(`${url}/version`)).json()).resolves.toEqual(V1);
    } finally {
      await close();
    }
  });

  it('reports the database state so an operator can see it', async () => {
    const { url, close } = await serve(createApp({ probe: async () => 'connected', release: V1 }));
    try {
      await expect((await fetch(`${url}/`)).json()).resolves.toMatchObject({
        application: 'deployz-fixture',
        database: 'connected',
        version: 'v1',
      });
    } finally {
      await close();
    }
  });
});

describe('canary markers', () => {
  it('writes a marker and reads it back', async () => {
    const markers = memoryMarkers();
    const { url, close } = await serve(createApp({ probe: async () => 'connected', release: V1, markers }));
    try {
      const written = await fetch(`${url}/canary/markers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'DEPLOYZ_CANARY_run-1', value: 'v1' }),
      });
      expect(written.status).toBe(201);
      await expect(written.json()).resolves.toMatchObject({ key: 'DEPLOYZ_CANARY_run-1', value: 'v1' });

      const read = await fetch(`${url}/canary/markers/DEPLOYZ_CANARY_run-1`);
      expect(read.status).toBe(200);
      await expect(read.json()).resolves.toMatchObject({ key: 'DEPLOYZ_CANARY_run-1', value: 'v1' });
    } finally {
      await close();
    }
  });

  it('defaults the value to the running version — the marker records who wrote it', async () => {
    const markers = memoryMarkers();
    const { url, close } = await serve(createApp({ probe: async () => 'connected', release: V1, markers }));
    try {
      const written = await fetch(`${url}/canary/markers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'k' }),
      });
      await expect(written.json()).resolves.toMatchObject({ key: 'k', value: 'v1' });
    } finally {
      await close();
    }
  });

  it('is write-once: a second write keeps the original row', async () => {
    const markers = memoryMarkers();
    const { url, close } = await serve(createApp({ probe: async () => 'connected', release: V1, markers }));
    try {
      const first = await (
        await fetch(`${url}/canary/markers`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: 'k', value: 'first' }),
        })
      ).json();
      const second = await (
        await fetch(`${url}/canary/markers`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: 'k', value: 'second' }),
        })
      ).json();
      expect(second).toEqual(first);
    } finally {
      await close();
    }
  });

  it('answers 404 for an unknown marker and 400 for a malformed key', async () => {
    const markers = memoryMarkers();
    const { url, close } = await serve(createApp({ probe: async () => 'connected', release: V1, markers }));
    try {
      expect((await fetch(`${url}/canary/markers/missing`)).status).toBe(404);
      expect((await fetch(`${url}/canary/markers/not%20valid`)).status).toBe(400);
      const bad = await fetch(`${url}/canary/markers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'has space' }),
      });
      expect(bad.status).toBe(400);
    } finally {
      await close();
    }
  });

  it('answers 503 without a database instead of pretending to store anything', async () => {
    const { url, close } = await serve(
      createApp({ probe: async () => 'not-configured', release: V1, markers: null }),
    );
    try {
      const written = await fetch(`${url}/canary/markers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'k' }),
      });
      expect(written.status).toBe(503);
      expect((await fetch(`${url}/canary/markers/k`)).status).toBe(503);
    } finally {
      await close();
    }
  });
});

describe('release identity', () => {
  it('reads release.json from the working directory', () => {
    const info = readReleaseInfo({}, () => JSON.stringify(BROKEN));
    expect(info).toEqual(BROKEN);
  });

  it('falls back to a local identity when the file is absent', () => {
    expect(
      readReleaseInfo({}, () => {
        throw new Error('ENOENT');
      }),
    ).toEqual({ version: 'dev', commit: 'local', healthMode: 'ok' });
  });

  it('lets the environment override the file for local runs', () => {
    const info = readReleaseInfo(
      { FIXTURE_VERSION: 'v9', FIXTURE_HEALTH_MODE: 'broken' },
      () => JSON.stringify(V1),
    );
    expect(info).toEqual({ version: 'v9', commit: 'aaaaaaa', healthMode: 'broken' });
  });

  it('treats any health mode other than "broken" as ok', () => {
    expect(readReleaseInfo({}, () => JSON.stringify({ ...V1, healthMode: 'weird' })).healthMode).toBe('ok');
  });
});

describe('database connection settings', () => {
  it('is not configured without a host', () => {
    expect(poolConfigFromEnv({})).toBeNull();
  });

  it('connects over TLS — the stack RDS forces it', () => {
    // The application stack's RDS runs on the default postgres16 parameter
    // group, where rds.force_ssl is 1. A plain connection is refused, which
    // showed up as a permanently "unavailable" database behind a healthy
    // container.
    const config = poolConfigFromEnv({ DATABASE_HOST: 'db.example.com' });

    expect(config?.ssl).toBeTruthy();
  });

  it('reads host, port, database and user from the stack env', () => {
    const config = poolConfigFromEnv({
      DATABASE_HOST: 'db.example.com',
      DATABASE_PORT: '6000',
      DATABASE_NAME: 'app',
      DATABASE_USER: 'appuser',
      DATABASE_PASSWORD: 'pw',
    });

    expect(config).toMatchObject({
      host: 'db.example.com',
      port: 6000,
      database: 'app',
      user: 'appuser',
      password: 'pw',
    });
  });
});
