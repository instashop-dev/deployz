import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { failureCodeEnum, jobStateEnum, jobTypeEnum } from '../enums.js';
import { auditFields, id } from './common.js';
import { deployments } from './deployments.js';

// §39 DeploymentJob — the unit of work the relay executes.
export const deploymentJobs = pgTable('deployment_jobs', {
  id: id(),
  deploymentId: uuid('deployment_id')
    .notNull()
    .references(() => deployments.id),
  // §39 job type (INSTALL … HEALTH_REPORT).
  type: jobTypeEnum('type').notNull(),
  // §39 job state. WAITING semantics: waiting on customer approval OR on
  // relay pickup — payload/result disambiguates which.
  state: jobStateEnum('state').notNull().default('REQUESTED'),
  // §39 idempotency: retries with the same key must not double-execute.
  idempotencyKey: text('idempotency_key').notNull().unique(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  result: jsonb('result').$type<Record<string, unknown>>(),
  // §61 stable failure code, set only on FAILED.
  failureCode: failureCodeEnum('failure_code'),
  // Better Auth text user id. No FK by design: job history must outlive
  // user deletion.
  requestedBy: text('requested_by'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  ...auditFields(),
});
