import { describe, expect, it } from 'vitest';

import {
  type ApplicationGraph,
  type DeploymentManifest,
  CAPABILITY_KEYS,
  cronExpressionError,
  deploymentManifestSchema,
} from '@deployz/contracts';

import { manifestToApplicationGraph } from '../src/graph.js';
import { planApplicationGraph } from '../src/planner.js';
import { relationshipViolations } from '../src/relationships.js';

// Phase 5B: producer/consumer, redrive and schedule edges are first-class
// graph relationships; the planner resolves them into capabilities and
// edge-specific IAM, and fails closed on any orphaned or mistyped edge.

const MANIFEST: DeploymentManifest = deploymentManifestSchema.parse({
  application: { root: '.', runtime: 'node', framework: 'express', dockerfilePath: 'Dockerfile' },
  build: { command: 'npm run build', context: '.' },
  web: { command: 'node dist/server.js', port: 3000 },
  health: { path: '/health', mode: 'explicit' },
  database: { postgres: true, engine: 'mysql' },
  redis: { required: false, envBindings: [] },
  storage: { required: true, envBindings: [{ name: 'S3_BUCKET', kind: 'bucket' }] },
  migration: { command: null, mode: 'startup' },
  worker: { command: 'node dist/worker.js' },
  workers: [{ id: 'worker', command: 'node dist/worker.js', source: 'Procfile' }],
  queues: [
    {
      id: 'orders-queue',
      envBindings: [{ name: 'ORDERS_QUEUE_URL', kind: 'url' }],
      producers: ['web'],
      consumers: ['worker'],
      visibilityTimeoutSeconds: 120,
      deadLetter: {
        maxReceiveCount: 5,
        envBindings: [{ name: 'ORDERS_DLQ_URL', kind: 'url' }],
        producers: [],
        consumers: ['worker'],
      },
      source: 'src/orders.ts',
    },
    {
      id: 'emails-queue',
      envBindings: [{ name: 'EMAILS_QUEUE_URL', kind: 'url' }],
      producers: ['web', 'worker'],
      consumers: ['worker'],
      source: 'src/emails.ts',
    },
  ],
  scheduledJobs: [
    {
      id: 'cleanup',
      command: 'node dist/cleanup.js',
      schedule: { type: 'cron', cron: '0 3 * * *' },
      timezone: 'Europe/Berlin',
      deadLetter: true,
      source: 'k8s/cleanup-cronjob.yaml',
    },
  ],
  questions: [
    {
      id: 'queue-audit-queue',
      field: 'queue_relationship',
      question: 'Which process consumes AUDIT_QUEUE_URL?',
      source: 'src/audit.ts',
    },
  ],
  environment: { variables: [] },
  externalServices: [],
  unsupported: [],
});

function edges(graph: ApplicationGraph, access: string): string[] {
  return graph.bindings
    .filter((b) => b.access === access)
    .map((b) => `${b.sourceId}->${b.targetId}`)
    .sort();
}

describe('async relationships — manifest → graph', () => {
  const graph = manifestToApplicationGraph(MANIFEST);

  it('models queues, dead-letter queues, schedules and the scheduled job as components', () => {
    expect(graph.workloads.map((w) => `${w.id}:${w.kind}`)).toEqual(['web:web', 'worker:worker', 'cleanup:scheduled-job']);
    expect(graph.resources.filter((r) => r.kind === 'queue').map((r) => r.id)).toEqual([
      'orders-queue',
      'orders-queue-dlq',
      'emails-queue',
      'cleanup-schedule-dlq',
    ]);
    expect(graph.schedules?.map((s) => s.id)).toEqual(['cleanup-schedule']);
    expect(graph.schedules?.[0]).toMatchObject({
      expression: { type: 'cron', cron: '0 3 * * *' },
      timezone: 'Europe/Berlin',
      retry: { maximumRetryAttempts: 3, maximumEventAgeSeconds: 3600 },
      enabled: true,
    });
  });

  it('represents every producer/consumer/redrive/schedule edge explicitly', () => {
    expect(edges(graph, 'produce')).toEqual(['web->emails-queue', 'web->orders-queue', 'worker->emails-queue']);
    expect(edges(graph, 'consume')).toEqual(['worker->emails-queue', 'worker->orders-queue', 'worker->orders-queue-dlq']);
    expect(edges(graph, 'dead-letter')).toEqual(['cleanup-schedule->cleanup-schedule-dlq', 'orders-queue->orders-queue-dlq']);
    expect(edges(graph, 'invoke')).toEqual(['cleanup-schedule->cleanup']);
    expect(graph.bindings.find((b) => b.sourceId === 'orders-queue')?.maxReceiveCount).toBe(5);
    expect(relationshipViolations(graph)).toEqual([]);
  });

  it('binds the env names the application reads, only on the edges that read them', () => {
    const webOrders = graph.bindings.find((b) => b.sourceId === 'web' && b.targetId === 'orders-queue');
    expect(webOrders?.envBindings).toEqual([{ name: 'ORDERS_QUEUE_URL', kind: 'url' }]);
    expect(graph.bindings.some((b) => b.sourceId === 'cleanup' && b.targetId === 'orders-queue')).toBe(false);
  });

  it('turns ambiguous evidence into a non-blocking question', () => {
    expect(graph.unresolved.find((u) => u.id === 'queue-audit-queue')).toMatchObject({
      field: 'queue_relationship',
      blocking: false,
    });
  });

  it('keeps a pre-Phase-5 manifest graph free of schedules and edge roles', () => {
    const { queues: _q, scheduledJobs: _s, questions: _x, ...legacy } = MANIFEST;
    const legacyGraph = manifestToApplicationGraph(legacy);
    expect('schedules' in legacyGraph).toBe(false);
    expect(legacyGraph.bindings.every((b) => b.access === undefined)).toBe(true);
  });
});

describe('async relationships — graph → IR', () => {
  const ir = planApplicationGraph({ graph: manifestToApplicationGraph(MANIFEST), region: 'us-east-1' });

  it('resolves every queue to Standard SQS with bounded configuration', () => {
    const queues = ir.resources.filter((r) => r.capabilityKey === CAPABILITY_KEYS.SQS);
    expect(queues.map((q) => q.componentId)).toEqual(['orders-queue', 'orders-queue-dlq', 'emails-queue', 'cleanup-schedule-dlq']);
    expect(queues.find((q) => q.componentId === 'orders-queue')?.configuration).toEqual({
      queueType: 'standard',
      messageRetentionSeconds: 345600,
      visibilityTimeoutSeconds: 120,
    });
    // Dead-letter targets keep failures for the SQS maximum.
    expect(queues.find((q) => q.componentId === 'orders-queue-dlq')?.configuration['messageRetentionSeconds']).toBe(1209600);
    expect(queues.every((q) => q.lifecycle === 'delete')).toBe(true);
  });

  it('derives edge-specific, least-privilege IAM intent', () => {
    const actions = (sourceId: string, targetId: string): string[] =>
      ir.bindings.find((b) => b.sourceId === sourceId && b.targetId === targetId)?.iamActions ?? [];
    expect(actions('web', 'orders-queue')).toEqual(['sqs:SendMessage']);
    expect(actions('worker', 'orders-queue')).toEqual([
      'sqs:ReceiveMessage',
      'sqs:DeleteMessage',
      'sqs:ChangeMessageVisibility',
      'sqs:GetQueueAttributes',
    ]);
    expect(actions('cleanup-schedule', 'cleanup')).toEqual(['ecs:RunTask', 'iam:PassRole']);
    expect(actions('cleanup-schedule', 'cleanup-schedule-dlq')).toEqual(['sqs:SendMessage']);
    // The pre-Phase-5 superset bindings keep their original S3 intent.
    expect(actions('web', 'storage')).toContain('s3:GetObject');
    // No workload other than the edge's own source gains SQS actions.
    const sqsSources = new Set(ir.bindings.filter((b) => b.iamActions.some((a) => a.startsWith('sqs:'))).map((b) => b.sourceId));
    expect([...sqsSources].sort()).toEqual(['cleanup-schedule', 'orders-queue', 'web', 'worker']);
  });

  it('resolves the schedule to EventBridge Scheduler targeting the scheduled job', () => {
    expect(ir.schedules).toEqual([
      {
        id: 'cleanup-schedule',
        capabilityKey: CAPABILITY_KEYS.EVENTBRIDGE_SCHEDULER,
        label: 'Schedule for cleanup',
        expression: { type: 'cron', cron: '0 3 * * *' },
        timezone: 'Europe/Berlin',
        targetWorkloadId: 'cleanup',
        retry: { maximumRetryAttempts: 3, maximumEventAgeSeconds: 3600 },
        deadLetterQueueId: 'cleanup-schedule-dlq',
        enabled: true,
      },
    ]);
    expect(ir.workloads.find((w) => w.componentId === 'cleanup')?.compute.capabilityKey).toBe(CAPABILITY_KEYS.ECS_FARGATE_TASK);
  });

  it('is deterministic', () => {
    const again = planApplicationGraph({ graph: manifestToApplicationGraph(MANIFEST), region: 'us-east-1' });
    expect(JSON.stringify(again)).toBe(JSON.stringify(ir));
  });
});

describe('async relationships — fail closed', () => {
  const graph = manifestToApplicationGraph(MANIFEST);
  const without = (predicate: (b: ApplicationGraph['bindings'][number]) => boolean): ApplicationGraph => ({
    ...graph,
    bindings: graph.bindings.filter((b) => !predicate(b)),
  });

  it('rejects a queue that loses its consumer (invalid deselection)', () => {
    const broken = without((b) => b.access === 'consume' && b.targetId === 'emails-queue');
    expect(relationshipViolations(broken)).toContain('queue emails-queue needs at least one producer and one consumer');
    expect(() => planApplicationGraph({ graph: broken, region: 'us-east-1' })).toThrow(/invalid relationships/);
  });

  it('rejects a scheduled job with no schedule, and a schedule with no target', () => {
    const broken = without((b) => b.access === 'invoke');
    expect(relationshipViolations(broken)).toEqual(
      expect.arrayContaining([
        'schedule cleanup-schedule must invoke exactly one scheduled job',
        'scheduled job cleanup must be invoked by exactly one schedule',
      ]),
    );
  });

  it('rejects an edge to an unknown component and a produce edge from a queue', () => {
    const extra: ApplicationGraph = {
      ...graph,
      bindings: [
        ...graph.bindings,
        { ...graph.bindings[0]!, id: 'x-1', sourceId: 'web', targetId: 'ghost', access: 'produce' },
        { ...graph.bindings[0]!, id: 'x-2', sourceId: 'orders-queue', targetId: 'emails-queue', access: 'produce' },
      ],
    };
    expect(relationshipViolations(extra)).toEqual(
      expect.arrayContaining([
        'binding x-1 references an unknown component (web → ghost)',
        'binding x-2: produce must connect a workload to a queue',
      ]),
    );
  });

  it('rejects a FIFO queue — it resolves to no capability', () => {
    const fifo: ApplicationGraph = {
      ...graph,
      resources: graph.resources.map((r) => (r.id === 'emails-queue' ? { ...r, engine: 'fifo' } : r)),
    };
    expect(() => planApplicationGraph({ graph: fifo, region: 'us-east-1' })).toThrow(/resolves to no capability/);
  });

  it('rejects duplicate component ids across workloads, resources and schedules', () => {
    const clash: ApplicationGraph = {
      ...graph,
      schedules: [...(graph.schedules ?? []), { ...graph.schedules![0]!, id: 'orders-queue' }],
    };
    expect(relationshipViolations(clash)).toContain('duplicate component id "orders-queue"');
  });
});

describe('schedule expressions are bounded', () => {
  it.each([
    ['0 3 * * *', null],
    ['*/15 * * * MON-FRI', null],
    ['0 0 1,15 * *', null],
    ['0 3 * * * *', 'cron expression must have exactly five fields'],
    ['@daily', 'cron expression must have exactly five fields'],
    ['0 3 1 * 1', 'cron expression may not restrict both day-of-month and day-of-week'],
    ['61 * * * *', 'invalid minute value "61"'],
    ['0 3 ? * *', 'invalid day-of-month value "?"'],
  ])('%s', (cron, error) => {
    expect(cronExpressionError(cron)).toBe(error);
  });

  it('rejects an unknown timezone and an out-of-range retry policy', () => {
    const job = MANIFEST.scheduledJobs![0]!;
    const parse = (patch: Record<string, unknown>) =>
      deploymentManifestSchema.safeParse({ ...MANIFEST, scheduledJobs: [{ ...job, ...patch }] }).success;
    expect(parse({ timezone: 'Mars/Olympus' })).toBe(false);
    expect(parse({ retry: { maximumRetryAttempts: 186, maximumEventAgeSeconds: 60 } })).toBe(false);
    expect(parse({ retry: { maximumRetryAttempts: 0, maximumEventAgeSeconds: 59 } })).toBe(false);
    expect(parse({ schedule: { type: 'rate', value: 0, unit: 'minutes' } })).toBe(false);
  });
});
