import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AwsSdkNotAvailableError,
  createAwsClients,
  seedTestAccount,
  type AwsClients,
  type CloudFormationClient,
} from '../src/integration/aws-clients.js';
import {
  CleanupRegistry,
  runWithTeardown,
} from '../src/integration/teardown.js';
import {
  SPOT_REGIONS,
  allRegions,
  spotRegions,
} from '../src/integration/regions.js';
import {
  SCP_BLOCKED_ERROR_CODE,
  SCP_DENIAL_SIGNATURE,
  SCP_EXPLICIT_DENY_MARKER,
  extractBlockedAction,
  isScpBlocked,
} from '../src/integration/scp-blocked.js';
import {
  classifyFailure,
  runSuite,
  verifyHealthy,
  waitForStackStatus,
  type SuiteConfig,
  type SuiteDeps,
  type SuiteTemplates,
} from '../src/integration/runner.js';
import type { PublishResult, SynthOutput } from '../src/quick-create/index.js';

// ── Fixtures ─────────────────────────────────────────────────────────────

function makeSynthOutput(description: string): SynthOutput {
  return { template: { Description: description }, assets: [] };
}

function makeTemplates(): SuiteTemplates {
  return {
    bootstrap: makeSynthOutput('bootstrap-template'),
    application: makeSynthOutput('application-template'),
  };
}

function makePublishResult(): PublishResult {
  return {
    templateKey: 'deployz/bootstrap/v1/bootstrap-template-v1.json',
    templateUrl: 'https://bucket.s3.us-east-1.amazonaws.com/deployz/bootstrap/v1/bootstrap-template-v1.json',
    quickCreateUrl: 'https://us-east-1.console.aws.amazon.com/cloudformation/home#/stacks/create/review',
    assetKeys: [],
    templateBytes: 1000,
    parameterCount: 2,
  };
}

const CONFIG: SuiteConfig = {
  region: 'us-east-1',
  bootstrapStackName: 'deployz-bootstrap',
  applicationStackName: 'deployz-application',
  clusterName: 'fixture-cluster',
  serviceName: 'fixture-service',
  targetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/fixture/1',
  wait: { pollIntervalMs: 0, maxAttempts: 5 },
};

const COMPLETE_STACK = {
  stackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/deployz-bootstrap/1',
  stackName: 'deployz-bootstrap',
  status: 'CREATE_COMPLETE' as const,
  outputs: [],
};

function makeHarness() {
  const createStack = vi.fn().mockResolvedValue({
    stackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/test/1',
  });
  const describeStacks = vi.fn().mockResolvedValue(COMPLETE_STACK);
  const deleteStack = vi.fn().mockResolvedValue(undefined);
  const describeServices = vi.fn().mockResolvedValue([
    { serviceName: 'fixture-service', status: 'ACTIVE', desiredCount: 1, runningCount: 1, healthy: true },
  ]);
  const describeTargetHealth = vi.fn().mockResolvedValue({
    targets: [{ targetId: 'i-1', state: 'healthy' }],
  });
  const getCallerIdentity = vi.fn().mockResolvedValue({
    account: '123456789012',
    arn: 'arn:aws:iam::123456789012:user/test',
    userId: 'AIDATEST',
  });
  const listPolicies = vi.fn().mockResolvedValue({ policies: [] });

  const aws: AwsClients = {
    cloudFormation: { createStack, describeStacks, deleteStack },
    ecs: { describeServices },
    elb: { describeTargetHealth },
    sts: { getCallerIdentity },
    organizations: { listPolicies },
  };

  const synth = vi.fn().mockResolvedValue(makeTemplates());
  const publish = vi.fn().mockResolvedValue(makePublishResult());

  const deps: SuiteDeps = { aws, synth, publish };

  return {
    deps,
    aws,
    createStack,
    describeStacks,
    deleteStack,
    describeServices,
    describeTargetHealth,
    getCallerIdentity,
    listPolicies,
    synth,
    publish,
  };
}

function scpDenial(action: string): Error {
  return new Error(
    `User: arn:aws:iam::123456789012:user/alice is not authorized to perform: ` +
      `${action} on resource: arn:aws:cloudformation:us-east-1:123456789012:stack/* ` +
      `with an explicit deny in a service control policy`,
  );
}

// ── AWS client interfaces + real-implementation placeholders ─────────────

describe('createAwsClients (real impl placeholder)', () => {
  it('every method throws AwsSdkNotAvailableError (SDK not installed)', async () => {
    const clients = createAwsClients();

    await expect(
      clients.cloudFormation.createStack({ stackName: 'x', templateBody: '{}', region: 'us-east-1' }),
    ).rejects.toThrow(AwsSdkNotAvailableError);
    await expect(
      clients.cloudFormation.describeStacks({ stackName: 'x', region: 'us-east-1' }),
    ).rejects.toThrow(AwsSdkNotAvailableError);
    await expect(
      clients.cloudFormation.deleteStack({ stackName: 'x', region: 'us-east-1' }),
    ).rejects.toThrow(AwsSdkNotAvailableError);
    await expect(
      clients.ecs.describeServices({ cluster: 'c', serviceNames: ['s'], region: 'us-east-1' }),
    ).rejects.toThrow(AwsSdkNotAvailableError);
    await expect(
      clients.elb.describeTargetHealth({ targetGroupArn: 'arn', region: 'us-east-1' }),
    ).rejects.toThrow(AwsSdkNotAvailableError);
    await expect(clients.sts.getCallerIdentity()).rejects.toThrow(AwsSdkNotAvailableError);
    await expect(
      clients.organizations.listPolicies({ filter: 'SERVICE_CONTROL_POLICY' }),
    ).rejects.toThrow(AwsSdkNotAvailableError);
  });

  it('throws a clear "not installed / credentials missing" message', async () => {
    const clients = createAwsClients();
    await expect(clients.sts.getCallerIdentity()).rejects.toThrow(
      /AWS SDK not installed or credentials missing/,
    );
  });
});

describe('seedTestAccount (test-account fixture)', () => {
  it('resolves the identity and surfaces SCPs', async () => {
    const harness = makeHarness();
    harness.listPolicies.mockResolvedValue({
      policies: [
        { id: 'p-1', name: 'DenyAll', arn: 'arn:aws:organizations::123456789012:policy/o-1/service_control_policy/p-1' },
      ],
    });

    const result = await seedTestAccount(harness.aws);

    expect(result.accountId).toBe('123456789012');
    expect(result.callerArn).toBe('arn:aws:iam::123456789012:user/test');
    expect(result.scpCount).toBe(1);
    expect(result.scpPolicies[0]?.name).toBe('DenyAll');
  });

  it('reports zero SCPs when the account has no org restriction', async () => {
    const harness = makeHarness();
    const result = await seedTestAccount(harness.aws);
    expect(result.scpCount).toBe(0);
  });
});

// ── Guaranteed teardown ───────────────────────────────────────────────────

describe('CleanupRegistry', () => {
  it('runs cleanups in reverse creation order', async () => {
    const registry = new CleanupRegistry();
    const order: string[] = [];
    registry.register('x', 'one', async () => { order.push('one'); });
    registry.register('x', 'two', async () => { order.push('two'); });
    registry.register('x', 'three', async () => { order.push('three'); });

    const result = await registry.teardown();

    expect(order).toEqual(['three', 'two', 'one']);
    expect(result.order).toEqual(['three', 'two', 'one']);
    expect(result.attempted).toBe(3);
    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(0);
    expect(registry.size).toBe(0);
  });

  it('continues teardown when one cleanup throws (best-effort)', async () => {
    const registry = new CleanupRegistry();
    const order: string[] = [];
    registry.register('x', 'one', async () => { order.push('one'); });
    registry.register('x', 'two', async () => { throw new Error('delete failed'); });
    registry.register('x', 'three', async () => { order.push('three'); });

    const result = await registry.teardown();

    expect(order).toEqual(['three', 'one']);
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(2);
    expect(result.errors[0]?.resourceId).toBe('two');
  });

  it('records lastResult after teardown', async () => {
    const registry = new CleanupRegistry();
    expect(registry.lastResult).toBeUndefined();
    registry.register('x', 'one', async () => {});
    await registry.teardown();
    expect(registry.lastResult?.attempted).toBe(1);
  });
});

describe('runWithTeardown', () => {
  it('returns the value and runs teardown', async () => {
    const registry = new CleanupRegistry();
    const cleaned: string[] = [];

    const value = await runWithTeardown(registry, async (reg) => {
      reg.register('x', 'one', async () => { cleaned.push('one'); });
      return 42;
    });

    expect(value).toBe(42);
    expect(cleaned).toEqual(['one']);
    expect(registry.size).toBe(0);
  });

  it('ALWAYS runs teardown even when fn throws (the "guaranteed" part)', async () => {
    const registry = new CleanupRegistry();
    const cleaned: string[] = [];

    await expect(
      runWithTeardown(registry, async (reg) => {
        reg.register('x', 'one', async () => { cleaned.push('one'); });
        throw new Error('test failure');
      }),
    ).rejects.toThrow('test failure');

    expect(cleaned).toEqual(['one']);
    expect(registry.size).toBe(0);
  });
});

// ── Region parameterization ───────────────────────────────────────────────

describe('regions', () => {
  it('spotRegions() returns the 3 spot-check regions', () => {
    expect(spotRegions()).toEqual(['us-east-1', 'eu-west-1', 'ap-southeast-1']);
  });

  it('allRegions() returns the full 17-region allowlist', () => {
    expect(allRegions()).toHaveLength(17);
  });

  it('spot regions are a subset of the 17 allowed regions', () => {
    const allowed = new Set(allRegions());
    for (const region of spotRegions()) {
      expect(allowed.has(region)).toBe(true);
    }
  });

  it('SPOT_REGIONS has 3 regions (expanded to 17 in todo 33)', () => {
    expect(SPOT_REGIONS).toHaveLength(3);
  });
});

// ── SCP-blocked error-signature classifier ────────────────────────────────

describe('SCP-blocked catalog constants', () => {
  it('captures the canonical AWS denial signature', () => {
    expect(SCP_BLOCKED_ERROR_CODE).toBe('AccessDenied');
    expect(SCP_EXPLICIT_DENY_MARKER).toBe('explicit deny in a service control policy');
    expect(SCP_DENIAL_SIGNATURE).toContain('is not authorized to perform: <action>');
    expect(SCP_DENIAL_SIGNATURE).toContain('explicit deny in a service control policy');
  });
});

describe('isScpBlocked', () => {
  it('recognizes the canonical SCP denial on a plain Error', () => {
    expect(isScpBlocked(scpDenial('cloudformation:CreateStack'))).toBe(true);
  });

  it('recognizes an SCP denial from a bare message string', () => {
    expect(
      isScpBlocked(
        'User: arn:aws:iam::123456789012:user/x is not authorized to perform: ecs:RunTask on resource: arn:aws:ecs:... with an explicit deny in a service control policy',
      ),
    ).toBe(true);
  });

  it('recognizes an AWS SDK-style error (name AccessDeniedException)', () => {
    expect(
      isScpBlocked({ name: 'AccessDeniedException', message: scpDenial('ecs:RunTask').message }),
    ).toBe(true);
  });

  it('rejects a plain IAM denial that lacks the SCP tail', () => {
    const err = new Error(
      'User: arn:aws:iam::123456789012:user/alice is not authorized to perform: ecs:RunTask on resource: arn:aws:ecs:us-east-1:123456789012:task-definition/fixture:1',
    );
    expect(isScpBlocked(err)).toBe(false);
  });

  it('rejects a definitively non-AccessDenied error code', () => {
    expect(
      isScpBlocked({ name: 'ThrottlingException', message: scpDenial('ecs:RunTask').message }),
    ).toBe(false);
  });

  it('rejects non-error values', () => {
    expect(isScpBlocked(null)).toBe(false);
    expect(isScpBlocked(undefined)).toBe(false);
    expect(isScpBlocked(42)).toBe(false);
    expect(isScpBlocked({})).toBe(false);
    expect(isScpBlocked('random message')).toBe(false);
  });
});

describe('extractBlockedAction', () => {
  it('extracts the blocked service:Action from an SCP denial', () => {
    expect(extractBlockedAction(scpDenial('ecs:RunTask'))).toBe('ecs:RunTask');
    expect(extractBlockedAction(scpDenial('iam:PassRole'))).toBe('iam:PassRole');
  });

  it('returns null for non-SCP errors', () => {
    expect(extractBlockedAction(new Error('boom'))).toBeNull();
    expect(extractBlockedAction(null)).toBeNull();
    expect(extractBlockedAction(undefined)).toBeNull();
  });
});

describe('classifyFailure', () => {
  it('maps an SCP denial to AWS_SCP_BLOCKED (§61)', () => {
    expect(classifyFailure(scpDenial('ecs:RunTask'))).toBe('AWS_SCP_BLOCKED');
  });

  it('maps anything else to UNKNOWN', () => {
    expect(classifyFailure(new Error('something else'))).toBe('UNKNOWN');
  });
});

// ── Suite runner ──────────────────────────────────────────────────────────

describe('runSuite (orchestration)', () => {
  let harness: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    harness = makeHarness();
  });

  it('drives synth → publish → deploy → wait → verify in order, then tears down', async () => {
    const result = await runSuite(harness.deps, CONFIG);

    expect(result.passed).toBe(true);
    expect(result.phase).toBe('teardown');
    expect(result.phases.map((p) => p.phase)).toEqual([
      'synth',
      'publish',
      'deploy-bootstrap',
      'wait-first-contact',
      'deploy-application',
      'verify-healthy',
      'teardown',
    ]);

    expect(harness.synth).toHaveBeenCalledTimes(1);
    expect(harness.publish).toHaveBeenCalledTimes(1);

    const createCalls = harness.createStack.mock.calls.map((c) => c[0].stackName);
    expect(createCalls).toEqual(['deployz-bootstrap', 'deployz-application']);

    // teardown deleted in reverse creation order (application, then bootstrap)
    const deleteCalls = harness.deleteStack.mock.calls.map((c) => c[0].stackName);
    expect(deleteCalls).toEqual(['deployz-application', 'deployz-bootstrap']);

    expect(result.teardown.attempted).toBe(2);
    expect(result.teardown.failed).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.failureCode).toBeUndefined();
  });

  it('tears down created resources when verify-healthy fails', async () => {
    harness.describeServices.mockResolvedValue([
      { serviceName: 'fixture-service', status: 'ACTIVE', desiredCount: 1, runningCount: 0, healthy: false },
    ]);

    const result = await runSuite(harness.deps, CONFIG);

    expect(result.passed).toBe(false);
    expect(result.phase).toBe('verify-healthy');
    expect(harness.createStack.mock.calls).toHaveLength(2);
    expect(harness.deleteStack.mock.calls).toHaveLength(2);
    expect(result.teardown.attempted).toBe(2);
  });

  it('tears down only the bootstrap stack when deploy-application fails', async () => {
    harness.createStack
      .mockResolvedValueOnce({ stackId: 'arn:...bootstrap...' })
      .mockRejectedValueOnce(new Error('application create failed'));

    const result = await runSuite(harness.deps, CONFIG);

    expect(result.passed).toBe(false);
    expect(result.phase).toBe('deploy-application');
    expect(result.error).toContain('application create failed');
    expect(result.failureCode).toBe('UNKNOWN');
    expect(harness.deleteStack.mock.calls.map((c) => c[0].stackName)).toEqual(['deployz-bootstrap']);
    expect(result.teardown.attempted).toBe(1);
  });

  it('classifies an SCP denial as AWS_SCP_BLOCKED during deploy', async () => {
    harness.createStack.mockRejectedValueOnce(scpDenial('cloudformation:CreateStack'));

    const result = await runSuite(harness.deps, CONFIG);

    expect(result.passed).toBe(false);
    expect(result.phase).toBe('deploy-bootstrap');
    expect(result.failureCode).toBe('AWS_SCP_BLOCKED');
    expect(result.error).toContain('explicit deny in a service control policy');
  });

  it('reports a phase-level failure with a structured, inspectable result', async () => {
    harness.publish.mockRejectedValueOnce(new Error('publish failed'));

    const result = await runSuite(harness.deps, CONFIG);

    expect(result.passed).toBe(false);
    expect(result.phase).toBe('publish');
    expect(result.phases.some((p) => p.phase === 'publish' && p.status === 'failed')).toBe(true);
    // nothing was created, nothing to tear down
    expect(result.teardown.attempted).toBe(0);
  });
});

describe('waitForStackStatus', () => {
  function makeCfn(describeStacks: CloudFormationClient['describeStacks']): CloudFormationClient {
    return { createStack: vi.fn(), describeStacks, deleteStack: vi.fn() };
  }

  it('returns immediately when already at the desired status', async () => {
    const describeStacks = vi.fn().mockResolvedValue(COMPLETE_STACK);
    const info = await waitForStackStatus(makeCfn(describeStacks), 'x', 'us-east-1', 'CREATE_COMPLETE', { pollIntervalMs: 0, maxAttempts: 5 });
    expect(info.status).toBe('CREATE_COMPLETE');
    expect(describeStacks).toHaveBeenCalledTimes(1);
  });

  it('polls until the desired status is reached', async () => {
    const describeStacks = vi.fn()
      .mockResolvedValueOnce({ ...COMPLETE_STACK, status: 'CREATE_IN_PROGRESS' })
      .mockResolvedValueOnce(COMPLETE_STACK);
    const info = await waitForStackStatus(makeCfn(describeStacks), 'x', 'us-east-1', 'CREATE_COMPLETE', { pollIntervalMs: 0, maxAttempts: 5 });
    expect(info.status).toBe('CREATE_COMPLETE');
    expect(describeStacks).toHaveBeenCalledTimes(2);
  });

  it('throws on a terminal failure status', async () => {
    const describeStacks = vi.fn().mockResolvedValue({ ...COMPLETE_STACK, status: 'ROLLBACK_COMPLETE' });
    await expect(
      waitForStackStatus(makeCfn(describeStacks), 'x', 'us-east-1', 'CREATE_COMPLETE', { pollIntervalMs: 0, maxAttempts: 5 }),
    ).rejects.toThrow(/terminal failure/);
  });
});

describe('verifyHealthy', () => {
  it('returns true when ECS runs its full desired count and all targets are healthy', async () => {
    const harness = makeHarness();
    const ok = await verifyHealthy(harness.aws, {
      cluster: 'fixture-cluster',
      serviceName: 'fixture-service',
      targetGroupArn: 'arn',
      region: 'us-east-1',
    });
    expect(ok).toBe(true);
  });

  it('returns false when ECS is not fully running', async () => {
    const harness = makeHarness();
    harness.describeServices.mockResolvedValue([
      { serviceName: 'fixture-service', status: 'ACTIVE', desiredCount: 1, runningCount: 0, healthy: false },
    ]);
    const ok = await verifyHealthy(harness.aws, {
      cluster: 'fixture-cluster',
      serviceName: 'fixture-service',
      targetGroupArn: 'arn',
      region: 'us-east-1',
    });
    expect(ok).toBe(false);
  });

  it('returns false when a target is unhealthy', async () => {
    const harness = makeHarness();
    harness.describeTargetHealth.mockResolvedValue({
      targets: [{ targetId: 'i-1', state: 'unhealthy' }],
    });
    const ok = await verifyHealthy(harness.aws, {
      cluster: 'fixture-cluster',
      serviceName: 'fixture-service',
      targetGroupArn: 'arn',
      region: 'us-east-1',
    });
    expect(ok).toBe(false);
  });

  it('returns false when there are no healthy targets', async () => {
    const harness = makeHarness();
    harness.describeTargetHealth.mockResolvedValue({ targets: [] });
    const ok = await verifyHealthy(harness.aws, {
      cluster: 'fixture-cluster',
      serviceName: 'fixture-service',
      targetGroupArn: 'arn',
      region: 'us-east-1',
    });
    expect(ok).toBe(false);
  });
});
