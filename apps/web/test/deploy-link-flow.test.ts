import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchDeployLinkData } from '../src/lib/deploy-link-flow';

// Resolve-reason mapping for the /deploy page's invalid-link states. Every
// non-ok branch must map to one friendly reason without leaking which part
// failed; 5xx is "unavailable", never "invalid".

const PUBLIC_ID = 'b7e2a91c-1f3a-4c5d-8e9f-0a1b2c3d4e5f';
const TOKEN = 'a'.repeat(64);

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function errorResponse(status: number, code?: string): Response {
  return new Response(JSON.stringify(code ? { error: { code } } : {}), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchDeployLinkData', () => {
  it('returns the resolved payload on 200', async () => {
    const data = {
      link: { status: 'active' },
      application: { name: 'Acme Analytics' },
      customer: { name: 'Acme' },
      region: 'us-east-1',
      resources: ['Application runtime'],
      deploymentState: 'NOT_INSTALLED',
      bootstrapStackName: 'deployz-bootstrap-acme-1',
      waitingForRelay: false,
      relayStuck: false,
      quickCreateUrl: 'https://console.aws.amazon.com/cloudformation/link',
      domain: null,
      status: { stage: 'WAITING_FOR_AWS' },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse(data)),
    );

    const result = await fetchDeployLinkData(PUBLIC_ID, TOKEN);
    expect(result).toEqual({ ok: true, data });
  });

  it('maps 404, a missing token and unknown ids to plain "invalid"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => errorResponse(404)),
    );
    expect(await fetchDeployLinkData(PUBLIC_ID, TOKEN)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('maps 410 DEPLOY_LINK_EXPIRED to "expired"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => errorResponse(410, 'DEPLOY_LINK_EXPIRED')),
    );
    expect(await fetchDeployLinkData(PUBLIC_ID, TOKEN)).toEqual({ ok: false, reason: 'expired' });
  });

  it('maps 410 DEPLOY_LINK_REVOKED to "revoked"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => errorResponse(410, 'DEPLOY_LINK_REVOKED')),
    );
    expect(await fetchDeployLinkData(PUBLIC_ID, TOKEN)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('maps a server error to "unavailable" instead of claiming the link is invalid', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => errorResponse(503)),
    );
    expect(await fetchDeployLinkData(PUBLIC_ID, TOKEN)).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('sends the secret in the x-deployz-token header, never in the URL', async () => {
    const fetchMock = vi.fn(async () => errorResponse(404));
    vi.stubGlobal('fetch', fetchMock);

    await fetchDeployLinkData(PUBLIC_ID, TOKEN);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).not.toContain(TOKEN);
    expect((init.headers as Record<string, string>)['x-deployz-token']).toBe(TOKEN);
  });
});
