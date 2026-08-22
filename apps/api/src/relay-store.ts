import crypto from 'node:crypto';

// §14/§39 relay bearer-token registry.
//
// The relay authenticates with a bearer token minted at install time and
// presented on every /api/relay/* call. The actual command/result/health
// state now lives in Postgres (deployment_jobs / deployments — see server.ts)
// so this store's only remaining job is the token itself: it maps
// installationId -> the token the relay registered with, and verifies a
// presented token against it in constant time.
//
// In-memory is intentional for the MVP (same pattern as the GitHub
// installation store): tokens are re-registered whenever the relay
// (re)connects, so losing the map on process restart just means the relay's
// next heartbeat re-registers. Persisting a hash of the token instead of the
// plaintext would be the natural next step if this needs to survive restarts
// or run across multiple API instances — noted here rather than done, since
// nothing in this MVP requires it yet.

export interface RelayStore {
  register(installationId: string, token: string): void;
  /** Constant-time check that `token` matches the token registered for `installationId`. */
  verify(installationId: string, token: string): boolean;
}

export function createRelayStore(): RelayStore {
  const tokens = new Map<string, string>();

  return {
    register(installationId, token) {
      tokens.set(installationId, token);
    },

    verify(installationId, token) {
      const expected = tokens.get(installationId);
      if (!expected) return false;
      // timingSafeEqual throws on length mismatch, so guard it first — an
      // early-return on the wrong-length case must not itself become a
      // length-based timing oracle in practice, and this keeps it simple.
      const expectedBuf = Buffer.from(expected);
      const presentedBuf = Buffer.from(token);
      if (expectedBuf.length !== presentedBuf.length) return false;
      return crypto.timingSafeEqual(expectedBuf, presentedBuf);
    },
  };
}
