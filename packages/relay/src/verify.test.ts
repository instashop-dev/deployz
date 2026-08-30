import { describe, expect, it } from 'vitest';

import {
  verifyInstallation,
  toReader,
  type CloudFormationReader,
  type StackResource,
  type StackLookup,
} from './verify.js';

const INSTALLATION = 'c2dca2bb-a733-470d-8ef0-8e96bc889442';

const COMPLETE_RESOURCES: StackResource[] = [
  { logicalId: 'Service', type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' },
  { logicalId: 'Alb', type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', status: 'CREATE_COMPLETE' },
  { logicalId: 'Db', type: 'AWS::RDS::DBInstance', status: 'CREATE_COMPLETE' },
  { logicalId: 'Bucket', type: 'AWS::S3::Bucket', status: 'CREATE_COMPLETE' },
];

function reader(lookup: StackLookup, resources: StackResource[] = []): CloudFormationReader {
  return {
    describeStack: async () => lookup,
    describeStackResources: async () => resources,
  };
}

function completeStack(tagValue: string = INSTALLATION, status = 'CREATE_COMPLETE'): StackLookup {
  return {
    found: true,
    stack: { stackName: 'deployz-app', status, tags: { 'deployz:installation': tagValue } },
  };
}

describe('verifyInstallation', () => {
  it('fails when the stack does not exist', async () => {
    const result = await verifyInstallation({
      cfn: reader({ found: false }),
      installationId: INSTALLATION,
    });

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('deployz-app');
    expect(result.checks[0]).toMatchObject({ name: 'stack-exists', passed: false });
  });

  it('names the AWS error code when the lookup was refused', async () => {
    const result = await verifyInstallation({
      cfn: reader({ found: false, errorCode: 'AccessDenied' }),
      installationId: INSTALLATION,
    });

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('AccessDenied');
  });

  it('fails when the stack rolled back', async () => {
    const result = await verifyInstallation({
      cfn: reader(completeStack(INSTALLATION, 'ROLLBACK_COMPLETE'), COMPLETE_RESOURCES),
      installationId: INSTALLATION,
    });

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('ROLLBACK_COMPLETE');
  });

  it('fails when the stack belongs to another installation', async () => {
    const result = await verifyInstallation({
      cfn: reader(completeStack('some-other-installation'), COMPLETE_RESOURCES),
      installationId: INSTALLATION,
    });

    expect(result.verified).toBe(false);
    expect(result.checks.find((c) => c.name === 'stack-tagged')?.passed).toBe(false);
  });

  it('fails when the compute resource is absent', async () => {
    const withoutService = COMPLETE_RESOURCES.filter((r) => r.type !== 'AWS::ECS::Service');
    const result = await verifyInstallation({
      cfn: reader(completeStack(), withoutService),
      installationId: INSTALLATION,
    });

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('ECS service');
  });

  it('fails when a resource exists but did not finish creating', async () => {
    const inProgress = COMPLETE_RESOURCES.map((r) =>
      r.type === 'AWS::RDS::DBInstance' ? { ...r, status: 'CREATE_IN_PROGRESS' } : r,
    );
    const result = await verifyInstallation({
      cfn: reader(completeStack(), inProgress),
      installationId: INSTALLATION,
    });

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('database');
  });

  it('passes on a complete stack', async () => {
    const result = await verifyInstallation({
      cfn: reader(completeStack(), COMPLETE_RESOURCES),
      installationId: INSTALLATION,
    });

    expect(result.verified).toBe(true);
    expect(result.reason).toBeUndefined();
    // Every REQUIRED check passes; the informational cache check reports the
    // (absent) cache without failing anything.
    expect(result.checks.filter((c) => c.required !== false).every((c) => c.passed)).toBe(true);
  });

  it('always reports the cache observation, informational when redis is not required', async () => {
    const result = await verifyInstallation({
      cfn: reader(completeStack(), COMPLETE_RESOURCES),
      installationId: INSTALLATION,
      redisRequired: false,
    });

    const cache = result.checks.find((c) => c.name === 'cache');
    expect(cache).toMatchObject({ passed: false, required: false });
    expect(cache?.detail).toContain('not provisioned');
    expect(result.verified).toBe(true);
  });

  it('requires a cache only when redis is required', async () => {
    const withoutCache = {
      cfn: reader(completeStack(), COMPLETE_RESOURCES),
      installationId: INSTALLATION,
    };

    expect((await verifyInstallation({ ...withoutCache, redisRequired: false })).verified).toBe(true);
    expect((await verifyInstallation({ ...withoutCache, redisRequired: true })).verified).toBe(false);
  });

  it('passes with a cache when redis is required', async () => {
    const withCache: StackResource[] = [
      ...COMPLETE_RESOURCES,
      { logicalId: 'Cache', type: 'AWS::ElastiCache::CacheCluster', status: 'CREATE_COMPLETE' },
    ];
    const result = await verifyInstallation({
      cfn: reader(completeStack(), withCache),
      installationId: INSTALLATION,
      redisRequired: true,
    });

    expect(result.verified).toBe(true);
  });

  it('honours an explicit stack name', async () => {
    let requestedStackName: string | undefined;
    const cfn: CloudFormationReader = {
      describeStack: async (stackName) => {
        requestedStackName = stackName;
        return { found: false };
      },
      describeStackResources: async () => [],
    };

    const result = await verifyInstallation({
      cfn,
      installationId: INSTALLATION,
      stackName: 'custom-stack',
    });

    expect(requestedStackName).toBe('custom-stack');
    expect(result.reason).toContain('custom-stack');
  });

  it('fails closed when describeStack throws instead of returning a StackLookup', async () => {
    const cfn: CloudFormationReader = {
      describeStack: async () => {
        throw new Error('network layer exploded');
      },
      describeStackResources: async () => COMPLETE_RESOURCES,
    };

    const result = await verifyInstallation({ cfn, installationId: INSTALLATION });

    expect(result.verified).toBe(false);
    expect(result.reason).toBeDefined();
    const errorCheck = result.checks.find((c) => c.name === 'verification-error');
    expect(errorCheck).toBeDefined();
    expect(errorCheck?.passed).toBe(false);
    expect(errorCheck?.detail).toContain('network layer exploded');
  });

  it('fails closed when describeStackResources throws, preserving earlier passing checks', async () => {
    const cfn: CloudFormationReader = {
      describeStack: async () => completeStack(),
      describeStackResources: async () => {
        throw new Error('throttled by AWS');
      },
    };

    const result = await verifyInstallation({ cfn, installationId: INSTALLATION });

    expect(result.verified).toBe(false);
    expect(result.reason).toBeDefined();

    // Earlier checks that ran before the throw must still be visible.
    expect(result.checks.find((c) => c.name === 'stack-exists')).toMatchObject({ passed: true });
    expect(result.checks.find((c) => c.name === 'stack-complete')).toMatchObject({ passed: true });
    expect(result.checks.find((c) => c.name === 'stack-tagged')).toMatchObject({ passed: true });

    const errorCheck = result.checks.find((c) => c.name === 'verification-error');
    expect(errorCheck).toBeDefined();
    expect(errorCheck?.passed).toBe(false);
    expect(errorCheck?.detail).toContain('throttled by AWS');
  });
});

describe('toReader', () => {
  it('maps a described stack into a lookup', async () => {
    const client = {
      send: async () => ({
        Stacks: [
          {
            StackName: 'deployz-app',
            StackStatus: 'CREATE_COMPLETE',
            Tags: [{ Key: 'deployz:installation', Value: INSTALLATION }],
          },
        ],
      }),
    };

    const lookup = await toReader(client).describeStack('deployz-app');

    expect(lookup).toEqual({
      found: true,
      stack: {
        stackName: 'deployz-app',
        status: 'CREATE_COMPLETE',
        tags: { 'deployz:installation': INSTALLATION },
      },
    });
  });

  it('reports a refused lookup as not found, with the error code', async () => {
    const client = {
      send: async () => {
        throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
      },
    };

    expect(await toReader(client).describeStack('deployz-app')).toEqual({
      found: false,
      errorCode: 'AccessDeniedException',
    });
  });

  it('reports an empty Stacks array as not found', async () => {
    const client = { send: async () => ({ Stacks: [] }) };
    expect(await toReader(client).describeStack('deployz-app')).toEqual({ found: false });
  });

  it('returns no resources when the describe call throws', async () => {
    const client = {
      send: async () => {
        throw new Error('throttled');
      },
    };
    expect(await toReader(client).describeStackResources('deployz-app')).toEqual([]);
  });

  it('drops resources missing any required field', async () => {
    const client = {
      send: async () => ({
        StackResources: [
          { LogicalResourceId: 'A', ResourceType: 'AWS::ECS::Service', ResourceStatus: 'CREATE_COMPLETE' },
          { LogicalResourceId: 'B', ResourceType: 'AWS::S3::Bucket' },
        ],
      }),
    };

    expect(await toReader(client).describeStackResources('deployz-app')).toEqual([
      { logicalId: 'A', type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' },
    ]);
  });
});
