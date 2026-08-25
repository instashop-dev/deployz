import { sql } from 'drizzle-orm';
import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { customDomainStatusEnum } from '../enums.js';
import { organization } from './auth.js';
import { auditFields, id } from './common.js';
import { deployments } from './deployments.js';

// Custom-domains MVP — one custom subdomain per deployment. The row is the
// control plane's source of truth for the domain state machine; ACM/ALB
// facts arrive via relay job results. Removal is a soft delete (removedAt)
// so a hostname frees up the moment removal completes while history stays.
export const customDomains = pgTable(
  'custom_domains',
  {
    id: id(),
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => deployments.id),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id),
    hostname: text('hostname').notNull(),
    status: customDomainStatusEnum('status').notNull().default('PENDING'),
    certificateArn: text('certificate_arn'),
    validationName: text('validation_name'),
    validationValue: text('validation_value'),
    routingTarget: text('routing_target'),
    // Stable error code (DNS_VALIDATION_NOT_FOUND, DNS_ROUTING_MISMATCH,
    // HTTPS_NOT_REACHABLE, AWS_PERMISSION_DENIED, CONFIGURE_FAILED,
    // REMOVE_FAILED) — mapped to copy in the web app, never raw AWS text.
    lastError: text('last_error'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    // Bumped to mint a fresh relay-job idempotency key when a finished job
    // needs re-running (retry after failure, next configure step).
    checkCycle: integer('check_cycle').notNull().default(0),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    ...auditFields(),
  },
  (table) => [
    // One active ownership of a hostname across ALL of Deployz.
    uniqueIndex('custom_domains_active_hostname_idx')
      .on(table.hostname)
      .where(sql`${table.removedAt} is null`),
    // One non-removed domain per deployment.
    uniqueIndex('custom_domains_active_deployment_idx')
      .on(table.deploymentId)
      .where(sql`${table.removedAt} is null`),
  ],
);
