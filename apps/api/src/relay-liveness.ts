// §28 relay liveness, persisted.
//
// The relay polls on a fixed schedule and reports health as it goes. The
// heartbeat writes CONNECTED; the worker's scheduled sweep (15 min, same
// cadence as the stuck-job watchdog) persists DISCONNECTED once
// RELAY_STALE_AFTER_MS passes without a check-in, and a returning relay's
// heartbeat flips the column straight back to CONNECTED. Every read — fleet
// badge, deployment detail, action gating, diagnostics — trusts the persisted
// column instead of re-deriving it, so all screens agree without a scheduler
// of their own.

import { RELAY_STALE_AFTER_MS } from '@deployz/contracts';

export { RELAY_STALE_AFTER_MS };

/** The relay's poll interval. Matches the bootstrap stack's schedule. */
export const RELAY_POLL_INTERVAL_MS = 5 * 60 * 1000;

/** Missed polls tolerated before a relay counts as gone. */
export const RELAY_MISSED_POLLS_BEFORE_DISCONNECTED = 3;

export type RelayStatus = 'CONNECTED' | 'DISCONNECTED' | 'UNKNOWN';
export type HealthStatus = 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';

/**
 * Health as of `now`. A stale relay means the reported health is stale too —
 * whatever it last said, we no longer know, and UNKNOWN is the honest answer.
 */
export function deriveHealthStatus(
  stored: HealthStatus,
  relayStatus: RelayStatus,
): HealthStatus {
  return relayStatus === 'DISCONNECTED' ? 'UNKNOWN' : stored;
}
