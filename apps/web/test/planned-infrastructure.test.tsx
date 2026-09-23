import { JSDOM } from 'jsdom';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { resolveDeploymentFootprint } from '@deployz/contracts';
import type { DeploymentFootprint, DeploymentManifest, DeploymentPlan, FootprintResource, FootprintWorkload } from '@deployz/contracts';

import { footprintComponentRows } from '../src/lib/footprint';
import { PlannedInfrastructure } from '../src/components/planned-infrastructure';

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

const STANDARD_MANIFEST = manifestWith({
  database: { postgres: true },
  redis: { required: true, envBindings: [] },
});
const MINIMAL_MANIFEST = manifestWith();

function footprintFor(manifest: DeploymentManifest): DeploymentFootprint {
  return resolveDeploymentFootprint({ manifest, region: 'us-east-1' });
}

function planFor(footprint: DeploymentFootprint): DeploymentPlan {
  return {
    schemaVersion: 1,
    action: 'INSTALL',
    region: 'us-east-1',
    components: [],
    awsResources: footprint.resources.map((resource) => ({
      id: resource.id,
      name: resource.label,
      purpose: 'Supports the application',
      group: 'compute_networking',
      componentKind: 'application',
      lifecycle: resource.lifecycle.retainOnDelete ? 'retain' : 'delete',
    })),
    footprint,
    costEstimate: null,
    requirementDrift: [],
  };
}

function render(element: React.ReactElement): Document {
  return new JSDOM(renderToString(element)).window.document;
}

describe('footprintComponentRows', () => {
  it('renders the standard plan (web + database + cache + storage + endpoint + nat gateway)', () => {
    const rows = footprintComponentRows(footprintFor(STANDARD_MANIFEST));
    expect(rows.map((row) => row.id)).toEqual(['web', 'database', 'cache', 'storage', 'endpoint', 'nat-gateway']);

    const web = rows.find((row) => row.id === 'web')!;
    expect(web).toEqual({
      id: 'web',
      component: 'Web application',
      provisionedAs: 'AWS Fargate',
      configuration: '0.25 vCPU · 0.5 GB memory',
      retention: 'Removed',
    });

    const database = rows.find((row) => row.id === 'database')!;
    expect(database).toEqual({
      id: 'database',
      component: 'Database',
      provisionedAs: 'PostgreSQL 16',
      configuration: 'db.t4g.micro · 20 GB storage',
      retention: 'Retained',
    });

    const cache = rows.find((row) => row.id === 'cache')!;
    expect(cache).toEqual({
      id: 'cache',
      component: 'Cache',
      provisionedAs: 'Redis (Valkey)',
      configuration: 'cache.t4g.micro · 1 node',
      retention: 'Removed',
    });

    const storage = rows.find((row) => row.id === 'storage')!;
    expect(storage.configuration).toBeNull();
    expect(storage.retention).toBe('Retained');

    const endpoint = rows.find((row) => row.id === 'endpoint')!;
    expect(endpoint.configuration).toBeNull();
    expect(endpoint.retention).toBe('Removed');

    const natGateway = rows.find((row) => row.id === 'nat-gateway')!;
    expect(natGateway.provisionedAs).toBe('NAT gateway');
    expect(natGateway.retention).toBe('Removed');
  });

  it('shows no database or cache rows for the minimal plan (web + storage + network only)', () => {
    const rows = footprintComponentRows(footprintFor(MINIMAL_MANIFEST));
    const ids = rows.map((row) => row.id);
    expect(ids).not.toContain('database');
    expect(ids).not.toContain('cache');
    expect(ids).toEqual(['web', 'storage', 'endpoint', 'nat-gateway']);
  });

  it('renders a future MySQL database through the generic path', () => {
    const base = footprintFor(MINIMAL_MANIFEST);
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
    const footprint: DeploymentFootprint = { ...base, resources: [...base.resources, mysql] };
    const row = footprintComponentRows(footprint).find((entry) => entry.id === 'database')!;
    expect(row).toEqual({
      id: 'database',
      component: 'Database',
      provisionedAs: 'MySQL',
      configuration: 'db.t4g.small · 50 GB storage',
      retention: 'Retained',
    });
  });

  it('renders two worker workloads, one with quantity, through the generic path', () => {
    const base = footprintFor(MINIMAL_MANIFEST);
    const worker: FootprintWorkload = {
      id: 'worker',
      role: 'worker',
      label: 'Background worker',
      quantity: 1,
      compute: { provider: 'aws', service: 'ecs-fargate', cpuUnits: 256, memoryMiB: 512, sizeLabel: 'Small' },
      lifecycle: { persistent: false },
    };
    const bulkWorker: FootprintWorkload = {
      id: 'worker-bulk',
      role: 'worker',
      label: 'Bulk import worker',
      quantity: 3,
      compute: { provider: 'aws', service: 'ecs-fargate', cpuUnits: 512, memoryMiB: 1024, sizeLabel: 'Medium' },
      lifecycle: { persistent: false },
    };
    const footprint: DeploymentFootprint = { ...base, workloads: [...base.workloads, worker, bulkWorker] };
    const rows = footprintComponentRows(footprint);

    const singleWorker = rows.find((row) => row.id === 'worker')!;
    expect(singleWorker.component).toBe('Background worker');
    expect(singleWorker.configuration).toBe('0.25 vCPU · 0.5 GB memory');
    expect(singleWorker.retention).toBe('Removed');

    const bulk = rows.find((row) => row.id === 'worker-bulk')!;
    expect(bulk.component).toBe('3 × Bulk import worker');
    expect(bulk.configuration).toBe('0.5 vCPU · 1 GB memory');
    expect(bulk.retention).toBe('Removed');
  });

  it('renders an unknown future resource (a queue) through the generic path', () => {
    const base = footprintFor(MINIMAL_MANIFEST);
    const queue: FootprintResource = {
      id: 'queue',
      category: 'queue',
      provider: 'aws',
      service: 'sqs',
      role: 'queue',
      label: 'Task queue',
      quantity: 1,
      configuration: {},
      lifecycle: { persistent: false, retainOnDelete: false },
    };
    const footprint: DeploymentFootprint = { ...base, resources: [...base.resources, queue] };
    const row = footprintComponentRows(footprint).find((entry) => entry.id === 'queue')!;
    expect(row).toEqual({
      id: 'queue',
      component: 'Task queue',
      provisionedAs: 'sqs',
      configuration: null,
      retention: 'Removed',
    });
  });

  it('never produces an empty string or an em dash for any field', () => {
    const rows = [
      ...footprintComponentRows(footprintFor(STANDARD_MANIFEST)),
      ...footprintComponentRows(footprintFor(MINIMAL_MANIFEST)),
    ];
    for (const row of rows) {
      expect(row.component).not.toBe('');
      expect(row.provisionedAs).not.toBe('');
      expect(row.component).not.toContain('—');
      expect(row.provisionedAs).not.toContain('—');
      if (row.configuration !== null) {
        expect(row.configuration).not.toBe('');
        expect(row.configuration).not.toContain('—');
      }
    }
  });
});

describe('PlannedInfrastructure', () => {
  it('shows the empty state when the plan is null', () => {
    const doc = render(<PlannedInfrastructure plan={null} />);
    expect(doc.querySelector('[data-testid="planned-infrastructure-empty"]')?.textContent).toContain(
      'The plan shows here after a successful analysis.',
    );
    expect(doc.querySelector('[data-testid="planned-infrastructure-table"]')).toBeNull();
    expect(doc.body.textContent).toContain('Planned infrastructure');
  });

  it('shows the empty state when the plan has no footprint', () => {
    const plan = { ...planFor(footprintFor(MINIMAL_MANIFEST)), footprint: null };
    const doc = render(<PlannedInfrastructure plan={plan} />);
    expect(doc.querySelector('[data-testid="planned-infrastructure-empty"]')).not.toBeNull();
    expect(doc.querySelector('[data-testid="planned-infrastructure-table"]')).toBeNull();
  });

  it('renders exactly the table headers, and one row per component', () => {
    const plan = planFor(footprintFor(STANDARD_MANIFEST));
    const doc = render(<PlannedInfrastructure plan={plan} />);
    const table = doc.querySelector('[data-testid="planned-infrastructure-table"]');
    expect(table).not.toBeNull();
    const headers = [...table!.querySelectorAll('th')].map((th) => th.textContent);
    expect(headers).toEqual(['Component', 'Provisioned as', 'Configuration', 'On uninstall']);

    for (const row of footprintComponentRows(plan.footprint!)) {
      expect(doc.querySelector(`[data-testid="planned-component-${row.id}"]`)).not.toBeNull();
    }
  });

  it('renders "Kept"/"Removed" in the On uninstall column, with an explanation of what it means', () => {
    const plan = planFor(footprintFor(STANDARD_MANIFEST));
    const doc = render(<PlannedInfrastructure plan={plan} />);
    const databaseRow = doc.querySelector('[data-testid="planned-component-database"]');
    expect(databaseRow?.textContent).toContain('Kept');
    const webRow = doc.querySelector('[data-testid="planned-component-web"]');
    expect(webRow?.textContent).toContain('Removed');
    expect(doc.body.textContent).toContain('what happens to each component when a customer');
  });

  it('falls back to "Standard" for a component with no meaningful configuration', () => {
    const plan = planFor(footprintFor(STANDARD_MANIFEST));
    const doc = render(<PlannedInfrastructure plan={plan} />);
    const storageRow = doc.querySelector('[data-testid="planned-component-storage"]');
    expect(storageRow?.textContent).toContain('Standard');
  });

  it('links to the AWS resource details disclosure, collapsed by default, with the resource count', () => {
    const plan = planFor(footprintFor(STANDARD_MANIFEST));
    const doc = render(<PlannedInfrastructure plan={plan} />);
    const trigger = doc.querySelector('[data-slot="collapsible-trigger"]');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(trigger?.textContent).toContain(`AWS resource details · ${plan.awsResources.length} resources`);
  });

  it('never mentions pricing or cost', () => {
    const plan = planFor(footprintFor(STANDARD_MANIFEST));
    const doc = render(<PlannedInfrastructure plan={plan} />);
    expect(doc.body.textContent).not.toContain('$');
    expect(doc.body.textContent?.toLowerCase()).not.toContain('month');
  });
});
