import { describe, expect, it } from 'vitest';

import type { DeploymentPlan } from '@deployz/contracts';
import {
  awsResourceGroups,
  awsResourceRemovalLabel,
  installPlanRegionLabel,
  installPlanRetentionNote,
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

function component(
  kind: 'application' | 'endpoint' | 'database' | 'cache' | 'storage',
  name: string,
  action: DeploymentPlan['components'][number]['action'] = 'CREATE',
  lifecycle: 'delete' | 'retain' = 'delete',
) {
  return { kind, name, action, lifecycle };
}

describe('installPlanRows', () => {
  it('returns the fallback application row when the plan is null', () => {
    const rows = installPlanRows(null);
    expect(rows).toEqual([{ kind: 'application', name: 'Application', whatHappens: 'Runs your application' }]);
  });

  it('returns only the CREATE components, in the plan\'s order', () => {
    const rows = installPlanRows(
      plan({
        components: [
          component('application', 'Application'),
          component('endpoint', 'Secure endpoint'),
          component('database', 'Database', 'UNCHANGED', 'retain'),
        ],
      }),
    );
    expect(rows.map((r) => r.kind)).toEqual(['application', 'endpoint']);
  });

  it('fills whatHappens from the shared component display, not the plan itself', () => {
    const rows = installPlanRows(plan({ components: [component('database', 'Database', 'CREATE', 'retain')] }));
    expect(rows).toEqual([
      { kind: 'database', name: 'Database', whatHappens: 'Stores persistent application data' },
    ]);
  });
});

describe('installPlanRetentionNote', () => {
  it('is null when the plan is unavailable', () => {
    expect(installPlanRetentionNote(null)).toBeNull();
  });

  it('is null when nothing is retained (a fully stateless deployment)', () => {
    const note = installPlanRetentionNote(
      plan({ components: [component('application', 'Application'), component('endpoint', 'Secure endpoint')] }),
    );
    expect(note).toBeNull();
  });

  it('names one retained component, with singular agreement', () => {
    const note = installPlanRetentionNote(plan({ components: [component('database', 'Database', 'CREATE', 'retain')] }));
    expect(note).toBe('When this deployment is removed, Database stays in your AWS account.');
  });

  it('joins two retained components with "and"', () => {
    const note = installPlanRetentionNote(
      plan({
        components: [
          component('database', 'Database', 'CREATE', 'retain'),
          component('storage', 'Storage', 'CREATE', 'retain'),
        ],
      }),
    );
    expect(note).toBe('When this deployment is removed, Database and Storage stay in your AWS account.');
  });

  it('joins three or more retained components with a serial comma', () => {
    const note = installPlanRetentionNote(
      plan({
        components: [
          component('database', 'Database', 'CREATE', 'retain'),
          component('storage', 'Storage', 'CREATE', 'retain'),
          component('cache', 'Cache', 'CREATE', 'retain'),
        ],
      }),
    );
    expect(note).toBe('When this deployment is removed, Database, Storage, and Cache stay in your AWS account.');
  });
});

describe('installPlanRegionLabel', () => {
  it('returns the friendly label for a recognized region', () => {
    expect(installPlanRegionLabel('us-east-2')).toBe('US East (Ohio)');
  });

  it('returns null for an unrecognized region, rather than a raw region code', () => {
    expect(installPlanRegionLabel('mars-central-1')).toBeNull();
  });
});

describe('awsResourceRemovalLabel', () => {
  it('is "Deleted" for a delete-lifecycle resource', () => {
    expect(awsResourceRemovalLabel('delete')).toBe('Deleted');
  });

  it('is "Kept in your AWS account" for a retain-lifecycle resource', () => {
    expect(awsResourceRemovalLabel('retain')).toBe('Kept in your AWS account');
  });
});

describe('awsResourceGroups', () => {
  it('is empty when the plan is unavailable', () => {
    expect(awsResourceGroups(null)).toEqual([]);
  });

  it('groups resources under their heading, in catalog order, omitting empty groups', () => {
    const groups = awsResourceGroups(
      plan({
        awsResources: [
          awsResource({ id: 'database', group: 'data', name: 'RDS PostgreSQL database' }),
          awsResource({ id: 'ecs_service', group: 'compute_networking', name: 'ECS Fargate service' }),
          awsResource({ id: 'log_group', group: 'security_operations', name: 'CloudWatch log group' }),
        ],
      }),
    );
    expect(groups.map((entry) => entry.group)).toEqual(['compute_networking', 'data', 'security_operations']);
    expect(groups.map((entry) => entry.label)).toEqual(['Compute & Networking', 'Data', 'Security & Operations']);
    expect(groups.map((entry) => entry.resources.map((resource) => resource.id))).toEqual([
      ['ecs_service'],
      ['database'],
      ['log_group'],
    ]);
  });

  it('omits a group with no resources for a stateless plan', () => {
    const groups = awsResourceGroups(
      plan({
        awsResources: [
          awsResource({ id: 'ecs_service', group: 'compute_networking' }),
          awsResource({ id: 'iam_roles', group: 'security_operations' }),
        ],
      }),
    );
    expect(groups.map((entry) => entry.group)).toEqual(['compute_networking', 'security_operations']);
  });
});
