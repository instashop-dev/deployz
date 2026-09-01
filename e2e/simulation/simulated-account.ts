/**
 * In-memory simulated customer AWS account.
 *
 * Implements the relay's own injectable client interfaces (`CloudFormationReader`
 * from verify.ts, `StackInstaller` from install.ts, `StackEventsReader` from
 * stack-events.ts, `EcsServiceReader`/`TargetHealthReader` from ecs-health.ts)
 * against a deterministic `ScenarioDefinition` timeline instead of the AWS
 * SDK — see docs/testing/discovery/phase1-design-decisions.md D1/D4.
 *
 * Two clocks are in play, both anchored the first time either is touched
 * (`ensureStarted`):
 *  - a REAL clock (`Date.now()`) that decides which timeline events are
 *    "revealed" yet, via each event's `afterMs`;
 *  - a VIRTUAL clock that decides what `Timestamp`/`operationStartedAt`
 *    values are reported, via each event's `atVirtualMs`. The virtual clock
 *    is anchored so the LAST event lands at (real) install-start time and
 *    every earlier event lands strictly before it — so every timestamp this
 *    account ever reports is at or before the collector's own
 *    `operationStartedAt` boundary, and never in the future relative to the
 *    API's clock that ultimately persists them.
 *
 * No AWS SDK types are imported — only the relay's own narrow seam
 * interfaces, imported from its subpath exports (`@deployz/relay/verify`,
 * `/install`, `/stack-events`, `/ecs-health`).
 */

import {
  INSTALLATION_TAG,
  type CreateStackInput,
  type CreateStackOutcome,
  type StackFailureEvent,
  type StackInstaller,
  type StackState,
} from '@deployz/relay/install';
import type { CloudFormationReader, StackLookup, StackResource } from '@deployz/relay/verify';
import type {
  StackEventRecord,
  StackEventsPage,
  StackEventsReader,
} from '@deployz/relay/stack-events';
import type { EcsServiceReader, TargetHealthReader } from '@deployz/relay/ecs-health';

import type { ScenarioDefinition, TimelineEvent } from './types.js';

const STACK_EVENT_RESOURCE_TYPE = 'AWS::CloudFormation::Stack';
const SUCCESS_STATUSES: ReadonlySet<string> = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE']);

function isStackLevel(event: TimelineEvent): boolean {
  return event.resourceType === STACK_EVENT_RESOURCE_TYPE;
}

/** Deterministic, realistic-looking physical ids — good enough for the
 *  relay code that parses an ECS service ARN's cluster segment out of one. */
function physicalIdFor(resourceType: string, logicalId: string, stackName: string): string {
  switch (resourceType) {
    case 'AWS::ECS::Service':
      return `arn:aws:ecs:us-east-1:123456789012:service/${stackName}-cluster/${stackName}-service`;
    case 'AWS::ElasticLoadBalancingV2::TargetGroup':
      return `arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/${stackName}-tg/0123456789abcdef`;
    case 'AWS::ElasticLoadBalancingV2::LoadBalancer':
      return `arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/${stackName}-alb/abcdef0123456789`;
    case 'AWS::RDS::DBInstance':
      return `${stackName}-database`;
    case 'AWS::S3::Bucket':
      return `${stackName}-storage-123456789012`;
    case 'AWS::ElastiCache::ReplicationGroup':
      return `${stackName}-redis`;
    default:
      return `${logicalId}-${stackName}`;
  }
}

export class SimulatedCustomerAccount {
  readonly scenario: ScenarioDefinition;
  private readonly indexedTimeline: ReadonlyArray<{ readonly event: TimelineEvent; readonly index: number }>;
  private readonly stackIdValue: string;
  private installStartRealMs: number | null = null;
  private stackNameValue: string | null = null;

  constructor(scenario: ScenarioDefinition) {
    this.scenario = scenario;
    this.indexedTimeline = scenario.timeline.map((event, index) => ({ event, index }));
    this.stackIdValue = `arn:aws:cloudformation:us-east-1:123456789012:stack/simulated-${crypto.randomUUID().slice(0, 8)}/${crypto.randomUUID()}`;
  }

  get stackName(): string | null {
    return this.stackNameValue;
  }

  // ── Clock ──────────────────────────────────────────────────────────────

  /** Anchors the simulated clock on first touch. Idempotent. */
  private ensureStarted(): number {
    if (this.installStartRealMs === null) this.installStartRealMs = Date.now();
    return this.installStartRealMs;
  }

  private totalVirtualDurationMs(): number {
    return this.scenario.timeline.reduce((max, event) => Math.max(max, event.atVirtualMs), 0);
  }

  private anchorMs(): number {
    return this.ensureStarted() - this.totalVirtualDurationMs();
  }

  /** ISO instant for the collector's `operationStartedAt` boundary — the
   *  earliest timestamp any event in this scenario can ever report. */
  operationStartedAtIso(): string {
    return new Date(this.anchorMs()).toISOString();
  }

  private eventTimestampIso(event: TimelineEvent): string {
    return new Date(this.anchorMs() + event.atVirtualMs).toISOString();
  }

  private elapsedRealMs(): number {
    if (this.installStartRealMs === null) return Number.NEGATIVE_INFINITY;
    return Date.now() - this.installStartRealMs;
  }

  private revealedIndexed(): ReadonlyArray<{ readonly event: TimelineEvent; readonly index: number }> {
    const elapsed = this.elapsedRealMs();
    return this.indexedTimeline.filter(({ event }) => elapsed >= event.afterMs);
  }

  private allRevealed(): boolean {
    return this.revealedIndexed().length === this.indexedTimeline.length;
  }

  // ── Derived state ──────────────────────────────────────────────────────

  private currentStackStatus(): string {
    if (this.allRevealed()) return this.scenario.finalStackStatus;
    const stackEvents = this.revealedIndexed().filter(({ event }) => isStackLevel(event));
    const latest = stackEvents[stackEvents.length - 1];
    return latest ? latest.event.status : 'CREATE_IN_PROGRESS';
  }

  private latestStackStatusReason(): string | undefined {
    const stackEvents = this.revealedIndexed().filter(({ event }) => isStackLevel(event));
    return stackEvents[stackEvents.length - 1]?.event.statusReason;
  }

  private currentResourceStates(): StackResource[] {
    const byResource = new Map<string, TimelineEvent>();
    for (const { event } of this.revealedIndexed()) {
      if (isStackLevel(event)) continue;
      byResource.set(event.logicalResourceId, event);
    }
    const stackName = this.stackNameValue;
    if (stackName === null) return [];
    return [...byResource.entries()].map(([logicalId, event]) => ({
      logicalId,
      type: event.resourceType,
      status: event.status,
      physicalId: physicalIdFor(event.resourceType, logicalId, stackName),
      timestamp: this.eventTimestampIso(event),
      ...(event.statusReason !== undefined ? { statusReason: event.statusReason } : {}),
    }));
  }

  // ── CreateStack (shared by the StackInstaller adapter) ────────────────

  private async createStack(input: CreateStackInput): Promise<CreateStackOutcome> {
    this.ensureStarted();
    if (this.stackNameValue !== null) {
      // Re-delivered/resumed INSTALL racing a create that already happened —
      // real CloudFormation answers this with AlreadyExistsException.
      return { created: false, alreadyExists: true };
    }
    this.stackNameValue = input.stackName;
    this.installationTag = input.tags[INSTALLATION_TAG] ?? '';
    return { created: true, stackId: this.stackIdValue };
  }

  // ── Adapters ───────────────────────────────────────────────────────────

  /** `CloudFormationReader` (verify.ts) — verification, provisioning
   *  snapshot, and resource-inventory paging all read through this. */
  cloudFormationReader(): CloudFormationReader {
    return {
      describeStack: async (stackName: string): Promise<StackLookup> => {
        if (this.stackNameValue === null || stackName !== this.stackNameValue) {
          return { found: false };
        }
        return {
          found: true,
          stack: {
            stackName: this.stackNameValue,
            status: this.currentStackStatus(),
            tags: { 'deployz:installation': this.installationTag },
            stackId: this.stackIdValue,
          },
        };
      },
      describeStackResources: async (stackName: string): Promise<StackResource[]> => {
        if (this.stackNameValue === null || stackName !== this.stackNameValue) return [];
        return this.currentResourceStates();
      },
      listStackResources: async (stackName: string) => {
        if (this.stackNameValue === null || stackName !== this.stackNameValue) return null;
        return { resources: this.currentResourceStates() };
      },
    };
  }

  /** `StackInstaller` (install.ts) — the INSTALL executor's write+watch seam. */
  stackInstaller(): StackInstaller {
    return {
      createStack: (input: CreateStackInput) => this.createStack(input),
      describeStack: async (stackName: string): Promise<StackState | null> => {
        if (this.stackNameValue === null || stackName !== this.stackNameValue) return null;
        const status = this.currentStackStatus();
        const outputs = SUCCESS_STATUSES.has(status) ? { ...(this.scenario.outputs ?? {}) } : {};
        const statusReason = this.latestStackStatusReason();
        return {
          status,
          outputs,
          ...(statusReason !== undefined ? { statusReason } : {}),
        };
      },
      describeStackEvents: async (stackName: string): Promise<StackFailureEvent[]> => {
        if (this.stackNameValue === null || stackName !== this.stackNameValue) return [];
        return this.revealedIndexed()
          .filter(({ event }) => !isStackLevel(event) && event.status === 'CREATE_FAILED' && event.statusReason !== undefined)
          .map(({ event }) => ({
            logicalResourceId: event.logicalResourceId,
            resourceType: event.resourceType,
            resourceStatusReason: event.statusReason!,
            timestamp: this.eventTimestampIso(event),
          }));
      },
    };
  }

  /** `StackEventsReader` (stack-events.ts) — feeds the progress collector
   *  that reports batches to `POST /api/relay/commands/:id/progress`. */
  stackEventsReader(): StackEventsReader {
    return {
      describeStackEventsPage: async (stackName: string): Promise<StackEventsPage | null> => {
        if (this.stackNameValue === null || stackName !== this.stackNameValue) return { events: [] };
        const records: StackEventRecord[] = this.revealedIndexed().map(({ event, index }) => ({
          eventId: `evt-${index}`,
          timestamp: this.eventTimestampIso(event),
          logicalResourceId: isStackLevel(event) ? this.stackNameValue! : event.logicalResourceId,
          resourceType: event.resourceType,
          resourceStatus: event.status,
          ...(event.statusReason !== undefined ? { resourceStatusReason: event.statusReason } : {}),
        }));
        // AWS returns newest-first.
        records.reverse();
        return { events: records };
      },
    };
  }

  /** `EcsServiceReader` (ecs-health.ts) — scenario-controlled rollout state. */
  ecsServiceReader(): EcsServiceReader {
    return {
      describeServices: async () => {
        const behavior = this.scenario.ecsBehavior ?? { kind: 'healthy', desiredCount: 1, runningCount: 1 };
        if (behavior.kind === 'rollout-failed') {
          return {
            services: [
              {
                desiredCount: behavior.desiredCount,
                runningCount: behavior.runningCount,
                deployments: [{ status: 'PRIMARY', rolloutState: 'FAILED' }],
              },
            ],
          };
        }
        return {
          services: [
            {
              desiredCount: behavior.desiredCount,
              runningCount: behavior.runningCount,
              deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED' }],
            },
          ],
        };
      },
    };
  }

  /** `TargetHealthReader` (ecs-health.ts) — scenario-controlled ALB targets. */
  targetHealthReader(): TargetHealthReader {
    return {
      describeTargetHealth: async () => {
        const behavior = this.scenario.ecsBehavior;
        if (behavior?.kind === 'unhealthy-targets') {
          return {
            targets: Array.from({ length: behavior.targetCount }, (_, i) => ({
              state: i < behavior.unhealthyTargetCount ? 'unhealthy' : 'healthy',
            })),
          };
        }
        if (behavior?.kind === 'healthy' && behavior.runningCount > 0) {
          return { targets: Array.from({ length: behavior.runningCount }, () => ({ state: 'healthy' })) };
        }
        return { targets: [] };
      },
    };
  }

  /** The `deployz:installation` tag value `CreateStack` was actually called
   *  with — captured in `createStack`, echoed back by `describeStack` for
   *  `verifyInstallation`'s `stack-tagged` check, exactly like real
   *  CloudFormation echoing back whatever tags it was given. */
  private installationTag = '';
}
