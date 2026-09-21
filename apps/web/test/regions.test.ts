import { REGION_LABELS, SUPPORTED_AWS_REGIONS } from '@deployz/contracts';
import { describe, expect, it } from 'vitest';

import { regionName, regionOptionLabel } from '../src/lib/regions';

describe('region display names', () => {
  it('names a known region and keeps the code available', () => {
    expect(regionName('ap-south-1')).toBe('Mumbai');
    expect(regionOptionLabel('ap-south-1')).toBe('Mumbai (ap-south-1)');
  });

  it('falls back to the raw code for a region it has never heard of', () => {
    expect(regionName('xx-future-9')).toBeNull();
    expect(regionOptionLabel('xx-future-9')).toBe('xx-future-9');
  });

  it('is not fooled by names that exist on plain objects', () => {
    expect(regionName('constructor')).toBeNull();
    expect(regionName('toString')).toBeNull();
    expect(regionName('')).toBeNull();
  });

  // The API serves the regions a vendor can deploy to; every one of them must
  // read as a name in the list, and the name must agree with the API's label.
  it('names every supported region consistently with the contract label', () => {
    for (const code of SUPPORTED_AWS_REGIONS) {
      const name = regionName(code);
      expect(name, code).not.toBeNull();
      expect(REGION_LABELS[code], code).toContain(name);
    }
  });
});
