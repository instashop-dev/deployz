import type { DeploymentPlan, SpecComponent } from '@deployz/contracts';

import type { ApplicationArchitecture } from '../../src/lib/readiness';

// Phase 4 compositions as hand-authored wire objects. The Phase 3 UI must
// render these through the generic presentation model (plan component groups,
// specComponents, readiness architecture) with no new display code; the
// objects are validated against the real zod schemas in
// phase3-phase4-fixtures.test.tsx.

// ── Composition A: web + 2 workers + MySQL + Redis + object storage ────────

export const webWorkersMysqlRedisPlan: DeploymentPlan = {
  schemaVersion: 1,
  action: 'INSTALL',
  region: 'us-east-2',
  components: [
    {
      kind: 'application',
      name: 'Web application',
      action: 'CREATE',
      lifecycle: 'delete',
      componentId: 'web',
      group: 'application',
    },
    {
      kind: 'worker',
      name: 'Email worker',
      action: 'CREATE',
      lifecycle: 'delete',
      componentId: 'worker-a',
      group: 'application',
    },
    {
      kind: 'worker',
      name: 'Jobs worker',
      action: 'CREATE',
      lifecycle: 'delete',
      componentId: 'worker-b',
      group: 'application',
    },
    {
      kind: 'database',
      name: 'MySQL database',
      action: 'CREATE',
      lifecycle: 'retain',
      componentId: 'mysql',
      group: 'data',
    },
    {
      kind: 'cache',
      name: 'Redis cache',
      action: 'CREATE',
      lifecycle: 'delete',
      componentId: 'redis',
      group: 'cache',
    },
    {
      kind: 'storage',
      name: 'File storage',
      action: 'CREATE',
      lifecycle: 'retain',
      componentId: 'storage',
      group: 'storage',
    },
  ],
  // MySQL-flavoured AWS resource rows — presentation only, the catalog kind
  // vocabulary is what the wire schema allows.
  awsResources: [
    {
      id: 'ecs_service',
      name: 'ECS Fargate service',
      purpose: 'Runs the application container and restarts it if it stops',
      group: 'compute_networking',
      componentKind: 'application',
      lifecycle: 'delete',
    },
    {
      id: 'rds_mysql',
      name: 'RDS MySQL database',
      purpose: 'Stores persistent application data',
      group: 'data',
      componentKind: 'database',
      lifecycle: 'retain',
    },
    {
      id: 'storage_bucket',
      name: 'S3 bucket',
      purpose: 'Stores uploaded files',
      group: 'data',
      componentKind: 'storage',
      lifecycle: 'retain',
    },
  ],
  footprint: {
    version: 1,
    region: 'us-east-2',
    workloads: [
      {
        id: 'web',
        role: 'web',
        label: 'Web application',
        quantity: 1,
        compute: { provider: 'aws', service: 'ecs-fargate', cpuUnits: 512, memoryMiB: 1024, sizeLabel: 'Medium' },
        lifecycle: { persistent: false },
      },
      {
        id: 'worker-a',
        role: 'worker-a',
        label: 'Email worker',
        quantity: 2,
        compute: { provider: 'aws', service: 'ecs-fargate', cpuUnits: 256, memoryMiB: 512, sizeLabel: 'Small' },
        lifecycle: { persistent: false },
      },
      {
        id: 'worker-b',
        role: 'worker-b',
        label: 'Jobs worker',
        quantity: 1,
        compute: { provider: 'aws', service: 'ecs-fargate', cpuUnits: 256, memoryMiB: 512, sizeLabel: 'Small' },
        lifecycle: { persistent: false },
      },
    ],
    resources: [
      {
        id: 'mysql',
        category: 'database',
        provider: 'aws',
        service: 'rds-mysql',
        role: 'database',
        label: 'MySQL database',
        quantity: 1,
        configuration: { engine: 'mysql' },
        lifecycle: { persistent: true, retainOnDelete: true },
      },
      {
        id: 'redis',
        category: 'cache',
        provider: 'aws',
        service: 'elasticache-valkey',
        role: 'cache',
        label: 'Redis cache',
        quantity: 1,
        configuration: {},
        lifecycle: { persistent: false, retainOnDelete: false },
      },
    ],
    generatedFrom: { infraVersion: null },
  },
  costEstimate: {
    currency: 'USD',
    monthlyMin: 92,
    monthlyMax: 128,
    complete: true,
    items: [
      { resourceId: 'web', label: 'Web application', monthlyMin: 9, monthlyMax: 12, pricingStatus: 'estimated' },
      { resourceId: 'mysql', label: 'MySQL database', monthlyMin: 14, monthlyMax: 19, pricingStatus: 'estimated' },
    ],
    usageDependent: ['Data processed by the NAT gateway'],
  },
  requirementDrift: [],
};

export const webWorkersMysqlRedisSpecComponents: SpecComponent[] = [
  { componentId: 'web', label: 'Web application', state: 'IN_PROGRESS', detail: 'Task definition registered' },
  { componentId: 'worker-a', label: 'Email worker', state: 'COMPLETE', detail: '2 tasks running' },
  { componentId: 'worker-b', label: 'Jobs worker', state: 'IN_PROGRESS', detail: 'Task starting' },
  { componentId: 'mysql', label: 'MySQL database', state: 'PENDING', detail: 'Waiting for the database engine' },
  { componentId: 'redis', label: 'Redis cache', state: 'COMPLETE', detail: 'Cluster available' },
  { componentId: 'storage', label: 'File storage', state: 'COMPLETE', detail: 'Bucket ready' },
];

export const webWorkersMysqlRedisArchitecture: ApplicationArchitecture = {
  groups: [
    {
      group: 'application',
      nodes: [
        { label: 'Web application', state: 'detected' },
        { label: 'Email worker', state: 'confirmed' },
        { label: 'Jobs worker', state: 'confirmed' },
      ],
    },
    { group: 'data', nodes: [{ label: 'MySQL database', state: 'confirmed' }] },
    { group: 'cache', nodes: [{ label: 'Redis cache', state: 'confirmed' }] },
    { group: 'storage', nodes: [{ label: 'File storage', state: 'confirmed' }] },
  ],
  unresolved: [
    { kind: 'mysql-database', question: 'Confirm the MySQL database engine version.', blocking: true },
  ],
};

// ── Composition B: web + worker + queue + scheduled job ─────────────────────

export const webWorkerQueueSchedulePlan: DeploymentPlan = {
  schemaVersion: 1,
  action: 'INSTALL',
  region: 'us-east-1',
  components: [
    {
      kind: 'application',
      name: 'Web application',
      action: 'CREATE',
      lifecycle: 'delete',
      componentId: 'web',
      group: 'application',
    },
    {
      kind: 'worker',
      name: 'Background worker',
      action: 'CREATE',
      lifecycle: 'delete',
      componentId: 'worker',
      group: 'application',
    },
    {
      kind: 'queue',
      name: 'Message queue',
      action: 'CREATE',
      lifecycle: 'delete',
      componentId: 'queue',
      group: 'messaging',
    },
    {
      kind: 'schedule',
      name: 'Scheduled job',
      action: 'CREATE',
      lifecycle: 'delete',
      componentId: 'schedule',
      group: 'messaging',
    },
  ],
  awsResources: [
    {
      id: 'worker_task',
      name: 'ECS Fargate task',
      purpose: 'Runs the background worker',
      group: 'compute_networking',
      componentKind: 'application',
      lifecycle: 'delete',
    },
    {
      id: 'message_queue',
      name: 'Message queue',
      purpose: 'Holds work until a worker is ready',
      group: 'data',
      componentKind: 'other',
      lifecycle: 'delete',
    },
  ],
  footprint: {
    version: 1,
    region: 'us-east-1',
    workloads: [
      {
        id: 'web',
        role: 'web',
        label: 'Web application',
        quantity: 1,
        compute: { provider: 'aws', service: 'ecs-fargate', cpuUnits: 256, memoryMiB: 512, sizeLabel: 'Small' },
        lifecycle: { persistent: false },
      },
      {
        id: 'worker',
        role: 'worker',
        label: 'Background worker',
        quantity: 1,
        compute: { provider: 'aws', service: 'ecs-fargate', cpuUnits: 256, memoryMiB: 512, sizeLabel: 'Small' },
        lifecycle: { persistent: false },
      },
    ],
    resources: [
      {
        id: 'queue',
        category: 'queue',
        provider: 'aws',
        service: 'sqs',
        role: 'queue',
        label: 'Message queue',
        quantity: 1,
        configuration: {},
        lifecycle: { persistent: false, retainOnDelete: false },
      },
    ],
    generatedFrom: { infraVersion: null },
  },
  costEstimate: {
    currency: 'USD',
    monthlyMin: 40,
    monthlyMax: 55,
    complete: true,
    items: [
      { resourceId: 'web', label: 'Web application', monthlyMin: 8, monthlyMax: 11, pricingStatus: 'estimated' },
      { resourceId: 'worker', label: 'Background worker', monthlyMin: 8, monthlyMax: 11, pricingStatus: 'estimated' },
    ],
    usageDependent: ['Queue requests'],
  },
  requirementDrift: [],
};

export const webWorkerQueueScheduleSpecComponents: SpecComponent[] = [
  { componentId: 'web', label: 'Web application', state: 'IN_PROGRESS', detail: 'Task definition registered' },
  { componentId: 'worker', label: 'Background worker', state: 'PENDING', detail: 'Waiting for the web service' },
  { componentId: 'queue', label: 'Message queue', state: 'COMPLETE', detail: 'Queue created' },
  { componentId: 'schedule', label: 'Scheduled job', state: 'PENDING', detail: 'Waiting for the worker' },
];

// ── Future-server fixture: a component the current client has never seen ────

export const futureCapabilitySpecComponent: SpecComponent = {
  componentId: 'future-capability-x',
  label: 'Future capability',
  state: 'IN_PROGRESS',
};
