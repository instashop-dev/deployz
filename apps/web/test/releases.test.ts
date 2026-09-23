import { describe, expect, it } from 'vitest';

import {
  deployableReleases,
  firstReleaseInput,
  installReleaseState,
  suggestNextVersion,
  type Release,
} from '../src/lib/releases';

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

describe('installReleaseState', () => {
  it('names the newest READY release as the one an install runs', () => {
    const state = installReleaseState([
      makeRelease({ id: 'old', createdAt: '2026-09-01T00:00:00.000Z' }),
      makeRelease({ id: 'new', createdAt: '2026-09-02T00:00:00.000Z' }),
      makeRelease({ id: 'building', status: 'BUILDING', createdAt: '2026-09-03T00:00:00.000Z' }),
    ]);
    expect(state).toMatchObject({ kind: 'ready', release: { id: 'new' } });
  });

  it('is building when no release is READY but one is still building', () => {
    const state = installReleaseState([
      makeRelease({ id: 'failed', status: 'FAILED' }),
      makeRelease({ id: 'building', status: 'BUILDING' }),
    ]);
    expect(state).toMatchObject({ kind: 'building', release: { id: 'building' } });
  });

  it('is none without releases, or when every build failed or is unavailable', () => {
    expect(installReleaseState([])).toEqual({ kind: 'none' });
    expect(
      installReleaseState([
        makeRelease({ status: 'FAILED' }),
        makeRelease({ status: 'UNAVAILABLE' }),
      ]),
    ).toEqual({ kind: 'none' });
  });
});

describe('firstReleaseInput', () => {
  it('builds from the analysed commit, versioned by its first 12 characters', () => {
    const sha = 'b2806f9010820a5659899cd0ce0b98d31561041d';
    expect(firstReleaseInput({ analysisCommitSha: sha })).toEqual({ version: 'b2806f901082', gitSha: sha });
  });

  it('is null when the analysis recorded no commit', () => {
    expect(firstReleaseInput(null)).toBeNull();
    expect(firstReleaseInput({})).toBeNull();
  });
});
