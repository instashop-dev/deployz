import { describe, expect, it } from 'vitest';

import type { DeploymentPlan, FootprintWorkload, PlanComponentGroup } from '@deployz/contracts';
import {
  formatMonthlyRange,
} from '../src/lib/footprint';
import {
  installPlanRegionLabel,
  installPlanResourceGroups,
  installPlanRetentionNote,
  installPlanRowGroups,
  installPlanRows,
} from '../src/lib/install-plan';

function plan(overrides: Partial<DeploymentPlan> = {}): DeploymentPlan {
  return {
    schemaVersion: 1,
    action: 'INSTALL',
    region: 'us-east-2',
    components: [],
    awsResources: [],
    requirementDrift: [],
    ...overrides,
  };
}

function component(
  kind: DeploymentPlan['components'][number]['kind'],
  name: string,
  action: DeploymentPlan['components'][number]['action'] = 'CREATE',
  lifecycle: 'delete' | 'retain' = 'delete',
  group?: PlanComponentGroup,
) {
  return { kind, name, action, lifecycle, ...(group ? { group } : {}) };
}

function awsResource(
  overrides: Partial<DeploymentPlan['awsResources'][number]> = {},
): DeploymentPlan['awsResources'][number] {
  return {
    id: 'ecs_service',
    name: 'ECS Fargate service',
    purpose: 'Runs the application container and restarts it if it stops',
    group: 'compute_networking',
    componentKind: 'application',
    lifecycle: 'delete',
    ...overrides,
  };
}

function workload(id: string, label: string, quantity = 1): FootprintWorkload {
  return {
    id,
    role: id,
    label,
    quantity,
    compute: {
      provider: 'aws',
      service: 'ecs-fargate',
      cpuUnits: 256,
      memoryMiB: 512,
      sizeLabel: 'Small',
    },
    lifecycle: { persistent: false },
  };
}

describe('installPlanRowGroups', () => {
  it('groups rows by component group with headings, only non-empty groups, in canonical order', () => {
    const groups = installPlanRowGroups(
      plan({
        components: [
          component('database', 'Database', 'CREATE', 'retain'),
          component('application', 'Application'),
          component('endpoint', 'Secure endpoint'),
          component('cache', 'Cache'),
        ],
      }),
    );
    expect(groups.map((entry) => entry.group)).toEqual(['application', 'data', 'cache', 'edge']);
    expect(groups.map((entry) => entry.label)).toEqual(['Application', 'Data', 'Cache', 'Edge']);
    expect(groups[0]!.rows.map((row) => row.name)).toEqual(['Application']);
    expect(groups[1]!.rows.map((row) => row.name)).toEqual(['Database']);
  });

  it('prefers the component\'s own group when present', () => {
    const groups = installPlanRowGroups(
      plan({ components: [component('endpoint', 'Secure endpoint', 'CREATE', 'delete', 'networking')] }),
    );
    expect(groups.map((entry) => entry.group)).toEqual(['networking']);
  });

  it('falls back through kind when the group value is unknown, and never drops the row', () => {
    const mystery = 'mystery' as unknown as PlanComponentGroup;
    const rows = installPlanRows(
      plan({
        components: [
          component('endpoint', 'Secure endpoint', 'CREATE', 'delete', mystery),
          component('queue', 'Task queue'),
        ],
      }),
    );
    expect(rows.map((row) => row.group)).toEqual(['edge', 'messaging']);
    const groups = installPlanRowGroups(
      plan({
        components: [
          component('endpoint', 'Secure endpoint', 'CREATE', 'delete', mystery),
          component('queue', 'Task queue'),
        ],
      }),
    );
    expect(groups.map((entry) => entry.group)).toEqual(['messaging', 'edge']);
  });
});

describe('installPlanResourceGroups', () => {
  it('renders a simple postgres plan materially as before, grouped by plan component groups', () => {
    const groups = installPlanResourceGroups(
      plan({
        components: [
          component('application', 'Application'),
          component('endpoint', 'Secure endpoint'),
          component('database', 'Database', 'CREATE', 'retain'),
        ],
        awsResources: [
          awsResource(),
          awsResource({
            id: 'database',
            name: 'RDS PostgreSQL database',
            purpose: 'Stores persistent application data',
            group: 'data',
            componentKind: 'database',
            lifecycle: 'retain',
          }),
        ],
        footprint: {
          version: 1,
          region: 'us-east-2',
          workloads: [workload('web', 'Web application')],
          resources: [],
          generatedFrom: { infraVersion: null },
        },
      }),
    );

    expect(groups[0]!.group).toBe('connector');
    expect(groups[0]!.label).toBe('Deployz connector');
    expect(groups[0]!.rows.map((row) => row.name)).toEqual([
      'Deployz connector (AWS Lambda)',
      'Connector IAM role',
      'Connector credential (Secrets Manager)',
      'Connector schedule (EventBridge)',
    ]);

    const planGroupEntries = groups.slice(1);
    expect(planGroupEntries.map((entry) => entry.group)).toEqual(['application', 'data']);
    const ecs = planGroupEntries[0]!.rows.find((row) => row.id === 'ecs_service')!;
    expect(ecs.serviceAndConfiguration).toBe('ECS Fargate service · 1 × Small · 0.25 vCPU · 512 MB');
    const database = planGroupEntries[1]!.rows.find((row) => row.id === 'database')!;
    expect(database.name).toBe('RDS PostgreSQL database');
    expect(database.onRemoval).toBe('Retained in your AWS account');
  });

  it('gives every footprint workload its own sizing line', () => {
    const groups = installPlanResourceGroups(
      plan({
        components: [component('application', 'Application')],
        awsResources: [awsResource()],
        footprint: {
          version: 1,
          region: 'us-east-2',
          workloads: [
            workload('web', 'Web application'),
            workload('email-worker', 'Email worker', 2),
            workload('jobs-worker', 'Jobs worker'),
          ],
          resources: [],
          generatedFrom: { infraVersion: null },
        },
      }),
    );

    const ecs = groups
      .find((entry) => entry.group === 'application')!
      .rows.find((row) => row.id === 'ecs_service')!;
    const lines = ecs.serviceAndConfiguration.split('\n');
    expect(lines).toEqual([
      'ECS Fargate service · Web application · 1 × Small · 0.25 vCPU · 512 MB',
      'Email worker · 2 × Small · 0.25 vCPU · 512 MB',
      'Jobs worker · 1 × Small · 0.25 vCPU · 512 MB',
    ]);
  });

  it('keeps an unknown component kind visible under Application', () => {
    const groups = installPlanResourceGroups(
      plan({
        awsResources: [
          awsResource({
            id: 'registry',
            name: 'Container registry',
            group: 'data',
            componentKind: 'container_registry',
          }),
        ],
      }),
    );
    const application = groups.find((entry) => entry.group === 'application')!;
    expect(application.rows.map((row) => row.id)).toEqual(['registry']);
  });

  it('orders plan component groups canonically and omits empty groups', () => {
    const groups = installPlanResourceGroups(
      plan({
        awsResources: [
          awsResource({ id: 'endpoint', componentKind: 'endpoint' }),
          awsResource({ id: 'storage_bucket', componentKind: 'storage', group: 'data' }),
          awsResource({ id: 'database', componentKind: 'database', group: 'data' }),
        ],
      }),
    );
    expect(groups.map((entry) => entry.group)).toEqual(['connector', 'data', 'storage', 'edge']);
  });
});

describe('truthful region and cost fallbacks', () => {
  it('keeps the estimate unavailable when the cost parts are missing', () => {
    expect(formatMonthlyRange(null, null)).toBeNull();
  });

  it('keeps an unrecognized region hidden rather than raw', () => {
    expect(installPlanRegionLabel('mars-central-1')).toBeNull();
  });
});

describe('generic retention derivation', () => {
  it('derives the retention note from every retained plan component, whatever it is', () => {
    const note = installPlanRetentionNote(
      plan({
        components: [
          component('database', 'Database', 'CREATE', 'retain'),
          component('storage', 'Storage', 'CREATE', 'retain'),
          component('queue', 'Task queue', 'CREATE', 'retain'),
        ],
      }),
    );
    expect(note).toBe(
      'When this deployment is removed, Database, Storage, and Task queue stay in your AWS account.',
    );
  });
});
