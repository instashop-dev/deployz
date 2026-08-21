import { describe, expect, it } from 'vitest';

import {
  FIXTURE_CONFIG_CUSTOMER_ID,
  fixtureConfig,
  mergeConfig,
} from '../src/lib/config';

// Locks the §31 config-screen data layer: the vendor/customer merge
// precedence, and the fixture contract — fixtures are what the API returns
// AFTER masking, so secret values are null everywhere (plaintext never
// exists in the client). §65: fixture copy is jargon-free.

const JARGON = /\b(CloudFormation|IAM|ECS|ALB|Lambda|VPC|CFN)\b/i;

describe('mergeConfig (§31 precedence)', () => {
  it('customer override wins over the vendor default with the same key', () => {
    const merged = mergeConfig(
      [{ key: 'LOG_LEVEL', isSecret: false, value: 'info' }],
      [{ key: 'LOG_LEVEL', isSecret: false, value: 'debug' }],
    );
    expect(merged).toEqual([
      { key: 'LOG_LEVEL', isSecret: false, value: 'debug', source: 'customer', vendorValue: 'info' },
    ]);
  });

  it('non-overridden keys stay vendor-sourced; customer-only keys are appended in order', () => {
    const merged = mergeConfig(
      [
        { key: 'A', isSecret: false, value: '1' },
        { key: 'B', isSecret: false, value: '2' },
      ],
      [{ key: 'C', isSecret: false, value: '3' }],
    );
    expect(merged.map((entry) => entry.key)).toEqual(['A', 'B', 'C']);
    expect(merged[0]).toMatchObject({ source: 'vendor', vendorValue: null });
    expect(merged[2]).toMatchObject({ source: 'customer', vendorValue: null });
  });

  it('an overridden secret never surfaces the vendor value', () => {
    const merged = mergeConfig(
      [{ key: 'DATABASE_URL', isSecret: true, value: null }],
      [{ key: 'DATABASE_URL', isSecret: true, value: null }],
    );
    expect(merged[0]).toMatchObject({ source: 'customer', value: null, vendorValue: null });
  });
});

describe('fixtureConfig (masked fixture contract)', () => {
  it('renders vendor defaults and customer overrides for the fixture customer', () => {
    const fixture = fixtureConfig('fixture-repo-1');
    expect(fixture.customerId).toBe(FIXTURE_CONFIG_CUSTOMER_ID);
    expect(fixture.vendorDefaults.map((entry) => entry.key)).toEqual([
      'DATABASE_URL',
      'LOG_LEVEL',
      'MAX_CONNECTIONS',
    ]);
    expect(fixture.customerOverrides.map((entry) => entry.key)).toEqual(['LOG_LEVEL', 'API_KEY']);
  });

  it('every secret entry is masked — no plaintext anywhere in the fixture', () => {
    const fixture = fixtureConfig('fixture-repo-1');
    for (const entry of [...fixture.vendorDefaults, ...fixture.customerOverrides, ...fixture.effective]) {
      if (entry.isSecret) {
        expect(entry.value).toBeNull();
      }
    }
    // The fixture must not contain any value that looks like a secret payload.
    expect(JSON.stringify(fixture)).not.toMatch(/postgres:\/\/|password|token/i);
  });

  it('the effective config reflects the override precedence', () => {
    const fixture = fixtureConfig('fixture-repo-1');
    const logLevel = fixture.effective.find((entry) => entry.key === 'LOG_LEVEL');
    expect(logLevel).toMatchObject({ value: 'debug', source: 'customer', vendorValue: 'info' });
    const databaseUrl = fixture.effective.find((entry) => entry.key === 'DATABASE_URL');
    expect(databaseUrl).toMatchObject({ isSecret: true, value: null, source: 'vendor' });
  });

  it('fixture copy is jargon-free (§65)', () => {
    const fixture = fixtureConfig('fixture-repo-1');
    const text = JSON.stringify(fixture);
    expect(text).not.toMatch(JARGON);
  });
});
