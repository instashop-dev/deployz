import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchInstallData } from '../src/lib/install-data';
import { fetchPublicInstallData } from '../src/lib/public-install-data';

// A customer opens an install link while the control plane is unhealthy. The
// lookup must say "error" — never "expired" or "not found" — so the page does
// not tell the customer a working link is dead.

const LINK_ID = '11111111-1111-1111-1111-111111111111';

function respond(status: number, body: unknown = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchInstallData', () => {
  it.each([500, 502, 503, 429])('maps %i to an error, not an expired link', async (status) => {
    respond(status, { error: { code: 'INTERNAL', message: 'Internal Server Error' } });
    await expect(fetchInstallData(LINK_ID)).resolves.toEqual({ status: 'error' });
  });

  it('maps a network failure to an error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(fetchInstallData(LINK_ID)).resolves.toEqual({ status: 'error' });
  });

  it('keeps 404 as not found', async () => {
    respond(404);
    await expect(fetchInstallData(LINK_ID)).resolves.toEqual({ status: 'not_found' });
  });

  it('keeps 410 as unavailable with the API code and message', async () => {
    respond(410, { error: { code: 'INSTALL_LINK_EXPIRED', message: 'This installation link has expired.' } });
    await expect(fetchInstallData(LINK_ID)).resolves.toEqual({
      status: 'unavailable',
      code: 'INSTALL_LINK_EXPIRED',
      message: 'This installation link has expired.',
    });
  });
});

describe('fetchPublicInstallData', () => {
  it.each([500, 503, 429])('maps %i to an error, not an unknown link', async (status) => {
    respond(status);
    await expect(fetchPublicInstallData(LINK_ID)).resolves.toEqual({ status: 'error' });
  });

  it('maps a network failure to an error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(fetchPublicInstallData(LINK_ID)).resolves.toEqual({ status: 'error' });
  });

  it('keeps 404 as an unknown link', async () => {
    respond(404);
    await expect(fetchPublicInstallData(LINK_ID)).resolves.toBeNull();
  });

  it('keeps 410 as gone with the API code', async () => {
    respond(410, { error: { code: 'PUBLIC_INSTALL_LINK_REVOKED' } });
    await expect(fetchPublicInstallData(LINK_ID)).resolves.toEqual({
      status: 'gone',
      code: 'PUBLIC_INSTALL_LINK_REVOKED',
    });
  });
});
