import { describe, expect, it } from 'vitest';

import {
  defaultInfrastructureSizeProfile,
  INFRASTRUCTURE_SIZE_PROFILES,
  profileKey,
  resolveInfrastructureSizeProfile,
  resolveStoredInfrastructureSizeProfile,
  SMALL_PROFILE,
  SMALL_V2_PROFILE,
} from './profile.js';

describe('infrastructure-size profile registry', () => {
  it('publishes two immutable profiles: small-v1 and small-v2', () => {
    expect(INFRASTRUCTURE_SIZE_PROFILES).toHaveLength(2);
    expect(SMALL_PROFILE.id).toBe('small');
    expect(SMALL_PROFILE.version).toBe(1);
    expect(profileKey(SMALL_PROFILE)).toBe('small-v1');
    expect(SMALL_V2_PROFILE.id).toBe('small');
    expect(SMALL_V2_PROFILE.version).toBe(2);
    expect(profileKey(SMALL_V2_PROFILE)).toBe('small-v2');
  });

  it('small-v1 preserves the pre-registry AWS sizing exactly', () => {
    expect(SMALL_PROFILE.workload).toEqual({ cpuUnits: 256, memoryMiB: 512, desiredCount: 1 });
    expect(SMALL_PROFILE.database).toEqual({
      instanceClass: 'db.t4g.micro',
      storageGb: 20,
      maxStorageGb: 100,
      storageType: 'gp2',
    });
    expect(SMALL_PROFILE.cache).toEqual({ nodeType: 'cache.t4g.micro', nodeCount: 1 });
    expect(SMALL_PROFILE.label).toBe('Small');
  });

  it('small-v2 uses db.t3.micro and gp3 for portability', () => {
    expect(SMALL_V2_PROFILE.workload).toEqual({ cpuUnits: 256, memoryMiB: 512, desiredCount: 1 });
    expect(SMALL_V2_PROFILE.database).toEqual({
      instanceClass: 'db.t3.micro',
      storageGb: 20,
      maxStorageGb: 100,
      storageType: 'gp3',
    });
    expect(SMALL_V2_PROFILE.cache).toEqual({ nodeType: 'cache.t4g.micro', nodeCount: 1 });
    expect(SMALL_V2_PROFILE.label).toBe('Small');
  });

  it('resolves published profiles by id + version and fails closed on unknown', () => {
    expect(resolveInfrastructureSizeProfile('small', 1)).toBe(SMALL_PROFILE);
    expect(resolveInfrastructureSizeProfile('small', 2)).toBe(SMALL_V2_PROFILE);
    expect(resolveInfrastructureSizeProfile('small', 3)).toBeUndefined();
    expect(resolveInfrastructureSizeProfile('large', 1)).toBeUndefined();
  });

  it('defaults to small-v2 for newly created deployments', () => {
    expect(defaultInfrastructureSizeProfile()).toBe(SMALL_V2_PROFILE);
  });

  it('resolves a frozen deployment to its stored profile, defaulting legacy deployments to small-v2', () => {
    expect(resolveStoredInfrastructureSizeProfile(null)).toBe(SMALL_V2_PROFILE);
    expect(resolveStoredInfrastructureSizeProfile({})).toBe(SMALL_V2_PROFILE);
    expect(
      resolveStoredInfrastructureSizeProfile({ infrastructureProfile: { id: 'small', version: 1 } }),
    ).toBe(SMALL_PROFILE);
    expect(
      resolveStoredInfrastructureSizeProfile({ infrastructureProfile: { id: 'small', version: 2 } }),
    ).toBe(SMALL_V2_PROFILE);
    // A stored reference to an unpublished profile is undefined, not a guess.
    expect(
      resolveStoredInfrastructureSizeProfile({ infrastructureProfile: { id: 'large', version: 1 } }),
    ).toBeUndefined();
    expect(
      resolveStoredInfrastructureSizeProfile({ infrastructureProfile: { id: 'small', version: 99 } }),
    ).toBeUndefined();
  });
});
