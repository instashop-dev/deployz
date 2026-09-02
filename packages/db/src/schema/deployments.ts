import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import {
  cleanupStateEnum,
  deploymentStateEnum,
  healthStatusEnum,
  regionEnum,
  relayStatusEnum,
} from '../enums.js';
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
  // §46 health starts UNKNOWN, not HEALTHY: a deployment that has never
  // checked in has no observed health, and rendering one as healthy is the
  // product asserting something it never measured.
  healthStatus: healthStatusEnum('health_status').notNull().default('UNKNOWN'),
  desiredState: jsonb('desired_state').$type<Record<string, unknown>>().notNull().default({}),
  observedState: jsonb('observed_state').$type<Record<string, unknown>>(),
  // Write-once observational timestamps for the derived deployment `step`
  // (apps/api/src/deployment-status.ts) — NOT a persisted lifecycle. Keyed by
  // DeploymentStep, `{ startedAt, completedAt? }` per step. Populated by
  // apps/api/src/step-timings.ts from the relay-authenticated write paths so
  // the event_logs `deployment.step_completed` stream has a duration to cite.
  stepTimings: jsonb('step_timings').$type<Record<string, { startedAt: string; completedAt?: string }>>(),
  infraVersion: text('infra_version').notNull().default('runtime-v1'),
  // §12 enrollment. Three identifiers, deliberately separate:
  //   installLinkId  — the only one in a customer-facing URL (/install/:id).
  //   enrollmentCode — single use, carried into the bootstrap stack as a
  //                    template parameter and traded once for a binding.
  //   installationId — the id the RELAY mints for itself inside the customer
  //                    account, unknown until it enrolls, hence nullable.
  // Before this split the install URL carried the relay's own id, so anyone
  // holding the link could register a token of their own and take the
  // deployment over.
  installLinkId: uuid('install_link_id').notNull().unique().defaultRandom(),
  enrollmentCode: text('enrollment_code').notNull().unique(),
  enrollmentUsedAt: timestamp('enrollment_used_at', { withTimezone: true }),
  installationId: text('installation_id').unique(),
  // Retry-isolation fields: the attempt counter keeps Quick Create stack
  // names fresh across retries (a ROLLBACK_COMPLETE stack never blocks the
  // next attempt), bootstrap_stack_name is the expected name of the current
  // attempt, and install_started_at marks when the customer launched AWS.
  attemptNumber: integer('attempt_number').notNull().default(0),
  bootstrapStackName: text('bootstrap_stack_name'),
  installStartedAt: timestamp('install_started_at', { withTimezone: true }),
  // Phase 5 §9.6: the identifiers a relay/reset REPLACED. A reset nulls
  // installationId and may rename the bootstrap stack, so the previous
  // stack's retained resources stay attributable to this deployment — a
  // later purge carries these to find them instead of silently orphaning.
  previousInstallationId: text('previous_installation_id'),
  previousBootstrapStackName: text('previous_bootstrap_stack_name'),
  // sha256 of the relay's bearer token. Stored (not the plaintext) and in
  // Postgres (not in memory) so a restart cannot reopen the enrollment.
  relayTokenHash: text('relay_token_hash'),
  relayBoundAt: timestamp('relay_bound_at', { withTimezone: true }),
  // Relay identity, reported at enrollment and on every heartbeat. Older
  // relays never report these — they stay null, which the UI reads as
  // "capabilities unknown" and gates unsupported actions on.
  relayVersion: text('relay_version'),
  bootstrapVersion: text('bootstrap_version'),
  relayCapabilities: jsonb('relay_capabilities').$type<Record<string, boolean>>(),
  isTestDeployment: boolean('is_test_deployment').notNull().default(false),
  lastHealthAt: timestamp('last_health_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  // Null on a normal disconnect (relay removed the resources). Set only when
  // the control plane knows something about the AWS-side leftovers.
  cleanupState: cleanupStateEnum('cleanup_state'),
  ...auditFields(),
});
