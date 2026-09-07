import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Db } from './client.js';
import { billingProviderEvents, billingSubscriptions } from './schema/index.js';
import { createTestDb, seedBase, type BaseIds } from './test-utils.js';

// drizzle-orm wraps driver errors as `Failed query: ...`; the underlying
// Postgres message (constraint name) lives on error.cause.
async function expectPgError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    const message = cause instanceof Error ? cause.message : String(cause ?? error);
    expect(message).toMatch(pattern);
    return;
  }
  throw new Error(`expected rejection matching ${pattern}, but the query succeeded`);
}

// Paddle migration Phase 3 — billing_subscriptions is one row per
// organization; billing_provider_events dedupes a redelivered webhook at the
// database, not only in application code.
describe('billing schema constraints', () => {
  let client: PGlite | undefined;
  let db: Db | undefined;
  let ids: BaseIds;

  beforeAll(async () => {
    ({ client, db } = await createTestDb());
    ids = await seedBase(db);
  });

  afterAll(async () => {
    await client?.close();
  });

  it('rejects a second billing_subscriptions row for the same organization', async () => {
    await db!.insert(billingSubscriptions).values({
      organizationId: ids.organizationId,
      providerCustomerId: 'ctm_1',
      providerSubscriptionId: 'sub_1',
      status: 'ACTIVE',
    });
    await expectPgError(
      db!.insert(billingSubscriptions).values({
        organizationId: ids.organizationId,
        providerCustomerId: 'ctm_2',
        providerSubscriptionId: 'sub_2',
        status: 'ACTIVE',
      }),
      /duplicate key value violates unique constraint/,
    );
  });

  it('rejects a duplicate billing_provider_events.provider_event_id', async () => {
    await db!.insert(billingProviderEvents).values({
      providerEventId: 'evt_1',
      eventType: 'subscription.activated',
      occurredAt: new Date(),
    });
    await expectPgError(
      db!.insert(billingProviderEvents).values({
        providerEventId: 'evt_1',
        eventType: 'subscription.updated',
        occurredAt: new Date(),
      }),
      /duplicate key value violates unique constraint/,
    );
  });
});
