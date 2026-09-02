import { describe, expect, it } from 'vitest';

import { probeHealthUrl, type HttpProbeFetch } from './http-probe.js';

function fetchReturning(status: number): HttpProbeFetch {
  return async () => ({ status });
}

describe('probeHealthUrl', () => {
  it('records a 2xx as ok with its status code and latency', async () => {
    const record = await probeHealthUrl(fetchReturning(200), 'http://alb.example/health');
    expect(record.ok).toBe(true);
    expect(record.statusCode).toBe(200);
    expect(record.latencyMs).toBeGreaterThanOrEqual(0);
    expect(record.checkedAt).toBeTruthy();
    expect(record.error).toBeUndefined();
  });

  it('records a non-2xx as a failed check with its status code', async () => {
    const record = await probeHealthUrl(fetchReturning(503), 'http://alb.example/health');
    expect(record.ok).toBe(false);
    expect(record.statusCode).toBe(503);
    expect(record.error).toBeUndefined();
  });

  it('records a transport failure as a failed check with no status code', async () => {
    const record = await probeHealthUrl(
      async () => {
        throw new Error('getaddrinfo ENOTFOUND alb.example');
      },
      'http://alb.example/health',
    );
    expect(record.ok).toBe(false);
    expect(record.statusCode).toBeNull();
    expect(record.error).toContain('ENOTFOUND');
  });

  it('never reads the response body — a bodyless response is enough', async () => {
    // The fake response has no json()/text(): the probe must not ask for one.
    const record = await probeHealthUrl(
      async () => ({ status: 200 }) as { status: number },
      'http://alb.example/health',
    );
    expect(record.ok).toBe(true);
  });

  it('a timed-out probe is a failed check, not an UNKNOWN', async () => {
    const record = await probeHealthUrl(
      () => new Promise<{ status: number }>(() => {}),
      'http://alb.example/health',
      () => new Date().toISOString(),
      5,
    );
    expect(record.ok).toBe(false);
    expect(record.statusCode).toBeNull();
    expect(record.error).toContain('timed out');
  });
});
