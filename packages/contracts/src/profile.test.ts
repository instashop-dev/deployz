import { describe, expect, it } from 'vitest';

import {
  defaultInfrastructureSizeProfile,
  INFRASTRUCTURE_SIZE_PROFILES,
  profileKey,
  resolveInfrastructureSizeProfile,
  resolveStoredInfrastructureSizeProfile,
  SMALL_PROFILE,
} from './profile.js';

describe('infrastructure-size profile registry', () => {
  it('publishes exactly one profile: small-v1', () => {
    expect(INFRASTRUCTURE_SIZE_PROFILES).toHaveLength(1);
    expect(SMALL_PROFILE.id).toBe('small');
    expect(SMALL_PROFILE.version).toBe(1);
    expect(profileKey(SMALL_PROFILE)).toBe('small-v1');
  });

  it('small-v1 preserves the pre-registry AWS sizing exactly', () => {
    expect(SMALL_PROFILE.workload).toEqual({ cpuUnits: 256, memoryMiB: 512, desiredCount: 1 });
    expect(SMALL_PROFILE.database).toEqual({
      instanceClass: 'db.t4g.micro',
      storageGb: 20,
      maxStorageGb: 100,
    });
    expect(SMALL_PROFILE.cache).toEqual({ nodeType: 'cache.t4g.micro', nodeCount: 1 });
    expect(SMALL_PROFILE.label).toBe('Small');
  });

  it('resolves the published profile by id + version and fails closed on unknown', () => {
    expect(resolveInfrastructureSizeProfile('small', 1)).toBe(SMALL_PROFILE);
    expect(resolveInfrastructureSizeProfile('small', 2)).toBeUndefined();
    expect(resolveInfrastructureSizeProfile('large', 1)).toBeUndefined();
    expect(defaultInfrastructureSizeProfile()).toBe(SMALL_PROFILE);
  });

  it('resolves a frozen deployment to its stored profile, defaulting legacy deployments to small-v1', () => {
    expect(resolveStoredInfrastructureSizeProfile(null)).toBe(SMALL_PROFILE);
    expect(resolveStoredInfrastructureSizeProfile({})).toBe(SMALL_PROFILE);
    expect(
      resolveStoredInfrastructureSizeProfile({ infrastructureProfile: { id: 'small', version: 1 } }),
    ).toBe(SMALL_PROFILE);
    // A stored reference to an unpublished profile is undefined, not a guess.
    expect(
      resolveStoredInfrastructureSizeProfile({ infrastructureProfile: { id: 'large', version: 1 } }),
    ).toBeUndefined();
  });
});
