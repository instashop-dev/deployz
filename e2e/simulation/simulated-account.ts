/**
 * In-memory simulated customer AWS account.
 *
 * Implements the relay's own injectable client interfaces (`CloudFormationReader`
 * from verify.ts, `StackInstaller` from install.ts, `StackEventsReader` from
 * stack-events.ts, `EcsServiceReader`/`TargetHealthReader` from ecs-health.ts)
 * against a deterministic `ScenarioDefinition` timeline instead of the AWS
 * SDK — see docs/testing/simulated-e2e.md D1/D4.
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

import { DEPLOYZ_INSTALLATION_TAG, deployzTaskFamily, workloadContainerCommand } from '@deployz/contracts';
import {
  type CreateStackInput,
  type CreateStackOutcome,
  type StackDescribeOutcome,
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
import type { StackDeleter, EcsStandaloneTaskStopper } from '@deployz/relay/destroy';

import type { ScenarioDefinition, TimelineEvent, UpdateRolloutOutcome } from './types.js';

const STACK_EVENT_RESOURCE_TYPE = 'AWS::CloudFormation::Stack';
const SUCCESS_STATUSES: ReadonlySet<string> = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE']);

/** One ECS service's simulated deploy/health state (one per workload). */
interface ServiceDeployState {
  readonly logicalId: string;
  readonly arn: string;
  readonly family: string;
  taskDefinitionArn: string;
  runningDigest: string | null;
  /** 0 until a deploy (or UpdateService) first sets the service's count. */
  desiredCount: number;
  /** One-shot: consumed by the deploy client's describeServices read. */
  jobRolloutFailed: boolean;
  /** Sticky: read by the runtime-health heartbeat until the next update. */
  healthRolloutFailed: boolean;
  running: boolean;
}

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
const RDS_CA_INIT_IMAGE = 'public.ecr.aws/amazonlinux/amazonlinux:2023-minimal';
/** The migration family and the frozen command the fixtures' seeded `npm run db:migrate` compiles to. */
const MIGRATION_FAMILY = deployzTaskFamily('migration');
const FROZEN_MIGRATION_COMMAND = workloadContainerCommand('npm run db:migrate');
const MIGRATION_TASK_LOGICAL_ID = 'MigrationTaskDefinition';

function isStackLevel(event: TimelineEvent): boolean {
  return event.resourceType === STACK_EVENT_RESOURCE_TYPE;
}

/** Deterministic, realistic-looking physical ids — good enough for the
 *  relay code that parses an ECS service ARN's cluster segment out of one.
 *  Each ECS service's ARN carries its OWN logical id, so a multi-workload
 *  stack (one service per workload) yields one ARN per service. */
function physicalIdFor(resourceType: string, logicalId: string, stackName: string): string {
  switch (resourceType) {
    case 'AWS::ECS::Service':
      return `arn:aws:ecs:us-east-1:123456789012:service/${stackName}-cluster/${logicalId}`;
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
  /**
   * Family → its latest ACTIVE revision's ARN (Phase 5). Kept alongside
   * `taskDefinitions` so `describeTaskDefinition` can resolve a BARE family
   * name (what `registerReleaseImageIntoFamily` in deploy.ts always passes —
   * the migration family, and every scheduled-job family) to the same
   * revision `registerTaskDefinition` most recently registered under it,
   * exactly like real ECS's "describe a family with no revision suffix"
   * behaviour.
   */
  private readonly taskDefinitionsByFamily = new Map<string, string>();
  /** Family → the revision the stack itself created (its CloudFormation physical id). */
  private readonly stackTaskDefinitionByFamily = new Map<string, string>();
  /**
   * One deploy/health state per ECS service (Phase 4A: one service per
   * workload), keyed by the service's ARN. Created lazily the first time a
   * service's stack resource is revealed.
   */
  private readonly serviceStates = new Map<string, ServiceDeployState>();
  private taskDefinitionRevision = 1;
  /** Which service each listed task ARN belongs to (for DescribeTasks). */
  private readonly taskServiceByArn = new Map<string, string>();
  private migrationTaskArn: string | null = null;
  /** The exact revision the migration RunTask resolved to — what ECS reports the task ran. */
  private migrationTaskDefinitionArn: string | null = null;
  /** How many one-off migration tasks the relay's deploy stage has started. */
  migrationRuns = 0;
  /**
   * Phase 5: standalone (non-service) tasks in the stack's cluster — a
   * scheduled job or migration run outside a service's own rollout. Test
   * control only: nothing in the compiled stack ever RunTask's a scheduled
   * job here (`AWS::Scheduler::Schedule` is never itself simulated), so a
   * scenario/spec seeds this directly with `runStandaloneTask`/
   * `stopStandaloneTask` to exercise the DESTROY stop-before-delete
   * path and the "a scheduled-job failure never touches deployment health"
   * proof.
   */
  private readonly standaloneTasks = new Map<
    string,
    { readonly arn: string; readonly family: string; running: boolean }
  >();
  private standaloneTaskCounter = 0;
  /** Task ARNs `ecsStandaloneTaskStopper().stopTask` actually stopped — the
   *  DESTROY assertion evidence. */
  readonly stoppedStandaloneTaskArns: string[] = [];
  /**
   * Phase 4C ordering evidence: every migration RunTask and every service
   * UpdateService appends here in order, so a scenario can assert the
   * migration ran BEFORE any service rolled (and only once).
   */
  readonly operationLog: string[] = [];
  /** How many RESTART forceNewDeployment calls reached the account. */
  restarts = 0;
  /** Every `CreateStack` call the relay's installer adapter received —
   *  counted at the top of `createStack` so even an `AlreadyExists` answer
   *  counts. The stale-install-resurrect regression asserts this never
   *  increases after a teardown. */
  createStackCalls = 0;
  private updateServiceCallIndex = 0;

  // ── Phase 14 observability ───────────────────────────────────────────────
  // (migrationRuns above)

  // ── Destroy state (D2) ──────────────────────────────────────────────────
  private deleteStartRealMs: number | null = null;
  /** Logical ids carried by a `deleteStack(stackName, retainResources)` call
   *  — the relay's data-preserving DELETE_FAILED recovery (destroy.ts). Once
   *  recorded, the modelled delete COMPLETES (the stack record goes away,
   *  like real DELETE_COMPLETE) while exactly those resources stay behind
   *  with their data. A plain retry without `retainResources` never clears
   *  the DELETE_FAILED state, mirroring how CloudFormation refuses to delete
   *  the pinned resources again. */
  private retainedLogicalIds: readonly string[] | null = null;

  // ── Transient-fault injection ──────────────────────────────────────────
  private transientDescribeRemaining: number;

  constructor(scenario: ScenarioDefinition) {
    this.scenario = scenario;
    this.indexedTimeline = scenario.timeline.map((event, index) => ({ event, index }));
    this.stackIdValue = `arn:aws:cloudformation:us-east-1:123456789012:stack/simulated-${crypto.randomUUID().slice(0, 8)}/${crypto.randomUUID()}`;
    this.transientDescribeRemaining = scenario.transientDescribeFailures ?? 0;
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
    // The compiled stack carries the migration task definition whenever the
    // app has a migration command, and the fixtures configure one for every
    // database app: it is complete by the time any ECS service is.
    const serviceComplete = [...byResource.values()].some(
      (event) => event.resourceType === 'AWS::ECS::Service' && SUCCESS_STATUSES.has(event.status),
    );
    if (serviceComplete && this.scenario.postgres !== false && !byResource.has(MIGRATION_TASK_LOGICAL_ID)) {
      byResource.set(MIGRATION_TASK_LOGICAL_ID, {
        afterMs: 0,
        atVirtualMs: 0,
        logicalResourceId: MIGRATION_TASK_LOGICAL_ID,
        resourceType: 'AWS::ECS::TaskDefinition',
        status: 'CREATE_COMPLETE',
      });
    }
    return [...byResource.entries()].map(([logicalId, event]) => ({
      logicalId,
      type: event.resourceType,
      status: event.status,
      // A task definition's physical id is the exact revision the stack created.
      physicalId:
        event.resourceType === 'AWS::ECS::TaskDefinition'
          ? this.stackTaskDefinitionArn(logicalId)
          : physicalIdFor(event.resourceType, logicalId, stackName),
      timestamp: this.eventTimestampIso(event),
      ...(event.statusReason !== undefined ? { statusReason: event.statusReason } : {}),
    }));
  }

  // ── CreateStack (shared by the StackInstaller adapter) ────────────────

  private async createStack(input: CreateStackInput): Promise<CreateStackOutcome> {
    this.createStackCalls += 1;
    this.ensureStarted();
    if (this.stackNameValue !== null) {
      // After a recovery delete (deleteStartRealMs set, no destroy scenario),
      // allow re-creation — the previous stack was intentionally destroyed so
      // the retry INSTALL can create a fresh one.
      if (this.deleteStartRealMs !== null && !this.scenario.destroy) {
        this.stackNameValue = input.stackName;
        this.installationTag = input.tags[DEPLOYZ_INSTALLATION_TAG] ?? '';
        this.deleteStartRealMs = null;
        return { created: true, stackId: this.stackIdValue };
      }
      // Re-delivered/resumed INSTALL racing a create that already happened —
      // real CloudFormation answers this with AlreadyExistsException.
      return { created: false, alreadyExists: true };
    }
    this.stackNameValue = input.stackName;
    this.installationTag = input.tags[DEPLOYZ_INSTALLATION_TAG] ?? '';
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
    // The retain-retry arrived: the data-preserving recovery completed the
    // deletion while leaving the named blockers (the retained database and
    // what its ENI pins) in the account — DELETE_COMPLETE, not DELETE_FAILED.
    if (this.retainedLogicalIds !== null) return { found: false };
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
        // After a recovery delete (deleteStartRealMs set without a destroy
        // scenario), report the stack as gone so the retry INSTALL creates a
        // fresh one through `installApplicationStack`'s create-branch.
        if (this.deleteStartRealMs !== null) return null;
        // Transient fault: the real relay client maps a throttled/timed-out
        // describe to `null` (unreadable) — the wait loop must ride these
        // out, not fail a live install.
        if (this.transientDescribeRemaining > 0) {
          this.transientDescribeRemaining -= 1;
          return null;
        }
        const status = this.currentStackStatus();
        const outputs = SUCCESS_STATUSES.has(status) ? { ...(this.scenario.outputs ?? {}) } : {};
        const statusReason = this.latestStackStatusReason();
        return {
          status,
          outputs,
          ...(statusReason !== undefined ? { statusReason } : {}),
        };
      },
      describeStackOutcome: async (stackName: string): Promise<StackDescribeOutcome> => {
        if (this.stackNameValue === null || stackName !== this.stackNameValue) {
          return { found: false, absent: true };
        }
        if (this.deleteStartRealMs !== null) return { found: false, absent: true };
        if (this.transientDescribeRemaining > 0) {
          this.transientDescribeRemaining -= 1;
          return { found: false, absent: false, errorCode: 'Throttling' };
        }
        const status = this.currentStackStatus();
        const outputs = SUCCESS_STATUSES.has(status) ? { ...(this.scenario.outputs ?? {}) } : {};
        const statusReason = this.latestStackStatusReason();
        return {
          found: true,
          stack: {
            status,
            outputs,
            ...(statusReason !== undefined ? { statusReason } : {}),
          },
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
   *  feeding the §59 runtime-health heartbeat, per ECS service. Once a
   *  DEPLOY_RELEASE/ROLLBACK has actually run (`ecsDeployInitialized`), each
   *  service reports its OWN state — identity consistency with
   *  `ecsDeployClient`'s view, and what keeps a genuinely failed rollout from
   *  self-healing back to HEALTHY on the next heartbeat (server.ts's
   *  `stateRecovered` rule). Before any deploy has run, this is
   *  `ecsBehavior`-driven. */
  ecsServiceReader(): EcsServiceReader {
    return {
      describeServices: async (input) => {
        if (this.ecsDeployInitialized) {
          this.ensureEcsDeployInitialized();
          return {
            services: input.services.map((arn) => {
              const state = this.serviceStates.get(arn);
              if (state === undefined) return {};
              return {
                desiredCount: state.desiredCount,
                runningCount: state.running && !state.healthRolloutFailed ? state.desiredCount : 0,
                deployments: [
                  { status: 'PRIMARY', rolloutState: state.healthRolloutFailed ? 'FAILED' : 'COMPLETED' },
                ],
              };
            }),
          };
        }
        const behavior = this.scenario.ecsBehavior ?? { kind: 'healthy', desiredCount: 1, runningCount: 1 };
        const rolloutState = behavior.kind === 'rollout-failed' ? 'FAILED' : 'COMPLETED';
        const described = input.services.length > 0 ? input.services : ['simulated'];
        return {
          services: described.map(() => ({
            desiredCount: behavior.desiredCount,
            runningCount: behavior.runningCount,
            deployments: [{ status: 'PRIMARY', rolloutState }],
          })),
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

  /** `DeployzApp<pascal(componentId)>` — the compiler's task-def family shape
   *  (WebService → DeployzAppWeb, EmailWorkerService → DeployzAppEmailWorker). */
  private familyForLogicalId(logicalId: string): string {
    const component = logicalId.replace(/Service$/, '');
    const pascal = component
      .split(/[^A-Za-z0-9]+/)
      .filter((word) => word.length > 0)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join('');
    return `DeployzApp${pascal}`;
  }

  /** The stack's ECS services in resource order — web first (compile order). */
  private ecsServiceViews(): { logicalId: string; arn: string }[] {
    const stackName = this.stackNameValue;
    if (stackName === null) return [];
    return this.currentResourceStates()
      .filter((resource) => resource.type === 'AWS::ECS::Service' && resource.physicalId !== undefined)
      .map((resource) => ({ logicalId: resource.logicalId, arn: resource.physicalId! }));
  }

  /**
   * Resolves a bare task-definition family to its latest ACTIVE revision's
   * ARN, lazily registering a bootstrap revision (the fixture image, exactly
   * like a service's own pre-first-deploy definition) the first time a
   * never-before-seen family is described — mirrors CloudFormation having
   * already registered the migration/scheduled-job task definition at
   * INSTALL time with the template's bootstrap `paramImageReference`.
   */
  private ensureTaskFamily(family: string): string {
    const existing = this.taskDefinitionsByFamily.get(family);
    if (existing !== undefined) return existing;
    this.taskDefinitionRevision += 1;
    const arn = `arn:aws:ecs:us-east-1:123456789012:task-definition/${family}:${this.taskDefinitionRevision}`;
    this.taskDefinitions.set(arn, {
      family,
      cpu: '256',
      memory: '512',
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      // The compiler's container shape: the essential application container
      // (the migration family carries its frozen command), then the
      // non-essential RDS CA init container.
      containerDefinitions: [
        {
          name: 'App',
          image: `${FIXTURE_IMAGE_REPOSITORY}@${BOOTSTRAP_IMAGE_DIGEST}`,
          essential: true,
          ...(family === MIGRATION_FAMILY ? { command: [...FROZEN_MIGRATION_COMMAND] } : {}),
        },
        { name: 'RdsCaBundle', image: RDS_CA_INIT_IMAGE, essential: false },
      ],
    });
    this.taskDefinitionsByFamily.set(family, arn);
    this.stackTaskDefinitionByFamily.set(family, arn);
    return arn;
  }

  /** The revision the stack created for a task-definition logical id (`MigrationTaskDefinition` → `DeployzAppMigration`). */
  private stackTaskDefinitionArn(logicalId: string): string {
    const family = this.familyForLogicalId(logicalId.replace(/TaskDefinition$/, ''));
    this.ensureTaskFamily(family);
    return this.stackTaskDefinitionByFamily.get(family)!;
  }

  /** The task definition the last migration task ran, for scenario assertions. */
  lastMigrationDefinition(): EcsTaskDefinition | undefined {
    return this.migrationTaskDefinitionArn === null ? undefined : this.taskDefinitions.get(this.migrationTaskDefinitionArn);
  }

  /** Lazily creates the deploy state for every revealed service. */
  private ensureEcsDeployInitialized(): void {
    this.ecsDeployInitialized = true;
    for (const view of this.ecsServiceViews()) {
      if (this.serviceStates.has(view.arn)) continue;
      const family = this.familyForLogicalId(view.logicalId);
      const arn = this.ensureTaskFamily(family);
      this.serviceStates.set(view.arn, {
        logicalId: view.logicalId,
        arn: view.arn,
        family,
        taskDefinitionArn: arn,
        runningDigest: null,
        // Install creates every service at the template's paramDesiredCount=0
        // (DEPLOY-009); the first deploy scales each to its own count.
        desiredCount: 0,
        jobRolloutFailed: false,
        healthRolloutFailed: false,
        running: false,
      });
    }
  }

  /** Per-service snapshot for scenario/spec assertions. */
  serviceSnapshots(): {
    logicalId: string;
    family: string;
    taskDefinitionArn: string;
    runningImageDigest: string | null;
    desiredCount: number;
    healthy: boolean;
  }[] {
    this.ensureEcsDeployInitialized();
    return [...this.serviceStates.values()].map((state) => ({
      logicalId: state.logicalId,
      family: state.family,
      taskDefinitionArn: state.taskDefinitionArn,
      runningImageDigest: state.runningDigest,
      desiredCount: state.desiredCount,
      healthy: state.running && !state.healthRolloutFailed,
    }));
  }

  private nextUpdateRolloutOutcome(): UpdateRolloutOutcome {
    const outcomes = this.scenario.updateRollouts ?? [];
    const outcome = outcomes[this.updateServiceCallIndex] ?? 'succeed';
    this.updateServiceCallIndex += 1;
    return outcome;
  }

  private listSimulatedTasks(serviceName: string): { taskArns: string[] } {
    // Callers pass either the full service ARN (deploy executor) or the
    // bare service name — the last ARN segment (ecs-observe). Both resolve.
    const state =
      this.serviceStates.get(serviceName) ??
      [...this.serviceStates.values()].find(
        (candidate) => candidate.arn === serviceName || candidate.arn.endsWith(`/${serviceName}`),
      );
    if (state === undefined || state.runningDigest === null) return { taskArns: [] };
    const taskArn = `arn:aws:ecs:us-east-1:123456789012:task/simulated/${state.logicalId}-task-1`;
    this.taskServiceByArn.set(taskArn, state.arn);
    return { taskArns: [taskArn] };
  }

  private describeSimulatedTasks(taskArns: string[]): {
    tasks: {
      lastStatus?: string;
      stopCode?: string;
      stoppedReason?: string;
      taskDefinitionArn?: string;
      containers?: { name?: string; imageDigest?: string; exitCode?: number }[];
    }[];
  } {
    type SimulatedTask = {
      lastStatus?: string;
      stopCode?: string;
      stoppedReason?: string;
      taskDefinitionArn?: string;
      containers?: { name?: string; imageDigest?: string; exitCode?: number }[];
    };
    // The one-off migration task answers STOPPED immediately: exit 0, or —
    // when the scenario's migrationBehavior says 'fail' — exit 1 with the
    // stoppedReason a real failed migration produces. Like real ECS, it names
    // the exact revision it ran and reports named containers with no
    // `essential` field, the RDS CA init container (always exit 0) FIRST.
    return {
      tasks: taskArns.flatMap((taskArn): SimulatedTask[] => {
        if (taskArn === this.migrationTaskArn && this.migrationTaskDefinitionArn !== null) {
          const definition = this.taskDefinitions.get(this.migrationTaskDefinitionArn);
          const command = definition?.containerDefinitions.find((container) => container.essential !== false)?.['command'];
          const frozen = JSON.stringify(command) === JSON.stringify(FROZEN_MIGRATION_COMMAND);
          const failed =
            this.scenario.migrationBehavior === 'fail' || (this.scenario.migrationBehavior === 'fail-frozen' && frozen);
          const containers = [...(definition?.containerDefinitions ?? [])]
            .sort((a, b) => Number(a.essential !== false) - Number(b.essential !== false))
            .map((container) => ({
              ...(container.name !== undefined ? { name: container.name } : {}),
              exitCode: container.essential === false || !failed ? 0 : 1,
            }));
          return [
            {
              lastStatus: 'STOPPED',
              stopCode: 'EssentialContainerExited',
              ...(failed ? { stoppedReason: 'migration failed: relation "deployz" does not exist' } : {}),
              taskDefinitionArn: this.migrationTaskDefinitionArn,
              containers,
            },
          ];
        }
        const serviceArn = this.taskServiceByArn.get(taskArn);
        const state = serviceArn !== undefined ? this.serviceStates.get(serviceArn) : undefined;
        return state !== undefined && state.runningDigest !== null
          ? [{ containers: [{ imageDigest: state.runningDigest }] }]
          : [];
      }),
    };
  }

  /**
   * `EcsDeployClient` (deploy.ts) — the DEPLOY_RELEASE/ROLLBACK/RESTART write
   * seam. A simplified but behaviourally faithful multi-service ECS: one task
   * definition family per workload service, `updateService` resolves
   * instantly per the scenario's `updateRollouts` knob (one outcome per call,
   * issued web-first — so "['succeed','fail']" means the web rollout succeeded
   * and a worker's failed). A RESTART's forceNewDeployment never consumes an
   * outcome: a restart redeploys the CURRENT definition and cannot circuit-
   * break on a new image.
   *
   * `rolloutState` is one-shot per service: `describeServices` reports
   * 'FAILED' exactly once, then resets to stable — mirroring how a finished
   * ECS deployment (successful or not) drops out of the service's active
   * `deployments` list once observed, so a LATER, unrelated deploy/rollback
   * attempt is never blocked by a stale failure it did not cause.
   */
  ecsDeployClient(): EcsDeployClient {
    return {
      describeServices: async (input) => {
        this.ensureEcsDeployInitialized();
        return {
          services: input.services.map((arn) => {
            const state = this.serviceStates.get(arn);
            if (state === undefined) return {};
            const failed = state.jobRolloutFailed;
            state.jobRolloutFailed = false;
            return {
              desiredCount: state.desiredCount,
              runningCount: failed || !state.running ? 0 : state.desiredCount,
              taskDefinition: state.taskDefinitionArn,
              deployments: [{ status: 'PRIMARY', rolloutState: failed ? 'FAILED' : 'COMPLETED' }],
              networkConfiguration: {
                awsvpcConfiguration: {
                  subnets: ['subnet-11111aaa'],
                  securityGroups: ['sg-22222bbb'],
                  assignPublicIp: 'DISABLED',
                },
              },
            };
          }),
        };
      },
      describeTaskDefinition: async ({ taskDefinition }) => this.describeSimulatedTaskDefinition(taskDefinition),
      registerTaskDefinition: async (input: RegisterTaskDefinitionInput) => {
        this.ensureEcsDeployInitialized();
        this.taskDefinitionRevision += 1;
        const family = input.family ?? 'DeployzAppWeb';
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
        this.taskDefinitionsByFamily.set(family, arn);
        return { taskDefinitionArn: arn };
      },
      updateService: async (input) => {
        this.ensureEcsDeployInitialized();
        const state = this.serviceStates.get(input.service);
        if (state === undefined) return;
        // RESTART: force a fresh deployment of the CURRENT definition — no
        // new image, no rollout knob consumed.
        if (input.forceNewDeployment === true) {
          this.restarts += 1;
          state.jobRolloutFailed = false;
          state.healthRolloutFailed = false;
          state.running = state.runningDigest !== null;
          return;
        }
        const outcome = this.nextUpdateRolloutOutcome();
        if (input.taskDefinition !== undefined) state.taskDefinitionArn = input.taskDefinition;
        // First-start scaling rides the payload's per-workload count.
        if (input.desiredCount !== undefined) state.desiredCount = input.desiredCount;
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
          state.runningDigest = null;
          state.running = false;
          state.jobRolloutFailed = true;
          state.healthRolloutFailed = true;
          return;
        }
        this.operationLog.push(`update:${state.logicalId}`);
        state.jobRolloutFailed = false;
        state.healthRolloutFailed = false;
        const definition = this.taskDefinitions.get(state.taskDefinitionArn);
        const image = definition?.containerDefinitions.find((c) => typeof c.image === 'string')?.image;
        const at = image?.lastIndexOf('@') ?? -1;
        if (image !== undefined && at > 0) {
          state.runningDigest = image.slice(at + 1);
          state.running = true;
        }
      },
      listTasks: async (input) => this.listSimulatedTasks(input.serviceName),
      describeTasks: async (input) => this.describeSimulatedTasks(input.tasks),
      runTask: async (input) => {
        this.ensureEcsDeployInitialized();
        // Phase 4C: the one-shot migration task — the spec-frozen family,
        // run AS-IS (no command override). It answers STOPPED on the next
        // poll with exit 0, or exit 1 + a migration-shaped reason when the
        // scenario's `migrationBehavior` says 'fail'.
        if (
          input.overrides?.containerOverrides?.some((override) => override.command !== undefined)
        ) {
          throw new Error('simulated account: a migration task must never carry a command override');
        }
        this.migrationRuns += 1;
        this.operationLog.push(`migration:${input.taskDefinition}`);
        this.migrationTaskArn = 'arn:aws:ecs:us-east-1:123456789012:task/simulated/migration-1';
        this.migrationTaskDefinitionArn = this.taskDefinitions.has(input.taskDefinition)
          ? input.taskDefinition
          : this.ensureTaskFamily(input.taskDefinition);
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
      listTasks: async (input) => this.listSimulatedTasks(input.serviceName),
      describeTasks: async (input) => this.describeSimulatedTasks(input.tasks),
      describeTaskDefinition: ({ taskDefinition }) => this.describeSimulatedTaskDefinition(taskDefinition),
    };
  }

  /** The one task-definition read both the deploy client and the task reader
   *  share, so a heartbeat describes exactly the revision a deploy registered.
   *  Accepts either a full ARN (a service's own current revision) or a BARE
   *  family name (Phase 5: `registerReleaseImageIntoFamily` always describes
   *  the migration/scheduled-job family this way) — resolved to that
   *  family's latest ACTIVE revision, exactly like real ECS. */
  private async describeSimulatedTaskDefinition(taskDefinition: string): Promise<{ taskDefinition: EcsTaskDefinition }> {
    this.ensureEcsDeployInitialized();
    const arn = this.taskDefinitions.has(taskDefinition) ? taskDefinition : this.ensureTaskFamily(taskDefinition);
    const found = this.taskDefinitions.get(arn);
    if (found === undefined) throw new Error(`Unknown task definition "${taskDefinition}"`);
    return {
      taskDefinition: {
        ...found,
        taskDefinitionArn: arn,
        containerDefinitions: found.containerDefinitions.map((c) => ({ ...c })),
      },
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

  /**
   * ISO instant for the DESTROY collector's `operationStartedAt` boundary.
   * Deliberately does NOT anchor the destroy clock itself (no
   * `ensureDestroyStarted()` call): this is read as `deps.now()` at the very
   * start of every DESTROY invocation, BEFORE `settleDestroy` has decided
   * whether this is the invocation that actually calls
   * `StackDeleter.deleteStack` — anchoring here would make `deleteStartRealMs`
   * non-null (and therefore `describeStack`/`describeStackResources` report
   * DELETE_IN_PROGRESS) before the delete was ever requested, which would
   * skip `stopStandaloneTasks`'s pre-delete read of the still-installed
   * stack on every DESTROY, not just this scenario's. `destroyAnchorMs()`
   * already falls back to `Date.now()` when no anchor exists yet.
   */
  destroyStartedAtIso(): string {
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
   *  configured outcome once that timeline fully reveals — unless a
   *  retain-retry arrived (see `retainedLogicalIds`), which completes the
   *  delete. Idempotent — a retried/resumed DeleteStack call does not
   *  re-anchor the clock. */
  stackDeleter(): StackDeleter {
    return {
      deleteStack: async (_stackName, retainResources) => {
        this.ensureDestroyStarted();
        if (retainResources !== undefined && retainResources.length > 0) {
          this.retainedLogicalIds = [...retainResources];
        }
      },
    };
  }

  /** The `deployz:installation` tag value `CreateStack` was actually called
   *  with — captured in `createStack`, echoed back by `describeStack` for
   *  `verifyInstallation`'s `stack-tagged` check, exactly like real
   *  CloudFormation echoing back whatever tags it was given. */
  private installationTag = '';

  // ── Standalone (non-service) ECS tasks — Phase 5 scheduled jobs ──────────

  /** Test control: simulate a scheduled job's task currently RUNNING in the
   *  stack's cluster (group `family:<family>`, no service) — the shape
   *  `stopStandaloneTasks` (destroy.ts) must find and stop before deleting
   *  the cluster. Returns the task's ARN. */
  runStandaloneTask(family: string): string {
    this.standaloneTaskCounter += 1;
    const arn = `arn:aws:ecs:us-east-1:123456789012:task/simulated/standalone-${this.standaloneTaskCounter}`;
    this.standaloneTasks.set(arn, { arn, family, running: true });
    return arn;
  }

  /** Test control: mark a previously-`runStandaloneTask`'d task STOPPED,
   *  simulating a scheduled job that ran to completion (or failure) on its
   *  own, outside any relay command. */
  stopStandaloneTask(arn: string): void {
    const task = this.standaloneTasks.get(arn);
    if (task) task.running = false;
  }

  /** `EcsStandaloneTaskStopper` (destroy.ts) — DESTROY's best-effort stop of
   *  every standalone task in the stack's own cluster before deleting it. */
  ecsStandaloneTaskStopper(): EcsStandaloneTaskStopper {
    return {
      listTasks: async () => ({
        taskArns: [...this.standaloneTasks.values()].filter((task) => task.running).map((task) => task.arn),
      }),
      describeTasks: async ({ tasks }) => ({
        tasks: tasks.flatMap((taskArn) => {
          const task = this.standaloneTasks.get(taskArn);
          return task === undefined ? [] : [{ taskArn: task.arn, group: `family:${task.family}` }];
        }),
      }),
      stopTask: async ({ task }) => {
        const found = this.standaloneTasks.get(task);
        if (found === undefined) return;
        found.running = false;
        this.stoppedStandaloneTaskArns.push(task);
      },
    };
  }
}
