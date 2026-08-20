import { date, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { subscriptionStatusEnum } from '../enums.js';
import { organization } from './auth.js';
import { createdAt, id, updatedAt } from './common.js';
import { deployments } from './deployments.js';

// §48 billing: one subscription per organization.
export const subscriptions = pgTable('subscriptions', {
  id: id(),
  organizationId: text('organization_id')
    .notNull()
    .unique()
    .references(() => organization.id),
  stripeSubscriptionId: text('stripe_subscription_id').notNull().unique(),
  stripeBasePriceId: text('stripe_base_price_id').notNull(),
  stripeMeteredPriceId: text('stripe_metered_price_id').notNull(),
  status: subscriptionStatusEnum('status').notNull(),
  currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// §48/U8 day-proration shape: ONE record per deployment per day,
// quantity = 1. stripe_usage_record_id is set once reported to Stripe.
export const usageRecords = pgTable(
  'usage_records',
  {
    id: id(),
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => deployments.id),
    usageDate: date('usage_date', { mode: 'string' }).notNull(),
    quantity: integer('quantity').notNull(),
    stripeUsageRecordId: text('stripe_usage_record_id').unique(),
    reportedAt: timestamp('reported_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('usage_records_deployment_date_uidx').on(t.deploymentId, t.usageDate)],
);
