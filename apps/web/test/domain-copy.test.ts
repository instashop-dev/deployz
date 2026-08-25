import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DOMAIN_STATUS_LABEL,
  domainErrorCopy,
  fetchDomainAccess,
  isGenericDomainError,
  type CustomDomainStatus,
} from '../src/lib/domains';

// Custom-domains MVP §65 — status/error copy the customer-facing domain
// panel renders. Locks the exact product wording so a future refactor can't
// silently drift the strings shown to a customer.

describe('DOMAIN_STATUS_LABEL', () => {
  it('maps all six statuses to the spec labels', () => {
    const expected: Record<CustomDomainStatus, string> = {
      pending: 'Setting up',
      waiting_for_dns: 'Waiting for DNS',
      configuring: 'Connecting',
      active: 'Active',
      error: 'Needs attention',
      removing: 'Removing',
    };
    expect(DOMAIN_STATUS_LABEL).toEqual(expected);
  });
});

describe('domainErrorCopy', () => {
  it('returns null for a null code', () => {
    expect(domainErrorCopy(null)).toBeNull();
  });

  it('maps DNS_VALIDATION_NOT_FOUND', () => {
    expect(domainErrorCopy('DNS_VALIDATION_NOT_FOUND')).toEqual({
      title: 'Verification record not found',
      body: "We couldn't find the required DNS record yet. Check that it matches exactly.",
    });
  });

  it('maps DNS_ROUTING_MISMATCH', () => {
    expect(domainErrorCopy('DNS_ROUTING_MISMATCH')).toEqual({
      title: "Domain isn't pointing to this deployment",
      body: 'Update the routing CNAME to the value shown below.',
    });
  });

  it('maps AWS_PERMISSION_DENIED', () => {
    expect(domainErrorCopy('AWS_PERMISSION_DENIED')).toEqual({
      title: "Deployz couldn't configure HTTPS",
      body: "The connected AWS account doesn't currently allow Deployz to complete the domain setup.",
    });
  });

  it.each(['CONFIGURE_FAILED', 'HTTPS_NOT_REACHABLE', 'REMOVE_FAILED', 'SOME_UNKNOWN_CODE'])(
    'maps %s to the generic connect-failure copy',
    (code) => {
      expect(domainErrorCopy(code)).toEqual({
        title: "We couldn't connect this domain",
        body: 'Check the DNS records and try again.',
      });
    },
  );
});

// CustomDomainCard uses this to switch its "Check again"/"Retry" button
// label without re-declaring GENERIC_ERROR_COPY's strings itself.
describe('isGenericDomainError', () => {
  it('returns false for null (no error)', () => {
    expect(isGenericDomainError(null)).toBe(false);
  });

  it.each(['DNS_VALIDATION_NOT_FOUND', 'DNS_ROUTING_MISMATCH', 'AWS_PERMISSION_DENIED'])(
    'returns false for the specifically-copied code %s',
    (code) => {
      expect(isGenericDomainError(code)).toBe(false);
    },
  );

  it.each(['CONFIGURE_FAILED', 'HTTPS_NOT_REACHABLE', 'REMOVE_FAILED', 'SOME_UNKNOWN_CODE'])(
    'returns true for %s (generic connect-failure copy)',
    (code) => {
      expect(isGenericDomainError(code)).toBe(true);
    },
  );
});

// `fetchDomain` collapses "no domain yet" and "no access" into the same
// `null`, which is exactly the distinction CustomDomainCard's manage-vs-
// customer mode detection needs. `fetchDomainAccess` keeps them apart.
describe('fetchDomainAccess', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(response: { ok: boolean; status: number; body: unknown }): void {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: response.ok,
        status: response.status,
        json: async () => response.body,
      }),
    );
  }

  it('reports canManage true with the domain on a successful read (including no domain yet)', async () => {
    stubFetch({ ok: true, status: 200, body: { domain: null } });
    await expect(fetchDomainAccess('dep-1')).resolves.toEqual({ canManage: true, domain: null });
  });

  it.each(['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'])(
    'reports canManage false when the server rejects with %s',
    async (code) => {
      stubFetch({ ok: false, status: 403, body: { error: { code } } });
      await expect(fetchDomainAccess('dep-1')).resolves.toEqual({
        canManage: false,
        domain: null,
      });
    },
  );

  it('rethrows other errors instead of masking them as no-access', async () => {
    stubFetch({ ok: false, status: 500, body: { error: { code: 'REQUEST_FAILED' } } });
    await expect(fetchDomainAccess('dep-1')).rejects.toThrow();
  });
});
