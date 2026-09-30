import { describe, expect, it } from 'vitest';

import type { FetchFn } from './auth.js';
import { fetchWithRetry, isRetryableStatus } from './retry.js';

type Response = Awaited<ReturnType<FetchFn>>;
const respond = (status: number): Response => ({ status, headers: { get: () => null }, json: async () => ({}) });

function scripted(steps: (number | Error)[]) {
  const calls: number[] = [];
  const fetchFn: FetchFn = async () => {
    const step = steps[calls.length] ?? 200;
    calls.push(calls.length);
    if (step instanceof Error) throw step;
    return respond(step);
  };
  return { fetchFn, calls };
}

const waits: number[] = [];
const sleep = async (ms: number) => {
  waits.push(ms);
};

describe('fetchWithRetry', () => {
  it('classifies throttling and server errors as retryable, client errors as final', () => {
    expect([429, 500, 502, 503, 504].every(isRetryableStatus)).toBe(true);
    expect([200, 201, 400, 401, 404, 409].some(isRetryableStatus)).toBe(false);
  });

  it('retries a 503 and a network error with backoff, then returns the success', async () => {
    waits.length = 0;
    const { fetchFn, calls } = scripted([503, new Error('socket hang up'), 200]);
    const response = await fetchWithRetry(fetchFn, 'https://cp/x', undefined, sleep, [10, 20, 30]);
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([10, 20]);
  });

  it('does not retry a client error', async () => {
    waits.length = 0;
    const { fetchFn, calls } = scripted([404]);
    expect((await fetchWithRetry(fetchFn, 'https://cp/x', undefined, sleep, [10])).status).toBe(404);
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('returns the last failing response, or rethrows the last error, once the delays are spent', async () => {
    const tooBusy = scripted([429, 429, 429]);
    expect((await fetchWithRetry(tooBusy.fetchFn, 'u', undefined, sleep, [1, 1])).status).toBe(429);
    expect(tooBusy.calls).toHaveLength(3);

    const down = scripted([new Error('a'), new Error('b')]);
    await expect(fetchWithRetry(down.fetchFn, 'u', undefined, sleep, [1])).rejects.toThrow('b');
  });
});
