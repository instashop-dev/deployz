import { describe, expect, it } from 'vitest';

import { listedUnderStatus, matchesRememberedCustomer, type RememberedCustomer } from '../src/lib/deployments';

const REMEMBERED: RememberedCustomer = {
  id: 'cust-1',
  name: 'Canary 20260902',
  email: 'canary@example.com',
};

describe('matchesRememberedCustomer', () => {
  it('returns false when nothing is remembered yet', () => {
    expect(matchesRememberedCustomer(null, REMEMBERED.name, REMEMBERED.email)).toBe(false);
  });

  it('reuses the remembered customer when the retry carries the same name and email', () => {
    expect(matchesRememberedCustomer(REMEMBERED, REMEMBERED.name, REMEMBERED.email)).toBe(true);
  });

  it('does not reuse the remembered customer when the name changed', () => {
    expect(matchesRememberedCustomer(REMEMBERED, 'Someone Else', REMEMBERED.email)).toBe(false);
  });

  it('does not reuse the remembered customer when the email changed', () => {
    expect(matchesRememberedCustomer(REMEMBERED, REMEMBERED.name, 'other@example.com')).toBe(
      false,
    );
  });
});

describe('listedUnderStatus', () => {
  it('keeps removed deployments out of the live fleet', () => {
    expect(listedUnderStatus({ state: 'DELETED' }, 'all')).toBe(false);
    expect(listedUnderStatus({ state: 'HEALTHY' }, 'all')).toBe(true);
  });

  it('lists removed deployments under the Removed filter only', () => {
    expect(listedUnderStatus({ state: 'DELETED' }, 'DELETED')).toBe(true);
    expect(listedUnderStatus({ state: 'HEALTHY' }, 'DELETED')).toBe(false);
    expect(listedUnderStatus({ state: 'HEALTHY' }, 'HEALTHY')).toBe(true);
  });
});
