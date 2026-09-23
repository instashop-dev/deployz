import { and, eq, isNull, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import { DEFAULT_PENDING_SECRET_TTL_MS } from '@deployz/contracts';
import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { ApiError, NotFoundError } from './errors.js';
import type { PendingSecretStore, SecretCipher } from './pending-secrets.js';
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
  /** DEPLOY-027 (Phase 4) at-rest KMS-backed secret store. */
  readonly pendingSecrets: PendingSecretStore;
  /** Cipher used to encrypt/decrypt values before persisting to pending_secrets. */
  readonly cipher: SecretCipher;
  /**
   * Scope-deployments query seam. Production wires this to a drizzle query
   * over deployments filtered by (applicationId, customerId); tests inject
   * a fake so no DB is needed.
   */
  readonly findScopeDeployments: (applicationId: string, customerId: string) => Promise<
    ReadonlyArray<{ id: string; organizationId: string; state: typeof schema.deployments.$inferSelect['state'] }>
  >;
  /**
   * Lookup seam for the application's organization. The DEPLOY-027 staged
   * rows need an organizationId even when the scope has zero deployments —
   * the application's own row is the canonical source.
   */
  readonly findApplicationOrganizationId: (applicationId: string) => Promise<string | undefined>;
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
 * DEPLOY-027 (Phase 4): a customer-required secret typed before the relay
 * connects must survive until a deployment is ready to consume it. The
 * staged/bound pending_secrets rows are the durable transport: pre-relay
 * deployments get per-deployment bound ciphertext immediately, the
 * "no deployment yet" path persists a staged row that the next
 * createDeploymentRecord materializes. Plaintext is encrypted ONCE per key
 * with the staged context, then bound rows re-encrypt with the deployment
 * context — only the relay config fetch ever decrypts.
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

  // DEPLOY-027 (Phase 4): one query splits the scope's deployments into
  // claimable (a relay can act on them today — anything outside the four
  // pre-relay states) and pre-relay (NOT_INSTALLED, WAITING_FOR_RELAY,
  // DELETING, DELETED). The exact filter mirrors packages/cdk/src/lambda/worker.ts:420-428.
  const scopeDeployments =
    customerId === null
      ? { claimable: [] as { id: string; organizationId: string }[], preRelay: [] as { id: string; organizationId: string }[] }
      : splitScopeDeployments(await deps.findScopeDeployments(applicationId, customerId));
  // DEPLOY-027 (Phase 4): the org id comes from the application's own row
  // when the scope has no deployments — staged rows need it, and the worker's
  // CONFIG_UPDATE fanout already trusts that every deployment in scope shares
  // an application.organization_id.
  const applicationOrganizationId = await deps.findApplicationOrganizationId(applicationId);
  const organizationId =
    scopeDeployments.claimable[0]?.organizationId ??
    scopeDeployments.preRelay[0]?.organizationId ??
    applicationOrganizationId;

  // Encrypt each non-empty secret value ONCE per key, with the staged
  // context. A bind failure here is a hard 502 — we never persist a half-
  // encrypted state. The cap (4096 bytes) matches KMS Encrypt's plaintext
  // limit. Vendor-scope secrets have no customer account to bind to, so they
  // skip this path entirely (the row carries SECRET_MASK only).
  const encryptedSecrets: Array<{
    entry: ConfigEntry;
    ciphertext: string;
    encryptionContext: Record<string, string>;
  }> = [];
  if (customerId !== null) {
    if (organizationId !== undefined) {
      for (const entry of changedEntries) {
        if (!entry.isSecret) continue;
        if (Buffer.byteLength(entry.value, 'utf8') > 4096) {
          throw new ApiError(
            422,
            'SECRET_VALUE_TOO_LARGE',
            `Secret value for key "${entry.key}" exceeds the KMS 4096-byte plaintext limit.`,
          );
        }
        const stagedContext: Record<string, string> = {
          organizationId,
          applicationId,
          key: entry.key,
          customerId,
        };
        try {
          const { ciphertext, encryptionContext } = await deps.cipher.encrypt(
            entry.value,
            stagedContext,
          );
          encryptedSecrets.push({ entry, ciphertext, encryptionContext });
        } catch {
          throw new ApiError(
            502,
            'CONFIG_WRITE_FAILED',
            'The configuration could not be written. Try again in a moment.',
          );
        }
      }
    }
  }

  // The relay write-through is for deployments the worker can act on today
  // (claimable). When zero claimable deployments exist we skip the enqueue:
  // every candidate is pre-relay, the worker would no-op, and the bound
  // ciphertext rows below deliver via GET /api/relay/config as soon as the
  // relay enrolls.
  if (customerId !== null && changedEntries.length > 0 && scopeDeployments.claimable.length > 0) {
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

  // DEPLOY-027 (Phase 4): persist the at-rest secret rows.
  //   * Zero claimable deployments AND at least one pre-relay deployment →
  //     staged rows persist for every encrypted key. The next
  //     createDeploymentRecord call materializes them.
  //   * One or more pre-relay deployments → bound rows per deployment,
  //     re-encrypted with the deployment context. The relay picks them up
  //     the moment its /api/relay/config fetch runs for that deployment.
  // The encryption context binds the row to its scope so a stolen row's
  // ciphertext cannot be reused against an unrelated tenant.
  const expiresAt = new Date(Date.now() + DEFAULT_PENDING_SECRET_TTL_MS);
  if (customerId !== null) {
    if (organizationId !== undefined) {
      if (scopeDeployments.preRelay.length > 0) {
        for (const { entry } of encryptedSecrets) {
          for (const deployment of scopeDeployments.preRelay) {
            // Re-bind with the deployment context so a relay holding this
            // row can only decrypt it for the matching deployment.
            const boundContext: Record<string, string> = {
              organizationId: deployment.organizationId,
              applicationId,
              deploymentId: deployment.id,
              key: entry.key,
              customerId,
            };
            let boundCiphertext: string;
            try {
              ({ ciphertext: boundCiphertext } = await deps.cipher.encrypt(entry.value, boundContext));
            } catch {
              throw new ApiError(
                502,
                'CONFIG_WRITE_FAILED',
                'The configuration could not be written. Try again in a moment.',
              );
            }
            await deps.pendingSecrets.upsertBound({
              organizationId: deployment.organizationId,
              applicationId,
              deploymentId: deployment.id,
              key: entry.key,
              ciphertext: boundCiphertext,
              encryptionContext: boundContext,
              expiresAt,
            });
          }
        }
      }
      // No claimable AND no pre-relay deployments (yet): persist staged rows
      // so the first deployment to land materializes them.
      if (scopeDeployments.claimable.length === 0 && scopeDeployments.preRelay.length === 0) {
        for (const { entry, ciphertext, encryptionContext } of encryptedSecrets) {
          await deps.pendingSecrets.upsertStaged({
            organizationId,
            applicationId,
            customerId,
            key: entry.key,
            ciphertext,
            encryptionContext,
            expiresAt,
            createdBy: null,
          });
        }
      }
    }
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
    // Drop any staged rows for the deleted keys and any pre-relay bound rows
    // (they are not encrypted with the same value the relay now has to
    // remove, so the simplest correct action is to drop them — the relay
    // config fetch will simply not see them).
    if (customerId !== null) {
      for (const key of deletes) {
        await deps.pendingSecrets.deleteStagedForScope({
          applicationId,
          customerId,
          key,
        });
      }
      for (const deployment of scopeDeployments.preRelay) {
        for (const key of deletes) {
          await deps.pendingSecrets.deleteStagedForScope({
            applicationId,
            customerId: deployment.id,
            key,
          });
        }
        await deps.pendingSecrets.deleteBoundForDeployment(deployment.id);
      }
    }
  }

  return getConfig(applicationId, customerId, deps.store);
}

const PRE_RELAY_STATES = new Set([
  'NOT_INSTALLED',
  'WAITING_FOR_RELAY',
  'DELETING',
  'DELETED',
]);

function splitScopeDeployments(
  rows: ReadonlyArray<{ id: string; organizationId: string; state: typeof schema.deployments.$inferSelect['state'] }>,
): { claimable: { id: string; organizationId: string }[]; preRelay: { id: string; organizationId: string }[] } {
  const claimable: { id: string; organizationId: string }[] = [];
  const preRelay: { id: string; organizationId: string }[] = [];
  for (const row of rows) {
    const bucket = PRE_RELAY_STATES.has(row.state) ? preRelay : claimable;
    bucket.push({ id: row.id, organizationId: row.organizationId });
  }
  return { claimable, preRelay };
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

/** DEPLOY-027 (Phase 4): default scope-deployments lookup over the db. */
export function createScopeDeploymentsFinder(
  db: RuntimeDb,
): ConfigDeps['findScopeDeployments'] {
  return async (applicationId, customerId) => {
    if (!UUID_PATTERN.test(applicationId) || !UUID_PATTERN.test(customerId)) return [];
    return db
      .select({
        id: schema.deployments.id,
        organizationId: schema.deployments.organizationId,
        state: schema.deployments.state,
      })
      .from(schema.deployments)
      .where(
        and(
          eq(schema.deployments.applicationId, applicationId),
          eq(schema.deployments.customerId, customerId),
        ),
      );
  };
}

/** DEPLOY-027 (Phase 4): the default ConfigDeps for the live API. */
export function createConfigDeps(
  db: RuntimeDb,
  pendingSecrets: PendingSecretStore,
  cipher: SecretCipher,
): ConfigDeps {
  return {
    store: createConfigStore(db),
    secretWriter: createRelaySecretWriter(),
    pendingSecrets,
    cipher,
    findScopeDeployments: createScopeDeploymentsFinder(db),
    findApplicationOrganizationId: createApplicationOrganizationIdFinder(db),
  };
}

function createApplicationOrganizationIdFinder(
  db: RuntimeDb,
): ConfigDeps['findApplicationOrganizationId'] {
  return async (applicationId) => {
    if (!UUID_PATTERN.test(applicationId)) return undefined;
    const rows = await db
      .select({ organizationId: schema.applications.organizationId })
      .from(schema.applications)
      .where(eq(schema.applications.id, applicationId))
      .limit(1);
    return rows[0]?.organizationId;
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
