import { boolean, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { deploymentStateEnum, healthStatusEnum, regionEnum, relayStatusEnum } from '../enums.js';
import { organization } from './auth.js';
import { auditFields, id } from './common.js';
import { applications, customers, releases } from './core.js';

export const deployments = pgTable('deployments', {
  id: id(),
  customerId: uuid('customer_id')
    .notNull()
    .references(() => customers.id),
  applicationId: uuid('application_id')
    .notNull()
    .references(() => applications.id),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id),
  region: regionEnum('region').notNull(),
  state: deploymentStateEnum('state').notNull().default('NOT_INSTALLED'),
  awsAccountId: text('aws_account_id'),
  currentReleaseId: uuid('current_release_id').references(() => releases.id),
  previousReleaseId: uuid('previous_release_id').references(() => releases.id),
  relayStatus: relayStatusEnum('relay_status').notNull().default('UNKNOWN'),
  // NULL until the relay reports health for the first time. A deployment
  // that is not installed yet has no health to report, and defaulting it to
  // HEALTHY paints a green fleet row for infrastructure that does not exist.
  healthStatus: healthStatusEnum('health_status'),
  desiredState: jsonb('desired_state').$type<Record<string, unknown>>().notNull().default({}),
  observedState: jsonb('observed_state').$type<Record<string, unknown>>(),
  infraVersion: text('infra_version').notNull().default('runtime-v1'),
  installationId: text('installation_id').notNull().unique(),
  isTestDeployment: boolean('is_test_deployment').notNull().default(false),
  lastHealthAt: timestamp('last_health_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  ...auditFields(),
});
