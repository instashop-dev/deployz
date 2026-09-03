import { describe, expect, it } from 'vitest';

import { createRealDomainCheckDeps, isPubliclyRoutableAddress } from './domain-check.js';

// SSRF hardening for `probeHttps`: before fetching a customer's hostname, we
// resolve it ourselves and refuse to proceed if any answer lands in a
// private/reserved range. This is the pure classifier that decision rests
// on — no network I/O here.
describe('isPubliclyRoutableAddress', () => {
  it('accepts a public IPv4 address', () => {
    expect(isPubliclyRoutableAddress('93.184.216.34')).toBe(true);
  });

  it('accepts a public IPv6 address', () => {
    expect(isPubliclyRoutableAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(true);
  });

  it('rejects an invalid/garbage string', () => {
    expect(isPubliclyRoutableAddress('not-an-ip')).toBe(false);
  });

  describe('IPv4 reserved ranges', () => {
    it('rejects "this network" 0.0.0.0/8', () => {
      expect(isPubliclyRoutableAddress('0.0.0.1')).toBe(false);
    });

    it('rejects RFC1918 10.0.0.0/8', () => {
      expect(isPubliclyRoutableAddress('10.0.0.1')).toBe(false);
    });

    it('rejects carrier-grade NAT 100.64.0.0/10', () => {
      expect(isPubliclyRoutableAddress('100.64.0.1')).toBe(false);
    });

    it('rejects loopback 127.0.0.0/8', () => {
      expect(isPubliclyRoutableAddress('127.0.0.1')).toBe(false);
    });

    it('rejects link-local 169.254.0.0/16 (cloud metadata range)', () => {
      expect(isPubliclyRoutableAddress('169.254.169.254')).toBe(false);
    });

    it('rejects RFC1918 192.168.0.0/16', () => {
      expect(isPubliclyRoutableAddress('192.168.1.1')).toBe(false);
    });

    it('rejects multicast 224.0.0.0/4', () => {
      expect(isPubliclyRoutableAddress('224.0.0.1')).toBe(false);
    });

    it('rejects reserved 240.0.0.0/4 and the broadcast address', () => {
      expect(isPubliclyRoutableAddress('240.0.0.1')).toBe(false);
      expect(isPubliclyRoutableAddress('255.255.255.255')).toBe(false);
    });

    // The octet-parsing trap: a naive string-prefix check like
    // `hostname.startsWith('172.16')` or a loose regex would misclassify
    // 172.160.x.x (a public address) as being inside 172.16.0.0/12. Numeric
    // octet parsing must get all three of these right.
    it('accepts 172.15.255.255 (just below the RFC1918 172.16.0.0/12 block)', () => {
      expect(isPubliclyRoutableAddress('172.15.255.255')).toBe(true);
    });

    it('rejects 172.16.0.0 (start of the RFC1918 172.16.0.0/12 block)', () => {
      expect(isPubliclyRoutableAddress('172.16.0.0')).toBe(false);
    });

    it('accepts 172.160.1.1 (public — not inside 172.16.0.0/12)', () => {
      expect(isPubliclyRoutableAddress('172.160.1.1')).toBe(true);
    });
  });

  describe('IPv6 reserved ranges', () => {
    it('rejects the unspecified address ::', () => {
      expect(isPubliclyRoutableAddress('::')).toBe(false);
    });

    it('rejects the loopback address ::1', () => {
      expect(isPubliclyRoutableAddress('::1')).toBe(false);
    });

    it('rejects unique local fc00::/7', () => {
      expect(isPubliclyRoutableAddress('fc00::1')).toBe(false);
    });

    it('rejects link-local fe80::/10', () => {
      expect(isPubliclyRoutableAddress('fe80::1')).toBe(false);
    });

    it('rejects multicast ff00::/8', () => {
      expect(isPubliclyRoutableAddress('ff02::1')).toBe(false);
    });

    it('rejects documentation range 2001:db8::/32', () => {
      expect(isPubliclyRoutableAddress('2001:db8::1')).toBe(false);
    });

    it('rejects an IPv4-mapped private address ::ffff:10.0.0.1', () => {
      expect(isPubliclyRoutableAddress('::ffff:10.0.0.1')).toBe(false);
    });

    it('accepts an IPv4-mapped public address ::ffff:93.184.216.34', () => {
      expect(isPubliclyRoutableAddress('::ffff:93.184.216.34')).toBe(true);
    });

    it('rejects a NAT64-mapped private address 64:ff9b::10.0.0.1', () => {
      expect(isPubliclyRoutableAddress('64:ff9b::10.0.0.1')).toBe(false);
    });
  });
});

// Phase 13 — the real HTTPS probe's SSRF posture, exercised with injected
// lookup/fetch seams (never real network): it refuses non-routable targets
// before any fetch, never follows a redirect (redirect:'manual' — at most 0
// hops, well inside the 2-hop bound), and always sends an abort timeout.
describe('probeHttps — SSRF and transport bounds (Phase 13)', () => {
  const lookupAddresses = (addresses: string[]) => async () => {
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })) as Awaited<
      ReturnType<typeof import('node:dns/promises')['lookup']>
    >;
  };

  function depsWithFetch(fetchImpl: (url: string, init: RequestInit) => Promise<Response>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const deps = createRealDomainCheckDeps({
      lookupFn: (lookupAddresses(['93.184.216.34'])) as never,
      fetchFn: async (url, init) => {
        calls.push({ url: String(url), init });
        return fetchImpl(String(url), init);
      },
    });
    return { deps, calls };
  }

  it('refuses a private/metadata target before any fetch happens', async () => {
    let fetched = false;
    const deps = createRealDomainCheckDeps({
      lookupFn: (async () => [{ address: '169.254.169.254', family: 4 }]) as never,
      fetchFn: async () => {
        fetched = true;
        throw new Error('must never be reached');
      },
    });

    const result = await deps.probeHttps('d-customer.deployz.dev');
    expect(result).toEqual({ ok: false, reason: 'HTTPS_NOT_REACHABLE' });
    expect(fetched).toBe(false);
  });

  it('refuses an unresolvable hostname without a fetch', async () => {
    let fetched = false;
    const deps = createRealDomainCheckDeps({
      lookupFn: (async () => {
        throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      }) as never,
      fetchFn: async () => {
        fetched = true;
        throw new Error('must never be reached');
      },
    });

    const result = await deps.probeHttps('d-customer.deployz.dev');
    expect(result).toEqual({ ok: false, reason: 'HTTPS_NOT_REACHABLE' });
    expect(fetched).toBe(false);
  });

  it('probes the https URL with redirect manual and an abort timeout, treating any response as healthy', async () => {
    const { deps, calls } = depsWithFetch(async () => new Response('ok', { status: 404 }));

    const result = await deps.probeHttps('d-customer.deployz.dev');

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://d-customer.deployz.dev/');
    expect(calls[0]!.init.method).toBe('GET');
    // redirect:'manual' — the probe never follows a Location header, so a
    // hostile redirect cannot steer a second request at an internal host.
    expect(calls[0]!.init.redirect).toBe('manual');
    // AbortSignal.timeout caps the whole attempt.
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });
});
