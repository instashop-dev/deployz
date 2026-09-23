import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { regionEnum, regionalCertificateStatusEnum } from '../enums.js';
import { organization } from './auth.js';
import { auditFields, id } from './common.js';
import { customers } from './core.js';

// Regional HTTPS certificates (docs/https-regional-certificates.md) — one
// persistent wildcard ACM certificate per (customer, aws account, region),
// reused by every deployment in that scope. The scope key is
// (customer_id, aws_account_id, region); the unique index below is the row
// itself acting as the concurrency lock — an `ON CONFLICT DO NOTHING` insert
// on that key is what makes concurrent first deployments for the same
// customer converge on ONE certificate request instead of racing ACM.
// ACM/relay facts (arn, status, validation record) arrive via relay job
// results, exactly like custom_domains.
export const customerRegionalCertificates = pgTable(
  'customer_regional_certificates',
  {
    id: id(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    awsAccountId: text('aws_account_id').notNull(),
    region: regionEnum('region').notNull(),
    certificateDomain: text('certificate_domain').notNull(),
    certificateArn: text('certificate_arn'),
    certificateStatus: regionalCertificateStatusEnum('certificate_status').notNull().default('REQUESTING'),
    validationRecordName: text('validation_record_name'),
    validationRecordValue: text('validation_record_value'),
    validationRecordType: text('validation_record_type'),
    cloudflareRecordId: text('cloudflare_record_id'),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    lastError: text('last_error'),
    requestedAt: timestamp('requested_at', { withTimezone: true }),
    validationDnsReadyAt: timestamp('validation_dns_ready_at', { withTimezone: true }),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    // Bumped on each driver reconciliation pass — mirrors custom_domains'
    // checkCycle (a fresh idempotency key for the next relay job).
    checkCycle: integer('check_cycle').notNull().default(0),
    // How many ENSURE_CERTIFICATE attempts this row has consumed since the
    // last recovery — the watchdog's budget, same accounting as
    // default-https's configureAttempts.
    attempts: integer('attempts').notNull().default(0),
    ...auditFields(),
  },
  (table) => [
    // One certificate row per customer+account+region — the lock this whole
    // feature depends on.
    uniqueIndex('customer_regional_certificates_scope_uidx').on(
      table.customerId,
      table.awsAccountId,
      table.region,
    ),
  ],
);
