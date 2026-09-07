import { Environment, LogLevel, Paddle } from '@paddle/paddle-node-sdk';

import { env } from './env.js';

/**
 * Resolved Paddle billing configuration. `apiKey`/`webhookSecret` never leave
 * this module's callers into a client response — see GET /api/billing/config
 * in server.ts. Price ids come only from here; nothing in this module (or
 * anywhere else) creates a Paddle product or price dynamically — real ids are
 * recorded in docs/billing/paddle-catalog.md and set through config.
 */
export interface PaddleConfig {
  apiKey: string;
  webhookSecret: string;
  clientToken: string;
  pricePlatform: string;
  priceDeployment: string;
  environment: 'sandbox' | 'production';
}

export interface PaddleBilling {
  client: Paddle;
  config: PaddleConfig;
}

/** The subset of env.ts's flat fields createPaddle needs, shaped so a test can supply a fixture without importing env.ts. */
type PaddleEnvSource = {
  paddleApiKey: string | undefined;
  paddleWebhookSecret: string | undefined;
  paddleClientToken: string | undefined;
  paddlePricePlatform: string | undefined;
  paddlePriceDeployment: string | undefined;
  paddleEnvironment: 'sandbox' | 'production';
};

/**
 * Builds the Paddle client and config, or `null` when PADDLE_API_KEY is
 * unset — billing stays optional at boot (env.ts warns once; every billing
 * surface then reports BILLING_DISABLED). When PADDLE_API_KEY is set, env.ts
 * has already validated the other four keys and the environment at startup,
 * so they are guaranteed present here.
 */
export function createPaddle(source: PaddleEnvSource = env): PaddleBilling | null {
  if (!source.paddleApiKey) return null;
  const config: PaddleConfig = {
    apiKey: source.paddleApiKey,
    webhookSecret: source.paddleWebhookSecret!,
    clientToken: source.paddleClientToken!,
    pricePlatform: source.paddlePricePlatform!,
    priceDeployment: source.paddlePriceDeployment!,
    environment: source.paddleEnvironment,
  };
  // The SDK logs every request at LOG level by default; errors are enough.
  const client = new Paddle(config.apiKey, {
    environment: config.environment === 'production' ? Environment.production : Environment.sandbox,
    logLevel: LogLevel.error,
  });
  return { client, config };
}
