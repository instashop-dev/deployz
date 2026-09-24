import { describe, expect, it } from 'vitest';

import {
  checkBinding,
  createApp,
  parseRedisUrl,
  poolConfigFromEnv,
  readReleaseInfo,
  redisPingTarget,
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

describe('/canary/bindings', () => {
  it('reports each binding as present with an 8-hex sha256 prefix, or absent', async () => {
    const { url, close } = await serve(
      createApp({
        probe: async () => 'not-configured',
        release: V1,
        markers: null,
        env: { DATABASE_URL: 'postgresql://u:p@h/db', STORAGE_BUCKET: 'my-bucket' },
      }),
    );
    try {
      const body = (await (await fetch(`${url}/canary/bindings`)).json()) as {
        bindings: Record<string, { present: boolean; sha256Prefix: string | null }>;
      };
      expect(body.bindings['DATABASE_URL']).toMatchObject({ present: true });
      expect(body.bindings['DATABASE_URL']?.sha256Prefix).toMatch(/^[0-9a-f]{8}$/);
      expect(body.bindings['STORAGE_BUCKET']).toMatchObject({ present: true });
      expect(body.bindings['S3_BUCKET']).toEqual({ present: false, sha256Prefix: null });
      expect(body.bindings['REDIS_URL']).toEqual({ present: false, sha256Prefix: null });
    } finally {
      await close();
    }
  });

  it('never echoes the binding value itself', async () => {
    const { url, close } = await serve(
      createApp({ probe: async () => 'not-configured', release: V1, markers: null, env: { DATABASE_URL: 'postgresql://u:secret-password@h/db' } }),
    );
    try {
      const text = await (await fetch(`${url}/canary/bindings`)).text();
      expect(text).not.toContain('secret-password');
    } finally {
      await close();
    }
  });

  it('pings redis over raw TCP when REDIS_URL is configured, via the injected pinger', async () => {
    const { url, close } = await serve(
      createApp({
        probe: async () => 'not-configured',
        release: V1,
        markers: null,
        env: { REDIS_URL: 'redis://cache.example.internal:6379' },
        pingRedis: async (host, port) => {
          expect(host).toBe('cache.example.internal');
          expect(port).toBe(6379);
          return { attempted: true, ok: true, detail: '+PONG' };
        },
      }),
    );
    try {
      const body = (await (await fetch(`${url}/canary/bindings`)).json()) as { redis: { attempted: boolean; ok: boolean } };
      expect(body.redis).toMatchObject({ attempted: true, ok: true });
    } finally {
      await close();
    }
  });

  it('does not attempt a redis ping when no REDIS_* binding is configured', async () => {
    const { url, close } = await serve(createApp({ probe: async () => 'not-configured', release: V1, markers: null, env: {} }));
    try {
      const body = (await (await fetch(`${url}/canary/bindings`)).json()) as { redis: { attempted: boolean } };
      expect(body.redis.attempted).toBe(false);
    } finally {
      await close();
    }
  });

  it('reports a failed ping without throwing', async () => {
    const { url, close } = await serve(
      createApp({
        probe: async () => 'not-configured',
        release: V1,
        markers: null,
        env: { REDIS_HOST: 'unreachable.example.internal', REDIS_PORT: '6380' },
        pingRedis: async () => ({ attempted: true, ok: false, detail: 'timeout' }),
      }),
    );
    try {
      const body = (await (await fetch(`${url}/canary/bindings`)).json()) as { redis: { attempted: boolean; ok: boolean; detail: string } };
      expect(body.redis).toEqual({ attempted: true, ok: false, detail: 'timeout' });
    } finally {
      await close();
    }
  });
});

describe('checkBinding / redisPingTarget / parseRedisUrl', () => {
  it('checkBinding: absent for undefined/empty, present with a sha256 prefix otherwise', () => {
    expect(checkBinding(undefined)).toEqual({ present: false, sha256Prefix: null });
    expect(checkBinding('')).toEqual({ present: false, sha256Prefix: null });
    const result = checkBinding('a-value');
    expect(result.present).toBe(true);
    expect(result.sha256Prefix).toMatch(/^[0-9a-f]{8}$/);
  });

  it('parseRedisUrl reads host/port, defaulting the port to 6379', () => {
    expect(parseRedisUrl('redis://cache.internal:6380')).toEqual({ host: 'cache.internal', port: 6380 });
    expect(parseRedisUrl('redis://cache.internal')).toEqual({ host: 'cache.internal', port: 6379 });
    expect(parseRedisUrl('not a url')).toBeNull();
  });

  it('redisPingTarget prefers REDIS_URL, falls back to REDIS_HOST/REDIS_PORT, else null', () => {
    expect(redisPingTarget({ REDIS_URL: 'redis://a:1234' })).toEqual({ host: 'a', port: 1234 });
    expect(redisPingTarget({ REDIS_HOST: 'b', REDIS_PORT: '9999' })).toEqual({ host: 'b', port: 9999 });
    expect(redisPingTarget({ REDIS_HOST: 'b' })).toEqual({ host: 'b', port: 6379 });
    expect(redisPingTarget({})).toBeNull();
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
