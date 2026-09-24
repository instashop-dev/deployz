import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { listProvidedConfigKeys, listVendorValues, vendorSecretContext } from './config.js';
import { migrateLegacyConfigSecrets } from './legacy-secret-migration.js';
import { createCipherStub, createDrizzlePendingSecretStore, type SecretCipher } from './pending-secrets.js';

// Stands in for the KMS cipher: `kms1:` + an opaque body, context-bound, and
// it refuses anything that is not `kms1:` — the same surface as the real one.
function fakeKmsCipher(onEncrypt?: () => Promise<void>): SecretCipher {
  const inner = createCipherStub();
  return {
    async encrypt(plaintext, context) {
      await onEncrypt?.();
      const { ciphertext } = await inner.encrypt(plaintext, context);
      return { ciphertext: `kms1:${Buffer.from(ciphertext).toString('base64')}`, encryptionContext: context };
    },
    async decrypt(ciphertext, context) {
      if (!ciphertext.startsWith('kms1:')) throw new Error('not kms1');
      return inner.decrypt(Buffer.from(ciphertext.slice(5), 'base64').toString(), context);
    },
  };
}

const failingKms: SecretCipher = {
  async encrypt() {
    throw new Error('KMS unavailable');
  },
  async decrypt() {
    throw new Error('KMS unavailable');
  },
};

describe('migrateLegacyConfigSecrets', () => {
  let client: PGlite | undefined;
  let db: Db;
  let organizationId: string;
  let applicationId: string;
  let customerId: string;
  const legacy = createCipherStub();
  const day = 24 * 60 * 60 * 1000;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    const [org] = await db
      .insert(schema.organization)
      .values({ id: 'org-legacy-migration', name: 'Legacy Org', slug: 'legacy-org' })
      .returning();
    organizationId = org!.id;
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'App',
        repoFullName: 'acme/legacy-app',
        repoUrl: 'https://github.com/acme/legacy-app',
        defaultBranch: 'main',
      })
      .returning();
    applicationId = application!.id;
    const [customer] = await db
      .insert(schema.customers)
      .values({ organizationId, name: 'Cust', email: 'legacy@example.test' })
      .returning();
    customerId = customer!.id;
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  beforeEach(async () => {
    await db.delete(schema.pendingSecrets);
    await db.delete(schema.applicationConfigs);
  });

  async function seedVendor(key: string, plaintext: string, contextKey = key): Promise<string> {
    const { ciphertext } = await legacy.encrypt(plaintext, vendorSecretContext(organizationId, applicationId, contextKey));
    const [row] = await db
      .insert(schema.applicationConfigs)
      .values({ applicationId, key, value: '••••', isSecret: true, encryptedValue: ciphertext })
      .returning();
    return row!.id;
  }

  async function seedPending(key: string, plaintext: string, expiresAt: Date, corrupt = false): Promise<string> {
    const context = { organizationId, applicationId, key, customerId };
    const { ciphertext } = await legacy.encrypt(plaintext, context);
    const [row] = await db
      .insert(schema.pendingSecrets)
      .values({
        organizationId,
        applicationId,
        customerId,
        key,
        ciphertext: corrupt ? 'enc:malformed' : ciphertext,
        encryptionContext: context,
        expiresAt,
      })
      .returning();
    return row!.id;
  }

  it('re-encrypts legacy vendor and active pending rows, then delivers them through KMS', async () => {
    await seedVendor('API_TOKEN', 'vendor-plaintext');
    await seedPending('DB_PASSWORD', 'customer-plaintext', new Date(Date.now() + day));
    const kms = fakeKmsCipher();

    // Before migration the production cipher refuses the legacy value.
    expect(await listVendorValues(db, applicationId, ['API_TOKEN'], kms)).toEqual({});

    const counts = await migrateLegacyConfigSecrets(db, kms);
    expect(counts.vendor).toEqual({ migrated: 1, unusable: 0, skipped: 0, failed: 0 });
    expect(counts.pending).toEqual({ migrated: 1, unusable: 0, skipped: 0, failed: 0 });
    expect(JSON.stringify(counts)).not.toContain('plaintext');

    const [vendorRow] = await db.select().from(schema.applicationConfigs);
    expect(vendorRow!.encryptedValue!.startsWith('kms1:')).toBe(true);
    expect(await listVendorValues(db, applicationId, ['API_TOKEN'], kms)).toEqual({ API_TOKEN: 'vendor-plaintext' });

    const [pendingRow] = await db.select().from(schema.pendingSecrets);
    expect(pendingRow!.ciphertext.startsWith('kms1:')).toBe(true);
    await expect(kms.decrypt(pendingRow!.ciphertext, pendingRow!.encryptionContext)).resolves.toBe('customer-plaintext');
    const store = createDrizzlePendingSecretStore(db, kms);
    await expect(
      store.materializeForDeployment({ organizationId, id: crypto.randomUUID(), applicationId, customerId }),
    ).resolves.toEqual([{ key: 'DB_PASSWORD', plaintext: 'customer-plaintext' }]);
  });

  it('is idempotent: a rerun finds nothing left to migrate', async () => {
    await seedVendor('API_TOKEN', 'vendor-plaintext');
    const kms = fakeKmsCipher();
    await migrateLegacyConfigSecrets(db, kms);
    const [before] = await db.select().from(schema.applicationConfigs);
    const rerun = await migrateLegacyConfigSecrets(db, kms);
    expect(rerun.vendor).toEqual({ migrated: 0, unusable: 0, skipped: 0, failed: 0 });
    const [after] = await db.select().from(schema.applicationConfigs);
    expect(after!.encryptedValue).toBe(before!.encryptedValue);
  });

  it('resumes in bounded batches', async () => {
    await seedVendor('A', 'a');
    await seedVendor('B', 'b');
    await seedVendor('C', 'c');
    const kms = fakeKmsCipher();
    expect((await migrateLegacyConfigSecrets(db, kms, { limit: 2 })).vendor.migrated).toBe(2);
    expect((await migrateLegacyConfigSecrets(db, kms, { limit: 2 })).vendor.migrated).toBe(1);
    const rows = await db.select().from(schema.applicationConfigs);
    expect(rows.every((row) => row.encryptedValue!.startsWith('kms1:'))).toBe(true);
  });

  it('sends an undecodable vendor row to re-entry and drops an undecodable pending row', async () => {
    // Encrypted under another key name → context mismatch on decode.
    await seedVendor('API_TOKEN', 'vendor-plaintext', 'OTHER_KEY');
    await seedPending('DB_PASSWORD', 'x', new Date(Date.now() + day), true);

    const counts = await migrateLegacyConfigSecrets(db, fakeKmsCipher());
    expect(counts.vendor.unusable).toBe(1);
    expect(counts.pending.unusable).toBe(1);

    const [vendorRow] = await db.select().from(schema.applicationConfigs);
    expect(vendorRow!.encryptedValue).toBeNull();
    expect(await listProvidedConfigKeys(db, applicationId, null)).not.toContain('API_TOKEN');
    expect(await db.select().from(schema.pendingSecrets)).toHaveLength(0);
  });

  it('never overwrites a concurrent edit', async () => {
    const id = await seedVendor('API_TOKEN', 'old');
    const kms = fakeKmsCipher(async () => {
      await db
        .update(schema.applicationConfigs)
        .set({ encryptedValue: 'kms1:concurrent-edit' })
        .where(eq(schema.applicationConfigs.id, id));
    });
    const counts = await migrateLegacyConfigSecrets(db, kms);
    expect(counts.vendor).toEqual({ migrated: 0, unusable: 0, skipped: 1, failed: 0 });
    const [row] = await db.select().from(schema.applicationConfigs);
    expect(row!.encryptedValue).toBe('kms1:concurrent-edit');
  });

  it('leaves rows untouched when KMS is unavailable, for the next tick to retry', async () => {
    await seedVendor('API_TOKEN', 'vendor-plaintext');
    await seedPending('DB_PASSWORD', 'customer-plaintext', new Date(Date.now() + day));
    const counts = await migrateLegacyConfigSecrets(db, failingKms);
    expect(counts.vendor.failed).toBe(1);
    expect(counts.pending.failed).toBe(1);
    const [vendorRow] = await db.select().from(schema.applicationConfigs);
    expect(vendorRow!.encryptedValue!.startsWith('enc:')).toBe(true);
  });

  it('does not touch expired pending rows (reads refuse them; the expiry sweep deletes them)', async () => {
    await seedPending('DB_PASSWORD', 'customer-plaintext', new Date(Date.now() - day));
    const counts = await migrateLegacyConfigSecrets(db, fakeKmsCipher());
    expect(counts.pending).toEqual({ migrated: 0, unusable: 0, skipped: 0, failed: 0 });
    const store = createDrizzlePendingSecretStore(db, fakeKmsCipher());
    await expect(
      store.materializeForDeployment({ organizationId, id: crypto.randomUUID(), applicationId, customerId }),
    ).resolves.toEqual([]);
  });
});
