import { describe, expect, it } from 'vitest';

import { resolveDeploymentFootprint } from '@deployz/contracts';
import type { DeploymentManifest, DeploymentPlan, FootprintResource } from '@deployz/contracts';
import {
  awsResourceGroups,
  awsResourceRemovalLabel,
  installPlanRegionLabel,
  installPlanRetentionNote,
  installPlanResourceGroups,
  installPlanRows,
} from '../src/lib/install-plan';

function manifestWith(overrides: Partial<DeploymentManifest> = {}): DeploymentManifest {
  return {
    schemaVersion: 1,
    application: { root: '.', runtime: 'node', framework: null, dockerfilePath: 'Dockerfile' },
    build: { command: 'npm run build', context: '.' },
    web: { command: 'npm start', port: 3000 },
    health: { path: '/health' },
    database: { postgres: false },
    redis: { required: false, envBindings: [] },
    storage: { required: false, envBindings: [] },
    migration: { command: null },
    worker: { command: null },
    environment: { variables: [] },
    externalServices: [],
    unsupported: [],
    ...overrides,
  };
}

const WORKERS_MANIFEST = manifestWith({
  worker: { command: 'npm run email' },
  workers: [
    { id: 'email-worker', command: 'npm run email', source: 'Procfile' },
    { id: 'import-worker', command: 'npm run import', source: 'Procfile' },
  ],
});

function footprintPlan(overrides: {
  manifest?: DeploymentManifest;
  awsResources?: DeploymentPlan['awsResources'];
}): DeploymentPlan {
  const footprint = resolveDeploymentFootprint({ manifest: overrides.manifest ?? manifestWith(), region: 'us-east-1' });
  return {
    schemaVersion: 1,
    action: 'INSTALL',
    region: 'us-east-1',
    components: [],
    awsResources: overrides.awsResources ?? [],
    footprint,
    requirementDrift: [],
  };
}

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

describe('installPlanResourceGroups', () => {
  const computeRows = (groups: ReturnType<typeof installPlanResourceGroups>) =>
    groups.find((entry) => entry.group === 'compute_networking')?.rows ?? [];

  it('renders one workload row for a single-workload deployment, carrying the workload sizing', () => {
    const rows = computeRows(installPlanResourceGroups(footprintPlan({})));
    const workloadRows = rows.filter((row) => row.id.startsWith('workload-'));
    expect(workloadRows).toEqual([
      {
        id: 'workload-web',
        name: 'Web application',
        serviceAndConfiguration: 'AWS Fargate · 1 × Small · 0.25 vCPU · 512 MB',
        purpose: "Serves the application's public traffic",
        onRemoval: 'Removed automatically',
      },
    ]);
  });

  it('renders one row per workload for a multi-worker deployment, workers without public-ingress wording', () => {
    const rows = computeRows(installPlanResourceGroups(footprintPlan({ manifest: WORKERS_MANIFEST })));
    const workloadRows = rows.filter((row) => row.id.startsWith('workload-'));
    expect(workloadRows.map((row) => row.id)).toEqual([
      'workload-web',
      'workload-email-worker',
      'workload-import-worker',
    ]);
    expect(workloadRows.map((row) => row.name)).toEqual([
      'Web application',
      'Worker email-worker',
      'Worker import-worker',
    ]);
    for (const row of workloadRows.slice(1)) {
      expect(row.purpose).toBe('Processes background jobs — not reachable from the internet');
      expect(row.onRemoval).toBe('Removed automatically');
      expect(row.purpose.toLowerCase()).not.toContain('public');
      expect(row.serviceAndConfiguration).not.toMatch(/https?:\/\//);
    }
  });

  it('sizes managed resources from the footprint by catalog role', () => {
    const groups = installPlanResourceGroups(
      footprintPlan({
        manifest: manifestWith({ database: { postgres: true } }),
        awsResources: [
          {
            id: 'database',
            name: 'RDS PostgreSQL database',
            purpose: 'Stores persistent application data',
            group: 'data',
            componentKind: 'database',
            lifecycle: 'retain',
          },
        ],
      }),
    );
    const dataRows = groups.find((entry) => entry.group === 'data')!.rows;
    expect(dataRows.map((row) => row.serviceAndConfiguration)).toEqual([
      'RDS PostgreSQL database · Database',
    ]);
  });

  it('renders a future MySQL-style resource through the generic role sizing', () => {
    const base = footprintPlan({
      manifest: manifestWith({ database: { postgres: true } }),
      awsResources: [
        {
          id: 'database',
          name: 'RDS MySQL database',
          purpose: 'Stores persistent application data',
          group: 'data',
          componentKind: 'database',
          lifecycle: 'retain',
        },
      ],
    });
    const mysql: FootprintResource = {
      id: 'database',
      category: 'database',
      provider: 'aws',
      service: 'rds-mysql',
      role: 'database',
      label: 'Database',
      quantity: 1,
      configuration: { engine: 'mysql', instanceType: 'db.t4g.small', storageGb: 50 },
      lifecycle: { persistent: true, retainOnDelete: true },
    };
    const groups = installPlanResourceGroups({
      ...base,
      footprint: { ...base.footprint!, resources: [...base.footprint!.resources, mysql] },
    });
    const dataRows = groups.find((entry) => entry.group === 'data')!.rows;
    expect(dataRows.map((row) => row.serviceAndConfiguration)).toEqual(['RDS MySQL database · Database']);
  });
});
