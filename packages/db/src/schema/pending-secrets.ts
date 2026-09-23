import { sql } from 'drizzle-orm';
import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { organization } from './auth.js';
import { auditFields, id } from './common.js';
import { applications, customers } from './core.js';
import { deployments } from './deployments.js';

// Pending secrets — the DEPLOY-027 (Phase 4) at-rest store for vendor /
// customer secrets that have no connected relay to deliver to yet. Two tiers:
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
export const pendingSecrets = pgTable(
  'pending_secrets',
  {
    id: id(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id),
    // NULL = vendor-scope default; non-NULL = a specific customer's override.
    customerId: uuid('customer_id').references(() => customers.id),
    // NULL = staged (waiting for a deployment to bind to). Set = bound.
    deploymentId: uuid('deployment_id').references(() => deployments.id),
    key: text('key').notNull(),
    ciphertext: text('ciphertext').notNull(),
    // The exact KMS EncryptionContext dict used at encrypt time. Stored as
    // jsonb so a relayer can hand it to Decrypt verbatim; it is AAD, not a
    // secret.
    encryptionContext: jsonb('encryption_context').notNull().$type<Record<string, string>>(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    deliveredDeploymentId: uuid('delivered_deployment_id'),
    deliveryAttempts: integer('delivery_attempts').notNull().default(0),
    ...auditFields(),
  },
  (t) => [
    // One staged row per (application, customer_or_vendor, key). NULLS NOT
    // DISTINCT so a vendor-default (customer_id NULL) row dedupes like a
    // customer-scoped one — same partial-UNIQUE shape as application_configs.
    uniqueIndex('ux_pending_secrets_staged')
      .on(t.applicationId, t.customerId, t.key)
      .where(sql`${t.deploymentId} IS NULL`)
      .with({ nullsNotDistinct: true }),
    // Bound tier: at most one row per (deployment, key).
    uniqueIndex('ux_pending_secrets_bound')
      .on(t.deploymentId, t.key)
      .where(sql`${t.deploymentId} IS NOT NULL`),
  ],
);