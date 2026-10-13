import { describe, expect, it } from 'vitest';

import {
  evaluateReleaseEvidence,
  releaseEvidenceSchema,
  type ExpectedWorkload,
  type ReleaseEvidence,
} from '@deployz/contracts';

import { createAuthState, type FetchFn } from './auth.js';
import { IdempotencyStore } from './commands.js';
import { observeRuntimeHealth, type EcsServiceReader, type TargetHealthReader } from './ecs-health.js';
import { observeServiceDigests, type EcsTaskReader } from './ecs-observe.js';
import { pollOnce, type PollDependencies } from './poll.js';
import type { CloudFormationReader, StackResource } from './verify.js';

const DIGEST = 'sha256:' + 'a'.repeat(64);
const OTHER_DIGEST = 'sha256:' + 'b'.repeat(64);
const WEB_ARN = 'arn:aws:ecs:us-east-1:151955775369:service/cluster/web-service';
const WORKER_ARN = 'arn:aws:ecs:us-east-1:151955775369:service/cluster/worker-service';
const TARGET_GROUP_ARN = 'arn:aws:elasticloadbalancing:us-east-1:151955775369:targetgroup/app/abc';

const EXPECTED: ExpectedWorkload[] = [
  { id: 'web', serviceLogicalId: 'WebService', public: true },
  { id: 'worker', serviceLogicalId: 'WorkerService', public: false },
];
const WORKLOADS = EXPECTED.map(({ id, serviceLogicalId }) => ({ id, serviceLogicalId }));

interface ServiceFake {
  desired?: number;
  running?: number;
  rollout?: string;
  digests?: string[];
  /** Omit the service from DescribeServices (it is reported as a failure by ECS). */
  missing?: boolean;
}

interface Scenario {
  web?: ServiceFake;
  worker?: ServiceFake;
  targets?: string[];
  probeOk?: boolean;
  probeThrows?: boolean;
}

async function heartbeat(scenario: Scenario): Promise<unknown> {
  const services = {
    'web-service': { arn: WEB_ARN, ...{ desired: 1, running: 1, rollout: 'COMPLETED', digests: [DIGEST] }, ...scenario.web },
    'worker-service': { arn: WORKER_ARN, ...{ desired: 1, running: 1, rollout: 'COMPLETED', digests: [DIGEST] }, ...scenario.worker },
  };
  const resources: StackResource[] = [
    { logicalId: 'WebService', type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE', physicalId: WEB_ARN },
    { logicalId: 'WorkerService', type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE', physicalId: WORKER_ARN },
    { logicalId: 'Targets', type: 'AWS::ElasticLoadBalancingV2::TargetGroup', status: 'CREATE_COMPLETE', physicalId: TARGET_GROUP_ARN },
  ];
  const cfn: CloudFormationReader = {
    async describeStack() {
      return { found: true, stack: { stackName: 'app', status: 'CREATE_COMPLETE', tags: {}, stackId: 'id' } };
    },
    async describeStackResources() {
      return resources;
    },
    async listStackResources() {
      return { resources };
    },
  };
  const ecsServices: EcsServiceReader = {
    async describeServices() {
      return {
        services: Object.entries(services)
          .filter(([, service]) => !('missing' in service && service.missing))
          .map(([name, service]) => ({
            serviceArn: service.arn,
            desiredCount: service.desired,
            runningCount: service.running,
            deployments: [{ status: 'PRIMARY', rolloutState: service.rollout }],
            loadBalancers: name === 'web-service' ? [{ targetGroupArn: TARGET_GROUP_ARN }] : [],
          })),
      };
    },
  };
  const elb: TargetHealthReader = {
    async describeTargetHealth() {
      return { targets: (scenario.targets ?? ['healthy']).map((state) => ({ state })) };
    },
  };
  const ecsTasks: EcsTaskReader = {
    async listTasks(input) {
      const service = services[input.serviceName as keyof typeof services];
      return { taskArns: service.digests.map((_, i) => `${input.serviceName}/${i}`) };
    },
    async describeTasks(input) {
      return {
        tasks: input.tasks.map((arn) => {
          const [name, index] = arn.split('/') as [keyof typeof services, string];
          return { lastStatus: 'RUNNING', containers: [{ imageDigest: services[name].digests[Number(index)] }] };
        }),
      };
    },
    async describeTaskDefinition() {
      return { taskDefinition: { containerDefinitions: [] } };
    },
  };

  let body: unknown;
  const fetchFn: FetchFn = async (url, init) => {
    if (url.includes('/api/relay/health')) body = JSON.parse(init?.body ?? '{}');
    return {
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        commands: [],
        deployment: { redisRequired: false, probeUrl: 'https://app.example.com', workloads: WORKLOADS },
      }),
    };
  };
  const deps: PollDependencies = {
    fetchFn,
    controlPlaneUrl: 'https://api.deployz.dev',
    installationId: 'inst-test',
    enrollmentCode: 'code',
    executors: {},
    idempotency: new IdempotencyStore(),
    sleep: async () => {},
    observeHealth: () => observeRuntimeHealth({ cfn, ecs: ecsServices, elb }, 'app', WORKLOADS),
    observeServiceDigests: () => observeServiceDigests({ cfn, ecs: ecsTasks, installationId: 'inst-test' }, 'app'),
    observeProbe: async () => {
      if (scenario.probeThrows) throw new Error('probe crashed');
      return { ok: scenario.probeOk ?? true, statusCode: scenario.probeOk === false ? 503 : 200, latencyMs: 5, checkedAt: new Date().toISOString() };
    },
  };
  const authState = createAuthState('inst-test', 'tok');
  authState.registered = true;
  await pollOnce(deps, authState);
  return body;
}

function evidenceOf(body: unknown): ReleaseEvidence {
  const parsed = releaseEvidenceSchema.safeParse((body as { observedState: Record<string, unknown> }).observedState['releaseEvidence']);
  expect(parsed.success).toBe(true);
  return parsed.data as ReleaseEvidence;
}

function verdict(body: unknown) {
  return evaluateReleaseEvidence(
    (body as { observedState: Record<string, unknown> }).observedState['releaseEvidence'],
    EXPECTED,
    new Date(),
  );
}

describe('releaseEvidence in the relay heartbeat', () => {
  it('passes for a healthy web and worker on one digest', async () => {
    const body = await heartbeat({});
    const evidence = evidenceOf(body);
    expect(evidence.services).toEqual([
      {
        workloadId: 'web',
        serviceLogicalId: 'WebService',
        observed: true,
        desiredCount: 1,
        runningCount: 1,
        rolloutState: 'COMPLETED',
        runningDigests: [DIGEST],
        targets: { healthy: 1, unhealthy: 0, pending: 0, unknown: 0 },
      },
      {
        workloadId: 'worker',
        serviceLogicalId: 'WorkerService',
        observed: true,
        desiredCount: 1,
        runningCount: 1,
        rolloutState: 'COMPLETED',
        runningDigests: [DIGEST],
        targets: null,
      },
    ]);
    expect(evidence.httpProbe).toMatchObject({ ok: true, status: 200 });
    expect(verdict(body)).toEqual({ pass: true, digest: DIGEST });
    expect((body as { runningImageDigest: string }).runningImageDigest).toBe(DIGEST);
  });

  it('fails when the worker service is missing', async () => {
    const body = await heartbeat({ worker: { missing: true } });
    expect(evidenceOf(body).services[1]).toMatchObject({ observed: false, runningCount: null, runningDigests: null });
    expect(verdict(body)).toEqual({ pass: false, reason: 'WORKLOAD_MISSING' });
  });

  it('fails when the worker has no running task', async () => {
    const body = await heartbeat({ worker: { running: 0, digests: [] } });
    expect(evidenceOf(body).services[1]).toMatchObject({ runningCount: 0, runningDigests: [] });
    expect(verdict(body)).toEqual({ pass: false, reason: 'TASKS_INSUFFICIENT' });
    expect((body as { runningImageDigest: string | null }).runningImageDigest).toBeNull();
  });

  it('fails when the public probe failed', async () => {
    expect(verdict(await heartbeat({ probeOk: false }))).toEqual({ pass: false, reason: 'PROBE_FAILED' });
  });

  it('fails when the probe threw: no probe is evidence', async () => {
    const body = await heartbeat({ probeThrows: true });
    expect(evidenceOf(body).httpProbe).toBeNull();
    expect(verdict(body)).toEqual({ pass: false, reason: 'PROBE_MISSING' });
  });

  it('fails when the worker runs a different digest', async () => {
    const body = await heartbeat({ worker: { digests: [OTHER_DIGEST] } });
    expect(verdict(body)).toEqual({ pass: false, reason: 'DIGEST_MIXED' });
    expect((body as { runningImageDigest: string | null }).runningImageDigest).toBeNull();
  });

  it('fails when two web tasks run different digests', async () => {
    const body = await heartbeat({ web: { desired: 2, running: 2, digests: [DIGEST, OTHER_DIGEST] } });
    expect(evidenceOf(body).services[0]?.runningDigests).toEqual([DIGEST, OTHER_DIGEST]);
    expect(verdict(body)).toEqual({ pass: false, reason: 'DIGEST_MIXED' });
  });

  it('fails while a target is still registering', async () => {
    expect(verdict(await heartbeat({ targets: ['healthy', 'initial'] }))).toEqual({
      pass: false,
      reason: 'TARGETS_UNHEALTHY',
    });
  });

  it('fails for a worker at zero desired tasks: not started, and no outage is reported', async () => {
    const body = await heartbeat({ worker: { desired: 0, running: 0, digests: [] } });
    expect(verdict(body)).toEqual({ pass: false, reason: 'WORKLOAD_NOT_STARTED' });
    expect((body as { components: Record<string, string> }).components['worker']).toBe('UNKNOWN');
  });

  it('fails during a rollout while the new tasks are not complete', async () => {
    const body = await heartbeat({ web: { desired: 2, running: 1, rollout: 'IN_PROGRESS' } });
    expect(verdict(body)).toEqual({ pass: false, reason: 'ROLLOUT_INCOMPLETE' });
  });
});
