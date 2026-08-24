// §28 relay liveness, derived on read.
//
// The relay polls on a fixed schedule and reports health as it goes. Nothing
// in the MVP sweeps for relays that have gone quiet, so `relay_status` was
// only ever written as CONNECTED and DISCONNECTED was unreachable: a
// deployment whose relay died weeks ago still read Healthy — and still billed
// at $19/month, because billing follows the deployment state.
//
// Deriving it from `last_health_at` on every read gives the fleet list, the
// detail page and the homepage the same answer without a scheduler. The
// persistent version (a sweep that also emits the §47 "relay disconnected"
// notification) can replace this later; the derivation stays correct either
// way because it is a pure function of the last check-in.

/** The relay's poll interval. Matches the bootstrap stack's schedule. */
export const RELAY_POLL_INTERVAL_MS = 5 * 60 * 1000;

/** Missed polls tolerated before a relay counts as gone. */
export const RELAY_MISSED_POLLS_BEFORE_DISCONNECTED = 3;

export const RELAY_STALE_AFTER_MS =
  RELAY_POLL_INTERVAL_MS * RELAY_MISSED_POLLS_BEFORE_DISCONNECTED;

export type RelayStatus = 'CONNECTED' | 'DISCONNECTED' | 'UNKNOWN';
export type HealthStatus = 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';

/**
 * The relay's status as of `now`.
 *
 * UNKNOWN (never checked in) stays UNKNOWN rather than becoming DISCONNECTED:
 * a deployment whose customer has not run the install link yet has no relay
 * to have lost, and saying otherwise would send the vendor chasing a fault
 * that does not exist.
 */
export function deriveRelayStatus(
  stored: RelayStatus,
  lastHealthAt: Date | null,
  now: Date,
): RelayStatus {
  if (lastHealthAt === null) {
    return stored === 'CONNECTED' ? 'CONNECTED' : 'UNKNOWN';
  }
  return now.getTime() - lastHealthAt.getTime() > RELAY_STALE_AFTER_MS
    ? 'DISCONNECTED'
    : 'CONNECTED';
}

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
