import { describe, expect, it } from 'vitest';

import { isPubliclyRoutableAddress } from './domain-check.js';

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
