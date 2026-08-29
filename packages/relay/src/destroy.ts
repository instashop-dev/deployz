/**
 * DESTROY executor — safely remove the application stack.
 *
 * The product boundary (Phase 6): disconnect removes the running application
 * and its networking while RETAINING the database, stored files, and
 * backups. The bootstrap relay stack is never touched. Because the
 * application template's CloudFormation retention policies govern what is
 * actually deleted versus retained, the executor's job is to delete the
 * stack and let CloudFormation enforce those policies — it enumerates and
 * deletes resources itself only for the narrow DELETE_FAILED recovery below,
 * and only the orphaned RDS/ElastiCache resources CloudFormation itself
 * named as retained.
 *
 * Safety: the stack must carry this installation's `deployz:installation`
 * tag. An untagged or mismatched stack is refused — the alternative is
 * deleting some other installation's (or some non-Deployz) stack by name.
 */

import type { CommandExecutor, RelayCommand, RelayCommandResult } from './commands.js';
import type { PendingStore } from './pending.js';
import {
  clearDeleteBlockersAndRetryDelete,
  type CacheCleanupClient,
  type RdsCleanupClient,
  type WaitOptions,
} from './recover.js';
import type { CloudFormationReader } from './verify.js';

/** The CloudFormation delete surface this module needs. */
export interface StackDeleter {
  deleteStack(stackName: string): Promise<void>;
}

export interface DestroyDeps {
  readonly cfn: CloudFormationReader;
  readonly deleter: StackDeleter;
  readonly pending: PendingStore;
  readonly installationId: string;
  readonly stackName: string;
  readonly now?: () => string;
  /**
   * DELETE_FAILED recovery: clears retained RDS/ElastiCache orphans that
   * block the delete and retries it (see `clearDeleteBlockersAndRetryDelete`
   * in ./recover.js). Same clients the INSTALL retry path already uses;
   * omitted, a DELETE_FAILED stack just fails as before.
   */
  readonly rds?: RdsCleanupClient;
  readonly cache?: CacheCleanupClient;
  readonly wait?: WaitOptions;
}

type DestroyOutcome =
  | { readonly state: 'succeeded'; readonly alreadyAbsent: boolean }
  | { readonly state: 'failed'; readonly reason: string }
  | { readonly state: 'deleting' };

/**
 * Runs the destroy to whatever conclusion is available right now. Reads
 * before writes: a stack already absent is success (idempotent retry), a
 * stack mid-deletion is deferred, a DELETE_FAILED stack is a failure.
 */
export async function settleDestroy(deps: DestroyDeps): Promise<DestroyOutcome> {
  const lookup = await deps.cfn.describeStack(deps.stackName);

  if (!lookup.found) {
    return { state: 'succeeded', alreadyAbsent: true };
  }

  const status = lookup.stack.status;

  // A same-named stack that does not carry THIS installation's tag is not
  // ours to delete. Deleting it would cross the installation boundary.
  if (lookup.stack.tags['deployz:installation'] !== deps.installationId) {
    return {
      state: 'failed',
      reason: `Stack "${deps.stackName}" does not carry this installation's tag — refusing to delete`,
    };
  }

  if (status === 'DELETE_FAILED') {
    // Don't dead-end here: enumerate the stack's own resources, clear the
    // orphaned RDS/ElastiCache blockers CloudFormation left retained, and
    // retry the delete — the same recovery the INSTALL retry path already
    // runs for a stuck first install (see ./recover.js).
    const cleared = await clearDeleteBlockersAndRetryDelete(
      {
        cfn: {
          describeStack: (name) => deps.cfn.describeStack(name),
          describeStackResources: async (name) =>
            (await deps.cfn.describeStackResources(name)).flatMap((r) =>
              r.physicalId ? [{ ...r, physicalId: r.physicalId }] : [],
            ),
          deleteStack: (name) => deps.deleter.deleteStack(name),
        },
        ...(deps.rds !== undefined ? { rds: deps.rds } : {}),
        ...(deps.cache !== undefined ? { cache: deps.cache } : {}),
        ...(deps.wait !== undefined ? { wait: deps.wait } : {}),
      },
      deps.stackName,
    );

    if (cleared.phase === 'STACK_DELETED') {
      return { state: 'succeeded', alreadyAbsent: false };
    }
    if (cleared.phase === 'DELETE_IN_PROGRESS') {
      return { state: 'deleting' };
    }

    const blocked =
      cleared.blockedResources.length > 0
        ? ` Still blocked by: ${cleared.blockedResources.join(', ')}.`
        : '';
    return {
      state: 'failed',
      reason:
        `Stack "${deps.stackName}" deletion previously failed (DELETE_FAILED); ` +
        `clearing known orphans (${cleared.orphansDeleted.length} cleared) did not ` +
        `unblock it.${blocked}`,
    };
  }

  if (status === 'DELETE_IN_PROGRESS') {
    return { state: 'deleting' };
  }

  // The stack is tagged and in a non-deleting state — start the deletion.
  // CloudFormation's per-resource retention policies are the single source
  // of truth for what is deleted versus retained.
  await deps.deleter.deleteStack(deps.stackName);
  return { state: 'deleting' };
}

function result(
  command: RelayCommand,
  success: boolean,
  extra: { output?: Record<string, unknown>; error?: string; failureCode?: string } = {},
): RelayCommandResult {
  return {
    commandId: command.id,
    idempotencyKey: command.idempotencyKey,
    success,
    ...extra,
  };
}

export function createDestroyExecutor(deps: DestroyDeps): CommandExecutor {
  return async (command) => {
    console.log(
      JSON.stringify({
        event: 'relay:command-executed',
        commandId: command.id,
        type: command.type,
        deploymentId: command.deploymentId,
        idempotencyKey: command.idempotencyKey,
      }),
    );

    let outcome: DestroyOutcome;
    try {
      outcome = await settleDestroy(deps);
    } catch (err) {
      return result(command, false, {
        error: String(err),
        failureCode: 'AWS_PERMISSION_DENIED',
      });
    }

    if (outcome.state === 'failed') {
      console.log(
        JSON.stringify({
          event: 'relay:command-failed',
          commandId: command.id,
          type: command.type,
          reason: outcome.reason,
        }),
      );
      return result(command, false, {
        error: outcome.reason,
        // DELETE_FAILED on the stack itself is the common terminal state;
        // a tag refusal or permission error surfaces through the same
        // mechanism and is distinguished by its message.
        failureCode: 'STACK_DELETE_FAILED',
      });
    }

    if (outcome.state === 'succeeded') {
      console.log(
        JSON.stringify({
          event: 'relay:command-succeeded',
          commandId: command.id,
          type: command.type,
          alreadyAbsent: outcome.alreadyAbsent,
        }),
      );
      return result(command, true, {
        output: { executed: true, type: command.type, alreadyAbsent: outcome.alreadyAbsent },
      });
    }

    // Deletion is in progress and will outlive this invocation — record the
    // debt so the resumer picks it up on a later poll.
    const recorded = await deps.pending.write({
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      type: command.type,
      stackName: deps.stackName,
      startedAt: (deps.now ?? (() => new Date().toISOString()))(),
      payload: command.payload,
    });
    if (!recorded) {
      return result(command, false, {
        error: 'Deletion in progress, but the relay could not record that it must report back',
      });
    }

    console.log(
      JSON.stringify({
        event: 'relay:command-deferred',
        commandId: command.id,
        type: command.type,
        stackName: deps.stackName,
      }),
    );
    return {
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      success: false,
      deferred: true,
    };
  };
}

/** The other half: finish a destroy an earlier invocation started. */
export function createDestroyResumer(deps: DestroyDeps): () => Promise<RelayCommandResult[]> {
  return async () => {
    const pending = await deps.pending.read();
    if (pending === null || pending.type !== 'DESTROY') return [];

    const outcome = await settleDestroy(deps);
    if (outcome.state === 'deleting') {
      console.log(
        JSON.stringify({
          event: 'relay:command-still-pending',
          commandId: pending.commandId,
          type: pending.type,
          startedAt: pending.startedAt,
        }),
      );
      return [];
    }

    await deps.pending.clear();
    console.log(
      JSON.stringify({
        event: 'relay:command-resumed',
        commandId: pending.commandId,
        type: pending.type,
        success: outcome.state === 'succeeded',
        startedAt: pending.startedAt,
      }),
    );
    return [
      outcome.state === 'succeeded'
        ? {
            commandId: pending.commandId,
            idempotencyKey: pending.idempotencyKey,
            success: true,
            output: {
              executed: true,
              type: pending.type,
              alreadyAbsent: outcome.alreadyAbsent,
            },
          }
        : {
            commandId: pending.commandId,
            idempotencyKey: pending.idempotencyKey,
            success: false,
            error: outcome.reason,
            failureCode: 'STACK_DELETE_FAILED',
          },
    ];
  };
}
