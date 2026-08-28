import { describe, expect, it } from 'vitest';

import type { RelayCapabilities } from '../src/lib/deployments';
import { DeploymentRequestError, isDeploymentNotFound } from '../src/lib/deployments';
import {
  RELAY_STATUS_LABEL,
  UNSUPPORTED_ACTION_COPY,
  actionSupported,
} from '../src/lib/deployment-vocabulary';
import { deployableReleases, runningReleaseIds, type Release } from '../src/lib/releases';

// Phase 1 honesty rules: management actions derive their enabled state purely
// from relay-reported capabilities and release data — never from lifecycle
// guesses — so the buttons are deterministic from the first render (no
// click-swallowed-during-hydration class of bug can hide here).

const FULL_CAPS: RelayCapabilities = {
  deployRelease: true,
  rollback: true,
  restart: true,
  configUpdate: true,
  destroy: true,
  domainManagement: true,
};

const DOMAIN_ONLY: RelayCapabilities = { ...FULL_CAPS, deployRelease: false, rollback: false, restart: false, configUpdate: false, destroy: false };

describe('actionSupported', () => {
  it('enables every day-2 action when the relay advertises it', () => {
    expect(actionSupported(FULL_CAPS, 'deploy')).toBe(true);
    expect(actionSupported(FULL_CAPS, 'rollback')).toBe(true);
    expect(actionSupported(FULL_CAPS, 'restart')).toBe(true);
    expect(actionSupported(FULL_CAPS, 'configUpdate')).toBe(true);
    expect(actionSupported(FULL_CAPS, 'disconnect')).toBe(true);
  });

  it('gates every unimplemented action off for a relay that only manages domains', () => {
    for (const action of ['deploy', 'rollback', 'restart', 'configUpdate', 'disconnect'] as const) {
      expect(actionSupported(DOMAIN_ONLY, action)).toBe(false);
    }
  });

  it('treats null capabilities (pre-capability relay) as supporting nothing', () => {
    for (const action of ['deploy', 'rollback', 'restart', 'configUpdate', 'disconnect'] as const) {
      expect(actionSupported(null, action)).toBe(false);
    }
  });

  it('ships stable copy for gated-off actions', () => {
    expect(UNSUPPORTED_ACTION_COPY).toBe(
      'This action is not supported by the currently installed Deployz connector.',
    );
  });
});

describe('deployableReleases', () => {
  function release(
    id: string,
    status: Release['status'],
    createdAt: string,
    failureReason: string | null = null,
  ): Release {
    return { id, version: `v-${id}`, status, failureReason, createdAt };
  }

  const releases = [
    release('r1', 'READY', '2026-08-25T10:00:00Z'),
    release('r2', 'FAILED', '2026-08-26T10:00:00Z'),
    release('r3', 'BUILDING', '2026-08-27T10:00:00Z'),
    release('r4', 'READY', '2026-08-26T12:00:00Z'),
    release('r5', 'READY', '2026-08-24T10:00:00Z'),
  ];

  it('offers READY releases only, newest first, excluding the running one', () => {
    expect(deployableReleases(releases, 'r1').map((r) => r.id)).toEqual(['r4', 'r5']);
  });

  it('excludes the current release even when it is the newest', () => {
    expect(deployableReleases([release('new', 'READY', '2026-08-28T00:00:00Z'), release('old', 'READY', '2026-08-01T00:00:00Z')], 'new').map((r) => r.id)).toEqual(['old']);
  });

  it('returns nothing when only non-READY releases exist', () => {
    expect(
      deployableReleases(
        [release('b', 'BUILDING', '2026-08-28T00:00:00Z'), release('f', 'FAILED', '2026-08-27T00:00:00Z')],
        null,
      ),
    ).toEqual([]);
  });

  it('returns nothing when no release exists', () => {
    expect(deployableReleases([], null)).toEqual([]);
  });
});

describe('runningReleaseIds', () => {
  it('collects current releases of live deployments only', () => {
    const ids = runningReleaseIds([
      { currentReleaseId: 'r1', state: 'HEALTHY' },
      { currentReleaseId: 'r2', state: 'UPDATE_AVAILABLE' },
      { currentReleaseId: 'r3', state: 'DELETED' },
      { currentReleaseId: null, state: 'HEALTHY' },
    ]);
    expect(ids.has('r1')).toBe(true);
    expect(ids.has('r2')).toBe(true);
    expect(ids.has('r3')).toBe(false);
    expect(ids.size).toBe(2);
  });

  it('returns an empty set when no deployment exists', () => {
    expect(runningReleaseIds([]).size).toBe(0);
  });
});

describe('relay status labels', () => {
  it('names a lost relay "Relay offline"', () => {
    expect(RELAY_STATUS_LABEL.DISCONNECTED).toBe('Relay offline');
    expect(RELAY_STATUS_LABEL.CONNECTED).toBe('Relay online');
  });
});

describe('isDeploymentNotFound', () => {
  it('classifies only 404 fetch errors as not-found', () => {
    expect(isDeploymentNotFound(new DeploymentRequestError('x', 404))).toBe(true);
    expect(isDeploymentNotFound(new DeploymentRequestError('x', 500))).toBe(false);
    expect(isDeploymentNotFound(new Error('x'))).toBe(false);
  });
});
