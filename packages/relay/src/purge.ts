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
  DescribeReplicationGroupsCommand,
  ElastiCacheClient,
  ListTagsForResourceCommand,
} from '@aws-sdk/client-elasticache';
import {
  DescribeDBInstancesCommand,
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

  // Phase 2e — orphaned ACM certificates (Phase 11 default HTTPS + custom
  // domains). The application stack is gone, so no listener can hold them
  // any more; the bootstrap stack is deleted LAST (below), and this relay
  // itself holds no certificate — only the destroyed deployment's did.
  const certificates = await deps.acm.listOwnedCertificates();
  if (certificates.length > 0) {
    for (const certificateArn of certificates) {
      await deps.acm.deleteCertificate(certificateArn);
    }
    return { state: 'purging' };
  }

  // Phase 3 — the bootstrap/relay stack, LAST by design. Initiated, not
  // awaited: the teardown takes minutes while the result of this very
  // command is reported sub-second after the executor returns, and the
  // relay cannot outlive its own stack to watch it go.
  //
  // Ownership is NOT verified by tag here: the bootstrap stack is created
  // by the customer's Quick Create BEFORE the installation id is minted
  // inside it, so it can never carry a readable `deployz:installation` tag
  // equal to ours (the id is a deploy-time GetAtt token on our own
  // resources, not a static stack tag). The ownership evidence is the
  // NAME: `bootstrapStackName` is baked into this relay's environment as
  // `Ref AWS::StackName` of the very stack we are deleting — the control
  // plane's `deployments.bootstrap_stack_name` metadata. Deleting a
  // same-named foreign stack in our own account is out of scope; refusing
  // on the impossible tag would make the bootstrap removal never run.
  const bootstrap = await deps.cfn.describeStack(deps.bootstrapStackName);
  if (bootstrap.found) {
    if (bootstrap.stack.status !== 'DELETE_IN_PROGRESS') {
      await deps.deleter.deleteStack(deps.bootstrapStackName);
    }
  }

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
        output: { executed: true, type: command.type, purged: true },
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
            output: { executed: true, type: pending.type, purged: true },
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
  };
}
