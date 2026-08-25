/**
 * The Cloudflare AI Gateway seam — the injectable boundary every AI
 * explanation layer talks to, plus the spend-limit configuration that bounds
 * a single request.
 *
 * This lives in `@deployz/analysis` so that BOTH `@deployz/cdk` (which owns
 * the compatibility explainer) and `apps/api` (which serves diagnostics) can
 * reach it. `@deployz/cdk` already depends on `@deployz/api`, so the API
 * importing the gateway from the CDK package would close a dependency cycle.
 *
 * The seam is injectable by design: tests replay recorded fixtures through
 * `AiGateway` without any network access or credentials, and the real
 * implementation degrades to a throwing stub when the gateway is not
 * configured.
 */

import { generateObject } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { z } from 'zod';

// ── Spend-limit config ──────────────────────────────────────────────────────

/**
 * Max tokens the PROMPT may occupy. An oversized prompt is truncated to this
 * budget before it reaches the gateway.
 *
 * Deliberately SEPARATE from the output budget: sharing one number between the
 * two means a prompt truncated to the ceiling leaves no room for any
 * completion, so the total-usage check can never pass.
 */
export const MAX_PROMPT_TOKENS = 700;

/**
 * Max tokens the COMPLETION may occupy. Passed to the model as
 * `maxOutputTokens`, so the provider enforces it on its side rather than the
 * limit being discovered after the tokens are already billed.
 */
export const MAX_OUTPUT_TOKENS = 300;

/**
 * Total per-request budget: prompt + completion. A post-hoc backstop against a
 * gateway that ignores `maxOutputTokens` and reports usage above what was
 * asked for.
 */
export const MAX_TOTAL_TOKENS = MAX_PROMPT_TOKENS + MAX_OUTPUT_TOKENS;

/** How long a single explanation request may take before it is abandoned. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Rough token estimator. This environment has no tokenizer installed, so the
 * budget uses a conservative ~4 chars/token heuristic. The REAL token count
 * comes from the gateway's reported `usage` — this estimate only gates prompt
 * truncation.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Truncate `text` to (at most) `maxTokens` estimated tokens. */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const budgetChars = Math.max(0, maxTokens * 4 - 3);
  return `${text.slice(0, budgetChars)}...`;
}

// ── The seam ────────────────────────────────────────────────────────────────

/** Token usage reported by the gateway for one request. */
export interface TokenUsage {
  /** Tokens consumed by the prompt. */
  readonly promptTokens: number;
  /** Tokens produced by the completion. */
  readonly completionTokens: number;
}

/** The gateway's raw response: the model's output plus its token usage. */
export interface AiGatewayResponse {
  /**
   * The model's structured output, already JSON-parsed by the Vercel AI SDK
   * (`generateObject`). Validated locally against the caller's Zod schema.
   */
  readonly object: unknown;
  /** Token usage reported by the gateway. */
  readonly usage: TokenUsage;
}

/** Per-request options the caller may hand the gateway. */
export interface AiGenerateOptions {
  /** Abort the request when this signal fires (the caller's hard timeout). */
  readonly abortSignal?: AbortSignal | undefined;
}

/**
 * The AI gateway seam. The real implementation calls Cloudflare AI Gateway via
 * the Vercel AI SDK (`generateObject` with the caller's Zod schema); tests
 * inject a recorded-fixture gateway that replays pre-recorded responses.
 */
export interface AiGateway {
  generate(
    prompt: string,
    schema: z.ZodType,
    options?: AiGenerateOptions,
  ): Promise<AiGatewayResponse>;
}

// ── Errors ──────────────────────────────────────────────────────────────────

/** Thrown when the gateway's reported usage exceeds the spend-limit budget. */
export class SpendLimitExceededError extends Error {
  constructor(usedTokens: number, limit: number) {
    super(
      `AI spend limit exceeded: request used ${usedTokens} tokens ` +
        `(prompt + completion) against a ${limit}-token budget.`,
    );
    this.name = 'SpendLimitExceededError';
  }
}

/**
 * Thrown by the real gateway when it has not been configured. The explanation
 * layers degrade to deterministic text when they see this, rather than
 * surfacing an error to the user.
 */
export class AiGatewayNotAvailableError extends Error {
  constructor(model: string) {
    super(
      `Cloudflare AI Gateway is not configured, so the "${model}" model cannot ` +
        `be reached. Set AI_GATEWAY_BASE_URL, AI_PROVIDER_API_KEY and ` +
        `AI_GATEWAY_TOKEN to enable AI explanations.`,
    );
    this.name = 'AiGatewayNotAvailableError';
  }
}

// ── Configuration ───────────────────────────────────────────────────────────

/**
 * Everything needed to reach the gateway. Assembled by the application's env
 * module (`apps/api/src/env.ts`) rather than read from `process.env` here, so
 * there stays exactly one place that touches the environment.
 */
export interface AiGatewayConfig {
  /**
   * The unified `/compat` endpoint, e.g.
   * `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/compat`.
   * The AI SDK appends `/chat/completions`, so any such suffix is stripped.
   */
  readonly baseUrl: string;
  /**
   * The model, provider-qualified for the `/compat` endpoint, e.g.
   * `workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731`.
   */
  readonly model: string;
  /**
   * The UPSTREAM PROVIDER's key. Sent as `Authorization: Bearer` — the
   * credential the provider behind the gateway checks.
   */
  readonly providerApiKey: string;
  /**
   * The GATEWAY's own token. Sent as `cf-aig-authorization` — what an
   * authenticated AI Gateway checks before forwarding upstream. Distinct from
   * `providerApiKey`; conflating the two makes an authenticated gateway 401.
   */
  readonly gatewayToken: string;
}

/**
 * Creates the real gateway from `config`, or a stub that throws
 * `AiGatewayNotAvailableError` when `config` is undefined (nothing configured).
 *
 * The two credentials travel on two DIFFERENT headers by design: the gateway
 * authenticates the caller via `cf-aig-authorization`, then authenticates
 * itself to the upstream provider with the `Authorization` bearer.
 *
 * `fetchFn` is injectable so tests can assert the request the SDK actually
 * builds without any network access.
 */
export function createAiGateway(
  config: AiGatewayConfig | undefined,
  fetchFn?: typeof fetch,
): AiGateway {
  if (!config) {
    return {
      async generate() {
        throw new AiGatewayNotAvailableError('unconfigured');
      },
    };
  }

  const baseURL = config.baseUrl.replace(/\/chat\/completions\/?$/, '');
  const provider = createOpenAICompatible({
    name: 'cloudflare-ai-gateway',
    baseURL,
    apiKey: config.providerApiKey,
    headers: {
      'cf-aig-authorization': `Bearer ${config.gatewayToken}`,
    },
    // Without this the SDK downgrades to `response_format: json_object`, which
    // asks for "some JSON" rather than JSON matching the schema. The strict
    // Zod schema would then be a post-hoc rejection instead of a constraint the
    // model was held to, and every malformed field would cost a wasted call.
    supportsStructuredOutputs: true,
    ...(fetchFn ? { fetch: fetchFn } : {}),
  });

  return {
    async generate(prompt, schema, options = {}) {
      const { object, usage } = await generateObject({
        model: provider(config.model),
        schema,
        prompt,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      });

      return {
        object,
        usage: {
          promptTokens: usage.inputTokens ?? 0,
          completionTokens: usage.outputTokens ?? 0,
        },
      };
    },
  };
}
