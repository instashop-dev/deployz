/**
 * Turns persisted CloudFormation stack events into the same provisioning
 * snapshot shape `deployment-status.ts` `readProvisioningSnapshot()` already
 * consumes from the relay heartbeat (`packages/relay/src/provision-progress.ts`
 * `summarizeProvisioning`). This is the event-driven equivalent: instead of a
 * point-in-time `DescribeStackResources` read, it replays the event history
 * so a resource's current status is its LATEST event, and rollback debris
 * (a `DELETE_*`/`ROLLBACK_*` event on a resource that already finished) never
 * regresses a category that already completed or fails one that never
 * genuinely failed. Pure and synchronous — no clock, no AWS call.
 */

export type ProvisioningCategory = 'network' | 'database' | 'storage' | 'redis' | 'application';

export interface StoredStackEvent {
  readonly eventAt: Date;
  readonly logicalResourceId: string;
  readonly resourceType: string;
  readonly resourceStatus: string;
  readonly resourceStatusReason: string | null;
}

interface CategoryProgress {
  readonly status: 'IN_PROGRESS' | 'COMPLETE' | 'FAILED';
  readonly startedAt?: string;
  readonly completedAt?: string;
}

/**
 * Category by CloudFormation resource-type prefix. Mirrors
 * `packages/relay/src/provision-progress.ts`'s table where they overlap —
 * including putting `AWS::SecretsManager::` under `database` — so the two
 * snapshots never disagree, then extends it with the application-tier types
 * that summarizer doesn't need (ECR, ACM, Route53).
 */
const CATEGORY_PREFIXES: ReadonlyArray<readonly [prefix: string, category: ProvisioningCategory]> = [
  ['AWS::EC2::', 'network'],
  ['AWS::RDS::', 'database'],
  ['AWS::SecretsManager::', 'database'],
  ['AWS::S3::', 'storage'],
  ['AWS::ElastiCache::', 'redis'],
  ['AWS::ECS::', 'application'],
  ['AWS::ElasticLoadBalancingV2::', 'application'],
  ['AWS::ECR::', 'application'],
  ['AWS::CertificateManager::', 'application'],
  ['AWS::Route53::', 'application'],
];

export function categorizeResourceType(resourceType: string): ProvisioningCategory | null {
  return CATEGORY_PREFIXES.find(([prefix]) => resourceType.startsWith(prefix))?.[1] ?? null;
}

/** Boilerplate reasons CloudFormation gives the resources it cancelled in
 *  response to the one that actually failed — same set as install.ts
 *  `CANCELLED_REASONS`. Never the genuine cause of a category failure. */
const CANCELLED_REASONS: ReadonlySet<string> = new Set([
  'Resource creation cancelled',
  'Resource update cancelled',
]);

/** `DELETE_*`/`ROLLBACK_*` events are teardown debris, not creation
 *  progress — they never mark a category FAILED and never regress one that
 *  already completed. */
function isDeletePhase(resourceStatus: string): boolean {
  return resourceStatus.startsWith('DELETE_') || resourceStatus.startsWith('ROLLBACK_');
}

function summarizeCategory(byResource: ReadonlyMap<string, StoredStackEvent[]>): CategoryProgress {
  let earliest: Date | null = null;
  let latestComplete: Date | null = null;
  let failed = false;
  let allComplete = true;
  let sawCreationStatus = false;

  for (const resourceEvents of byResource.values()) {
    for (const resourceEvent of resourceEvents) {
      if (!earliest || resourceEvent.eventAt < earliest) earliest = resourceEvent.eventAt;
    }

    // The resource's latest non-debris event — rollback/delete events on a
    // resource that already reached a creation verdict are ignored entirely.
    const creationEvents = resourceEvents.filter((resourceEvent) => !isDeletePhase(resourceEvent.resourceStatus));
    if (creationEvents.length === 0) continue;
    const latest = creationEvents.reduce((a, b) => (b.eventAt > a.eventAt ? b : a));
    sawCreationStatus = true;

    const isGenuineFailure =
      (latest.resourceStatus === 'CREATE_FAILED' || latest.resourceStatus === 'UPDATE_FAILED') &&
      !(latest.resourceStatusReason !== null && CANCELLED_REASONS.has(latest.resourceStatusReason.trim()));
    if (isGenuineFailure) failed = true;

    const isComplete = latest.resourceStatus === 'CREATE_COMPLETE' || latest.resourceStatus === 'UPDATE_COMPLETE';
    if (isComplete) {
      if (!latestComplete || latest.eventAt > latestComplete) latestComplete = latest.eventAt;
    } else {
      allComplete = false;
    }
  }

  const complete = !failed && allComplete && sawCreationStatus;
  const status: CategoryProgress['status'] = failed ? 'FAILED' : complete ? 'COMPLETE' : 'IN_PROGRESS';

  return {
    status,
    ...(earliest ? { startedAt: earliest.toISOString() } : {}),
    ...(complete && latestComplete ? { completedAt: latestComplete.toISOString() } : {}),
  };
}

// Returns the same shape readProvisioningSnapshot() consumes:
// { stackStatus, observedAt, categories: { [cat]: { status, startedAt?, completedAt? } } }
export function summarizeStackEvents(
  stackName: string,
  events: readonly StoredStackEvent[],
  observedAt: string,
): Record<string, unknown> | null {
  if (events.length === 0) return null;

  let stackStatus: string | null = null;
  let stackStatusAt: Date | null = null;
  const byCategory = new Map<ProvisioningCategory, Map<string, StoredStackEvent[]>>();

  for (const stackEvent of events) {
    if (stackEvent.resourceType === 'AWS::CloudFormation::Stack' && stackEvent.logicalResourceId === stackName) {
      if (!stackStatusAt || stackEvent.eventAt > stackStatusAt) {
        stackStatus = stackEvent.resourceStatus;
        stackStatusAt = stackEvent.eventAt;
      }
      continue;
    }

    const category = categorizeResourceType(stackEvent.resourceType);
    if (!category) continue;

    let byResource = byCategory.get(category);
    if (!byResource) {
      byResource = new Map();
      byCategory.set(category, byResource);
    }
    let resourceEvents = byResource.get(stackEvent.logicalResourceId);
    if (!resourceEvents) {
      resourceEvents = [];
      byResource.set(stackEvent.logicalResourceId, resourceEvents);
    }
    resourceEvents.push(stackEvent);
  }

  const categories: Record<string, CategoryProgress> = {};
  for (const [category, byResource] of byCategory) {
    categories[category] = summarizeCategory(byResource);
  }

  return {
    ...(stackStatus !== null ? { stackStatus } : {}),
    observedAt,
    categories,
  };
}
