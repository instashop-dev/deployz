import { describe, expect, it } from 'vitest';

import { Environment } from '@paddle/paddle-node-sdk';

import { createPaddle } from './paddle.js';

// Fixture matching env.ts's flat field shape (paddleApiKey, paddleWebhookSecret,
// …) so createPaddle can be exercised without importing the real env module
// or mutating process.env. Placeholder values only — never a realistic id.
function paddleEnv(overrides: Partial<Parameters<typeof createPaddle>[0]> = {}) {
  return {
    paddleApiKey: 'test_replace_me',
    paddleWebhookSecret: 'test_replace_me',
    paddleClientToken: 'pdl_sdbx_replace_me',
    paddlePricePlatform: 'pri_platform_replace_me',
    paddlePriceDeployment: 'pri_deployment_replace_me',
    paddleEnvironment: 'sandbox' as const,
    ...overrides,
  };
}

describe('createPaddle', () => {
  it('returns null when PADDLE_API_KEY is unset', () => {
    const billing = createPaddle({ ...paddleEnv(), paddleApiKey: undefined });
    expect(billing).toBeNull();
  });

  it('returns a client configured for the sandbox environment by default', () => {
    const billing = createPaddle(paddleEnv());
    expect(billing).not.toBeNull();
    expect(billing!.config.environment).toBe('sandbox');
    expect(billing!.client).toBeDefined();
  });

  it('returns a client configured for production when PADDLE_ENVIRONMENT=production', () => {
    const billing = createPaddle(paddleEnv({ paddleEnvironment: 'production' }));
    expect(billing).not.toBeNull();
    expect(billing!.config.environment).toBe('production');
  });

  it('exposes the price ids, client token and api key from config', () => {
    const billing = createPaddle(paddleEnv());
    expect(billing!.config.pricePlatform).toBe('pri_platform_replace_me');
    expect(billing!.config.priceDeployment).toBe('pri_deployment_replace_me');
    expect(billing!.config.clientToken).toBe('pdl_sdbx_replace_me');
    expect(billing!.config.apiKey).toBe('test_replace_me');
  });

  it('exports only createPaddle at runtime — no seam creates products or prices', async () => {
    const paddleModule = await import('./paddle.js');
    expect(Object.keys(paddleModule)).toEqual(['createPaddle']);
  });
});

// Sanity check that the SDK's Environment enum values line up with the
// 'sandbox' | 'production' strings env.ts validates — if the SDK ever
// renamed these, createPaddle's environment mapping would silently break.
describe('Paddle SDK Environment enum', () => {
  it('matches the sandbox/production string values', () => {
    expect(Environment.sandbox).toBe('sandbox');
    expect(Environment.production).toBe('production');
  });
});
