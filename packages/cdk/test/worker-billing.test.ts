import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { sweepBilling } from '../src/lambda/worker.js';

// Paddle migration Phase 10 — the billing safety net. Every billing write in
// the request path is best-effort by design, so a Paddle failure can never
// fail a deployment; this sweep is what makes that safe. It runs on the same
// 15-minute schedule as the watchdogs.

const PRICE_PLATFORM = 'pri_platform_test';
const PRICE_DEPLOYMENT = 'pri_deployment_test';

interface UpdateCall {
  items: { priceId: string; quantity: number }[];
}

/** A Paddle double — no test reaches the Paddle API. */
function fakePaddle(updates: UpdateCall[] = []): Parameters<typeof sweepBilling>[1] {
  return {
    config: {
      apiKey: 'test_replace_me',
      webhookSecret: 'test_replace_me',
      clientToken: 'pdl_sdbx_replace_me',
      pricePlatform: PRICE_PLATFORM,
      priceDeployment: PRICE_DEPLOYMENT,
      environment: 'sandbox' as const,
    },
    client: {
      subscriptions: {
        get: async () => ({
          items: [{ price: { id: PRICE_PLATFORM }, quantity: 1, status: 'active' }],
        }),
        update: async (_id: string, body: UpdateCall) => {
          updates.push(body);
          return {};
        },
      },
    },
  } as unknown as Parameters<typeof sweepBilling>[1];
}

const READY_TIMING = { READY: { startedAt: '2026-09-01T00:00:00.000Z' } };

describe('sweepBilling (Paddle migration Phase 10)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let organizationId: string;
  let applicationId: string;
  let customerId: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    const [org] = await db
      .insert(schema.organization)
      .values({ id: 'org-billing-sweep', name: 'Sweep Org', slug: 'sweep-org-1234' })
      .returning();
    organizationId = org!.id;
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'Sweep App',
        repoFullName: 'acme/sweep',
        repoUrl: 'https://github.com/acme/sweep',
      })
      .returning();
    applicationId = application!.id;
    const [customer] = await db
      .insert(schema.customers)
      .values({ organizationId, name: 'Acme', email: 'sweep@acme.test' })
      .returning();
    customerId = customer!.id;
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  async function insertDeployment(overrides: Partial<typeof schema.deployments.$inferInsert> = {}) {
    const [row] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        enrollmentCode: randomUUID(),
        deploymentType: 'PRODUCTION',
        ...overrides,
      })
      .returning();
    return row!;
  }

  it('promotes a PRODUCTION deployment that reached READY but never started billing', async () => {
    const deployment = await insertDeployment({ state: 'HEALTHY', stepTimings: READY_TIMING });

    const result = await sweepBilling(db, null);

    expect(result.promoted).toBe(1);
    const [fresh] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id));
    expect(fresh!.billingState).toBe('ACTIVE');
    expect(fresh!.billingStartedAt).not.toBeNull();
  });

  it('is idempotent — a second pass promotes nothing', async () => {
    const result = await sweepBilling(db, null);
    expect(result.promoted).toBe(0);
  });

  it('never promotes a TEST deployment, one short of READY, or one being removed', async () => {
    await insertDeployment({ deploymentType: 'TEST', state: 'HEALTHY', stepTimings: READY_TIMING });
    await insertDeployment({
      state: 'INSTALLING',
      stepTimings: { APPLICATION: { startedAt: '2026-09-01T00:00:00.000Z' } },
    });
    // Being torn down: the billing state machine deliberately ignores
    // `state`, so the sweep itself must exclude these — otherwise it would
    // start billing a deployment on its way out.
    const deleting = await insertDeployment({ state: 'DELETING', stepTimings: READY_TIMING });
    const deleted = await insertDeployment({ state: 'DELETED', stepTimings: READY_TIMING });

    const result = await sweepBilling(db, null);

    expect(result.promoted).toBe(0);
    for (const row of [deleting, deleted]) {
      const [fresh] = await db
        .select()
        .from(schema.deployments)
        .where(eq(schema.deployments.id, row.id));
      expect(fresh!.billingState).toBe('NOT_STARTED');
    }
  });

  it('releases a webhook event abandoned in RECEIVED so the redelivery is processed', async () => {
    const [abandoned] = await db
      .insert(schema.billingProviderEvents)
      .values({
        providerEventId: 'evt_sweep_abandoned',
        eventType: 'subscription.activated',
        occurredAt: new Date('2026-09-01T00:00:00.000Z'),
        processingStatus: 'RECEIVED',
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
      })
      .returning();
    const [recent] = await db
      .insert(schema.billingProviderEvents)
      .values({
        providerEventId: 'evt_sweep_recent',
        eventType: 'subscription.activated',
        occurredAt: new Date(),
        processingStatus: 'RECEIVED',
      })
      .returning();

    const result = await sweepBilling(db, null);

    expect(result.unstuck).toBe(1);
    const [released] = await db
      .select()
      .from(schema.billingProviderEvents)
      .where(eq(schema.billingProviderEvents.id, abandoned!.id));
    expect(released!.processingStatus).toBe('FAILED');
    // A row claimed moments ago is still being processed — leave it alone.
    const [untouched] = await db
      .select()
      .from(schema.billingProviderEvents)
      .where(eq(schema.billingProviderEvents.id, recent!.id));
    expect(untouched!.processingStatus).toBe('RECEIVED');
  });

  it('reconciles a subscription that has never been reconciled, and stamps it', async () => {
    await db.insert(schema.billingSubscriptions).values({
      organizationId,
      providerCustomerId: 'ctm_sweep_1',
      providerSubscriptionId: 'sub_sweep_1',
      status: 'ACTIVE',
    });
    const updates: UpdateCall[] = [];

    const result = await sweepBilling(db, fakePaddle(updates));

    expect(result.reconciled).toBe(1);
    // One deployment reached ACTIVE in the first test of this file.
    expect(updates).toEqual([
      expect.objectContaining({
        items: [
          { priceId: PRICE_PLATFORM, quantity: 1 },
          { priceId: PRICE_DEPLOYMENT, quantity: 1 },
        ],
      }),
    ]);
    const [subscription] = await db
      .select()
      .from(schema.billingSubscriptions)
      .where(eq(schema.billingSubscriptions.organizationId, organizationId));
    expect(subscription!.lastReconciledAt).not.toBeNull();
  });

  it('leaves a freshly reconciled subscription alone', async () => {
    const result = await sweepBilling(db, fakePaddle());
    expect(result.reconciled).toBe(0);
  });
});

// Included production deployments (Phase 12): the sweep runs the SAME
// reconcileBilling as everything else, so it repairs drift to the allowance
// formula without any allowance-specific scheduling of its own.
describe('sweepBilling respects the included production deployment allowance', () => {
  let client: PGlite | undefined;
  let db: Db;
  const organizationId = 'org-billing-sweep-allowance';
  let applicationId: string;
  let customerId: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    await db.insert(schema.organization).values({
      id: organizationId,
      name: 'Allowance Org',
      slug: 'allowance-org-1234',
      includedProductionDeployments: 2,
    });
    const [application] = await db
      .insert(schema.applications)
      .values({ organizationId, name: 'App', repoFullName: 'acme/allow', repoUrl: 'https://github.com/acme/allow' })
      .returning();
    applicationId = application!.id;
    const [customer] = await db
      .insert(schema.customers)
      .values({ organizationId, name: 'Acme', email: 'allow@acme.test' })
      .returning();
    customerId = customer!.id;
    await db.insert(schema.billingSubscriptions).values({
      organizationId,
      providerCustomerId: 'ctm_allow',
      providerSubscriptionId: 'sub_allow',
      status: 'ACTIVE',
      // Never reconciled: the drift sweep must pick it up on the first pass.
      lastReconciledAt: null,
    });
    for (let i = 0; i < 5; i += 1) {
      await db.insert(schema.deployments).values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        enrollmentCode: randomUUID(),
        deploymentType: 'PRODUCTION',
        billingState: 'ACTIVE',
      });
    }
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('repairs Paddle to max(active − included, 0): 5 live, 2 included, Paddle had 4 → 3', async () => {
    const updates: UpdateCall[] = [];
    const paddle = {
      ...fakePaddle(updates),
      client: {
        subscriptions: {
          get: async () => ({
            items: [
              { price: { id: PRICE_PLATFORM }, quantity: 1, status: 'active' },
              { price: { id: PRICE_DEPLOYMENT }, quantity: 4, status: 'active' },
            ],
          }),
          update: async (_id: string, body: UpdateCall) => {
            updates.push(body);
            return {};
          },
        },
      },
    } as unknown as Parameters<typeof sweepBilling>[1];

    const result = await sweepBilling(db, paddle);

    expect(result.reconciled).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.items).toEqual([
      { priceId: PRICE_PLATFORM, quantity: 1 },
      { priceId: PRICE_DEPLOYMENT, quantity: 3 },
    ]);
    const [ledger] = await db
      .select()
      .from(schema.billingReconciliationEvents)
      .where(eq(schema.billingReconciliationEvents.organizationId, organizationId));
    expect(ledger).toMatchObject({ expectedDeploymentQuantity: 3, providerDeploymentQuantity: 4, status: 'SUCCEEDED' });
  });

  it('a repeated pass within the hour is a no-op', async () => {
    const updates: UpdateCall[] = [];
    const result = await sweepBilling(db, fakePaddle(updates));
    expect(result.reconciled).toBe(0);
    expect(updates).toHaveLength(0);
  });
});
