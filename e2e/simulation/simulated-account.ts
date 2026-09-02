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
import type { EcsDeployClient, EcsTaskDefinition, RegisterTaskDefinitionInput } from '@deployz/relay/deploy';
import type { EcsTaskReader } from '@deployz/relay/ecs-observe';
import type { StackDeleter } from '@deployz/relay/destroy';

import type { ScenarioDefinition, TimelineEvent, UpdateRolloutOutcome } from './types.js';

const STACK_EVENT_RESOURCE_TYPE = 'AWS::CloudFormation::Stack';
const SUCCESS_STATUSES: ReadonlySet<string> = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE']);

/**
 * Mirrors apps/api/src/server.ts's BUILD_FIXTURE_MODE fixture image
 * repository — every fixture release digest is minted under this same
 * repository (see `fixtureImageDigest` there), so the account's bootstrap
 * task definition below already references it, exactly like a real service
 * already running an earlier image from the same ECR repository before its
 * first Deployz-driven deploy.
 */
const FIXTURE_IMAGE_REPOSITORY = '123456789012.dkr.ecr.us-east-1.amazonaws.com/deployz-fixture';
const BOOTSTRAP_IMAGE_DIGEST = `sha256:${'0'.repeat(64)}`;

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

  // ── Deploy/rollback state (D2) ─────────────────────────────────────────
  private ecsDeployInitialized = false;
  private readonly taskDefinitions = new Map<string, EcsTaskDefinition>();
  private currentTaskDefinitionArn = '';
  private taskDefinitionRevision = 1;
  private runningImageDigest: string | null = null;
  /** The one-off migration task, when a deploy started one (Phase 4 stage). */
  private migrationTaskArn: string | null = null;
  // One-shot: consumed (and reset) the first time `ecsDeployClient()`'s own
  // `describeServices` reads it as 'failed' — this is what settleEcsDeploy's
  // `rolloutFailed()` gate checks BEFORE issuing a new UpdateService, so a
  // LATER, unrelated deploy/rollback must not see a stale failure it did not
  // cause (see `ecsDeployClient`'s doc comment).
  private jobRolloutState: 'stable' | 'failed' = 'stable';
  // NOT one-shot: reflects the outcome of the most recently COMPLETED
  // UpdateService call, read by `ecsServiceReader()`/the runtime-health
  // heartbeat for as long as it stays true. Identity consistency: without
  // this, the heartbeat kept reporting the scenario's static `ecsBehavior`
  // ('healthy') even while a deploy had just failed, and server.ts's
  // self-healing rule (a HEALTHY heartbeat recovers a FAILED deployment)
  // raced the failure back to HEALTHY before a test could ever observe it.
  private healthRolloutFailed = false;
  private updateServiceCallIndex = 0;
  private readonly desiredCount = 2;
  private readonly runningCount = 2;

  // ── Destroy state (D2) ──────────────────────────────────────────────────
  private deleteStartRealMs: number | null = null;

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
        if (this.deleteStartRealMs !== null) return this.describeStackDuringDestroy();
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
        if (
          this.deleteStartRealMs !== null &&
          this.destroyAllRevealed() &&
          this.scenario.destroy?.outcome === 'delete-failed'
        ) {
          // Only the resources CloudFormation itself reports DELETE_FAILED
          // for — `settleDestroy` filters exactly this status to find its
          // blockers. Empty (the scenario default) means no blocker is
          // identifiable, matching its honest permanent-failure branch.
          return (this.scenario.destroy.blockedResources ?? []).map((resource) => ({
            logicalId: resource.logicalId,
            type: resource.resourceType,
            status: 'DELETE_FAILED',
            physicalId: physicalIdFor(resource.resourceType, resource.logicalId, this.stackNameValue!),
            statusReason: resource.reason,
          }));
        }
        return this.currentResourceStates();
      },
      listStackResources: async (stackName: string) => {
        if (this.stackNameValue === null || stackName !== this.stackNameValue) return null;
        return { resources: this.currentResourceStates() };
      },
    };
  }

  /**
   * `describeStack` once a DESTROY has been requested (`stackDeleter()`'s
   * `deleteStack` was called at least once). Reveals the scenario's
   * `destroy.timeline` on the same real/virtual two-clock scheme as the
   * install timeline, anchored to when the delete was first requested —
   * see `DestroyScenario` in ./types.ts.
   */
  private describeStackDuringDestroy(): StackLookup {
    const destroy = this.scenario.destroy;
    if (!destroy || !this.destroyAllRevealed()) {
      // No destroy scenario configured (deleteStack called anyway — should
      // not happen in a lifecycle scenario) defaults to an immediate, clean
      // delete. A configured scenario still mid-timeline reports the stack
      // as deleting, same as real CloudFormation between CreateStack's
      // terminal state and DeleteStack's.
      if (!destroy) return { found: false };
      return {
        found: true,
        stack: {
          stackName: this.stackNameValue!,
          status: 'DELETE_IN_PROGRESS',
          tags: { 'deployz:installation': this.installationTag },
          stackId: this.stackIdValue,
        },
      };
    }
    if (destroy.outcome === 'complete') return { found: false };
    return {
      found: true,
      stack: {
        stackName: this.stackNameValue!,
        status: 'DELETE_FAILED',
        tags: { 'deployz:installation': this.installationTag },
        stackId: this.stackIdValue,
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
   *  that reports batches to `POST /api/relay/commands/:id/progress`, for
   *  both the INSTALL and the DESTROY collector (see `describeStackEventsPage`
   *  below for the DESTROY branch). */
  stackEventsReader(): StackEventsReader {
    return {
      describeStackEventsPage: async (stackName: string): Promise<StackEventsPage | null> => {
        if (this.stackNameValue === null || stackName !== this.stackNameValue) return { events: [] };
        if (this.deleteStartRealMs !== null) {
          // A DESTROY collector's own `operationStartedAt` boundary is
          // anchored at/after `destroyAnchorMs()`, strictly after every
          // create-timeline event's timestamp, so returning only the destroy
          // timeline here (rather than merging with the create one) produces
          // the same collected result the boundary filter would anyway.
          const records: StackEventRecord[] = this.destroyRevealedIndexed().map(({ event, index }) => ({
            eventId: `destroy-evt-${index}`,
            timestamp: this.destroyEventTimestampIso(event),
            logicalResourceId: isStackLevel(event) ? this.stackNameValue! : event.logicalResourceId,
            resourceType: event.resourceType,
            resourceStatus: event.status,
            ...(event.statusReason !== undefined ? { resourceStatusReason: event.statusReason } : {}),
          }));
          records.reverse();
          return { events: records };
        }
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

  /** `EcsServiceReader` (ecs-health.ts) — scenario-controlled rollout state,
   *  feeding the §59 runtime-health heartbeat. Once a DEPLOY_RELEASE/ROLLBACK
   *  has actually run (`ecsDeployInitialized`), this reads `healthRolloutFailed`
   *  instead of the static `ecsBehavior` knob — identity consistency with
   *  `ecsDeployClient`'s own view of the service, and what keeps a genuinely
   *  failed rollout from self-healing back to HEALTHY on the next heartbeat
   *  (server.ts's `stateRecovered` rule). Before any deploy has run, this is
   *  unchanged from Phase 1: purely `ecsBehavior`-driven. */
  ecsServiceReader(): EcsServiceReader {
    return {
      describeServices: async () => {
        if (this.ecsDeployInitialized) {
          return {
            services: [
              {
                desiredCount: this.desiredCount,
                runningCount: this.healthRolloutFailed ? 0 : this.runningCount,
                deployments: [
                  { status: 'PRIMARY', rolloutState: this.healthRolloutFailed ? 'FAILED' : 'COMPLETED' },
                ],
              },
            ],
          };
        }
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

  // ── Deploy/rollback (D2) ─────────────────────────────────────────────────

  private ensureEcsDeployInitialized(): void {
    if (this.ecsDeployInitialized) return;
    this.ecsDeployInitialized = true;
    const family = `${this.stackNameValue ?? 'simulated-app'}-app`;
    const arn = `arn:aws:ecs:us-east-1:123456789012:task-definition/${family}:1`;
    this.currentTaskDefinitionArn = arn;
    this.taskDefinitions.set(arn, {
      family,
      cpu: '256',
      memory: '512',
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      containerDefinitions: [{ name: 'app', image: `${FIXTURE_IMAGE_REPOSITORY}@${BOOTSTRAP_IMAGE_DIGEST}` }],
    });
  }

  private nextUpdateRolloutOutcome(): UpdateRolloutOutcome {
    const outcomes = this.scenario.updateRollouts ?? [];
    const outcome = outcomes[this.updateServiceCallIndex] ?? 'succeed';
    this.updateServiceCallIndex += 1;
    return outcome;
  }

  private async listSimulatedTasks(): Promise<{ taskArns: string[] }> {
    return {
      taskArns:
        this.runningImageDigest !== null
          ? ['arn:aws:ecs:us-east-1:123456789012:task/simulated/task-1']
          : [],
    };
  }

  private async describeSimulatedTasks(): Promise<{
    tasks: {
      lastStatus?: string;
      stopCode?: string;
      containers?: { imageDigest?: string; exitCode?: number }[];
    }[];
  }> {
    // The one-off migration task answers STOPPED + exit 0 immediately, so a
    // scenario that carries a migration command resolves the migration stage
    // the same way the rollout resolves: on the next poll.
    return {
      tasks: [
        ...(this.migrationTaskArn !== null
          ? [
              {
                lastStatus: 'STOPPED',
                stopCode: 'EssentialContainerExited',
                containers: [{ exitCode: 0 }],
              },
            ]
          : []),
        ...(this.runningImageDigest !== null
          ? [{ containers: [{ imageDigest: this.runningImageDigest }] }]
          : []),
      ],
    };
  }

  /**
   * `EcsDeployClient` (deploy.ts) — the DEPLOY_RELEASE/ROLLBACK write seam.
   * A simplified but behaviourally faithful single-service ECS: one task
   * definition family, `updateService` resolves instantly per the scenario's
   * `updateRollouts` knob rather than modelling a real rollout's duration.
   *
   * `rolloutState` is one-shot: `describeServices` reports 'FAILED' exactly
   * once, then resets to stable — mirroring how a finished ECS deployment
   * (successful or not) drops out of the service's active `deployments` list
   * once observed, so a LATER, unrelated deploy/rollback attempt is never
   * blocked by a stale failure it did not cause.
   */
  ecsDeployClient(): EcsDeployClient {
    return {
      describeServices: async () => {
        this.ensureEcsDeployInitialized();
        const failed = this.jobRolloutState === 'failed';
        if (failed) this.jobRolloutState = 'stable';
        return {
          services: [
            {
              desiredCount: this.desiredCount,
              runningCount: this.runningCount,
              taskDefinition: this.currentTaskDefinitionArn,
              deployments: [{ status: 'PRIMARY', rolloutState: failed ? 'FAILED' : 'COMPLETED' }],
              networkConfiguration: {
                awsvpcConfiguration: {
                  subnets: ['subnet-11111aaa'],
                  securityGroups: ['sg-22222bbb'],
                  assignPublicIp: 'DISABLED',
                },
              },
            },
          ],
        };
      },
      describeTaskDefinition: async ({ taskDefinition }) => {
        this.ensureEcsDeployInitialized();
        const found =
          this.taskDefinitions.get(taskDefinition) ?? this.taskDefinitions.get(this.currentTaskDefinitionArn)!;
        return {
          taskDefinition: { ...found, containerDefinitions: found.containerDefinitions.map((c) => ({ ...c })) },
        };
      },
      registerTaskDefinition: async (input: RegisterTaskDefinitionInput) => {
        this.ensureEcsDeployInitialized();
        this.taskDefinitionRevision += 1;
        const family = input.family ?? `${this.stackNameValue ?? 'simulated-app'}-app`;
        const arn = `arn:aws:ecs:us-east-1:123456789012:task-definition/${family}:${this.taskDefinitionRevision}`;
        this.taskDefinitions.set(arn, {
          family: input.family,
          cpu: input.cpu,
          memory: input.memory,
          networkMode: input.networkMode,
          requiresCompatibilities: input.requiresCompatibilities,
          executionRoleArn: input.executionRoleArn,
          taskRoleArn: input.taskRoleArn,
          containerDefinitions: input.containerDefinitions as unknown as EcsTaskDefinition['containerDefinitions'],
          ...(input.volumes ? { volumes: input.volumes } : {}),
        });
        return { taskDefinitionArn: arn };
      },
      updateService: async (input) => {
        this.ensureEcsDeployInitialized();
        const outcome = this.nextUpdateRolloutOutcome();
        if (input.taskDefinition !== undefined) this.currentTaskDefinitionArn = input.taskDefinition;
        if (outcome === 'fail') {
          // Circuit breaker aborts the rollout — what is actually running is
          // left unresolved (no task cleanly answers for a digest) rather
          // than pinned back to the old one. This matters for a LATER
          // deploy/rollback that targets the same digest the service was
          // already running before this failure: settleEcsDeploy's own
          // idempotent "already running" short-circuit compares against
          // `observeRunningDigest`, and a resolved-but-stale answer would
          // let that later attempt report success without ever calling
          // UpdateService — silently skipping the very rollout a
          // rollback-also-fails scenario needs to exercise.
          this.runningImageDigest = null;
          this.jobRolloutState = 'failed';
          this.healthRolloutFailed = true;
          return;
        }
        this.jobRolloutState = 'stable';
        this.healthRolloutFailed = false;
        const definition = this.taskDefinitions.get(this.currentTaskDefinitionArn);
        const image = definition?.containerDefinitions.find((c) => typeof c.image === 'string')?.image;
        const at = image?.lastIndexOf('@') ?? -1;
        if (image !== undefined && at > 0) this.runningImageDigest = image.slice(at + 1);
      },
      listTasks: () => this.listSimulatedTasks(),
      describeTasks: () => this.describeSimulatedTasks(),
      runTask: async () => {
        this.ensureEcsDeployInitialized();
        // Simulated migrations succeed instantly: the task answers STOPPED
        // with exit code 0 on the next poll (see describeSimulatedTasks).
        this.migrationTaskArn = 'arn:aws:ecs:us-east-1:123456789012:task/simulated/migration-1';
        return { taskArns: [this.migrationTaskArn] };
      },
    };
  }

  /** `EcsTaskReader` (ecs-observe.ts) — the §59 heartbeat's running-digest
   *  observation, sharing the exact same running-task state `ecsDeployClient`
   *  writes, so a heartbeat taken right after a deploy/rollback settles
   *  always agrees with what that deploy just did (identity consistency). */
  ecsTaskReader(): EcsTaskReader {
    return {
      listTasks: () => this.listSimulatedTasks(),
      describeTasks: () => this.describeSimulatedTasks(),
    };
  }

  // ── Destroy (D2) ─────────────────────────────────────────────────────────

  private ensureDestroyStarted(): number {
    if (this.deleteStartRealMs === null) this.deleteStartRealMs = Date.now();
    return this.deleteStartRealMs;
  }

  private destroyTimeline(): readonly TimelineEvent[] {
    return this.scenario.destroy?.timeline ?? [];
  }

  private destroyTotalVirtualDurationMs(): number {
    return this.destroyTimeline().reduce((max, event) => Math.max(max, event.atVirtualMs), 0);
  }

  private destroyAnchorMs(): number {
    return (this.deleteStartRealMs ?? Date.now()) - this.destroyTotalVirtualDurationMs();
  }

  private destroyEventTimestampIso(event: TimelineEvent): string {
    return new Date(this.destroyAnchorMs() + event.atVirtualMs).toISOString();
  }

  /** ISO instant for the DESTROY collector's `operationStartedAt` boundary. */
  destroyStartedAtIso(): string {
    this.ensureDestroyStarted();
    return new Date(this.destroyAnchorMs()).toISOString();
  }

  private destroyElapsedRealMs(): number {
    if (this.deleteStartRealMs === null) return Number.NEGATIVE_INFINITY;
    return Date.now() - this.deleteStartRealMs;
  }

  private destroyRevealedIndexed(): ReadonlyArray<{ readonly event: TimelineEvent; readonly index: number }> {
    const elapsed = this.destroyElapsedRealMs();
    return this.destroyTimeline()
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => elapsed >= event.afterMs);
  }

  private destroyAllRevealed(): boolean {
    return this.destroyRevealedIndexed().length === this.destroyTimeline().length;
  }

  /** `StackDeleter` (destroy.ts) — the DESTROY write seam. Only records that
   *  deletion was requested and anchors the destroy timeline's clock;
   *  `describeStack`/`describeStackResources` above report the scenario's
   *  configured outcome once that timeline fully reveals. Idempotent — a
   *  retried/resumed DeleteStack call does not re-anchor the clock. */
  stackDeleter(): StackDeleter {
    return {
      deleteStack: async () => {
        this.ensureDestroyStarted();
      },
    };
  }

  /** The `deployz:installation` tag value `CreateStack` was actually called
   *  with — captured in `createStack`, echoed back by `describeStack` for
   *  `verifyInstallation`'s `stack-tagged` check, exactly like real
   *  CloudFormation echoing back whatever tags it was given. */
  private installationTag = '';
}
