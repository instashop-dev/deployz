import { sql } from 'drizzle-orm';
import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { organization } from './auth.js';
import { createdAt, id, updatedAt } from './common.js';
import { applications } from './core.js';

// Public Install Links — a vendor-published, credential-free installation
// entry point. Unlike a deploy link (one pre-created deployment, one secret
// token), a public install link only names the application: the customer
// reviews the offer on the public page and confirms, and ONLY THEN is a
// deployment created (deployments.source = 'public_link', keyed to the link
// through deployments.public_install_link_id + confirm_key for idempotency).
// `id` is the opaque public link id that appears in the customer URL; no
// token exists — anyone holding the link may review and install, so the
// vendor disables (enabled = false) or revokes (revoked_at) to stop that.
// One LIVE (not revoked) link per application; re-issuing requires revoking.
export const publicInstallLinks = pgTable(
  'public_install_links',
  {
    id: id(),
    // organization.id is a Better Auth text key, so this FK column is text
    // (mirrors deployments.organization_id) despite the uuid sibling columns.
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id),
    enabled: boolean('enabled').notNull().default(false),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // At most one live link per application — a revoked link no longer
    // occupies the slot, so the vendor can revoke and re-issue.
    uniqueIndex('public_install_links_one_live_per_application_uidx')
      .on(t.applicationId)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
);
