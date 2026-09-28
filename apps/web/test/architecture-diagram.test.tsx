import { JSDOM } from 'jsdom';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { resolveDeploymentFootprint } from '@deployz/contracts';
import type { DeploymentFootprint, DeploymentManifest, DeploymentPlan, FootprintResource } from '@deployz/contracts';

import { ArchitectureDiagram } from '../src/components/architecture-diagram';

// The plan-view architecture diagram renders one box per footprint workload —
// the web workload public, every worker internal — plus one box per managed
// resource the plan includes. Plans saved before footprints keep the single
// "Application container" box and the catalog-component fallback.

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

const WEB_ONLY = manifestWith();
const WEB_DB_CACHE = manifestWith({ database: { postgres: true }, redis: { required: true, envBindings: [] } });
const WEB_TWO_WORKERS = manifestWith({
  worker: { command: 'npm run email' },
  workers: [
    { id: 'email-worker', command: 'npm run email', source: 'Procfile' },
    { id: 'import-worker', command: 'npm run import', source: 'Procfile' },
  ],
});

function renderPlan(plan: DeploymentPlan): Document {
  return new JSDOM(renderToString(<ArchitectureDiagram plan={plan} />)).window.document;
}

function renderFootprint(manifest: DeploymentManifest): Document {
  return renderPlan({
    schemaVersion: 1,
    action: 'INSTALL',
    region: 'us-east-1',
    components: [],
    awsResources: [],
    footprint: resolveDeploymentFootprint({ manifest, region: 'us-east-1' }),
    requirementDrift: [],
  });
}

function workloadBoxes(doc: Document): string[] {
  return [...doc.querySelectorAll('[data-testid="diagram-workloads"] > div')].map(
    (box) => box.textContent ?? '',
  );
}

function resourceBoxes(doc: Document): string[] {
  return [...doc.querySelectorAll('[data-testid="diagram-resources"] > div')].map(
    (box) => box.textContent ?? '',
  );
}

describe('ArchitectureDiagram', () => {
  it('renders one public workload box for a web-only deployment', () => {
    const doc = renderFootprint(WEB_ONLY);
    expect(workloadBoxes(doc)).toEqual(['Web applicationPublic']);
    expect(doc.body.textContent).not.toContain('Internal');
    expect(resourceBoxes(doc)).toEqual(['Storage', 'Secrets', 'Monitoring']);
  });

  it('renders the database and cache boxes only when the footprint includes them', () => {
    const doc = renderFootprint(WEB_DB_CACHE);
    expect(resourceBoxes(doc)).toEqual(['Database', 'Cache', 'Storage', 'Secrets', 'Monitoring']);
  });

  it('renders one internal box per worker, and no public-ingress affordance for them', () => {
    const doc = renderFootprint(WEB_TWO_WORKERS);
    expect(workloadBoxes(doc)).toEqual([
      'Web applicationPublic',
      'Worker email-workerInternal',
      'Worker import-workerInternal',
    ]);
    const text = doc.body.textContent ?? '';
    expect(text).not.toMatch(/https?:\/\//);
    expect(doc.querySelectorAll('[data-testid="diagram-workloads"] .border-primary')).toHaveLength(1);
  });

  it('renders the full web + worker + database + cache combination', () => {
    const full = manifestWith({
      database: { postgres: true },
      redis: { required: true, envBindings: [] },
      worker: { command: 'npm run worker' },
    });
    const doc = renderFootprint(full);
    expect(workloadBoxes(doc)).toEqual(['Web applicationPublic', 'Background workerInternal']);
    expect(resourceBoxes(doc)).toEqual(['Database', 'Cache', 'Storage', 'Secrets', 'Monitoring']);
  });

  it('renders a future MySQL-style resource through the generic footprint path', () => {
    const base = resolveDeploymentFootprint({ manifest: WEB_ONLY, region: 'us-east-1' });
    const mysql: FootprintResource = {
      id: 'database',
      category: 'database',
      provider: 'aws',
      service: 'rds-mysql',
      role: 'database',
      label: 'Database',
      quantity: 1,
      configuration: { engine: 'mysql' },
      lifecycle: { persistent: true, retainOnDelete: true },
    };
    const doc = renderPlan({
      schemaVersion: 1,
      action: 'INSTALL',
      region: 'us-east-1',
      components: [],
      awsResources: [],
      footprint: { ...base, resources: [...base.resources, mysql] },
      requirementDrift: [],
    });
    // The box renders wherever the footprint lists the resource — appended
    // last here, first for a manifest that requires the database.
    expect(resourceBoxes(doc)).toEqual(['Storage', 'Database', 'Secrets', 'Monitoring']);
  });

  it('keeps the single application box and catalog fallback for plans saved before footprints', () => {
    const doc = renderPlan({
      schemaVersion: 1,
      action: 'INSTALL',
      region: 'us-east-1',
      components: [
        { kind: 'database', name: 'Database', action: 'CREATE', lifecycle: 'retain' },
      ],
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
      footprint: null,
      requirementDrift: [],
    });
    expect(workloadBoxes(doc)).toEqual(['Application container']);
    expect(doc.body.textContent).not.toContain('Public');
    expect(doc.body.textContent).not.toContain('Internal');
    expect(resourceBoxes(doc)).toEqual(['Database', 'Secrets', 'Monitoring']);
  });
});
