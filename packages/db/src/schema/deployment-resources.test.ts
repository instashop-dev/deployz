import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { persistDeploymentResourceSnapshot } from '../deployment-resources-persist.js';
import { createTestDb, seedBase, type TestContext } from '../test-utils.js';
import { deploymentResources, deployments } from './index.js';

const STACK_ID = 'arn:aws:cloudformation:us-east-1:123456789012:stack/deployz-app/abc';

function resource(logicalId: string, type: string, status: string, extra: Record<string, unknown> = {}) {
  return { logicalId, type, status, ...extra };
}

describe('persistDeploymentResourceSnapshot', () => {
  let client: PGlite | undefined;
  let ctx: TestContext;
  let deploymentId: string;

  beforeAll(async () => {
    ({ client, db: ctx } = await createTestDb());
    const base = await seedBase(ctx);
    const created = await ctx
      .insert(deployments)
      .values({
        customerId: base.customerId,
        applicationId: base.applicationId,
        organizationId: base.organizationId,
        region: 'us-east-1',
        enrollmentCode: 'code-1',
      })
      .returning({ id: deployments.id });
    deploymentId = created[0]!.id;
  });

  afterAll(async () => {
    await client?.close();
  });

  async function rows(): Promise<Array<Record<string, unknown>>> {
    const result = await ctx.select().from(deploymentResources).orderBy(deploymentResources.logicalResourceId);
    return result;
  }

  it('inserts a classified snapshot on first observation', async () => {
    const result = await persistDeploymentResourceSnapshot(ctx, {
      deploymentId,
      stackId: STACK_ID,
      observedAt: '2026-09-01T12:00:00.000Z',
      resources: [
        resource('Database', 'AWS::RDS::DBInstance', 'CREATE_COMPLETE'),
        resource('AppStorage', 'AWS::S3::Bucket', 'CREATE_COMPLETE'),
        resource('Service', 'AWS::ECS::Service', 'CREATE_IN_PROGRESS'),
      ],
    });

    expect(result).toEqual({ persisted: true, count: 3 });
    const all = await rows();
    expect(all).toHaveLength(3);

    const database = all.find((r) => r.logicalResourceId === 'Database');
    expect(database).toMatchObject({
      stackId: STACK_ID,
      resourceType: 'AWS::RDS::DBInstance',
      resourceStatus: 'ready',
      rawResourceStatus: 'CREATE_COMPLETE',
      componentKind: 'database',
      resourceRole: 'primary',
      lifecyclePolicy: 'retain',
    });
    expect(all.find((r) => r.logicalResourceId === 'Service')).toMatchObject({
      resourceStatus: 'provisioning',
      rawResourceStatus: 'CREATE_IN_PROGRESS',
      componentKind: 'application',
      resourceRole: 'primary',
      lifecyclePolicy: 'delete',
    });
  });

  it('updates an existing row, keeping firstSeenAt', async () => {
    const result = await persistDeploymentResourceSnapshot(ctx, {
      deploymentId,
      stackId: STACK_ID,
      observedAt: '2026-09-01T12:05:00.000Z',
      resources: [resource('Service', 'AWS::ECS::Service', 'CREATE_COMPLETE')],
    });

    expect(result).toEqual({ persisted: true, count: 1 });
    const service = (await rows()).find((r) => r.logicalResourceId === 'Service');
    expect(service).toMatchObject({
      resourceStatus: 'ready',
      lastUpdatedAt: new Date('2026-09-01T12:05:00.000Z'),
      firstSeenAt: new Date('2026-09-01T12:00:00.000Z'),
    });
  });

  it('is idempotent — the same observedAt twice persists the same row', async () => {
    const again = await persistDeploymentResourceSnapshot(ctx, {
      deploymentId,
      stackId: STACK_ID,
      observedAt: '2026-09-01T12:05:00.000Z',
      resources: [resource('Service', 'AWS::ECS::Service', 'CREATE_COMPLETE')],
    });

    expect(again).toEqual({ persisted: true, count: 1 });
    expect((await rows()).filter((r) => r.logicalResourceId === 'Service')).toHaveLength(1);
  });

  it('rejects a stale observation — an older observedAt never overwrites a newer one', async () => {
    await persistDeploymentResourceSnapshot(ctx, {
      deploymentId,
      stackId: STACK_ID,
      observedAt: '2026-09-01T13:00:00.000Z',
      resources: [resource('Database', 'AWS::RDS::DBInstance', 'UPDATE_COMPLETE')],
    });

    const stale = await persistDeploymentResourceSnapshot(ctx, {
      deploymentId,
      stackId: STACK_ID,
      observedAt: '2026-09-01T12:30:00.000Z',
      resources: [resource('Database', 'AWS::RDS::DBInstance', 'CREATE_FAILED', { statusReason: 'boom' })],
    });

    expect(stale).toEqual({ persisted: true, count: 0 });
    const database = (await rows()).find((r) => r.logicalResourceId === 'Database');
    expect(database).toMatchObject({
      resourceStatus: 'ready',
      resourceStatusReason: null,
      lastUpdatedAt: new Date('2026-09-01T13:00:00.000Z'),
    });
  });

  it('keeps the final snapshot after a later null observation (no-op)', async () => {
    const before = await rows();
    expect(before.length).toBeGreaterThan(0);

    const nullResult = await persistDeploymentResourceSnapshot(ctx, {
      deploymentId,
      stackId: STACK_ID,
      observedAt: '2026-09-01T14:00:00.000Z',
      resources: null,
    });

    expect(nullResult).toEqual({ persisted: false, reason: 'no-snapshot' });
    const after = await rows();
    expect(after).toEqual(before);
  });

  it('persists status reasons and physical ids but nothing else', async () => {
    const result = await persistDeploymentResourceSnapshot(ctx, {
      deploymentId,
      stackId: STACK_ID,
      observedAt: '2026-09-01T15:00:00.000Z',
      resources: [
        resource('Cache', 'AWS::ElastiCache::ReplicationGroup', 'CREATE_FAILED', {
          physicalId: 'cluster-abc',
          statusReason: 'Subnet group not found',
        }),
      ],
    });

    expect(result).toEqual({ persisted: true, count: 1 });
    const cache = (await rows()).find((r) => r.logicalResourceId === 'Cache');
    expect(cache).toMatchObject({
      physicalResourceId: 'cluster-abc',
      resourceStatus: 'failed',
      rawResourceStatus: 'CREATE_FAILED',
      resourceStatusReason: 'Subnet group not found',
      componentKind: 'cache',
      lifecyclePolicy: 'delete',
    });
  });
});