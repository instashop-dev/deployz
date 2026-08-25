import type { AiGatewayConfig } from '@deployz/analysis';

// §16/§29 AI gateway configuration, resolved from the environment.
//
// Kept as a pure function over an env-shaped record (rather than reading
// `process.env` inline) so the partial-configuration rules below are testable
// without mutating global state.

/**
 * The default model, provider-qualified for the unified `/compat` endpoint.
 * Override with `AI_MODEL`; switching provider is a one-variable change
 * because the endpoint stays the same.
 */
export const AI_MODEL_DEFAULT = 'workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731';

/** Why a gateway configuration was rejected, for the startup warning. */
export type AiConfigProblem = 'missing' | 'reused-secret';

/**
 * Build the gateway config, or `undefined` when the environment does not fully
 * configure one.
 *
 * A PARTIAL configuration is treated as no configuration on purpose. Half-wired
 * credentials fail at request time, once per diagnostics view; an absent
 * configuration degrades cleanly to deterministic remediation guidance.
 */
export function resolveAiGatewayConfig(
  source: Record<string, string | undefined>,
): AiGatewayConfig | undefined {
  return describeAiGatewayConfig(source).config;
}

/**
 * `resolveAiGatewayConfig` plus the reason it rejected, so callers can warn
 * with something more useful than "not configured".
 */
export function describeAiGatewayConfig(source: Record<string, string | undefined>): {
  config: AiGatewayConfig | undefined;
  problem: AiConfigProblem | undefined;
} {
  const baseUrl = source.AI_GATEWAY_BASE_URL;
  const providerApiKey = source.AI_PROVIDER_API_KEY;
  const gatewayToken = source.AI_GATEWAY_TOKEN;

  if (!baseUrl || !providerApiKey || !gatewayToken) {
    return { config: undefined, problem: 'missing' };
  }

  // The two credentials authenticate different hops: the gateway checks
  // cf-aig-authorization, the upstream provider checks Authorization. Equal
  // values mean one was pasted twice, and an authenticated gateway would
  // reject every request — better to disable AI than to fail every view.
  if (providerApiKey === gatewayToken) {
    return { config: undefined, problem: 'reused-secret' };
  }

  return {
    config: {
      baseUrl,
      providerApiKey,
      gatewayToken,
      model: source.AI_MODEL ?? AI_MODEL_DEFAULT,
    },
    problem: undefined,
  };
}
