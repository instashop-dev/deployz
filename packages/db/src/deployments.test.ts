import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Db } from './client.js';
import { deployments } from './schema/index.js';
import { createTestDb, seedBase, type BaseIds } from './test-utils.js';

// §59/§60 desired-state model + §62 audit fields + §7 test-deployment flag.
describe('deployments desired-state and audit fields', () => {
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

  it('defaults state to NOT_INSTALLED, infra_version to runtime-v1, is_test_deployment to false', async () => {
    const id = crypto.randomUUID();
    await db!.insert(deployments).values({
      id,
      customerId: ids.customerId,
      applicationId: ids.applicationId,
      organizationId: ids.organizationId,
      region: 'us-east-1',
      installationId: 'inst-defaults',
    });
    const [row] = await db!.select().from(deployments).where(eq(deployments.id, id));
    expect(row?.state).toBe('NOT_INSTALLED');
    expect(row?.infraVersion).toBe('runtime-v1');
    expect(row?.isTestDeployment).toBe(false);
    expect(row?.observedState).toBeNull();
    expect(row?.desiredState).toEqual({});
    expect(row?.lastHealthAt).toBeNull();
    expect(row?.relayStatus).toBe('UNKNOWN');
    expect(row?.healthStatus).toBe('HEALTHY');
    expect(row?.deletedAt).toBeNull();
    expect(row?.awsAccountId).toBeNull();
    expect(row?.currentReleaseId).toBeNull();
    expect(row?.previousReleaseId).toBeNull();
  });

  it('round-trips desired_state and observed_state jsonb (§59)', async () => {
    const id = crypto.randomUUID();
    const desired = { instanceType: 't3.micro', replicas: 2, env: { LOG_LEVEL: 'info' } };
    await db!.insert(deployments).values({
      id,
      customerId: ids.customerId,
      applicationId: ids.applicationId,
      organizationId: ids.organizationId,
      region: 'eu-west-1',
      installationId: 'inst-jsonb',
      desiredState: desired,
    });

    const observed = { instanceType: 't3.micro', replicas: 2, running: true };
    await db!.update(deployments).set({ observedState: observed }).where(eq(deployments.id, id));

    const [row] = await db!.select().from(deployments).where(eq(deployments.id, id));
    expect(row?.desiredState).toEqual(desired);
    expect(row?.observedState).toEqual(observed);
  });

  it('carries §62 audit fields (created_by/updated_by + timestamps)', async () => {
    const id = crypto.randomUUID();
    await db!.insert(deployments).values({
      id,
      customerId: ids.customerId,
      applicationId: ids.applicationId,
      organizationId: ids.organizationId,
      region: 'us-east-1',
      installationId: 'inst-audit',
      createdBy: 'user_admin',
    });
    const [row] = await db!.select().from(deployments).where(eq(deployments.id, id));
    expect(row?.createdBy).toBe('user_admin');
    expect(row?.updatedBy).toBeNull();
    expect(row?.createdAt).toBeInstanceOf(Date);
    expect(row?.updatedAt).toBeInstanceOf(Date);
  });
});
