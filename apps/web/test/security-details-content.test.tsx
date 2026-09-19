import { JSDOM } from 'jsdom';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { DeploymentPlan } from '@deployz/contracts';

import { SecurityDetailsContent } from '../src/components/security-details-content';
import { OWNERSHIP_NOTE } from '../src/lib/security-details';

// The Security Details page body is plan-driven: the "Exact AWS resources
// created" list and the architecture diagram render the deployment's saved
// DeploymentPlan, and a null plan shows honest unavailable states instead of
// a static catalogue. The component uses next/link, so it is rendered with
// react-dom/server and parsed with jsdom (the repo's pattern for that).

const BACK_HREF = '/install/11111111-1111-1111-1111-111111111111';

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

/** Mirrors buildInstallPlan output: catalog components and AWS resources,
 * filtered by the same profile the manifest would derive. */
function installPlan({ postgres, redis }: { postgres: boolean; redis: boolean }): DeploymentPlan {
  const components: DeploymentPlan['components'] = [
    { kind: 'application', name: 'Application', action: 'CREATE', lifecycle: 'delete' },
    { kind: 'endpoint', name: 'Secure endpoint', action: 'CREATE', lifecycle: 'delete' },
  ];
  if (postgres) {
    components.push({ kind: 'database', name: 'Database', action: 'CREATE', lifecycle: 'retain' });
  }
  components.push({ kind: 'storage', name: 'Storage', action: 'CREATE', lifecycle: 'retain' });
  if (redis) {
    components.push({ kind: 'cache', name: 'Cache', action: 'CREATE', lifecycle: 'delete' });
  }

  const awsResources: DeploymentPlan['awsResources'] = [
    awsResource({
      id: 'vpc',
      name: 'Private network (VPC)',
      purpose: 'Isolates the application from other resources in your account',
      componentKind: 'network',
    }),
    awsResource(),
    awsResource({
      id: 'load_balancer',
      name: 'Application Load Balancer',
      purpose: 'Receives web traffic and sends it to the application',
      componentKind: 'endpoint',
    }),
  ];
  if (postgres) {
    awsResources.push(
      awsResource({
        id: 'database',
        name: 'RDS PostgreSQL database',
        purpose: 'Stores persistent application data',
        group: 'data',
        componentKind: 'database',
        lifecycle: 'retain',
      }),
    );
  }
  if (redis) {
    awsResources.push(
      awsResource({
        id: 'cache',
        name: 'ElastiCache Valkey cache',
        purpose: 'Speeds up application requests',
        group: 'data',
        componentKind: 'cache',
      }),
    );
  }
  awsResources.push(
    awsResource({
      id: 'storage_bucket',
      name: 'S3 bucket',
      purpose: 'Stores uploaded files',
      group: 'data',
      componentKind: 'storage',
      lifecycle: 'retain',
    }),
    awsResource({
      id: 'log_group',
      name: 'CloudWatch log group',
      purpose: 'Collects application logs',
      group: 'security_operations',
      componentKind: 'monitoring',
    }),
  );

  return {
    schemaVersion: 1,
    action: 'INSTALL',
    region: 'us-east-1',
    components,
    awsResources,
    requirementDrift: [],
  };
}

function renderContent(plan: DeploymentPlan | null): Document {
  const html = renderToString(<SecurityDetailsContent plan={plan} backHref={BACK_HREF} />);
  return new JSDOM(html).window.document;
}

/** The text of the two plan-driven sections — the resource list and the
 * architecture diagram. Everything else (trust story, deletion copy) mentions
 * "database" and "cache" unconditionally, so absence is only meaningful
 * here. */
function planDrivenSectionText(doc: Document): string[] {
  return ['resources-created', 'architecture'].map(
    (id) => doc.querySelector(`[aria-labelledby="${id}"]`)?.textContent ?? '',
  );
}

describe('SecurityDetailsContent', () => {
  it('shows no database or cache in the list or diagram for a stateless plan', () => {
    const doc = renderContent(installPlan({ postgres: false, redis: false }));
    for (const text of planDrivenSectionText(doc)) {
      expect(text).not.toMatch(/database/i);
      expect(text).not.toContain('PostgreSQL');
      expect(text).not.toContain('RDS');
      expect(text).not.toMatch(/cache/i);
      expect(text).not.toContain('Valkey');
      expect(text).not.toContain('ElastiCache');
    }
  });

  it('shows the database row and box, and no cache anywhere, for a PostgreSQL-only plan', () => {
    const doc = renderContent(installPlan({ postgres: true, redis: false }));
    const [resources, architecture] = planDrivenSectionText(doc);
    expect(resources).toContain('RDS PostgreSQL database');
    expect(resources).toContain('Stores persistent application data');
    expect(architecture).toContain('Database');
    for (const text of planDrivenSectionText(doc)) {
      expect(text).not.toMatch(/cache/i);
      expect(text).not.toContain('Valkey');
      expect(text).not.toContain('ElastiCache');
    }
  });

  it('shows the cache row and box, and no database anywhere, for a Redis-only plan', () => {
    const doc = renderContent(installPlan({ postgres: false, redis: true }));
    const [resources, architecture] = planDrivenSectionText(doc);
    expect(resources).toContain('ElastiCache Valkey cache');
    expect(resources).toContain('Speeds up application requests');
    expect(architecture).toContain('Cache');
    for (const text of planDrivenSectionText(doc)) {
      expect(text).not.toMatch(/database/i);
      expect(text).not.toContain('PostgreSQL');
      expect(text).not.toContain('RDS');
    }
  });

  it('shows both the database and the cache for a PostgreSQL + Redis plan', () => {
    const doc = renderContent(installPlan({ postgres: true, redis: true }));
    const [resources, architecture] = planDrivenSectionText(doc);
    expect(resources).toContain('RDS PostgreSQL database');
    expect(resources).toContain('ElastiCache Valkey cache');
    expect(architecture).toContain('Database');
    expect(architecture).toContain('Cache');
  });

  it('renders storage from the plan row, not the outdated conditional wording', () => {
    const doc = renderContent(installPlan({ postgres: false, redis: false }));
    const [resources, architecture] = planDrivenSectionText(doc);
    expect(resources).toContain('S3 bucket');
    expect(resources).toContain('Stores uploaded files');
    expect(architecture).toContain('Storage');
    expect(doc.body.textContent).not.toContain('when the application requires file storage');
  });

  it('renders the group headings from the shared resource groups', () => {
    const doc = renderContent(installPlan({ postgres: true, redis: true }));
    const [resources] = planDrivenSectionText(doc);
    expect(resources).toContain('Compute & Networking');
    expect(resources).toContain('Data');
    expect(resources).toContain('Security & Operations');
  });

  it('keeps the plan-driven resource names collapsed inside a details element', () => {
    const doc = renderContent(installPlan({ postgres: false, redis: false }));
    const section = doc.querySelector('[aria-labelledby="resources-created"]')!;
    // The catalog names (VPC, ECS, IAM) only appear inside a collapsed
    // disclosure, so they stay out of the visible top-level text.
    const details = section.querySelector('details')!;
    expect(details.hasAttribute('open')).toBe(false);
    expect(details.textContent).toContain('ECS Fargate service');
    expect(details.textContent).toContain('The Deployz relay (a small scheduled job)');
    // The section heading and the plain-English lead-in stay visible outside.
    const heading = section.querySelector('h2')!;
    expect(heading.textContent).toBe('Exact AWS resources created');
    expect(heading.closest('details')).toBeNull();
    const leadIn = [...section.children].find(
      (child) => child.tagName === 'P' && child.textContent?.includes('provisioned in your account'),
    )!;
    expect(leadIn.closest('details')).toBeNull();
  });

  it('shows honest unavailable states and no resources or diagram when the plan is null', () => {
    const doc = renderContent(null);
    expect(
      [...doc.querySelectorAll('h3')].filter(
        (heading) => heading.textContent === 'Infrastructure details are unavailable',
      ),
    ).toHaveLength(2);
    for (const text of planDrivenSectionText(doc)) {
      expect(text).toContain('Infrastructure details are unavailable');
      expect(text).toContain('could not be read');
      expect(text).not.toContain('ECS');
      expect(text).not.toContain('Load Balancer');
      expect(text).not.toContain('S3 bucket');
      expect(text).not.toContain('Your AWS account');
    }
    // The rest of the page still renders.
    const body = doc.body.textContent ?? '';
    expect(body).toContain('What the relay can do');
    expect(body).toContain('How to revoke Deployz');
    expect(body).toContain('How deletion works');
    expect(body).toContain('Technical detail');
  });

  it('replaces the absolute tag-scope claim with the accurate read-only exception', () => {
    const doc = renderContent(installPlan({ postgres: false, redis: false }));
    const body = doc.body.textContent ?? '';
    expect(body).not.toContain('every action is limited to resources carrying your installation');
    expect(body).toContain('restricted to Deployz-managed resources');
    expect(body).toContain('read-only lookup');
    expect(body).toContain('Describe actions cannot be restricted by tag');
    expect(body).toContain('The exact permissions remain listed in the technical detail below');
  });

  it('keeps the exact IAM actions inside collapsed details sections', () => {
    const doc = renderContent(installPlan({ postgres: false, redis: false }));
    const actionCodes = [...doc.querySelectorAll('code')].filter((code) =>
      (code.textContent ?? '').startsWith('cloudformation:'),
    );
    expect(actionCodes.length).toBeGreaterThan(0);
    for (const code of actionCodes) {
      expect(code.closest('details')).not.toBeNull();
    }
  });

  it('renders the shared ownership note near the revoke steps', () => {
    const doc = renderContent(installPlan({ postgres: false, redis: false }));
    const revoke = doc.querySelector('[aria-labelledby="revoke"]');
    expect(revoke?.textContent).toContain(OWNERSHIP_NOTE);
  });

  it('links back to the given backHref', () => {
    const doc = renderContent(installPlan({ postgres: false, redis: false }));
    const back = [...doc.querySelectorAll('a')].find(
      (anchor) => anchor.textContent === 'Back to install',
    );
    expect(back?.getAttribute('href')).toBe(BACK_HREF);
  });
});
