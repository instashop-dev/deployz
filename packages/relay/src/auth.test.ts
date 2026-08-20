import { describe, expect, it, vi } from 'vitest';

import {
  buildAuthHeaders,
  createAuthState,
  decrementGrace,
  processRotationResponse,
  readCredential,
  registerInstallation,
  TOKEN_ROTATION_GRACE_POLLS,
  type AuthState,
  type FetchFn,
  type SecretsClient,
} from './auth.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSecretsClient(token: string): SecretsClient {
  return {
    async getSecretValue() {
      return { SecretString: JSON.stringify({ token }) };
    },
  };
}

function makeFetchFn(
  status: number,
  body: unknown = {},
): FetchFn {
  return async () => ({
    status,
    headers: { get: () => null },
    json: async () => body,
  });
}

// ── readCredential ───────────────────────────────────────────────────────────

describe('readCredential', () => {
  it('reads and parses the token from Secrets Manager', async () => {
    const client = makeSecretsClient('test-token-abc123');
    const token = await readCredential(client, 'arn:aws:secretsmanager:...');
    expect(token).toBe('test-token-abc123');
  });

  it('throws when SecretString is missing', async () => {
    const client: SecretsClient = {
      async getSecretValue() {
        return {};
      },
    };
    await expect(readCredential(client, 'arn:...')).rejects.toThrow('no SecretString');
  });

  it('throws when token field is missing', async () => {
    const client: SecretsClient = {
      async getSecretValue() {
        return { SecretString: '{}' };
      },
    };
    await expect(readCredential(client, 'arn:...')).rejects.toThrow('missing "token"');
  });

  it('throws when token is not a string', async () => {
    const client: SecretsClient = {
      async getSecretValue() {
        return { SecretString: '{"token":42}' };
      },
    };
    await expect(readCredential(client, 'arn:...')).rejects.toThrow('missing "token"');
  });

  it('throws on invalid JSON', async () => {
    const client: SecretsClient = {
      async getSecretValue() {
        return { SecretString: 'not-json' };
      },
    };
    await expect(readCredential(client, 'arn:...')).rejects.toThrow();
  });
});

// ── registerInstallation ─────────────────────────────────────────────────────

describe('registerInstallation', () => {
  it('returns true on HTTP 200', async () => {
    const fetchFn = makeFetchFn(200);
    const result = await registerInstallation(fetchFn, 'https://api.example.com', 'inst-1', 'tok');
    expect(result).toBe(true);
  });

  it('returns true on HTTP 201', async () => {
    const fetchFn = makeFetchFn(201);
    const result = await registerInstallation(fetchFn, 'https://api.example.com', 'inst-1', 'tok');
    expect(result).toBe(true);
  });

  it('returns false on HTTP 401', async () => {
    const fetchFn = makeFetchFn(401);
    const result = await registerInstallation(fetchFn, 'https://api.example.com', 'inst-1', 'tok');
    expect(result).toBe(false);
  });

  it('sends the installationId in the body', async () => {
    const spy = vi.fn<FetchFn>().mockResolvedValue({
      status: 200,
      headers: { get: () => null },
      json: async () => ({}),
    });

    await registerInstallation(spy, 'https://api.example.com', 'inst-xyz', 'tok-123');

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/api/relay/register');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toHaveProperty('Authorization', 'Bearer tok-123');
    expect(JSON.parse(init?.body ?? '{}')).toEqual({ installationId: 'inst-xyz' });
  });
});

// ── createAuthState ──────────────────────────────────────────────────────────

describe('createAuthState', () => {
  it('creates a fresh unregistered auth state', () => {
    const state = createAuthState('inst-1', 'tok-1');
    expect(state.installationId).toBe('inst-1');
    expect(state.token).toBe('tok-1');
    expect(state.registered).toBe(false);
    expect(state.oldToken).toBeUndefined();
    expect(state.gracePollsRemaining).toBe(0);
  });
});

// ── buildAuthHeaders ─────────────────────────────────────────────────────────

describe('buildAuthHeaders', () => {
  it('sends only the current token when not rotating', () => {
    const state = createAuthState('inst-1', 'tok-current');
    const headers = buildAuthHeaders(state);
    expect(headers.Authorization).toBe('Bearer tok-current');
    expect(headers['X-Deployz-Old-Token']).toBeUndefined();
  });

  it('sends both tokens during rotation grace window', () => {
    const state = createAuthState('inst-1', 'tok-new');
    state.oldToken = 'tok-old';
    state.gracePollsRemaining = 2;
    const headers = buildAuthHeaders(state);
    expect(headers.Authorization).toBe('Bearer tok-new');
    expect(headers['X-Deployz-Old-Token']).toBe('tok-old');
  });

  it('does not send old token after grace expires', () => {
    const state = createAuthState('inst-1', 'tok-new');
    state.oldToken = 'tok-old';
    state.gracePollsRemaining = 0;
    const headers = buildAuthHeaders(state);
    expect(headers.Authorization).toBe('Bearer tok-new');
    expect(headers['X-Deployz-Old-Token']).toBeUndefined();
  });
});

// ── Token rotation ───────────────────────────────────────────────────────────

describe('token rotation', () => {
  it('processRotationResponse starts rotation when new token header present', () => {
    const state = createAuthState('inst-1', 'tok-old');
    processRotationResponse(state, 'tok-new');

    expect(state.token).toBe('tok-new');
    expect(state.oldToken).toBe('tok-old');
    expect(state.gracePollsRemaining).toBe(TOKEN_ROTATION_GRACE_POLLS);
  });

  it('processRotationResponse is a no-op when header is null', () => {
    const state = createAuthState('inst-1', 'tok-current');
    processRotationResponse(state, null);

    expect(state.token).toBe('tok-current');
    expect(state.oldToken).toBeUndefined();
    expect(state.gracePollsRemaining).toBe(0);
  });

  it('collapses double rotation: old-old discarded, current becomes old', () => {
    const state = createAuthState('inst-1', 'tok-v2');
    state.oldToken = 'tok-v1';
    state.gracePollsRemaining = 1;

    // Another rotation arrives before grace expires.
    processRotationResponse(state, 'tok-v3');

    expect(state.token).toBe('tok-v3');
    expect(state.oldToken).toBe('tok-v2'); // v1 discarded, v2 becomes old
    expect(state.gracePollsRemaining).toBe(TOKEN_ROTATION_GRACE_POLLS);
  });

  it('decrementGrace counts down and discards old token at zero', () => {
    const state = createAuthState('inst-1', 'tok-new');
    state.oldToken = 'tok-old';
    state.gracePollsRemaining = 2;

    decrementGrace(state);
    expect(state.gracePollsRemaining).toBe(1);
    expect(state.oldToken).toBe('tok-old'); // still present

    decrementGrace(state);
    expect(state.gracePollsRemaining).toBe(0);
    expect(state.oldToken).toBeUndefined(); // discarded

    // Idempotent at zero.
    decrementGrace(state);
    expect(state.gracePollsRemaining).toBe(0);
    expect(state.oldToken).toBeUndefined();
  });

  it('full rotation lifecycle: old accepted during grace, rejected after', () => {
    const state = createAuthState('inst-1', 'tok-v1');

    // Rotation triggered.
    processRotationResponse(state, 'tok-v2');
    expect(state.token).toBe('tok-v2');
    expect(state.oldToken).toBe('tok-v1');
    expect(state.gracePollsRemaining).toBe(TOKEN_ROTATION_GRACE_POLLS);

    // During grace: both tokens in headers.
    let headers = buildAuthHeaders(state);
    expect(headers.Authorization).toBe('Bearer tok-v2');
    expect(headers['X-Deployz-Old-Token']).toBe('tok-v1');

    // Exhaust grace.
    for (let i = 0; i < TOKEN_ROTATION_GRACE_POLLS; i++) {
      decrementGrace(state);
    }

    // After grace: only new token.
    headers = buildAuthHeaders(state);
    expect(headers.Authorization).toBe('Bearer tok-v2');
    expect(headers['X-Deployz-Old-Token']).toBeUndefined();
    expect(state.oldToken).toBeUndefined();
  });
});