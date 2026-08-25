import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AiGatewayNotAvailableError,
  MAX_OUTPUT_TOKENS,
  MAX_PROMPT_TOKENS,
  MAX_TOTAL_TOKENS,
  createAiGateway,
  estimateTokens,
  truncateToTokens,
  type AiGatewayConfig,
} from '../src/ai-gateway.js';

// ==========================================================================
// Test helpers — a fake fetch that records the request the SDK actually made
// ==========================================================================

const schema = z
  .object({
    failureCode: z.string(),
    what: z.string(),
    why: z.string(),
    fix: z.string(),
  })
  .strict();

const modelOutput = {
  failureCode: 'UNKNOWN',
  what: 'what',
  why: 'why',
  fix: 'fix',
};

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * A fetch stub that returns a well-formed OpenAI chat-completion response and
 * records what the SDK sent. Nothing here touches the network.
 */
function recordingFetch(recorded: RecordedRequest[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    recorded.push({
      url: String(input),
      headers,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 0,
        model: 'test-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: JSON.stringify(modelOutput) },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
}

const config: AiGatewayConfig = {
  baseUrl: 'https://gateway.ai.cloudflare.com/v1/acct-123/gw-456/compat',
  model: 'workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731',
  providerApiKey: 'provider-key-aaa',
  gatewayToken: 'gateway-token-bbb',
};

// ==========================================================================
// Unconfigured gateway
// ==========================================================================

describe('createAiGateway — unconfigured', () => {
  it('returns a stub that throws AiGatewayNotAvailableError', async () => {
    const gateway = createAiGateway(undefined);

    await expect(gateway.generate('prompt', schema)).rejects.toThrow(
      AiGatewayNotAvailableError,
    );
  });

  it('never performs a network call when unconfigured', async () => {
    const recorded: RecordedRequest[] = [];
    const gateway = createAiGateway(undefined, recordingFetch(recorded));

    await expect(gateway.generate('prompt', schema)).rejects.toThrow();
    expect(recorded).toHaveLength(0);
  });
});

// ==========================================================================
// Authentication — the two-token separation
// ==========================================================================

describe('createAiGateway — authentication headers', () => {
  it('sends the provider key as the Authorization bearer', async () => {
    const recorded: RecordedRequest[] = [];
    const gateway = createAiGateway(config, recordingFetch(recorded));

    await gateway.generate('prompt', schema);

    expect(recorded[0]?.headers['authorization']).toBe('Bearer provider-key-aaa');
  });

  it('sends the gateway token on cf-aig-authorization', async () => {
    const recorded: RecordedRequest[] = [];
    const gateway = createAiGateway(config, recordingFetch(recorded));

    await gateway.generate('prompt', schema);

    expect(recorded[0]?.headers['cf-aig-authorization']).toBe('Bearer gateway-token-bbb');
  });

  it('keeps the two credentials distinct (an authenticated gateway 401s otherwise)', async () => {
    const recorded: RecordedRequest[] = [];
    const gateway = createAiGateway(config, recordingFetch(recorded));

    await gateway.generate('prompt', schema);

    const sent = recorded[0]?.headers ?? {};
    expect(sent['authorization']).not.toBe(sent['cf-aig-authorization']);
  });
});

// ==========================================================================
// Endpoint + model
// ==========================================================================

describe('createAiGateway — endpoint and model', () => {
  it('posts to the /compat endpoint with /chat/completions appended once', async () => {
    const recorded: RecordedRequest[] = [];
    const gateway = createAiGateway(config, recordingFetch(recorded));

    await gateway.generate('prompt', schema);

    expect(recorded[0]?.url).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct-123/gw-456/compat/chat/completions',
    );
  });

  it('does not double-append when the configured base URL already ends in /chat/completions', async () => {
    const recorded: RecordedRequest[] = [];
    const gateway = createAiGateway(
      { ...config, baseUrl: `${config.baseUrl}/chat/completions` },
      recordingFetch(recorded),
    );

    await gateway.generate('prompt', schema);

    expect(recorded[0]?.url).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct-123/gw-456/compat/chat/completions',
    );
  });

  it('constrains the model with a json_schema response format', async () => {
    // Without this the SDK falls back to coaxing JSON out of the prompt, and
    // the .strict() schema becomes a post-hoc rejection rather than a
    // constraint the model was actually held to.
    const recorded: RecordedRequest[] = [];
    const gateway = createAiGateway(config, recordingFetch(recorded));

    await gateway.generate('prompt', schema);

    expect(recorded[0]?.body.response_format).toMatchObject({ type: 'json_schema' });
  });

  it('sends the provider-qualified model id the /compat endpoint expects', async () => {
    const recorded: RecordedRequest[] = [];
    const gateway = createAiGateway(config, recordingFetch(recorded));

    await gateway.generate('prompt', schema);

    expect(recorded[0]?.body.model).toBe(
      'workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731',
    );
  });
});

// ==========================================================================
// Spend limit — a real upstream cap, not a post-hoc discovery
// ==========================================================================

describe('createAiGateway — spend limit', () => {
  it('sends maxOutputTokens so the provider enforces the cap', async () => {
    const recorded: RecordedRequest[] = [];
    const gateway = createAiGateway(config, recordingFetch(recorded));

    await gateway.generate('prompt', schema);

    expect(recorded[0]?.body.max_tokens).toBe(MAX_OUTPUT_TOKENS);
  });

  it('reports the usage the gateway returned', async () => {
    const gateway = createAiGateway(config, recordingFetch([]));

    const response = await gateway.generate('prompt', schema);

    expect(response.usage).toEqual({ promptTokens: 11, completionTokens: 7 });
  });

  it('budgets the prompt separately from the completion', () => {
    // One shared number means a prompt truncated to the ceiling leaves no room
    // for any completion, so the total check can never pass.
    expect(MAX_PROMPT_TOKENS).toBeLessThan(MAX_TOTAL_TOKENS);
    expect(MAX_TOTAL_TOKENS).toBe(MAX_PROMPT_TOKENS + MAX_OUTPUT_TOKENS);
  });

  it('leaves room for a full-budget completion after a maximally truncated prompt', () => {
    const huge = 'x'.repeat(MAX_PROMPT_TOKENS * 4 * 10);

    const truncated = truncateToTokens(huge, MAX_PROMPT_TOKENS);

    expect(estimateTokens(truncated) + MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(
      MAX_TOTAL_TOKENS,
    );
  });
});

// ==========================================================================
// Cancellation
// ==========================================================================

describe('createAiGateway — cancellation', () => {
  it('aborts the request when the caller signal fires', async () => {
    const controller = new AbortController();
    let sawSignal = false;
    // Never resolves on its own: the ONLY way out is the caller's signal, so a
    // signal that fails to reach fetch shows up as a timeout, not a false pass.
    const hangingFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        sawSignal = true;
        const abort = (): void => reject(new DOMException('Aborted', 'AbortError'));
        // The signal may already have fired before the SDK reached fetch.
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort);
      })) as typeof fetch;
    const gateway = createAiGateway(config, hangingFetch);

    const pending = gateway.generate('prompt', schema, {
      abortSignal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toThrow();
    expect(sawSignal).toBe(true);
  });
});
