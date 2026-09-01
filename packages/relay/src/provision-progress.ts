/**
 * Provisioning snapshot — a per-category read of a CloudFormation stack
 * that is still mid-create or mid-update.
 *
 * `verifyInstallation` (./verify.ts) answers one question — is the
 * installation done and correct? — and stops at the first sign it is not.
 * While a stack is still building, that early exit is right for
 * verification but leaves a heartbeat with nothing to say about progress.
 * This module answers the different question a still-building stack can
 * usefully answer: which parts of the application are up, which are
 * working, and which have failed?
 *
 * Resources are grouped by CloudFormation type prefix into the five
 * categories the product surfaces (network, database, storage, redis,
 * application). A resource type nobody asked to categorize is silently
 * ignored — the snapshot enriches a heartbeat, it does not audit the stack.
 *
 * Every category status is computed strictly from `DescribeStackResources`
 * output that is already fetched for verification, so this costs no extra
 * IAM permission. `Timestamp` there is CloudFormation's last-status-change
 * time per resource — not "when creation truly started" — which is a good
 * enough proxy for "how long has this category been at it" without a
 * second, more expensive read of `DescribeStackEvents`.
 *
 * The building block (`summarizeProvisioning`) is pure and synchronous, so
 * every rule can be tested without a fake AWS client. `buildProvisioningSnapshot`
 * is the only part that touches the reader, and it follows the same
 * fail-closed rule as `verifyInstallation`: this is enrichment on top of an
 * already-reported heartbeat, so ANY failure — an unreadable stack, a
 * throw from a reader that broke its no-throw contract — resolves to `null`
 * rather than losing the heartbeat it was meant to enrich.
 */

import type { CloudFormationReader, StackResource } from './verify.js';

// ── Snapshot shape ───────────────────────────────────────────────────────────

export type ProvisioningCategory = 'network' | 'database' | 'storage' | 'redis' | 'application';

export interface CategoryProgress {
  readonly status: 'IN_PROGRESS' | 'COMPLETE' | 'FAILED';
  /** Earliest resource `Timestamp` observed in this category. */
  readonly startedAt?: string;
  /** Latest resource `Timestamp` observed — only set once the category is COMPLETE. */
  readonly completedAt?: string;
}

export interface ProvisioningSnapshot {
  readonly stackStatus: string;
  readonly observedAt: string;
  /** Absent categories have no resources yet — the API treats that as "not started". */
  readonly categories: Readonly<Partial<Record<ProvisioningCategory, CategoryProgress>>>;
}

/** Stack and resource statuses that mean "this finished, and it worked". */
const COMPLETE_STATUSES: ReadonlySet<string> = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE']);

/**
 * Category by CloudFormation resource-type prefix. Order does not matter —
 * every prefix here is unambiguous on its own — but each entry is checked
 * with `startsWith` rather than equality, since CloudFormation resource
 * types below the `::` boundary (e.g. `AWS::EC2::VPC`, `AWS::EC2::Subnet`)
 * are not enumerated individually.
 */
const CATEGORY_PREFIXES: ReadonlyArray<readonly [prefix: string, category: ProvisioningCategory]> = [
  ['AWS::EC2::', 'network'],
  ['AWS::RDS::', 'database'],
  ['AWS::SecretsManager::', 'database'],
  ['AWS::S3::', 'storage'],
  ['AWS::ElastiCache::', 'redis'],
  ['AWS::ECS::', 'application'],
  ['AWS::ElasticLoadBalancingV2::', 'application'],
  // IAM roles and log groups deliberately stay uncategorized: CloudFormation
  // creates them at the very start of the stack, so counting them as
  // `application` backdated that category's startedAt to stack creation and
  // inflated the "Starting application" elapsed time by several minutes
  // (observed live on the first documenso E2E of this feature).
];

function categoryFor(resourceType: string): ProvisioningCategory | undefined {
  return CATEGORY_PREFIXES.find(([prefix]) => resourceType.startsWith(prefix))?.[1];
}

/**
 * Roll a stack's resource inventory up into a per-category progress
 * snapshot. Pure and synchronous — every rule here is a direct function of
 * its three inputs, with no clock or AWS call inside.
 *
 * Category status: `FAILED` if any resource in the category ended in
 * `*_FAILED`; `COMPLETE` only when every resource in it is
 * `CREATE_COMPLETE`/`UPDATE_COMPLETE`; `IN_PROGRESS` otherwise (covers
 * `*_IN_PROGRESS`, `ROLLBACK_COMPLETE` on an individual resource, etc.).
 *
 * `startedAt` is the earliest resource `Timestamp` in the category, present
 * as soon as CloudFormation has touched any of it. `completedAt` is the
 * latest, but only once the whole category is COMPLETE — a still-moving
 * category has no end time to report yet.
 */
export function summarizeProvisioning(
  stackStatus: string,
  resources: readonly StackResource[],
  observedAt: string,
): ProvisioningSnapshot {
  const byCategory = new Map<ProvisioningCategory, StackResource[]>();
  for (const resource of resources) {
    const category = categoryFor(resource.type);
    if (!category) continue;
    const existing = byCategory.get(category);
    if (existing) existing.push(resource);
    else byCategory.set(category, [resource]);
  }

  const categories: Partial<Record<ProvisioningCategory, CategoryProgress>> = {};
  for (const [category, categoryResources] of byCategory) {
    categories[category] = summarizeCategory(categoryResources);
  }

  return { stackStatus, observedAt, categories };
}

function summarizeCategory(resources: readonly StackResource[]): CategoryProgress {
  const failed = resources.some((resource) => resource.status.endsWith('_FAILED'));
  const complete = !failed && resources.every((resource) => COMPLETE_STATUSES.has(resource.status));
  const status: CategoryProgress['status'] = failed ? 'FAILED' : complete ? 'COMPLETE' : 'IN_PROGRESS';

  const timestamps = resources
    .map((resource) => resource.timestamp)
    .filter((timestamp): timestamp is string => timestamp !== undefined)
    .sort();

  return {
    status,
    ...(timestamps.length > 0 ? { startedAt: timestamps[0] } : {}),
    ...(complete && timestamps.length > 0 ? { completedAt: timestamps[timestamps.length - 1] } : {}),
  };
}

// ── Composing helper ─────────────────────────────────────────────────────────

/**
 * Fetch a stack's status and resource inventory and summarize them.
 *
 * The two calls this makes (`describeStack`, `describeStackResources`) are
 * the same ones `verifyInstallation` already made this poll — no new IAM
 * permission is needed. Every failure — the stack not found, a reader that
 * throws despite its no-throw contract — resolves to `null`: the snapshot
 * is enrichment riding inside an already-successful heartbeat, and it must
 * never be the reason that heartbeat is late or missing.
 */
export async function buildProvisioningSnapshot(
  cfn: CloudFormationReader,
  stackName: string,
  now: () => string = () => new Date().toISOString(),
): Promise<ProvisioningSnapshot | null> {
  try {
    const lookup = await cfn.describeStack(stackName);
    if (!lookup.found) return null;

    const resources = await cfn.describeStackResources(stackName);
    return summarizeProvisioning(lookup.stack.status, resources, now());
  } catch {
    return null;
  }
}
