import { describe, expect, it } from 'vitest';

import { deployableReleases, suggestNextVersion, type Release } from '../src/lib/releases';

function makeRelease(overrides: Partial<Release>): Release {
  return {
    id: 'rel-1',
    version: 'v1.0.0',
    status: 'READY',
    failureReason: null,
    gitSha: 'a'.repeat(40),
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('deployableReleases', () => {
  it('offers only READY releases, excluding UNAVAILABLE', () => {
    const releases: Release[] = [
      makeRelease({ id: 'ready-1', status: 'READY' }),
      makeRelease({ id: 'unavailable-1', status: 'UNAVAILABLE' }),
      makeRelease({ id: 'failed-1', status: 'FAILED' }),
      makeRelease({ id: 'building-1', status: 'BUILDING' }),
    ];
    const result = deployableReleases(releases, null);
    expect(result.map((r) => r.id)).toEqual(['ready-1']);
  });
});

describe('suggestNextVersion', () => {
  it('increments the patch of the newest release, keeping the v prefix', () => {
    const versions = [
      { version: 'v0.1.0', createdAt: '2026-09-01T00:00:00.000Z' },
      { version: 'v0.1.1', createdAt: '2026-09-10T00:00:00.000Z' },
    ];
    expect(suggestNextVersion(versions)).toBe('v0.1.2');
  });

  it('increments the patch of a bare (non-prefixed) semver version', () => {
    expect(suggestNextVersion([{ version: '1.0.9', createdAt: '2026-09-01T00:00:00.000Z' }])).toBe(
      '1.0.10',
    );
  });

  it('returns an empty string when the newest version is not plain semver', () => {
    expect(
      suggestNextVersion([{ version: 'sha-1.0.0', createdAt: '2026-09-01T00:00:00.000Z' }]),
    ).toBe('');
  });

  it('returns an empty string when there are no releases', () => {
    expect(suggestNextVersion([])).toBe('');
  });
});
