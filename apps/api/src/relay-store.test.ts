import { describe, expect, it } from 'vitest';

import { createRelayStore } from './relay-store.js';

describe('relay-store', () => {
  it('rejects an unknown installation', () => {
    const store = createRelayStore();
    expect(store.verify('inst-unknown', 'anything')).toBe(false);
  });

  it('accepts the exact token registered for an installation', () => {
    const store = createRelayStore();
    store.register('inst-1', 'secret-token-1');
    expect(store.verify('inst-1', 'secret-token-1')).toBe(true);
  });

  it('rejects a mismatched token for a known installation', () => {
    const store = createRelayStore();
    store.register('inst-1', 'secret-token-1');
    expect(store.verify('inst-1', 'wrong-token')).toBe(false);
  });

  it('rejects a token of a different length than the registered one', () => {
    const store = createRelayStore();
    store.register('inst-1', 'short');
    expect(store.verify('inst-1', 'a-much-longer-token-value')).toBe(false);
  });

  it('re-registering an installation rotates its token', () => {
    const store = createRelayStore();
    store.register('inst-1', 'token-a');
    store.register('inst-1', 'token-b');
    expect(store.verify('inst-1', 'token-a')).toBe(false);
    expect(store.verify('inst-1', 'token-b')).toBe(true);
  });

  it('keeps installations independent', () => {
    const store = createRelayStore();
    store.register('inst-1', 'token-1');
    store.register('inst-2', 'token-2');
    expect(store.verify('inst-1', 'token-2')).toBe(false);
    expect(store.verify('inst-2', 'token-1')).toBe(false);
    expect(store.verify('inst-1', 'token-1')).toBe(true);
    expect(store.verify('inst-2', 'token-2')).toBe(true);
  });
});
