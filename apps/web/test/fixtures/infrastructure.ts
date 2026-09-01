import type {
  InfrastructureComponent,
  InfrastructureComponentKind,
  InfrastructureComponentStatus,
  InfrastructureLifecycle,
  InfrastructureResponse,
  InfrastructureSummaryStatus,
} from '../../src/lib/deployments';

const baseComponent = (kind: InfrastructureComponentKind): InfrastructureComponent => ({
  kind,
  name: kind.charAt(0).toUpperCase() + kind.slice(1).replace('_', ' '),
  purpose: 'Test purpose',
  status: 'ready' as InfrastructureComponentStatus,
  awsService: 'AWS',
  region: 'us-east-2',
  lifecycle: 'delete' as InfrastructureLifecycle,
  resources: [],
});

export function makeInfrastructureResponse(
  overrides: Partial<InfrastructureResponse> = {},
): InfrastructureResponse {
  return {
    provider: 'aws',
    region: 'us-east-2',
    stackStatus: 'CREATE_COMPLETE',
    connectionState: 'connected',
    snapshotState: 'fresh',
    summary: {
      status: 'healthy' as InfrastructureSummaryStatus,
      componentCount: 0,
      technicalResourceCount: 0,
    },
    components: [],
    lastUpdatedAt: '2026-09-01T00:00:00.000Z',
    disconnectWarning: null,
    ...overrides,
  };
}

export const infrastructureFixtures = {
  none: makeInfrastructureResponse({
    snapshotState: 'none',
    summary: { status: 'unknown', componentCount: 0, technicalResourceCount: 0 },
  }),

  provisioning: makeInfrastructureResponse({
    snapshotState: 'fresh',
    summary: { status: 'provisioning', componentCount: 3, technicalResourceCount: 5 },
    components: [
      { ...baseComponent('application'), status: 'provisioning', awsService: 'ECS' },
      { ...baseComponent('database'), status: 'pending', awsService: 'RDS', lifecycle: 'retain' },
      { ...baseComponent('network'), status: 'ready', awsService: 'VPC' },
    ],
  }),

  healthy: makeInfrastructureResponse({
    snapshotState: 'fresh',
    summary: { status: 'healthy', componentCount: 4, technicalResourceCount: 6 },
    components: [
      { ...baseComponent('application'), status: 'ready', awsService: 'ECS' },
      { ...baseComponent('database'), status: 'ready', awsService: 'RDS', lifecycle: 'retain' },
      { ...baseComponent('storage'), status: 'ready', awsService: 'S3', lifecycle: 'retain' },
      { ...baseComponent('network'), status: 'ready', awsService: 'VPC' },
    ],
  }),

  updating: makeInfrastructureResponse({
    snapshotState: 'fresh',
    summary: { status: 'updating', componentCount: 2, technicalResourceCount: 4 },
    components: [
      { ...baseComponent('application'), status: 'updating', awsService: 'ECS' },
      { ...baseComponent('database'), status: 'ready', awsService: 'RDS', lifecycle: 'retain' },
    ],
  }),

  failure: makeInfrastructureResponse({
    snapshotState: 'fresh',
    summary: { status: 'failed', componentCount: 3, technicalResourceCount: 3 },
    components: [
      {
        ...baseComponent('application'),
        status: 'failed',
        awsService: 'ECS',
        resources: [
          {
            logicalId: 'TaskDefinition',
            physicalId: 'arn:aws:ecs:...',
            type: 'AWS::ECS::TaskDefinition',
            status: 'CREATE_FAILED',
            statusReason: 'Resource handler returned message: No space left.',
          },
        ],
      },
      { ...baseComponent('database'), status: 'ready', awsService: 'RDS', lifecycle: 'retain' },
      { ...baseComponent('network'), status: 'ready', awsService: 'VPC' },
    ],
  }),

  deleting: makeInfrastructureResponse({
    snapshotState: 'fresh',
    summary: { status: 'deleting', componentCount: 3, technicalResourceCount: 3 },
    components: [
      { ...baseComponent('application'), status: 'deleting', awsService: 'ECS', lifecycle: 'delete' },
      { ...baseComponent('database'), status: 'retained', awsService: 'RDS', lifecycle: 'retain' },
      { ...baseComponent('storage'), status: 'retained', awsService: 'S3', lifecycle: 'snapshot' },
    ],
  }),

  retained: makeInfrastructureResponse({
    snapshotState: 'stale',
    summary: { status: 'retained', componentCount: 2, technicalResourceCount: 2 },
    components: [
      { ...baseComponent('database'), status: 'retained', awsService: 'RDS', lifecycle: 'retain' },
      { ...baseComponent('storage'), status: 'retained', awsService: 'S3', lifecycle: 'retain' },
    ],
  }),

  disconnected: makeInfrastructureResponse({
    snapshotState: 'stale',
    connectionState: 'disconnected',
    summary: { status: 'unknown', componentCount: 2, technicalResourceCount: 2 },
    disconnectWarning: { lastVerifiedAt: '2026-08-31T23:00:00.000Z' },
    components: [
      { ...baseComponent('application'), status: 'unknown', awsService: 'ECS' },
      { ...baseComponent('database'), status: 'unknown', awsService: 'RDS', lifecycle: 'retain' },
    ],
  }),

  withCache: makeInfrastructureResponse({
    snapshotState: 'fresh',
    summary: { status: 'healthy', componentCount: 2, technicalResourceCount: 2 },
    components: [
      { ...baseComponent('application'), status: 'ready', awsService: 'ECS' },
      { ...baseComponent('cache'), status: 'ready', awsService: 'ElastiCache', lifecycle: 'retain' },
    ],
  }),

  withoutCache: makeInfrastructureResponse({
    snapshotState: 'fresh',
    summary: { status: 'healthy', componentCount: 1, technicalResourceCount: 1 },
    components: [{ ...baseComponent('application'), status: 'ready', awsService: 'ECS' }],
  }),
};
