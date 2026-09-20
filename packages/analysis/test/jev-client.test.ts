import { afterEach, describe, expect, it, vi } from 'vitest';

import { createJevCircuitBreaker } from '../src/jev/circuit-breaker.js';
import { createJevClient, type JevClientConfig } from '../src/jev/client.js';
import { JevError } from '../src/jev/errors.js';
import { createFixtureJevClient } from '../src/jev/fixture.js';
import type { JevQuestion } from '../src/jev/schemas.js';

// ==========================================================================
// Test helpers — an injectable fetch that records the request and replays a
// scripted response sequence. Nothing here touches the network.
// ==========================================================================

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const config: JevClientConfig = {
  // Trailing slash on purpose: the client must strip it before joining
  // /v1/systemone.
  baseUrl: 'https://gateway.ai.cloudflare.com/v1/acct-123/gw-456/custom-typesafe-ai/',
  apiKey: 'jev-key-aaa',
  model: 'jev-test',
  gatewayToken: 'gateway-token-bbb',
};

const state = { service: 'api', region: 'us-east-1' };

const questions: Record<string, JevQuestion> = {
  isReady: {
    type: 'noul',
    instructions: 'Is the service ready for production?',
    criteria: { true: 'ready', false: 'not ready' },
  },
  tier: {
    type: 'choice',
    instructions: 'Which support tier fits?',
    criteria: { gold: 'premium support', silver: null },
  },
  risk: {
    type: 'score',
    instructions: ['Rate the rollout risk.', 'Consider the blast radius.'],
    criteria: ['low', 'medium', 'high'],
  },
};

const successBody = {
  model: 'jev-test',
  answers: {
    isReady: { type: 'noul', noul: 0.87 },
    tier: {
      type: 'choice',
      choice: 'gold',
      probabilities: { gold: 0.7, silver: 0.3 },
      confidence: 0.7,
    },
    risk: {
      type: 'score',
      score: 2,
      legend: { '0': 'low', '1': 'medium', '2': 'high' },
      probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 },
      confidence: 0.9,
    },
  },
  usage: { input_tokens: 12, output_tokens: 34 },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Records every request and always answers with a 200 success body. */
function recordingFetch(recorded: RecordedRequest[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    recorded.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    return jsonResponse(200, successBody);
  }) as typeof fetch;
}

/** A fetch stub whose responses are scripted call-by-call. */
function scriptedFetch(script: Array<() => Response>): {
  fetchFn: typeof fetch;
  callCount: () => number;
} {
  let calls = 0;
  const fetchFn = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const index = calls;
    calls += 1;
    const make = script[index] ?? script[script.length - 1];
    if (!make) throw new Error('scriptedFetch: no response scripted');
    return make();
  }) as typeof fetch;
  return { fetchFn, callCount: () => calls };
}

const noSleep = async (): Promise<void> => {};

afterEach(() => {
  vi.restoreAllMocks();
});

// ==========================================================================
// Endpoint, headers, request body
// ==========================================================================

describe('createJevClient — endpoint and headers', () => {
  it('posts to /v1/systemone with the trailing slash stripped from the base URL', async () => {
    const recorded: RecordedRequest[] = [];
    const client = createJevClient({ ...config, fetchImpl: recordingFetch(recorded) });

    await client.evaluate(state, questions, { label: 'test' });

    expect(recorded[0]?.url).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct-123/gw-456/custom-typesafe-ai/v1/systemone',
    );
    expect(recorded[0]?.method).toBe('POST');
  });

  it('sends the API key as the Authorization bearer', async () => {
    const recorded: RecordedRequest[] = [];
    const client = createJevClient({ ...config, fetchImpl: recordingFetch(recorded) });

    await client.evaluate(state, questions, { label: 'test' });

    expect(recorded[0]?.headers['authorization']).toBe('Bearer jev-key-aaa');
    expect(recorded[0]?.headers['content-type']).toBe('application/json');
  });

  it('sends the gateway token on cf-aig-authorization when configured', async () => {
    const recorded: RecordedRequest[] = [];
    const client = createJevClient({ ...config, fetchImpl: recordingFetch(recorded) });

    await client.evaluate(state, questions, { label: 'test' });

    expect(recorded[0]?.headers['cf-aig-authorization']).toBe('Bearer gateway-token-bbb');
  });

  it('omits cf-aig-authorization entirely when no gateway token is set', async () => {
    // An unauthenticated gateway 401s on a cf-aig-authorization header it
    // cannot validate, so an absent token must mean an absent header — not an
    // empty or bogus one.
    const recorded: RecordedRequest[] = [];
    const client = createJevClient({
      ...config,
      gatewayToken: undefined,
      fetchImpl: recordingFetch(recorded),
    });

    await client.evaluate(state, questions, { label: 'test' });

    expect(recorded[0]?.headers).not.toHaveProperty('cf-aig-authorization');
    expect(recorded[0]?.headers['authorization']).toBe('Bearer jev-key-aaa');
  });

  it('sends { state, model, questions } as the request body', async () => {
    const recorded: RecordedRequest[] = [];
    const client = createJevClient({ ...config, fetchImpl: recordingFetch(recorded) });

    await client.evaluate(state, questions, { label: 'test' });

    expect(recorded[0]?.body).toEqual({ state, model: 'jev-test', questions });
  });
});

// ==========================================================================
// Success
// ==========================================================================

describe('createJevClient — success', () => {
  it('parses all three answer types', async () => {
    const client = createJevClient({ ...config, fetchImpl: recordingFetch([]) });

    const result = await client.evaluate(state, questions, { label: 'test' });

    expect(result.answers.isReady).toEqual({ type: 'noul', noul: 0.87 });
    expect(result.answers.tier).toEqual({
      type: 'choice',
      choice: 'gold',
      probabilities: { gold: 0.7, silver: 0.3 },
      confidence: 0.7,
    });
    expect(result.answers.risk).toEqual({
      type: 'score',
      score: 2,
      legend: { '0': 'low', '1': 'medium', '2': 'high' },
      probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 },
      confidence: 0.9,
    });
  });

  it('returns the model, usage, latency, and attempt count', async () => {
    const client = createJevClient({ ...config, fetchImpl: recordingFetch([]) });

    const result = await client.evaluate(state, questions, { label: 'test' });

    expect(result.model).toBe('jev-test');
    expect(result.usage).toEqual({ input_tokens: 12, output_tokens: 34 });
    // Absent extras stay valid: no id/provider/usage cost in the canned body.
    expect(result.usageCost).toBeUndefined();
    expect(result.attempts).toBe(1);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns and logs the usage cost when the response carries one, echoing the resolved model', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { fetchFn } = scriptedFetch([
      () =>
        jsonResponse(200, {
          id: 'gen-dec-test',
          provider: 'TypeSafe',
          // TypeSafe resolves the jev-latest alias to the versioned id.
          model: 'jev-1.13-20260917',
          answers: successBody.answers,
          usage: { input_tokens: 12, output_tokens: 34, cost: 0.000126 },
        }),
    ]);
    const client = createJevClient({ ...config, fetchImpl: fetchFn });

    const result = await client.evaluate(state, questions, { label: 'cost-test' });

    // The RESOLVED versioned id, never the requested model alias.
    expect(result.model).toBe('jev-1.13-20260917');
    expect(result.usageCost).toBe(0.000126);
    const line = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(line.costUsd).toBe(0.000126);
  });
});

// ==========================================================================
// Non-retryable failures
// ==========================================================================

describe('createJevClient — non-retryable failures', () => {
  it('maps 401 to unauthorized and does not retry', async () => {
    const { fetchFn, callCount } = scriptedFetch([
      () => jsonResponse(401, { error: 'unauthorized' }),
    ]);
    const client = createJevClient({ ...config, fetchImpl: fetchFn, sleep: noSleep });

    await expect(client.evaluate(state, questions, { label: 'test' })).rejects.toMatchObject({
      kind: 'unauthorized',
      status: 401,
    });
    expect(callCount()).toBe(1);
  });

  it('maps 422 to validation and does not retry', async () => {
    const { fetchFn, callCount } = scriptedFetch([
      () => jsonResponse(422, { error: 'validation' }),
    ]);
    const client = createJevClient({ ...config, fetchImpl: fetchFn, sleep: noSleep });

    await expect(client.evaluate(state, questions, { label: 'test' })).rejects.toMatchObject({
      kind: 'validation',
      status: 422,
    });
    expect(callCount()).toBe(1);
  });

  it('classifies a schema-invalid body as malformed with exactly one attempt', async () => {
    const { fetchFn, callCount } = scriptedFetch([
      () => jsonResponse(200, { model: 'jev-test', answers: {} }),
    ]);
    const client = createJevClient({ ...config, fetchImpl: fetchFn, sleep: noSleep });

    const error: unknown = await client
      .evaluate(state, questions, { label: 'test' })
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

    expect(error).toBeInstanceOf(JevError);
    expect((error as JevError).kind).toBe('malformed');
    expect((error as JevError).attempts).toBe(1);
    expect(callCount()).toBe(1);
  });

  it('classifies a non-JSON body as malformed with exactly one attempt', async () => {
    const { fetchFn, callCount } = scriptedFetch([
      () => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }),
    ]);
    const client = createJevClient({ ...config, fetchImpl: fetchFn, sleep: noSleep });

    await expect(client.evaluate(state, questions, { label: 'test' })).rejects.toMatchObject({
      kind: 'malformed',
    });
    expect(callCount()).toBe(1);
  });

  it('still rejects an unknown top-level key as malformed', async () => {
    const { fetchFn, callCount } = scriptedFetch([
      () => jsonResponse(200, { ...successBody, extra: 'not part of the contract' }),
    ]);
    const client = createJevClient({ ...config, fetchImpl: fetchFn, sleep: noSleep });

    await expect(client.evaluate(state, questions, { label: 'test' })).rejects.toMatchObject({
      kind: 'malformed',
    });
    expect(callCount()).toBe(1);
  });
});

// ==========================================================================
// Retry — 429/529/network/timeout are retried with a fixed backoff
// ==========================================================================

describe('createJevClient — retry', () => {
  it('retries a 429 and succeeds on the second attempt', async () => {
    const { fetchFn, callCount } = scriptedFetch([
      () => jsonResponse(429, { error: 'rate limited' }),
      () => jsonResponse(200, successBody),
    ]);
    const client = createJevClient({ ...config, fetchImpl: fetchFn, sleep: noSleep });

    const result = await client.evaluate(state, questions, { label: 'test' });

    expect(result.attempts).toBe(2);
    expect(result.answers.isReady).toEqual({ type: 'noul', noul: 0.87 });
    expect(callCount()).toBe(2);
  });

  it('retries a 529 (overloaded) and succeeds on the second attempt', async () => {
    const { fetchFn, callCount } = scriptedFetch([
      () => jsonResponse(529, { error: 'overloaded' }),
      () => jsonResponse(200, successBody),
    ]);
    const client = createJevClient({ ...config, fetchImpl: fetchFn, sleep: noSleep });

    const result = await client.evaluate(state, questions, { label: 'test' });

    expect(result.attempts).toBe(2);
    expect(callCount()).toBe(2);
  });

  it('retries a network failure and succeeds on the second attempt', async () => {
    const { fetchFn, callCount } = scriptedFetch([
      () => {
        throw new TypeError('fetch failed');
      },
      () => jsonResponse(200, successBody),
    ]);
    const client = createJevClient({ ...config, fetchImpl: fetchFn, sleep: noSleep });

    const result = await client.evaluate(state, questions, { label: 'test' });

    expect(result.attempts).toBe(2);
    expect(callCount()).toBe(2);
  });

  it('waits the fixed backoff between attempts', async () => {
    const { fetchFn } = scriptedFetch([
      () => jsonResponse(429, { error: 'rate limited' }),
      () => jsonResponse(200, successBody),
    ]);
    const sleeps: number[] = [];
    const client = createJevClient({
      ...config,
      fetchImpl: fetchFn,
      backoffMs: 500,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await client.evaluate(state, questions, { label: 'test' });

    expect(sleeps).toEqual([500]);
  });

  it('classifies a never-resolving fetch as timeout once the per-attempt budget expires', async () => {
    // Never resolves on its own: the ONLY way out is the per-attempt abort,
    // so a timeout that fails to reach fetch shows up as a hang, not a pass.
    const hangingFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        const abort = (): void => reject(new DOMException('Aborted', 'AbortError'));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort);
      })) as typeof fetch;
    const client = createJevClient({
      ...config,
      fetchImpl: hangingFetch,
      timeoutMs: 10,
      maxAttempts: 1,
    });

    await expect(client.evaluate(state, questions, { label: 'test' })).rejects.toMatchObject({
      kind: 'timeout',
    });
  });
});

// ==========================================================================
// Circuit breaker
// ==========================================================================

describe('createJevClient — circuit breaker', () => {
  it('short-circuits with breaker-open after the failure threshold, with zero fetches', async () => {
    const { fetchFn, callCount } = scriptedFetch([
      () => jsonResponse(500, { error: 'server error' }),
    ]);
    const breaker = createJevCircuitBreaker({ failureThreshold: 2 });
    const client = createJevClient({ ...config, fetchImpl: fetchFn, sleep: noSleep, maxAttempts: 1, breaker });

    await expect(client.evaluate(state, questions, { label: 'test' })).rejects.toMatchObject({
      kind: 'gateway-error',
    });
    await expect(client.evaluate(state, questions, { label: 'test' })).rejects.toMatchObject({
      kind: 'gateway-error',
    });
    await expect(client.evaluate(state, questions, { label: 'test' })).rejects.toMatchObject({
      kind: 'breaker-open',
      attempts: 0,
    });
    expect(callCount()).toBe(2);
  });

  it('allows one probe after the bypass window and closes on its success', async () => {
    let clock = 1_000;
    let fail = true;
    const fetchFn = (async () =>
      fail ? jsonResponse(500, { error: 'server error' }) : jsonResponse(200, successBody)) as typeof fetch;
    const breaker = createJevCircuitBreaker({
      failureThreshold: 2,
      bypassDurationMs: 10_000,
      now: () => clock,
    });
    const client = createJevClient({ ...config, fetchImpl: fetchFn, sleep: noSleep, maxAttempts: 1, breaker });

    await expect(client.evaluate(state, questions, { label: 'test' })).rejects.toMatchObject({
      kind: 'gateway-error',
    });
    await expect(client.evaluate(state, questions, { label: 'test' })).rejects.toMatchObject({
      kind: 'gateway-error',
    });
    await expect(client.evaluate(state, questions, { label: 'test' })).rejects.toMatchObject({
      kind: 'breaker-open',
    });

    // Bypass window elapsed → the breaker allows exactly one probe.
    clock += 10_001;
    fail = false;
    const probe = await client.evaluate(state, questions, { label: 'probe' });
    expect(probe.attempts).toBe(1);

    // The probe's success reset the breaker: a single later failure must NOT
    // re-open it (threshold 2), so the next evaluate still reaches fetch.
    fail = true;
    await expect(client.evaluate(state, questions, { label: 'test' })).rejects.toMatchObject({
      kind: 'gateway-error',
    });
    fail = false;
    const after = await client.evaluate(state, questions, { label: 'test' });
    expect(after.attempts).toBe(1);
  });
});

// ==========================================================================
// The structured log line — one JSON line per evaluate, never any payload
// ==========================================================================

describe('createJevClient — structured log line', () => {
  it('logs one line with label/model/latency/attempts/usage on success', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = createJevClient({ ...config, fetchImpl: recordingFetch([]) });

    await client.evaluate({ summary: 'STATE-SENTINEL' }, { q1: { type: 'noul', instructions: 'QUESTION-SENTINEL' } }, { label: 'log-test' });

    expect(log).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(line).toMatchObject({
      jev: 'log-test',
      model: 'jev-test',
      ok: true,
      attempts: 1,
      inputTokens: 12,
      outputTokens: 34,
    });
    expect(typeof line.latencyMs).toBe('number');

    const raw = JSON.stringify(log.mock.calls[0] ?? []);
    expect(raw).not.toContain('STATE-SENTINEL');
    expect(raw).not.toContain('QUESTION-SENTINEL');
    expect(raw).not.toContain('jev-key-aaa');
    expect(raw).not.toContain('gateway-token-bbb');
  });

  it('logs one line with the error kind on failure, still without payload', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { fetchFn } = scriptedFetch([() => jsonResponse(401, { error: 'unauthorized' })]);
    const client = createJevClient({ ...config, fetchImpl: fetchFn, sleep: noSleep });

    await expect(
      client.evaluate({ summary: 'STATE-SENTINEL' }, questions, { label: 'log-fail' }),
    ).rejects.toMatchObject({ kind: 'unauthorized' });

    expect(log).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(line).toMatchObject({
      jev: 'log-fail',
      model: 'jev-test',
      ok: false,
      attempts: 1,
      error: 'unauthorized',
    });
    expect(String(log.mock.calls[0]?.[0])).not.toContain('STATE-SENTINEL');
  });
});

// ==========================================================================
// Fixture client
// ==========================================================================

describe('createFixtureJevClient', () => {
  it('returns the canned answers for the label, with zero network', async () => {
    const client = createFixtureJevClient({
      'shadow-check': {
        answers: { isReady: { type: 'noul', noul: 0.5 } },
      },
    });

    const result = await client.evaluate(state, questions, { label: 'shadow-check' });

    expect(result.answers.isReady).toEqual({ type: 'noul', noul: 0.5 });
    expect(result.model).toBe('jev-fixture');
    expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(result.attempts).toBe(1);
  });

  it('throws unconfigured for a label without a fixture', async () => {
    const client = createFixtureJevClient({});

    await expect(client.evaluate(state, questions, { label: 'missing' })).rejects.toMatchObject({
      kind: 'unconfigured',
    });
  });
});
