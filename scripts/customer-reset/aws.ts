/**
 * Thin AWS helpers for the customer-reset admin tool.
 *
 * Mirrors the ownership-verification pattern `packages/relay/src/purge.ts`
 * already uses for the per-customer PURGE flow: every `listOwned*` helper
 * here reads a resource's tags itself and returns ONLY resources carrying
 * `deployz:installation=<installationId>` — an unreadable or mismatched tag
 * is omitted, never assumed. `listCustomerStacks` layers the same rule on
 * top of the naming convention from `@deployz/contracts`: a name matching
 * `applicationStackNameForInstallation`/`bootstrapStackName` is only a
 * CANDIDATE — the stack must also carry the installation tag before it is
 * returned. Callers still run every candidate through
 * `safety.ts#isOwnedByInstallation` against the manifest before deleting.
 */

import {
  CloudFormationClient,
  DeleteStackCommand,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
  waitUntilStackDeleteComplete,
} from '@aws-sdk/client-cloudformation';
import {
  DeleteReplicationGroupCommand,
  DescribeReplicationGroupsCommand,
  ElastiCacheClient,
  ListTagsForResourceCommand as ListCacheTagsCommand,
} from '@aws-sdk/client-elasticache';
import {
  DeleteDBInstanceCommand,
  DescribeDBInstancesCommand,
  ListTagsForResourceCommand as ListRdsTagsCommand,
  ModifyDBInstanceCommand,
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

const INSTALLATION_TAG = 'deployz:installation';

// ── Retry with backoff ───────────────────────────────────────────────────────

function isThrottlingError(err: unknown): boolean {
  const name = (err as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' && /Throttl|TooManyRequests|RequestLimitExceeded/i.test(name);
}

/** Retries an AWS call on throttling errors only, with exponential backoff. */
export async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isThrottlingError(err) || attempt >= maxAttempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    }
  }
}

/** A simple fixed-size concurrency pool — no queueing library, just enough for this tool. */
export async function runPooled<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

// ── CloudFormation stacks ────────────────────────────────────────────────────

export interface CustomerStack {
  readonly stackName: string;
  readonly stackStatus: string;
  readonly installationTag: string;
  readonly kind: 'application' | 'bootstrap';
}

// The naming conventions from @deployz/contracts (applicationStackNameForInstallation /
// bootstrapStackName) — used only to shortlist CANDIDATES; the installation
// tag check below is what actually decides ownership.
const APPLICATION_STACK_PATTERN = /^deployz-app(-|$)/;
const BOOTSTRAP_STACK_PATTERN = /^deployz-bootstrap(-|$)/;

/**
 * Lists CloudFormation stacks in `region` whose name matches the Deployz
 * application/bootstrap naming convention AND that carry the
 * `deployz:installation` tag. Name alone is never sufficient — a stack
 * without the tag is skipped, not returned as a candidate.
 */
export async function listCustomerStacks(region: string): Promise<CustomerStack[]> {
  const client = new CloudFormationClient({ region });
  const stacks: CustomerStack[] = [];
  let nextToken: string | undefined;
  do {
    const response = await withRetry(() =>
      client.send(new DescribeStacksCommand({ NextToken: nextToken })),
    );
    for (const stack of response.Stacks ?? []) {
      const name = stack.StackName;
      if (!name) continue;
      const kind = APPLICATION_STACK_PATTERN.test(name)
        ? 'application'
        : BOOTSTRAP_STACK_PATTERN.test(name)
          ? 'bootstrap'
          : undefined;
      if (!kind) continue;
      const installationTag = (stack.Tags ?? []).find((tag) => tag.Key === INSTALLATION_TAG)?.Value;
      if (installationTag === undefined) continue;
      stacks.push({ stackName: name, stackStatus: stack.StackStatus ?? 'UNKNOWN', installationTag, kind });
    }
    nextToken = response.NextToken;
  } while (nextToken);
  return stacks;
}

/** Deletes a stack and waits for CloudFormation to report it gone. */
export async function deleteStackAndWait(region: string, stackName: string): Promise<void> {
  const client = new CloudFormationClient({ region });
  await withRetry(() => client.send(new DeleteStackCommand({ StackName: stackName })));
  await waitUntilStackDeleteComplete(
    { client, maxWaitTime: 900 },
    { StackName: stackName },
  );
}

/**
 * DELETE_FAILED remediation — same pattern `packages/relay/src/recover.ts`
 * uses: read the stack's own DELETE_FAILED resources, clear the RDS/
 * ElastiCache blockers CloudFormation named, then retry the delete.
 */
export async function remediateDeleteFailedStack(region: string, stackName: string): Promise<void> {
  const cfn = new CloudFormationClient({ region });
  const { StackResources } = await withRetry(() =>
    cfn.send(new DescribeStackResourcesCommand({ StackName: stackName })),
  );
  for (const resource of StackResources ?? []) {
    if (resource.ResourceStatus !== 'DELETE_FAILED' || !resource.PhysicalResourceId) continue;
    try {
      if (resource.ResourceType === 'AWS::RDS::DBInstance') {
        await disableRdsProtectionAndDelete(region, resource.PhysicalResourceId);
      } else if (resource.ResourceType === 'AWS::ElastiCache::ReplicationGroup') {
        const cache = new ElastiCacheClient({ region });
        await withRetry(() =>
          cache.send(new DeleteReplicationGroupCommand({ ReplicationGroupId: resource.PhysicalResourceId })),
        );
      }
    } catch (err) {
      console.warn(
        `[customer-reset] could not clear DELETE_FAILED blocker ${resource.LogicalResourceId} (${resource.ResourceType}): ${String(err)}`,
      );
    }
  }
  await deleteStackAndWait(region, stackName);
}

// ── RDS ───────────────────────────────────────────────────────────────────

/** Skips the final snapshot and deletes automated backups — this is the explicitly-authorized reset path. */
export async function disableRdsProtectionAndDelete(
  region: string,
  dbInstanceIdentifier: string,
): Promise<void> {
  const client = new RDSClient({ region });
  await withRetry(() =>
    client.send(
      new ModifyDBInstanceCommand({
        DBInstanceIdentifier: dbInstanceIdentifier,
        DeletionProtection: false,
        ApplyImmediately: true,
      }),
    ),
  );
  await withRetry(() =>
    client.send(
      new DeleteDBInstanceCommand({
        DBInstanceIdentifier: dbInstanceIdentifier,
        SkipFinalSnapshot: true,
        DeleteAutomatedBackups: true,
      }),
    ),
  );
}

/** Tag-verified RDS instances owned by `installationId` — read-only, deletes nothing. */
export async function listOwnedRdsInstances(region: string, installationId: string): Promise<string[]> {
  const client = new RDSClient({ region });
  const owned: string[] = [];
  const response = await withRetry(() => client.send(new DescribeDBInstancesCommand({})));
  for (const instance of response.DBInstances ?? []) {
    if (!instance.DBInstanceIdentifier || !instance.DBInstanceArn) continue;
    try {
      const tags = await client.send(new ListRdsTagsCommand({ ResourceName: instance.DBInstanceArn }));
      if ((tags.TagList ?? []).some((tag) => tag.Key === INSTALLATION_TAG && tag.Value === installationId)) {
        owned.push(instance.DBInstanceIdentifier);
      }
    } catch {
      // Unreadable tags are not verifiably ours — omitted.
    }
  }
  return owned;
}

// ── ElastiCache ───────────────────────────────────────────────────────────

/** Tag-verified ElastiCache replication groups owned by `installationId` — read-only, deletes nothing. */
export async function listOwnedReplicationGroups(region: string, installationId: string): Promise<string[]> {
  const client = new ElastiCacheClient({ region });
  const owned: string[] = [];
  const response = await withRetry(() => client.send(new DescribeReplicationGroupsCommand({})));
  for (const group of response.ReplicationGroups ?? []) {
    if (!group.ReplicationGroupId || !group.ARN) continue;
    try {
      const tags = await client.send(new ListCacheTagsCommand({ ResourceName: group.ARN }));
      if ((tags.TagList ?? []).some((tag) => tag.Key === INSTALLATION_TAG && tag.Value === installationId)) {
        owned.push(group.ReplicationGroupId);
      }
    } catch {
      // Unreadable tags are not verifiably ours — omitted.
    }
  }
  return owned;
}

// ── S3 ────────────────────────────────────────────────────────────────────

/** Tag-verified S3 buckets owned by `installationId` — read-only, deletes nothing. */
export async function listOwnedBuckets(installationId: string): Promise<string[]> {
  const client = new S3Client({});
  const owned: string[] = [];
  const response = await withRetry(() => client.send(new ListBucketsCommand({})));
  for (const bucket of response.Buckets ?? []) {
    if (!bucket.Name) continue;
    try {
      const tagging = await client.send(new GetBucketTaggingCommand({ Bucket: bucket.Name }));
      if ((tagging.TagSet ?? []).some((tag) => tag.Key === INSTALLATION_TAG && tag.Value === installationId)) {
        owned.push(bucket.Name);
      }
    } catch {
      // An untaggable/unreadable bucket is not verifiably ours.
    }
  }
  return owned;
}

/** Deletes every object version and delete marker, then the empty bucket itself. */
export async function emptyAndDeleteBucket(bucketName: string): Promise<void> {
  const client = new S3Client({});
  for (;;) {
    const objects: { Key: string; VersionId: string }[] = [];
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    do {
      const page = await withRetry(() =>
        client.send(
          new ListObjectVersionsCommand({
            Bucket: bucketName,
            ...(keyMarker !== undefined ? { KeyMarker: keyMarker } : {}),
            ...(versionIdMarker !== undefined ? { VersionIdMarker: versionIdMarker } : {}),
          }),
        ),
      );
      objects.push(
        ...(page.Versions ?? []).flatMap((v) =>
          v.Key !== undefined && v.VersionId !== undefined ? [{ Key: v.Key, VersionId: v.VersionId }] : [],
        ),
        ...(page.DeleteMarkers ?? []).flatMap((m) =>
          m.Key !== undefined && m.VersionId !== undefined ? [{ Key: m.Key, VersionId: m.VersionId }] : [],
        ),
      );
      keyMarker = page.NextKeyMarker;
      versionIdMarker = page.NextVersionIdMarker;
    } while (keyMarker !== undefined);

    if (objects.length === 0) break;
    for (let offset = 0; offset < objects.length; offset += 1000) {
      await withRetry(() =>
        client.send(
          new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: { Objects: objects.slice(offset, offset + 1000) },
          }),
        ),
      );
    }
  }
  await withRetry(() => client.send(new DeleteBucketCommand({ Bucket: bucketName })));
}

// ── Orphan sweep ──────────────────────────────────────────────────────────

export interface OwnedResources {
  readonly rdsInstances: readonly string[];
  readonly replicationGroups: readonly string[];
  readonly buckets: readonly string[];
}

/**
 * Tag-verified RDS/ElastiCache/S3 resources owned by `installationId` —
 * read-only, deletes nothing. Used by both the destructive sweep below and
 * `verify.ts`'s post-reset re-scan.
 */
export async function findOwnedResources(installationId: string, region: string): Promise<OwnedResources> {
  const [rdsInstances, replicationGroups, buckets] = await Promise.all([
    listOwnedRdsInstances(region, installationId),
    listOwnedReplicationGroups(region, installationId),
    listOwnedBuckets(installationId),
  ]);
  return { rdsInstances, replicationGroups, buckets };
}

export interface OrphanSweepResult {
  readonly rdsInstancesDeleted: readonly string[];
  readonly replicationGroupsDeleted: readonly string[];
  readonly bucketsDeleted: readonly string[];
}

/**
 * Sweeps RDS/ElastiCache/S3 for resources tag-verified as belonging to
 * `installationId` and deletes them. Each list is re-read and re-verified
 * here — nothing is deleted on the strength of a name or region alone.
 */
export async function deleteOrphansForInstallation(
  installationId: string,
  region: string,
): Promise<OrphanSweepResult> {
  const { rdsInstances, replicationGroups, buckets } = await findOwnedResources(installationId, region);

  await runPooled(rdsInstances, 3, (id) => disableRdsProtectionAndDelete(region, id));
  await runPooled(replicationGroups, 3, (id) => {
    const client = new ElastiCacheClient({ region });
    return withRetry(() => client.send(new DeleteReplicationGroupCommand({ ReplicationGroupId: id })));
  });
  await runPooled(buckets, 3, (name) => emptyAndDeleteBucket(name));

  return {
    rdsInstancesDeleted: rdsInstances,
    replicationGroupsDeleted: replicationGroups,
    bucketsDeleted: buckets,
  };
}

// ── Relay EventBridge freeze (best-effort) ──────────────────────────────────

/**
 * Disables the relay's polling EventBridge rule(s) inside a bootstrap stack,
 * so a relay cannot pick up new work mid-reset. Best-effort and skippable by
 * design (the tool never depends on this succeeding): resolved dynamically
 * so a missing `@aws-sdk/client-eventbridge` install, a permission denial, or
 * any other failure just logs a warning and moves on.
 */
export async function freezeRelayEventBridgeRules(
  region: string,
  bootstrapStackName: string,
): Promise<readonly string[]> {
  try {
    const { EventBridgeClient, ListRulesCommand, DisableRuleCommand } = await import(
      '@aws-sdk/client-eventbridge'
    );
    const client = new EventBridgeClient({ region });
    const disabled: string[] = [];
    let nextToken: string | undefined;
    do {
      const response = await client.send(
        new ListRulesCommand({ NamePrefix: bootstrapStackName, NextToken: nextToken }),
      );
      for (const rule of response.Rules ?? []) {
        if (!rule.Name) continue;
        try {
          await client.send(new DisableRuleCommand({ Name: rule.Name }));
          disabled.push(rule.Name);
        } catch (err) {
          console.warn(`[customer-reset] could not disable rule ${rule.Name}: ${String(err)}`);
        }
      }
      nextToken = response.NextToken;
    } while (nextToken);
    return disabled;
  } catch (err) {
    console.warn(
      `[customer-reset] EventBridge rule freeze skipped for "${bootstrapStackName}": ${String(err)}`,
    );
    return [];
  }
}
