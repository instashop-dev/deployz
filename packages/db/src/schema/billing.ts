import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import {
  billingEventProcessingStatusEnum,
  billingProviderEnum,
  billingReconciliationStatusEnum,
  billingSubscriptionStatusEnum,
} from '../enums.js';
import { organization } from './auth.js';
import { createdAt, id, updatedAt } from './common.js';

// Paddle migration Phase 3 — minimal billing schema. `provider` exists so a
// row says what it is, nothing more; this is not a multi-provider system.

// One row per organization. No row means evaluation mode (no subscription
// yet). Written by the Phase 6 webhook handler.
export const billingSubscriptions = pgTable('billing_subscriptions', {
  id: id(),
  organizationId: text('organization_id')
    .notNull()
    .unique()
    .references(() => organization.id),
  provider: billingProviderEnum('provider').notNull().default('PADDLE'),
  providerCustomerId: text('provider_customer_id').notNull(),
  providerSubscriptionId: text('provider_subscription_id').notNull().unique(),
  status: billingSubscriptionStatusEnum('status').notNull(),
  currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  lastProviderEventAt: timestamp('last_provider_event_at', { withTimezone: true }),
  lastReconciledAt: timestamp('last_reconciled_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// Raw webhook event log. `providerEventId` unique so a redelivered webhook is
// dedupe-checked at the database, not only in application code.
export const billingProviderEvents = pgTable('billing_provider_events', {
  id: id(),
  provider: billingProviderEnum('provider').notNull().default('PADDLE'),
  providerEventId: text('provider_event_id').notNull().unique(),
  eventType: text('event_type').notNull(),
  organizationId: text('organization_id').references(() => organization.id),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  processingStatus: billingEventProcessingStatusEnum('processing_status')
    .notNull()
    .default('RECEIVED'),
  error: text('error'),
  createdAt: createdAt(),
});

// One row per reconciliation pass (Phase 9): what the control plane expected
// to bill vs what the provider reports, and what action (if any) was taken.
export const billingReconciliationEvents = pgTable('billing_reconciliation_events', {
  id: id(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id),
  expectedDeploymentQuantity: integer('expected_deployment_quantity').notNull(),
  providerDeploymentQuantity: integer('provider_deployment_quantity'),
  action: text('action').notNull(),
  status: billingReconciliationStatusEnum('status').notNull(),
  error: text('error'),
  createdAt: createdAt(),
});
