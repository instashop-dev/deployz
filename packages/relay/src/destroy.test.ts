import { describe, expect, it } from 'vitest';

import { createDestroyExecutor, createDestroyResumer, settleDestroy, type StackDeleter } from './destroy.js';
import { memoryPendingStore } from './pending.js';
import type { CacheCleanupClient, RdsCleanupClient, WaitOptions } from './recover.js';
import type { CloudFormationReader, StackLookup, StackResource } from './verify.js';

const INSTALLATION_ID = 'inst-destroy-test';
const STACK_NAME = 'deployz-app';
const NO_SLEEP: WaitOptions = { pollIntervalMs: 0, maxAttempts: 3, sleep: async () => {} };

function cfnReturning(lookup: StackLookup): CloudFormationReader {
  return {
    async describeStack() {
      return lookup;
    },
    async describeStackResources() {
      return [];
    },
  };
}

function cfnMissing(): CloudFormationReader {
  return {
    async describeStack() {
      return { found: false };
    },
    async describeStackResources() {
      return [];
    },
  };
}

function deleterRecording(): StackDeleter & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    async deleteStack(stackName) {
      deleted.push(stackName);
    },
  };
}

function deps(
  cfn: CloudFormationReader,
  deleter: StackDeleter = deleterRecording(),
  extra: { rds?: RdsCleanupClient; cache?: CacheCleanupClient; wait?: WaitOptions } = {},
) {
  return {
    cfn,
    deleter,
    pending: memoryPendingStore(),
    installationId: INSTALLATION_ID,
    stackName: STACK_NAME,
    ...extra,
  };
}

function taggedStack(status: string, installationId = INSTALLATION_ID): StackLookup {
  return {
    found: true,
    stack: {
      stackName: STACK_NAME,
      status,
      tags: { 'deployz:installation': installationId },
    },
  };
}

const DB_ORPHAN: StackResource = {
  logicalId: 'Database',
  type: 'AWS::RDS::DBInstance',
  status: 'DELETE_FAILED',
  physicalId: 'deployz-app-database-1a2b3c',
};

const STUCK_SECURITY_GROUP: StackResource = {
  logicalId: 'AppSecurityGroup',
  type: 'AWS::EC2::SecurityGroup',
  status: 'DELETE_FAILED',
  physicalId: 'sg-0123456789abcdef0',
};

function rdsFake(): RdsCleanupClient & { unprotected: string[]; deleted: string[] } {
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

/**
 * A DELETE_FAILED stack whose retry either clears (walking to
 * DELETE_COMPLETE, after which it reports absent — the real-world way a
 * finished delete is eventually observed) or stays stuck. `resources` is
 * what `describeStackResources` returns throughout — DELETE_FAILED stacks
 * keep their resource list readable.
 */
function scriptedDeleteFailedStack(afterRetry: string[], resources: StackResource[] = []) {
  const deleted: string[] = [];
  let walk: string[] = [];
  let polls = 0;
  let current: StackLookup = taggedStack('DELETE_FAILED');

  const cfn: CloudFormationReader = {
    async describeStack() {
      if (polls < walk.length) {
        return taggedStack(walk[polls++]!);
      }
      return current;
    },
    async describeStackResources() {
      return resources;
    },
  };

  const retained: (readonly string[])[] = [];
  const deleter: StackDeleter & { deleted: string[]; retained: (readonly string[])[] } = {
    deleted,
    retained,
    async deleteStack(stackName, retainResources) {
      deleted.push(stackName);
      if (retainResources) retained.push(retainResources);
      walk = afterRetry;
      polls = 0;
      const last = afterRetry[afterRetry.length - 1] ?? 'DELETE_IN_PROGRESS';
      current = last === 'DELETE_COMPLETE' ? { found: false } : taggedStack(last);
    },
  };

  return { cfn, deleter };
}

describe('settleDestroy', () => {
  it('reports success without deleting when the stack is already absent', async () => {
    const d = deps(cfnMissing());
    const deleter = d.deleter as ReturnType<typeof deleterRecording>;
    const outcome = await settleDestroy(d);
    expect(outcome).toEqual({ state: 'succeeded', alreadyAbsent: true });
    expect(deleter.deleted).toHaveLength(0);
  });

  it('refuses to delete a stack carrying a different installation tag', async () => {
    const outcome = await settleDestroy(deps(cfnReturning(taggedStack('CREATE_COMPLETE', 'inst-other'))));
    expect(outcome).toEqual({ state: 'failed', reason: expect.stringContaining('tag') });
  });

  it('refuses to delete an untagged stack', async () => {
    const lookup: StackLookup = {
      found: true,
      stack: { stackName: STACK_NAME, status: 'CREATE_COMPLETE', tags: {} },
    };
    const outcome = await settleDestroy(deps(cfnReturning(lookup)));
    expect(outcome.state).toBe('failed');
  });

  it('reports DELETE_FAILED as a failure when there are no known orphans to clear', async () => {
    const outcome = await settleDestroy(deps(cfnReturning(taggedStack('DELETE_FAILED'))));
    expect(outcome).toEqual({ state: 'failed', reason: expect.stringContaining('DELETE_FAILED') });
  });

  it('reports DELETE_IN_PROGRESS as still deleting', async () => {
    const outcome = await settleDestroy(deps(cfnReturning(taggedStack('DELETE_IN_PROGRESS'))));
    expect(outcome).toEqual({ state: 'deleting' });
  });

  it('starts deletion of a tagged, non-deleting stack', async () => {
    const deleter = deleterRecording();
    const outcome = await settleDestroy(deps(cfnReturning(taggedStack('CREATE_COMPLETE')), deleter));
    expect(outcome).toEqual({ state: 'deleting' });
    expect(deleter.deleted).toEqual([STACK_NAME]);
  });

  it('clears an orphaned, protected RDS instance and retries the delete on DELETE_FAILED', async () => {
    const { cfn, deleter } = scriptedDeleteFailedStack(['DELETE_IN_PROGRESS', 'DELETE_COMPLETE'], [
      DB_ORPHAN,
    ]);
    const rds = rdsFake();

    const outcome = await settleDestroy(deps(cfn, deleter, { rds, wait: NO_SLEEP }), true);

    expect(outcome).toEqual({ state: 'succeeded', alreadyAbsent: false });
    expect(rds.unprotected).toEqual([DB_ORPHAN.physicalId]);
    expect(rds.deleted).toEqual([DB_ORPHAN.physicalId]);
    expect(deleter.deleted).toEqual([STACK_NAME]);
  });

  it('reports a failure naming the still-blocked resource when the retry fails again', async () => {
    // The RDS orphan clears, but a security group the relay has no IAM to
    // touch keeps the stack stuck — the retry fails the same way.
    const { cfn, deleter } = scriptedDeleteFailedStack(['DELETE_FAILED'], [
      DB_ORPHAN,
      STUCK_SECURITY_GROUP,
    ]);
    const rds = rdsFake();

    const outcome = await settleDestroy(deps(cfn, deleter, { rds, wait: NO_SLEEP }), true);

    expect(outcome.state).toBe('failed');
    expect((outcome as { reason: string }).reason).toContain('AWS::EC2::SecurityGroup');
    expect(rds.deleted).toEqual([DB_ORPHAN.physicalId]);
    expect(deleter.deleted).toEqual([STACK_NAME]);
  });

  it('finishes a DELETE_FAILED stack by RETAINING the blocked resources when data deletion is not authorized', async () => {
    // The default path: a deployment that ever ran keeps its database. The
    // relay never touches the orphan — it re-issues the delete retaining
    // exactly the resources CloudFormation reported stuck.
    const { cfn, deleter } = scriptedDeleteFailedStack(['DELETE_IN_PROGRESS'], [
      DB_ORPHAN,
      STUCK_SECURITY_GROUP,
    ]);
    const rds = rdsFake();

    const outcome = await settleDestroy(deps(cfn, deleter, { rds, wait: NO_SLEEP }));

    expect(outcome).toEqual({ state: 'deleting' });
    expect(rds.unprotected).toEqual([]);
    expect(rds.deleted).toEqual([]);
    expect(deleter.retained).toEqual([[DB_ORPHAN.logicalId, STUCK_SECURITY_GROUP.logicalId]]);
  });

  it('re-running destroy after a cleared DELETE_FAILED stack is harmless', async () => {
    const { cfn, deleter } = scriptedDeleteFailedStack(['DELETE_IN_PROGRESS', 'DELETE_COMPLETE'], [
      DB_ORPHAN,
    ]);
    const rds = rdsFake();
    const d = deps(cfn, deleter, { rds, wait: NO_SLEEP });

    const first = await settleDestroy(d, true);
    expect(first).toEqual({ state: 'succeeded', alreadyAbsent: false });

    const second = await settleDestroy(d, true);
    expect(second).toEqual({ state: 'succeeded', alreadyAbsent: true });
    // No second delete attempt — the stack was already gone.
    expect(deleter.deleted).toEqual([STACK_NAME]);
  });
});

describe('createDestroyExecutor', () => {
  function destroyCommand() {
    return {
      id: 'job-destroy',
      deploymentId: 'dep-1',
      type: 'DESTROY' as const,
      idempotencyKey: 'dep-1:DESTROY',
      payload: {},
    };
  }

  it('returns success when the stack is already absent', async () => {
    const d = deps(cfnMissing());
    const result = await createDestroyExecutor(d)(destroyCommand());
    expect(result.success).toBe(true);
    expect((result.output as { alreadyAbsent: boolean }).alreadyAbsent).toBe(true);
  });

  it('fails with STACK_DELETE_FAILED when a DELETE_FAILED stack has no clearable orphans', async () => {
    const d = deps(cfnReturning(taggedStack('DELETE_FAILED')));
    const result = await createDestroyExecutor(d)(destroyCommand());
    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('STACK_DELETE_FAILED');
  });

  it('succeeds when clearing a DELETE_FAILED stack unblocks the retry', async () => {
    const { cfn, deleter } = scriptedDeleteFailedStack(['DELETE_IN_PROGRESS', 'DELETE_COMPLETE'], [
      DB_ORPHAN,
    ]);
    const rds = rdsFake();
    const d = deps(cfn, deleter, { rds, wait: NO_SLEEP });

    const result = await createDestroyExecutor(d)({
      ...destroyCommand(),
      payload: { dataDeletionAuthorized: true },
    });

    expect(result.success).toBe(true);
    expect((result.output as { alreadyAbsent: boolean }).alreadyAbsent).toBe(false);
  });

  it('defers through the pending store when deletion is in progress', async () => {
    const d = deps(cfnReturning(taggedStack('CREATE_COMPLETE')));
    const result = await createDestroyExecutor(d)(destroyCommand());
    expect(result.deferred).toBe(true);
    const pending = await d.pending.read();
    expect(pending?.commandId).toBe('job-destroy');
    expect(pending?.type).toBe('DESTROY');
  });
});

describe('createDestroyResumer', () => {
  it('settles once the stack is gone', async () => {
    let absent = false;
    const cfn: CloudFormationReader = {
      async describeStack() {
        return absent ? { found: false } : taggedStack('DELETE_IN_PROGRESS');
      },
      async describeStackResources() {
        return [];
      },
    };
    const d = deps(cfn);
    await d.pending.write({
      commandId: 'job-destroy',
      idempotencyKey: 'dep-1:DESTROY',
      type: 'DESTROY',
      stackName: STACK_NAME,
      startedAt: new Date().toISOString(),
      payload: {},
    });

    const waiting = await createDestroyResumer(d)();
    expect(waiting).toHaveLength(0);

    absent = true;
    const settled = await createDestroyResumer(d)();
    expect(settled).toHaveLength(1);
    expect(settled[0]!.success).toBe(true);
    expect(await d.pending.read()).toBeNull();
  });

  it('ignores pending commands of other types', async () => {
    const d = deps(cfnMissing());
    await d.pending.write({
      commandId: 'job-install',
      idempotencyKey: 'dep-1:INSTALL',
      type: 'INSTALL',
      stackName: STACK_NAME,
      startedAt: new Date().toISOString(),
      payload: {},
    });
    const results = await createDestroyResumer(d)();
    expect(results).toHaveLength(0);
  });
});
