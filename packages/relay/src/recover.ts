/**
 * First-install stack recovery — the cleanup half of a retried INSTALL.
 *
 * `installApplicationStack` (./install.ts) is the honest reporter: it tells
 * the truth about the stack's real CloudFormation status and never recreates
 * a terminal-failed stack. That honesty is exactly what strands a failed
 * FIRST install: CloudFormation cannot update a `ROLLBACK_COMPLETE` stack,
 * so every future INSTALL fails while it exists — and manual deletion fails
 * too, because the application stack's RDS instance is `RETAIN` +
 * `deletionProtection: true` (keeping its security group and the VPC alive)
 * and the S3 bucket is `RETAIN`.
 *
 * This module deletes a terminal-failed stack and the retained resources
 * that block its deletion, so the next `installApplicationStack` can create
 * the stack again. It runs ONLY when the command payload carries
 * `recovery.neverInstalled: true` — set by the control plane's
 * retry-install route, which first proves no INSTALL ever succeeded. Defense
 * in depth: a stack found healthy or in progress is refused untouched,
 * whatever the payload claims.
 *
 * Orphans are identified ONLY from the failed stack's own resource list —
 * never by name guessing — and only types whose deletion the relay's
 * tag-scoped IAM already grants (rds:ModifyDBInstance/DeleteDBInstance,
 * elasticache:DeleteCacheCluster). A retained S3 bucket is deliberately
 * left alone: it blocks nothing (it is not a VPC resource), costs nothing
 * when empty, and deleting objects would need object-level S3 permissions
 * the relay does not carry.
 *
 * Bounded by the relay Lambda's timeout: an exhausted wait budget reports
 * honestly ("still in progress") so the next retry pass continues from real
 * state. Each pass makes forward progress; none is ever destructive twice.
 */

import {
  CloudFormationClient,
  DeleteStackCommand,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import { DeleteCacheClusterCommand, ElastiCacheClient } from '@aws-sdk/client-elasticache';
import {
  DeleteDBInstanceCommand,
  ModifyDBInstanceCommand,
  RDSClient,
} from '@aws-sdk/client-rds';

import type { StackLookup, StackResource } from './verify.js';

// ── Stack status vocabulary ─────────────────────────────────────────────────

/** Statuses that mean "this stack finished, and it worked". */
const HEALTHY_STATUSES: ReadonlySet<string> = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE']);

/**
 * Terminal statuses from which this stack can never become healthy. A stack
 * here must be deleted before the application can be installed again.
 */
export const TERMINAL_FAILED_STACK_STATUSES: ReadonlySet<string> = new Set([
  'CREATE_FAILED',
  'ROLLBACK_FAILED',
  'ROLLBACK_COMPLETE',
  'DELETE_FAILED',
  'UPDATE_ROLLBACK_FAILED',
  'UPDATE_ROLLBACK_COMPLETE',
  'IMPORT_ROLLBACK_COMPLETE',
]);

/** Any *_IN_PROGRESS or REVIEW_IN_PROGRESS status. */
function isInProgress(status: string): boolean {
  return status.endsWith('_IN_PROGRESS') || status === 'REVIEW_IN_PROGRESS';
}

// ── Injectable seams ────────────────────────────────────────────────────────

/** A stack resource with the physical ID cleanup needs. */
export interface PhysicalStackResource extends StackResource {
  readonly physicalId: string;
}

/**
 * The CloudFormation operations recovery needs. Same lookup contract as
 * verify.ts's `CloudFormationReader`; `deleteStack` and
 * `describeStackResources` add the write side.
 */
export interface RecoveryCloudFormation {
  describeStack(stackName: string): Promise<StackLookup>;
  describeStackResources(stackName: string): Promise<PhysicalStackResource[]>;
  deleteStack(stackName: string): Promise<void>;
}

/** RDS cleanup for an orphaned, never-successfully-installed database. */
export interface RdsCleanupClient {
  disableDeletionProtection(dbInstanceIdentifier: string): Promise<void>;
  deleteInstance(dbInstanceIdentifier: string): Promise<void>;
}

/** ElastiCache cleanup for an orphaned, never-successfully-installed cache. */
export interface CacheCleanupClient {
  deleteCluster(cacheClusterId: string): Promise<void>;
}

/** Wait configuration; the budget must fit the relay Lambda's own timeout. */
export interface WaitOptions {
  pollIntervalMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 24;

// ── Recovery ────────────────────────────────────────────────────────────────

/** Resource types whose retained instances block stack deletion or leak cost. */
const ORPHAN_RESOURCE_TYPES: Readonly<Record<string, 'rds' | 'cache'>> = {
  'AWS::RDS::DBInstance': 'rds',
  'AWS::ElastiCache::CacheCluster': 'cache',
};

export type RecoveryPhase =
  /** No stack — nothing to clean. */
  | 'ALREADY_ABSENT'
  /** Complete/healthy stack — refused, nothing deleted. */
  | 'REFUSED_LIVE_STACK'
  /** A mutation is already running — refused, nothing deleted. */
  | 'REFUSED_IN_PROGRESS'
  /** DeleteStack reached DELETE_COMPLETE; no orphans remained. */
  | 'STACK_DELETED'
  /** Delete budget exhausted mid-delete; safe to re-run. */
  | 'DELETE_IN_PROGRESS'
  /** Orphaned blockers deleted; re-delete still failing. */
  | 'DELETE_STUCK'
  /** Orphaned blockers deleted and the stack delete finished. */
  | 'BLOCKERS_CLEARED_STACK_GONE';

export interface RecoveryReport {
  readonly phase: RecoveryPhase;
  readonly lastStackStatus: string;
  readonly orphansDeleted: readonly string[];
}

export interface RecoveryInput {
  readonly stackName: string;
}

export interface RecoveryDeps {
  readonly cfn: RecoveryCloudFormation;
  readonly rds?: RdsCleanupClient;
  readonly cache?: CacheCleanupClient;
  readonly wait?: WaitOptions;
}

/**
 * Outcome of clearing a DELETE_FAILED stack's known orphan blockers and
 * retrying the delete. A strict subset of `RecoveryPhase`: this helper never
 * sees a healthy or in-progress stack, only one already stuck deleting.
 */
export interface ClearDeleteBlockersReport {
  readonly phase: 'STACK_DELETED' | 'DELETE_IN_PROGRESS' | 'DELETE_STUCK';
  readonly lastStackStatus: string;
  readonly orphansDeleted: readonly string[];
  /** Populated only when `phase` is `DELETE_STUCK` — what is still blocking. */
  readonly blockedResources: readonly string[];
}

/**
 * Clears the retained orphans (RDS, ElastiCache) that block a DELETE_FAILED
 * stack's deletion, then retries `DeleteStack`. Shared by first-install
 * recovery (below, after its own initial delete attempt fails) and by
 * `destroy.ts` (which reaches a DELETE_FAILED stack directly, without a
 * delete attempt of its own to run first).
 *
 * Orphans are identified ONLY from the stack's own resource list — never by
 * name guessing — and only types whose deletion the relay's tag-scoped IAM
 * already grants (rds:ModifyDBInstance/DeleteDBInstance,
 * elasticache:DeleteCacheCluster). If nothing here can be cleared, the
 * delete is not retried — retrying a delete that will fail the same way
 * again would just waste the caller's wait budget.
 */
export async function clearDeleteBlockersAndRetryDelete(
  deps: RecoveryDeps,
  stackName: string,
): Promise<ClearDeleteBlockersReport> {
  const { cfn, rds, cache } = deps;
  const wait = resolveWait(deps.wait);

  // The stack's own resources are still readable in DELETE_FAILED — the
  // orphans to clean are exactly the retained members of this list.
  const resources = await cfn.describeStackResources(stackName);
  const orphans = resources.filter(
    (r) => ORPHAN_RESOURCE_TYPES[r.type] !== undefined && r.physicalId.length > 0,
  );

  // The retained orphans are what block the default-Delete resources (the
  // DB instance keeps its security group's ENIs alive; the cache keeps its
  // subnet group). Clear them, then ask CloudFormation to finish the delete.
  const deleted: string[] = [];
  for (const orphan of orphans) {
    const kind = ORPHAN_RESOURCE_TYPES[orphan.type]!;
    const physicalId = orphan.physicalId;
    if (kind === 'rds') {
      if (!rds) continue;
      // deletionProtection=true refuses DeleteDBInstance — lower it first.
      await rds.disableDeletionProtection(physicalId);
      await rds.deleteInstance(physicalId);
    } else {
      if (!cache) continue;
      await cache.deleteCluster(physicalId);
    }
    deleted.push(physicalId);
  }

  const blockedResources = (): string[] =>
    resources
      .filter((r) => !deleted.includes(r.physicalId) && r.status === 'DELETE_FAILED')
      .map((r) => `${r.type} (${r.logicalId})`);

  if (deleted.length === 0) {
    return {
      phase: 'DELETE_STUCK',
      lastStackStatus: 'DELETE_FAILED',
      orphansDeleted: deleted,
      blockedResources: blockedResources(),
    };
  }

  await cfn.deleteStack(stackName);
  const last = await waitForSettled(cfn, wait, stackName);

  if (last === 'DELETE_COMPLETE') {
    return { phase: 'STACK_DELETED', lastStackStatus: last, orphansDeleted: deleted, blockedResources: [] };
  }
  if (isInProgress(last)) {
    return { phase: 'DELETE_IN_PROGRESS', lastStackStatus: last, orphansDeleted: deleted, blockedResources: [] };
  }
  return {
    phase: 'DELETE_STUCK',
    lastStackStatus: last,
    orphansDeleted: deleted,
    blockedResources: blockedResources(),
  };
}

export async function recoverFailedInstallStack(
  deps: RecoveryDeps,
  input: RecoveryInput,
): Promise<RecoveryReport> {
  const { cfn } = deps;
  const wait = resolveWait(deps.wait);

  const initial = await cfn.describeStack(input.stackName);
  if (!initial.found) {
    return { phase: 'ALREADY_ABSENT', lastStackStatus: 'MISSING', orphansDeleted: [] };
  }

  const status = initial.stack.status;
  if (HEALTHY_STATUSES.has(status)) {
    return { phase: 'REFUSED_LIVE_STACK', lastStackStatus: status, orphansDeleted: [] };
  }
  if (isInProgress(status)) {
    return { phase: 'REFUSED_IN_PROGRESS', lastStackStatus: status, orphansDeleted: [] };
  }
  if (!TERMINAL_FAILED_STACK_STATUSES.has(status)) {
    // DELETE_COMPLETE or an unrecognized terminal state — nothing to recover.
    return { phase: 'ALREADY_ABSENT', lastStackStatus: status, orphansDeleted: [] };
  }

  await cfn.deleteStack(input.stackName);
  const last = await waitForSettled(cfn, wait, input.stackName);

  if (last === 'DELETE_COMPLETE') {
    return { phase: 'STACK_DELETED', lastStackStatus: last, orphansDeleted: [] };
  }
  if (isInProgress(last)) {
    return { phase: 'DELETE_IN_PROGRESS', lastStackStatus: last, orphansDeleted: [] };
  }

  // DELETE_FAILED: clear known orphan blockers and retry.
  const cleared = await clearDeleteBlockersAndRetryDelete(deps, input.stackName);
  return {
    phase: cleared.phase === 'STACK_DELETED' ? 'BLOCKERS_CLEARED_STACK_GONE' : cleared.phase,
    lastStackStatus: cleared.lastStackStatus,
    orphansDeleted: cleared.orphansDeleted,
  };
}

/**
 * Poll until the stack settles (not *_IN_PROGRESS) or the budget runs out.
 * A stack that has vanished — DescribeStacks "does not exist" after a
 * delete — reports DELETE_COMPLETE. Budget exhaustion returns the last
 * observed status, the honest "not finished yet" answer.
 */
async function waitForSettled(
  cfn: RecoveryCloudFormation,
  wait: Required<WaitOptions>,
  stackName: string,
): Promise<string> {
  let last = 'UNKNOWN';
  for (let attempt = 0; attempt < wait.maxAttempts; attempt++) {
    const lookup = await cfn.describeStack(stackName);
    if (!lookup.found) {
      return 'DELETE_COMPLETE';
    }
    last = lookup.stack.status;
    if (!isInProgress(last)) {
      return last;
    }
    if (attempt < wait.maxAttempts - 1) {
      await wait.sleep(wait.pollIntervalMs);
    }
  }
  return last;
}

function resolveWait(wait?: WaitOptions): Required<WaitOptions> {
  return {
    pollIntervalMs: wait?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    maxAttempts: wait?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    sleep: wait?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
  };
}

// ── Real AWS implementations ────────────────────────────────────────────────

/**
 * Real CloudFormation actor. Same lookup contract as verify.ts's
 * `createCloudFormationReader`: DescribeStacks maps "stack does not exist"
 * (and, fail-closed, any lookup error) to `{ found: false }` carrying the
 * AWS error code.
 */
export function createRecoveryCloudFormation(): RecoveryCloudFormation {
  const client = new CloudFormationClient({});

  return {
    async describeStack(stackName: string): Promise<StackLookup> {
      try {
        const response = await client.send(
          new DescribeStacksCommand({ StackName: stackName }),
        );
        const stack = response.Stacks?.[0];
        if (!stack) {
          return { found: false };
        }
        const tags: Record<string, string> = {};
        for (const tag of stack.Tags ?? []) {
          if (tag.Key !== undefined && tag.Value !== undefined) {
            tags[tag.Key] = tag.Value;
          }
        }
        return {
          found: true,
          stack: { stackName, status: stack.StackStatus ?? 'UNKNOWN', tags },
        };
      } catch (err) {
        const name = (err as { name?: unknown }).name;
        return { found: false, errorCode: typeof name === 'string' ? name : String(err) };
      }
    },

    async describeStackResources(stackName: string): Promise<PhysicalStackResource[]> {
      const response = await client.send(
        new DescribeStackResourcesCommand({ StackName: stackName }),
      );
      return (response.StackResources ?? []).map((r) => ({
        logicalId: r.LogicalResourceId ?? '',
        type: r.ResourceType ?? '',
        status: r.ResourceStatus ?? '',
        physicalId: r.PhysicalResourceId ?? '',
      }));
    },

    async deleteStack(stackName: string): Promise<void> {
      await client.send(new DeleteStackCommand({ StackName: stackName }));
    },
  };
}

/** Real RDS cleanup client. Untested by design (thin SDK wrapper). */
export function createRealRdsCleanupClient(): RdsCleanupClient {
  const client = new RDSClient({});
  return {
    async disableDeletionProtection(dbInstanceIdentifier: string): Promise<void> {
      await client.send(
        new ModifyDBInstanceCommand({
          DBInstanceIdentifier: dbInstanceIdentifier,
          DeletionProtection: false,
        }),
      );
    },
    async deleteInstance(dbInstanceIdentifier: string): Promise<void> {
      await client.send(
        new DeleteDBInstanceCommand({
          DBInstanceIdentifier: dbInstanceIdentifier,
          // A never-successfully-installed database holds no customer data
          // worth a final snapshot; keeping one just leaves clutter behind.
          SkipFinalSnapshot: true,
        }),
      );
    },
  };
}

/** Real ElastiCache cleanup client. Untested by design (thin SDK wrapper). */
export function createRealCacheCleanupClient(): CacheCleanupClient {
  const client = new ElastiCacheClient({});
  return {
    async deleteCluster(cacheClusterId: string): Promise<void> {
      await client.send(
        new DeleteCacheClusterCommand({ CacheClusterId: cacheClusterId }),
      );
    },
  };
}
