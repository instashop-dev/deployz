import { describe, expect, it } from 'vitest';

import {
  CUSTOMER_DNS_SCOPE_RE,
  CUSTOMER_SCOPE_LABEL_PREFIX,
  DEFAULT_DEPLOYMENT_LABEL_PREFIX,
  DEFAULT_HTTPS_ZONE,
  customerNamespaceHostname,
  customerScopeLabel,
  isScopeValidationRecordName,
  isValidCustomerDnsScope,
  legacyDefaultDeploymentHostname,
  parseLegacyDefaultDeploymentHostname,
  parseScopedDeploymentHostname,
  regionalCertificateDomain,
  scopedDeploymentHostname,
  scopedDeploymentUrl,
} from './hostnames.js';

const SCOPE = 'abc123def456';
const DEPLOYMENT_ID = '11111111-2222-3333-4444-555555555555';

describe('constants', () => {
  it('pins the zone and label prefixes', () => {
    expect(DEFAULT_HTTPS_ZONE).toBe('deployz.dev');
    expect(DEFAULT_DEPLOYMENT_LABEL_PREFIX).toBe('d-');
    expect(CUSTOMER_SCOPE_LABEL_PREFIX).toBe('c-');
  });
});

describe('isValidCustomerDnsScope', () => {
  it('accepts 4-32 lowercase alphanumeric characters', () => {
    expect(isValidCustomerDnsScope('abcd')).toBe(true);
    expect(isValidCustomerDnsScope('a'.repeat(32))).toBe(true);
    expect(isValidCustomerDnsScope(SCOPE)).toBe(true);
  });

  it('rejects too short, too long, uppercase, or non-alphanumeric values', () => {
    expect(isValidCustomerDnsScope('abc')).toBe(false);
    expect(isValidCustomerDnsScope('a'.repeat(33))).toBe(false);
    expect(isValidCustomerDnsScope('ABCD')).toBe(false);
    expect(isValidCustomerDnsScope('abc-123')).toBe(false);
    expect(isValidCustomerDnsScope('')).toBe(false);
  });

  it('matches CUSTOMER_DNS_SCOPE_RE directly', () => {
    expect(CUSTOMER_DNS_SCOPE_RE.test(SCOPE)).toBe(true);
  });
});

describe('customerScopeLabel', () => {
  it('prefixes a valid scope with c-', () => {
    expect(customerScopeLabel(SCOPE)).toBe(`c-${SCOPE}`);
  });

  it('throws on an invalid scope', () => {
    expect(() => customerScopeLabel('BAD')).toThrow();
  });
});

describe('customerNamespaceHostname', () => {
  it('builds c-<scope>.<zone>, defaulting the zone', () => {
    expect(customerNamespaceHostname(SCOPE)).toBe(`c-${SCOPE}.deployz.dev`);
  });

  it('honors a custom zone', () => {
    expect(customerNamespaceHostname(SCOPE, 'deployz-fixture.test')).toBe(`c-${SCOPE}.deployz-fixture.test`);
  });
});

describe('regionalCertificateDomain', () => {
  it('is the wildcard over the customer namespace', () => {
    expect(regionalCertificateDomain(SCOPE)).toBe(`*.c-${SCOPE}.deployz.dev`);
  });
});

describe('scopedDeploymentHostname / scopedDeploymentUrl', () => {
  it('builds d-<id>.c-<scope>.<zone>, lowercasing the deployment id', () => {
    const upper = DEPLOYMENT_ID.toUpperCase();
    expect(scopedDeploymentHostname(upper, SCOPE)).toBe(`d-${DEPLOYMENT_ID}.c-${SCOPE}.deployz.dev`);
  });

  it('honors a custom prefix and zone', () => {
    expect(scopedDeploymentHostname(DEPLOYMENT_ID, SCOPE, { prefix: 'x-', zone: 'example.com' })).toBe(
      `x-${DEPLOYMENT_ID}.c-${SCOPE}.example.com`,
    );
  });

  it('throws on a deployment id that is not DNS-safe', () => {
    expect(() => scopedDeploymentHostname('not a valid id!', SCOPE)).toThrow();
  });

  it('builds the https URL', () => {
    expect(scopedDeploymentUrl(DEPLOYMENT_ID, SCOPE)).toBe(`https://d-${DEPLOYMENT_ID}.c-${SCOPE}.deployz.dev`);
  });
});

describe('legacyDefaultDeploymentHostname', () => {
  it('builds d-<id>.<zone>, the pre-regional shape', () => {
    expect(legacyDefaultDeploymentHostname(DEPLOYMENT_ID)).toBe(`d-${DEPLOYMENT_ID}.deployz.dev`);
  });
});

describe('parseScopedDeploymentHostname', () => {
  it('round-trips a hostname it built', () => {
    const hostname = scopedDeploymentHostname(DEPLOYMENT_ID, SCOPE);
    expect(parseScopedDeploymentHostname(hostname)).toEqual({ deploymentId: DEPLOYMENT_ID, dnsScope: SCOPE });
  });

  it('is case-insensitive', () => {
    const hostname = scopedDeploymentHostname(DEPLOYMENT_ID, SCOPE).toUpperCase();
    expect(parseScopedDeploymentHostname(hostname)).toEqual({ deploymentId: DEPLOYMENT_ID, dnsScope: SCOPE });
  });

  it('rejects a non-uuid deployment id', () => {
    expect(parseScopedDeploymentHostname(`d-not-a-uuid.c-${SCOPE}.deployz.dev`)).toBeNull();
  });

  it('rejects an invalid scope label', () => {
    expect(parseScopedDeploymentHostname(`d-${DEPLOYMENT_ID}.c-BAD.deployz.dev`)).toBeNull();
  });

  it('rejects the legacy (unscoped) shape', () => {
    expect(parseScopedDeploymentHostname(`d-${DEPLOYMENT_ID}.deployz.dev`)).toBeNull();
  });

  it('rejects the wrong zone', () => {
    expect(parseScopedDeploymentHostname(`d-${DEPLOYMENT_ID}.c-${SCOPE}.example.com`)).toBeNull();
  });
});

describe('parseLegacyDefaultDeploymentHostname', () => {
  it('round-trips a hostname it built', () => {
    expect(parseLegacyDefaultDeploymentHostname(legacyDefaultDeploymentHostname(DEPLOYMENT_ID))).toBe(DEPLOYMENT_ID);
  });

  it('is case-insensitive', () => {
    expect(parseLegacyDefaultDeploymentHostname(legacyDefaultDeploymentHostname(DEPLOYMENT_ID).toUpperCase())).toBe(
      DEPLOYMENT_ID,
    );
  });

  it('rejects a scoped hostname', () => {
    expect(parseLegacyDefaultDeploymentHostname(scopedDeploymentHostname(DEPLOYMENT_ID, SCOPE))).toBeNull();
  });

  it('rejects a non-uuid id and reserved hostnames', () => {
    expect(parseLegacyDefaultDeploymentHostname('app.deployz.dev')).toBeNull();
    expect(parseLegacyDefaultDeploymentHostname('deployz.dev')).toBeNull();
  });
});

describe('isScopeValidationRecordName', () => {
  it('accepts exactly one label directly under the customer namespace', () => {
    expect(isScopeValidationRecordName(`_abc123.c-${SCOPE}.deployz.dev`, SCOPE)).toBe(true);
  });

  it('tolerates a single trailing dot (FQDN form)', () => {
    expect(isScopeValidationRecordName(`_abc123.c-${SCOPE}.deployz.dev.`, SCOPE)).toBe(true);
  });

  it('rejects more than one label under the namespace', () => {
    expect(isScopeValidationRecordName(`_abc123.nested.c-${SCOPE}.deployz.dev`, SCOPE)).toBe(false);
  });

  it('rejects no label at all (the namespace hostname itself)', () => {
    expect(isScopeValidationRecordName(`c-${SCOPE}.deployz.dev`, SCOPE)).toBe(false);
  });

  it('rejects a name under a different scope', () => {
    expect(isScopeValidationRecordName(`_abc123.c-otherscope1.deployz.dev`, SCOPE)).toBe(false);
  });

  it('returns false for an invalid scope', () => {
    expect(isScopeValidationRecordName(`_abc123.c-BAD.deployz.dev`, 'BAD')).toBe(false);
  });
});
