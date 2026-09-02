import type { PGlite } from '@electric-sql/pglite';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Db } from './client.js';
import { aiExplanationStateEnum } from './enums.js';
import { deploymentJobs, deployments } from './schema/index.js';
import { createTestDb, seedBase, type BaseIds } from './test-utils.js';

// The AI explanation is cached on the deployment ATTEMPT (the job row), not on
// the deployment: the attempt is the thing that failed, and a later attempt of
// the same deployment must get its own explanation rather than inheriting one.
describe('deployment_jobs AI explanation cache', () => {
  let client: PGlite | undefined;
  let db: Db | undefined;
  let ids: BaseIds;
  let deploymentId: string;

  beforeAll(async () => {
    ({ client, db } = await createTestDb());
    ids = await seedBase(db);
    deploymentId = crypto.randomUUID();
    await db.insert(deployments).values({
      id: deploymentId,
      customerId: ids.customerId,
      applicationId: ids.applicationId,
      organizationId: ids.organizationId,
      region: 'us-east-1',
      installationId: 'inst-ai',
      // Minted by the control plane at creation; the relay trades it once.
      enrollmentCode: crypto.randomUUID(),
    });
  });

  afterAll(async () => {
    await client?.close();
  });

  async function insertJob(key: string): Promise<string> {
    // One active mutating job per deployment (partial unique index): settle
    // the previous test's job before inserting the next one.
    await db!
      .update(deploymentJobs)
      .set({ state: 'CANCELLED', finishedAt: new Date() })
      .where(
        and(
          eq(deploymentJobs.deploymentId, deploymentId),
          inArray(deploymentJobs.state, ['REQUESTED', 'QUEUED', 'WAITING', 'RUNNING']),
        ),
      );
    const id = crypto.randomUUID();
    await db!.insert(deploymentJobs).values({
      id,
      deploymentId,
      type: 'DEPLOY_RELEASE',
      idempotencyKey: key,
    });
    return id;
  }

  it('carries the four explanation states', () => {
    expect([...aiExplanationStateEnum.enumValues].sort()).toEqual([
      'FAILED',
      'GENERATING',
      'PENDING',
      'READY',
    ]);
  });

  it('defaults a new job to PENDING with no explanation text', async () => {
    const id = await insertJob('ai-defaults');

    const [row] = await db!
      .select()
      .from(deploymentJobs)
      .where(eq(deploymentJobs.id, id));

    expect(row?.aiExplanationState).toBe('PENDING');
    expect(row?.aiExplanationWhat).toBeNull();
    expect(row?.aiExplanationWhy).toBeNull();
    expect(row?.aiExplanationFix).toBeNull();
    expect(row?.aiExplanationClaimedAt).toBeNull();
    expect(row?.aiExplanationGeneratedAt).toBeNull();
  });

  it('stores a generated explanation', async () => {
    const id = await insertJob('ai-stored');
    const generatedAt = new Date();

    await db!
      .update(deploymentJobs)
      .set({
        aiExplanationState: 'READY',
        aiExplanationWhat: 'what',
        aiExplanationWhy: 'why',
        aiExplanationFix: 'fix',
        aiExplanationGeneratedAt: generatedAt,
      })
      .where(eq(deploymentJobs.id, id));

    const [row] = await db!
      .select()
      .from(deploymentJobs)
      .where(eq(deploymentJobs.id, id));

    expect(row?.aiExplanationState).toBe('READY');
    expect(row?.aiExplanationWhat).toBe('what');
    expect(row?.aiExplanationGeneratedAt).toBeInstanceOf(Date);
  });

  it('leaves the explanation columns independent of job state', async () => {
    // A failed AI explanation must never be mistaken for a failed job.
    const id = await insertJob('ai-independent');

    await db!
      .update(deploymentJobs)
      .set({ aiExplanationState: 'FAILED' })
      .where(eq(deploymentJobs.id, id));

    const [row] = await db!
      .select()
      .from(deploymentJobs)
      .where(eq(deploymentJobs.id, id));

    expect(row?.aiExplanationState).toBe('FAILED');
    expect(row?.state).toBe('REQUESTED');
  });
});
