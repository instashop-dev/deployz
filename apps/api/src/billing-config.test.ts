import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import type { PaddleBilling } from './paddle.js';
import { buildServer } from './server.js';

/** Signs up a fresh user, which provisions its own vendor org (auth.ts session hook). */
async function signUpAndGetOrg(
  auth: Auth,
  db: Db,
  email: string,
): Promise<{ userId: string; organizationId: string; cookie: string }> {
  const password = crypto.randomUUID();
  const signup = await auth.api.signUpEmail({ body: { email, password, name: email.split('@')[0]! } });
  const signin = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  const setCookie = signin.headers.get('set-cookie');
  if (!setCookie) {
    throw new Error('sign-in did not set a session cookie');
  }
  const memberships = await db
    .select({ organizationId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, signup.user.id))
    .limit(1);
  const organizationId = memberships[0]?.organizationId;
  if (!organizationId) {
    throw new Error('signup did not provision an organization');
  }
  return { userId: signup.user.id, organizationId, cookie: setCookie };
}

// A fake PaddleBilling — the real @paddle/paddle-node-sdk client is never
// constructed in a test, and its real shape (products/prices/etc resources)
// is irrelevant here: only `config` is read by the route.
function fakePaddleBilling(overrides: Partial<PaddleBilling['config']> = {}): PaddleBilling {
  return {
    client: {} as PaddleBilling['client'],
    config: {
      apiKey: 'test_replace_me',
      webhookSecret: 'test_replace_me',
      clientToken: 'pdl_sdbx_replace_me',
      pricePlatform: 'pri_platform_replace_me',
      priceDeployment: 'pri_deployment_replace_me',
      environment: 'sandbox',
      ...overrides,
    },
  };
}

describe('GET /api/billing/config', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let org: { userId: string; organizationId: string; cookie: string };

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, `billing-config-${crypto.randomUUID()}@example.com`);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('requires auth (401 without a session)', async () => {
    const app = await buildServer({ auth, db, paddle: null });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/billing/config' });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('returns { enabled: false } when paddle is null', async () => {
    const app = await buildServer({ auth, db, paddle: null });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/billing/config',
        headers: { cookie: org.cookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toStrictEqual({ enabled: false });
    } finally {
      await app.close();
    }
  });

  it('returns the client token, environment and price ids when Paddle is configured', async () => {
    const app = await buildServer({ auth, db, paddle: fakePaddleBilling({ environment: 'production' }) });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/billing/config',
        headers: { cookie: org.cookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toStrictEqual({
        enabled: true,
        environment: 'production',
        clientToken: 'pdl_sdbx_replace_me',
        pricePlatform: 'pri_platform_replace_me',
        priceDeployment: 'pri_deployment_replace_me',
      });
    } finally {
      await app.close();
    }
  });

  it('never includes the api key or webhook secret in the response', async () => {
    const app = await buildServer({ auth, db, paddle: fakePaddleBilling() });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/billing/config',
        headers: { cookie: org.cookie },
      });
      const body = response.json() as Record<string, unknown>;
      const raw = JSON.stringify(body);
      expect(raw).not.toContain('apiKey');
      expect(raw).not.toContain('webhookSecret');
      expect(raw).not.toContain('test_replace_me');
    } finally {
      await app.close();
    }
  });
});
