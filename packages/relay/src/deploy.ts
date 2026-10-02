/**
 * ECS deploy/rollback/restart executors — the day-2 write path.
 *
 * DEPLOY_RELEASE and ROLLBACK share one executor: both roll the application
 * to an immutable `repository@sha256:…` image, discovered through the
 * application's CloudFormation stack (never a hard-coded service name). The
 * only difference between them is which release the control plane derived
 * the payload from.
 *
 * Built around the same three properties as `./install.ts`:
 *
 * 1. **Idempotent.** If the requested digest is already running and the
 *    service is stable, the answer is success with no new task-definition
 *    revision — a retried command must not mutate twice.
 *
 * 2. **Bounded, resumable waiting.** An ECS rollout outlives a Lambda
 *    invocation, so `settleEcsDeploy` returns `in-progress` and the caller
 *    defers through `./pending.ts`; the resumer re-asks the same questions
 *    on later polls until the rollout settles one way or the other.
 *
 * 3. **Failure is classified.** A rollout the ECS circuit breaker reports
 *    FAILED fails the job with `ECS_DEPLOYMENT_FAILED`, never a success.
 *
 * DEPLOY_RELEASE additionally runs a migration stage before any service
 * rollout (Phase 4C): the spec-frozen one-shot migration task definition —
 * compiled from analyzed state with the command BAKED IN — is RunTask'd
 * on the same cluster/VPC/secrets as the app services. No load balancer, no
 * RunTask command override, polled until STOPPED. A vendor's migration
 * correction rides the seat and becomes a new revision of the same family
 * (only the application container's command and image change); the relay
 * then runs that exact revision. Exit code 0 continues the deploy; anything
 * else fails with MIGRATION_FAILED, names the migration task, and no
 * service is touched. ROLLBACK never runs migrations: schema changes are
 * never auto-reversed.
 *
 * Phase 5: one-shot task-definition FAMILIES (the migration, and every
 * scheduled-job family) are compiled into the stack once, with the
 * INSTALL-time image baked in (`paramImageReference`) — DEPLOY_RELEASE and
 * ROLLBACK never touch CloudFormation, so a family's latest revision never
 * otherwise picks up a new release. `registerReleaseImageIntoFamily` is the
 * one generic, bounded step that keeps a named family current: describe its
 * latest ACTIVE revision, skip if it already runs the target digest
 * (idempotent/retry-safe), otherwise register a new revision with the
 * release image. It runs (a) for the migration family right before RunTask,
 * and (b) for every scheduled-job family the control plane names, but only
 * once a DEPLOY_RELEASE/ROLLBACK rollout has otherwise SETTLED — a failed
 * update must leave scheduled jobs on the previous image.
 */

import { workloadContainerCommand, type FailureEvidence } from '@deployz/contracts';
import type { CommandExecutor, RelayCommand, RelayCommandResult } from './commands.js';
import type { PendingStore } from './pending.js';
import type { CloudFormationReader } from './verify.js';
import { applicationContainers, applicationExits, essentialContainerNames } from './ecs-observe.js';
import type { TargetHealthReader } from './ecs-health.js';

/** The ECS write surface this module needs (injectable seam for testing). */
export interface EcsDeployClient {
  describeServices(input: {
    cluster: string;
    services: string[];
  }): Promise<{
    services: {
      desiredCount?: number | undefined;
      runningCount?: number | undefined;
      taskDefinition?: string | undefined;
      deployments?: {
        status?: string | undefined;
        rolloutState?: string | undefined;
        taskDefinition?: string | undefined;
      }[];
      networkConfiguration?: {
        awsvpcConfiguration?: {
          subnets?: string[] | undefined;
          securityGroups?: string[] | undefined;
          assignPublicIp?: string | undefined;
        } | undefined;
      } | undefined;
    }[];
  }>;
  describeTaskDefinition(input: { taskDefinition: string }): Promise<{
    taskDefinition: EcsTaskDefinition;
  }>;
  registerTaskDefinition(input: RegisterTaskDefinitionInput): Promise<{ taskDefinitionArn: string }>;
  updateService(input: {
    cluster: string;
    service: string;
    taskDefinition?: string;
    forceNewDeployment?: boolean;
    desiredCount?: number;
  }): Promise<void>;
  listTasks(input: {
    cluster: string;
    serviceName: string;
    /** Defaults to RUNNING; STOPPED lists the tasks ECS still remembers (about an hour). */
    desiredStatus?: 'RUNNING' | 'STOPPED';
  }): Promise<{ taskArns: string[] }>;
  describeTasks(input: {
    cluster: string;
    tasks: string[];
  }): Promise<{
    tasks: {
      lastStatus?: string | undefined;
      stopCode?: string | undefined;
      stoppedReason?: string | undefined;
      taskDefinitionArn?: string | undefined;
      containers?:
        | {
            name?: string | undefined;
            imageDigest?: string | undefined;
            exitCode?: number | undefined;
          }[]
        | undefined;
    }[];
  }>;
  /** Starts a one-off migration task — no load balancer, no overrides: the
   *  definition named here is the spec-frozen family, run as-is. */
  runTask(input: {
    cluster: string;
    taskDefinition: string;
    count?: number;
    launchType?: string;
    networkConfiguration: {
      awsvpcConfiguration: { subnets: string[]; securityGroups: string[]; assignPublicIp: string };
    };
    overrides: { containerOverrides: { name?: string; command?: string[] }[] };
  }): Promise<{ taskArns: string[] }>;
}

/**
 * The task-definition fields carried across a copy. Deliberately the full
 * register-time shape minus the fields AWS owns (revision, status,
 * registration metadata) — a partial copy would silently drop configuration
 * the running service depends on.
 */
export interface EcsTaskDefinition {
  /** The exact revision AWS answered with — read only, never copied into a registration. */
  taskDefinitionArn?: string | undefined;
  family?: string | undefined;
  cpu?: string | undefined;
  memory?: string | undefined;
  networkMode?: string | undefined;
  requiresCompatibilities?: string[] | undefined;
  executionRoleArn?: string | undefined;
  taskRoleArn?: string | undefined;
  containerDefinitions: {
    name?: string | undefined;
    image?: string | undefined;
    [field: string]: unknown;
  }[];
  volumes?: unknown[];
}

export type RegisterTaskDefinitionInput = Omit<EcsTaskDefinition, 'containerDefinitions'> & {
  containerDefinitions: Record<string, unknown>[];
  /** The installation tag the relay's IAM conditions require on register. */
  tags?: { key: string; value: string }[];
};

export interface EcsDeployDeps {
  readonly cfn: CloudFormationReader;
  readonly ecs: EcsDeployClient;
  /**
   * ALB target-health reader behind the settle gate: a deploy does not count
   * as settled until every registered target is `healthy`. Rollout state
   * alone is not enough — ECS can mark a deployment COMPLETED while target
   * registration lags behind it (§10.3).
   */
  readonly elb: TargetHealthReader;
  readonly pending: PendingStore;
  readonly stackName: string;
  /** Stamped on every registered task-definition copy (IAM tag boundary). */
  readonly installationId: string;
  readonly now?: () => string;
  /** How long the in-invocation migration poll waits between DescribeTasks calls. */
  readonly migrationPollIntervalMs?: number;
  /** How many in-invocation migration polls may run before deferring to a later invocation. */
  readonly migrationPollMaxAttempts?: number;
}

/** One workload's rollout seat: which service and how many tasks it gets. */
export interface DeployWorkload {
  /** The spec's componentId (e.g. `web`, `email-worker`). */
  readonly id: string;
  /** The CloudFormation logical id of the workload's ECS service. */
  readonly serviceLogicalId: string;
  /** Tasks this workload's service rolls out to (web = configured, workers = 1). */
  readonly desiredCount: number;
}

/** The frozen one-shot migration the control plane names for this deploy. */
export interface DeployMigrationTask {
  /** The ECS task-definition family the compiler froze (e.g. DeployzAppMigration). */
  readonly family: string;
  /**
   * The migration identity the control plane computed (sha256 over the frozen
   * command + image digest) — carried for logging/diagnostics only; the
   * control plane records confirmation against it, never this module.
   */
  readonly identity: string;
  /**
   * The vendor's migration correction, snapshotted when the job was queued,
   * or null to run the frozen command the stack compiled. It replaces only
   * the application container's command in a new revision of THIS family;
   * nothing else in the task definition changes.
   */
  readonly command: string | null;
}

/** A deploy request after payload validation. */
export interface DeployRequest {
  readonly imageRepository: string;
  readonly imageDigest: string;
  /**
   * The spec-frozen one-shot migration to run BEFORE any service rollout.
   * The command lives in the compiled task definition — this module runs the
   * named family as-is and can never receive or inject a command. Absent
   * (null): the control plane decided no migration is needed (no migration
   * workload in the frozen spec, or this identity already confirmed).
   */
  readonly migrationTask: DeployMigrationTask | null;
  /**
   * The deployment's persistent workloads (Phase 4A) — frozen spec data the
   * control plane derived, consumed only to name a service in diagnostics
   * and to scale a first start to the right per-workload count. Empty (an
   * older control plane) keeps the single-service behaviour exactly.
   */
  readonly workloads: readonly DeployWorkload[];
  /**
   * The scheduled-job ECS task-definition families (Phase 5) the control
   * plane derived ONLY from the frozen spec's `oneShotTasksFromSpec(spec,
   * 'scheduled-job')` — never a command: each entry is a bare family name,
   * validated against the `DeployzApp…` shape. Once this rollout settles,
   * the relay registers the release image into every one of them; it never
   * runs them — `AWS::Scheduler::Schedule` does. Empty on a spec with no
   * scheduled-job workload, or an older control plane.
   */
  readonly scheduledJobFamilies: readonly string[];
}

/**
 * One-off migration-task state, carried on the pending marker so a migration
 * that outlives one invocation resumes on the SAME task (never a second run).
 * `completedAt` is set the moment the task STOPPED with exit code 0.
 */
export interface PendingMigration {
  readonly taskArn: string;
  readonly completedAt?: string;
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * The only shape a one-shot task-definition family name may take (mirrors
 * `deployzTaskFamily` in `@deployz/contracts`) — never a command, never
 * anything the relay could confuse for one.
 */
const TASK_FAMILY_PATTERN = /^DeployzApp[A-Za-z0-9]+$/;

/** The longest migration correction the relay accepts. */
const MIGRATION_COMMAND_MAX_LENGTH = 4096;

/** Parses and validates the control plane's deploy payload contract. */
export function readDeployRequest(payload: Record<string, unknown>): DeployRequest | null {
  const imageRepository = payload['imageRepository'];
  const imageDigest = payload['imageDigest'];
  if (typeof imageRepository !== 'string' || imageRepository.length === 0) return null;
  if (typeof imageDigest !== 'string' || !DIGEST_PATTERN.test(imageDigest)) return null;
  // The frozen migration rides as a NAMED task-definition family. A payload
  // carrying a legacy top-level `migrationCommand` (a pre-4C control plane)
  // is ignored outright. The one exception is the seat's own `command`: the
  // vendor's correction, which only replaces the application container's
  // command in a new revision of the named family — never a RunTask override.
  const rawMigration = payload['migrationTask'];
  let migrationTask: DeployMigrationTask | null = null;
  if (rawMigration !== undefined && rawMigration !== null) {
    if (typeof rawMigration !== 'object' || Array.isArray(rawMigration)) return null;
    const record = rawMigration as Record<string, unknown>;
    const family = record['family'];
    const identity = record['identity'];
    if (typeof family !== 'string' || !TASK_FAMILY_PATTERN.test(family)) return null;
    if (typeof identity !== 'string' || !/^[0-9a-f]{64}$/.test(identity)) return null;
    const command = record['command'];
    if (
      command !== undefined &&
      command !== null &&
      (typeof command !== 'string' ||
        command.trim().length === 0 ||
        command.length > MIGRATION_COMMAND_MAX_LENGTH ||
        command.includes('\0'))
    ) {
      return null;
    }
    migrationTask = { family, identity, command: typeof command === 'string' ? command : null };
  }
  // Workload seats are optional (an older control plane omits them) but a
  // malformed one is rejected outright, never partially trusted.
  const rawWorkloads = payload['workloads'];
  const workloads: DeployWorkload[] = [];
  if (rawWorkloads !== undefined) {
    if (!Array.isArray(rawWorkloads)) return null;
    for (const entry of rawWorkloads) {
      if (typeof entry !== 'object' || entry === null) return null;
      const record = entry as Record<string, unknown>;
      const id = record['id'];
      const serviceLogicalId = record['serviceLogicalId'];
      const desiredCount = record['desiredCount'];
      if (typeof id !== 'string' || id.length === 0) return null;
      if (typeof serviceLogicalId !== 'string' || serviceLogicalId.length === 0) return null;
      if (typeof desiredCount !== 'number' || !Number.isInteger(desiredCount) || desiredCount < 0) return null;
      workloads.push({ id, serviceLogicalId, desiredCount });
    }
  }
  // Scheduled-job families (Phase 5): bare family names only — validated
  // against the same pattern as the migration family, and never run here.
  const rawScheduledJobFamilies = payload['scheduledJobFamilies'];
  const scheduledJobFamilies: string[] = [];
  if (rawScheduledJobFamilies !== undefined) {
    if (!Array.isArray(rawScheduledJobFamilies)) return null;
    for (const entry of rawScheduledJobFamilies) {
      if (typeof entry !== 'string' || !TASK_FAMILY_PATTERN.test(entry)) return null;
      scheduledJobFamilies.push(entry);
    }
  }
  return { imageRepository, imageDigest, migrationTask, workloads, scheduledJobFamilies };
}

type EcsDeployOutcome =
  | { readonly state: 'succeeded'; readonly alreadyRunning: boolean }
  | {
      readonly state: 'failed';
      readonly reason: string;
      readonly failureCode?: string;
      /** Phase 1 structured evidence for the classified failure, when any was observed. */
      readonly evidence?: FailureEvidence;
    }
  | {
      readonly state: 'in-progress';
      readonly migration?: PendingMigration;
      readonly startedFromZero?: boolean;
      /** The task-definition revision this deploy rolls out (DEPLOY-015). */
      readonly targetTaskDefinitionArn?: string;
      /**
       * Per-service rollout revisions (Phase 4A), keyed by ECS service ARN.
       * Absent for a service already settled when this pass first saw it —
       * the DEPLOY-015 rollback check only applies to services this command
       * actually started rolling.
       */
      readonly targetTaskDefinitionArns?: Readonly<Record<string, string>>;
    };

/**
 * Tasks a service is scaled to when a deploy finds it at zero (DEPLOY-009):
 * an install that had to wait for configuration creates the service with
 * `param_DesiredCount=0`, and the first deploy is the first start. The MVP
 * runs one task, which is also the template's default count.
 */
const FIRST_START_DESIRED_COUNT = 1;

/** Per-call deploy context: which command family is running and any migration state already started. */
export interface DeploySettleContext {
  /**
   * Migrations run only for DEPLOY_RELEASE. ROLLBACK rolls the old digest
   * without them — schema changes are never auto-reversed.
   */
  readonly allowMigration: boolean;
  /** The pending marker's migration state, when this command was already started. */
  readonly migration?: PendingMigration | null;
  /**
   * This command scaled the service up from zero tasks (a configured first
   * start). A rollout the circuit breaker rolls back then goes back to zero,
   * so the template's unconfigured task definition never churns.
   */
  readonly startedFromZero?: boolean;
  /**
   * The revision an earlier invocation of this command rolled out. A service
   * whose PRIMARY deployment runs another revision was rolled back by the
   * circuit breaker — never a success, even when that revision runs the
   * same image (a pinned first start's template revision, DEPLOY-015).
   * Single-service form (kept for in-flight markers written before the
   * multi-workload rollout); applies only while the stack has one service.
   */
  readonly targetTaskDefinitionArn?: string | null;
  /**
   * Per-service rollout revisions (Phase 4A), keyed by ECS service ARN.
   * Services missing from the map skip the DEPLOY-015 check — the command
   * never started rolling them.
   */
  readonly targetTaskDefinitionArns?: Readonly<Record<string, string>> | null;
  /**
   * Command metadata for writing an early migration marker after RunTask
   * succeeds — set when the executor has the full command.  A migration task
   * whose ARN is persisted before the poll loop survives invocation death;
   * without this, a re-offer would start a second RunTask (DZ-AUDIT-003).
   */
  readonly markerCommandId?: string;
  readonly markerIdempotencyKey?: string;
  readonly markerType?: string;
  readonly markerPayload?: Record<string, unknown>;
}

/**
 * Runs the deploy to whatever conclusion is available right now. Reads
 * before writes: a rollout that already reached the requested digest (or the
 * circuit breaker) is settled without registering anything.
 *
 * "Settled" (§10.3) means all four ECS-side gates have passed for EVERY
 * application service (Phase 4A: one service per persistent workload) — the
 * digest is running, the expected task count is up, the primary deployment's
 * rollout state is COMPLETED, and every registered ALB target is healthy. A
 * rollout that is still draining old tasks, or whose targets are still
 * registering, is `in-progress` — never a success. Any single service
 * failing fails the whole deploy, with the reason naming WHICH workload.
 */
export async function settleEcsDeploy(
  deps: EcsDeployDeps,
  request: DeployRequest,
  context: DeploySettleContext = { allowMigration: false },
): Promise<EcsDeployOutcome> {
  const views = await findServiceViews(deps);
  if (views.length === 0) {
    return { state: 'failed', reason: `No ECS service found in stack "${deps.stackName}"` };
  }
  const cluster = views[0]!.arn.split('/')[1] ?? null;
  if (!cluster) {
    return { state: 'failed', reason: `Malformed service ARN "${views[0]!.arn}"` };
  }
  // Defensive: readDeployRequest always sets this; a hand-built request that
  // omits it reads as the legacy single-workload shape.
  const workloads = request.workloads ?? [];

  const { services: described } = await deps.ecs.describeServices({
    cluster,
    services: views.map((view) => view.arn),
  });
  // DescribeServices answers in request order; zip so each observed service
  // lands on the workload that asked for it. A service missing from the
  // answer is a failure for that workload, never a silent skip.
  for (let i = 0; i < views.length; i++) views[i]!.service = described[i];

  const workloadFor = (view: ServiceView): DeployWorkload | undefined =>
    workloads.find((workload) => workload.serviceLogicalId === view.logicalId);
  const label = (view: ServiceView): string => {
    const workload = workloadFor(view);
    return workload !== undefined ? `workload "${workload.id}" (${view.logicalId})` : `service ${view.logicalId}`;
  };

  // ── Per-service failure scan ────────────────────────────────────────────
  interface ServiceFailure {
    readonly view: ServiceView;
    readonly reason: string;
    readonly failureCode?: string;
    /** Phase 1 structured evidence (crash-loop stop facts), when observed. */
    readonly evidence?: FailureEvidence;
  }
  const failures: ServiceFailure[] = [];
  let anyServiceNeedsUpdate = false;

  for (const view of views) {
    const service = view.service;
    if (!service || service.taskDefinition === undefined) {
      failures.push({
        view,
        reason: `ECS service "${view.arn}" could not be described`,
        failureCode: 'AWS_PERMISSION_DENIED',
      });
      continue;
    }
    if (rolloutFailed(service.deployments)) {
      failures.push({
        view,
        reason: 'The ECS deployment circuit breaker reported a failed rollout',
        failureCode: 'ECS_DEPLOYMENT_FAILED',
      });
      continue;
    }
    // DEPLOY-015: once this command has rolled a revision out, a PRIMARY
    // deployment on any other revision means ECS rolled it back — the
    // circuit breaker restored the previous deployment, which on a pinned
    // first start runs the same image and comes up "healthy" unconfigured.
    const primary = service.deployments?.find((deployment) => deployment.status === 'PRIMARY');
    const target = resolveTarget(context, views.length, view.arn);
    if (target !== null && primary?.taskDefinition !== undefined && primary.taskDefinition !== target) {
      failures.push({
        view,
        reason: `ECS rolled the service back to ${primary.taskDefinition}; the new revision never became healthy`,
        failureCode: 'ECS_DEPLOYMENT_FAILED',
      });
    }
  }

  // The ALB target gate is stack-wide (one target group, on the public
  // workload) — read once for the whole deploy.
  const targetsHealthy = await deploymentTargetsHealthy(deps);

  // Per-service gates that need the task definitions — only for services
  // that have not already failed above.
  const definitions = new Map<string, EcsTaskDefinition>();
  for (const view of views) {
    if (failures.some((failure) => failure.view === view)) continue;
    const service = view.service!;
    const serviceTaskDefinition = service.taskDefinition!;
    const { taskDefinition } = await deps.ecs.describeTaskDefinition({
      taskDefinition: serviceTaskDefinition,
    });
    definitions.set(view.arn, taskDefinition);
    const essential = essentialContainerNames(taskDefinition.containerDefinitions);
    const primary = service.deployments?.find((deployment) => deployment.status === 'PRIMARY');
    const target = resolveTarget(context, views.length, view.arn);
    const runningDigest = await observeRunningDigest(deps, cluster, view.arn, essential);
    const stable =
      (service.desiredCount ?? 0) > 0 && (service.runningCount ?? 0) >= (service.desiredCount ?? 0);
    const rolloutCompleted = primaryRolloutCompleted(service.deployments);
    const onTarget = target === null || primary?.taskDefinition === undefined || primary.taskDefinition === target;
    const nextImage = `${request.imageRepository}@${request.imageDigest}`;
    const alreadyRegistered = taskDefinition.containerDefinitions.some(
      (container) => container.image === nextImage,
    );
    const settled =
      runningDigest === request.imageDigest && stable && rolloutCompleted && targetsHealthy && onTarget;

    // DEPLOY-011: ECS's circuit breaker counts a task as failed only when it
    // never reaches RUNNING or fails a health check. A task that starts,
    // runs for a while and then exits is a restart to ECS, so a crash-looping
    // rollout never reaches COMPLETED and never FAILS — it would sit
    // in-progress until the control plane's 24-hour grace. Once the service
    // runs this request's revision, its own stopped tasks are the verdict.
    if (!settled && alreadyRegistered) {
      // The application's names come from the revision whose tasks are
      // inspected, never from another revision.
      const inspected = target ?? serviceTaskDefinition;
      const inspectedEssential =
        inspected === serviceTaskDefinition
          ? essential
          : essentialContainerNames(
              (await deps.ecs.describeTaskDefinition({ taskDefinition: inspected })).taskDefinition
                .containerDefinitions,
            );
      const crashed = await crashedTasksOfRevision(deps, cluster, view.arn, inspected, inspectedEssential);
      if (crashed.count >= CRASH_LOOP_THRESHOLD) {
        failures.push({
          view,
          reason: `${crashed.count} tasks of the new revision exited with code ${crashed.exitCode} (${crashed.stoppedReason})`,
          failureCode: 'CONTAINER_START_FAILED',
          evidence: {
            container: {
              exitCode: crashed.exitCode,
              stopCode: crashed.stopCode,
              stoppedReason: crashed.stoppedReason.length > 0 ? crashed.stoppedReason : null,
              stoppedTaskCount: crashed.count,
            },
          },
        });
        continue;
      }
    }

    if (!settled) anyServiceNeedsUpdate = true;
    view.alreadyRunning = settled;
    view.alreadyRegistered = alreadyRegistered;
    view.runningDigest = runningDigest;
  }

  if (failures.length > 0) {
    if (context.startedFromZero) {
      // The circuit breaker restored the previous deployment, which for a
      // first start is the template's unconfigured task definition — at the
      // count this command set, it would keep crashing. Back to zero; the
      // deployment is FAILED and the next deploy starts it again.
      for (const view of views) {
        try {
          await deps.ecs.updateService({ cluster, service: view.arn, desiredCount: 0 });
        } catch {
          // Best effort: the failure below is the outcome either way.
        }
      }
    }
    const reasons = failures.map((failure) => `${label(failure.view)}: ${failure.reason}`);
    return {
      state: 'failed',
      reason: reasons.join('; '),
      failureCode: failures[0]!.failureCode ?? 'ECS_DEPLOYMENT_FAILED',
      ...(failures[0]!.evidence ? { evidence: failures[0]!.evidence } : {}),
    };
  }

  // Every service already runs this release, stable and verified — nothing
  // to roll (a retried command must not mutate twice). Enforced by code, not
  // convention: when a migration seat is present, success may only be
  // returned AFTER the migration stage has run — so the early return is
  // gated on there being no migration to run.
  if (!anyServiceNeedsUpdate && request.migrationTask === null) {
    return settleSuccess(deps, request, context.migration ?? undefined);
  }

  // Migration stage — before any service update, so the previous release
  // keeps running and the release pointers never move on a MIGRATION_FAILED.
  // Gated twice: the control plane only ever puts a migrationTask on
  // DEPLOY_RELEASE payloads, AND this executor refuses to run one for any
  // other command type — ROLLBACK and RESTART never run migrations.
  let migration: PendingMigration | undefined;
  // The one-off task runs on the SAME network as the application's public
  // workload — `web` is the fixed public-workload component id every graph
  // carries (falling back to the first service for a payload without seats).
  const migrationNetworkView = views.find((view) => workloadFor(view)?.id === 'web') ?? views[0]!;
  if (request.migrationTask !== null && context.allowMigration) {
    const outcome = await settleMigration(deps, {
      cluster,
      networkConfiguration: migrationNetworkView.service?.networkConfiguration,
      migrationTask: request.migrationTask,
      pendingMigration: context.migration ?? null,
      request,
      markerCommandId: context.markerCommandId,
      markerIdempotencyKey: context.markerIdempotencyKey,
      markerType: context.markerType,
      markerPayload: context.markerPayload,
    });
    if (outcome.state === 'failed') {
      return {
        state: 'failed',
        reason: outcome.reason,
        failureCode: outcome.failureCode ?? 'MIGRATION_FAILED',
        ...(outcome.evidence ? { evidence: outcome.evidence } : {}),
      };
    }
    if (outcome.state === 'in-progress') {
      return { state: 'in-progress', migration: outcome.migration };
    }
    migration = outcome.migration;
  }
  // A seat the executor refused to run (ROLLBACK/RESTART, by the gate above)
  // cannot gate the success path: those commands never carry migrations.
  if (!anyServiceNeedsUpdate) {
    return settleSuccess(deps, request, migration);
  }

  // ── Roll every service that still needs it ──────────────────────────────
  const anyStartedFromZero =
    views.some((view) => (view.service?.desiredCount ?? 0) === 0) || context.startedFromZero === true;
  const targetArns: Record<string, string> = {};
  for (const view of views) {
    if (view.alreadyRunning === true) continue;
    const service = view.service!;
    const taskDefinition = definitions.get(view.arn)!;
    const workload = workloadFor(view);
    // A service at zero tasks is an install that waited for configuration
    // (DEPLOY-009): this deploy is its first start, scaled to the workload's
    // own configured count (workers ride the template default of 1).
    const firstStart =
      (service.desiredCount ?? 0) === 0
        ? { desiredCount: workload?.desiredCount ?? FIRST_START_DESIRED_COUNT }
        : {};

    let registeredArn: string | null = null;
    const alreadyRegistered = view.alreadyRegistered ?? false;
    const runningDigest = view.runningDigest ?? null;
    if (!alreadyRegistered) {
      // No migration registered this service's application copy, so this is
      // the same fresh-register path as ever: register, then start the
      // rollout.
      const replaced = replaceApplicationImages(taskDefinition, request);
      if (!replaced) {
        return {
          state: 'failed',
          reason: `${label(view)}: no container in the task definition references repository "${request.imageRepository}"`,
        };
      }
      replaced.tags = [{ key: 'deployz:installation', value: deps.installationId }];
      const registered = await deps.ecs.registerTaskDefinition(replaced);
      registeredArn = registered.taskDefinitionArn;
      await deps.ecs.updateService({
        cluster,
        service: view.arn,
        taskDefinition: registeredArn,
        ...firstStart,
      });
    } else if (runningDigest !== request.imageDigest) {
      // This service already runs the new revision's task definition (an
      // earlier attempt of this command registered it) but its tasks have
      // not picked the new image up yet — re-issue the update against that
      // copy.
      await deps.ecs.updateService({
        cluster,
        service: view.arn,
        taskDefinition: registeredArn ?? service.taskDefinition!,
        ...firstStart,
      });
    }

    // The rollout just started or is still in flight — only its own progress
    // can settle it, on a later poll. Record the revision this command
    // rolled (or had already rolled) so that poll can tell a rollback from
    // a rollout (DEPLOY-015).
    const target = resolveTarget(context, views.length, view.arn);
    targetArns[view.arn] = target ?? registeredArn ?? service.taskDefinition!;
  }

  return {
    state: 'in-progress',
    ...(migration === undefined ? {} : { migration }),
    ...(anyStartedFromZero ? { startedFromZero: true } : {}),
    targetTaskDefinitionArns: targetArns,
    // Single-service stacks keep the legacy string form too, so an in-flight
    // marker written here still resumes under a relay that predates the map.
    ...(views.length === 1 ? { targetTaskDefinitionArn: targetArns[views[0]!.arn] } : {}),
  };
}

/** The outcome of one migration-stage pass. */
type MigrationOutcome =
  | {
      readonly state: 'completed';
      readonly migration: PendingMigration;
    }
  | { readonly state: 'in-progress'; readonly migration: PendingMigration }
  | {
      readonly state: 'failed';
      readonly reason: string;
      /**
       * Sharper classification for a migration task that could not run at
       * all — the image pull failed before the migration command started
       * (the task's stoppedReason names CannotPullContainerError). Absent
       * when the migration itself failed, which stays MIGRATION_FAILED.
       */
      readonly failureCode?: string;
      /** Phase 1 structured evidence for the stopped migration task. */
      readonly evidence?: FailureEvidence;
    };

/**
 * Runs (or resumes) the migration stage: the spec-frozen one-off ECS task
 * definition (Phase 4C), run AS-IS on the SAME cluster/VPC/subnets/security
 * groups as the app services. The migration command is baked into the task
 * definition by the compiler from analyzed/frozen state — this module runs
 * the family the control plane names and can never inject a command. Polls
 * DescribeTasks until STOPPED; a task that outlives the invocation is resumed
 * by ARN on a later poll, never re-run. Exit code 0 completes the stage;
 * anything else fails the job with MIGRATION_FAILED (exit code + stoppedReason
 * as detail — never log bodies: the relay role deliberately has no
 * logs:GetLogEvents). An outcome is only ever `completed` after the task was
 * actually observed STOPPED with the application container's exit code 0. A
 * failed AWS read defers to the next poll; a task ECS no longer knows fails
 * without recording anything (reconcile-before-fail: never guess).
 */
async function settleMigration(
  deps: EcsDeployDeps,
  params: {
    cluster: string;
    networkConfiguration?: {
      awsvpcConfiguration?: {
        subnets?: string[] | undefined;
        securityGroups?: string[] | undefined;
        assignPublicIp?: string | undefined;
      } | undefined;
    } | undefined;
    migrationTask: DeployMigrationTask;
    pendingMigration: PendingMigration | null;
    /** The deploy request — needed to register the release image into the
     *  migration family before it runs (see `registerReleaseImageIntoFamily`). */
    request: DeployRequest;
    /** Marker fields for the early migration write after RunTask succeeds. */
    markerCommandId?: string | undefined;
    markerIdempotencyKey?: string | undefined;
    markerType?: string | undefined;
    markerPayload?: Record<string, unknown> | undefined;
  },
): Promise<MigrationOutcome> {
  const { cluster, migrationTask } = params;

  if (params.pendingMigration?.completedAt !== undefined) {
    return { state: 'completed', migration: params.pendingMigration };
  }

  let taskArn: string | null = params.pendingMigration?.taskArn ?? null;

  if (taskArn === null) {
    // Run the frozen migration task definition AS-IS — no overrides, no
    // command injection. The command lives in the definition the compiler
    // froze from analyzed state.
    const network = params.networkConfiguration?.awsvpcConfiguration;
    if (network === undefined || network.subnets === undefined || network.securityGroups === undefined) {
      return {
        state: 'failed',
        reason:
          "Migration needs the service's VPC network configuration, which could not be described",
      };
    }

    // The migration family is compiled once into the stack with the
    // INSTALL-time image baked in — DEPLOY_RELEASE/ROLLBACK never touch
    // CloudFormation, so its latest revision would otherwise still run
    // whatever image the last stack operation set, not this release's
    // digest. Bring it current before RunTask (idempotent — a no-op once
    // the latest revision already runs the digest and the command), and run
    // exactly the revision that results.
    let revision: string;
    try {
      revision = await migrationRevision(deps, migrationTask, params.request);
    } catch (err) {
      return {
        state: 'failed',
        reason: `Migration family "${migrationTask.family}" could not be updated to the release image: ${String(err)}`,
      };
    }

    const { taskArns } = await deps.ecs.runTask({
      cluster,
      taskDefinition: revision,
      count: 1,
      launchType: 'FARGATE',
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: network.subnets,
          securityGroups: network.securityGroups,
          assignPublicIp: network.assignPublicIp ?? 'DISABLED',
        },
      },
      overrides: { containerOverrides: [] },
    });
    taskArn = taskArns[0] ?? null;
    if (taskArn === null) {
      return {
        state: 'failed',
        reason: 'Migration task could not be started (RunTask returned no task ARN)',
      };
    }

    // DZ-AUDIT-003: persist the migration ARN before entering the poll loop —
    // a dead invocation must still leave a marker so a re-offer resumes the
    // SAME task instead of starting a second one.  The late marker write at
    // ~887 overwrites/merges later; this write is the safety net for the
    // invocation-death window between RunTask success and the post-settle
    // marker write.
    if (
      params.markerCommandId !== undefined &&
      params.markerIdempotencyKey !== undefined &&
      params.markerType !== undefined &&
      params.markerPayload !== undefined
    ) {
      await deps.pending.write({
        commandId: params.markerCommandId,
        idempotencyKey: params.markerIdempotencyKey,
        type: params.markerType,
        stackName: deps.stackName,
        startedAt: (deps.now ?? (() => new Date().toISOString()))(),
        payload: params.markerPayload,
        migration: { taskArn },
      });
    }
  }

  const releaseImage = `${params.request.imageRepository}@${params.request.imageDigest}`;
  const pollIntervalMs = deps.migrationPollIntervalMs ?? 10_000;
  const maxAttempts = deps.migrationPollMaxAttempts ?? 24;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleep(pollIntervalMs);
    let task: Awaited<ReturnType<EcsDeployClient['describeTasks']>>['tasks'][number] | undefined;
    let exit: MigrationExit | null = null;
    try {
      task = (await deps.ecs.describeTasks({ cluster, tasks: [taskArn] })).tasks[0];
      if (task?.lastStatus === 'STOPPED') exit = await migrationApplicationExit(deps, task, releaseImage);
    } catch (err) {
      // A failed read says nothing about the task. Defer: the next poll asks
      // again about the SAME task, and nothing is confirmed or failed.
      console.log(JSON.stringify({ event: 'relay:migration-read-deferred', taskArn, error: String(err) }));
      return { state: 'in-progress', migration: { taskArn } };
    }
    if (task === undefined) {
      // Reconcile-before-fail: we asked, and got no answer — that is an
      // UNKNOWN outcome, never a success. Fail honestly; nothing is recorded
      // as confirmed, so a retry re-verifies from a fresh run.
      return {
        state: 'failed',
        reason: `Migration task "${taskArn}" could not be described`,
      };
    }
    if (task.lastStatus !== 'STOPPED' || exit === null) continue;
    // Only the application container's own exit code 0 is a success. The RDS
    // CA init container also exits 0, in any container order; a missing
    // identity or exit code is never a number, so it can never pass as 0.
    const exitCode = exit.exitCode;
    if (exitCode !== 0) {
      return {
        state: 'failed',
        reason: `Migration workload "${migrationTask.family}" failed: exit code ${exitCode ?? `unknown, ${exit.problem}`} (${task.stopCode ?? 'STOPPED'}: ${task.stoppedReason ?? 'no reason given'})`,
        // §14.2 ECR-image-pull classification: the migration task never ran
        // because its image could not be pulled. The migration runs the SAME
        // image as the service update, so a pull denial here is the ECR
        // grant / registry problem §29's IMAGE_PULL_FAILED exists for — not
        // a migration bug the "fix the migration" remediation would address.
        ...(isImagePullFailure(task.stoppedReason)
          ? { failureCode: 'IMAGE_PULL_FAILED' }
          : {}),
        // Phase 1: the stopped task's own facts, structured — read from the
        // task already described, so it cannot throw.
        evidence: {
          container: {
            exitCode: exitCode ?? null,
            stopCode: task.stopCode ?? null,
            stoppedReason: task.stoppedReason ?? null,
            stoppedTaskCount: 1,
          },
        },
      };
    }
    const completedAt = (deps.now ?? (() => new Date().toISOString()))();
    return {
      state: 'completed',
      migration: {
        taskArn,
        completedAt,
      },
    };
  }

  return {
    state: 'in-progress',
    migration: { taskArn },
  };
}

type MigrationExit =
  | { readonly exitCode: number }
  | { readonly exitCode: null; readonly problem: string };

/**
 * The application container's exit code in a stopped migration task. A
 * runtime container carries no `essential` field, so the identity comes from
 * the exact revision the task ran: its one essential container that runs the
 * release image. The exit code is then read by that container's name.
 * Throws only when an AWS read fails.
 */
async function migrationApplicationExit(
  deps: EcsDeployDeps,
  task: Awaited<ReturnType<EcsDeployClient['describeTasks']>>['tasks'][number],
  releaseImage: string,
): Promise<MigrationExit> {
  if (task.taskDefinitionArn === undefined) {
    return { exitCode: null, problem: 'the task names no task definition' };
  }
  const { taskDefinition } = await deps.ecs.describeTaskDefinition({ taskDefinition: task.taskDefinitionArn });
  const candidates = taskDefinition.containerDefinitions.filter(
    (container) => container.essential !== false && container.image === releaseImage,
  );
  const name = candidates.length === 1 ? candidates[0]!.name : undefined;
  if (typeof name !== 'string' || name.length === 0) {
    return {
      exitCode: null,
      problem: `${task.taskDefinitionArn} has ${candidates.length} named essential containers running ${releaseImage}, not one`,
    };
  }
  const reported = (task.containers ?? []).filter((container) => container.name === name);
  if (reported.length !== 1) {
    return { exitCode: null, problem: `the task reports ${reported.length} containers named "${name}", not one` };
  }
  const exitCode = reported[0]!.exitCode;
  return exitCode === undefined
    ? { exitCode: null, problem: `container "${name}" reported no exit code` }
    : { exitCode };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Markers that tell a migration task never ran because ECS could not pull
 * the application image — the task's stoppedReason names them verbatim
 * (CannotPullContainerError is ECS's own wrap; the others are the ECR /
 * registry error texts inside it). Mirrors the server-side refinement
 * vocabulary in apps/api/src/failure-classification.ts so the relay and the
 * control plane agree on what an image-pull failure looks like.
 */
const IMAGE_PULL_FAILURE_MARKERS =
  /cannotpullcontainererror|pull access denied|no basic auth credentials|failed to pull image/i;

/**
 * True when a stopped migration task never started because its image could
 * not be pulled. The migration command runs the SAME image the service
 * update will use, so a pull denial here is the ECR grant / registry
 * problem §29's IMAGE_PULL_FAILED exists for — not a migration bug, and the
 * "fix the migration" remediation would send the vendor the wrong way.
 */
function isImagePullFailure(stoppedReason: string | null | undefined): boolean {
  return stoppedReason !== undefined && stoppedReason !== null && IMAGE_PULL_FAILURE_MARKERS.test(stoppedReason);
}

function rolloutFailed(
  deployments: { status?: string | undefined; rolloutState?: string | undefined }[] | undefined,
): boolean {
  return deployments?.some((deployment) => deployment.rolloutState === 'FAILED') ?? false;
}

/**
 * Whether the PRIMARY deployment reached ECS's COMPLETED rollout state. A
 * service mid-rollout has its new deployment PRIMARY and IN_PROGRESS; a
 * service that is not (or has never been) rolling exposes no COMPLETED
 * primary, so this is false and the deploy keeps waiting.
 */
function primaryRolloutCompleted(
  deployments: { status?: string | undefined; rolloutState?: string | undefined }[] | undefined,
): boolean {
  return deployments?.find((deployment) => deployment.status === 'PRIMARY')?.rolloutState === 'COMPLETED';
}

const TARGET_GROUP_TYPE = 'AWS::ElasticLoadBalancingV2::TargetGroup';

/**
 * Resource statuses whose physicalId actually backs live infrastructure —
 * the same rule ecs-health.ts applies, so a rolled-back stack's phantom
 * target-group reference is never asked about.
 */
const COMPLETE_RESOURCE_STATUSES: ReadonlySet<string> = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE']);

/**
 * Whether every registered ALB target for the application's target group is
 * healthy. Only `healthy` counts: a target still registering (`initial`),
 * draining, unclassified, or unhealthy means the load balancer is not
 * finished with this release, however complete the ECS rollout looks.
 * Absent target group (never completed, or not readable) also means not
 * healthy — the deploy keeps waiting rather than guessing.
 */
async function deploymentTargetsHealthy(deps: EcsDeployDeps): Promise<boolean> {
  const resources = await deps.cfn.describeStackResources(deps.stackName);
  const targetGroup = resources.find(
    (resource) => resource.type === TARGET_GROUP_TYPE && COMPLETE_RESOURCE_STATUSES.has(resource.status),
  );
  if (!targetGroup?.physicalId) return false;
  const { targets } = await deps.elb.describeTargetHealth({ targetGroupArn: targetGroup.physicalId });
  return targets.length > 0 && targets.every((target) => target.state === 'healthy');
}

async function observeRunningDigest(
  deps: EcsDeployDeps,
  cluster: string,
  serviceArn: string,
  essential: ReadonlySet<string>,
): Promise<string | null> {
  const { taskArns } = await deps.ecs.listTasks({ cluster, serviceName: serviceArn });
  if (taskArns.length === 0) return null;
  const { tasks } = await deps.ecs.describeTasks({ cluster, tasks: taskArns });
  for (const task of tasks) {
    const digest = applicationContainers(task.containers, essential).find((c) =>
      c.imageDigest?.startsWith('sha256:'),
    )?.imageDigest;
    if (digest) return digest;
  }
  return null;
}

/**
 * Stopped tasks of one task-definition revision whose essential container
 * exited non-zero — the crash loop ECS's circuit breaker does not count.
 * Tasks the scheduler stopped (an old revision draining, a scale-down) have
 * another stop code and are never counted. `essential` names that
 * revision's application containers; a helper's exit never counts.
 */
const CRASH_LOOP_THRESHOLD = 3;

async function crashedTasksOfRevision(
  deps: EcsDeployDeps,
  cluster: string,
  serviceArn: string,
  taskDefinitionArn: string,
  essential: ReadonlySet<string>,
): Promise<{ count: number; exitCode: number | null; stopCode: string | null; stoppedReason: string }> {
  const { taskArns } = await deps.ecs.listTasks({ cluster, serviceName: serviceArn, desiredStatus: 'STOPPED' });
  if (taskArns.length === 0) return { count: 0, exitCode: null, stopCode: null, stoppedReason: '' };
  const { tasks } = await deps.ecs.describeTasks({ cluster, tasks: taskArns.slice(0, 20) });
  let count = 0;
  let exitCode: number | null = null;
  let stopCode: string | null = null;
  let stoppedReason = '';
  for (const task of tasks) {
    if (task.taskDefinitionArn !== taskDefinitionArn || task.stopCode !== 'EssentialContainerExited') continue;
    const failed = applicationExits(task.containers, essential).find((c) => c.exitCode !== 0);
    if (!failed) continue;
    count += 1;
    exitCode = failed.exitCode ?? null;
    stopCode = task.stopCode ?? stopCode;
    stoppedReason = task.stoppedReason ?? stoppedReason;
  }
  return { count, exitCode, stopCode, stoppedReason };
}

/** One stack ECS service: its CloudFormation logical id and physical ARN. */
interface ServiceView {
  readonly logicalId: string;
  readonly arn: string;
  /** The DescribeServices answer for this service — undefined until zipped. */
  service?: Awaited<ReturnType<EcsDeployClient['describeServices']>>['services'][number] | undefined;
  /** The per-service gates computed by `settleEcsDeploy`. */
  alreadyRunning?: boolean | undefined;
  alreadyRegistered?: boolean | undefined;
  runningDigest?: string | null | undefined;
}

/** The stack's ECS services, in CloudFormation resource order (web first). */
async function findServiceViews(deps: EcsDeployDeps): Promise<ServiceView[]> {
  const resources = await deps.cfn.describeStackResources(deps.stackName);
  return resources
    .filter((resource) => resource.type === 'AWS::ECS::Service' && resource.physicalId !== undefined)
    .map((resource) => ({ logicalId: resource.logicalId, arn: resource.physicalId! }));
}

/** The revision this command rolled out for one service, when it rolled one. */
function resolveTarget(
  context: DeploySettleContext,
  serviceCount: number,
  serviceArn: string,
): string | null {
  return (
    context.targetTaskDefinitionArns?.[serviceArn] ??
    // Legacy single-revision marker form: it can only name THE one service
    // of a single-service stack.
    (serviceCount === 1 ? (context.targetTaskDefinitionArn ?? null) : null)
  );
}

/**
 * Copies the definition with only application images from the expected
 * repository replaced. Sidecars from other registries are copied verbatim.
 * Returns null when no container matched — a deploy that changes nothing is
 * a misconfiguration, not a success.
 */
export function replaceApplicationImages(
  taskDefinition: EcsTaskDefinition,
  request: DeployRequest,
): RegisterTaskDefinitionInput | null {
  const nextImage = `${request.imageRepository}@${request.imageDigest}`;
  let matched = false;
  const containerDefinitions = taskDefinition.containerDefinitions.map((container) => {
    if (typeof container.image === 'string' && container.image.startsWith(`${request.imageRepository}@`)) {
      matched = true;
      return { ...container, image: nextImage };
    }
    return { ...container };
  });
  if (!matched) return null;
  const copy: RegisterTaskDefinitionInput = {
    family: taskDefinition.family,
    cpu: taskDefinition.cpu,
    memory: taskDefinition.memory,
    networkMode: taskDefinition.networkMode,
    requiresCompatibilities: taskDefinition.requiresCompatibilities,
    executionRoleArn: taskDefinition.executionRoleArn,
    taskRoleArn: taskDefinition.taskRoleArn,
    containerDefinitions,
    ...(taskDefinition.volumes ? { volumes: taskDefinition.volumes } : {}),
  };
  return copy;
}

/**
 * Registers the release image into a named, spec-frozen one-shot task
 * family: reads the family's latest ACTIVE revision (`describeTaskDefinition`
 * accepts a bare family name and answers with its newest active revision),
 * and registers a new revision only when that revision does not already run
 * the target digest. Idempotent and retry-safe — a repeated call after a
 * successful register is a no-op, so a re-offered command or a later
 * scheduled-job family in the same list never double-registers.
 *
 * Used for the migration family right before RunTask (Phase 4C/5: DEPLOY_
 * RELEASE and ROLLBACK never touch CloudFormation, so a family's latest
 * revision otherwise keeps running whatever image the last stack operation
 * baked in) and for every scheduled-job family once a rollout has settled.
 */
async function registerReleaseImageIntoFamily(
  deps: EcsDeployDeps,
  family: string,
  request: DeployRequest,
  applicationCommand?: readonly string[],
): Promise<string | undefined> {
  const { taskDefinition } = await deps.ecs.describeTaskDefinition({ taskDefinition: family });
  const nextImage = `${request.imageRepository}@${request.imageDigest}`;
  const alreadyOnDigest = taskDefinition.containerDefinitions.some((container) => container.image === nextImage);
  const commandCurrent =
    applicationCommand === undefined ||
    sameCommand(
      applicationContainer(taskDefinition.containerDefinitions, request.imageRepository)?.['command'],
      applicationCommand,
    );
  if (alreadyOnDigest && commandCurrent) return taskDefinition.taskDefinitionArn;
  const replaced = replaceApplicationImages(taskDefinition, request);
  if (!replaced) {
    throw new Error(
      `Task family "${family}" has no container referencing repository "${request.imageRepository}"`,
    );
  }
  if (applicationCommand !== undefined) {
    const container = applicationContainer(replaced.containerDefinitions, request.imageRepository);
    if (container === undefined) {
      throw new Error(`Task family "${family}" has no single application container to carry the command`);
    }
    container['command'] = [...applicationCommand];
  }
  replaced.tags = [{ key: 'deployz:installation', value: deps.installationId }];
  return (await deps.ecs.registerTaskDefinition(replaced)).taskDefinitionArn;
}

/**
 * The application container of a task definition: its one essential
 * container that runs an image from the release repository. A helper (the
 * RDS CA init container) is never essential and never matches. Undefined
 * when there is not exactly one.
 */
function applicationContainer<T extends { image?: unknown; essential?: unknown }>(
  containers: T[],
  imageRepository: string,
): T | undefined {
  const matches = containers.filter(
    (container) =>
      container.essential !== false &&
      typeof container.image === 'string' &&
      container.image.startsWith(`${imageRepository}@`),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function sameCommand(current: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(current) &&
    current.length === expected.length &&
    current.every((part, index) => part === expected[index])
  );
}

/** `arn:aws:ecs:…:task-definition/<family>:<revision>` → `<family>`. */
function taskDefinitionFamily(arn: string): string | null {
  return /:task-definition\/([^:/]+):\d+$/.exec(arn)?.[1] ?? null;
}

/**
 * The exact migration revision to run. The named family must be a task
 * definition of this deployment's own stack — never another family the
 * relay can reach. The command is the vendor's correction when the seat
 * carries one, otherwise the frozen command of the revision the stack
 * itself created, so a removed correction restores the frozen command. Only
 * the application container's command and image change; the entrypoint,
 * roles, secrets, volumes, networking and init containers are copied from
 * the family's latest revision.
 */
async function migrationRevision(
  deps: EcsDeployDeps,
  migrationTask: DeployMigrationTask,
  request: DeployRequest,
): Promise<string> {
  const resources = await deps.cfn.describeStackResources(deps.stackName);
  const owned = resources.find(
    (resource) =>
      resource.type === 'AWS::ECS::TaskDefinition' &&
      resource.physicalId !== undefined &&
      taskDefinitionFamily(resource.physicalId) === migrationTask.family,
  );
  if (owned?.physicalId === undefined) {
    throw new Error(`Task family "${migrationTask.family}" is not part of stack "${deps.stackName}"`);
  }
  let command: readonly string[] | undefined;
  if (migrationTask.command !== null) {
    command = workloadContainerCommand(migrationTask.command);
  } else {
    const { taskDefinition } = await deps.ecs.describeTaskDefinition({ taskDefinition: owned.physicalId });
    const frozen = applicationContainer(taskDefinition.containerDefinitions, request.imageRepository)?.['command'];
    command = Array.isArray(frozen) && frozen.every((part) => typeof part === 'string') ? frozen : undefined;
  }
  const revision = await registerReleaseImageIntoFamily(deps, migrationTask.family, request, command);
  if (revision === undefined) {
    throw new Error(`Task family "${migrationTask.family}" answered with no revision ARN`);
  }
  return revision;
}

/**
 * Registers the release image into every scheduled-job family the control
 * plane named (Phase 5) — called only once a DEPLOY_RELEASE/ROLLBACK
 * rollout has otherwise SETTLED, so a failed update leaves scheduled jobs on
 * the previous image. `AWS::Scheduler::Schedule` runs the family's latest
 * revision; this never RunTask's it — that stays Scheduler's job alone.
 */
async function registerScheduledJobFamilies(deps: EcsDeployDeps, request: DeployRequest): Promise<void> {
  for (const family of request.scheduledJobFamilies) {
    await registerReleaseImageIntoFamily(deps, family, request);
  }
}

/**
 * The only way `settleEcsDeploy` may report success: every scheduled-job
 * family is brought current with the release image FIRST, so a rollout only
 * ever settles once its scheduled jobs would run the same release the
 * services do. The services may already run the release here, so a
 * registration error never reports a failed update (the previous release is
 * no longer what serves): the command stays in progress, carrying any
 * completed migration so it is never re-run, and the next poll retries —
 * bounded by the control plane's in-progress grace like any other rollout.
 */
async function settleSuccess(
  deps: EcsDeployDeps,
  request: DeployRequest,
  migration: PendingMigration | undefined,
): Promise<EcsDeployOutcome> {
  try {
    await registerScheduledJobFamilies(deps, request);
  } catch {
    return { state: 'in-progress', ...(migration !== undefined ? { migration } : {}) };
  }
  return { state: 'succeeded', alreadyRunning: true };
}

// ── Executors ────────────────────────────────────────────────────────────────

function result(
  command: RelayCommand,
  success: boolean,
  extra: {
    output?: Record<string, unknown>;
    error?: string;
    failureCode?: string;
    evidence?: FailureEvidence;
  } = {},
): RelayCommandResult {
  return {
    commandId: command.id,
    idempotencyKey: command.idempotencyKey,
    success,
    ...extra,
  };
}

/** The shared DEPLOY_RELEASE / ROLLBACK executor. */
export function createEcsDeployExecutor(deps: EcsDeployDeps): CommandExecutor {
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

    const request = readDeployRequest(command.payload);
    if (!request) {
      return result(command, false, {
        error: 'Command payload is missing a valid imageRepository/imageDigest pair',
      });
    }

    let outcome: EcsDeployOutcome;
    try {
      // Only this command's OWN marker may carry a migration task forward —
      // a stale marker from an earlier command must never resume its task.
      const existing = await deps.pending.read();
      const migration = existing?.commandId === command.id ? (existing.migration ?? null) : null;
      outcome = await settleEcsDeploy(deps, request, {
        allowMigration: command.type === 'DEPLOY_RELEASE',
        migration,
        markerCommandId: command.id,
        markerIdempotencyKey: command.idempotencyKey,
        markerType: command.type,
        markerPayload: command.payload,
      });
    } catch (err) {
      return result(command, false, {
        error: String(err),
        failureCode: 'AWS_PERMISSION_DENIED',
      });
    }

    if (outcome.state === 'failed') {
      // The early migration marker (DZ-AUDIT-003) may have been written
      // inside settleMigration before the poll discovered the failure —
      // clear it so a stale marker never looks like something to resume.
      await deps.pending.clear();
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
        ...(outcome.failureCode ? { failureCode: outcome.failureCode } : {}),
        ...(outcome.evidence ? { evidence: outcome.evidence } : {}),
      });
    }

    if (outcome.state === 'succeeded') {
      // The early migration marker (DZ-AUDIT-003) may exist when the deploy
      // was already-succeeded but still owed a migration — the stage ran to
      // completion above, so the marker must not survive: a dangling marker
      // of a settled command would be resumed and re-reported on later polls.
      await deps.pending.clear();
      console.log(
        JSON.stringify({
          event: 'relay:command-succeeded',
          commandId: command.id,
          type: command.type,
          alreadyRunning: outcome.alreadyRunning,
        }),
      );
      return result(command, true, {
        output: { executed: true, type: command.type, alreadyRunning: outcome.alreadyRunning },
      });
    }

    // Record the debt BEFORE deferring — an unfindable deferral leaves the
    // job in RUNNING forever, which is worse than an honest failure. The
    // marker also carries any migration task so a later invocation resumes
    // the SAME task instead of starting a second migration.
    const recorded = await deps.pending.write({
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      type: command.type,
      stackName: deps.stackName,
      startedAt: (deps.now ?? (() => new Date().toISOString()))(),
      // A first start from zero rides the marker so the resumer can scale a
      // rolled-back rollout back down (DEPLOY-009); the revision rolled out
      // rides along so the resumer can tell a rollback from a rollout
      // (DEPLOY-015).
      payload: {
        ...command.payload,
        ...(outcome.startedFromZero ? { startedFromZero: true } : {}),
        ...(outcome.targetTaskDefinitionArn ? { targetTaskDefinitionArn: outcome.targetTaskDefinitionArn } : {}),
        ...(outcome.targetTaskDefinitionArns
          ? { targetTaskDefinitionArns: outcome.targetTaskDefinitionArns }
          : {}),
      },
      ...(outcome.migration ? { migration: outcome.migration } : {}),
    });
    if (!recorded) {
      return result(command, false, {
        error: 'Rollout in progress, but the relay could not record that it must report back',
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
    return { commandId: command.id, idempotencyKey: command.idempotencyKey, success: false, deferred: true };
  };
}

/** The other half: finish a deploy an earlier invocation started. */
export function createEcsDeployResumer(deps: EcsDeployDeps): () => Promise<RelayCommandResult[]> {
  return async () => {
    const pending = await deps.pending.read();
    if (pending === null || (pending.type !== 'DEPLOY_RELEASE' && pending.type !== 'ROLLBACK')) {
      return [];
    }

    const request = readDeployRequest(pending.payload);
    if (!request) {
      await deps.pending.clear();
      return [
        {
          commandId: pending.commandId,
          idempotencyKey: pending.idempotencyKey,
          success: false,
          error: 'Pending payload lost its imageRepository/imageDigest pair',
        },
      ];
    }

    const rawTarget = pending.payload['targetTaskDefinitionArn'];
    const rawTargetMap = pending.payload['targetTaskDefinitionArns'];
    const targetMap: Record<string, string> = {};
    if (rawTargetMap !== null && typeof rawTargetMap === 'object') {
      for (const [arn, revision] of Object.entries(rawTargetMap as Record<string, unknown>)) {
        if (typeof arn === 'string' && arn.length > 0 && typeof revision === 'string' && revision.length > 0) {
          targetMap[arn] = revision;
        }
      }
    }
    const outcome = await settleEcsDeploy(deps, request, {
      allowMigration: pending.type === 'DEPLOY_RELEASE',
      migration: pending.migration ?? null,
      startedFromZero: pending.payload['startedFromZero'] === true,
      targetTaskDefinitionArn: typeof rawTarget === 'string' ? rawTarget : null,
      ...(Object.keys(targetMap).length > 0 ? { targetTaskDefinitionArns: targetMap } : {}),
    });
    if (outcome.state === 'in-progress') {
      // The moment a migration task is first observed STOPPED + exit 0, pin
      // completion onto the marker: a stopped task ages out of DescribeTasks,
      // and re-polling it on later polls would eventually fail a deploy
      // whose migration already succeeded. One extra write, exactly once.
      if (outcome.migration !== undefined && outcome.migration.completedAt !== pending.migration?.completedAt) {
        await deps.pending.write({ ...pending, migration: outcome.migration });
      }
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

    // Clear first: reporting twice would re-emit the control plane's
    // deploy/rollback event on every poll.
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
            output: { executed: true, type: pending.type, alreadyRunning: outcome.alreadyRunning },
          }
        : {
            commandId: pending.commandId,
            idempotencyKey: pending.idempotencyKey,
            success: false,
            error: outcome.reason,
            ...(outcome.failureCode ? { failureCode: outcome.failureCode } : {}),
            ...(outcome.evidence ? { evidence: outcome.evidence } : {}),
          },
    ];
  };
}

/** The RESTART executor: force a new deployment of EVERY workload's current definition. */
export function createRestartExecutor(deps: EcsDeployDeps): CommandExecutor {
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

    const views = await findServiceViews(deps);
    if (views.length === 0) {
      return result(command, false, {
        error: `No ECS service found in stack "${deps.stackName}"`,
      });
    }
    const cluster = views[0]!.arn.split('/')[1] ?? null;
    if (!cluster) {
      return result(command, false, { error: `Malformed service ARN "${views[0]!.arn}"` });
    }

    try {
      // The services' rolling replacement makes forceNewDeployment safe to
      // re-issue: it never leaves a service with zero tasks. Every workload
      // restarts — a worker has no HTTP surface, so its service replacement
      // is the restart.
      for (const view of views) {
        await deps.ecs.updateService({ cluster, service: view.arn, forceNewDeployment: true });
      }
    } catch (err) {
      return result(command, false, { error: String(err), failureCode: 'AWS_PERMISSION_DENIED' });
    }

    return result(command, true, { output: { executed: true, type: command.type } });
  };
}
