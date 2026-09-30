/**
 * Retry for control-plane calls that must not be lost to a transient failure.
 *
 * The control plane runs on a small Lambda concurrency quota: when it is
 * throttled, API Gateway answers 429/5xx, or the connection fails outright.
 * A command result or a config fetch that gave up on the first such answer
 * would leave the job RUNNING until the watchdog re-offers it (or fail a
 * CONFIG_UPDATE for a reason that has passed a second later). Only the relay
 * side changes; the requests and their idempotent server handling are the
 * same, so older control planes and older relays stay compatible.
 */

import type { FetchFn } from './auth.js';

/** Delays before each retry: four retries, about half a minute in total. */
export const CONTROL_PLANE_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000, 9_000, 20_000];

export type SleepFn = (ms: number) => Promise<void>;

const realSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

type FetchResponse = Awaited<ReturnType<FetchFn>>;

/** Whether a status says "the service could not take this now, try again". */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Calls `fetchFn`, retrying a thrown error, a 429 or a 5xx with the given
 * delays. Returns the last response (which may still be a failure status) or
 * rethrows the last error once the delays are spent.
 */
export async function fetchWithRetry(
  fetchFn: FetchFn,
  url: string,
  init?: Parameters<FetchFn>[1],
  sleep: SleepFn = realSleep,
  delays: readonly number[] = CONTROL_PLANE_RETRY_DELAYS_MS,
): Promise<FetchResponse> {
  for (let attempt = 0; ; attempt += 1) {
    const delay = delays[attempt];
    try {
      const response = await fetchFn(url, init);
      if (!isRetryableStatus(response.status) || delay === undefined) return response;
    } catch (error) {
      if (delay === undefined) throw error;
    }
    await sleep(delay as number);
  }
}
