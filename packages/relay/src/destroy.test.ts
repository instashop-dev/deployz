import { describe, expect, it } from 'vitest';

import { createDestroyExecutor, createDestroyResumer, settleDestroy, type StackDeleter } from './destroy.js';
import { memoryPendingStore } from './pending.js';
import type { CloudFormationReader, StackLookup } from './verify.js';

const INSTALLATION_ID = 'inst-destroy-test';
const STACK_NAME = 'deployz-app';

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
) {
  return {
    cfn,
    deleter,
    pending: memoryPendingStore(),
    installationId: INSTALLATION_ID,
    stackName: STACK_NAME,
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

  it('reports DELETE_FAILED as a failure', async () => {
    const outcome = await settleDestroy(deps(cfnReturning(taggedStack('DELETE_FAILED'))));
    expect(outcome.state).toBe('failed');
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

  it('fails with STACK_DELETE_FAILED when a DELETE_FAILED stack is found', async () => {
    const d = deps(cfnReturning(taggedStack('DELETE_FAILED')));
    const result = await createDestroyExecutor(d)(destroyCommand());
    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('STACK_DELETE_FAILED');
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
