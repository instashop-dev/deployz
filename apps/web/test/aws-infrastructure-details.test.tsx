// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import type { DeploymentPlan } from '@deployz/contracts';

import { AwsInfrastructureDetails } from '../src/components/aws-infrastructure-details';

function resource(
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

function plan(overrides: Partial<DeploymentPlan> = {}): DeploymentPlan {
  return {
    schemaVersion: 1,
    action: 'INSTALL',
    region: 'us-east-1',
    components: [],
    awsResources: [
      resource({ id: 'vpc', name: 'Private network (VPC)', group: 'compute_networking' }),
      resource({
        id: 'database',
        name: 'RDS PostgreSQL database',
        purpose: 'Stores persistent application data',
        group: 'data',
        componentKind: 'database',
        lifecycle: 'retain',
      }),
      resource({
        id: 'cache',
        name: 'ElastiCache Valkey cache',
        purpose: 'Speeds up application requests',
        group: 'data',
        componentKind: 'cache',
      }),
      resource({
        id: 'log_group',
        name: 'CloudWatch log group',
        purpose: 'Collects application logs',
        group: 'security_operations',
        componentKind: 'monitoring',
      }),
    ],
    requirementDrift: [],
    ...overrides,
  };
}

const STATELESS_PLAN: DeploymentPlan = plan({
  awsResources: [resource({ id: 'ecs_service', group: 'compute_networking' })],
});

const cleanups: Array<() => void> = [];

function render(element: React.ReactElement): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(element);
  });
  cleanups.push(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });
  return container;
}

afterEach(() => {
  while (cleanups.length) {
    cleanups.pop()?.();
  }
  document.body.innerHTML = '';
});

describe('AwsInfrastructureDetails', () => {
  it('renders nothing when the plan is null', () => {
    const container = render(<AwsInfrastructureDetails plan={null} />);
    expect(container.querySelector('[data-testid="aws-infrastructure-details"]')).toBeNull();
  });

  it('renders nothing when the plan has no AWS resources', () => {
    const container = render(<AwsInfrastructureDetails plan={plan({ awsResources: [] })} />);
    expect(container.querySelector('[data-testid="aws-infrastructure-details"]')).toBeNull();
  });

  it('is collapsed by default, showing the region and resource count in the trigger', () => {
    const container = render(<AwsInfrastructureDetails plan={plan()} region="us-east-1" />);
    const trigger = container.querySelector('[data-slot="collapsible-trigger"]') as HTMLElement;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).toContain('AWS infrastructure details');
    expect(container.textContent).toContain('US East (N. Virginia)');
    expect(container.textContent).toContain('4 AWS resources');
    expect(container.querySelector('table')).toBeNull();
  });

  it('omits the region from the trigger summary when no region is given', () => {
    const container = render(<AwsInfrastructureDetails plan={plan()} />);
    expect(container.textContent).not.toContain('US East');
    expect(container.textContent).toContain('4 AWS resources');
  });

  it('expands to show the table on click', () => {
    const container = render(<AwsInfrastructureDetails plan={plan()} region="us-east-1" />);
    const trigger = container.querySelector('[data-slot="collapsible-trigger"]') as HTMLElement;
    act(() => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.textContent).toContain('AWS resource');
    expect(container.textContent).toContain('Purpose');
    expect(container.textContent).toContain('When removed');
  });

  it('shows all three group headings for a postgres+redis plan', () => {
    const container = render(<AwsInfrastructureDetails plan={plan()} />);
    const trigger = container.querySelector('[data-slot="collapsible-trigger"]') as HTMLElement;
    act(() => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(container.textContent).toContain('Compute & Networking');
    expect(container.textContent).toContain('Data');
    expect(container.textContent).toContain('Security & Operations');
  });

  it('shows only the groups present for a stateless plan', () => {
    const container = render(<AwsInfrastructureDetails plan={STATELESS_PLAN} />);
    const trigger = container.querySelector('[data-slot="collapsible-trigger"]') as HTMLElement;
    act(() => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(container.textContent).toContain('Compute & Networking');
    expect(container.textContent).not.toContain('Data');
    expect(container.textContent).not.toContain('Security & Operations');
  });

  it('maps lifecycle to the two exact removal labels', () => {
    const container = render(<AwsInfrastructureDetails plan={plan()} />);
    const trigger = container.querySelector('[data-slot="collapsible-trigger"]') as HTMLElement;
    act(() => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    const deleted = container.querySelector('[data-testid="aws-resource-vpc"]');
    const retained = container.querySelector('[data-testid="aws-resource-database"]');
    expect(deleted?.textContent).toContain('Deleted');
    expect(retained?.textContent).toContain('Kept in your AWS account');
  });

  it('never renders the words Lifecycle, DELETE or RETAIN', () => {
    const container = render(<AwsInfrastructureDetails plan={plan()} region="us-east-1" />);
    const trigger = container.querySelector('[data-slot="collapsible-trigger"]') as HTMLElement;
    act(() => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(container.textContent).not.toContain('Lifecycle');
    expect(container.textContent).not.toContain('DELETE');
    expect(container.textContent).not.toContain('RETAIN');
  });
});
