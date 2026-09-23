import { sql } from 'drizzle-orm';
import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { regionEnum, regionSelectionEnum } from '../enums.js';
import { organization } from './auth.js';
import { createdAt, id, updatedAt } from './common.js';
import { applications, customers } from './core.js';

// Installation invitations (MVP Readiness 2, Phase 2) — the ONE vendor-created
// entry point before a deployment exists. Unifies the old public install link
// and the deploy link under one model:
//
//   * Reusable public link   — `customer_id`/`token_hash` NULL; one LIVE link
//                              per application; the customer reviews, selects a
//                              Region, supplies config, and confirms; ONLY THEN
//                              is a deployment created (source = 'public_link').
//   * Targeted invitation    — `customer_id` + `token_hash` set; expiring and
//                              revocable; the vendor may recommend a Region but
//                              the customer makes the final choice. Confirmation
//                              creates exactly one deployment, then the
//                              invitation is consumed (`confirmed_at`).
//
// `id` is the opaque id in the customer URL; the token is never stored — only
// its sha256 in `token_hash`. `region_selection` records ownership:
// 'customer' for everything new, 'legacy_publisher_fixed' is reserved for the
// legacy deploy-links table (Region fixed by the vendor before this model).
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
    // Null on a reusable public link; the target customer on a targeted
    // vendor invitation.
    customerId: uuid('customer_id').references(() => customers.id),
    // Optional vendor Region recommendation — never the final choice.
    recommendedRegion: regionEnum('recommended_region'),
    // Who makes the final Region choice. Always 'customer' for new rows.
    regionSelection: regionSelectionEnum('region_selection').notNull().default('customer'),
    // sha256 of the private token (targeted invitations only; null on a
    // reusable public link, which has no token).
    tokenHash: text('token_hash'),
    // Null = no limit (links created before this field existed stay valid).
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    // Set when the customer confirms — the invitation is consumed and can
    // never create another deployment.
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    enabled: boolean('enabled').notNull().default(false),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // At most one LIVE REUSABLE link per application — a targeted invitation
    // (customer_id set) never occupies this slot, so many customers can hold
    // active invitations to the same application. A revoked reusable link
    // frees the slot for re-issue.
    uniqueIndex('public_install_links_one_live_per_application_uidx')
      .on(t.applicationId)
      .where(sql`${t.revokedAt} IS NULL AND ${t.customerId} IS NULL`),
  ],
);
