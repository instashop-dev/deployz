import { describe, expect, it } from 'vitest';

import {
  recoverFailedInstallStack,
  type CacheCleanupClient,
  type PhysicalStackResource,
  type RecoveryCloudFormation,
  type RdsCleanupClient,
} from './recover.js';
import type { StackLookup } from './verify.js';

const STACK = 'deployz-app';
const NO_SLEEP = { pollIntervalMs: 0, maxAttempts: 3, sleep: async () => {} };

function lookup(status: string): StackLookup {
  return {
    found: true,
    stack: { stackName: STACK, status, tags: { 'deployz:installation': 'inst' } },
  };
}

interface ActorScript {
  initial?: StackLookup;
  /** One status sequence per deleteStack call; the last sequence repeats. */
  afterDelete?: string[][];
  resources?: PhysicalStackResource[];
}

/**
 * A scripted actor: `initial` is what the first DescribeStacks returns; each
 * delete call then installs its own status sequence, walked one status per
 * subsequent poll (the last status repeats). deleteStack calls are recorded.
 */
function scriptedActor(script: ActorScript): RecoveryCloudFormation & { deleteCalls: string[] } {
  const deleteCalls: string[] = [];
  let deleteIndex = 0;
  let walk: string[] = [];
  let polls = 0;

  let current = script.initial ?? { found: false as const };

  return {
    deleteCalls,
    async describeStack() {
      if (walk.length === 0) {
        return current;
      }
      const status = walk[Math.min(polls++, walk.length - 1)]!;
      return lookup(status);
    },
    async describeStackResources() {
      return script.resources ?? [];
    },
    async deleteStack(stackName) {
      deleteCalls.push(stackName);
      const seq = script.afterDelete?.[Math.min(deleteIndex++, (script.afterDelete.length - 1))] ?? [];
      walk = seq;
      polls = 0;
      current = lookup(seq[seq.length - 1] ?? 'DELETE_IN_PROGRESS');
    },
  };
}

function rdsFake(): RdsCleanupClient & {
  unprotected: string[];
  deleted: string[];
} {
  const unprotected: string[] = [];
  const deleted: string[] = [];
  return {
    unprotected,
    deleted,
    async disableDeletionProtection(id) {
      unprotected.push(id);
    },
    async deleteInstance(id) {
      deleted.push(id);
    },
  };
}

function cacheFake(): CacheCleanupClient & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    async deleteCluster(id) {
      deleted.push(id);
    },
  };
}

const DB_ORPHAN: PhysicalStackResource = {
  logicalId: 'Database',
  type: 'AWS::RDS::DBInstance',
  status: 'CREATE_COMPLETE',
  physicalId: 'deployz-app-database-1a2b3c',
};
const CACHE_ORPHAN: PhysicalStackResource = {
  logicalId: 'Cache',
  type: 'AWS::ElastiCache::CacheCluster',
  status: 'CREATE_COMPLETE',
  physicalId: 'deployz-app-cache-4d5e6f',
};

describe('recoverFailedInstallStack', () => {
  it('deletes a ROLLBACK_COMPLETE stack cleanly when nothing is retained', async () => {
    const actor = scriptedActor({
      initial: lookup('ROLLBACK_COMPLETE'),
      afterDelete: [['DELETE_IN_PROGRESS', 'DELETE_COMPLETE']],
    });
    const rds = rdsFake();

    const report = await recoverFailedInstallStack(
      { cfn: actor, rds, wait: NO_SLEEP },
      { stackName: STACK },
    );

    expect(report.phase).toBe('STACK_DELETED');
    expect(actor.deleteCalls).toEqual([STACK]);
    expect(rds.deleted).toHaveLength(0);
  });

  it('clears retained blockers (RDS deletion protection, cache) and re-deletes a DELETE_FAILED stack', async () => {
    const actor = scriptedActor({
      initial: lookup('DELETE_FAILED'),
      afterDelete: [['DELETE_FAILED'], ['DELETE_COMPLETE']],
      resources: [DB_ORPHAN, CACHE_ORPHAN],
    });
    const rds = rdsFake();
    const cache = cacheFake();

    const report = await recoverFailedInstallStack(
      { cfn: actor, rds, cache, wait: NO_SLEEP },
      { stackName: STACK },
    );

    expect(report.phase).toBe('BLOCKERS_CLEARED_STACK_GONE');
    expect(report.orphansDeleted).toEqual([DB_ORPHAN.physicalId, CACHE_ORPHAN.physicalId]);
    expect(rds.unprotected).toEqual([DB_ORPHAN.physicalId]);
    expect(rds.deleted).toEqual([DB_ORPHAN.physicalId]);
    expect(cache.deleted).toEqual([CACHE_ORPHAN.physicalId]);
    expect(actor.deleteCalls).toEqual([STACK, STACK]);
  });

  it('leaves a healthy stack untouched, whatever the caller claims', async () => {
    const actor = scriptedActor({ initial: lookup('CREATE_COMPLETE') });
    const rds = rdsFake();

    const report = await recoverFailedInstallStack(
      { cfn: actor, rds, wait: NO_SLEEP },
      { stackName: STACK },
    );

    expect(report.phase).toBe('REFUSED_LIVE_STACK');
    expect(actor.deleteCalls).toHaveLength(0);
    expect(rds.deleted).toHaveLength(0);
  });

  it('refuses an in-progress stack (another mutation is running)', async () => {
    const actor = scriptedActor({ initial: lookup('CREATE_IN_PROGRESS') });

    const report = await recoverFailedInstallStack(
      { cfn: actor, wait: NO_SLEEP },
      { stackName: STACK },
    );

    expect(report.phase).toBe('REFUSED_IN_PROGRESS');
    expect(actor.deleteCalls).toHaveLength(0);
  });

  it('is a no-op when no stack exists', async () => {
    const actor = scriptedActor({});

    const report = await recoverFailedInstallStack(
      { cfn: actor, wait: NO_SLEEP },
      { stackName: STACK },
    );

    expect(report.phase).toBe('ALREADY_ABSENT');
    expect(actor.deleteCalls).toHaveLength(0);
  });

  it('reports DELETE_STUCK when the re-delete fails again', async () => {
    const actor = scriptedActor({
      initial: lookup('DELETE_FAILED'),
      afterDelete: [['DELETE_FAILED'], ['DELETE_FAILED']],
      resources: [DB_ORPHAN],
    });
    const rds = rdsFake();

    const report = await recoverFailedInstallStack(
      { cfn: actor, rds, wait: NO_SLEEP },
      { stackName: STACK },
    );

    expect(report.phase).toBe('DELETE_STUCK');
    expect(report.orphansDeleted).toEqual([DB_ORPHAN.physicalId]);
    expect(actor.deleteCalls).toEqual([STACK, STACK]);
  });

  it('skips orphan cleanup for a type with no matching client', async () => {
    const actor = scriptedActor({
      initial: lookup('DELETE_FAILED'),
      afterDelete: [['DELETE_FAILED']],
      resources: [CACHE_ORPHAN],
    });
    const rds = rdsFake();
    // no cache client injected

    const report = await recoverFailedInstallStack(
      { cfn: actor, rds, wait: NO_SLEEP },
      { stackName: STACK },
    );

    expect(report.orphansDeleted).toEqual([]);
    expect(actor.deleteCalls).toEqual([STACK]);
  });

  it('reports DELETE_IN_PROGRESS when the delete budget runs out', async () => {
    const actor = scriptedActor({
      initial: lookup('ROLLBACK_COMPLETE'),
      afterDelete: [['DELETE_IN_PROGRESS']],
    });

    const report = await recoverFailedInstallStack(
      { cfn: actor, wait: NO_SLEEP },
      { stackName: STACK },
    );

    expect(report.phase).toBe('DELETE_IN_PROGRESS');
    expect(report.lastStackStatus).toBe('DELETE_IN_PROGRESS');
  });
});
