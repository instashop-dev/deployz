import { describe, expect, it } from 'vitest';

import { normalizeHostname, validateHostname } from './domain-validation.js';

describe('normalizeHostname', () => {
  it('lowercases, trims, and strips a trailing dot', () => {
    expect(normalizeHostname('  App.Example.COM. ')).toBe('app.example.com');
  });
});

describe('validateHostname', () => {
  const ok = (h: string) => expect(validateHostname(h)).toEqual({ ok: true });
  const code = (h: string) => {
    const r = validateHostname(h);
    return r.ok ? 'OK' : r.code;
  };

  it('accepts a plain subdomain', () => ok('app.example.com'));
  it('accepts a deep subdomain', () => ok('a.b.example.com'));
  it('accepts a subdomain of a multi-part suffix', () => ok('app.example.co.uk'));

  it('rejects https URLs as URL_ENTERED', () =>
    expect(code('https://app.example.com')).toBe('URL_ENTERED'));
  it('rejects http URLs as URL_ENTERED', () =>
    expect(code('http://app.example.com')).toBe('URL_ENTERED'));
  it('rejects paths as URL_ENTERED', () => expect(code('app.example.com/login')).toBe('URL_ENTERED'));
  it('rejects ports as URL_ENTERED', () => expect(code('app.example.com:8443')).toBe('URL_ENTERED'));

  it('rejects the empty string', () => expect(code('')).toBe('INVALID_DOMAIN'));
  it('rejects single labels', () => expect(code('localhost')).toBe('INVALID_DOMAIN'));
  it('rejects IPv4 addresses', () => expect(code('192.168.0.10')).toBe('INVALID_DOMAIN'));
  it('rejects IPv6 addresses', () => expect(code('::1')).toBe('URL_ENTERED'));
  it('rejects underscores and bad chars', () => expect(code('app_1.example.com')).toBe('INVALID_DOMAIN'));
  it('rejects labels over 63 chars', () => expect(code(`${'a'.repeat(64)}.example.com`)).toBe('INVALID_DOMAIN'));
  it('rejects hostnames over 253 chars', () =>
    expect(code(`${'a.'.repeat(127)}example.com`)).toBe('INVALID_DOMAIN'));
  it('rejects hyphen-edged labels', () => expect(code('-app.example.com')).toBe('INVALID_DOMAIN'));
  it('rejects Deployz-owned hostnames', () => expect(code('evil.deployz.dev')).toBe('INVALID_DOMAIN'));
  it('rejects AWS-internal hostnames', () =>
    expect(code('foo.us-east-1.elb.amazonaws.com')).toBe('INVALID_DOMAIN'));
  it('rejects acm-validations hostnames', () =>
    expect(code('x.acm-validations.aws')).toBe('INVALID_DOMAIN'));

  it('rejects apex domains as ROOT_DOMAIN', () => expect(code('example.com')).toBe('ROOT_DOMAIN'));
  it('rejects multi-part-suffix apexes as ROOT_DOMAIN', () =>
    expect(code('example.co.uk')).toBe('ROOT_DOMAIN'));

  it('rejects wildcards as WILDCARD_NOT_SUPPORTED', () =>
    expect(code('*.example.com')).toBe('WILDCARD_NOT_SUPPORTED'));
});
