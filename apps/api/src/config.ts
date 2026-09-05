import { and, eq, isNull, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { ApiError, NotFoundError } from './errors.js';
import { enqueue } from './queue.js';

// §31 application configuration API — vendor defaults (customer_id NULL)
// vs customer-specific overrides, with write-only secrets.
//
// Secret boundary (§31): secret values are write-only. They are written to
// the CUSTOMER's Secrets Manager via the relay write-through (todo 18's
// CONFIG_UPDATE workflow) and are NEVER stored in the control-plane DB in
// plaintext — the row carries the SECRET_MASK placeholder so key precedence
// and the isSecret flag keep working. The API NEVER returns a plaintext
// secret: masked views carry `value: null` for isSecret entries.
//
// Seams (same graceful-degradation pattern as billing/github): ConfigStore
// is the DB boundary (drizzle impl below, mocked in unit tests) and
// ConfigSecretWriter is the relay write-through (a no-op stub by default —
// the real relay dispatch plumbing lands with the deployment wiring; unit
// tests inject a mock).

// ── Types ─────────────────────────────────────────────────────────────────

/** A single config entry (§31). Also the stored row shape the store returns. */
export interface ConfigEntry {
  readonly key: string;
  readonly value: string;
  readonly isSecret: boolean;
}

/** A config entry as the API returns it — secrets NEVER carry a value. */
export interface MaskedConfigEntry {
  readonly key: string;
  readonly isSecret: boolean;
  /** Null for secrets (write-only, §31); the plaintext value otherwise. */
  readonly value: string | null;
  /**
   * True when Deployz generated this secret (Stage B phase 4) — the vendor
   * did not type it. Derived from the stored marker, never from plaintext.
   */
  readonly generated?: boolean;
}

/** The effective entry after merging vendor defaults with customer overrides. */
export interface EffectiveConfigEntry extends MaskedConfigEntry {
  /** Where the effective value comes from — customer overrides win (§31). */
  readonly source: 'vendor' | 'customer';
  /** The vendor default when a customer override is in effect (null for secrets). */
  readonly vendorValue: string | null;
}

/** Everything the config screen needs for one application + customer scope. */
export interface ApplicationConfigView {
  readonly applicationId: string;
  /** Null when viewing vendor defaults; the customer id when scoped. */
  readonly customerId: string | null;
  readonly vendorDefaults: readonly MaskedConfigEntry[];
  readonly customerOverrides: readonly MaskedConfigEntry[];
  readonly effective: readonly EffectiveConfigEntry[];
}

// ── Request validation (route boundary) ───────────────────────────────────

export const configEntrySchema = z.object({
  key: z.string().min(1),
  value: z.string(),
  isSecret: z.boolean(),
});

export const setConfigBodySchema = z.object({
  /** Null/absent = write vendor defaults; a customer id = write overrides. */
  customerId: z.string().min(1).nullish(),
  entries: z.array(configEntrySchema).max(200),
  /**
   * Keys to remove in this same write. Adds, edits and removals travel
   * together so one Save is one atomic change to the scope. Without this
   * there was no delete path at all — not in the UI, and not by omitting an
   * entry, since setConfig only ever upserted what it was given.
   */
  deletes: z.array(z.string().min(1)).max(200).optional(),
});

// ── Seams ─────────────────────────────────────────────────────────────────

/** DB boundary for application_configs (+ the application existence check). */
export interface ConfigStore {
  applicationExists(applicationId: string): Promise<boolean>;
  /** Rows for the vendor scope (customerId null) or one customer's overrides. */
  list(applicationId: string, customerId: string | null): Promise<readonly ConfigEntry[]>;
  upsert(applicationId: string, customerId: string | null, entry: ConfigEntry): Promise<void>;
  /** Remove one key from a scope. Absent keys are not an error. */
  remove(applicationId: string, customerId: string | null, key: string): Promise<void>;
}

/**
 * §31 relay write-through: writes secret entries to the CUSTOMER's Secrets
 * Manager via the relay. The control plane never persists plaintext secrets.
 */
export interface ConfigSecretWriter {
  writeSecrets(customerId: string, entries: readonly ConfigEntry[]): Promise<void>;
  /**
   * Remove secrets from the CUSTOMER's own secret store. A key deleted here
   * must not keep existing in their account — the control plane never held
   * the plaintext, so the relay is the only thing that can remove it.
   */
  removeSecrets(customerId: string, keys: readonly string[]): Promise<void>;
}

export interface ConfigDeps {
  readonly store: ConfigStore;
  readonly secretWriter: ConfigSecretWriter;
}

// ── Secret masking (§31 write-only) ───────────────────────────────────────

/** Placeholder stored/emitted in place of a secret value (never plaintext). */
export const SECRET_MASK = '***';
/**
 * Stored marker for a Deployz-GENERATED secret (Stage B phase 4). Distinct
 * from SECRET_MASK so the API can tell "the vendor typed a secret" from
 * "Deployz generated one" without ever storing the plaintext. Both are
 * masks — neither is a value.
 */
export const GENERATED_SECRET_MASK = '***deployz-generated***';

/** Mask one entry for the API boundary — secrets lose their value entirely. */
export function toMaskedEntry(entry: ConfigEntry): MaskedConfigEntry {
  if (!entry.isSecret) return { key: entry.key, isSecret: false, value: entry.value };
  const generated = entry.value === GENERATED_SECRET_MASK;
  return generated
    ? { key: entry.key, isSecret: true, value: null, generated: true }
    : { key: entry.key, isSecret: true, value: null };
}

// ── Vendor/customer merge (pure) ──────────────────────────────────────────

/**
 * Merge vendor defaults with customer overrides into the effective config
 * (§31: a customer override takes precedence over the vendor default with the
 * same key). Order is stable: vendor-default order first, then customer-only
 * keys. All values are masked — secrets never surface here.
 */
export function mergeConfigEntries(
  vendorDefaults: readonly ConfigEntry[],
  customerOverrides: readonly ConfigEntry[],
): EffectiveConfigEntry[] {
  const order: string[] = [];
  const byKey = new Map<string, EffectiveConfigEntry>();

  for (const row of vendorDefaults) {
    order.push(row.key);
    byKey.set(row.key, { ...toMaskedEntry(row), source: 'vendor', vendorValue: null });
  }
  for (const row of customerOverrides) {
    const vendor = byKey.get(row.key);
    const masked = toMaskedEntry(row);
    if (vendor) {
      byKey.set(row.key, { ...masked, source: 'customer', vendorValue: vendor.value });
    } else {
      order.push(row.key);
      byKey.set(row.key, { ...masked, source: 'customer', vendorValue: null });
    }
  }

  const merged: EffectiveConfigEntry[] = [];
  for (const key of order) {
    const entry = byKey.get(key);
    if (entry) merged.push(entry);
  }
  return merged;
}

// ── Read ──────────────────────────────────────────────────────────────────

/**
 * Read an application's config for one scope: vendor defaults always, plus
 * the customer's overrides when customerId is given. Secrets are masked —
 * the response NEVER contains a plaintext secret value.
 */
export async function getConfig(
  applicationId: string,
  customerId: string | null,
  store: ConfigStore,
): Promise<ApplicationConfigView> {
  if (!(await store.applicationExists(applicationId))) {
    throw new NotFoundError('Application not found');
  }
  const vendorDefaults = await store.list(applicationId, null);
  const customerOverrides: readonly ConfigEntry[] =
    customerId === null ? [] : await store.list(applicationId, customerId);

  return {
    applicationId,
    customerId,
    vendorDefaults: vendorDefaults.map(toMaskedEntry),
    customerOverrides: customerOverrides.map(toMaskedEntry),
    effective: mergeConfigEntries(vendorDefaults, customerOverrides),
  };
}

// ── Write ─────────────────────────────────────────────────────────────────

/**
 * Write config entries for one scope (vendor defaults when customerId is
 * null, customer overrides otherwise).
 *
 * §31 write-through for secrets: entries flagged isSecret with a fresh value
 * are written to the CUSTOMER's Secrets Manager via the relay BEFORE anything
 * persists, and the control-plane row stores only SECRET_MASK — plaintext
 * never touches the DB. Untouched secret fields arrive as empty strings
 * (write-only inputs never echo the old value) and are skipped — an empty
 * secret means "leave unchanged". Vendor-scope secrets have no customer
 * account to write to, so they persist as masked placeholders only.
 *
 * All-or-nothing: a failed relay write aborts before any DB write.
 */
export async function setConfig(
  applicationId: string,
  customerId: string | null,
  entries: readonly ConfigEntry[],
  deps: ConfigDeps,
  deletes: readonly string[] = [],
): Promise<ApplicationConfigView> {
  validateEntries(entries);
  if (!(await deps.store.applicationExists(applicationId))) {
    throw new NotFoundError('Application not found');
  }

  // A key cannot be written and removed in one save — that is a client bug,
  // and guessing which the vendor meant is worse than saying so.
  const writtenKeys = new Set(entries.map((entry) => entry.key));
  const conflicting = deletes.filter((key) => writtenKeys.has(key));
  if (conflicting.length > 0) {
    throw new ApiError(
      400,
      'CONFIG_CONFLICTING_WRITE',
      `These values are both set and removed in the same save: ${conflicting.join(', ')}.`,
    );
  }

  // Every customer-scoped change propagates to the running deployment —
  // plain values included, not only secrets. A save that only touched plain
  // variables previously enqueued nothing, so the running application never
  // saw it while the screen promised it would "within a few minutes"
  // (verified live). Untouched secrets (empty value) are not changes.
  const changedEntries = entries.filter((entry) => !(entry.isSecret && entry.value.length === 0));
  if (customerId !== null && changedEntries.length > 0) {
    try {
      await deps.secretWriter.writeSecrets(customerId, changedEntries);
    } catch {
      throw new ApiError(
        502,
        'CONFIG_WRITE_FAILED',
        'The configuration could not be written. Try again in a moment.',
      );
    }
  }

  for (const entry of entries) {
    if (entry.isSecret && entry.value.length === 0) continue; // untouched secret
    const stored: ConfigEntry = entry.isSecret
      ? { key: entry.key, value: SECRET_MASK, isSecret: true }
      : entry;
    await deps.store.upsert(applicationId, customerId, stored);
  }

  if (deletes.length > 0) {
    // Removals propagate for every key: a removed secret has to leave the
    // customer's own secret store, and a removed plain variable has to leave
    // the running task definition — both travel as removedKeys on the same
    // CONFIG_UPDATE write-through.
    if (customerId !== null) {
      try {
        await deps.secretWriter.removeSecrets(customerId, deletes);
      } catch {
        throw new ApiError(
          502,
          'CONFIG_WRITE_FAILED',
          'The configuration could not be written. Try again in a moment.',
        );
      }
    }
    for (const key of deletes) {
      await deps.store.remove(applicationId, customerId, key);
    }
  }

  return getConfig(applicationId, customerId, deps.store);
}

/** Empty keys and duplicate keys within one write are rejected (§31). */
function validateEntries(entries: readonly ConfigEntry[]): void {
  const seen = new Set<string>();
  const invalidKeys: string[] = [];
  for (const entry of entries) {
    if (entry.key.length === 0) {
      invalidKeys.push('');
      continue;
    }
    if (seen.has(entry.key)) {
      invalidKeys.push(entry.key);
      continue;
    }
    seen.add(entry.key);
  }
  if (invalidKeys.length > 0) {
    throw new ApiError(400, 'INVALID_CONFIG', 'Configuration keys are invalid', { invalidKeys });
  }
}

// ── Real seams ────────────────────────────────────────────────────────────

// application_configs.application_id is uuid-keyed: fixture/dev ids are not
// UUIDs and can never match — skip the query (Postgres would raise "invalid
// input syntax for type uuid" instead of returning no rows).
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Drizzle-backed ConfigStore over the real schema. */
export function createConfigStore(db: RuntimeDb): ConfigStore {
  const scopeWhere = (applicationId: string, customerId: string | null, key?: string): SQL => {
    const conditions: SQL[] = [eq(schema.applicationConfigs.applicationId, applicationId)];
    conditions.push(
      customerId === null
        ? isNull(schema.applicationConfigs.customerId)
        : eq(schema.applicationConfigs.customerId, customerId),
    );
    if (key !== undefined) {
      conditions.push(eq(schema.applicationConfigs.key, key));
    }
    return and(...conditions) as SQL;
  };

  return {
    async applicationExists(applicationId) {
      if (!UUID_PATTERN.test(applicationId)) return false;
      const rows = await db
        .select({ id: schema.applications.id })
        .from(schema.applications)
        .where(eq(schema.applications.id, applicationId))
        .limit(1);
      return rows.length > 0;
    },

    async list(applicationId, customerId) {
      if (!UUID_PATTERN.test(applicationId)) return [];
      if (customerId !== null && !UUID_PATTERN.test(customerId)) return [];
      const rows = await db
        .select({
          key: schema.applicationConfigs.key,
          value: schema.applicationConfigs.value,
          isSecret: schema.applicationConfigs.isSecret,
        })
        .from(schema.applicationConfigs)
        .where(scopeWhere(applicationId, customerId))
        .orderBy(schema.applicationConfigs.key);
      return rows;
    },

    // Select-then-insert/update keeps this portable — it does not depend on
    // ON CONFLICT inference against the NULLS NOT DISTINCT unique index.
    async upsert(applicationId, customerId, entry) {
      const existing = await db
        .select({ id: schema.applicationConfigs.id })
        .from(schema.applicationConfigs)
        .where(scopeWhere(applicationId, customerId, entry.key))
        .limit(1);
      if (existing.length > 0) {
        await db
          .update(schema.applicationConfigs)
          .set({ value: entry.value, isSecret: entry.isSecret })
          .where(scopeWhere(applicationId, customerId, entry.key));
        return;
      }
      await db.insert(schema.applicationConfigs).values({
        applicationId,
        customerId,
        key: entry.key,
        value: entry.value,
        isSecret: entry.isSecret,
      });
    },

    async remove(applicationId, customerId, key) {
      if (!UUID_PATTERN.test(applicationId)) return;
      if (customerId !== null && !UUID_PATTERN.test(customerId)) return;
      await db
        .delete(schema.applicationConfigs)
        .where(scopeWhere(applicationId, customerId, key));
    },
  };
}

/**
 * Relay write-through backed by SQS. Enqueues a CONFIG_UPDATE relay command
 * to the job queue so the worker can dispatch it to the relay Lambda in the
 * customer account. New secret VALUES ride the queue message transiently —
 * the relay persists them into the customer's own Secrets Manager; the
 * control plane's durable stores only ever see keys and the SECRET_MASK
 * placeholder. The relay fetches the effective configuration over its
 * authenticated channel when it executes. Without a queue (local dev /
 * tests) `enqueue` reports false and this degrades to a no-op stub.
 */
export function createRelaySecretWriter(): ConfigSecretWriter {
  return {
    async writeSecrets(customerId, entries) {
      const secrets = entries
        .filter((entry) => entry.isSecret && entry.value.length > 0)
        .map(({ key, value }) => ({ key, value }));
      await enqueue({
        type: 'CONFIG_UPDATE',
        customerId,
        changedKeys: entries.map((entry) => entry.key),
        ...(secrets.length > 0 ? { secrets } : {}),
      });
    },

    async removeSecrets(customerId, keys) {
      await enqueue({ type: 'CONFIG_UPDATE', customerId, removedKeys: [...keys] });
    },
  };
}

/**
 * The env keys that already carry a value for one deployment scope: vendor
 * defaults for the application plus this customer's overrides (§31 merge
 * order). Used by the §11.2 readiness gate at deployment creation to decide
 * which required env vars are already provided.
 */
export async function listProvidedConfigKeys(
  db: RuntimeDb,
  applicationId: string,
  customerId: string | null,
): Promise<string[]> {
  if (!UUID_PATTERN.test(applicationId) || (customerId !== null && !UUID_PATTERN.test(customerId))) return [];
  const rows = await db
    .select({ key: schema.applicationConfigs.key })
    .from(schema.applicationConfigs)
    .where(
      and(
        eq(schema.applicationConfigs.applicationId, applicationId),
        customerId === null
          ? isNull(schema.applicationConfigs.customerId)
          : or(isNull(schema.applicationConfigs.customerId), eq(schema.applicationConfigs.customerId, customerId)),
      ),
    );
  return [...new Set(rows.map((row) => row.key))];
}
