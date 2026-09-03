/**
 * PURGE executor — permanently remove retained AWS resources.
 *
 * The destructive counterpart to Disconnect (Phase 6 boundary): Disconnect
 * removes the running application while RETAINING the database, stored
 * files, and backups; PURGE removes those retained leftovers too — the
 * database instance, the database's retained credential secrets (Phase 9),
 * stored files, the cache, plus the bootstrap/relay stack itself. It only
 * ever runs for a deployment whose vendor typed its name to confirm, and
 * only after the control plane accepted the request (deployment already
 * DELETED with SKIPPED_RELAY_OFFLINE leftovers).
 *
 * Safety: every resource is touched only after it verifies as THIS
 * installation's — the APPLICATION stack by its `deployz:installation`
 * stack tag, orphaned RDS/ElastiCache/S3 resources by their resource tags
 * (the ownership check lives inside the clients: `listOwned*` returns only
 * verified resources). The bootstrap/relay stack is deleted by its KNOWN
 * NAME (baked into this relay's environment by the stack itself) — it is
 * created before the installation id exists and so can never carry a
 * readable installation tag; a name-based ownership proof is the only
 * feasible one. An untagged or mismatched resource is refused, never
 * deleted.
 *
 * Idempotent by construction: a pass only deletes what a fresh read shows
 * still present, and a resource already deleting is waited on, not
 * re-deleted. Retries and resumptions converge to the same end state.
 */

import {
  ACMClient,
  DeleteCertificateCommand,
  ListCertificatesCommand,
  ListTagsForCertificateCommand,
} from '@aws-sdk/client-acm';
import {
  DeleteInternetGatewayCommand,
  DeleteNatGatewayCommand,
  DeleteRouteTableCommand,
  DeleteSecurityGroupCommand,
  DeleteSubnetCommand,
  DeleteVpcCommand,
  DescribeInternetGatewaysCommand,
  DescribeNatGatewaysCommand,
  DescribeRouteTablesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  DetachInternetGatewayCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';
import {
  DescribeReplicationGroupsCommand,
  ElastiCacheClient,
  ListTagsForResourceCommand,
} from '@aws-sdk/client-elasticache';
import {
  DeleteDBSubnetGroupCommand,
  DescribeDBInstancesCommand,
  DescribeDBSubnetGroupsCommand,
  ListTagsForResourceCommand as ListRdsTagsCommand,
  RDSClient,
} from '@aws-sdk/client-rds';
import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  GetBucketTaggingCommand,
  ListBucketsCommand,
  ListObjectVersionsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  DeleteSecretCommand,
  DescribeSecretCommand,
  ListSecretsCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

import type { CommandExecutor, RelayCommand, RelayCommandResult } from './commands.js';
import type { PendingStore } from './pending.js';
import {
  clearDeleteBlockersAndRetryDelete,
  createRealCacheCleanupClient,
  createRealRdsCleanupClient,
  type CacheCleanupClient,
  type RdsCleanupClient,
  type WaitOptions,
} from './recover.js';
import type { CloudFormationReader } from './verify.js';
import type { StackDeleter } from './destroy.js';

/** RDS resources this installation owns, plus the deletion surface. */
export interface RdsPurgeClient extends RdsCleanupClient {
  /** Owned (tag-verified) instances only; anything else is omitted, not attempted. */
  listOwnedInstances(): Promise<{ identifier: string; status: string }[]>;
  /**
   * Owned (tag-verified) DB subnet groups — RETAIN-ed alongside the database
   * (CANARY-015). Deletable only once no DB instance still references them;
   * the instance sweep above already guarantees that by running first.
   */
  listOwnedSubnetGroups(): Promise<string[]>;
  /** Deletes a subnet group by name. An in-use rejection is the caller's to retry. */
  deleteSubnetGroup(name: string): Promise<void>;
}

/**
 * The orphaned VPC network (CANARY-015) a data-preserving Disconnect can
 * leave behind: the retained RDS instance's ENI keeps a private subnet and
 * the DB security group alive through the application stack's DeleteStack,
 * which then strands the VPC itself. Every list is tag-verified — same rule
 * as every other purge client: a resource whose tag is unreadable or
 * mismatched is omitted, never deleted.
 */
export interface NetworkPurgeClient {
  /** Owned (tag-verified) VPC ids only. */
  listOwnedVpcs(): Promise<string[]>;
  /** Owned (tag-verified), non-default security groups in a VPC. */
  listOwnedSecurityGroups(vpcId: string): Promise<string[]>;
  deleteSecurityGroup(groupId: string): Promise<void>;
  /** Owned (tag-verified) subnets in a VPC. */
  listOwnedSubnets(vpcId: string): Promise<string[]>;
  deleteSubnet(subnetId: string): Promise<void>;
  /** Owned (tag-verified) custom route tables in a VPC. Normally already gone. */
  listOwnedRouteTables(vpcId: string): Promise<string[]>;
  deleteRouteTable(routeTableId: string): Promise<void>;
  /** Owned (tag-verified) internet gateways attached to a VPC. Normally already gone. */
  listOwnedInternetGateways(vpcId: string): Promise<string[]>;
  detachInternetGateway(gatewayId: string, vpcId: string): Promise<void>;
  deleteInternetGateway(gatewayId: string): Promise<void>;
  /** Owned (tag-verified) NAT gateways in a VPC. Normally already gone. */
  listOwnedNatGateways(vpcId: string): Promise<string[]>;
  deleteNatGateway(natGatewayId: string): Promise<void>;
  deleteVpc(vpcId: string): Promise<void>;
}

/** ElastiCache resources this installation owns, plus the deletion surface. */
export interface CachePurgeClient extends CacheCleanupClient {
  /** Owned (tag-verified) replication groups only. */
  listOwnedReplicationGroups(): Promise<{ identifier: string; status: string }[]>;
}

/**
 * S3 resources this installation owns. Buckets cannot be tag-scoped at IAM,
 * so ownership is verified in code (GetBucketTagging) and only verified
 * buckets are ever returned or touched.
 */
export interface S3PurgeClient {
  /** Owned (tag-verified) bucket names only. */
  listOwnedBuckets(): Promise<string[]>;
  /** Removes every object version and delete marker; a no-op on an empty bucket. */
  emptyBucket(bucketName: string): Promise<void>;
  deleteBucket(bucketName: string): Promise<void>;
}

/**
 * Secrets Manager resources this installation's APPLICATION stack owns —
 * the retained DB credentials (DatabaseSecret + DatabaseUrlSecret, Phase 9).
 *
 * Ownership is verified in code: a secret qualifies only when it carries
 * BOTH the `deployz:installation` tag AND `deployz:component=application` —
 * the bootstrap stack's own credential secret carries the installation tag
 * too but is `deployz:component=bootstrap`, so the component check keeps the
 * sweep from eating the relay's home before the bootstrap stack is deleted.
 */
export interface SecretsPurgeClient {
  /** Owned (tag-verified) application secrets only, by name. */
  listOwnedSecrets(): Promise<string[]>;
  /** Deletes a secret permanently (no recovery window). */
  deleteSecret(secretName: string): Promise<void>;
}

/**
 * ACM certificates this installation owns — the Phase 11 default-HTTPS (and
 * custom-domain) certificates live OUTSIDE the application stack, so a
 * normal destroy removes them via a REMOVE_DOMAIN job and a force-completed
 * destroy (relay offline) would otherwise leave them orphaned in the
 * customer account forever. Ownership is verified in code (ListTags) exactly
 * like the RDS/secrets sweeps.
 */
export interface AcmPurgeClient {
  /** Owned (tag-verified) certificate ARNs only. */
  listOwnedCertificates(): Promise<string[]>;
  deleteCertificate(certificateArn: string): Promise<void>;
}

export interface PurgeDeps {
  readonly cfn: CloudFormationReader;
  readonly deleter: StackDeleter;
  readonly pending: PendingStore;
  readonly installationId: string;
  readonly stackName: string;
  readonly bootstrapStackName: string;
  readonly rds: RdsPurgeClient;
  readonly cache: CachePurgeClient;
  readonly s3: S3PurgeClient;
  readonly secrets: SecretsPurgeClient;
  readonly acm: AcmPurgeClient;
  readonly network: NetworkPurgeClient;
  readonly now?: () => string;
  readonly wait?: WaitOptions;
}

type PurgeOutcome =
  | { readonly state: 'succeeded' }
  | { readonly state: 'failed'; readonly reason: string }
  | { readonly state: 'purging' };

const INSTALLATION_TAG = 'deployz:installation';

/**
 * Whether an AWS error is a permission rejection (AccessDenied /
 * UnauthorizedOperation / 403). Distinct from "resource does not exist":
 * only an ACCESS-DENIED error may be rethrown to fail the purge retryably —
 * a missing resource genuinely means "nothing to purge here".
 */
export function isAccessDenied(error: unknown): boolean {
  const name = typeof (error as { name?: unknown } | undefined)?.name === 'string'
    ? (error as { name: string }).name
    : '';
  const code = typeof (error as { Code?: unknown } | undefined)?.Code === 'string'
    ? (error as { Code: string }).Code
    : '';
  const statusCode = (error as { $metadata?: { httpStatusCode?: unknown } } | undefined)
    ?.$metadata?.httpStatusCode;
  return (
    statusCode === 403 ||
    name.includes('AccessDenied') ||
    code.includes('AccessDenied') ||
    code.includes('UnauthorizedOperation')
  );
}

/**
 * Whether an AWS error means a network resource is still referenced by
 * something else — the ENI a just-deleted RDS instance leaves behind for a
 * few seconds, a security group still referenced by another's rule, or a
 * gateway mid-detach. Retryable: the purge stays `purging` so the next poll
 * finds it cleared, never a purge failure.
 */
function isDependencyViolation(error: unknown): boolean {
  const code = typeof (error as { Code?: unknown } | undefined)?.Code === 'string'
    ? (error as { Code: string }).Code
    : typeof (error as { name?: unknown } | undefined)?.name === 'string'
      ? (error as { name: string }).name
      : '';
  return code.includes('DependencyViolation');
}

/** Whether an RDS error means the subnet group is still referenced by a DB instance. */
function isSubnetGroupInUse(error: unknown): boolean {
  const name = typeof (error as { name?: unknown } | undefined)?.name === 'string'
    ? (error as { name: string }).name
    : '';
  return name.includes('InvalidDBSubnetGroupStateFault');
}

/**
 * Runs the purge to whatever conclusion is available right now. Reads
 * before writes, one phase at a time: application stack first, then the
 * owned orphans it left behind, then the bootstrap/relay stack LAST — the
 * relay deletes its own home, so nothing may follow that call.
 */
export async function settlePurge(deps: PurgeDeps): Promise<PurgeOutcome> {
  // Phase 1 — the application stack. Deleting it enforces the template's
  // per-resource policies; the retained RDS/S3/cache leftovers are swept in
  // the next phase, after the stack is gone.
  const lookup = await deps.cfn.describeStack(deps.stackName);
  if (lookup.found) {
    if (lookup.stack.tags[INSTALLATION_TAG] !== deps.installationId) {
      return {
        state: 'failed',
        reason: `Stack "${deps.stackName}" does not carry this installation's tag — refusing to purge`,
      };
    }
    const status = lookup.stack.status;
    if (status === 'DELETE_IN_PROGRESS') {
      return { state: 'purging' };
    }
    if (status === 'DELETE_FAILED') {
      // PURGE is the explicitly authorized data-deletion path: clear the
      // retained RDS/ElastiCache blockers outright and retry the delete.
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
      if (cleared.phase === 'DELETE_IN_PROGRESS') return { state: 'purging' };
      if (cleared.phase !== 'STACK_DELETED') {
        const blocked =
          cleared.blockedResources.length > 0
            ? ` Still blocked by: ${cleared.blockedResources.join(', ')}.`
            : '';
        return {
          state: 'failed',
          reason:
            `Stack "${deps.stackName}" deletion previously failed (DELETE_FAILED); ` +
            `clearing known orphans (${cleared.orphansDeleted.length} cleared) did not unblock it.${blocked}`,
        };
      }
    } else {
      await deps.deleter.deleteStack(deps.stackName);
      return { state: 'purging' };
    }
  }

  // Phase 2 — owned orphans. The stack is gone, so ownership is verifiable
  // only by resource tags. Each sub-phase initiates its deletions and then
  // waits (deferred) for a later pass to see them gone before moving on.
  const instances = await deps.rds.listOwnedInstances();
  if (instances.length > 0) {
    for (const instance of instances) {
      if (instance.status === 'deleting') continue;
      await deps.rds.disableDeletionProtection(instance.identifier);
      await deps.rds.deleteInstance(instance.identifier);
    }
    return { state: 'purging' };
  }

  const groups = await deps.cache.listOwnedReplicationGroups();
  if (groups.length > 0) {
    for (const group of groups) {
      if (group.status === 'deleting') continue;
      await deps.cache.deleteReplicationGroup(group.identifier);
    }
    return { state: 'purging' };
  }

  const buckets = await deps.s3.listOwnedBuckets();
  if (buckets.length > 0) {
    for (const bucket of buckets) {
      await deps.s3.emptyBucket(bucket);
      await deps.s3.deleteBucket(bucket);
    }
    return { state: 'purging' };
  }

  // Phase 2d — retained DB credentials (Phase 9). The application stack's
  // DatabaseSecret and DatabaseUrlSecret are retained with the database, so
  // a DELETE never strands a retained database without its password. A PURGE
  // deletes the retained database above first, then these secrets — the
  // credential to a deleted database is dead and must not linger.
  const secrets = await deps.secrets.listOwnedSecrets();
  if (secrets.length > 0) {
    for (const secret of secrets) {
      await deps.secrets.deleteSecret(secret);
    }
    return { state: 'purging' };
  }

  // ACM orphan sweep (Phase 11) — default-HTTPS and custom-domain
  // certificates live OUTSIDE the application stack, so a force-completed
  // destroy would leave them orphaned in the customer account. The
  // application stack is gone by now, so no ALB listener can hold them any
  // more; this relay itself holds no certificate — only the destroyed
  // deployment's did.
  const certificates = await deps.acm.listOwnedCertificates();
  if (certificates.length > 0) {
    for (const certificateArn of certificates) {
      await deps.acm.deleteCertificate(certificateArn);
    }
    return { state: 'purging' };
  }

  // Phase 2e — the RETAIN-ed RDS subnet group (CANARY-015). Only removable
  // once no DB instance references it — the instance sweep above already
  // guarantees that by running first and staying `purging` until every
  // owned instance is gone.
  const subnetGroups = await deps.rds.listOwnedSubnetGroups();
  if (subnetGroups.length > 0) {
    for (const name of subnetGroups) {
      try {
        await deps.rds.deleteSubnetGroup(name);
      } catch (error) {
        // Still referenced by a DB instance mid-deletion — wait, don't fail.
        if (!isSubnetGroupInUse(error)) throw error;
      }
    }
    console.log(
      JSON.stringify({ event: 'relay:purge-orphans-swept', kind: 'rds-subnet-group', ids: subnetGroups }),
    );
    return { state: 'purging' };
  }

  // Phase 2f — the orphaned VPC network (CANARY-015). A data-preserving
  // Disconnect's retained RDS instance keeps its ENI, its subnet and its DB
  // security group alive through the application stack's DeleteStack,
  // stranding the VPC too. Each list is tag-verified like every sweep
  // above; deletion order (security groups, then subnets, then the
  // rarely-present route-table/gateway leftovers, then the VPC itself)
  // follows CloudFormation's own dependency order for these resources. Only
  // the first VPC still carrying work is touched per pass — the next pass
  // sees it gone and moves to any sibling, or falls through to Phase 3.
  const vpcs = await deps.network.listOwnedVpcs();
  for (const vpcId of vpcs) {
    const securityGroups = await deps.network.listOwnedSecurityGroups(vpcId);
    if (securityGroups.length > 0) {
      const blocked: string[] = [];
      for (const groupId of securityGroups) {
        try {
          await deps.network.deleteSecurityGroup(groupId);
        } catch (error) {
          if (!isDependencyViolation(error)) throw error;
          blocked.push(groupId);
        }
      }
      // A security group referenced by another's own rule fails on the
      // first pass and clears once its sibling is gone — one more pass
      // before deferring the rest to the next poll.
      for (const groupId of blocked) {
        try {
          await deps.network.deleteSecurityGroup(groupId);
        } catch (error) {
          if (!isDependencyViolation(error)) throw error;
        }
      }
      console.log(
        JSON.stringify({ event: 'relay:purge-orphans-swept', kind: 'security-group', ids: securityGroups }),
      );
      return { state: 'purging' };
    }

    const subnets = await deps.network.listOwnedSubnets(vpcId);
    if (subnets.length > 0) {
      for (const subnetId of subnets) {
        try {
          await deps.network.deleteSubnet(subnetId);
        } catch (error) {
          if (!isDependencyViolation(error)) throw error;
        }
      }
      console.log(
        JSON.stringify({ event: 'relay:purge-orphans-swept', kind: 'subnet', ids: subnets }),
      );
      return { state: 'purging' };
    }

    // Route tables, internet gateways and NAT gateways are normally already
    // gone — the application stack's own DELETE_COMPLETE removed them
    // before the retained RDS instance ever blocked the subnet/SG/VPC.
    // Swept only when present, so a clean install's purge never touches
    // them.
    const routeTables = await deps.network.listOwnedRouteTables(vpcId);
    const internetGateways = await deps.network.listOwnedInternetGateways(vpcId);
    const natGateways = await deps.network.listOwnedNatGateways(vpcId);
    if (routeTables.length > 0 || internetGateways.length > 0 || natGateways.length > 0) {
      for (const routeTableId of routeTables) {
        try {
          await deps.network.deleteRouteTable(routeTableId);
        } catch (error) {
          if (!isDependencyViolation(error)) throw error;
        }
      }
      for (const gatewayId of internetGateways) {
        try {
          await deps.network.detachInternetGateway(gatewayId, vpcId);
          await deps.network.deleteInternetGateway(gatewayId);
        } catch (error) {
          if (!isDependencyViolation(error)) throw error;
        }
      }
      for (const natGatewayId of natGateways) {
        try {
          await deps.network.deleteNatGateway(natGatewayId);
        } catch (error) {
          if (!isDependencyViolation(error)) throw error;
        }
      }
      console.log(
        JSON.stringify({
          event: 'relay:purge-orphans-swept',
          kind: 'route-table-gateway',
          ids: [...routeTables, ...internetGateways, ...natGateways],
        }),
      );
      return { state: 'purging' };
    }

    try {
      await deps.network.deleteVpc(vpcId);
    } catch (error) {
      if (!isDependencyViolation(error)) throw error;
      return { state: 'purging' };
    }
    console.log(JSON.stringify({ event: 'relay:purge-orphans-swept', kind: 'vpc', ids: [vpcId] }));
    return { state: 'purging' };
  }

  // Phase 3 — the bootstrap/relay stack is NOT deleted here (CANARY-014).
  // It was created by the customer's Quick Create, the relay's CloudFormation
  // grants are tag-conditioned on an installation id that stack can never
  // carry (the id is minted inside it), and a stack cannot delete its own
  // execution role — the old describe-then-delete attempt was AccessDenied on
  // every real install and, being fail-closed, was silently reported as
  // "already gone". Say so instead: the control plane tells the customer to
  // delete the stack in CloudFormation.
  console.log(
    JSON.stringify({
      event: 'relay:purge-bootstrap-retained',
      installationId: deps.installationId,
      bootstrapStackName: deps.bootstrapStackName,
    }),
  );

  return { state: 'succeeded' };
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

export function createPurgeExecutor(deps: PurgeDeps): CommandExecutor {
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

    let outcome: PurgeOutcome;
    try {
      outcome = await settlePurge(deps);
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
        failureCode: 'STACK_DELETE_FAILED',
      });
    }

    if (outcome.state === 'succeeded') {
      console.log(
        JSON.stringify({
          event: 'relay:command-succeeded',
          commandId: command.id,
          type: command.type,
        }),
      );
      return result(command, true, {
        output: {
          executed: true,
          type: command.type,
          purged: true,
          connectorStackRetained: deps.bootstrapStackName,
        },
      });
    }

    // Deletions are in flight and will outlive this invocation — record the
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
        error: 'Purge in progress, but the relay could not record that it must report back',
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

/** The other half: finish a purge an earlier invocation started. */
export function createPurgeResumer(deps: PurgeDeps): () => Promise<RelayCommandResult[]> {
  return async () => {
    const pending = await deps.pending.read();
    if (pending === null || pending.type !== 'PURGE') return [];

    const outcome = await settlePurge(deps);
    if (outcome.state === 'purging') {
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
              purged: true,
              connectorStackRetained: deps.bootstrapStackName,
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

// ── Real AWS clients ───────────────────────────────────────────────────────

/**
 * Production purge clients. Ownership filtering happens HERE, not in the
 * executor: every `listOwned*` call verifies the `deployz:installation` tag
 * and returns only this installation's resources — a resource whose tags
 * are unreadable or mismatched is omitted, never attempted.
 */
export function createRealPurgeClients(installationId: string): {
  rds: RdsPurgeClient;
  cache: CachePurgeClient;
  s3: S3PurgeClient;
  secrets: SecretsPurgeClient;
  acm: AcmPurgeClient;
  network: NetworkPurgeClient;
} {
  const rdsBase = createRealRdsCleanupClient();
  const rds = new RDSClient({});
  const cacheBase = createRealCacheCleanupClient();
  const elasticache = new ElastiCacheClient({});
  const s3 = new S3Client({});
  const secrets = new SecretsManagerClient({});
  const acm = new ACMClient({});
  const owns = (
    tags: readonly { readonly Key?: string | undefined; readonly Value?: string | undefined }[],
  ) => tags.some((tag) => tag.Key === INSTALLATION_TAG && tag.Value === installationId);
  const ownsApplicationSecret = (
    tags: readonly { readonly Key?: string | undefined; readonly Value?: string | undefined }[],
  ) =>
    owns(tags) && tags.some((tag) => tag.Key === 'deployz:component' && tag.Value === 'application');

  return {
    rds: {
      ...rdsBase,
      async listOwnedInstances() {
        const response = await rds.send(new DescribeDBInstancesCommand({}));
        const owned: { identifier: string; status: string }[] = [];
        for (const instance of response.DBInstances ?? []) {
          if (!instance.DBInstanceIdentifier || !instance.DBInstanceArn) continue;
          try {
            const tags = await rds.send(
              new ListRdsTagsCommand({ ResourceName: instance.DBInstanceArn }),
            );
            if (owns(tags.TagList ?? [])) {
              owned.push({
                identifier: instance.DBInstanceIdentifier,
                status: instance.DBInstanceStatus ?? '',
              });
            }
          } catch (error) {
            // A permission failure is NOT "not ours" — it is a retryable
            // operation failure. Rethrowing sends the whole purge to
            // AWS_PERMISSION_DENIED; swallowing would report purged=true
            // while the instance still exists. Only a genuinely unreadable
            // tag (no such tag set, resource gone) means "not verifiably
            // ours" and is omitted.
            if (isAccessDenied(error)) throw error;
          }
        }
        return owned;
      },
      async listOwnedSubnetGroups() {
        const response = await rds.send(new DescribeDBSubnetGroupsCommand({}));
        const owned: string[] = [];
        for (const group of response.DBSubnetGroups ?? []) {
          if (!group.DBSubnetGroupName || !group.DBSubnetGroupArn) continue;
          try {
            const tags = await rds.send(
              new ListRdsTagsCommand({ ResourceName: group.DBSubnetGroupArn }),
            );
            if (owns(tags.TagList ?? [])) owned.push(group.DBSubnetGroupName);
          } catch (error) {
            if (isAccessDenied(error)) throw error;
          }
        }
        return owned;
      },
      async deleteSubnetGroup(name) {
        await rds.send(new DeleteDBSubnetGroupCommand({ DBSubnetGroupName: name }));
      },
    },
    cache: {
      ...cacheBase,
      async listOwnedReplicationGroups() {
        const response = await elasticache.send(new DescribeReplicationGroupsCommand({}));
        const owned: { identifier: string; status: string }[] = [];
        for (const group of response.ReplicationGroups ?? []) {
          if (!group.ReplicationGroupId || !group.ARN) continue;
          try {
            const tags = await elasticache.send(
              new ListTagsForResourceCommand({ ResourceName: group.ARN }),
            );
            if (owns(tags.TagList ?? [])) {
              owned.push({ identifier: group.ReplicationGroupId, status: group.Status ?? '' });
            }
          } catch (error) {
            if (isAccessDenied(error)) throw error;
          }
        }
        return owned;
      },
    },
    s3: {
      async listOwnedBuckets() {
        const response = await s3.send(new ListBucketsCommand({}));
        const owned: string[] = [];
        for (const bucket of response.Buckets ?? []) {
          if (!bucket.Name) continue;
          try {
            const tagging = await s3.send(new GetBucketTaggingCommand({ Bucket: bucket.Name }));
            if (owns(tagging.TagSet ?? [])) owned.push(bucket.Name);
          } catch (error) {
            // Same rule: AccessDenied must fail the purge, not vanish it.
            if (isAccessDenied(error)) throw error;
          }
        }
        return owned;
      },
      async emptyBucket(bucketName) {
        // Round-based: collect every object version and delete marker (all
        // pages), delete them in batches of 1000, repeat until a full round
        // collects nothing. Versioning means "empty" is zero versions AND
        // zero delete markers.
        for (;;) {
          const objects: { Key: string; VersionId: string }[] = [];
          let keyMarker: string | undefined;
          let versionIdMarker: string | undefined;
          do {
            const page = await s3.send(
              new ListObjectVersionsCommand({
                Bucket: bucketName,
                ...(keyMarker !== undefined ? { KeyMarker: keyMarker } : {}),
                ...(versionIdMarker !== undefined ? { VersionIdMarker: versionIdMarker } : {}),
              }),
            );
            objects.push(
              ...(page.Versions ?? []).flatMap((version) =>
                version.Key !== undefined && version.VersionId !== undefined
                  ? [{ Key: version.Key, VersionId: version.VersionId }]
                  : [],
              ),
              ...(page.DeleteMarkers ?? []).flatMap((marker) =>
                marker.Key !== undefined && marker.VersionId !== undefined
                  ? [{ Key: marker.Key, VersionId: marker.VersionId }]
                  : [],
              ),
            );
            keyMarker = page.NextKeyMarker;
            versionIdMarker = page.NextVersionIdMarker;
          } while (keyMarker !== undefined);
          if (objects.length === 0) return;
          for (let offset = 0; offset < objects.length; offset += 1000) {
            await s3.send(
              new DeleteObjectsCommand({
                Bucket: bucketName,
                Delete: { Objects: objects.slice(offset, offset + 1000) },
              }),
            );
          }
        }
      },
      async deleteBucket(bucketName) {
        await s3.send(new DeleteBucketCommand({ Bucket: bucketName }));
      },
    },
    secrets: {
      async listOwnedSecrets() {
        const response = await secrets.send(new ListSecretsCommand({}));
        const owned: string[] = [];
        for (const secret of response.SecretList ?? []) {
          if (!secret.Name || !secret.ARN) continue;
          try {
            const description = await secrets.send(
              new DescribeSecretCommand({ SecretId: secret.ARN }),
            );
            if (ownsApplicationSecret(description.Tags ?? [])) owned.push(secret.Name);
          } catch (error) {
            // Same rule as every other orphan read: an access-denied while
            // verifying ownership must fail the purge, not vanish it.
            if (isAccessDenied(error)) throw error;
          }
        }
        return owned;
      },
      async deleteSecret(secretName) {
        // ForceDeleteWithoutRecovery: a purge is the explicitly authorized
        // data-deletion path — no 30-day soft-delete window for a credential
        // whose database is already gone.
        await secrets.send(
          new DeleteSecretCommand({ SecretId: secretName, ForceDeleteWithoutRecovery: true }),
        );
      },
    },
    acm: {
      async listOwnedCertificates() {
        const owned: string[] = [];
        let marker: string | undefined;
        do {
          const response = await acm.send(new ListCertificatesCommand({ NextToken: marker }));
          for (const certificate of response.CertificateSummaryList ?? []) {
            if (!certificate.CertificateArn) continue;
            try {
              const tags = await acm.send(
                new ListTagsForCertificateCommand({ CertificateArn: certificate.CertificateArn }),
              );
              if (owns(tags.Tags ?? [])) owned.push(certificate.CertificateArn);
            } catch (error) {
              // Same rule: an access-denied while reading tags must fail the
              // purge, not be silently treated as "not ours".
              if (isAccessDenied(error)) throw error;
            }
          }
          marker = response.NextToken;
        } while (marker !== undefined);
        return owned;
      },
      async deleteCertificate(certificateArn) {
        await acm.send(new DeleteCertificateCommand({ CertificateArn: certificateArn }));
      },
    },
    network: createRealNetworkPurgeClient(installationId),
  };
}

/** The one method of the SDK client `toNetworkPurgeClient` uses. */
interface SendsEc2Commands {
  send(command: unknown): Promise<unknown>;
}

interface TaggedEc2Resource {
  Tags?: { Key?: string; Value?: string }[];
}

/**
 * Wrap an EC2 client as a `NetworkPurgeClient`. Split out from
 * `createRealNetworkPurgeClient` so it can be tested against a fake client
 * with no SDK construction — same shape as `toReader`/`toInstaller`.
 *
 * Every list narrows with the request's own tag filter AND re-checks the
 * returned `Tags`: the filter is the fast path, the re-check is the same
 * fail-closed guarantee every other purge client makes — an untagged or
 * mismatched resource that somehow surfaces here is still omitted, never
 * deleted.
 */
export function toNetworkPurgeClient(
  client: SendsEc2Commands,
  installationId: string,
): NetworkPurgeClient {
  const owns = (resource: TaggedEc2Resource) =>
    (resource.Tags ?? []).some(
      (tag) => tag.Key === INSTALLATION_TAG && tag.Value === installationId,
    );
  const installationFilter = { Name: `tag:${INSTALLATION_TAG}`, Values: [installationId] };

  return {
    async listOwnedVpcs() {
      const response = (await client.send(
        new DescribeVpcsCommand({ Filters: [installationFilter] }),
      )) as { Vpcs?: (TaggedEc2Resource & { VpcId?: string })[] };
      return (response.Vpcs ?? []).flatMap((vpc) =>
        vpc.VpcId && owns(vpc) ? [vpc.VpcId] : [],
      );
    },
    async listOwnedSecurityGroups(vpcId) {
      const response = (await client.send(
        new DescribeSecurityGroupsCommand({
          Filters: [installationFilter, { Name: 'vpc-id', Values: [vpcId] }],
        }),
      )) as { SecurityGroups?: (TaggedEc2Resource & { GroupId?: string; GroupName?: string })[] };
      return (response.SecurityGroups ?? []).flatMap((group) =>
        group.GroupId && group.GroupName !== 'default' && owns(group) ? [group.GroupId] : [],
      );
    },
    async deleteSecurityGroup(groupId) {
      await client.send(new DeleteSecurityGroupCommand({ GroupId: groupId }));
    },
    async listOwnedSubnets(vpcId) {
      const response = (await client.send(
        new DescribeSubnetsCommand({
          Filters: [installationFilter, { Name: 'vpc-id', Values: [vpcId] }],
        }),
      )) as { Subnets?: (TaggedEc2Resource & { SubnetId?: string })[] };
      return (response.Subnets ?? []).flatMap((subnet) =>
        subnet.SubnetId && owns(subnet) ? [subnet.SubnetId] : [],
      );
    },
    async deleteSubnet(subnetId) {
      await client.send(new DeleteSubnetCommand({ SubnetId: subnetId }));
    },
    async listOwnedRouteTables(vpcId) {
      const response = (await client.send(
        new DescribeRouteTablesCommand({
          Filters: [installationFilter, { Name: 'vpc-id', Values: [vpcId] }],
        }),
      )) as {
        RouteTables?: (TaggedEc2Resource & {
          RouteTableId?: string;
          Associations?: { Main?: boolean }[];
        })[];
      };
      return (response.RouteTables ?? []).flatMap((table) =>
        table.RouteTableId &&
        owns(table) &&
        !(table.Associations ?? []).some((assoc) => assoc.Main)
          ? [table.RouteTableId]
          : [],
      );
    },
    async deleteRouteTable(routeTableId) {
      await client.send(new DeleteRouteTableCommand({ RouteTableId: routeTableId }));
    },
    async listOwnedInternetGateways(vpcId) {
      const response = (await client.send(
        new DescribeInternetGatewaysCommand({
          Filters: [installationFilter, { Name: 'attachment.vpc-id', Values: [vpcId] }],
        }),
      )) as { InternetGateways?: (TaggedEc2Resource & { InternetGatewayId?: string })[] };
      return (response.InternetGateways ?? []).flatMap((gateway) =>
        gateway.InternetGatewayId && owns(gateway) ? [gateway.InternetGatewayId] : [],
      );
    },
    async detachInternetGateway(gatewayId, vpcId) {
      await client.send(
        new DetachInternetGatewayCommand({ InternetGatewayId: gatewayId, VpcId: vpcId }),
      );
    },
    async deleteInternetGateway(gatewayId) {
      await client.send(new DeleteInternetGatewayCommand({ InternetGatewayId: gatewayId }));
    },
    async listOwnedNatGateways(vpcId) {
      const response = (await client.send(
        // DescribeNatGateways uses `Filter` (singular) — a naming quirk of
        // this one action, unlike every other Describe* used here.
        new DescribeNatGatewaysCommand({
          Filter: [installationFilter, { Name: 'vpc-id', Values: [vpcId] }],
        }),
      )) as {
        NatGateways?: (TaggedEc2Resource & { NatGatewayId?: string; State?: string })[];
      };
      return (response.NatGateways ?? []).flatMap((gateway) =>
        gateway.NatGatewayId &&
        owns(gateway) &&
        gateway.State !== 'deleting' &&
        gateway.State !== 'deleted'
          ? [gateway.NatGatewayId]
          : [],
      );
    },
    async deleteNatGateway(natGatewayId) {
      await client.send(new DeleteNatGatewayCommand({ NatGatewayId: natGatewayId }));
    },
    async deleteVpc(vpcId) {
      await client.send(new DeleteVpcCommand({ VpcId: vpcId }));
    },
  };
}

/** Production network purge client — credentials come from the standard SDK chain. */
export function createRealNetworkPurgeClient(installationId: string): NetworkPurgeClient {
  return toNetworkPurgeClient(new EC2Client({}), installationId);
}
