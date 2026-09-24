import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { inventoryConfigSecrets } from '../src/lambda/worker.js';

describe('inventoryConfigSecrets', () => {
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
      .values({ id: 'org-secret-inventory', name: 'Inventory Org', slug: 'inventory-org' })
      .returning();
    organizationId = org!.id;
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'App',
        repoFullName: 'acme/inventory-app',
        repoUrl: 'https://github.com/acme/inventory-app',
        defaultBranch: 'main',
      })
      .returning();
    applicationId = application!.id;
    const [customer] = await db
      .insert(schema.customers)
      .values({ organizationId, name: 'Cust', email: 'inventory@example.test' })
      .returning();
    customerId = customer!.id;
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('counts rows by format, state, tier, and age without reading values', async () => {
    const day = 24 * 60 * 60 * 1000;
    await db.insert(schema.applicationConfigs).values([
      { applicationId, key: 'STUB_SECRET', value: '••••', isSecret: true, encryptedValue: 'enc:aGFzaA==:c2VjcmV0' },
      { applicationId, key: 'KMS_SECRET', value: '••••', isSecret: true, encryptedValue: 'kms1:AQID' },
      { applicationId, key: 'LEGACY_SECRET', value: '••••', isSecret: true, encryptedValue: null },
      { applicationId, key: 'PLAIN', value: 'visible', isSecret: false },
      { applicationId, customerId, key: 'CUSTOMER_SECRET', value: '••••', isSecret: true },
    ]);
    await db.insert(schema.pendingSecrets).values([
      {
        organizationId,
        applicationId,
        customerId,
        key: 'ACTIVE',
        ciphertext: 'enc:aGFzaA==:c2VjcmV0',
        encryptionContext: { organizationId },
        expiresAt: new Date(Date.now() + day),
      },
      {
        organizationId,
        applicationId,
        customerId,
        key: 'EXPIRED',
        ciphertext: 'enc:aGFzaA==:c2VjcmV0',
        encryptionContext: { organizationId },
        expiresAt: new Date(Date.now() - day),
      },
    ]);

    const inventory = await inventoryConfigSecrets(db);

    expect(inventory.vendor).toEqual({ 'stub/lt1d': 1, 'kms1/lt1d': 1, 'none/lt1d': 1 });
    expect(inventory.customerScopeCiphertext).toBe(0);
    expect(inventory.pending).toEqual({
      'stub/active/staged/undelivered/lt1d': 1,
      'stub/expired/staged/undelivered/lt1d': 1,
    });
    expect(JSON.stringify(inventory)).not.toContain('c2VjcmV0');
  });
});
