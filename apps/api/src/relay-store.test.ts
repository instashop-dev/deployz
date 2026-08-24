import { describe, expect, it } from 'vitest';

import {
  hashRelayToken,
  mintEnrollmentCode,
  verifyRelayToken,
  verifyRelayTokenWithRotation,
} from './relay-store.js';

describe('relay token binding', () => {
  it('rejects an installation that has never bound a token', () => {
    expect(verifyRelayToken(null, 'anything')).toBe(false);
  });

  it('accepts the exact token that was bound', () => {
    expect(verifyRelayToken(hashRelayToken('secret-token-1'), 'secret-token-1')).toBe(true);
  });

  it('rejects a mismatched token', () => {
    expect(verifyRelayToken(hashRelayToken('secret-token-1'), 'wrong-token')).toBe(false);
  });

  it('rejects a token of a different length than the one bound', () => {
    expect(verifyRelayToken(hashRelayToken('short'), 'a-much-longer-token-value')).toBe(false);
  });

  it('keeps installations independent', () => {
    const first = hashRelayToken('token-1');
    const second = hashRelayToken('token-2');
    expect(verifyRelayToken(first, 'token-2')).toBe(false);
    expect(verifyRelayToken(second, 'token-1')).toBe(false);
    expect(verifyRelayToken(first, 'token-1')).toBe(true);
    expect(verifyRelayToken(second, 'token-2')).toBe(true);
  });

  it('never stores the token itself', () => {
    const hash = hashRelayToken('secret-token-1');
    expect(hash).not.toContain('secret-token-1');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('rotation grace', () => {
  // The relay adopts a new token and keeps sending the old one for a few
  // polls (packages/relay/src/auth.ts). Both have to authenticate during that
  // window or a rotating relay locks itself out.
  it('accepts the current token', () => {
    const bound = hashRelayToken('token-new');
    expect(verifyRelayTokenWithRotation(bound, 'token-new', 'token-old')).toBe(true);
  });

  it('accepts the previous token while it is still being sent', () => {
    const bound = hashRelayToken('token-old');
    expect(verifyRelayTokenWithRotation(bound, 'token-new', 'token-old')).toBe(true);
  });

  it('rejects when neither token matches', () => {
    const bound = hashRelayToken('token-bound');
    expect(verifyRelayTokenWithRotation(bound, 'token-new', 'token-old')).toBe(false);
  });

  it('rejects when there is no old token to fall back on', () => {
    const bound = hashRelayToken('token-bound');
    expect(verifyRelayTokenWithRotation(bound, 'token-other', undefined)).toBe(false);
  });
});

describe('enrollment codes', () => {
  it('mints a long random hex code', () => {
    expect(mintEnrollmentCode()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never repeats', () => {
    const codes = new Set(Array.from({ length: 100 }, () => mintEnrollmentCode()));
    expect(codes.size).toBe(100);
  });
});
