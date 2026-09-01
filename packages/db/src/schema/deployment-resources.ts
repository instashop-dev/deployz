import { index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import {
  infrastructureComponentKindEnum,
  infrastructureLifecycleEnum,
  infrastructureResourceRoleEnum,
} from '../enums.js';
import { deployments } from './deployments.js';

// §Infrastructure inventory — one row per CloudFormation resource the relay
// observed in the deployment's application stack.
//
// The table keeps the LAST COMPLETE snapshot per resource, upserted
// idempotently per heartbeat (see persistDeploymentResourceSnapshot in
// ../deployment-resources.ts). No cascade on deployments: the snapshot
// outlives a soft-deleted deployment row, and no hard deletion ever runs.
//
// resource_status carries the PRODUCT status (mapResourceStatus in
// @deployz/contracts) — never raw CloudFormation wording — while
// raw_resource_status keeps the raw AWS status verbatim (CREATE_COMPLETE,
// CREATE_FAILED, …) for the technical disclosure, and
// resource_status_reason keeps CFN's sanitized reason for the state. Only
// these columns are persisted: no ResourceProperties, credentials, secret
// values, or environment variables ever reach this table.
export const deploymentResources = pgTable(
  'deployment_resources',
  {
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => deployments.id),
    stackId: text('stack_id').notNull(),
    logicalResourceId: text('logical_resource_id').notNull(),
    physicalResourceId: text('physical_resource_id'),
    resourceType: text('resource_type').notNull(),
    resourceStatus: text('resource_status').notNull(),
    rawResourceStatus: text('raw_resource_status'),
    resourceStatusReason: text('resource_status_reason'),
    componentKind: infrastructureComponentKindEnum('component_kind').notNull(),
    resourceRole: infrastructureResourceRoleEnum('resource_role').notNull(),
    lifecyclePolicy: infrastructureLifecycleEnum('lifecycle_policy').notNull(),
    lastUpdatedAt: timestamp('last_updated_at', { withTimezone: true }).notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('deployment_resources_deployment_stack_logical_unique').on(
      table.deploymentId,
      table.stackId,
      table.logicalResourceId,
    ),
    index('deployment_resources_deployment_idx').on(table.deploymentId),
    index('deployment_resources_deployment_kind_idx').on(table.deploymentId, table.componentKind),
  ],
);