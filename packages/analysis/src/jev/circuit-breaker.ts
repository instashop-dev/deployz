/**
 * In-memory circuit breaker for the Jev client — a consecutive-failure counter
 * with a timed bypass window.
 *
 * Closed: everything flows and failures count. Reaching `failureThreshold`
 * consecutive failures opens the breaker. Open: nothing flows until
 * `bypassDurationMs` has passed — a persistently failing provider is not worth
 * hammering while it is down, and for a shadow-mode consumer the cheapest
 * failure is no request at all. Half-open: exactly one probe attempt is
 * allowed; its outcome closes the breaker or re-opens it.
 *
 * Pure and in-memory by design: one breaker per process, `now` injectable so
 * tests advance the clock without fake timers.
 */

export interface JevCircuitBreaker {
  /** `true` when a request may be attempted right now. */
  allow(): boolean;
  /** Record a successful attempt: close the breaker and reset the failure count. */
  recordSuccess(): void;
  /** Record a failed attempt: count it, and open (or re-open) when it qualifies. */
  recordFailure(): void;
}

export interface JevCircuitBreakerOptions {
  /** Consecutive failures before the breaker opens. Default 5. */
  readonly failureThreshold?: number;
  /** How long an open breaker stays open before one probe is allowed. Default 10 minutes. */
  readonly bypassDurationMs?: number;
  /** Injectable clock. Default `Date.now`. */
  readonly now?: () => number;
}

type BreakerState = 'closed' | 'open' | 'half-open';

export function createJevCircuitBreaker(
  options: JevCircuitBreakerOptions = {},
): JevCircuitBreaker {
  const failureThreshold = options.failureThreshold ?? 5;
  const bypassDurationMs = options.bypassDurationMs ?? 10 * 60_000;
  const now = options.now ?? Date.now;

  let state: BreakerState = 'closed';
  let consecutiveFailures = 0;
  let openedAt = 0;

  return {
    allow(): boolean {
      if (state === 'closed') return true;
      if (state === 'open') {
        if (now() < openedAt + bypassDurationMs) return false;
        state = 'half-open';
        return true;
      }
      // Half-open: the one allowed probe is already in flight.
      return false;
    },
    recordSuccess(): void {
      state = 'closed';
      consecutiveFailures = 0;
    },
    recordFailure(): void {
      consecutiveFailures += 1;
      // A half-open probe failing re-opens immediately; otherwise the count
      // has to reach the threshold first.
      if (state === 'half-open' || consecutiveFailures >= failureThreshold) {
        state = 'open';
        openedAt = now();
      }
    },
  };
}
