import { boolean, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { deploymentStateEnum, regionEnum } from '../enums.js';
import { organization } from './auth.js';
import { auditFields, id } from './common.js';
import { applications, customers } from './core.js';

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
  // §32 region allowlist (enum enforces the exact 17).
  region: regionEnum('region').notNull(),
  // §46 product-vocabulary state machine.
  state: deploymentStateEnum('state').notNull().default('NOT_INSTALLED'),
  // §59 desired/observed state model: the control plane reconciles observed
  // toward desired. desired starts as {} until the install request lands.
  desiredState: jsonb('desired_state').$type<Record<string, unknown>>().notNull().default({}),
  observedState: jsonb('observed_state').$type<Record<string, unknown>>(),
  // §60 infra version marker — INFRA_UPGRADE jobs move this forward.
  infraVersion: text('infra_version').notNull().default('runtime-v1'),
  // Install identifier handed to the customer/relay.
  installationId: text('installation_id').notNull().unique(),
  // §7 free test deployment flag.
  isTestDeployment: boolean('is_test_deployment').notNull().default(false),
  lastHealthAt: timestamp('last_health_at', { withTimezone: true }),
  ...auditFields(),
});
