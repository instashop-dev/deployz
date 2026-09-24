import { and, eq, gt, isNull, like } from 'drizzle-orm';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { vendorSecretContext } from './config.js';
import { createCipherStub, type SecretCipher } from './pending-secrets.js';

// KMS fix, phase 2 (docs/pending-secret-delivery.md § Legacy rows): before the
// control-plane KMS key existed, production stored secrets with the dev
// cipher stub (`enc:<base64 context>:<base64 plaintext>`). This is the ONLY
// place that still decodes that format. The production cipher refuses it,
// so a legacy row is never delivered as-is. Remove this module once the
// watchdog inventory shows zero `stub` rows.

const LEGACY_PREFIX = 'enc:';
const legacyStub = createCipherStub();

export interface LegacyMigrationCounts {
  /** Re-encrypted with the KMS cipher. */
  migrated: number;
  /** Undecodable (malformed / context mismatch): vendor → re-entry, pending → recollection. */
  unusable: number;
  /** A concurrent edit changed the row first; nothing was written. */
  skipped: number;
  /** KMS or DB error; the row is left as-is for the next tick. */
  failed: number;
}

const emptyCounts = (): LegacyMigrationCounts => ({ migrated: 0, unusable: 0, skipped: 0, failed: 0 });

/**
 * Re-encrypts up to `limit` legacy vendor secrets and `limit` active legacy
 * pending secrets with `cipher` (the production KMS cipher). Idempotent and
 * resumable: it selects only `enc:` rows, and every write is conditional on
 * the ciphertext it read, so a concurrent edit wins and a rerun continues
 * where the last one stopped. Expired pending rows are left to the expiry
 * sweep — reads already refuse them. Returns counts only and swallows
 * per-row errors: a failed query's message carries its parameters, which
 * can include a legacy (decodable) value.
 */
export async function migrateLegacyConfigSecrets(
  db: RuntimeDb,
  cipher: SecretCipher,
  options: { limit?: number; now?: Date } = {},
): Promise<{ vendor: LegacyMigrationCounts; pending: LegacyMigrationCounts }> {
  const limit = options.limit ?? 100;
  const now = options.now ?? new Date();
  const vendor = emptyCounts();
  const pending = emptyCounts();

  const vendorRows = await db
    .select({
      id: schema.applicationConfigs.id,
      applicationId: schema.applicationConfigs.applicationId,
      key: schema.applicationConfigs.key,
      encryptedValue: schema.applicationConfigs.encryptedValue,
      organizationId: schema.applications.organizationId,
    })
    .from(schema.applicationConfigs)
    .innerJoin(schema.applications, eq(schema.applications.id, schema.applicationConfigs.applicationId))
    .where(
      and(
        isNull(schema.applicationConfigs.customerId),
        eq(schema.applicationConfigs.isSecret, true),
        like(schema.applicationConfigs.encryptedValue, `${LEGACY_PREFIX}%`),
      ),
    )
    .limit(limit);

  for (const row of vendorRows) {
    const legacy = row.encryptedValue!;
    const context = vendorSecretContext(row.organizationId, row.applicationId, row.key);
    const unchanged = and(
      eq(schema.applicationConfigs.id, row.id),
      eq(schema.applicationConfigs.encryptedValue, legacy),
    );
    let plaintext: string;
    try {
      plaintext = await legacyStub.decrypt(legacy, context);
    } catch {
      // Clearing the ciphertext is the existing vendor re-entry state
      // (`needsReentry`; not counted as provided by the readiness gate).
      try {
        const cleared = await db
          .update(schema.applicationConfigs)
          .set({ encryptedValue: null, updatedAt: new Date() })
          .where(unchanged)
          .returning();
        if (cleared.length > 0) vendor.unusable += 1;
        else vendor.skipped += 1;
      } catch {
        vendor.failed += 1;
      }
      continue;
    }
    try {
      const { ciphertext } = await cipher.encrypt(plaintext, context);
      const updated = await db
        .update(schema.applicationConfigs)
        .set({ encryptedValue: ciphertext, updatedAt: new Date() })
        .where(unchanged)
        .returning();
      if (updated.length > 0) vendor.migrated += 1;
      else vendor.skipped += 1;
    } catch {
      vendor.failed += 1;
    }
  }

  const pendingRows = await db
    .select({
      id: schema.pendingSecrets.id,
      ciphertext: schema.pendingSecrets.ciphertext,
      encryptionContext: schema.pendingSecrets.encryptionContext,
    })
    .from(schema.pendingSecrets)
    .where(
      and(
        like(schema.pendingSecrets.ciphertext, `${LEGACY_PREFIX}%`),
        gt(schema.pendingSecrets.expiresAt, now),
      ),
    )
    .limit(limit);

  for (const row of pendingRows) {
    const unchanged = and(
      eq(schema.pendingSecrets.id, row.id),
      eq(schema.pendingSecrets.ciphertext, row.ciphertext),
    );
    let plaintext: string;
    try {
      plaintext = await legacyStub.decrypt(row.ciphertext, row.encryptionContext);
    } catch {
      // Deleting the row is the existing recollection path: the key shows
      // as unbound and the customer re-enters the value.
      try {
        const deleted = await db
          .delete(schema.pendingSecrets)
          .where(unchanged)
          .returning();
        if (deleted.length > 0) pending.unusable += 1;
        else pending.skipped += 1;
      } catch {
        pending.failed += 1;
      }
      continue;
    }
    try {
      const { ciphertext } = await cipher.encrypt(plaintext, row.encryptionContext);
      const updated = await db
        .update(schema.pendingSecrets)
        .set({ ciphertext, updatedAt: new Date() })
        .where(unchanged)
        .returning();
      if (updated.length > 0) pending.migrated += 1;
      else pending.skipped += 1;
    } catch {
      pending.failed += 1;
    }
  }

  return { vendor, pending };
}
