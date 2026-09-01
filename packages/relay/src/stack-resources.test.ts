import { describe, expect, it } from 'vitest';

import { listAllStackResources } from './stack-resources.js';
import { toReader, type CloudFormationReader, type StackLookup } from './verify.js';

const STACK_ID = 'arn:aws:cloudformation:us-east-1:123456789012:stack/deployz-app/abc123';

function foundStack(stackId: string = STACK_ID): StackLookup {
  return {
    found: true,
    stack: { stackName: 'deployz-app', status: 'CREATE_COMPLETE', tags: {}, stackId },
  };
}

function reader(options: {
  lookup: StackLookup;
  pages?: Array<Record<string, unknown> | null | undefined>;
}): CloudFormationReader {
  return {
    describeStack: async () => options.lookup,
    describeStackResources: async () => [],
    listStackResources: async () => {
      const page = options.pages?.shift();
      if (page === undefined) throw new Error('unexpected page request');
      if (page === null) return null;
      return page as { resources: never[]; nextToken?: string };
    },
  };
}

describe('listAllStackResources', () => {
  it('returns the stack id and resources from a single page', async () => {
    const result = await listAllStackResources(
      reader({
        lookup: foundStack(),
        pages: [{ resources: [{ logicalId: 'Database', type: 'AWS::RDS::DBInstance', status: 'CREATE_COMPLETE' }] }],
      }),
      'deployz-app',
    );

    expect(result).toEqual({
      stackId: STACK_ID,
      resources: [{ logicalId: 'Database', type: 'AWS::RDS::DBInstance', status: 'CREATE_COMPLETE' }],
    });
  });

  it('follows the NextToken loop across pages until it is gone', async () => {
    const requestedTokens: Array<string | undefined> = [];
    const cfn: CloudFormationReader = {
      describeStack: async () => foundStack(),
      describeStackResources: async () => [],
      listStackResources: async (_stackName, nextToken) => {
        requestedTokens.push(nextToken);
        if (nextToken === undefined) {
          return {
            resources: [{ logicalId: 'Vpc', type: 'AWS::EC2::VPC', status: 'CREATE_COMPLETE' }],
            nextToken: 'page-2',
          };
        }
        return {
          resources: [{ logicalId: 'Service', type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' }],
        };
      },
    };

    const result = await listAllStackResources(cfn, 'deployz-app');

    expect(requestedTokens).toEqual([undefined, 'page-2']);
    expect(result?.resources.map((r) => r.logicalId)).toEqual(['Vpc', 'Service']);
  });

  it('fails closed when pagination fails halfway — no partial snapshot', async () => {
    const cfn: CloudFormationReader = {
      describeStack: async () => foundStack(),
      describeStackResources: async () => [],
      listStackResources: async (_stackName, nextToken) => {
        if (nextToken === undefined) {
          return { resources: [{ logicalId: 'Vpc', type: 'AWS::EC2::VPC', status: 'CREATE_COMPLETE' }], nextToken: 'page-2' };
        }
        return null;
      },
    };

    expect(await listAllStackResources(cfn, 'deployz-app')).toBeNull();
  });

  it('returns null for a missing stack (stack gone)', async () => {
    const result = await listAllStackResources(
      reader({ lookup: { found: false }, pages: [] }),
      'deployz-app',
    );
    expect(result).toBeNull();
  });

  it('returns null when the stack lookup carries no stack id', async () => {
    const result = await listAllStackResources(
      reader({ lookup: foundStack(undefined as unknown as string), pages: [] }),
      'deployz-app',
    );
    expect(result).toBeNull();
  });

  it('returns an empty inventory for a complete stack with no resources', async () => {
    const result = await listAllStackResources(
      reader({ lookup: foundStack(), pages: [{ resources: [] }] }),
      'deployz-app',
    );
    expect(result).toEqual({ stackId: STACK_ID, resources: [] });
  });

  it('fails closed when a reader throws despite its no-throw contract', async () => {
    const cfn: CloudFormationReader = {
      describeStack: async () => foundStack(),
      describeStackResources: async () => [],
      listStackResources: async () => {
        throw new Error('network layer exploded');
      },
    };
    expect(await listAllStackResources(cfn, 'deployz-app')).toBeNull();
  });

  it('fails closed when the reader does not implement pagination at all', async () => {
    const cfn: CloudFormationReader = {
      describeStack: async () => foundStack(),
      describeStackResources: async () => [],
    };
    expect(await listAllStackResources(cfn, 'deployz-app')).toBeNull();
  });

  it('transports retained and failed resources with their status reasons', async () => {
    const result = await listAllStackResources(
      reader({
        lookup: foundStack(),
        pages: [
          {
            resources: [
              {
                logicalId: 'DatabaseNetworkInterface',
                type: 'AWS::EC2::NetworkInterface',
                status: 'DELETE_SKIPPED',
                physicalId: 'eni-123',
                statusReason: 'Resource cannot be deleted because it is in use',
              },
              {
                logicalId: 'Service',
                type: 'AWS::ECS::Service',
                status: 'CREATE_FAILED',
                statusReason: 'Task definition could not be registered',
              },
            ],
          },
        ],
      }),
      'deployz-app',
    );

    expect(result?.resources).toEqual([
      {
        logicalId: 'DatabaseNetworkInterface',
        type: 'AWS::EC2::NetworkInterface',
        status: 'DELETE_SKIPPED',
        physicalId: 'eni-123',
        statusReason: 'Resource cannot be deleted because it is in use',
      },
      {
        logicalId: 'Service',
        type: 'AWS::ECS::Service',
        status: 'CREATE_FAILED',
        statusReason: 'Task definition could not be registered',
      },
    ]);
  });
});

describe('toReader.listStackResources', () => {
  it('maps a page of resource summaries', async () => {
    const client = {
      send: async () => ({
        StackResourceSummaries: [
          {
            LogicalResourceId: 'Database',
            ResourceType: 'AWS::RDS::DBInstance',
            ResourceStatus: 'CREATE_COMPLETE',
            PhysicalResourceId: 'db-abc',
            ResourceStatusReason: 'ok',
            LastUpdatedTimestamp: new Date('2026-09-01T12:00:00.000Z'),
          },
        ],
      }),
    };

    const page = await toReader(client).listStackResources('deployz-app');

    expect(page).toEqual({
      resources: [
        {
          logicalId: 'Database',
          type: 'AWS::RDS::DBInstance',
          status: 'CREATE_COMPLETE',
          physicalId: 'db-abc',
          timestamp: '2026-09-01T12:00:00.000Z',
          statusReason: 'ok',
        },
      ],
    });
  });

  it('passes the NextToken through to the next request', async () => {
    let requested: unknown;
    const client = {
      send: async (command: { input?: { NextToken?: string } }) => {
        requested = command.input;
        return { StackResourceSummaries: [], NextToken: 'page-2' };
      },
    };

    const page = await toReader(client).listStackResources('deployz-app', 'page-1');

    expect(requested).toMatchObject({ NextToken: 'page-1' });
    expect(page).toEqual({ resources: [], nextToken: 'page-2' });
  });

  it('fails closed — returns null on a throw instead of a partial page', async () => {
    const client = {
      send: async () => {
        throw new Error('throttled');
      },
    };
    expect(await toReader(client).listStackResources('deployz-app')).toBeNull();
  });

  it('reports a missing stack as not found, keeping a stack id when present', async () => {
    const client = {
      send: async () => ({
        Stacks: [
          {
            StackName: 'deployz-app',
            StackId: STACK_ID,
            StackStatus: 'CREATE_COMPLETE',
            Tags: [],
          },
        ],
      }),
    };
    const lookup = await toReader(client).describeStack('deployz-app');
    expect(lookup).toEqual({ found: true, stack: { stackName: 'deployz-app', status: 'CREATE_COMPLETE', tags: {}, stackId: STACK_ID } });
  });
});