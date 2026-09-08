import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { reconcileBilling } from './billing-reconcile.js';
import type { PaddleBilling } from './paddle.js';

// Paddle migration Phase 9 — reconciliation pushes the ABSOLUTE number of
// live production deployments onto the subscription's per-deployment item.
// Fixture ids only (sub_test_1, pri_deployment_test, ...).

const PRICE_PLATFORM = 'pri_platform_test';
const PRICE_DEPLOYMENT = 'pri_deployment_test';

interface UpdateCall {
  subscriptionId: string;
  body: { items: { priceId: string; quantity: number }[]; prorationBillingMode?: string; onPaymentFailure?: string };
}

/** A Paddle double: `subscriptions.get` returns the item list under test,
 *  `subscriptions.update` records what reconciliation asked for. */
function fakePaddle(options: {
  items?: { priceId: string; quantity: number; status?: 'active' | 'inactive' | 'trialing' }[];
  getError?: Error;
  updateError?: Error;
  updates?: UpdateCall[];
}): PaddleBilling {
  const items = options.items ?? [];
  return {
    config: {
      apiKey: 'test_replace_me',
      webhookSecret: 'test_replace_me',
      clientToken: 'pdl_sdbx_replace_me',
      pricePlatform: PRICE_PLATFORM,
      priceDeployment: PRICE_DEPLOYMENT,
      environment: 'sandbox',
    },
    client: {
      subscriptions: {
        get: async () => {
          if (options.getError) throw options.getError;
          return {
            items: items.map((i) => ({
              price: { id: i.priceId },
              quantity: i.quantity,
              status: i.status ?? 'active',
            })),
          };
        },
        update: async (subscriptionId: string, body: UpdateCall['body']) => {
          if (options.updateError) throw options.updateError;
          options.updates?.push({ subscriptionId, body });
          return {};
        },
      },
    } as unknown as PaddleBilling['client'],
  };
}

const ORG = 'org_reconcile';

async function seedOrg(db: Db): Promise<{ applicationId: string; customerId: string }> {
  await db.insert(schema.organization).values({ id: ORG, name: 'Acme', slug: 'acme-reconcile' });
  const [application] = await db
    .insert(schema.applications)
    .values({
      organizationId: ORG,
      name: 'shop',
      repoFullName: 'acme/shop',
      repoUrl: 'https://github.com/acme/shop',
    })
    .returning();
  const [customer] = await db
    .insert(schema.customers)
    .values({ organizationId: ORG, name: 'Buyer', email: 'buyer@example.com' })
    .returning();
  return { applicationId: application!.id, customerId: customer!.id };
}

describe('reconcileBilling (Paddle migration Phase 9)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let ids: { applicationId: string; customerId: string };

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    ids = await seedOrg(db);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  beforeEach(async () => {
    await db.delete(schema.billingReconciliationEvents);
    await db.delete(schema.deployments);
    await db.delete(schema.billingSubscriptions);
    await setIncluded(0);
  });

  /** The organization's included production deployments (admin-set allowance). */
  async function setIncluded(included: number): Promise<void> {
    await db
      .update(schema.organization)
      .set({ includedProductionDeployments: included })
      .where(eq(schema.organization.id, ORG));
  }

  async function addDeployment(
    deploymentType: 'TEST' | 'PRODUCTION',
    billingState: 'NOT_STARTED' | 'ACTIVE' | 'STOPPED',
  ): Promise<void> {
    await db.insert(schema.deployments).values({
      organizationId: ORG,
      applicationId: ids.applicationId,
      customerId: ids.customerId,
      region: 'us-east-1',
      enrollmentCode: crypto.randomUUID(),
      deploymentType,
      billingState,
    });
  }

  async function addSubscription(status: 'ACTIVE' | 'PAST_DUE' | 'PAUSED' | 'CANCELED'): Promise<void> {
    await db.insert(schema.billingSubscriptions).values({
      organizationId: ORG,
      providerCustomerId: 'ctm_test_1',
      providerSubscriptionId: 'sub_test_1',
      status,
    });
  }

  function reconciliationRows() {
    return db
      .select()
      .from(schema.billingReconciliationEvents)
      .where(eq(schema.billingReconciliationEvents.organizationId, ORG));
  }

  it('counts only live PRODUCTION deployments — TEST and non-ACTIVE never bill', async () => {
    await addSubscription('ACTIVE');
    await addDeployment('PRODUCTION', 'ACTIVE');
    await addDeployment('PRODUCTION', 'ACTIVE');
    await addDeployment('PRODUCTION', 'NOT_STARTED');
    await addDeployment('PRODUCTION', 'STOPPED');
    await addDeployment('TEST', 'ACTIVE');
    const updates: UpdateCall[] = [];

    const result = await reconcileBilling(
      { db, paddle: fakePaddle({ items: [{ priceId: PRICE_PLATFORM, quantity: 1 }], updates }) },
      ORG,
    );

    expect(result).toMatchObject({ status: 'SUCCEEDED', action: 'ITEM_ADDED', expected: 2, provider: 0 });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.body.items).toEqual([
      { priceId: PRICE_PLATFORM, quantity: 1 },
      { priceId: PRICE_DEPLOYMENT, quantity: 2 },
    ]);
  });

  it('sends the absolute quantity, so running twice is the same as running once', async () => {
    await addSubscription('ACTIVE');
    await addDeployment('PRODUCTION', 'ACTIVE');
    await addDeployment('PRODUCTION', 'ACTIVE');
    await addDeployment('PRODUCTION', 'ACTIVE');
    const updates: UpdateCall[] = [];
    const paddle = fakePaddle({
      items: [
        { priceId: PRICE_PLATFORM, quantity: 1 },
        { priceId: PRICE_DEPLOYMENT, quantity: 1 },
      ],
      updates,
    });

    await reconcileBilling({ db, paddle }, ORG);
    await reconcileBilling({ db, paddle }, ORG);

    // Both passes ask for 3 — never 1 + 2, and never 3 + 3.
    expect(updates.map((u) => u.body.items)).toEqual([
      [
        { priceId: PRICE_PLATFORM, quantity: 1 },
        { priceId: PRICE_DEPLOYMENT, quantity: 3 },
      ],
      [
        { priceId: PRICE_PLATFORM, quantity: 1 },
        { priceId: PRICE_DEPLOYMENT, quantity: 3 },
      ],
    ]);
  });

  it('preserves the platform item and lets Paddle prorate', async () => {
    await addSubscription('ACTIVE');
    await addDeployment('PRODUCTION', 'ACTIVE');
    const updates: UpdateCall[] = [];

    await reconcileBilling(
      {
        db,
        paddle: fakePaddle({
          items: [
            { priceId: PRICE_PLATFORM, quantity: 1 },
            { priceId: PRICE_DEPLOYMENT, quantity: 4 },
          ],
          updates,
        }),
      },
      ORG,
    );

    expect(updates[0]!.body).toMatchObject({
      prorationBillingMode: 'prorated_immediately',
      onPaymentFailure: 'apply_change',
    });
    // The platform item survives: Paddle removes anything left out.
    expect(updates[0]!.body.items).toContainEqual({ priceId: PRICE_PLATFORM, quantity: 1 });
  });

  it('drops the per-deployment item when the last live deployment goes away', async () => {
    await addSubscription('ACTIVE');
    await addDeployment('PRODUCTION', 'STOPPED');
    const updates: UpdateCall[] = [];

    const result = await reconcileBilling(
      {
        db,
        paddle: fakePaddle({
          items: [
            { priceId: PRICE_PLATFORM, quantity: 1 },
            { priceId: PRICE_DEPLOYMENT, quantity: 1 },
          ],
          updates,
        }),
      },
      ORG,
    );

    expect(result).toMatchObject({ status: 'SUCCEEDED', action: 'ITEM_REMOVED', expected: 0, provider: 1 });
    // Zero is not a quantity this price can hold — the item is removed.
    expect(updates[0]!.body.items).toEqual([{ priceId: PRICE_PLATFORM, quantity: 1 }]);
  });

  it('writes no reconciliation row when the provider already agrees, but stamps lastReconciledAt', async () => {
    await addSubscription('ACTIVE');
    await addDeployment('PRODUCTION', 'ACTIVE');
    const updates: UpdateCall[] = [];

    const result = await reconcileBilling(
      {
        db,
        paddle: fakePaddle({
          items: [
            { priceId: PRICE_PLATFORM, quantity: 1 },
            { priceId: PRICE_DEPLOYMENT, quantity: 1 },
          ],
          updates,
        }),
      },
      ORG,
    );

    expect(result).toMatchObject({ status: 'SUCCEEDED', action: 'NONE', expected: 1, provider: 1 });
    expect(updates).toHaveLength(0);
    expect(await reconciliationRows()).toHaveLength(0);
    const [subscription] = await db
      .select()
      .from(schema.billingSubscriptions)
      .where(eq(schema.billingSubscriptions.organizationId, ORG));
    expect(subscription!.lastReconciledAt).not.toBeNull();
  });

  it('records the change it made', async () => {
    await addSubscription('ACTIVE');
    await addDeployment('PRODUCTION', 'ACTIVE');
    await addDeployment('PRODUCTION', 'ACTIVE');

    await reconcileBilling(
      {
        db,
        paddle: fakePaddle({
          items: [
            { priceId: PRICE_PLATFORM, quantity: 1 },
            { priceId: PRICE_DEPLOYMENT, quantity: 5 },
          ],
        }),
      },
      ORG,
    );

    const rows = await reconciliationRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      expectedDeploymentQuantity: 2,
      providerDeploymentQuantity: 5,
      action: 'QUANTITY_UPDATED',
      status: 'SUCCEEDED',
    });
  });

  it('never throws when Paddle fails — it records FAILED and returns', async () => {
    await addSubscription('ACTIVE');
    await addDeployment('PRODUCTION', 'ACTIVE');

    const result = await reconcileBilling(
      { db, paddle: fakePaddle({ items: [], updateError: new Error('paddle is down') }) },
      ORG,
    );

    expect(result).toMatchObject({ status: 'FAILED', expected: 1, reason: 'paddle is down' });
    const rows = await reconciliationRows();
    expect(rows[0]).toMatchObject({ status: 'FAILED', error: 'paddle is down', expectedDeploymentQuantity: 1 });
  });

  it('skips silently when billing is not configured', async () => {
    await addSubscription('ACTIVE');
    await addDeployment('PRODUCTION', 'ACTIVE');

    const result = await reconcileBilling({ db, paddle: null }, ORG);

    expect(result).toMatchObject({ status: 'SKIPPED', reason: 'billing disabled', expected: 1 });
    expect(await reconciliationRows()).toHaveLength(0);
  });

  it('skips an organization in evaluation with nothing to bill, and writes no row', async () => {
    await addDeployment('TEST', 'ACTIVE');

    const result = await reconcileBilling({ db, paddle: fakePaddle({}) }, ORG);

    expect(result).toMatchObject({ status: 'SKIPPED', reason: 'no subscription', expected: 0 });
    expect(await reconciliationRows()).toHaveLength(0);
  });

  it('records the anomaly of a live production deployment with no subscription', async () => {
    await addDeployment('PRODUCTION', 'ACTIVE');

    const result = await reconcileBilling({ db, paddle: fakePaddle({}) }, ORG);

    expect(result).toMatchObject({ status: 'SKIPPED', reason: 'no subscription', expected: 1 });
    const rows = await reconciliationRows();
    expect(rows[0]).toMatchObject({ status: 'SKIPPED', expectedDeploymentQuantity: 1, error: 'no subscription' });
  });

  it.each(['PAUSED', 'CANCELED'] as const)(
    'does not try to update a %s subscription',
    async (status) => {
      await addSubscription(status);
      await addDeployment('PRODUCTION', 'ACTIVE');
      const updates: UpdateCall[] = [];

      const result = await reconcileBilling({ db, paddle: fakePaddle({ updates }) }, ORG);

      expect(result).toMatchObject({ status: 'SKIPPED', reason: `subscription is ${status}` });
      expect(updates).toHaveLength(0);
      expect(await reconciliationRows()).toHaveLength(1);
    },
  );

  it('never resurrects an item Paddle has already deactivated', async () => {
    await addSubscription('ACTIVE');
    await addDeployment('PRODUCTION', 'ACTIVE');
    const updates: UpdateCall[] = [];

    const result = await reconcileBilling(
      {
        db,
        paddle: fakePaddle({
          items: [
            { priceId: PRICE_PLATFORM, quantity: 1 },
            // Removed from the subscription earlier; Paddle keeps the record.
            { priceId: 'pri_retired_test', quantity: 3, status: 'inactive' },
            { priceId: PRICE_DEPLOYMENT, quantity: 9, status: 'inactive' },
          ],
          updates,
        }),
      },
      ORG,
    );

    // The inactive per-deployment item does not count as the current quantity.
    expect(result).toMatchObject({ expected: 1, provider: 0, action: 'ITEM_ADDED' });
    // And neither inactive item is sent back.
    expect(updates[0]!.body.items).toEqual([
      { priceId: PRICE_PLATFORM, quantity: 1 },
      { priceId: PRICE_DEPLOYMENT, quantity: 1 },
    ]);
  });

  it('reconciles a PAST_DUE subscription — Paddle is still billing it', async () => {
    await addSubscription('PAST_DUE');
    await addDeployment('PRODUCTION', 'ACTIVE');
    const updates: UpdateCall[] = [];

    const result = await reconcileBilling(
      { db, paddle: fakePaddle({ items: [{ priceId: PRICE_PLATFORM, quantity: 1 }], updates }) },
      ORG,
    );

    expect(result.status).toBe('SUCCEEDED');
    expect(updates).toHaveLength(1);
  });

  // ── Included production deployments ─────────────────────────────────────
  // The allowance reduces ONLY the per-deployment quantity: Paddle receives
  // max(active - included, 0), never learns the allowance itself, and the
  // platform item is untouched throughout.
  describe('included production deployments', () => {
    const platformOnly = [{ priceId: PRICE_PLATFORM, quantity: 1 }];

    it('subtracts the allowance from the live count', async () => {
      await addSubscription('ACTIVE');
      await setIncluded(2);
      for (let i = 0; i < 5; i += 1) await addDeployment('PRODUCTION', 'ACTIVE');
      const updates: UpdateCall[] = [];

      const result = await reconcileBilling({ db, paddle: fakePaddle({ items: platformOnly, updates }) }, ORG);

      expect(result).toMatchObject({ status: 'SUCCEEDED', action: 'ITEM_ADDED', active: 5, included: 2, expected: 3 });
      expect(updates[0]!.body.items).toEqual([
        { priceId: PRICE_PLATFORM, quantity: 1 },
        { priceId: PRICE_DEPLOYMENT, quantity: 3 },
      ]);
    });

    it('removes the deployment item when every live deployment is included', async () => {
      await addSubscription('ACTIVE');
      await setIncluded(3);
      for (let i = 0; i < 3; i += 1) await addDeployment('PRODUCTION', 'ACTIVE');
      const updates: UpdateCall[] = [];

      const result = await reconcileBilling(
        {
          db,
          paddle: fakePaddle({
            items: [...platformOnly, { priceId: PRICE_DEPLOYMENT, quantity: 3 }],
            updates,
          }),
        },
        ORG,
      );

      expect(result).toMatchObject({ status: 'SUCCEEDED', action: 'ITEM_REMOVED', active: 3, included: 3, expected: 0, provider: 3 });
      // Platform × 1 only — never a $0 line, never a quantity-0 item.
      expect(updates[0]!.body.items).toEqual(platformOnly);
    });

    it('never goes negative when the allowance exceeds the live count', async () => {
      await addSubscription('ACTIVE');
      await setIncluded(10000);
      await addDeployment('PRODUCTION', 'ACTIVE');
      const updates: UpdateCall[] = [];

      const result = await reconcileBilling({ db, paddle: fakePaddle({ items: platformOnly, updates }) }, ORG);

      expect(result).toMatchObject({ status: 'SUCCEEDED', action: 'NONE', active: 1, included: 10000, expected: 0, provider: 0 });
      expect(updates).toHaveLength(0);
    });

    it('a TEST deployment neither counts nor consumes the allowance', async () => {
      await addSubscription('ACTIVE');
      await setIncluded(1);
      await addDeployment('TEST', 'ACTIVE');
      await addDeployment('PRODUCTION', 'ACTIVE');
      const updates: UpdateCall[] = [];

      const result = await reconcileBilling({ db, paddle: fakePaddle({ items: platformOnly, updates }) }, ORG);

      expect(result).toMatchObject({ active: 1, included: 1, expected: 0 });
      expect(updates).toHaveLength(0);
    });

    it('converges to the absolute formula whichever order the allowance and the count change in', async () => {
      await addSubscription('ACTIVE');
      const updates: UpdateCall[] = [];
      const paddle = fakePaddle({ items: platformOnly, updates });

      // 2 live, allowance 0 → 2; allowance becomes 2 → item removed; a third
      // deployment goes live → 1; allowance back to 0 → 3. Every pass sends the
      // absolute quantity for the state at that moment.
      await addDeployment('PRODUCTION', 'ACTIVE');
      await addDeployment('PRODUCTION', 'ACTIVE');
      expect((await reconcileBilling({ db, paddle }, ORG)).expected).toBe(2);
      await setIncluded(2);
      expect((await reconcileBilling({ db, paddle }, ORG)).expected).toBe(0);
      await addDeployment('PRODUCTION', 'ACTIVE');
      expect((await reconcileBilling({ db, paddle }, ORG)).expected).toBe(1);
      await setIncluded(0);
      expect((await reconcileBilling({ db, paddle }, ORG)).expected).toBe(3);

      // The fake always reports the platform item only (provider 0), so the
      // pass that expected 0 was a no-op and every other pass pushed.
      expect(updates.map((u) => u.body.items.find((i) => i.priceId === PRICE_DEPLOYMENT)?.quantity ?? 0)).toEqual([
        2, 1, 3,
      ]);
    });

    it('with no subscription the allowance changes nothing: no Paddle call, no ledger row', async () => {
      await setIncluded(3);
      await addDeployment('PRODUCTION', 'ACTIVE');
      const updates: UpdateCall[] = [];

      const result = await reconcileBilling({ db, paddle: fakePaddle({ items: platformOnly, updates }) }, ORG);

      expect(result).toMatchObject({ status: 'SKIPPED', reason: 'no subscription', active: 1, included: 3, expected: 0 });
      expect(updates).toHaveLength(0);
      // Nothing should be billed, so the "live deployment with no
      // subscription" anomaly row is not written either.
      expect(await reconciliationRows()).toHaveLength(0);
    });

    it('a Paddle failure records the expected quantity under the allowance for the retry', async () => {
      await addSubscription('ACTIVE');
      await setIncluded(1);
      for (let i = 0; i < 4; i += 1) await addDeployment('PRODUCTION', 'ACTIVE');

      const result = await reconcileBilling(
        { db, paddle: fakePaddle({ items: platformOnly, updateError: new Error('paddle down') }) },
        ORG,
      );

      expect(result).toMatchObject({ status: 'FAILED', expected: 3, reason: 'paddle down' });
      const rows = await reconciliationRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ expectedDeploymentQuantity: 3, status: 'FAILED' });
    });
  });
});
