import { describe, expect, it } from 'vitest';

import {
  DOMAIN_STATUS_LABEL,
  domainErrorCopy,
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
