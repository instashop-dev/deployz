import { describe, expect, it } from 'vitest';

import type { InfrastructureComponentStatus, InfrastructureLifecycle } from '../src/lib/deployments';
import {
  INFRASTRUCTURE_LIFECYCLE_LABEL,
  INFRASTRUCTURE_STATUS_BADGE,
  INFRASTRUCTURE_STATUS_LABEL,
  INFRASTRUCTURE_SUMMARY_STATUS_BADGE,
  INFRASTRUCTURE_SUMMARY_STATUS_LABEL,
} from '../src/lib/deployment-vocabulary';

import { infrastructureFixtures } from './fixtures/infrastructure';

// @testing-library/react is not installed in this workspace, so these tests
// cover the fixture shapes and the vocabulary maps the component uses. DOM
// rendering coverage is documented in the component's test checklist.

describe('infrastructure fixtures', () => {
  it('none snapshot has no components and no summary count', () => {
    const fixture = infrastructureFixtures.none;
    expect(fixture.snapshotState).toBe('none');
    expect(fixture.summary.componentCount).toBe(0);
    expect(fixture.components).toHaveLength(0);
  });

  it('provisioning fixture has pending and provisioning components', () => {
    const fixture = infrastructureFixtures.provisioning;
    expect(fixture.summary.status).toBe('provisioning');
    expect(fixture.components.some((c) => c.status === 'provisioning')).toBe(true);
    expect(fixture.components.some((c) => c.status === 'pending')).toBe(true);
  });

  it('healthy fixture has all ready components', () => {
    const fixture = infrastructureFixtures.healthy;
    expect(fixture.summary.status).toBe('healthy');
    expect(fixture.components.every((c) => c.status === 'ready')).toBe(true);
  });

  it('updating fixture has an updating component', () => {
    const fixture = infrastructureFixtures.updating;
    expect(fixture.summary.status).toBe('updating');
    expect(fixture.components.some((c) => c.status === 'updating')).toBe(true);
  });

  it('failure fixture has a failed component with a status reason', () => {
    const fixture = infrastructureFixtures.failure;
    expect(fixture.summary.status).toBe('failed');
    const failed = fixture.components.find((c) => c.status === 'failed');
    expect(failed).toBeDefined();
    expect(failed!.resources.some((r) => r.statusReason !== null)).toBe(true);
  });

  it('deleting fixture marks delete lifecycle components as deleting and retain as retained', () => {
    const fixture = infrastructureFixtures.deleting;
    expect(fixture.summary.status).toBe('deleting');
    expect(fixture.components.find((c) => c.lifecycle === 'delete')?.status).toBe('deleting');
    expect(
      fixture.components
        .filter((c) => c.lifecycle === 'retain' || c.lifecycle === 'snapshot')
        .every((c) => c.status === 'retained'),
    ).toBe(true);
  });

  it('retained fixture has retained components and a stale snapshot', () => {
    const fixture = infrastructureFixtures.retained;
    expect(fixture.snapshotState).toBe('stale');
    expect(fixture.summary.status).toBe('retained');
    expect(fixture.components.every((c) => c.status === 'retained')).toBe(true);
  });

  it('disconnected fixture carries a warning and unknown component statuses', () => {
    const fixture = infrastructureFixtures.disconnected;
    expect(fixture.connectionState).toBe('disconnected');
    expect(fixture.disconnectWarning).not.toBeNull();
    expect(fixture.components.every((c) => c.status === 'unknown')).toBe(true);
  });

  it('withCache fixture includes a cache component', () => {
    expect(infrastructureFixtures.withCache.components.some((c) => c.kind === 'cache')).toBe(true);
  });

  it('withoutCache fixture does not include a cache component', () => {
    expect(
      infrastructureFixtures.withoutCache.components.some((c) => c.kind === 'cache'),
    ).toBe(false);
  });
});

describe('infrastructure status vocabulary', () => {
  it('ready and retained are positive', () => {
    expect(INFRASTRUCTURE_STATUS_BADGE.ready).toBe('default');
    expect(INFRASTRUCTURE_STATUS_BADGE.retained).toBe('default');
  });

  it('provisioning and updating are info/outline', () => {
    expect(INFRASTRUCTURE_STATUS_BADGE.provisioning).toBe('outline');
    expect(INFRASTRUCTURE_STATUS_BADGE.updating).toBe('outline');
  });

  it('deleting is warn/outline', () => {
    expect(INFRASTRUCTURE_STATUS_BADGE.deleting).toBe('outline');
  });

  it('failed is destructive', () => {
    expect(INFRASTRUCTURE_STATUS_BADGE.failed).toBe('destructive');
  });

  it('pending, removed, and unknown are muted', () => {
    expect(INFRASTRUCTURE_STATUS_BADGE.pending).toBe('secondary');
    expect(INFRASTRUCTURE_STATUS_BADGE.removed).toBe('secondary');
    expect(INFRASTRUCTURE_STATUS_BADGE.unknown).toBe('secondary');
  });

  it('every component status has a label', () => {
    const statuses: InfrastructureComponentStatus[] = [
      'pending',
      'provisioning',
      'ready',
      'updating',
      'deleting',
      'failed',
      'retained',
      'removed',
      'unknown',
    ];
    for (const status of statuses) {
      expect(INFRASTRUCTURE_STATUS_LABEL[status]).toBeDefined();
      expect(INFRASTRUCTURE_STATUS_BADGE[status]).toBeDefined();
    }
  });
});

describe('infrastructure summary status vocabulary', () => {
  it('healthy is positive and failed is destructive', () => {
    expect(INFRASTRUCTURE_SUMMARY_STATUS_BADGE.healthy).toBe('default');
    expect(INFRASTRUCTURE_SUMMARY_STATUS_BADGE.failed).toBe('destructive');
  });

  it('retained and unknown are muted', () => {
    expect(INFRASTRUCTURE_SUMMARY_STATUS_BADGE.retained).toBe('secondary');
    expect(INFRASTRUCTURE_SUMMARY_STATUS_BADGE.unknown).toBe('secondary');
  });

  it('every summary status has a label', () => {
    const statuses = [
      'healthy',
      'provisioning',
      'updating',
      'degraded',
      'failed',
      'deleting',
      'retained',
      'unknown',
    ] as const;
    for (const status of statuses) {
      expect(INFRASTRUCTURE_SUMMARY_STATUS_LABEL[status]).toBeDefined();
      expect(INFRASTRUCTURE_SUMMARY_STATUS_BADGE[status]).toBeDefined();
    }
  });
});

describe('infrastructure lifecycle copy', () => {
  it('contains the expected copy for each lifecycle', () => {
    const lifecycleLabels: Record<InfrastructureLifecycle, string> = {
      retain:
        'Retained when deployment is removed. AWS charges may continue until this resource is deleted.',
      delete: 'Removed automatically when the deployment is deleted.',
      snapshot: 'A snapshot is kept when the deployment is deleted.',
      conditional: 'Retention depends on the deployment\'s configuration.',
    };
    for (const [lifecycle, expected] of Object.entries(lifecycleLabels) as [
      InfrastructureLifecycle,
      string,
    ][]) {
      expect(INFRASTRUCTURE_LIFECYCLE_LABEL[lifecycle]).toBe(expected);
    }
  });
});
