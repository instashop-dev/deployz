import { describe, expect, it } from 'vitest';

import {
  CUSTOMER_STATE_FILTERS,
  CUSTOMER_STATE_FILTER_LABELS,
  DEFAULT_CUSTOMER_SORT,
  customerDeployment,
  customerListRow,
  customerSummary,
  filterCustomerRows,
  hasActiveCustomerFilters,
  matchesCustomerState,
  parseCustomerQuery,
  sortCustomerRows,
  type Customer,
  type CustomerListQuery,
  type CustomerListRow,
} from '../src/lib/customers';
import type { FleetDeployment } from '../src/lib/deployments';
import { fleetDeployment } from './fixtures/fleet-deployment';

function customer(id: string, overrides: Partial<Customer> = {}): Customer {
  return {
    id,
    organizationId: 'org-1',
    name: `Customer ${id}`,
    email: `${id}@example.com`,
    company: null,
    externalReference: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

let counter = 0;
function dep(state: string, overrides: Parameters<typeof fleetDeployment>[0] = {}): FleetDeployment {
  counter += 1;
  return fleetDeployment({ id: `dep-${counter}`, state: state as FleetDeployment['state'], ...overrides });
}

const summaryText = (...states: string[]) => customerSummary(states.map((state) => dep(state))).text;

describe('customerSummary — one line per customer, counted from their deployments', () => {
  it('counts active deployments', () => {
    expect(summaryText('HEALTHY', 'HEALTHY')).toBe('2 active');
    expect(summaryText('HEALTHY', 'UPDATE_AVAILABLE', 'UPDATING')).toBe('3 active');
  });

  it('reads a mixed customer as active and needing attention', () => {
    expect(summaryText('HEALTHY', 'FAILED')).toBe('1 active · 1 needs attention');
    expect(summaryText('FAILED')).toBe('1 needs attention');
  });

  it('says "Setup pending" for one unfinished setup, and counts several', () => {
    expect(summaryText('NOT_INSTALLED')).toBe('Setup pending');
    expect(summaryText('INSTALLING')).toBe('Setup pending');
    expect(summaryText('WAITING_FOR_RELAY', 'NOT_INSTALLED')).toBe('2 setup pending');
    expect(summaryText('HEALTHY', 'NOT_INSTALLED')).toBe('1 active · 1 setup pending');
  });

  it('says so when there is nothing, and when everything was removed', () => {
    expect(summaryText()).toBe('No deployments');
    expect(summaryText('DELETED')).toBe('Removed');
    expect(summaryText('DELETED', 'DELETED')).toBe('Removed');
    expect(summaryText('DELETING')).toBe('1 removing');
  });

  it('lets removed deployments fall silent while anything else is going on', () => {
    expect(summaryText('HEALTHY', 'DELETED')).toBe('1 active');
  });

  it('treats a running deployment that lost contact as needing attention, not active', () => {
    const summary = customerSummary([dep('HEALTHY', { relayStatus: 'DISCONNECTED' })]);
    expect(summary.text).toBe('1 needs attention');
    expect(summary.counts.active).toBe(0);
  });

  it('surfaces an unknown future status as needing attention', () => {
    expect(summaryText('SOMETHING_NEW')).toBe('1 needs attention');
  });

  it('exposes the parts in order, each tied to a bucket', () => {
    expect(customerSummary([dep('FAILED'), dep('HEALTHY')]).parts).toEqual([
      { bucket: 'active', text: '1 active' },
      { bucket: 'attention', text: '1 needs attention' },
    ]);
  });
});

describe('matchesCustomerState — the state filter', () => {
  const summaries = {
    active: customerSummary([dep('HEALTHY')]),
    attention: customerSummary([dep('FAILED')]),
    mixed: customerSummary([dep('HEALTHY'), dep('FAILED')]),
    pending: customerSummary([dep('NOT_INSTALLED')]),
    none: customerSummary([]),
    removed: customerSummary([dep('DELETED')]),
    removing: customerSummary([dep('DELETING')]),
  };
  const matching = (filter: (typeof CUSTOMER_STATE_FILTERS)[number]) =>
    Object.entries(summaries)
      .filter(([, summary]) => matchesCustomerState(summary, filter))
      .map(([name]) => name);

  it('Active: any active deployment', () => {
    expect(matching('active')).toEqual(['active', 'mixed']);
  });

  it('Needs attention: any deployment that needs it', () => {
    expect(matching('attention')).toEqual(['attention', 'mixed']);
  });

  it('Setup pending: any unfinished setup', () => {
    expect(matching('pending')).toEqual(['pending']);
  });

  it('No active deployments: nothing running or being set up, including all-removed', () => {
    expect(matching('none')).toEqual(['none', 'removed', 'removing']);
  });

  it('Removed: has deployments, all of them gone or going', () => {
    expect(matching('removed')).toEqual(['removed', 'removing']);
  });

  it('labels every filter option', () => {
    for (const filter of CUSTOMER_STATE_FILTERS) expect(CUSTOMER_STATE_FILTER_LABELS[filter]).toBeTruthy();
  });
});

describe('customerListRow', () => {
  it('lists each application once, most recently active first', () => {
    const row = customerListRow(customer('c1'), [
      dep('HEALTHY', { applicationName: 'Docs', deploymentStatus: { updatedAt: '2026-09-01T00:00:00Z' } }),
      dep('HEALTHY', { applicationName: 'Sheets', deploymentStatus: { updatedAt: '2026-09-03T00:00:00Z' } }),
      dep('HEALTHY', { applicationName: 'Docs', deploymentStatus: { updatedAt: '2026-09-02T00:00:00Z' } }),
    ]);
    expect(row.applications).toEqual(['Sheets', 'Docs']);
  });

  it('names live applications, and falls back to removed ones when nothing is live', () => {
    const mixed = customerListRow(customer('c1'), [
      dep('HEALTHY', { applicationName: 'Docs' }),
      dep('DELETED', { applicationName: 'Old' }),
    ]);
    expect(mixed.applications).toEqual(['Docs']);
    const gone = customerListRow(customer('c2'), [dep('DELETED', { applicationName: 'Old' })]);
    expect(gone.applications).toEqual(['Old']);
    expect(customerListRow(customer('c3'), []).applications).toEqual([]);
  });

  it('takes last activity from the newest deployment, else the day the customer was created', () => {
    const active = customerListRow(customer('c1'), [
      dep('HEALTHY', { deploymentStatus: { updatedAt: '2026-09-09T00:00:00Z' } }),
    ]);
    expect(active.lastActivityAt).toBe('2026-09-09T00:00:00Z');
    expect(customerListRow(customer('c2', { createdAt: '2026-07-07T00:00:00Z' }), []).lastActivityAt).toBe(
      '2026-07-07T00:00:00Z',
    );
  });

  it('falls back to the row time when a deployment has no usable status time', () => {
    const row = customerListRow(customer('c1'), [
      dep('HEALTHY', { updatedAt: '2026-06-06T00:00:00Z', deploymentStatus: { updatedAt: 'nope' } }),
    ]);
    expect(row.lastActivityAt).toBe('2026-06-06T00:00:00Z');
  });

  it('keeps one customer with several deployments on one row', () => {
    const row = customerListRow(customer('c1'), [dep('HEALTHY'), dep('FAILED'), dep('NOT_INSTALLED')]);
    expect(row.summary.text).toBe('1 active · 1 needs attention · 1 setup pending');
    expect(row.rollup.deployments).toHaveLength(3);
  });
});

describe('customer rollup agrees with the list summary', () => {
  it('reads a live app being updated as Live, not Installing', () => {
    expect(customerDeployment([dep('UPDATING')]).status).toBe('LIVE');
  });

  it('reads an unknown status as needing attention', () => {
    expect(customerDeployment([dep('SOMETHING_NEW')]).status).toBe('NEEDS_ATTENTION');
  });
});

describe('parseCustomerQuery', () => {
  it('reads search, state, application and sort from the URL', () => {
    expect(
      parseCustomerQuery(new URLSearchParams('q=acme&state=attention&application=Docs&sort=customer&dir=desc')),
    ).toEqual({
      search: 'acme',
      state: 'attention',
      application: 'Docs',
      sort: { key: 'customer', dir: 'desc' },
    });
  });

  it('defaults to last activity, newest first, and ignores unknown values', () => {
    const query = parseCustomerQuery(new URLSearchParams('state=bogus&sort=nope'));
    expect(query).toEqual({ search: '', state: null, application: null, sort: DEFAULT_CUSTOMER_SORT });
    expect(DEFAULT_CUSTOMER_SORT).toEqual({ key: 'activity', dir: 'desc' });
  });
});

describe('filtering and sorting customer rows', () => {
  const none: CustomerListQuery = { search: '', state: null, application: null, sort: DEFAULT_CUSTOMER_SORT };
  const rows: CustomerListRow[] = [
    customerListRow(
      customer('alpha', { name: 'Alpha Ltd', email: 'ops@alpha.example', company: 'Alpha Group', createdAt: '2026-01-01T00:00:00Z' }),
      [dep('HEALTHY', { applicationName: 'Docs', deploymentStatus: { updatedAt: '2026-09-01T00:00:00Z' } })],
    ),
    customerListRow(
      customer('beta', { name: 'beta inc', createdAt: '2026-03-01T00:00:00Z' }),
      [
        dep('FAILED', { applicationName: 'Sheets', deploymentStatus: { updatedAt: '2026-09-05T00:00:00Z' } }),
        dep('HEALTHY', { applicationName: 'Docs', deploymentStatus: { updatedAt: '2026-09-04T00:00:00Z' } }),
      ],
    ),
    customerListRow(customer('gamma', { name: 'Gamma', createdAt: '2026-02-01T00:00:00Z' }), []),
    customerListRow(customer('delta', { name: 'Delta', createdAt: '2026-04-01T00:00:00Z' }), [
      dep('DELETED', { applicationName: 'Docs', deploymentStatus: { updatedAt: '2026-08-15T00:00:00Z' } }),
    ]),
  ];
  const names = (list: CustomerListRow[]) => list.map((row) => row.customer.id);

  it('searches name, email and company', () => {
    expect(names(filterCustomerRows(rows, { ...none, search: 'alpha ltd' }))).toEqual(['alpha']);
    expect(names(filterCustomerRows(rows, { ...none, search: 'ops@alpha' }))).toEqual(['alpha']);
    expect(names(filterCustomerRows(rows, { ...none, search: 'alpha group' }))).toEqual(['alpha']);
    expect(filterCustomerRows(rows, { ...none, search: 'zzz' })).toEqual([]);
  });

  it('filters by deployment state and by application', () => {
    expect(names(filterCustomerRows(rows, { ...none, state: 'attention' }))).toEqual(['beta']);
    expect(names(filterCustomerRows(rows, { ...none, state: 'none' }))).toEqual(['gamma', 'delta']);
    expect(names(filterCustomerRows(rows, { ...none, state: 'removed' }))).toEqual(['delta']);
    expect(names(filterCustomerRows(rows, { ...none, application: 'Docs' }))).toEqual(['alpha', 'beta', 'delta']);
    expect(names(filterCustomerRows(rows, { ...none, application: 'Sheets' }))).toEqual(['beta']);
  });

  it('combines filters with AND', () => {
    expect(names(filterCustomerRows(rows, { ...none, state: 'active', application: 'Docs', search: 'beta' }))).toEqual([
      'beta',
    ]);
    expect(filterCustomerRows(rows, { ...none, state: 'removed', application: 'Sheets' })).toEqual([]);
  });

  it('defaults to last activity, newest first', () => {
    expect(names(sortCustomerRows(rows, DEFAULT_CUSTOMER_SORT))).toEqual(['beta', 'alpha', 'delta', 'gamma']);
  });

  it('sorts by customer and by created in both directions', () => {
    expect(names(sortCustomerRows(rows, { key: 'customer', dir: 'asc' }))).toEqual(['alpha', 'beta', 'delta', 'gamma']);
    expect(names(sortCustomerRows(rows, { key: 'customer', dir: 'desc' }))).toEqual(['gamma', 'delta', 'beta', 'alpha']);
    expect(names(sortCustomerRows(rows, { key: 'created', dir: 'desc' }))).toEqual(['delta', 'beta', 'gamma', 'alpha']);
    expect(names(sortCustomerRows(rows, { key: 'created', dir: 'asc' }))).toEqual(['alpha', 'gamma', 'beta', 'delta']);
  });

  it('sorts within a filtered set', () => {
    const filtered = filterCustomerRows(rows, { ...none, application: 'Docs' });
    expect(names(sortCustomerRows(filtered, { key: 'customer', dir: 'desc' }))).toEqual(['delta', 'beta', 'alpha']);
  });

  it('knows when a filter is narrowing the list', () => {
    expect(hasActiveCustomerFilters(none)).toBe(false);
    expect(hasActiveCustomerFilters({ ...none, sort: { key: 'created', dir: 'asc' } })).toBe(false);
    expect(hasActiveCustomerFilters({ ...none, search: 'x' })).toBe(true);
    expect(hasActiveCustomerFilters({ ...none, state: 'active' })).toBe(true);
    expect(hasActiveCustomerFilters({ ...none, application: 'Docs' })).toBe(true);
  });
});
