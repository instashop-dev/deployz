import { pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { organization } from './auth.js';
import { createdAt, id, updatedAt } from './common.js';
import { applications, customers } from './core.js';
import { deployments } from './deployments.js';

// Deploy Links — a vendor-generated, tokenized entry point that pre-creates
// one deployment (deployments.source = 'deploy_link') for an existing
// customer + application. The customer opens the public page with the link's
// uuid + secret token and drives the SAME install flow as an emailed install
// link. `id` is the public link id (it appears in the customer URL); the
// token itself is never stored — only its sha256 in token_hash. Status is
// derived at read time (active / revoked / expired); no state machine.
export const deployLinks = pgTable(
  'deploy_links',
  {
    id: id(),
    // organization.id is a Better Auth text key, so this FK column is text
    // (mirrors deployments.organization_id) despite the uuid sibling columns.
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id),
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => deployments.id),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('deploy_links_deployment_uidx').on(t.deploymentId)],
);
