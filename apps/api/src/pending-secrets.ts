import { and, eq, isNull, lt, sql } from 'drizzle-orm';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

// DEPLOY-027 (Phase 4): KMS-backed at-rest store for vendor / customer
// secrets that have no connected relay to deliver to yet. Two tiers:
//
//   * staged  (deployment_id NULL)  — written before any deployment exists
//                                    for the scope, or alongside pre-relay
//                                    deployments that cannot consume yet.
//                                    Materializes into a deployment's bound
//                                    rows when that deployment is created.
//   * bound   (deployment_id SET)   — per-deployment ciphertext awaiting
//                                    relay pickup via GET /api/relay/config.
//                                    Deleted once the deployment settles.
//
// Plaintext is NEVER stored. Every row carries the KMS ciphertext +
// EncryptionContext used to encrypt it (the context is the same AAD KMS binds
// to — never the secret). The decryption seam is exactly one place: the
// relay config fetch (apps/api/src/install-config.ts).

// ── Cipher seam (encrypt/decrypt, KMS-backed in production) ────────────────

/**
 * The cipher is the single boundary that touches plaintext. The API holds a
 * cipher instance per process; tests inject the in-memory stub. Every
 * encrypt() captures an EncryptionContext the relay MUST echo on decrypt()
 * — that is what binds an `organizationId + applicationId + key (+ deploymentId)`
 * tuple to a ciphertext, and is what stops a stolen relay / event-log reader
 * from replaying the value against an unrelated deployment.
 */
export interface SecretCipher {
  encrypt(
    plaintext: string,
    context: Record<string, string>,
  ): Promise<{ ciphertext: string; encryptionContext: Record<string, string> }>;
  decrypt(ciphertext: string, encryptionContext: Record<string, string>): Promise<string>;
}

/**
 * In-memory cipher for tests: `enc:` + base64(plaintext), reversed on
 * decrypt. The context is bound through (encrypt embeds a hash of it into
 * the ciphertext's "header"; decrypt requires the same hash) so a wrong
 * context fails the round-trip — the same surface a stolen-context KMS
 * Decrypt would raise.
 */
export function createCipherStub(): SecretCipher {
  const ctxHash = (context: Record<string, string>): string => {
    const entries = Object.entries(context).sort(([a], [b]) => a.localeCompare(b));
    return Buffer.from(entries.map(([k, v]) => `${k}=${v}`).join('&')).toString('base64');
  };
  return {
    async encrypt(plaintext, context) {
      const body = Buffer.from(plaintext, 'utf8').toString('base64');
      return { ciphertext: `enc:${ctxHash(context)}:${body}`, encryptionContext: context };
    },
    async decrypt(ciphertext, encryptionContext) {
      const parts = ciphertext.split(':');
      if (parts.length !== 3 || parts[0] !== 'enc') {
        throw new Error('cipher stub: malformed ciphertext');
      }
      const expectedHash = ctxHash(encryptionContext);
      if (parts[1] !== expectedHash) {
        throw new Error('cipher stub: encryptionContext mismatch');
      }
      return Buffer.from(parts[2]!, 'base64').toString('utf8');
    },
  };
}

/**
 * Real KMS-backed cipher. The EncryptionContext passed to AWS must contain
 * the same key/value pairs we later use to decrypt — KMS binds the AAD to
 * the ciphertext, so a wrong context is a guaranteed Decrypt failure. We
 * serialize the context to a sorted dict (AWS requires string-only values).
 */
export function createKmsCipher(keyArn: string): SecretCipher {
  // Lazy import: the API bundle carries @aws-sdk/client-kms only when the
  // cipher seam is actually constructed. Tests that use the stub never load
  // the SDK.
  type KmsModule = typeof import('@aws-sdk/client-kms');
  let modPromise: Promise<KmsModule> | undefined;
  const load = (): Promise<KmsModule> => {
    modPromise ??= import('@aws-sdk/client-kms');
    return modPromise;
  };
  // Base64-url encode the KMS CiphertextBlob, which AWS returns as a Uint8Array
  // or a binary string. The store persists the value as text.
  const encodeBlob = (blob: Uint8Array): string => Buffer.from(blob).toString('base64');
  const decodeBlob = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'base64'));
  return {
    async encrypt(plaintext, context) {
      const mod = await load();
      const client = new mod.KMSClient({});
      const response = await client.send(
        new mod.EncryptCommand({
          KeyId: keyArn,
          Plaintext: new TextEncoder().encode(plaintext),
          EncryptionContext: context,
        }),
      );
      if (response.CiphertextBlob === undefined) {
        throw new Error('KMS Encrypt returned no CiphertextBlob');
      }
      const blob = response.CiphertextBlob instanceof Uint8Array
        ? response.CiphertextBlob
        : new TextEncoder().encode(String(response.CiphertextBlob));
      return { ciphertext: encodeBlob(blob), encryptionContext: context };
    },
    async decrypt(ciphertext, encryptionContext) {
      const mod = await load();
      const client = new mod.KMSClient({});
      const response = await client.send(
        new mod.DecryptCommand({
          KeyId: keyArn,
          CiphertextBlob: decodeBlob(ciphertext),
          EncryptionContext: encryptionContext,
        }),
      );
      if (response.Plaintext === undefined) {
        throw new Error('KMS Decrypt returned no Plaintext');
      }
      return new TextDecoder().decode(response.Plaintext);
    },
  };
}

// ── Store seam (DB-backed) ────────────────────────────────────────────────

export interface UpsertStagedInput {
  organizationId: string;
  applicationId: string;
  customerId: string | null;
  key: string;
  ciphertext: string;
  encryptionContext: Record<string, string>;
  expiresAt: Date;
  createdBy: string | null;
}

export interface UpsertBoundInput {
  organizationId: string;
  applicationId: string;
  deploymentId: string;
  key: string;
  ciphertext: string;
  encryptionContext: Record<string, string>;
  expiresAt: Date;
}

export interface MaterializeRow {
  key: string;
  plaintext: string;
}

export interface BoundRow {
  key: string;
  ciphertext: string;
  encryptionContext: Record<string, string>;
  deliveryAttempts: number;
}

/**
 * The two-tier pending-secrets store. Encryption/decryption is a separate
 * dependency (SecretCipher) — the store only knows about ciphertext +
 * context, never plaintext. materializeForDeployment() is the single seam
 * that decrypts: it is called inside the materialization hook in
 * apps/api/src/deploy-links.ts, and the relay config fetch in
 * apps/api/src/install-config.ts.
 */
export interface PendingSecretStore {
  /** Upsert a staged (deployment_id NULL) row for a scope. */
  upsertStaged(input: UpsertStagedInput): Promise<void>;
  /** Upsert a bound (deployment_id SET) row for a single deployment. */
  upsertBound(input: UpsertBoundInput): Promise<void>;
  /**
   * Read all staged rows for `(applicationId, customerId)` plus vendor-scope
   * rows (`customerId NULL`), decrypt each with the stored context, return
   * plaintext. Fail-closed: a cipher error throws.
   */
  materializeForDeployment(deployment: {
    organizationId: string;
    id: string;
    applicationId: string;
    customerId: string;
  }): Promise<MaterializeRow[]>;
  /** List bound rows for one deployment — no decrypt, just the ciphertext. */
  listBoundForDeployment(deploymentId: string): Promise<BoundRow[]>;
  /** Delete every bound row for a deployment (e.g. on config-update ack). */
  deleteBoundForDeployment(deploymentId: string): Promise<void>;
  /** Delete one staged row by its scope triple. */
  deleteStagedForScope(input: {
    applicationId: string;
    customerId: string | null;
    key: string;
  }): Promise<void>;
  /** Delete every row whose expires_at is before `now`. Returns the count. */
  sweepExpired(now: Date): Promise<number>;
  /**
   * Record a successful relay pickup: stamp delivered_at, link the
   * deployment, and increment delivery_attempts. Idempotent at the row
   * level — a duplicate stamp just re-stamps deliveredAt.
   */
  stampDelivery(deploymentId: string, key: string): Promise<void>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createDrizzlePendingSecretStore(
  db: RuntimeDb,
  cipher: SecretCipher,
): PendingSecretStore {
  const nowIso = (): string => new Date().toISOString();

  const upsertStagedRow = async (
    rows: PendingSecretRow[],
    keyName: string,
    input: { ciphertext: string; encryptionContext: Record<string, string>; expiresAt: Date },
    applicationId: string,
    customerId: string | null,
    organizationId: string,
    createdBy: string | null,
  ): Promise<void> => {
    if (rows.length > 0) {
      await db
        .update(schema.pendingSecrets)
        .set({
          ciphertext: input.ciphertext,
          encryptionContext: input.encryptionContext,
          expiresAt: input.expiresAt,
          updatedAt: new Date(),
          updatedBy: createdBy,
        })
        .where(eq(schema.pendingSecrets.id, rows[0]!.id));
      return;
    }
    await db.insert(schema.pendingSecrets).values({
      organizationId,
      applicationId,
      customerId,
      key: keyName,
      ciphertext: input.ciphertext,
      encryptionContext: input.encryptionContext,
      expiresAt: input.expiresAt,
      deliveryAttempts: 0,
      createdBy,
      updatedBy: createdBy,
    });
  };

  return {
    async upsertStaged(input) {
      if (!UUID_PATTERN.test(input.applicationId)) return;
      const existing = await db
        .select({ id: schema.pendingSecrets.id })
        .from(schema.pendingSecrets)
        .where(
          and(
            eq(schema.pendingSecrets.applicationId, input.applicationId),
            input.customerId === null
              ? isNull(schema.pendingSecrets.customerId)
              : eq(schema.pendingSecrets.customerId, input.customerId),
            eq(schema.pendingSecrets.key, input.key),
            isNull(schema.pendingSecrets.deploymentId),
          ),
        )
        .limit(1);
      await upsertStagedRow(
        existing,
        input.key,
        input,
        input.applicationId,
        input.customerId,
        input.organizationId,
        input.createdBy,
      );
    },

    async upsertBound(input) {
      if (!UUID_PATTERN.test(input.applicationId) || !UUID_PATTERN.test(input.deploymentId)) return;
      const existing = await db
        .select({ id: schema.pendingSecrets.id })
        .from(schema.pendingSecrets)
        .where(
          and(
            eq(schema.pendingSecrets.deploymentId, input.deploymentId),
            eq(schema.pendingSecrets.key, input.key),
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        await db
          .update(schema.pendingSecrets)
          .set({
            ciphertext: input.ciphertext,
            encryptionContext: input.encryptionContext,
            expiresAt: input.expiresAt,
            updatedAt: new Date(),
          })
          .where(eq(schema.pendingSecrets.id, existing[0]!.id));
        return;
      }
      await db.insert(schema.pendingSecrets).values({
        organizationId: input.organizationId,
        applicationId: input.applicationId,
        deploymentId: input.deploymentId,
        key: input.key,
        ciphertext: input.ciphertext,
        encryptionContext: input.encryptionContext,
        expiresAt: input.expiresAt,
        deliveryAttempts: 0,
      });
    },

    async materializeForDeployment(deployment) {
      if (!UUID_PATTERN.test(deployment.id) || !UUID_PATTERN.test(deployment.applicationId)) {
        return [];
      }
      const rows = await db
        .select()
        .from(schema.pendingSecrets)
        .where(
          and(
            eq(schema.pendingSecrets.applicationId, deployment.applicationId),
            sql`(${schema.pendingSecrets.customerId} IS NULL OR ${schema.pendingSecrets.customerId} = ${deployment.customerId})`,
            isNull(schema.pendingSecrets.deploymentId),
            sql`${schema.pendingSecrets.expiresAt} > ${nowIso()}`,
          ),
        );
      const out: MaterializeRow[] = [];
      for (const row of rows) {
        const plaintext = await cipher.decrypt(row.ciphertext, row.encryptionContext);
        out.push({ key: row.key, plaintext });
      }
      return out;
    },

    async listBoundForDeployment(deploymentId) {
      if (!UUID_PATTERN.test(deploymentId)) return [];
      const rows = await db
        .select({
          key: schema.pendingSecrets.key,
          ciphertext: schema.pendingSecrets.ciphertext,
          encryptionContext: schema.pendingSecrets.encryptionContext,
          deliveryAttempts: schema.pendingSecrets.deliveryAttempts,
        })
        .from(schema.pendingSecrets)
        .where(
          and(
            eq(schema.pendingSecrets.deploymentId, deploymentId),
            sql`${schema.pendingSecrets.expiresAt} > ${nowIso()}`,
          ),
        );
      return rows;
    },

    async deleteBoundForDeployment(deploymentId) {
      if (!UUID_PATTERN.test(deploymentId)) return;
      await db
        .delete(schema.pendingSecrets)
        .where(eq(schema.pendingSecrets.deploymentId, deploymentId));
    },

    async deleteStagedForScope(input) {
      if (!UUID_PATTERN.test(input.applicationId)) return;
      await db
        .delete(schema.pendingSecrets)
        .where(
          and(
            eq(schema.pendingSecrets.applicationId, input.applicationId),
            input.customerId === null
              ? isNull(schema.pendingSecrets.customerId)
              : eq(schema.pendingSecrets.customerId, input.customerId),
            eq(schema.pendingSecrets.key, input.key),
            isNull(schema.pendingSecrets.deploymentId),
          ),
        );
    },

    async sweepExpired(now) {
      const deleted = await db
        .delete(schema.pendingSecrets)
        .where(lt(schema.pendingSecrets.expiresAt, now))
        .returning();
      return deleted.length;
    },

    async stampDelivery(deploymentId, key) {
      if (!UUID_PATTERN.test(deploymentId)) return;
      await db
        .update(schema.pendingSecrets)
        .set({
          deliveredAt: new Date(),
          deliveredDeploymentId: deploymentId,
          deliveryAttempts: sql`${schema.pendingSecrets.deliveryAttempts} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.pendingSecrets.deploymentId, deploymentId),
            eq(schema.pendingSecrets.key, key),
          ),
        );
    },
  };
}

interface PendingSecretRow {
  id: string;
}