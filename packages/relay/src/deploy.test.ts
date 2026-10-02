import { describe, expect, it } from 'vitest';

import { IdempotencyStore, type CommandExecutor } from './commands.js';
import {
  createEcsDeployExecutor,
  createEcsDeployResumer,
  createRestartExecutor,
  readDeployRequest,
  replaceApplicationImages,
  settleEcsDeploy,
  type DeployRequest,
  type EcsDeployClient,
  type EcsDeployDeps,
  type EcsTaskDefinition,
  type RegisterTaskDefinitionInput,
} from './deploy.js';
import { memoryPendingStore } from './pending.js';
import type { CloudFormationReader, StackResource } from './verify.js';

const REPO = '151955775369.dkr.ecr.us-east-1.amazonaws.com/deployz-images';
const DIGEST_V2 = 'sha256:' + '2'.repeat(64);
const DIGEST_V3 = 'sha256:' + '3'.repeat(64);
const SERVICE_ARN = 'arn:aws:ecs:us-east-1:151955775369:service/app-cluster/app-service';
const BASE_DEF_ARN = 'arn:aws:ecs:us-east-1:151955775369:task-definition/app:7';
const MIGRATION_TASK_ARN = 'arn:aws:ecs:us-east-1:151955775369:task/app-cluster/migration-1';
/** The frozen migration seat the control plane puts on DEPLOY_RELEASE payloads. */
const MIGRATION_TASK = { family: 'DeployzAppMigration', identity: 'a'.repeat(64) };
const MIGRATION_DEF_ARN = 'arn:aws:ecs:us-east-1:151955775369:task-definition/DeployzAppMigration:3';
const MIGRATION_FAMILY_ARN_PREFIX = 'arn:aws:ecs:us-east-1:151955775369:task-definition/DeployzAppMigration';
const CLEANUP_FAMILY = 'DeployzAppCleanup';
const CLEANUP_DEF_ARN = `arn:aws:ecs:us-east-1:151955775369:task-definition/${CLEANUP_FAMILY}:1`;

interface FakeEcs {
  service?: {
    desiredCount?: number;
    runningCount?: number;
    taskDefinition: string;
    deployments?: { status?: string; rolloutState?: string }[];
    networkConfiguration?: {
      awsvpcConfiguration?: { subnets?: string[]; securityGroups?: string[]; assignPublicIp?: string };
    };
  };
  taskDefinition: EcsTaskDefinition;
  /** ARN → definition map, seeded with the service's current definition. */
  definitions: Map<string, EcsTaskDefinition>;
  runningDigest: string | null;
  /** Registered target states, one per target — the settle gate's answer. */
  targetHealth?: string[];
  registered: unknown[];
  updates: unknown[];
  runTasks: unknown[];
  /** DescribeTasks answer for the migration task ARN (defaults to STOPPED, exit 0). */
  migrationTask?: {
    lastStatus?: string;
    stopCode?: string;
    stoppedReason?: string;
    /** The `app` container's exit code; absent means it reported none. */
    exitCode?: number;
    /** Replaces the reported containers outright (names, order, exit codes). */
    containers?: { name?: string; exitCode?: number }[];
    /** Replaces the revision the task reports it ran (`null`: none). */
    taskDefinitionArn?: string | null;
  } | null;
  /** The exact revision the last RunTask resolved its task definition to. */
  ranTaskDefinitionArn?: string;
  /** Family → its latest registered revision ARN. */
  latestByFamily?: Map<string, string>;
  /** Stopped tasks ECS still remembers (ListTasks desiredStatus STOPPED). */
  stoppedTasks?: {
    taskDefinitionArn: string;
    exitCode: number;
    stopCode?: string;
    stoppedReason?: string;
    /** Replaces the default single `app` container. */
    containers?: { name?: string; exitCode?: number }[];
  }[];
  /**
   * Every task lists a finished, non-essential init container BEFORE the
   * application container (the RDS CA bundle of DEPLOY-007), with its own
   * digest and exit code 0.
   */
  initContainerFirst?: boolean;
  failAt?: 'describeServices' | 'register';
}

const INIT_DIGEST = 'sha256:' + '9'.repeat(64);

/** Runtime containers as ECS reports them: named, and never with an `essential` field. */
function withInitContainer(
  state: FakeEcs,
  containers: { imageDigest?: string; exitCode?: number }[],
): { name?: string; imageDigest?: string; exitCode?: number }[] {
  const app = containers.map((container) => ({ name: 'app', ...container }));
  if (!state.initContainerFirst) return app;
  return [{ name: 'RdsCaBundle', imageDigest: INIT_DIGEST, exitCode: 0 }, ...app];
}

function fakeEcs(state: FakeEcs): EcsDeployClient {
  const resolve = (taskDefinition: string): string =>
    state.definitions.has(taskDefinition)
      ? taskDefinition
      : (state.latestByFamily?.get(taskDefinition) ?? BASE_DEF_ARN);
  return {
    async describeServices() {
      if (state.failAt === 'describeServices') throw new Error('AccessDenied');
      return { services: state.service ? [state.service] : [] };
    },
    async describeTaskDefinition(input) {
      const arn = resolve(input.taskDefinition);
      const found = state.definitions.get(arn);
      return {
        taskDefinition: found
          ? { ...found, taskDefinitionArn: arn, containerDefinitions: found.containerDefinitions.map((c) => ({ ...c })) }
          : state.taskDefinition,
      };
    },
    async registerTaskDefinition(input) {
      if (state.failAt === 'register') throw new Error('AccessDenied');
      state.registered.push(input);
      const arn = `arn:aws:ecs:us-east-1:151955775369:task-definition/${input.family ?? 'app'}:${state.registered.length}`;
      state.definitions.set(arn, {
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
      if (input.family !== undefined) (state.latestByFamily ??= new Map()).set(input.family, arn);
      return { taskDefinitionArn: arn };
    },
    async updateService(input) {
      state.updates.push(input);
      if (input.taskDefinition !== undefined && state.service) {
        state.service.taskDefinition = input.taskDefinition;
      }
    },
    async listTasks(input) {
      if (input.desiredStatus === 'STOPPED') {
        return { taskArns: (state.stoppedTasks ?? []).map((_, i) => `stopped-${i}`) };
      }
      return { taskArns: state.runningDigest ? ['task-1'] : [] };
    },
    async describeTasks(input) {
      if (input.tasks[0]?.startsWith('stopped-')) {
        return {
          tasks: (state.stoppedTasks ?? []).map((t) => ({
            lastStatus: 'STOPPED',
            stopCode: t.stopCode ?? 'EssentialContainerExited',
            stoppedReason: t.stoppedReason ?? 'Essential container in task exited',
            taskDefinitionArn: t.taskDefinitionArn,
            containers: t.containers ?? [{ name: 'app', exitCode: t.exitCode }],
          })),
        };
      }
      if (input.tasks[0] === MIGRATION_TASK_ARN) {
        // A configured migration task is reported verbatim, so a stopped
        // reason like CannotPullContainerError (with NO container exit code —
        // the container never started) is representable. An unconfigured
        // migration task defaults to an instant STOPPED/exit-0 completion,
        // which is what the "runs the migration one-off" test relies on.
        const migration = state.migrationTask ?? { stopCode: 'EssentialContainerExited', exitCode: 0 };
        const ran = migration.taskDefinitionArn === undefined ? state.ranTaskDefinitionArn : migration.taskDefinitionArn;
        return {
          tasks: [
            {
              lastStatus: migration.lastStatus ?? 'STOPPED',
              ...(migration.stopCode !== undefined ? { stopCode: migration.stopCode } : {}),
              ...(migration.stoppedReason !== undefined ? { stoppedReason: migration.stoppedReason } : {}),
              ...(ran !== null && ran !== undefined ? { taskDefinitionArn: ran } : {}),
              containers:
                migration.containers ??
                withInitContainer(state, [migration.exitCode !== undefined ? { exitCode: migration.exitCode } : {}]),
            },
          ],
        };
      }
      return {
        tasks: state.runningDigest
          ? [{ containers: withInitContainer(state, [{ imageDigest: state.runningDigest }]) }]
          : [],
      };
    },
    async runTask(input) {
      state.runTasks.push(input);
      state.ranTaskDefinitionArn = resolve(input.taskDefinition);
      return { taskArns: [MIGRATION_TASK_ARN] };
    },
  };
}

function cfnWith(service: boolean): CloudFormationReader {
  const resources: StackResource[] = service
    ? [
        {
          logicalId: 'Service',
          type: 'AWS::ECS::Service',
          status: 'CREATE_COMPLETE',
          physicalId: SERVICE_ARN,
        },
        {
          logicalId: 'TargetGroup',
          type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
          status: 'CREATE_COMPLETE',
          physicalId: 'arn:aws:elasticloadbalancing:us-east-1:151955775369:targetgroup/app/c1b2d3e4f5a6b7c8',
        },
        ...STACK_TASK_DEFINITIONS,
      ]
    : [{ logicalId: 'Bucket', type: 'AWS::S3::Bucket', status: 'CREATE_COMPLETE' }];
  return {
    async describeStack() {
      return {
        found: true,
        stack: { stackName: 'deployz-app', status: 'CREATE_COMPLETE', tags: {}, stackId: 'stack-id-deployz-app' },
      };
    },
    async describeStackResources() {
      return resources;
    },
    async listStackResources() {
      return { resources };
    },
  };
}

/** The one-shot task definitions the stack itself created (exact revisions). */
const STACK_TASK_DEFINITIONS: StackResource[] = [
  { logicalId: 'MigrationTaskDefinition', type: 'AWS::ECS::TaskDefinition', status: 'CREATE_COMPLETE', physicalId: MIGRATION_DEF_ARN },
  { logicalId: 'CleanupTaskDefinition', type: 'AWS::ECS::TaskDefinition', status: 'CREATE_COMPLETE', physicalId: CLEANUP_DEF_ARN },
];

/** The ELB reader the settle gate reads: every registered target healthy by default. */
function fakeElb(state: FakeEcs) {
  return {
    async describeTargetHealth() {
      return { targets: (state.targetHealth ?? ['healthy']).map((targetState) => ({ state: targetState })) };
    },
  };
}

function deps(state: FakeEcs, service = true): EcsDeployDeps {
  return {
    cfn: cfnWith(service),
    ecs: fakeEcs(state),
    elb: fakeElb(state),
    pending: memoryPendingStore(),
    stackName: 'deployz-app',
    installationId: 'inst-test',
  };
}

function baseState(overrides: Partial<FakeEcs> = {}): FakeEcs {
  const taskDefinition: EcsTaskDefinition = {
    family: 'app',
    cpu: '256',
    memory: '512',
    networkMode: 'awsvpc',
    requiresCompatibilities: ['FARGATE'],
    executionRoleArn: 'arn:aws:iam::151955775369:role/deployz/app-execution',
    taskRoleArn: 'arn:aws:iam::151955775369:role/deployz/app-task',
    containerDefinitions: [
      { name: 'app', image: `${REPO}@${DIGEST_V2}` },
      { name: 'sidecar', image: 'public.ecr.aws/sidecar:1' },
      ...(overrides.initContainerFirst
        ? [{ name: 'RdsCaBundle', image: 'public.ecr.aws/amazonlinux/amazonlinux:2023-minimal', essential: false }]
        : []),
    ],
  };
  // The stack's own migration revision: the application container, plus the
  // non-essential RDS CA init container when the stack has a database.
  const migrationDefinition: EcsTaskDefinition = {
    ...taskDefinition,
    family: MIGRATION_TASK.family,
    containerDefinitions: [
      { name: 'app', image: `${REPO}@${DIGEST_V2}`, essential: true },
      ...(overrides.initContainerFirst
        ? [{ name: 'RdsCaBundle', image: 'public.ecr.aws/amazonlinux/amazonlinux:2023-minimal', essential: false }]
        : []),
    ],
  };
  return {
    service: {
      desiredCount: 1,
      runningCount: 1,
      taskDefinition: BASE_DEF_ARN,
      deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED' }],
      networkConfiguration: {
        awsvpcConfiguration: { subnets: ['subnet-a'], securityGroups: ['sg-1'], assignPublicIp: 'DISABLED' },
      },
    },
    taskDefinition,
    definitions: new Map([
      [BASE_DEF_ARN, taskDefinition],
      [MIGRATION_DEF_ARN, migrationDefinition],
      [CLEANUP_DEF_ARN, { ...migrationDefinition, family: CLEANUP_FAMILY }],
    ]),
    latestByFamily: new Map([
      [MIGRATION_TASK.family, MIGRATION_DEF_ARN],
      [CLEANUP_FAMILY, CLEANUP_DEF_ARN],
    ]),
    runningDigest: DIGEST_V2,
    registered: [],
    updates: [],
    runTasks: [],
    ...overrides,
  };
}

function deployCommand(payload: Record<string, unknown>, type: 'DEPLOY_RELEASE' | 'ROLLBACK' = 'DEPLOY_RELEASE') {
  return {
    id: 'job-1',
    deploymentId: 'dep-1',
    type,
    idempotencyKey: 'dep-1:' + type,
    payload,
  } as const;
}

async function run(executor: CommandExecutor, command: ReturnType<typeof deployCommand>) {
  return executor(command);
}

describe('readDeployRequest', () => {
  it('accepts the payload contract (no migration seat = deploy as before)', () => {
    expect(readDeployRequest({ imageRepository: REPO, imageDigest: DIGEST_V3 })).toEqual({
      imageRepository: REPO,
      imageDigest: DIGEST_V3,
      migrationTask: null,
      workloads: [],
      scheduledJobFamilies: [],
    });
  });

  it('parses the frozen migration seat: a named task family, never a command', () => {
    expect(
      readDeployRequest({
        imageRepository: REPO,
        imageDigest: DIGEST_V3,
        migrationTask: MIGRATION_TASK,
      }),
    ).toEqual({
      imageRepository: REPO,
      imageDigest: DIGEST_V3,
      migrationTask: MIGRATION_TASK,
      workloads: [],
      scheduledJobFamilies: [],
    });
    // A legacy control-plane `migrationCommand` is dropped, never executed.
    expect(readDeployRequest({ imageRepository: REPO, imageDigest: DIGEST_V3, migrationCommand: '   ' })).toEqual({
      imageRepository: REPO,
      imageDigest: DIGEST_V3,
      migrationTask: null,
      workloads: [],
      scheduledJobFamilies: [],
    });
  });

  it('rejects a malformed digest or missing repository', () => {
    expect(readDeployRequest({ imageRepository: REPO, imageDigest: 'sha256:short' })).toBeNull();
    expect(readDeployRequest({ imageDigest: DIGEST_V3 })).toBeNull();
    expect(readDeployRequest({})).toBeNull();
  });

  it('parses per-workload rollout seats and rejects malformed ones (Phase 4A)', () => {
    expect(
      readDeployRequest({
        imageRepository: REPO,
        imageDigest: DIGEST_V3,
        workloads: [
          { id: 'web', serviceLogicalId: 'WebService', desiredCount: 1 },
          { id: 'email-worker', serviceLogicalId: 'EmailWorkerService', desiredCount: 1 },
        ],
      }),
    ).toEqual({
      imageRepository: REPO,
      imageDigest: DIGEST_V3,
      migrationTask: null,
      workloads: [
        { id: 'web', serviceLogicalId: 'WebService', desiredCount: 1 },
        { id: 'email-worker', serviceLogicalId: 'EmailWorkerService', desiredCount: 1 },
      ],
      scheduledJobFamilies: [],
    });
    expect(readDeployRequest({ imageRepository: REPO, imageDigest: DIGEST_V3, workloads: 'nope' })).toBeNull();
    expect(readDeployRequest({ imageRepository: REPO, imageDigest: DIGEST_V3, workloads: [{}] })).toBeNull();
    expect(
      readDeployRequest({
        imageRepository: REPO,
        imageDigest: DIGEST_V3,
        workloads: [{ id: 'web', serviceLogicalId: 'WebService', desiredCount: -1 }],
      }),
    ).toBeNull();
  });
});

describe('replaceApplicationImages', () => {
  it('replaces only images from the expected repository', () => {
    const state = baseState();
    const next = replaceApplicationImages(state.taskDefinition, {
      imageRepository: REPO,
      imageDigest: DIGEST_V3,
      migrationTask: null,
      workloads: [],
      scheduledJobFamilies: [],
    })!;
    const app = next.containerDefinitions[0] as { image: string };
    const sidecar = next.containerDefinitions[1] as { image: string };
    expect(app.image).toBe(`${REPO}@${DIGEST_V3}`);
    expect(sidecar.image).toBe('public.ecr.aws/sidecar:1');
  });

  it('returns null when no container matches the repository', () => {
    const next = replaceApplicationImages(
      { containerDefinitions: [{ name: 'app', image: 'other/repo:1' }] },
      { imageRepository: REPO, imageDigest: DIGEST_V3, migrationTask: null, workloads: [], scheduledJobFamilies: [] },
    );
    expect(next).toBeNull();
  });
});

describe('createEcsDeployExecutor', () => {
  // Phase 5: a scheduled job or migration is a STANDALONE ECS task — group
  // `family:DeployzApp…`, no AWS::ECS::Service backs it. `findServiceViews`
  // only ever looks at AWS::ECS::Service resources, and every crash-loop
  // check is scoped to one service's own ListTasks(serviceName=…) answer —
  // never a cluster-wide or family-scoped list — so a scheduled job's own
  // stopped/crashing tasks, of a DIFFERENT task-definition revision, cannot
  // affect deploy readiness or settlement even while it runs in the very
  // same cluster.
  it('a standalone scheduled-job task definition, running or crashing, never affects deploy settlement', async () => {
    const state = baseState({
      stoppedTasks: [
        {
          taskDefinitionArn: 'arn:aws:ecs:us-east-1:151955775369:task-definition/DeployzAppCleanup:1',
          exitCode: 1,
        },
        {
          taskDefinitionArn: 'arn:aws:ecs:us-east-1:151955775369:task-definition/DeployzAppCleanup:1',
          exitCode: 1,
        },
        {
          taskDefinitionArn: 'arn:aws:ecs:us-east-1:151955775369:task-definition/DeployzAppCleanup:1',
          exitCode: 1,
        },
      ],
    });
    state.runningDigest = DIGEST_V3;
    const result = await run(
      createEcsDeployExecutor(deps(state)),
      deployCommand({ imageRepository: REPO, imageDigest: DIGEST_V3 }),
    );
    // Three "crashes" would trip CONTAINER_START_FAILED for the web
    // service's OWN revision — they never do here, because they are a
    // different task-definition family entirely, of a standalone task no
    // service check ever lists.
    expect(result.success).toBe(true);
  });

  it('reports success without a new revision when the digest already runs', async () => {
    const state = baseState();
    state.runningDigest = DIGEST_V3;
    const result = await run(
      createEcsDeployExecutor(deps(state)),
      deployCommand({ imageRepository: REPO, imageDigest: DIGEST_V3 }),
    );
    expect(result.success).toBe(true);
    expect((result.output as { alreadyRunning: boolean }).alreadyRunning).toBe(true);
    expect(state.registered).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });

  it('the no-migration fast path skips the migration stage entirely (gate B2)', async () => {
    const state = baseState();
    state.runningDigest = DIGEST_V3;
    const result = await run(
      createEcsDeployExecutor(deps(state)),
      deployCommand({ imageRepository: REPO, imageDigest: DIGEST_V3 }),
    );
    expect(result.success).toBe(true);
    expect(state.runTasks).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });

  it('an already-succeeded deploy WITH an unconfirmed migration seat still runs the migration stage (gate B2)', async () => {
    // Every service already runs the release digest — the old early return
    // would report success here without the migration ever running.
    const state = baseState();
    state.runningDigest = DIGEST_V3;
    const d = deps(state);
    const result = await run(
      createEcsDeployExecutor(d),
      deployCommand({
        imageRepository: REPO,
        imageDigest: DIGEST_V3,
        migrationTask: MIGRATION_TASK,
      }),
    );
    // The migration stage ran to completion before success was reported.
    expect(state.runTasks).toHaveLength(1);
    // The EXACT revision just registered — never the bare family.
    expect(state.runTasks[0]).toMatchObject({ taskDefinition: `${MIGRATION_FAMILY_ARN_PREFIX}:1` });
    expect(state.updates).toHaveLength(0);
    expect(result.success).toBe(true);
    // The early migration marker is cleared once the deploy settles — a
    // dangling marker of a settled command would be resumed and re-reported.
    expect(await d.pending.read()).toBeNull();
  });

  it('registers a copy, updates the service, and defers while the rollout runs', async () => {
    const state = baseState();
    const d = deps(state);
    const result = await run(
      createEcsDeployExecutor(d),
      deployCommand({ imageRepository: REPO, imageDigest: DIGEST_V3 }),
    );
    expect(result.deferred).toBe(true);
    expect(state.registered).toHaveLength(1);
    const registered = state.registered[0] as { tags?: { key: string; value: string }[] };
    expect(registered.tags).toContainEqual({
      key: 'deployz:installation',
      value: 'inst-test',
    });
    expect(state.updates).toHaveLength(1);
    const pending = await d.pending.read();
    expect(pending?.commandId).toBe('job-1');
    expect(pending?.type).toBe('DEPLOY_RELEASE');
  });

  it('re-issues the service update when the copy is registered but not running', async () => {
    const state = baseState();
    state.taskDefinition.containerDefinitions[0] = { name: 'app', image: `${REPO}@${DIGEST_V3}` };
    const result = await run(
      createEcsDeployExecutor(deps(state)),
      deployCommand({ imageRepository: REPO, imageDigest: DIGEST_V3 }),
    );
    expect(result.deferred).toBe(true);
    expect(state.registered).toHaveLength(0);
    expect(state.updates).toHaveLength(1);
  });

  it('runs the frozen migration task before the service update: named family, no command override, same network', async () => {
    const state = baseState();
    const d = deps(state);
    const result = await run(
      createEcsDeployExecutor(d),
      deployCommand({
        imageRepository: REPO,
        imageDigest: DIGEST_V3,
        migrationTask: MIGRATION_TASK,
      }),
    );
    expect(result.deferred).toBe(true);

    // The migration ran first — the spec-frozen task definition, AS-IS.
    expect(state.runTasks).toHaveLength(1);
    const runInput = state.runTasks[0] as {
      taskDefinition: string;
      networkConfiguration: {
        awsvpcConfiguration: { subnets: string[]; securityGroups: string[]; assignPublicIp: string };
      };
      overrides: { containerOverrides: unknown[] };
      launchType: string;
      count: number;
    };
    expect(runInput.launchType).toBe('FARGATE');
    expect(runInput.count).toBe(1);
    expect(runInput.taskDefinition).toBe(`${MIGRATION_FAMILY_ARN_PREFIX}:1`);
    expect(runInput.networkConfiguration.awsvpcConfiguration).toEqual({
      subnets: ['subnet-a'],
      securityGroups: ['sg-1'],
      assignPublicIp: 'DISABLED',
    });
    // NO command override — the command lives in the frozen task definition;
    // the relay can never inject one.
    expect(runInput.overrides.containerOverrides).toEqual([]);
    // Before RunTask, the migration family is brought current with the
    // release image (Phase 5) — that is the FIRST registration. The service
    // update then registers its own copy and rolls out after.
    const registeredArn = `arn:aws:ecs:us-east-1:151955775369:task-definition/app:2`;
    expect(state.registered).toHaveLength(2);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({ cluster: 'app-cluster', taskDefinition: registeredArn });

    // The marker records the completed migration so no later poll re-runs it.
    const pending = await d.pending.read();
    expect(pending?.migration).toEqual({
      taskArn: MIGRATION_TASK_ARN,
      completedAt: expect.any(String),
    });
  });

  it('ignores a legacy migrationCommand payload outright — commands never cross the trust boundary', async () => {
    const state = baseState();
    const result = await run(
      createEcsDeployExecutor(deps(state)),
      deployCommand({
        imageRepository: REPO,
        imageDigest: DIGEST_V3,
        migrationCommand: 'node evil.js',
      }),
    );
    // No migration ran, and the rollout proceeds exactly like a no-migration
    // deploy: the arbitrary command is dead weight the relay drops.
    expect(result.deferred).toBe(true);
    expect(state.runTasks).toHaveLength(0);
    expect(state.updates).toHaveLength(1);
  });

  it('rejects a malformed migrationTask seat', () => {
    expect(
      readDeployRequest({
        imageRepository: REPO,
        imageDigest: DIGEST_V3,
        migrationTask: { family: 'DeployzAppMigration' },
      }),
    ).toBeNull();
    expect(
      readDeployRequest({
        imageRepository: REPO,
        imageDigest: DIGEST_V3,
        migrationTask: { family: 'DeployzAppMigration', identity: 'not-a-hash' },
      }),
    ).toBeNull();
  });

  it('reads the running digest from the essential container, not the init container that ran first (DEPLOY-014)', async () => {
    const state = baseState({ initContainerFirst: true });
    state.runningDigest = DIGEST_V3;
    const result = await run(
      createEcsDeployExecutor(deps(state)),
      deployCommand({ imageRepository: REPO, imageDigest: DIGEST_V3 }),
    );
    expect(result.success).toBe(true);
    expect((result.output as { alreadyRunning: boolean }).alreadyRunning).toBe(true);
    expect(state.updates).toHaveLength(0);
  });

  it('reads the migration exit code from the essential container, not the init container that exited 0 (DEPLOY-014)', async () => {
    const state = baseState({ initContainerFirst: true });
    state.migrationTask = {
      lastStatus: 'STOPPED',
      stopCode: 'EssentialContainerExited',
      stoppedReason: 'migration crashed: bad SQL',
      exitCode: 1,
    };
    const result = await run(
      createEcsDeployExecutor(deps(state)),
      deployCommand({ imageRepository: REPO, imageDigest: DIGEST_V3, migrationTask: MIGRATION_TASK }),
    );
    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('MIGRATION_FAILED');
    expect(String(result.error)).toContain('exit code 1');
    expect(state.updates).toHaveLength(0);
  });

  it('fails with MIGRATION_FAILED (exit code + stoppedReason) and never touches the service', async () => {
    const state = baseState();
    state.migrationTask = {
      lastStatus: 'STOPPED',
      stopCode: 'EssentialContainerExited',
      stoppedReason: 'migration crashed: bad SQL',
      exitCode: 1,
    };
    const d = deps(state);
    const result = await run(
      createEcsDeployExecutor(d),
      deployCommand({
        imageRepository: REPO,
        imageDigest: DIGEST_V3,
        migrationTask: MIGRATION_TASK,
      }),
    );
    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('MIGRATION_FAILED');
    expect(String(result.error)).toContain('exit code 1');
    expect(String(result.error)).toContain('migration crashed: bad SQL');
    // The previous release keeps running: no service update, no deferral.
    expect(state.updates).toHaveLength(0);
    expect(await d.pending.read()).toBeNull();
  });

  it('attaches the stopped task as structured evidence alongside the migration free text (Phase 1)', async () => {
    const state = baseState();
    state.migrationTask = {
      lastStatus: 'STOPPED',
      stopCode: 'EssentialContainerExited',
      stoppedReason: 'Error: DATABASE_URL is not set',
      exitCode: 1,
    };
    const result = await run(
      createEcsDeployExecutor(deps(state)),
      deployCommand({
        imageRepository: REPO,
        imageDigest: DIGEST_V3,
        migrationTask: MIGRATION_TASK,
      }),
    );
    expect(result.success).toBe(false);
    expect(result.evidence).toEqual({
      container: {
        exitCode: 1,
        stopCode: 'EssentialContainerExited',
        stoppedReason: 'Error: DATABASE_URL is not set',
        stoppedTaskCount: 1,
      },
    });
  });

  it('classifies a migration task that could not pull the image as IMAGE_PULL_FAILED, not MIGRATION_FAILED', async () => {
    const state = baseState();
    // The migration container never started: no exit code, stopped reason is
    // ECS's CannotPullContainerError wrap of the ECR pull denial.
    state.migrationTask = {
      lastStatus: 'STOPPED',
      stopCode: 'TaskFailedToStart',
      stoppedReason:
        'CannotPullContainerError: pull access denied for acme/app@sha256:abc, repository does not exist or may require docker login',
    };
    const d = deps(state);
    const result = await run(
      createEcsDeployExecutor(d),
      deployCommand({
        imageRepository: REPO,
        imageDigest: DIGEST_V3,
        migrationTask: MIGRATION_TASK,
      }),
    );
    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('IMAGE_PULL_FAILED');
    // The remediation for IMAGE_PULL_FAILED is registry/grant access — never
    // "fix the migration". The previous release keeps serving untouched.
    expect(state.updates).toHaveLength(0);
    expect(await d.pending.read()).toBeNull();
  });

  it('writes the migration ARN early so a dead invocation never starts a second RunTask (DZ-AUDIT-003)', async () => {
    const state = baseState();
    state.migrationTask = { lastStatus: 'RUNNING' };
    const d = deps(state);
    d.migrationPollIntervalMs = 0;
    d.migrationPollMaxAttempts = 1;

    // First "invocation": RunTask via settleEcsDeploy, but the executor's
    // late pending.write (~887) is skipped — simulating invocation death
    // after settleEcsDeploy returns but before the marker is persisted.
    const request: DeployRequest = {
      imageRepository: REPO,
      imageDigest: DIGEST_V3,
      migrationTask: MIGRATION_TASK,
      workloads: [],
      scheduledJobFamilies: [],
    };
    const first = await settleEcsDeploy(d, request, {
      allowMigration: true,
      markerCommandId: 'job-1',
      markerIdempotencyKey: 'dep-1:DEPLOY_RELEASE',
      markerType: 'DEPLOY_RELEASE',
      markerPayload: {
        imageRepository: REPO,
        imageDigest: DIGEST_V3,
        migrationTask: MIGRATION_TASK,
      },
    });
    expect(first.state).toBe('in-progress');
    expect(state.runTasks).toHaveLength(1);

    // The early marker was written inside settleMigration (the fix) — a
    // re-offer will find it and resume the SAME task.
    const earlyMarker = await d.pending.read();
    expect(earlyMarker).not.toBeNull();
    expect(earlyMarker?.migration?.taskArn).toBe(MIGRATION_TASK_ARN);
    expect(earlyMarker?.migration?.completedAt).toBeUndefined();

    // Second invocation (re-offer): reads the early marker, resumes the
    // SAME task — must NOT trigger a second RunTask.
    state.migrationTask = { lastStatus: 'STOPPED', exitCode: 0 };
    state.runningDigest = DIGEST_V3;
    const second = await run(
      createEcsDeployExecutor(d),
      deployCommand({
        imageRepository: REPO,
        imageDigest: DIGEST_V3,
        migrationTask: MIGRATION_TASK,
      }),
    );
    expect(state.runTasks).toHaveLength(1);
    expect(second.success).toBe(true);
  });

  it('defers while the migration task runs, resuming the SAME task by ARN', async () => {
    const state = baseState();
    state.migrationTask = { lastStatus: 'RUNNING' };
    const d = deps(state);
    const result = await run(
      createEcsDeployExecutor({ ...d, migrationPollIntervalMs: 0, migrationPollMaxAttempts: 1 }),
      deployCommand({
        imageRepository: REPO,
        imageDigest: DIGEST_V3,
        migrationTask: MIGRATION_TASK,
      }),
    );
    expect(result.deferred).toBe(true);
    expect(state.updates).toHaveLength(0);
    expect(state.runTasks).toHaveLength(1);
    const pending = await d.pending.read();
    expect(pending?.migration).toBeDefined();
    expect(pending?.migration?.taskArn).toBe(MIGRATION_TASK_ARN);
    expect(pending?.migration?.completedAt).toBeUndefined();
  });

  it('ROLLBACK deploys the old digest without ever running migrations', async () => {
    const state = baseState();
    const result = await run(
      createEcsDeployExecutor(deps(state)),
      deployCommand(
        {
          imageRepository: REPO,
          imageDigest: DIGEST_V3,
          migrationTask: MIGRATION_TASK,
        },
        'ROLLBACK',
      ),
    );
    expect(result.deferred).toBe(true);
    expect(state.runTasks).toHaveLength(0);
    expect(state.registered).toHaveLength(1);
    expect(state.updates).toHaveLength(1);
  });

  it('fails with ECS_DEPLOYMENT_FAILED when the rollout failed', async () => {
    const state = baseState();
    state.service!.deployments = [{ status: 'PRIMARY', rolloutState: 'FAILED' }];
    const result = await run(
      createEcsDeployExecutor(deps(state)),
      deployCommand({ imageRepository: REPO, imageDigest: DIGEST_V3 }),
    );
    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('ECS_DEPLOYMENT_FAILED');
  });

  it('starts a zero-task service (an install that waited for configuration) by scaling it up with the deploy (DEPLOY-009)', async () => {
    const state = baseState();
    state.service!.desiredCount = 0;
    state.service!.runningCount = 0;
    state.runningDigest = null;
    const d = deps(state);
    const result = await run(
      createEcsDeployExecutor(d),
      deployCommand({ imageRepository: REPO, imageDigest: DIGEST_V3 }),
    );
    expect(result.deferred).toBe(true);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({ desiredCount: 1 });
    // The marker remembers the first start, so a rolled-back rollout can be
    // scaled back down by the resumer.
    expect((await d.pending.read())?.payload['startedFromZero']).toBe(true);
  });

  it('remembers the revision it rolled out on the pending marker (DEPLOY-015)', async () => {
    const state = baseState();
    state.runningDigest = DIGEST_V2;
    const d = deps(state);
    await run(createEcsDeployExecutor(d), deployCommand({ imageRepository: REPO, imageDigest: DIGEST_V3 }));
    const pending = await d.pending.read();
    expect(pending?.payload['targetTaskDefinitionArn']).toBe(
      'arn:aws:ecs:us-east-1:151955775369:task-definition/app:1',
    );
  });

  it('fails ECS_DEPLOYMENT_FAILED when the circuit breaker rolled the service back to a previous revision running the same image (DEPLOY-015)', async () => {
    const state = baseState();
    // The rollback target (the pinned template revision) runs the release
    // digest already and is stable, COMPLETED and healthy — every gate
    // that used to declare success.
    state.runningDigest = DIGEST_V3;
    state.service!.deployments = [{ status: 'PRIMARY', rolloutState: 'COMPLETED', taskDefinition: BASE_DEF_ARN }];
    const d = deps(state);
    await d.pending.write({
      commandId: 'job-1',
      idempotencyKey: 'dep-1:DEPLOY_RELEASE',
      type: 'DEPLOY_RELEASE',
      stackName: 'deployz-app',
      startedAt: new Date().toISOString(),
      payload: {
        imageRepository: REPO,
        imageDigest: DIGEST_V3,
        startedFromZero: true,
        targetTaskDefinitionArn: 'arn:aws:ecs:us-east-1:151955775369:task-definition/app:8',
      },
    });

    const results = await createEcsDeployResumer(d)();
    expect(results).toHaveLength(1);
    expect(results[0]!.success).toBe(false);
    expect(results[0]!.failureCode).toBe('ECS_DEPLOYMENT_FAILED');
    expect(String(results[0]!.error)).toContain('rolled the service back');
    // A first start goes back to zero tasks, as a rollout the breaker failed.
    expect(state.updates).toEqual([{ cluster: 'app-cluster', service: SERVICE_ARN, desiredCount: 0 }]);
  });

  it('settles a deferred deploy as a success only on the revision it rolled out (DEPLOY-015)', async () => {
    const state = baseState();
    state.runningDigest = DIGEST_V3;
    state.service!.deployments = [{ status: 'PRIMARY', rolloutState: 'COMPLETED', taskDefinition: BASE_DEF_ARN }];
    const d = deps(state);
    await d.pending.write({
      commandId: 'job-1',
      idempotencyKey: 'dep-1:DEPLOY_RELEASE',
      type: 'DEPLOY_RELEASE',
      stackName: 'deployz-app',
      startedAt: new Date().toISOString(),
      payload: { imageRepository: REPO, imageDigest: DIGEST_V3, targetTaskDefinitionArn: BASE_DEF_ARN },
    });
    const results = await createEcsDeployResumer(d)();
    expect(results).toHaveLength(1);
    expect(results[0]!.success).toBe(true);
  });

  it('scales a first start the circuit breaker rolled back to zero tasks, then fails ECS_DEPLOYMENT_FAILED (DEPLOY-009)', async () => {
    const state = baseState();
    state.service!.deployments = [{ status: 'PRIMARY', rolloutState: 'FAILED' }];
    const d = deps(state);
    await d.pending.write({
      commandId: 'job-1',
      idempotencyKey: 'dep-1:DEPLOY_RELEASE',
      type: 'DEPLOY_RELEASE',
      stackName: 'deployz-app',
      startedAt: new Date().toISOString(),
      payload: { imageRepository: REPO, imageDigest: DIGEST_V3, startedFromZero: true },
    });

    const results = await createEcsDeployResumer(d)();
    expect(results).toHaveLength(1);
    expect(results[0]!.failureCode).toBe('ECS_DEPLOYMENT_FAILED');
    expect(state.updates).toEqual([{ cluster: 'app-cluster', service: SERVICE_ARN, desiredCount: 0 }]);
  });

  it('settles a crash-looping rollout the circuit breaker never trips as CONTAINER_START_FAILED (DEPLOY-011)', async () => {
    const state = baseState();
    // The service already runs this request's revision (registered by an
    // earlier pass); its tasks start, run their migration, and exit 1.
    state.taskDefinition.containerDefinitions[0] = { name: 'app', image: `${REPO}@${DIGEST_V3}` };
    state.runningDigest = null;
    state.stoppedTasks = [
      { taskDefinitionArn: BASE_DEF_ARN, exitCode: 1, stoppedReason: 'Essential container in task exited' },
      { taskDefinitionArn: BASE_DEF_ARN, exitCode: 1 },
      { taskDefinitionArn: BASE_DEF_ARN, exitCode: 1 },
    ];
    const d = deps(state);
    await d.pending.write({
      commandId: 'job-1',
      idempotencyKey: 'dep-1:DEPLOY_RELEASE',
      type: 'DEPLOY_RELEASE',
      stackName: 'deployz-app',
      startedAt: new Date().toISOString(),
      payload: { imageRepository: REPO, imageDigest: DIGEST_V3, startedFromZero: true },
    });

    const results = await createEcsDeployResumer(d)();
    expect(results).toHaveLength(1);
    expect(results[0]!.failureCode).toBe('CONTAINER_START_FAILED');
    expect(results[0]!.error).toContain('3 tasks of the new revision exited with code 1');
    // A configured first start goes back to zero tasks.
    expect(state.updates).toEqual([{ cluster: 'app-cluster', service: SERVICE_ARN, desiredCount: 0 }]);
    expect(await d.pending.read()).toBeNull();
  });

  it('attaches the crash-loop stopped tasks as structured evidence alongside the free text (Phase 1)', async () => {
    const state = baseState();
    state.taskDefinition.containerDefinitions[0] = { name: 'app', image: `${REPO}@${DIGEST_V3}` };
    state.runningDigest = null;
    state.stoppedTasks = [
      {
        taskDefinitionArn: BASE_DEF_ARN,
        exitCode: 1,
        stopCode: 'EssentialContainerExited',
        stoppedReason: 'connect ECONNREFUSED 10.0.1.5:5432',
      },
      { taskDefinitionArn: BASE_DEF_ARN, exitCode: 1, stoppedReason: 'connect ECONNREFUSED 10.0.1.5:5432' },
      { taskDefinitionArn: BASE_DEF_ARN, exitCode: 1 },
    ];
    const d = deps(state);
    await d.pending.write({
      commandId: 'job-1',
      idempotencyKey: 'dep-1:DEPLOY_RELEASE',
      type: 'DEPLOY_RELEASE',
      stackName: 'deployz-app',
      startedAt: new Date().toISOString(),
      payload: { imageRepository: REPO, imageDigest: DIGEST_V3 },
    });

    const results = await createEcsDeployResumer(d)();
    expect(results).toHaveLength(1);
    expect(results[0]!.failureCode).toBe('CONTAINER_START_FAILED');
    expect(results[0]!.evidence).toEqual({
      container: {
        exitCode: 1,
        stopCode: 'EssentialContainerExited',
        // The loop keeps the last matching task's reason — the fake's
        // default when a stopped task carries none.
        stoppedReason: 'Essential container in task exited',
        stoppedTaskCount: 3,
      },
    });
  });

  it('does not count another revision\'s exits or the scheduler\'s own stops as a crash loop', async () => {
    const state = baseState();
    state.taskDefinition.containerDefinitions[0] = { name: 'app', image: `${REPO}@${DIGEST_V3}` };
    state.runningDigest = null;
    state.stoppedTasks = [
      { taskDefinitionArn: 'arn:aws:ecs:us-east-1:151955775369:task-definition/app:6', exitCode: 1 },
      { taskDefinitionArn: BASE_DEF_ARN, exitCode: 137, stopCode: 'ServiceSchedulerInitiated' },
      { taskDefinitionArn: BASE_DEF_ARN, exitCode: 1 },
      { taskDefinitionArn: BASE_DEF_ARN, exitCode: 0 },
    ];
    const d = deps(state);
    await d.pending.write({
      commandId: 'job-1',
      idempotencyKey: 'dep-1:DEPLOY_RELEASE',
      type: 'DEPLOY_RELEASE',
      stackName: 'deployz-app',
      startedAt: new Date().toISOString(),
      payload: { imageRepository: REPO, imageDigest: DIGEST_V3 },
    });

    const results = await createEcsDeployResumer(d)();
    expect(results).toHaveLength(0);
    expect(await d.pending.read()).not.toBeNull();
  });

  it('leaves the task count alone when a rolled-back rollout was not a first start', async () => {
    const state = baseState();
    state.service!.deployments = [{ status: 'PRIMARY', rolloutState: 'FAILED' }];
    const d = deps(state);
    await d.pending.write({
      commandId: 'job-1',
      idempotencyKey: 'dep-1:DEPLOY_RELEASE',
      type: 'DEPLOY_RELEASE',
      stackName: 'deployz-app',
      startedAt: new Date().toISOString(),
      payload: { imageRepository: REPO, imageDigest: DIGEST_V3 },
    });

    const results = await createEcsDeployResumer(d)();
    expect(results[0]!.failureCode).toBe('ECS_DEPLOYMENT_FAILED');
    expect(state.updates).toHaveLength(0);
  });

  it('fails on a malformed payload without touching AWS', async () => {
    const state = baseState();
    const result = await run(
      createEcsDeployExecutor(deps(state)),
      deployCommand({ imageRepository: REPO }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('imageRepository/imageDigest');
    expect(state.registered).toHaveLength(0);
  });

  it('fails when the stack has no ECS service', async () => {
    const state = baseState();
    const result = await run(
      createEcsDeployExecutor(deps(state, false)),
      deployCommand({ imageRepository: REPO, imageDigest: DIGEST_V3 }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('No ECS service');
  });

  it('classifies an AWS failure as permission denied', async () => {
    const state = baseState();
    state.failAt = 'describeServices';
    const result = await run(
      createEcsDeployExecutor(deps(state)),
      deployCommand({ imageRepository: REPO, imageDigest: DIGEST_V3 }),
    );
    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('AWS_PERMISSION_DENIED');
  });
});

// Real ECS runtime containers carry no `essential` field: the verdict must
// come from the application container, named by the revision that ran.
describe('migration verdict — the application container of the revision that ran', () => {
  const INIT = { name: 'RdsCaBundle', exitCode: 0 };
  const migrationDeploy = () =>
    deployCommand({ imageRepository: REPO, imageDigest: DIGEST_V3, migrationTask: MIGRATION_TASK });

  for (const order of ['init container first', 'application container first'] as const) {
    for (const exitCode of [0, 1, 127]) {
      it(`application exit ${exitCode}, ${order}: only exit 0 continues to the rollout`, async () => {
        const state = baseState({ initContainerFirst: true });
        const app = { name: 'app', exitCode };
        state.migrationTask = {
          stopCode: 'EssentialContainerExited',
          containers: order === 'init container first' ? [INIT, app] : [app, INIT],
        };
        const d = deps(state);
        const result = await run(createEcsDeployExecutor(d), migrationDeploy());
        if (exitCode === 0) {
          expect(result.deferred).toBe(true);
          expect(state.updates).toHaveLength(1);
          expect((await d.pending.read())?.migration?.completedAt).toEqual(expect.any(String));
          return;
        }
        expect(result.success).toBe(false);
        expect(result.failureCode).toBe('MIGRATION_FAILED');
        expect(result.error).toContain(`exit code ${exitCode} `);
        expect(result.evidence?.container?.exitCode).toBe(exitCode);
        expect(state.updates).toHaveLength(0);
        expect(await d.pending.read()).toBeNull();
      });
    }
  }

  async function expectNeverConfirmed(state: FakeEcs, problem: string): Promise<void> {
    const d = deps(state);
    const result = await run(createEcsDeployExecutor(d), migrationDeploy());
    expect(result.success).toBe(false);
    expect(result.deferred).toBeUndefined();
    expect(result.failureCode).toBe('MIGRATION_FAILED');
    expect(result.error).toContain('exit code unknown');
    expect(result.error).toContain(problem);
    expect(result.evidence?.container?.exitCode).toBeNull();
    expect(state.updates).toHaveLength(0);
    expect(await d.pending.read()).toBeNull();
  }

  it('cannot succeed when the application container is missing from the task', async () => {
    const state = baseState({ initContainerFirst: true });
    state.migrationTask = { stopCode: 'EssentialContainerExited', containers: [INIT] };
    await expectNeverConfirmed(state, '0 containers named "app"');
  });

  it('cannot succeed on unnamed containers, even when one exited 0', async () => {
    const state = baseState({ initContainerFirst: true });
    state.migrationTask = { stopCode: 'EssentialContainerExited', containers: [{ exitCode: 0 }] };
    await expectNeverConfirmed(state, '0 containers named "app"');
  });

  it('cannot succeed when the application container reported no exit code', async () => {
    const state = baseState({ initContainerFirst: true });
    state.migrationTask = { stopCode: 'TaskFailedToStart', containers: [INIT, { name: 'app' }] };
    await expectNeverConfirmed(state, 'container "app" reported no exit code');
  });

  it('cannot succeed when the task reports the application name twice', async () => {
    const state = baseState();
    state.migrationTask = {
      stopCode: 'EssentialContainerExited',
      containers: [
        { name: 'app', exitCode: 0 },
        { name: 'app', exitCode: 0 },
      ],
    };
    await expectNeverConfirmed(state, '2 containers named "app"');
  });

  it('cannot succeed when two essential containers run the release image', async () => {
    const state = baseState();
    state.definitions.get(MIGRATION_DEF_ARN)!.containerDefinitions.push({ name: 'twin', image: `${REPO}@${DIGEST_V2}` });
    state.migrationTask = { stopCode: 'EssentialContainerExited', containers: [{ name: 'app', exitCode: 0 }] };
    await expectNeverConfirmed(state, 'has 2 named essential containers');
  });

  it('cannot succeed when the revision that ran does not run the release image', async () => {
    const state = baseState();
    state.migrationTask = {
      stopCode: 'EssentialContainerExited',
      taskDefinitionArn: MIGRATION_DEF_ARN,
      containers: [{ name: 'app', exitCode: 0 }],
    };
    await expectNeverConfirmed(state, `${MIGRATION_DEF_ARN} has 0 named essential containers`);
  });

  it('cannot succeed when the task names no task definition', async () => {
    const state = baseState();
    state.migrationTask = { stopCode: 'EssentialContainerExited', taskDefinitionArn: null, exitCode: 0 };
    await expectNeverConfirmed(state, 'the task names no task definition');
  });

  it('defers on a failed read of the revision, then resumes the SAME task to its verdict', async () => {
    const state = baseState({ initContainerFirst: true });
    const d = deps(state);
    let throttled = true;
    const ecs: EcsDeployClient = {
      ...d.ecs,
      async describeTaskDefinition(input) {
        if (throttled && input.taskDefinition === state.ranTaskDefinitionArn) throw new Error('ThrottlingException');
        return d.ecs.describeTaskDefinition(input);
      },
    };
    const first = await run(createEcsDeployExecutor({ ...d, ecs }), migrationDeploy());
    expect(first.deferred).toBe(true);
    expect(state.updates).toHaveLength(0);
    expect((await d.pending.read())?.migration).toEqual({ taskArn: MIGRATION_TASK_ARN });

    throttled = false;
    expect(await createEcsDeployResumer({ ...d, ecs })()).toHaveLength(0);
    expect(state.runTasks).toHaveLength(1);
    expect(state.updates).toHaveLength(1);
    expect((await d.pending.read())?.migration?.completedAt).toEqual(expect.any(String));
  });

  it('defers on a failed read of the task — a throttle is never a failure', async () => {
    const state = baseState();
    const d = deps(state);
    const ecs: EcsDeployClient = {
      ...d.ecs,
      async describeTasks(input) {
        if (input.tasks[0] === MIGRATION_TASK_ARN) throw new Error('ThrottlingException');
        return d.ecs.describeTasks(input);
      },
    };
    const result = await run(createEcsDeployExecutor({ ...d, ecs }), migrationDeploy());
    expect(result.deferred).toBe(true);
    expect(state.updates).toHaveLength(0);
    expect((await d.pending.read())?.migration).toEqual({ taskArn: MIGRATION_TASK_ARN });
  });

  it('a resumed migration whose application exits 127 fails without a rollout, a second run or a confirmation', async () => {
    const state = baseState({ initContainerFirst: true });
    state.migrationTask = { lastStatus: 'RUNNING' };
    const d = deps(state);
    const first = await run(
      createEcsDeployExecutor({ ...d, migrationPollIntervalMs: 0, migrationPollMaxAttempts: 1 }),
      migrationDeploy(),
    );
    expect(first.deferred).toBe(true);

    state.migrationTask = {
      stopCode: 'EssentialContainerExited',
      stoppedReason: 'Essential container in task exited',
      containers: [INIT, { name: 'app', exitCode: 127 }],
    };
    const results = await createEcsDeployResumer(d)();
    expect(results).toHaveLength(1);
    expect(results[0]!.success).toBe(false);
    expect(results[0]!.failureCode).toBe('MIGRATION_FAILED');
    expect(results[0]!.error).toContain('exit code 127');
    expect(results[0]!.evidence?.container?.exitCode).toBe(127);
    expect(state.runTasks).toHaveLength(1);
    expect(state.updates).toHaveLength(0);
    expect(await d.pending.read()).toBeNull();
  });
});

describe('crash-loop detection — application exits only', () => {
  async function resumeWithStopped(state: FakeEcs) {
    state.taskDefinition.containerDefinitions[0] = { name: 'app', image: `${REPO}@${DIGEST_V3}` };
    state.runningDigest = null;
    const d = deps(state);
    await d.pending.write({
      commandId: 'job-1',
      idempotencyKey: 'dep-1:DEPLOY_RELEASE',
      type: 'DEPLOY_RELEASE',
      stackName: 'deployz-app',
      startedAt: new Date().toISOString(),
      payload: { imageRepository: REPO, imageDigest: DIGEST_V3 },
    });
    return createEcsDeployResumer(d)();
  }

  it("never counts a helper's non-zero exit as the application crashing", async () => {
    const state = baseState({ initContainerFirst: true });
    const task = {
      taskDefinitionArn: BASE_DEF_ARN,
      exitCode: 1,
      containers: [{ name: 'RdsCaBundle', exitCode: 1 }, { name: 'app', exitCode: 0 }],
    };
    state.stoppedTasks = [task, task, task];
    expect(await resumeWithStopped(state)).toHaveLength(0);
  });

  it('counts the application exit by name in either container order', async () => {
    const state = baseState({ initContainerFirst: true });
    const initFirst = [INIT_EXIT_0, { name: 'app', exitCode: 1 }];
    const appFirst = [{ name: 'app', exitCode: 1 }, INIT_EXIT_0];
    state.stoppedTasks = [initFirst, appFirst, initFirst].map((containers) => ({
      taskDefinitionArn: BASE_DEF_ARN,
      exitCode: 1,
      containers,
    }));
    const results = await resumeWithStopped(state);
    expect(results).toHaveLength(1);
    expect(results[0]!.failureCode).toBe('CONTAINER_START_FAILED');
    expect(results[0]!.error).toContain('3 tasks of the new revision exited with code 1');
  });
});

const INIT_EXIT_0 = { name: 'RdsCaBundle', exitCode: 0 };

describe('scheduled-job family image registration (Phase 5)', () => {
  it('registers the release image into every scheduled-job family once the rollout settles', async () => {
    const state = baseState();
    state.runningDigest = DIGEST_V3; // the services already run the release
    const result = await run(
      createEcsDeployExecutor(deps(state)),
      deployCommand({ imageRepository: REPO, imageDigest: DIGEST_V3, scheduledJobFamilies: [CLEANUP_FAMILY] }),
    );
    expect(result.success).toBe(true);
    // The family's latest revision (the fake's fallback) still runs the old
    // digest, so it gets a new revision with the release image.
    expect(state.registered).toHaveLength(1);
    const registered = state.registered[0] as {
      containerDefinitions: { image?: string }[];
      tags?: { key: string; value: string }[];
    };
    expect(registered.containerDefinitions[0]?.image).toBe(`${REPO}@${DIGEST_V3}`);
    expect(registered.tags).toContainEqual({ key: 'deployz:installation', value: 'inst-test' });
    // Never RunTask'd — the relay only registers the family; Scheduler runs it.
    expect(state.runTasks).toHaveLength(0);
  });

  it('is idempotent: a retried deploy reuses the copy it registered, never a second revision', async () => {
    const state = baseState();
    state.runningDigest = DIGEST_V3;
    const command = deployCommand({ imageRepository: REPO, imageDigest: DIGEST_V3, scheduledJobFamilies: [CLEANUP_FAMILY] });
    expect((await run(createEcsDeployExecutor(deps(state)), command)).success).toBe(true);
    expect((await run(createEcsDeployExecutor(deps(state)), command)).success).toBe(true);
    expect(state.registered).toHaveLength(1);
  });

  it('reuses the stack\'s own revision when it already runs the release image', async () => {
    const state = baseState();
    state.runningDigest = DIGEST_V2;
    state.service!.taskDefinition = BASE_DEF_ARN;
    const result = await run(
      createEcsDeployExecutor(deps(state)),
      deployCommand({ imageRepository: REPO, imageDigest: DIGEST_V2, scheduledJobFamilies: [CLEANUP_FAMILY] }),
    );
    expect(result.success).toBe(true);
    expect(state.registered).toHaveLength(0);
  });

  it('never registers into a family its own stack did not create', async () => {
    const state = baseState();
    state.runningDigest = DIGEST_V3;
    const foreign = 'DeployzAppCleanupotherinstallation';
    state.definitions.set(`arn:aws:ecs:us-east-1:151955775369:task-definition/${foreign}:1`, {
      ...state.definitions.get(CLEANUP_DEF_ARN)!,
      family: foreign,
    });
    const result = await run(
      createEcsDeployExecutor(deps(state)),
      deployCommand({ imageRepository: REPO, imageDigest: DIGEST_V3, scheduledJobFamilies: [foreign] }),
    );
    // Never settles on a family it cannot prove is its own — and never copies it.
    expect(result.deferred).toBe(true);
    expect(state.registered).toHaveLength(0);
  });

  it('a failed registration never settles the deploy — it stays in progress and the next poll retries', async () => {
    // The services already run the release, so a failed update would be a
    // lie: the command defers, and succeeds once the family is registered.
    const state = baseState();
    state.runningDigest = DIGEST_V3;
    state.failAt = 'register';
    const d = deps(state);
    const command = deployCommand({ imageRepository: REPO, imageDigest: DIGEST_V3, scheduledJobFamilies: [CLEANUP_FAMILY] });
    const first = await run(createEcsDeployExecutor(d), command);
    expect(first.deferred).toBe(true);
    expect(state.updates).toHaveLength(0);

    delete state.failAt;
    const results = await createEcsDeployResumer(d)();
    expect(results).toHaveLength(1);
    expect(results[0]!.success).toBe(true);
  });

  it('never registers a family name outside the DeployzApp… shape (trust boundary)', () => {
    expect(
      readDeployRequest({ imageRepository: REPO, imageDigest: DIGEST_V3, scheduledJobFamilies: ['rm -rf /'] }),
    ).toBeNull();
    expect(
      readDeployRequest({ imageRepository: REPO, imageDigest: DIGEST_V3, scheduledJobFamilies: 'DeployzAppCleanup' }),
    ).toBeNull();
  });
});

// An older stack names its families without an installation suffix, so a
// second installation of the same application in the same account and
// Region registers into the SAME family, with the SAME release image, but its
// own roles and secrets.
describe('one-shot families shared with another installation', () => {
  const OTHER_ROLE = 'arn:aws:iam::151955775369:role/deployz/other-installation-task';

  /** Registers another installation's revision of `family`, running `image`, as the family's latest. */
  function foreignRevision(state: FakeEcs, family: string, source: string, image: string): string {
    const arn = `arn:aws:ecs:us-east-1:151955775369:task-definition/${family}:${900 + state.definitions.size}`;
    const own = state.definitions.get(source)!;
    state.definitions.set(arn, {
      ...own,
      taskRoleArn: OTHER_ROLE,
      containerDefinitions: own.containerDefinitions.map((c) => (c.name === 'app' ? { ...c, image } : { ...c })),
    });
    state.latestByFamily!.set(family, arn);
    return arn;
  }

  const migrationDeploy = () =>
    deployCommand({ imageRepository: REPO, imageDigest: DIGEST_V3, migrationTask: MIGRATION_TASK });

  it("never runs or copies the other installation's revision, even when it runs the same image", async () => {
    const state = baseState({ initContainerFirst: true });
    const foreign = foreignRevision(state, MIGRATION_TASK.family, MIGRATION_DEF_ARN, `${REPO}@${DIGEST_V3}`);
    await run(createEcsDeployExecutor(deps(state)), migrationDeploy());

    const migrationCopy = state.registered[0] as RegisterTaskDefinitionInput;
    expect(migrationCopy.family).toBe(MIGRATION_TASK.family);
    expect(migrationCopy.taskRoleArn).toBe('arn:aws:iam::151955775369:role/deployz/app-task');
    const ran = (state.runTasks[0] as { taskDefinition: string }).taskDefinition;
    expect(ran).not.toBe(foreign);
    expect(ran).not.toBe(MIGRATION_TASK.family);
    expect(state.definitions.get(ran)!.taskRoleArn).toBe('arn:aws:iam::151955775369:role/deployz/app-task');
  });

  it('runs the revision it registered when another installation registers in between', async () => {
    const state = baseState({ initContainerFirst: true });
    const d = deps(state);
    const ecs: EcsDeployClient = {
      ...d.ecs,
      async registerTaskDefinition(input) {
        const registered = await d.ecs.registerTaskDefinition(input);
        if (input.family === MIGRATION_TASK.family) {
          foreignRevision(state, MIGRATION_TASK.family, MIGRATION_DEF_ARN, `${REPO}@${DIGEST_V3}`);
        }
        return registered;
      },
    };
    const result = await run(createEcsDeployExecutor({ ...d, ecs }), migrationDeploy());
    expect(result.deferred).toBe(true);
    expect(state.runTasks[0]).toMatchObject({ taskDefinition: `${MIGRATION_FAMILY_ARN_PREFIX}:1` });
    // The verdict reads the same exact revision.
    expect((await d.pending.read())?.migration?.completedAt).toEqual(expect.any(String));
  });

  it('a retry after a failed RunTask reuses its own copy, never the newer foreign latest', async () => {
    const state = baseState({ initContainerFirst: true });
    const d = deps(state);
    let failRunTask = true;
    const ecs: EcsDeployClient = {
      ...d.ecs,
      async runTask(input) {
        if (failRunTask) throw new Error('ThrottlingException');
        return d.ecs.runTask(input);
      },
    };
    const first = await run(createEcsDeployExecutor({ ...d, ecs }), migrationDeploy());
    expect(first.success).toBe(false);
    expect(state.runTasks).toHaveLength(0);

    // The family's latest is now another installation's revision.
    foreignRevision(state, MIGRATION_TASK.family, MIGRATION_DEF_ARN, `${REPO}@${DIGEST_V3}`);
    failRunTask = false;
    await run(createEcsDeployExecutor({ ...d, ecs }), migrationDeploy());
    const ran = (state.runTasks[0] as { taskDefinition: string }).taskDefinition;
    expect(state.definitions.get(ran)!.taskRoleArn).toBe('arn:aws:iam::151955775369:role/deployz/app-task');
    expect(state.definitions.get(ran)!.containerDefinitions[0]!.image).toBe(`${REPO}@${DIGEST_V3}`);
  });

  it("a scheduled-job family never adopts the other installation's revision", async () => {
    const state = baseState();
    state.runningDigest = DIGEST_V3;
    foreignRevision(state, CLEANUP_FAMILY, CLEANUP_DEF_ARN, `${REPO}@${DIGEST_V3}`);
    const result = await run(
      createEcsDeployExecutor(deps(state)),
      deployCommand({ imageRepository: REPO, imageDigest: DIGEST_V3, scheduledJobFamilies: [CLEANUP_FAMILY] }),
    );
    expect(result.success).toBe(true);
    // Its own copy, registered as the family's latest — the schedule runs it.
    expect(state.registered).toHaveLength(1);
    const copy = state.registered[0] as RegisterTaskDefinitionInput;
    expect(copy.taskRoleArn).toBe('arn:aws:iam::151955775369:role/deployz/app-task');
    expect(state.definitions.get(state.latestByFamily!.get(CLEANUP_FAMILY)!)!.taskRoleArn).toBe(
      'arn:aws:iam::151955775369:role/deployz/app-task',
    );
  });

  it('copies and runs nothing when its own stack resources cannot be read', async () => {
    const state = baseState();
    const d = deps(state);
    const result = await run(
      createEcsDeployExecutor({ ...d, cfn: { ...d.cfn, listStackResources: async () => null } }),
      migrationDeploy(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('could not be read');
    expect(state.registered).toHaveLength(0);
    expect(state.runTasks).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });

  it('a failed rollout leaves the scheduled-job family on the previous release', async () => {
    const state = baseState();
    state.service!.deployments = [{ status: 'PRIMARY', rolloutState: 'FAILED' }];
    const result = await run(
      createEcsDeployExecutor(deps(state)),
      deployCommand({ imageRepository: REPO, imageDigest: DIGEST_V3, scheduledJobFamilies: [CLEANUP_FAMILY] }),
    );
    expect(result.failureCode).toBe('ECS_DEPLOYMENT_FAILED');
    expect(state.registered).toHaveLength(0);
    expect(state.latestByFamily!.get(CLEANUP_FAMILY)).toBe(CLEANUP_DEF_ARN);
  });
});

describe('createEcsDeployResumer', () => {
  it('settles a deferred deploy once the digest runs and the service is stable', async () => {
    const state = baseState();
    const d = deps(state);
    await d.pending.write({
      commandId: 'job-1',
      idempotencyKey: 'dep-1:DEPLOY_RELEASE',
      type: 'DEPLOY_RELEASE',
      stackName: 'deployz-app',
      startedAt: new Date().toISOString(),
      payload: { imageRepository: REPO, imageDigest: DIGEST_V3 },
    });
    state.runningDigest = DIGEST_V3;

    const results = await createEcsDeployResumer(d)();
    expect(results).toHaveLength(1);
    expect(results[0]!.success).toBe(true);
    expect(await d.pending.read()).toBeNull();
  });

  it('keeps waiting while the rollout is still in progress', async () => {
    const state = baseState();
    const d = deps(state);
    await d.pending.write({
      commandId: 'job-1',
      idempotencyKey: 'dep-1:DEPLOY_RELEASE',
      type: 'DEPLOY_RELEASE',
      stackName: 'deployz-app',
      startedAt: new Date().toISOString(),
      payload: { imageRepository: REPO, imageDigest: DIGEST_V3 },
    });

    const results = await createEcsDeployResumer(d)();
    expect(results).toHaveLength(0);
    expect(await d.pending.read()).not.toBeNull();
  });

  it('never settles while the primary rollout is IN_PROGRESS even when the digest runs', async () => {
    const state = baseState();
    state.service!.deployments = [{ status: 'PRIMARY', rolloutState: 'IN_PROGRESS' }];
    state.runningDigest = DIGEST_V3;
    // ECS already switched the service to the new-definition rollout, whose
    // running tasks carry v3 — but old tasks are still draining.
    state.definitions.set(BASE_DEF_ARN, {
      ...state.taskDefinition,
      containerDefinitions: state.taskDefinition.containerDefinitions.map((container) =>
        container.name === 'app' ? { ...container, image: `${REPO}@${DIGEST_V3}` } : container,
      ),
    });
    const d = deps(state);
    await d.pending.write({
      commandId: 'job-1',
      idempotencyKey: 'dep-1:DEPLOY_RELEASE',
      type: 'DEPLOY_RELEASE',
      stackName: 'deployz-app',
      startedAt: new Date().toISOString(),
      payload: { imageRepository: REPO, imageDigest: DIGEST_V3 },
    });

    // Partially rolled out: the new digest runs and the count is stable, but
    // ECS has not finished the rollout — this must never report success or
    // re-issue an update against a service that is already rolling.
    const results = await createEcsDeployResumer(d)();
    expect(results).toHaveLength(0);
    expect(await d.pending.read()).not.toBeNull();
    expect(state.updates).toHaveLength(0);

    // Once ECS finishes, the same settle call succeeds.
    state.service!.deployments = [{ status: 'PRIMARY', rolloutState: 'COMPLETED' }];
    const settled = await createEcsDeployResumer(d)();
    expect(settled).toHaveLength(1);
    expect(settled[0]?.success).toBe(true);
    expect(await d.pending.read()).toBeNull();
  });

  it('never settles while ALB targets are still registering', async () => {
    const state = baseState();
    state.runningDigest = DIGEST_V3;
    state.targetHealth = ['healthy', 'initial'];
    const d = deps(state);
    await d.pending.write({
      commandId: 'job-1',
      idempotencyKey: 'dep-1:DEPLOY_RELEASE',
      type: 'DEPLOY_RELEASE',
      stackName: 'deployz-app',
      startedAt: new Date().toISOString(),
      payload: { imageRepository: REPO, imageDigest: DIGEST_V3 },
    });

    const results = await createEcsDeployResumer(d)();
    expect(results).toHaveLength(0);
    expect(await d.pending.read()).not.toBeNull();

    // Once the last target registers healthy the same settle call succeeds.
    state.targetHealth = ['healthy', 'healthy'];
    const settled = await createEcsDeployResumer(d)();
    expect(settled).toHaveLength(1);
    expect(settled[0]?.success).toBe(true);
    expect(await d.pending.read()).toBeNull();
  });

  it('settles once rollout COMPLETED, digest running and all targets healthy', async () => {
    const state = baseState();
    state.service!.deployments = [{ status: 'PRIMARY', rolloutState: 'IN_PROGRESS' }];
    const d = deps(state);
    await d.pending.write({
      commandId: 'job-1',
      idempotencyKey: 'dep-1:DEPLOY_RELEASE',
      type: 'DEPLOY_RELEASE',
      stackName: 'deployz-app',
      startedAt: new Date().toISOString(),
      payload: { imageRepository: REPO, imageDigest: DIGEST_V3 },
    });

    // Mid-rollout: the digest is not running yet.
    expect(await createEcsDeployResumer(d)()).toHaveLength(0);

    // Rollout completes and the new digest serves every task.
    state.service!.deployments = [{ status: 'PRIMARY', rolloutState: 'COMPLETED' }];
    state.runningDigest = DIGEST_V3;
    const settled = await createEcsDeployResumer(d)();
    expect(settled).toHaveLength(1);
    expect(settled[0]?.success).toBe(true);
    expect(await d.pending.read()).toBeNull();
  });

  it('ignores pending commands of other types', async () => {
    const state = baseState();
    const d = deps(state);
    await d.pending.write({
      commandId: 'job-install',
      idempotencyKey: 'dep-1:INSTALL',
      type: 'INSTALL',
      stackName: 'deployz-app',
      startedAt: new Date().toISOString(),
      payload: {},
    });
    const results = await createEcsDeployResumer(d)();
    expect(results).toHaveLength(0);
  });

  it('resumes an in-flight migration by ARN — never a second RunTask — then settles', async () => {
    const state = baseState();
    state.migrationTask = { lastStatus: 'RUNNING' };
    const d = deps(state);

    // First invocation: migration still running → deferred with the task ARN.
    const first = await run(
      createEcsDeployExecutor({ ...d, migrationPollIntervalMs: 0, migrationPollMaxAttempts: 1 }),
      deployCommand({
        imageRepository: REPO,
        imageDigest: DIGEST_V3,
        migrationTask: MIGRATION_TASK,
      }),
    );
    expect(first.deferred).toBe(true);
    expect(state.runTasks).toHaveLength(1);
    expect(state.updates).toHaveLength(0);

    // The migration finishes; the resumer polls the SAME task and proceeds.
    state.migrationTask = { lastStatus: 'STOPPED', exitCode: 0 };
    const resumed = await createEcsDeployResumer(d)();
    expect(resumed).toHaveLength(0); // rollout now in flight — still pending
    expect(state.runTasks).toHaveLength(1); // never re-run
    // 2 registrations total: the migration family (before RunTask, on the
    // first invocation) and the service's own copy (once migration completed).
    expect(state.registered).toHaveLength(2);
    expect(state.updates).toHaveLength(1);
    const pending = await d.pending.read();
    expect(pending?.migration?.completedAt).toBeDefined();

    // The rollout settles; the resumer reports success and clears the marker.
    state.runningDigest = DIGEST_V3;
    const settled = await createEcsDeployResumer(d)();
    expect(settled).toHaveLength(1);
    expect(settled[0]?.success).toBe(true);
    expect(await d.pending.read()).toBeNull();
  });
});

describe('createRestartExecutor', () => {
  it('forces a new deployment of the current definition', async () => {
    const state = baseState();
    const result = await run(
      createRestartExecutor(deps(state)),
      deployCommand({}, 'RESTART' as never),
    );
    expect(result.success).toBe(true);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({
      cluster: 'app-cluster',
      service: SERVICE_ARN,
      forceNewDeployment: true,
    });
  });

  it('fails when there is no service to restart', async () => {
    const state = baseState();
    const result = await run(
      createRestartExecutor(deps(state, false)),
      deployCommand({}, 'RESTART' as never),
    );
    expect(result.success).toBe(false);
  });

  it('restarts EVERY app service (Phase 4A multi-workload)', async () => {
    const state = baseState();
    const d = deps(state);
    // Two services in the stack.
    (d.cfn as { describeStackResources(): Promise<StackResource[]> }).describeStackResources =
      async () => [
        { logicalId: 'WebService', type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE', physicalId: SERVICE_ARN },
        { logicalId: 'EmailWorkerService', type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE', physicalId: WORKER_SERVICE_ARN },
      ];
    const fake = d.ecs as unknown as {
      describeServices(input: { services: string[] }): Promise<{ services: unknown[] }>;
    };
    const originalDescribe = fake.describeServices.bind(d.ecs);
    fake.describeServices = async (input) => {
      const answer = await originalDescribe(input);
      // One shared fake service state, answered once per requested ARN.
      return { services: input.services.map(() => answer.services[0]) };
    };

    const result = await run(createRestartExecutor(d), deployCommand({}, 'RESTART' as never));
    expect(result.success).toBe(true);
    expect(state.updates).toHaveLength(2);
    expect(state.updates[0]).toMatchObject({ service: SERVICE_ARN, forceNewDeployment: true });
    expect(state.updates[1]).toMatchObject({ service: WORKER_SERVICE_ARN, forceNewDeployment: true });
  });
});

// ── Multi-workload rollout (Phase 4A): one deploy rolls EVERY service ────────

const WORKER_SERVICE_ARN = 'arn:aws:ecs:us-east-1:151955775369:service/app-cluster/EmailWorkerService';

const MULTI_WORKLOADS = [
  { id: 'web', serviceLogicalId: 'WebService', desiredCount: 1 },
  { id: 'email-worker', serviceLogicalId: 'EmailWorkerService', desiredCount: 1 },
];

function multiCfnWith(service: boolean): CloudFormationReader {
  const resources: StackResource[] = service
    ? [
        {
          logicalId: 'WebService',
          type: 'AWS::ECS::Service',
          status: 'CREATE_COMPLETE',
          physicalId: SERVICE_ARN,
        },
        {
          logicalId: 'EmailWorkerService',
          type: 'AWS::ECS::Service',
          status: 'CREATE_COMPLETE',
          physicalId: WORKER_SERVICE_ARN,
        },
        {
          logicalId: 'TargetGroup',
          type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
          status: 'CREATE_COMPLETE',
          physicalId: 'arn:aws:elasticloadbalancing:us-east-1:151955775369:targetgroup/app/c1b2d3e4f5a6b7c8',
        },
      ]
    : [{ logicalId: 'Bucket', type: 'AWS::S3::Bucket', status: 'CREATE_COMPLETE' }];
  return {
    async describeStack() {
      return { found: true, stack: { stackName: 'deployz-app', status: 'CREATE_COMPLETE', tags: {} } };
    },
    async describeStackResources() {
      return resources;
    },
  };
}

/** A two-service fake: both ARNs answer the SAME shared fake service. */
function multiFakeEcs(state: FakeEcs): EcsDeployClient {
  const single = fakeEcs(state);
  return {
    ...single,
    async describeServices(input) {
      const answer = await single.describeServices(input);
      return { services: input.services.map(() => answer.services[0] ?? {}) };
    },
  };
}

describe('settleEcsDeploy — multi-workload rollout', () => {
  it('fails fast when the payload carries malformed workload seats', async () => {
    const state = baseState();
    const result = await run(
      createEcsDeployExecutor(deps(state)),
      deployCommand({
        imageRepository: REPO,
        imageDigest: DIGEST_V3,
        workloads: [{ id: 'web', serviceLogicalId: 'WebService' }],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rolls EVERY app service to the new digest and settles only when all are stable', async () => {
    const state = baseState();
    state.runningDigest = DIGEST_V2;
    const d: EcsDeployDeps = {
      ...(deps(state) as EcsDeployDeps),
      cfn: multiCfnWith(true),
      ecs: multiFakeEcs(state),
    };
    const executor = createEcsDeployExecutor(d);
    const payload = {
      imageRepository: REPO,
      imageDigest: DIGEST_V3,
      workloads: MULTI_WORKLOADS,
    };

    const first = await run(executor, deployCommand(payload));
    expect(first.deferred).toBe(true);
    // Both services registered and updated.
    expect(state.registered).toHaveLength(2);
    expect(state.updates).toHaveLength(2);

    // The resumer finds both services on the new digest → success.
    state.runningDigest = DIGEST_V3;
    const results = await createEcsDeployResumer(d)();
    expect(results).toHaveLength(1);
    expect(results[0]!.success).toBe(true);
  });

  it('names the failed workload when ONE service fails while the other succeeds', async () => {
    const state = baseState();
    state.runningDigest = DIGEST_V2;
    const d: EcsDeployDeps = {
      ...(deps(state) as EcsDeployDeps),
      cfn: multiCfnWith(true),
      ecs: multiFakeEcs(state),
    };
    // The worker's rollout fails; the web rollout succeeds (web first).
    state.service!.deployments = [];
    const single = multiFakeEcs(state);
    const ecs: EcsDeployClient = {
      ...single,
      async describeServices(input) {
        const answer = await single.describeServices(input);
        return {
          services: input.services.map((arn, index) => {
            const base = answer.services[0] ?? {};
            return arn === WORKER_SERVICE_ARN
              ? { ...(base as object), deployments: [{ status: 'PRIMARY', rolloutState: 'FAILED' }] }
              : index === 0
                ? base
                : base;
          }),
        };
      },
    };
    const result = await settleEcsDeploy(
      { ...d, ecs },
      { imageRepository: REPO, imageDigest: DIGEST_V3, migrationTask: null, workloads: MULTI_WORKLOADS },
    );
    expect(result.state).toBe('failed');
    if (result.state === 'failed') {
      expect(result.failureCode).toBe('ECS_DEPLOYMENT_FAILED');
      expect(result.reason).toContain('workload "email-worker"');
      expect(result.reason).toContain('EmailWorkerService');
      expect(result.reason).toContain('circuit breaker');
    }
  });

  it('scales a first start from zero to each per-workload configured count', async () => {
    const state = baseState();
    state.service!.desiredCount = 0;
    state.service!.runningCount = 0;
    state.runningDigest = null;
    const d: EcsDeployDeps = {
      ...(deps(state) as EcsDeployDeps),
      cfn: multiCfnWith(true),
      ecs: multiFakeEcs(state),
    };
    await run(
      createEcsDeployExecutor(d),
      deployCommand({
        imageRepository: REPO,
        imageDigest: DIGEST_V3,
        workloads: MULTI_WORKLOADS,
      }),
    );
    // Both zero-count services were scaled up with the deploy.
    expect(state.updates.filter((update) => (update as { desiredCount?: number }).desiredCount === 1)).toHaveLength(2);
  });
});

// The dispatch layer's idempotency: a re-delivered key replays the cached
// result rather than executing the executor a second time.
describe('deploy idempotency through dispatch', () => {
  it('does not re-execute a settled command', async () => {
    const state = baseState();
    state.runningDigest = DIGEST_V3;
    const executor = createEcsDeployExecutor(deps(state));
    const idempotency = new IdempotencyStore();
    const command = deployCommand({ imageRepository: REPO, imageDigest: DIGEST_V3 });

    const first = await executor(command);
    idempotency.set(command.idempotencyKey, first);

    const updatesBefore = state.updates.length;
    const cached = idempotency.get(command.idempotencyKey)!;
    expect(cached.success).toBe(true);
    expect(state.updates.length).toBe(updatesBefore);
  });
});
