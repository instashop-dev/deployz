import { JARGON_PATTERN } from '@deployz/copy-map';
import { describe, expect, it } from 'vitest';

import { DEPLOYMENT_STATES } from '../src/lib/deployment-vocabulary';
import {
  CUSTOMER_BUCKETS,
  CUSTOMER_BUCKET_BADGE,
  STATUS_FILTER_GROUPS,
  STATUS_GROUPS,
  STATUS_GROUP_LABELS,
  customerBucket,
  deploymentDisplayStatus,
  isStatusGroup,
  statusGroupRank,
} from '../src/lib/deployment-status-groups';
import type { FleetDeployment } from '../src/lib/deployments';
import { summarise } from '../src/lib/home-state';
import { fleetDeployment } from './fixtures/fleet-deployment';

function withState(state: string, overrides: Parameters<typeof fleetDeployment>[0] = {}) {
  return fleetDeployment({ state: state as FleetDeployment['state'], ...overrides });
}

describe('deploymentDisplayStatus — precise labels', () => {
  it.each([
    ['NOT_INSTALLED', 'Waiting for customer', 'waiting'],
    ['WAITING_FOR_RELAY', 'Waiting for AWS', 'waiting'],
    ['UPDATING', 'Updating', 'in-progress'],
    ['UPDATE_AVAILABLE', 'Update available', 'update-available'],
    ['HEALTHY', 'Healthy', 'healthy'],
    ['FAILED', 'Failed', 'attention'],
    ['DISCONNECTED', 'Disconnected', 'attention'],
    ['DELETING', 'Removing', 'in-progress'],
    ['DELETED', 'Removed', 'removed'],
  ] as const)('%s reads "%s" under %s', (state, label, group) => {
    expect(deploymentDisplayStatus(withState(state))).toMatchObject({ label, group });
  });

  it.each([
    ['RELAY_CONNECT', 'Connecting'],
    ['PREPARING', 'Provisioning'],
    ['NETWORK', 'Provisioning'],
    ['DATABASE_STORAGE', 'Provisioning'],
    ['REDIS', 'Provisioning'],
    ['MIGRATION', 'Running migrations'],
    ['APPLICATION', 'Starting application'],
    ['HEALTH_CHECK', 'Checking health'],
    ['TLS', 'Setting up HTTPS'],
  ])('an install on step %s reads "%s" and stays in progress', (step, label) => {
    const status = deploymentDisplayStatus(
      withState('INSTALLING', { deploymentStatus: { stage: 'PROVISIONING', step } as never }),
    );
    expect(status).toMatchObject({ label, group: 'in-progress', badge: 'info' });
  });

  it('falls back to "Installing" when the API sent no step or an unmapped one', () => {
    const noStep = withState('INSTALLING', { deploymentStatus: { step: undefined } });
    const unmapped = withState('INSTALLING', { deploymentStatus: { step: 'READY' } });
    expect(deploymentDisplayStatus(noStep).label).toBe('Installing');
    expect(deploymentDisplayStatus(unmapped).label).toBe('Installing');
  });

  it('keeps a HEALTHY deployment healthy while its stage is still finishing HTTPS', () => {
    const status = deploymentDisplayStatus(
      withState('HEALTHY', { deploymentStatus: { stage: 'VERIFYING', step: 'TLS' } }),
    );
    expect(status).toMatchObject({ label: 'Healthy', group: 'healthy' });
  });
});

describe('deploymentDisplayStatus — attention overlays', () => {
  it('names the cause behind a running deployment that needs the vendor', () => {
    expect(deploymentDisplayStatus(withState('HEALTHY', { relayStatus: 'DISCONNECTED' }))).toMatchObject({
      label: 'Lost contact',
      group: 'attention',
    });
    expect(deploymentDisplayStatus(withState('HEALTHY', { healthStatus: 'UNHEALTHY' }))).toMatchObject({
      label: 'Unhealthy',
      badge: 'destructive',
    });
    expect(deploymentDisplayStatus(withState('UPDATE_AVAILABLE', { healthStatus: 'DEGRADED' }))).toMatchObject({
      label: 'Degraded',
      badge: 'warning',
    });
  });

  it('never flags a deployment that is waiting or on its way out', () => {
    for (const state of ['NOT_INSTALLED', 'WAITING_FOR_RELAY', 'DELETING', 'DELETED']) {
      const status = deploymentDisplayStatus(
        withState(state, { relayStatus: 'DISCONNECTED', healthStatus: 'UNHEALTHY' }),
      );
      expect(status.group, state).not.toBe('attention');
    }
  });

  it('surfaces a status this build does not know as attention, without leaking the raw value', () => {
    const status = deploymentDisplayStatus(withState('PAUSED_BY_FUTURE_FEATURE'));
    expect(status).toEqual({ group: 'attention', label: 'Unknown status', badge: 'warning' });
  });
});

describe('vocabulary guardrails', () => {
  it('has a label, a rank and a filter slot for every group', () => {
    for (const group of STATUS_GROUPS) {
      expect(STATUS_GROUP_LABELS[group]).toBeTruthy();
      expect(STATUS_FILTER_GROUPS).toContain(group);
      expect(statusGroupRank(group)).toBe(STATUS_GROUPS.indexOf(group));
    }
    expect(new Set(STATUS_FILTER_GROUPS).size).toBe(STATUS_GROUPS.length);
  });

  it('ranks attention first and removed last', () => {
    expect(STATUS_GROUPS[0]).toBe('attention');
    expect(STATUS_GROUPS.at(-1)).toBe('removed');
    expect(isStatusGroup('attention')).toBe(true);
    expect(isStatusGroup('DELETED')).toBe(false);
  });

  it('never shows raw enums or AWS jargon in any label the list can render', () => {
    const labels = [
      ...Object.values(STATUS_GROUP_LABELS),
      ...DEPLOYMENT_STATES.flatMap((state) => [
        deploymentDisplayStatus(withState(state)).label,
        deploymentDisplayStatus(withState(state, { relayStatus: 'DISCONNECTED' })).label,
      ]),
    ];
    for (const label of labels) {
      expect(label, label).not.toMatch(JARGON_PATTERN);
      expect(label, label).not.toMatch(/_/);
    }
  });
});

describe('customerBucket', () => {
  it.each([
    ['HEALTHY', 'active'],
    ['UPDATE_AVAILABLE', 'active'],
    ['UPDATING', 'active'],
    ['FAILED', 'attention'],
    ['DISCONNECTED', 'attention'],
    ['NOT_INSTALLED', 'pending'],
    ['WAITING_FOR_RELAY', 'pending'],
    ['INSTALLING', 'pending'],
    ['DELETING', 'removing'],
    ['DELETED', 'removed'],
    ['SOMETHING_NEW', 'attention'],
  ])('%s counts as %s', (state, bucket) => {
    expect(customerBucket(withState(state))).toBe(bucket);
  });

  it('counts a running deployment that lost contact as attention, like the list does', () => {
    expect(customerBucket(withState('HEALTHY', { relayStatus: 'DISCONNECTED' }))).toBe('attention');
  });

  it('has a badge for every bucket', () => {
    for (const bucket of CUSTOMER_BUCKETS) expect(CUSTOMER_BUCKET_BADGE[bucket]).toBeDefined();
  });
});

// The homepage counts the fleet with its own classification. This pins the two
// together: the group a deployment sits in on the list is the tile it is
// counted in on Home, for every state and every attention overlay.
describe('agreement with the homepage fleet summary', () => {
  const cases: FleetDeployment[] = [
    ...DEPLOYMENT_STATES.filter((state) => state !== 'DELETED' && state !== 'DELETING').map((state) =>
      withState(state),
    ),
    withState('HEALTHY', { relayStatus: 'DISCONNECTED' }),
    withState('UPDATE_AVAILABLE', { healthStatus: 'DEGRADED' }),
    withState('INSTALLING', { healthStatus: 'UNHEALTHY' }),
  ];

  it.each(cases.map((d) => [`${d.state}/${d.relayStatus}/${d.healthStatus}`, d] as const))(
    '%s lands in the same bucket',
    (_name, d) => {
      const summary = summarise([d]);
      const tile =
        summary.attention > 0
          ? 'attention'
          : summary.deploying > 0
            ? 'in-progress'
            : summary.waiting > 0
              ? 'waiting'
              : summary.updates > 0
                ? 'update-available'
                : 'healthy';
      expect(deploymentDisplayStatus(d).group).toBe(tile);
    },
  );
});
