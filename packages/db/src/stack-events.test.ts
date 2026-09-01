import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Db } from './client.js';
import { deploymentStackEvents, deployments } from './schema/index.js';
import { createTestDb, seedBase, type BaseIds } from './test-utils.js';

describe('deployment_stack_events', () => {
  let client: PGlite | undefined;
  let db: Db | undefined;
  let ids: BaseIds;

  beforeAll(async () => {
    ({ client, db } = await createTestDb());
    ids = await seedBase(db);
  });

  afterAll(async () => {
    await client?.close();
  });

  it('stores one row per (deployment, provider event id) and ignores duplicates', async () => {
    const [deployment] = await db!
      .insert(deployments)
      .values({
        customerId: ids.customerId,
        applicationId: ids.applicationId,
        organizationId: ids.organizationId,
        region: 'us-east-1',
        enrollmentCode: 'code-stack-events',
      })
      .returning();

    const row = {
      deploymentId: deployment!.id,
      providerEventId: 'event-1',
      eventAt: new Date('2026-09-01T10:00:00Z'),
      logicalResourceId: 'Vpc',
      resourceType: 'AWS::EC2::VPC',
      resourceStatus: 'CREATE_IN_PROGRESS',
    };
    await db!.insert(deploymentStackEvents).values(row);
    await db!
      .insert(deploymentStackEvents)
      .values(row)
      .onConflictDoNothing({
        target: [deploymentStackEvents.deploymentId, deploymentStackEvents.providerEventId],
      });

    const rows = await db!.select().from(deploymentStackEvents);
    expect(rows).toHaveLength(1);
  });
});
