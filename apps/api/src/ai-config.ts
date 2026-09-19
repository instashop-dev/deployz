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
  // Optional: only a gateway with authentication switched on requires it. An
  // unauthenticated gateway 401s on a cf-aig-authorization header it cannot
  // validate, so an unset token must mean no header at all.
  const gatewayToken = source.AI_GATEWAY_TOKEN || undefined;

  if (!baseUrl || !providerApiKey) {
    return { config: undefined, problem: 'missing' };
  }

  // The two credentials authenticate different hops: the gateway checks
  // cf-aig-authorization, the upstream provider checks Authorization. Equal
  // values mean one was pasted twice, and an authenticated gateway would
  // reject every request — better to disable AI than to fail every view.
  if (gatewayToken && providerApiKey === gatewayToken) {
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

// Jev shadow-mode client configuration, resolved from the same environment.

/** The default Jev model id. Override with `JEV_MODEL`. */
export const JEV_MODEL_DEFAULT = 'jev-latest';

/** How long a single Jev attempt may take. Override with `JEV_TIMEOUT_MS`. */
export const JEV_TIMEOUT_MS_DEFAULT = 10_000;

/**
 * Jev resolved as far as the environment allows. `enabled` is false unless
 * JEV_ENABLED=true AND both JEV_GATEWAY_URL and JEV_API_KEY are set — the
 * client is shadow-mode only, so a partial configuration disables it with a
 * warning rather than failing per request later.
 */
export interface JevConfig {
  readonly enabled: boolean;
  readonly baseUrl?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly model: string;
  readonly gatewayToken?: string | undefined;
  readonly timeoutMs: number;
}

function parseJevTimeoutMs(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return JEV_TIMEOUT_MS_DEFAULT;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : JEV_TIMEOUT_MS_DEFAULT;
}

/**
 * Build the Jev config. A PARTIAL configuration (one of URL/key missing while
 * JEV_ENABLED) is treated as disabled on purpose, mirroring the AI gateway's
 * rule — half-wired credentials fail at request time, an absent configuration
 * degrades cleanly.
 */
export function resolveJevConfig(source: Record<string, string | undefined>): JevConfig {
  const baseUrl = source.JEV_GATEWAY_URL;
  const apiKey = source.JEV_API_KEY;
  // Jev routes through the same Cloudflare AI Gateway as the AI explanations,
  // so the gateway's own token is the same shared AI_GATEWAY_TOKEN.
  const gatewayToken = source.AI_GATEWAY_TOKEN || undefined;
  const model = source.JEV_MODEL ?? JEV_MODEL_DEFAULT;
  const timeoutMs = parseJevTimeoutMs(source.JEV_TIMEOUT_MS);

  if (source.JEV_ENABLED !== 'true') {
    return { enabled: false, model, gatewayToken, timeoutMs };
  }

  if (!baseUrl || !apiKey) {
    console.warn(
      '[jev] JEV_ENABLED=true but JEV_GATEWAY_URL/JEV_API_KEY are not both set — ' +
        'the Jev shadow client stays disabled. Set them in .env.',
    );
    return { enabled: false, model, gatewayToken, timeoutMs };
  }

  return { enabled: true, baseUrl, apiKey, model, gatewayToken, timeoutMs };
}
