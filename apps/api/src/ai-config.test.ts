import { describe, expect, it } from 'vitest';

import { AI_MODEL_DEFAULT, resolveAiGatewayConfig } from './ai-config.js';

const complete = {
  AI_GATEWAY_BASE_URL: 'https://gateway.ai.cloudflare.com/v1/acct/gw/compat',
  AI_PROVIDER_API_KEY: 'provider-key',
  AI_GATEWAY_TOKEN: 'gateway-token',
};

describe('resolveAiGatewayConfig', () => {
  it('builds a config when every credential is present', () => {
    expect(resolveAiGatewayConfig(complete)).toEqual({
      baseUrl: complete.AI_GATEWAY_BASE_URL,
      providerApiKey: 'provider-key',
      gatewayToken: 'gateway-token',
      model: AI_MODEL_DEFAULT,
    });
  });

  it('uses AI_MODEL when set', () => {
    const config = resolveAiGatewayConfig({ ...complete, AI_MODEL: 'anthropic/claude-haiku-4-5' });

    expect(config?.model).toBe('anthropic/claude-haiku-4-5');
  });

  it('returns undefined when nothing is configured', () => {
    expect(resolveAiGatewayConfig({})).toBeUndefined();
  });

  // A half-wired gateway is worse than a disabled one: it fails at request
  // time instead of degrading to deterministic remediation.
  it.each([
    ['AI_GATEWAY_BASE_URL'],
    ['AI_PROVIDER_API_KEY'],
    ['AI_GATEWAY_TOKEN'],
  ])('treats a config missing %s as unconfigured', (missing) => {
    const partial: Record<string, string> = { ...complete };
    delete partial[missing];

    expect(resolveAiGatewayConfig(partial)).toBeUndefined();
  });

  it('treats an empty-string credential as unset', () => {
    expect(resolveAiGatewayConfig({ ...complete, AI_GATEWAY_TOKEN: '' })).toBeUndefined();
  });

  it('refuses a config that reuses one secret for both headers', () => {
    // The gateway token and the provider key authenticate different hops. If
    // they are equal it is a copy-paste error, and an authenticated gateway
    // would reject every request.
    const reused = resolveAiGatewayConfig({
      ...complete,
      AI_PROVIDER_API_KEY: 'same-secret',
      AI_GATEWAY_TOKEN: 'same-secret',
    });

    expect(reused).toBeUndefined();
  });
});
