import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import type { PaddleBilling } from './paddle.js';
import { buildServer } from './server.js';

// Paddle migration Phase 12 — the customer portal. Fixture ids only
// (ctm_test_1, sub_test_1, ...); no test reaches the Paddle API.

interface PortalCall {
  customerId: string;
  subscriptionIds: string[];
}

/** A Paddle double: records what portal session was asked for and answers
 *  with the shape the SDK returns. */
function fakePaddle(options: { calls?: PortalCall[]; error?: Error } = {}): PaddleBilling {
  return {
    config: {
      apiKey: 'test_replace_me',
      webhookSecret: 'test_replace_me',
      clientToken: 'pdl_sdbx_replace_me',
      pricePlatform: 'pri_platform_replace_me',
      priceDeployment: 'pri_deployment_replace_me',
      environment: 'sandbox',
    },
    client: {
      customerPortalSessions: {
        create: async (customerId: string, subscriptionIds: string[]) => {
          if (options.error) throw options.error;
          options.calls?.push({ customerId, subscriptionIds });
          return {
            id: 'cpls_test_1',
            customerId,
            urls: {
              general: { overview: 'https://portal.test/overview' },
              subscriptions: subscriptionIds.map((id) => ({
                id,
                cancelSubscription: `https://portal.test/${id}/cancel`,
                updateSubscriptionPaymentMethod: `https://portal.test/${id}/payment`,
              })),
            },
            createdAt: new Date().toISOString(),
          };
        },
      },
    } as unknown as PaddleBilling['client'],
  };
}

async function signUpAndGetOrg(
  auth: Auth,
  db: Db,
  email: string,
): Promise<{ organizationId: string; cookie: string }> {
  const password = 'super-secret-1';
  const signup = await auth.api.signUpEmail({ body: { email, password, name: email.split('@')[0]! } });
  const signin = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  const setCookie = signin.headers.get('set-cookie');
  if (!setCookie) throw new Error('sign-in did not set a session cookie');
  const memberships = await db
    .select({ organizationId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, signup.user.id))
    .limit(1);
  const organizationId = memberships[0]?.organizationId;
  if (!organizationId) throw new Error('signup did not provision an organization');
  return { organizationId, cookie: setCookie };
}

function postPortal(app: FastifyInstance, cookie?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/billing/portal',
    headers: cookie ? { cookie } : {},
  });
}

describe('POST /api/billing/portal (Paddle migration Phase 12)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let org: { organizationId: string; cookie: string };

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, `portal-${crypto.randomUUID()}@example.com`);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('401s without a session', async () => {
    const app = await buildServer({ auth, db, paddle: fakePaddle() });
    try {
      expect((await postPortal(app)).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('503s when Paddle is not configured', async () => {
    const app = await buildServer({ auth, db, paddle: null });
    try {
      const response = await postPortal(app, org.cookie);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: 'BILLING_DISABLED' } });
    } finally {
      await app.close();
    }
  });

  it('409s an organization in evaluation — there is nothing to manage', async () => {
    const calls: PortalCall[] = [];
    const app = await buildServer({ auth, db, paddle: fakePaddle({ calls }) });
    try {
      const response = await postPortal(app, org.cookie);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'NO_SUBSCRIPTION' } });
      expect(calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("mints links for the organization's OWN customer and subscription", async () => {
    await db.insert(schema.billingSubscriptions).values({
      organizationId: org.organizationId,
      providerCustomerId: 'ctm_test_1',
      providerSubscriptionId: 'sub_test_1',
      status: 'ACTIVE',
    });
    const calls: PortalCall[] = [];
    const app = await buildServer({ auth, db, paddle: fakePaddle({ calls }) });
    try {
      const response = await postPortal(app, org.cookie);
      expect(response.statusCode, response.body).toBe(200);
      // The session's authorization IS the customer id on file — never a
      // value from the request.
      expect(calls).toEqual([{ customerId: 'ctm_test_1', subscriptionIds: ['sub_test_1'] }]);
      expect(response.json()).toEqual({
        overview: 'https://portal.test/overview',
        updatePaymentMethod: 'https://portal.test/sub_test_1/payment',
        cancel: 'https://portal.test/sub_test_1/cancel',
      });
    } finally {
      await app.close();
    }
  });

  it('502s without leaking the provider error when Paddle refuses', async () => {
    const app = await buildServer({
      auth,
      db,
      paddle: fakePaddle({ error: new Error('internal paddle detail') }),
    });
    try {
      const response = await postPortal(app, org.cookie);
      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({ error: { code: 'PORTAL_UNAVAILABLE' } });
      expect(response.body).not.toContain('internal paddle detail');
    } finally {
      await app.close();
    }
  });
});
