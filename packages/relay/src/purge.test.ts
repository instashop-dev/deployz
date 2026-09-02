import { describe, expect, it } from 'vitest';

import {
  createPurgeExecutor,
  createPurgeResumer,
  isAccessDenied,
  settlePurge,
  type CachePurgeClient,
  type PurgeDeps,
  type RdsPurgeClient,
  type S3PurgeClient,
} from './purge.js';
import { memoryPendingStore } from './pending.js';
import type { WaitOptions } from './recover.js';
import type { StackDeleter } from './destroy.js';
import type { CloudFormationReader, StackLookup, StackResource } from './verify.js';

const INSTALLATION_ID = 'inst-purge-test';
const APP_STACK = 'deployz-app';
const BOOTSTRAP_STACK = 'deployz-bootstrap';
const NO_SLEEP: WaitOptions = { pollIntervalMs: 0, maxAttempts: 3, sleep: async () => {} };

function appStack(status: string, installationId = INSTALLATION_ID): StackLookup {
  return {
    found: true,
    stack: { stackName: APP_STACK, status, tags: { 'deployz:installation': installationId } },
  };
}

function bootstrapStack(status = 'CREATE_COMPLETE', installationId = INSTALLATION_ID): StackLookup {
  return {
    found: true,
    stack: {
      stackName: BOOTSTRAP_STACK,
      status,
      tags: { 'deployz:installation': installationId },
    },
  };
}

function command() {
  return {
    id: 'cmd-1',
    deploymentId: 'dep-1',
    type: 'PURGE' as const,
    idempotencyKey: 'key-1',
    payload: {},
  };
}

// ── Fakes ────────────────────────────────────────────────────────────────

interface FakedClients {
  calls: string[];
  rds: RdsPurgeClient;
  cache: CachePurgeClient;
  s3: S3PurgeClient;
  deleter: StackDeleter;
}

function clients(calls: string[], owned: {
  instances?: { identifier: string; status: string }[];
  groups?: { identifier: string; status: string }[];
  buckets?: string[];
} = {}): FakedClients {
  const rds: RdsPurgeClient = {
    async listOwnedInstances() {
      return owned.instances ?? [];
    },
    async disableDeletionProtection(identifier) {
      calls.push(`rds:unprotect:${identifier}`);
    },
    async deleteInstance(identifier) {
      calls.push(`rds:delete:${identifier}`);
    },
  };
  const cache: CachePurgeClient = {
    async listOwnedReplicationGroups() {
      return owned.groups ?? [];
    },
    async deleteReplicationGroup(identifier) {
      calls.push(`cache:delete:${identifier}`);
    },
  };
  const s3: S3PurgeClient = {
    async listOwnedBuckets() {
      return owned.buckets ?? [];
    },
    async emptyBucket(bucketName) {
      calls.push(`s3:empty:${bucketName}`);
    },
    async deleteBucket(bucketName) {
      calls.push(`s3:delete:${bucketName}`);
    },
  };
  const deleter: StackDeleter = {
    async deleteStack(stackName) {
      calls.push(`stack:delete:${stackName}`);
    },
  };
  return { calls, rds, cache, s3, deleter };
}

function depsWith(cfn: CloudFormationReader, calls: string[], extra: Partial<PurgeDeps> = {}): PurgeDeps {
  const faked = clients(calls);
  return {
    cfn,
    deleter: faked.deleter,
    pending: memoryPendingStore(),
    installationId: INSTALLATION_ID,
    stackName: APP_STACK,
    bootstrapStackName: BOOTSTRAP_STACK,
    rds: faked.rds,
    cache: faked.cache,
    s3: faked.s3,
    ...extra,
  };
}

// ── settlePurge: application stack ───────────────────────────────────────

describe('settlePurge — application stack phase', () => {
  it('deletes a tagged, present application stack and waits (deferred)', async () => {
    const calls: string[] = [];
    const deps = depsWith(
      {
        async describeStack(stackName) {
          return stackName === APP_STACK ? appStack('CREATE_COMPLETE') : { found: false };
        },
        async describeStackResources() {
          return [];
        },
      },
      calls,
    );

    const outcome = await settlePurge(deps);
    expect(outcome).toEqual({ state: 'purging' });
    expect(calls).toEqual([`stack:delete:${APP_STACK}`]);
  });

  it('refuses an application stack that does not carry this installation tag', async () => {
    const calls: string[] = [];
    const deps = depsWith(
      {
        async describeStack(stackName) {
          return stackName === APP_STACK ? appStack('CREATE_COMPLETE', 'someone-else') : { found: false };
        },
        async describeStackResources() {
          return [];
        },
      },
      calls,
    );

    const outcome = await settlePurge(deps);
    expect(outcome).toEqual({
      state: 'failed',
      reason: `Stack "${APP_STACK}" does not carry this installation's tag — refusing to purge`,
    });
    expect(calls).toEqual([]);
  });

  it('waits on a stack already DELETE_IN_PROGRESS without re-deleting', async () => {
    const calls: string[] = [];
    const deps = depsWith(
      {
        async describeStack(stackName) {
          return stackName === APP_STACK ? appStack('DELETE_IN_PROGRESS') : { found: false };
        },
        async describeStackResources() {
          return [];
        },
      },
      calls,
    );

    const outcome = await settlePurge(deps);
    expect(outcome).toEqual({ state: 'purging' });
    expect(calls).toEqual([]);
  });

  it('clears DELETE_FAILED orphans outright (purge authorizes data deletion) and waits for the retry', async () => {
    const calls: string[] = [];
    const resources: StackResource[] = [
      {
        logicalId: 'Database',
        type: 'AWS::RDS::DBInstance',
        status: 'DELETE_FAILED',
        physicalId: 'deployz-app-database-1a2b3c',
      },
    ];
    let appLookups = 0;
    const deps = depsWith(
      {
        async describeStack(stackName) {
          if (stackName !== APP_STACK) return { found: false };
          appLookups += 1;
          // First lookup: DELETE_FAILED; the retry's poll then sees deletion.
          return appLookups === 1 ? appStack('DELETE_FAILED') : appStack('DELETE_IN_PROGRESS');
        },
        async describeStackResources() {
          return resources;
        },
      },
      calls,
      { wait: NO_SLEEP },
    );

    const outcome = await settlePurge(deps);
    expect(outcome).toEqual({ state: 'purging' });
    expect(calls).toContain('rds:delete:deployz-app-database-1a2b3c');
    expect(calls).toContain(`stack:delete:${APP_STACK}`);
  });
});

// ── settlePurge: owned orphans ────────────────────────────────────────────

describe('settlePurge — orphan sweep', () => {
  function cfnAppAbsent(): CloudFormationReader {
    return {
      async describeStack() {
        return { found: false };
      },
      async describeStackResources() {
        return [];
      },
    };
  }

  it('initiates owned RDS deletion and waits', async () => {
    const calls: string[] = [];
    const deps = depsWith(cfnAppAbsent(), calls, {
      rds: clients(calls, {
        instances: [{ identifier: 'db-1', status: 'available' }],
      }).rds,
    });

    const outcome = await settlePurge(deps);
    expect(outcome).toEqual({ state: 'purging' });
    expect(calls).toEqual(['rds:unprotect:db-1', 'rds:delete:db-1']);
  });

  it('waits on an RDS instance already deleting instead of re-deleting it', async () => {
    const calls: string[] = [];
    const deps = depsWith(cfnAppAbsent(), calls, {
      rds: clients(calls, {
        instances: [{ identifier: 'db-1', status: 'deleting' }],
      }).rds,
    });

    const outcome = await settlePurge(deps);
    expect(outcome).toEqual({ state: 'purging' });
    expect(calls).toEqual([]);
  });

  it('moves on to owned cache groups once no RDS instance remains', async () => {
    const calls: string[] = [];
    const deps = depsWith(cfnAppAbsent(), calls, {
      cache: clients(calls, {
        groups: [{ identifier: 'cache-1', status: 'available' }],
      }).cache,
    });

    const outcome = await settlePurge(deps);
    expect(outcome).toEqual({ state: 'purging' });
    expect(calls).toEqual(['cache:delete:cache-1']);
  });

  it('empties and deletes owned buckets once no RDS or cache remains', async () => {
    const calls: string[] = [];
    const deps = depsWith(cfnAppAbsent(), calls, {
      s3: clients(calls, { buckets: ['bucket-1'] }).s3,
    });

    const outcome = await settlePurge(deps);
    expect(outcome).toEqual({ state: 'purging' });
    expect(calls).toEqual(['s3:empty:bucket-1', 's3:delete:bucket-1']);
  });
});

// ── settlePurge: bootstrap stack, last ────────────────────────────────────

describe('settlePurge — bootstrap stack, last', () => {
  function cfnSweptClean(bootstrap: StackLookup | { found: false }): CloudFormationReader {
    return {
      async describeStack(stackName) {
        if (stackName === APP_STACK) return { found: false };
        return bootstrap;
      },
      async describeStackResources() {
        return [];
      },
    };
  }

  it('deletes the tagged bootstrap stack once everything else is gone', async () => {
    const calls: string[] = [];
    const deps = depsWith(cfnSweptClean(bootstrapStack()), calls);

    const outcome = await settlePurge(deps);
    expect(outcome).toEqual({ state: 'succeeded' });
    expect(calls).toEqual([`stack:delete:${BOOTSTRAP_STACK}`]);
  });

  it('treats an absent or already-deleting bootstrap stack as done', async () => {
    const calls: string[] = [];
    const deleting = depsWith(cfnSweptClean(bootstrapStack('DELETE_IN_PROGRESS')), calls);
    expect(await settlePurge(deleting)).toEqual({ state: 'succeeded' });

    const absent = depsWith(cfnSweptClean({ found: false }), calls);
    expect(await settlePurge(absent)).toEqual({ state: 'succeeded' });
    expect(calls).toEqual([]);
  });

  it('deletes the bootstrap stack by its known name even when it carries no installation tag', async () => {
    // Phase 5 §9.1: the bootstrap stack is created BEFORE the installation
    // id exists, so it can never carry a readable `deployz:installation`
    // tag. Refusing on that impossible tag made the bootstrap removal never
    // run in production; ownership is the NAME baked into the relay's env.
    const calls: string[] = [];
    const untagged = depsWith(cfnSweptClean(bootstrapStack('CREATE_COMPLETE')), calls);

    const outcome = await settlePurge(untagged);
    expect(outcome).toEqual({ state: 'succeeded' });
    expect(calls).toEqual([`stack:delete:${BOOTSTRAP_STACK}`]);

    // A mismatched tag is equally impossible in practice and equally ignored:
    // the deciding fact is the trusted stack name, not a tag that cannot be.
    const mismatched = depsWith(cfnSweptClean(bootstrapStack('CREATE_COMPLETE', 'someone-else')), calls);
    calls.length = 0;
    expect(await settlePurge(mismatched)).toEqual({ state: 'succeeded' });
    expect(calls).toEqual([`stack:delete:${BOOTSTRAP_STACK}`]);
  });
});

// ── Full purge across passes: idempotent, bootstrap last ──────────────────

describe('full purge across passes', () => {
  interface World {
    calls: string[];
    deps: PurgeDeps;
    setAppStack(status: string | null): void;
    setBootstrap(status: string | null): void;
  }

  function world(): World {
    const calls: string[] = [];
    const state = {
      app: 'CREATE_COMPLETE' as string | null,
      bootstrap: 'CREATE_COMPLETE' as string | null,
      instances: [{ identifier: 'db-1', status: 'available' }],
      groups: [{ identifier: 'cache-1', status: 'available' }],
      buckets: ['bucket-1'],
    };
    const cfn: CloudFormationReader = {
      async describeStack(stackName) {
        const status = stackName === APP_STACK ? state.app : state.bootstrap;
        if (status === null) return { found: false };
        return {
          found: true,
          stack: {
            stackName,
            status,
            tags: { 'deployz:installation': INSTALLATION_ID },
          },
        };
      },
      async describeStackResources() {
        return [];
      },
    };
    const rds: RdsPurgeClient = {
      async listOwnedInstances() {
        return [...state.instances];
      },
      async disableDeletionProtection(identifier) {
        calls.push(`rds:unprotect:${identifier}`);
      },
      async deleteInstance(identifier) {
        calls.push(`rds:delete:${identifier}`);
        state.instances = [];
      },
    };
    const cache: CachePurgeClient = {
      async listOwnedReplicationGroups() {
        return [...state.groups];
      },
      async deleteReplicationGroup(identifier) {
        calls.push(`cache:delete:${identifier}`);
        state.groups = [];
      },
    };
    const s3: S3PurgeClient = {
      async listOwnedBuckets() {
        return [...state.buckets];
      },
      async emptyBucket(bucketName) {
        calls.push(`s3:empty:${bucketName}`);
      },
      async deleteBucket(bucketName) {
        calls.push(`s3:delete:${bucketName}`);
        state.buckets = [];
      },
    };
    const deleter: StackDeleter = {
      async deleteStack(stackName) {
        calls.push(`stack:delete:${stackName}`);
        if (stackName === APP_STACK) state.app = 'DELETE_IN_PROGRESS';
        if (stackName === BOOTSTRAP_STACK) state.bootstrap = 'DELETE_IN_PROGRESS';
      },
    };
    return {
      calls,
      deps: {
        cfn,
        deleter,
        pending: memoryPendingStore(),
        installationId: INSTALLATION_ID,
        stackName: APP_STACK,
        bootstrapStackName: BOOTSTRAP_STACK,
        rds,
        cache,
        s3,
      },
      setAppStack(status) {
        state.app = status;
      },
      setBootstrap(status) {
        state.bootstrap = status;
      },
    };
  }

  it('makes forward progress each pass and removes the bootstrap stack last', async () => {
    const w = world();

    // Pass 1: application stack present — delete it, wait.
    expect(await settlePurge(w.deps)).toEqual({ state: 'purging' });
    // CloudFormation finishes the stack delete between polls.
    w.setAppStack(null);

    // Pass 2: owned RDS instance — unprotect, delete, wait.
    expect(await settlePurge(w.deps)).toEqual({ state: 'purging' });
    // Pass 3: owned cache — delete, wait.
    expect(await settlePurge(w.deps)).toEqual({ state: 'purging' });
    // Pass 4: owned bucket — empty, delete, wait.
    expect(await settlePurge(w.deps)).toEqual({ state: 'purging' });
    // Pass 5: everything swept — bootstrap stack goes LAST.
    expect(await settlePurge(w.deps)).toEqual({ state: 'succeeded' });

    expect(w.calls).toEqual([
      `stack:delete:${APP_STACK}`,
      'rds:unprotect:db-1',
      'rds:delete:db-1',
      'cache:delete:cache-1',
      's3:empty:bucket-1',
      's3:delete:bucket-1',
      `stack:delete:${BOOTSTRAP_STACK}`,
    ]);
    expect(w.calls[w.calls.length - 1]).toBe(`stack:delete:${BOOTSTRAP_STACK}`);

    // Re-running the completed purge is a clean no-op (idempotent retry).
    w.setBootstrap(null);
    w.calls.length = 0;
    expect(await settlePurge(w.deps)).toEqual({ state: 'succeeded' });
    expect(w.calls).toEqual([]);
  });
});

// ── Executor + resumer ───────────────────────────────────────────────────

describe('createPurgeExecutor', () => {
  function cfnReturning(app: StackLookup | { found: false }, bootstrap: StackLookup | { found: false }): CloudFormationReader {
    return {
      async describeStack(stackName) {
        return stackName === APP_STACK ? app : bootstrap;
      },
      async describeStackResources() {
        return [];
      },
    };
  }

  it('reports success with purged output when everything is already gone', async () => {
    const calls: string[] = [];
    const deps = depsWith(cfnReturning({ found: false }, { found: false }), calls);
    const result = await createPurgeExecutor(deps)(command());

    expect(result).toEqual({
      commandId: 'cmd-1',
      idempotencyKey: 'key-1',
      success: true,
      output: { executed: true, type: 'PURGE', purged: true },
    });
    expect(calls).toEqual([]);
  });

  it('defers while deletions are in flight and records the pending debt', async () => {
    const calls: string[] = [];
    const deps = depsWith(cfnReturning(appStack('CREATE_COMPLETE'), { found: false }), calls);
    const result = await createPurgeExecutor(deps)(command());

    expect(result).toEqual({
      commandId: 'cmd-1',
      idempotencyKey: 'key-1',
      success: false,
      deferred: true,
    });
    const pending = await deps.pending.read();
    expect(pending?.type).toBe('PURGE');
    expect(pending?.commandId).toBe('cmd-1');
  });

  it('fails when the pending debt cannot be recorded', async () => {
    const calls: string[] = [];
    const deps = depsWith(cfnReturning(appStack('CREATE_COMPLETE'), { found: false }), calls, {
      pending: {
        async read() {
          return null;
        },
        async write() {
          return false;
        },
        async clear() {
          return true;
        },
      },
    });
    const result = await createPurgeExecutor(deps)(command());

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('could not record');
    }
  });

  it('maps a tag refusal to a STACK_DELETE_FAILED failure', async () => {
    const calls: string[] = [];
    const deps = depsWith(
      cfnReturning(appStack('CREATE_COMPLETE', 'someone-else'), { found: false }),
      calls,
    );
    const result = await createPurgeExecutor(deps)(command());

    expect(result).toMatchObject({
      success: false,
      failureCode: 'STACK_DELETE_FAILED',
    });
    expect(calls).toEqual([]);
  });

  it('classifies a permission failure on an orphan tag read as retryable AWS_PERMISSION_DENIED, never as purge success', async () => {
    // Phase 5 §9.1: an AccessDenied while READING ownership must fail the
    // purge retryably. Swallowing it (the old behavior) reported
    // `purged: true` while every retained resource still existed — the
    // control plane then cleared the retained-resources warning.
    const accessDenied = Object.assign(new Error('Access denied'), {
      name: 'AccessDenied',
      code: 'AccessDenied',
    });
    const calls: string[] = [];
    const deps = depsWith(
      {
        async describeStack() {
          return { found: false };
        },
        async describeStackResources() {
          return [];
        },
      },
      calls,
      {
        rds: {
          async listOwnedInstances() {
            throw accessDenied;
          },
          async disableDeletionProtection() {},
          async deleteInstance() {},
        },
      },
    );
    // isAccessDenied itself distinguishes the two error classes.
    expect(isAccessDenied(accessDenied)).toBe(true);
    expect(isAccessDenied(Object.assign(new Error('gone'), { name: 'NoSuchTagSet' }))).toBe(false);

    const result = await createPurgeExecutor(deps)(command());
    expect(result).toMatchObject({
      success: false,
      failureCode: 'AWS_PERMISSION_DENIED',
    });
    expect(calls).toEqual([]);
  });
});

describe('createPurgeResumer', () => {
  function pendingRecord(type: string) {
    return {
      commandId: 'cmd-1',
      idempotencyKey: 'key-1',
      type,
      stackName: APP_STACK,
      startedAt: '2026-08-31T00:00:00.000Z',
      payload: {},
    };
  }

  it('ignores pending debts that are not PURGE', async () => {
    const calls: string[] = [];
    const deps = depsWith(
      {
        async describeStack() {
          return { found: false };
        },
        async describeStackResources() {
          return [];
        },
      },
      calls,
    );
    await deps.pending.write(pendingRecord('DESTROY'));

    const results = await createPurgeResumer(deps)();
    expect(results).toEqual([]);
  });

  it('keeps the debt while the purge is still in flight', async () => {
    const calls: string[] = [];
    const deps = depsWith(
      {
        async describeStack(stackName) {
          return stackName === APP_STACK ? appStack('DELETE_IN_PROGRESS') : { found: false };
        },
        async describeStackResources() {
          return [];
        },
      },
      calls,
    );
    await deps.pending.write(pendingRecord('PURGE'));

    const results = await createPurgeResumer(deps)();
    expect(results).toEqual([]);
    expect(await deps.pending.read()).not.toBeNull();
  });

  it('settles a finished purge, clears the debt, and reports the result', async () => {
    const calls: string[] = [];
    const deps = depsWith(
      {
        async describeStack() {
          return { found: false };
        },
        async describeStackResources() {
          return [];
        },
      },
      calls,
    );
    await deps.pending.write(pendingRecord('PURGE'));

    const results = await createPurgeResumer(deps)();
    expect(results).toEqual([
      {
        commandId: 'cmd-1',
        idempotencyKey: 'key-1',
        success: true,
        output: { executed: true, type: 'PURGE', purged: true },
      },
    ]);
    expect(await deps.pending.read()).toBeNull();
  });
});
