import { describe, expect, it } from 'vitest';

import { deployableReleases, type Release } from '../src/lib/releases';

function makeRelease(overrides: Partial<Release>): Release {
  return {
    id: 'rel-1',
    version: 'v1.0.0',
    status: 'READY',
    failureReason: null,
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
