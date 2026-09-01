/**
 * Phase 1 D1 (provisioning-side failure scenarios): six new scenarios on top
 * of e2e/scenario-install.spec.ts's original four, exercising the same real
 * production pipeline (simulated CFN events -> relay collector ->
 * POST /api/relay/commands/:id/progress -> summarizeStackEvents -> DB ->
 * status derivation) for cases that spec did not cover: a slow/ETA-flagged
 * install, a rollback-less generic stack failure, a database-specific
 * rollback with its step pinned, a Redis failure whose `redisRequired` comes
 * from the real analyser (not a hand-set flag), a bootstrap-stack failure
 * before the relay ever registers, and a relay that goes silent mid-install.
 * See docs/testing/discovery/phase1-design-decisions.md and
 * e2e/scenario-install.spec.ts for the conventions this file follows
 * (@scenario:<id> tags, one test.describe per scenario, real HTTP API only).
 */

import { expect, test } from './simulation/fixtures.js';

interface StackEventRow {
  logicalResourceId: string;
  resourceType: string;
  resourceStatus: string;
  resourceStatusReason: string | null;
}

interface ComponentProgressRow {
  key: string;
  label: string;
  status: string;
}

interface VendorDeploymentStatus {
  stage: string;
  step: string;
  stepStartedAt: string | null;
  typicalDurationSeconds: { min: number; max: number } | null;
  takingLongerThanUsual: boolean;
  components: ComponentProgressRow[];
  job: { type: string; status: string } | null;
  failure: {
    code: string | null;
    component: string | null;
    reference: string;
    message: string;
    awsStatus: string | null;
  } | null;
}

interface DeploymentResponse {
  state: string;
  healthStatus: string;
  stepTimings: Record<string, { startedAt: string; completedAt?: string }> | null;
  deploymentStatus: VendorDeploymentStatus;
}

interface CustomerDeploymentStatus {
  stage: string;
  failure: unknown | null;
}

interface InstallInfoResponse {
  waitingForRelay: boolean;
  relayStuck: boolean;
  deploymentState: string;
  resourcesCreated: string[];
}

test.describe.configure({ mode: 'parallel' });

test.describe('slow-provision', () => {
  test.use({ deployzScenario: 'slow-provision' });

  test('@scenario:slow-provision ladder reaches DATABASE_STORAGE with a slow-step ETA before HEALTHY', async ({
    deployzInstall,
  }) => {
    test.setTimeout(30_000);
    const { deploymentId, api } = deployzInstall;

    // Ladder actually progresses — poll the vendor status while the install
    // runs and observe DATABASE_STORAGE as the active step (RDS is still
    // mid-create for several real seconds — see
    // ./simulation/scenarios/slow-provision.ts). Reaching this value at all
    // already proves the ladder moved past NETWORK first.
    await expect
      .poll(
        async () => {
          const deployment = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
          return deployment.deploymentStatus.step;
        },
        { timeout: 6_000, message: 'waiting for the ladder to reach DATABASE_STORAGE' },
      )
      .toBe('DATABASE_STORAGE');

    const midFlight = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(midFlight.deploymentStatus.stage).toBe('PROVISIONING');
    // TYPICAL_STEP_DURATION_SECONDS.DATABASE_STORAGE (packages/contracts/src/index.ts)
    // is present for the active step regardless of timing.
    expect(midFlight.deploymentStatus.typicalDurationSeconds).toEqual({ min: 180, max: 720 });
    // Honest, observed production behaviour (not forced): SimulatedCustomerAccount
    // anchors its virtual clock so the LAST timeline event lands at (real)
    // install start (docs/testing/discovery/phase1-design-decisions.md D4),
    // so a still-active step's reported elapsed time is approximately
    // totalVirtualDuration-minus-the-step's-own-virtual-start — ~885s here
    // for DATABASE_STORAGE, comfortably past its 720s typical max. No
    // scenario-engine change was needed for this: it falls straight out of
    // the existing anchor once the timeline's virtual gap is authored past
    // the step's own max (see slow-provision.ts's doc comment).
    expect(midFlight.deploymentStatus.takingLongerThanUsual).toBe(true);

    // Terminal outcome: still reaches HEALTHY, same as happy-path.
    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for deployment.state to reach HEALTHY',
      })
      .toBe('HEALTHY');
    const settled = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(settled.deploymentStatus.takingLongerThanUsual).toBe(false);
  });
});

test.describe('cloudformation-failure', () => {
  test.use({ deployzScenario: 'cloudformation-failure' });

  test('@scenario:cloudformation-failure terminal FAILED with no rollback, never a stuck install', async ({
    deployzInstall,
  }) => {
    test.setTimeout(30_000);
    const { deploymentId, api } = deployzInstall;

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for deployment.state to reach FAILED',
      })
      .toBe('FAILED');

    const deployment = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(deployment.deploymentStatus.stage).toBe('FAILED');
    expect(deployment.deploymentStatus.failure).not.toBeNull();
    expect(deployment.deploymentStatus.failure!.code).toBe('STACK_CREATE_FAILED');
    // The distinguishing fact versus cloudformation-rollback.ts/ecs-failure.ts:
    // the stack's own terminal status here is CREATE_FAILED, never
    // ROLLBACK_COMPLETE — rollback was never attempted.
    expect(deployment.deploymentStatus.failure!.awsStatus).toBe('CREATE_FAILED');
    // A human-readable failure, not a stuck install — vendorMessage always
    // resolves to real §29 remediation copy for a classified failure code.
    expect(deployment.deploymentStatus.failure!.message.length).toBeGreaterThan(0);

    const events = (await api.getStackEvents(deploymentId)) as StackEventRow[];
    const vpcEvent = events.find(
      (event) => event.logicalResourceId === 'ApplicationVpc' && event.resourceStatus === 'CREATE_FAILED',
    );
    expect(vpcEvent).toBeDefined();
    expect(vpcEvent!.resourceStatusReason).toBe('The maximum number of VPCs has been reached.');
    // No rollback debris in the persisted events — this scenario's timeline
    // never emits one.
    expect(events.every((event) => !event.resourceStatus.startsWith('ROLLBACK_'))).toBe(true);
  });
});

test.describe('database-failure', () => {
  test.use({ deployzScenario: 'database-failure' });

  test('@scenario:database-failure terminal FAILED with step pinned to DATABASE_STORAGE', async ({
    deployzInstall,
  }) => {
    test.setTimeout(30_000);
    const { deploymentId, api } = deployzInstall;

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for deployment.state to reach FAILED',
      })
      .toBe('FAILED');

    const deployment = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(deployment.deploymentStatus.stage).toBe('FAILED');
    expect(deployment.deploymentStatus.failure!.code).toBe('STACK_CREATE_FAILED');
    expect(deployment.deploymentStatus.failure!.awsStatus).toBe('ROLLBACK_COMPLETE');
    // Honest, observed production behaviour: `snapshotFailedStep`
    // (apps/api/src/deployment-status.ts) finds exactly one failed category
    // (`database`) since NETWORK completed fine first, so the FAILED-stage
    // step lands on DATABASE_STORAGE — not the generic PREPARING fallback
    // e2e/scenario-install.spec.ts's cloudformation-rollback test never
    // checks.
    expect(deployment.deploymentStatus.step).toBe('DATABASE_STORAGE');

    const events = (await api.getStackEvents(deploymentId)) as StackEventRow[];
    const dbEvent = events.find(
      (event) => event.logicalResourceId === 'ApplicationDatabase' && event.resourceStatus === 'CREATE_FAILED',
    );
    expect(dbEvent).toBeDefined();
    expect(dbEvent!.resourceStatusReason).toContain('InsufficientDBInstanceCapacity');
  });
});

test.describe('redis-failure', () => {
  test.use({ deployzScenario: 'redis-failure', deployzRepoFullName: 'deployz-demo/bullmq-worker' });

  test('@scenario:redis-failure REDIS step fails, redisRequired flowed through the real analyser', async ({
    deployzInstall,
  }) => {
    test.setTimeout(30_000);
    const { deploymentId, installLinkId, api } = deployzInstall;

    // The harness genuinely received redisRequired=true, through production
    // analysis logic rather than a hand-set flag — observable via the same
    // API field the install page's "Deployz will create" list reads
    // (mirrors e2e/redis.spec.ts's willCreateSection assertion), independent
    // of how the install itself later turns out.
    const installInfo = (await api.getInstallInfo(installLinkId)) as unknown as InstallInfoResponse;
    expect(installInfo.resourcesCreated).toContain('Redis cache');

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for deployment.state to reach FAILED',
      })
      .toBe('FAILED');

    const deployment = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(deployment.deploymentStatus.stage).toBe('FAILED');
    expect(deployment.deploymentStatus.failure!.code).toBe('STACK_CREATE_FAILED');
    expect(deployment.deploymentStatus.failure!.awsStatus).toBe('ROLLBACK_COMPLETE');
    // Honest, observed production behaviour: `snapshotFailedStep` finds only
    // the `redis` category failed (network + database completed fine), so
    // the FAILED-stage step lands on REDIS.
    expect(deployment.deploymentStatus.step).toBe('REDIS');

    const events = (await api.getStackEvents(deploymentId)) as StackEventRow[];
    const redisEvent = events.find(
      (event) => event.logicalResourceId === 'ApplicationRedis' && event.resourceStatus === 'CREATE_FAILED',
    );
    expect(redisEvent).toBeDefined();
    expect(redisEvent!.resourceType).toBe('AWS::ElastiCache::ReplicationGroup');
    expect(redisEvent!.resourceStatusReason).toContain('Availability Zone');
  });
});

test.describe('bootstrap-failure', () => {
  test.use({ deployzScenario: 'bootstrap-failure', deployzStartRelay: false });

  test('@scenario:bootstrap-failure never registers a relay — holds WAITING_FOR_AWS, never a false FAILED/READY', async ({
    deployzInstall,
  }) => {
    test.setTimeout(30_000);
    const { deploymentId, installLinkId, api } = deployzInstall;

    // The customer already pressed "Deploy to AWS" (seedAndLaunch's /launched
    // call), but no relay was ever started for this test — the bootstrap
    // stack itself failed in the customer's account before the relay Lambda
    // it would have deployed ever ran. Honest, observed production
    // behaviour (not forced): with no INSTALL job and no relay enrollment at
    // all, deriveDeploymentStatus's precedence ladder
    // (apps/api/src/deployment-status.ts) has nothing to promote it past
    // WAITING_FOR_AWS — see docs/testing/discovery/deployment-lifecycle.md
    // §2. The 15-minute relayStuck escalation (server.ts's `relayStuck`
    // check against RELAY_STALE_AFTER_MS, ~line 1411) is out of reach for a
    // fast test and is deliberately not exercised here — no production time
    // knob was added for it.
    const deployment = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(deployment.state).toBe('WAITING_FOR_RELAY');
    expect(deployment.deploymentStatus.stage).toBe('WAITING_FOR_AWS');
    expect(deployment.deploymentStatus.step).toBe('AWS_SETUP');
    expect(deployment.deploymentStatus.failure).toBeNull();

    // The unauthenticated customer-facing status endpoint keeps serving and
    // agrees.
    const customerStatus = (await api.getInstallStatus(installLinkId)) as unknown as CustomerDeploymentStatus;
    expect(customerStatus.stage).toBe('WAITING_FOR_AWS');
    expect(customerStatus.failure).toBeNull();

    // The install page reflects the same not-yet-connected state — never
    // "stuck" or "failed" language this early.
    const installInfo = (await api.getInstallInfo(installLinkId)) as unknown as InstallInfoResponse;
    expect(installInfo.waitingForRelay).toBe(true);
    expect(installInfo.relayStuck).toBe(false);

    // A brief real wait changes nothing — proves this is a stable holding
    // state, not a race that happens to look right on the first read.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const again = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(again.state).toBe('WAITING_FOR_RELAY');
    expect(again.deploymentStatus.stage).toBe('WAITING_FOR_AWS');
    expect(again.deploymentStatus.failure).toBeNull();
  });
});

test.describe('relay-disconnect', () => {
  test.use({ deployzScenario: 'relay-disconnect', deployzRelayOptions: { stopAfterFirstProgress: true } });

  test('@scenario:relay-disconnect goes silent mid-install — holds PROVISIONING at its last-known step, job stays RUNNING', async ({
    deployzInstall,
  }) => {
    test.setTimeout(30_000);
    const { deploymentId, api } = deployzInstall;

    // The relay registers and starts the INSTALL job (deployment.state ->
    // INSTALLING per docs/testing/discovery/deployment-lifecycle.md §2),
    // reports its first (and, per `stopAfterFirstProgress`, only) batch of
    // progress, then goes silent — see
    // ./simulation/relay-harness.ts's `stopAfterFirstProgress` and
    // ./simulation/scenarios/relay-disconnect.ts.
    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 10_000,
        message: 'waiting for deployment.state to reach INSTALLING',
      })
      .toBe('INSTALLING');

    // The first (and, per `stopAfterFirstProgress`, only) progress batch
    // landing — waited for explicitly, rather than assumed immediate,
    // because it happens slightly after the state flip above (one more
    // internal wait-loop tick).
    await expect
      .poll(async () => (await api.getStackEvents(deploymentId)).length, {
        timeout: 5_000,
        message: 'waiting for the first progress batch to persist',
      })
      .toBeGreaterThan(0);

    const firstEvents = (await api.getStackEvents(deploymentId)) as StackEventRow[];
    // None of the timeline entries authored at afterMs >= 1s ever arrive —
    // the relay went silent well before real elapsed time reached them.
    expect(firstEvents.some((event) => event.logicalResourceId === 'ApplicationService')).toBe(false);

    const first = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(first.deploymentStatus.stage).toBe('PROVISIONING');
    // Honest, observed production behaviour: the only category the first
    // batch reports is `network`, still IN_PROGRESS (the VPC never
    // completed before the relay went silent), so `provisioningLadderStep`
    // (apps/api/src/deployment-status.ts) names NETWORK — the deployment's
    // genuine last-known step.
    expect(first.deploymentStatus.step).toBe('NETWORK');
    expect(first.deploymentStatus.job).toEqual({ type: 'INSTALL', status: 'RUNNING' });

    // A further real wait — long enough that every remaining timeline event
    // would have been revealed by the (now-silent) SimulatedCustomerAccount
    // had anyone still been polling it — changes nothing: no regression to
    // an earlier step, no false READY/FAILED, and the events already
    // persisted stay served. Full DISCONNECTED/staleness surfacing needs the
    // worker's 15-minute liveness sweep (`sweepRelayLiveness`,
    // packages/cdk/src/lambda/worker.ts), which does not run locally — not
    // exercised here.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const later = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(later.state).toBe('INSTALLING');
    expect(later.deploymentStatus.stage).toBe('PROVISIONING');
    expect(later.deploymentStatus.step).toBe('NETWORK');
    expect(later.deploymentStatus.job).toEqual({ type: 'INSTALL', status: 'RUNNING' });
    expect(later.deploymentStatus.failure).toBeNull();
    const laterEvents = (await api.getStackEvents(deploymentId)) as StackEventRow[];
    expect(laterEvents.length).toBe(firstEvents.length);

    // Deliberately no relay.waitForResult() — the INSTALL job never settles
    // in this scenario. relay.stop() (in the fixture's teardown) only clears
    // the poll-cycle timer, which is safe even though the last poll cycle's
    // `pollOnce()` promise is permanently pending.
  });
});
