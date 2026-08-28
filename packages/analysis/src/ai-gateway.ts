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

import { APICallError, NoObjectGeneratedError, generateObject } from 'ai';
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
 *
 * Sized for a REASONING model. Models like `@cf/deepseek-ai/deepseek-v4-flash`
 * emit `reasoning_content` first and charge it to the same budget, so the cap
 * has to cover the thinking as well as the JSON. Measured against the live
 * gateway: a 300-token cap truncated the response in 3 of 6 runs
 * (`finish_reason: "length"`, unparseable JSON, which surfaces as a silent
 * fallback to deterministic text); 700 was 6 of 6 with a peak completion of
 * 499. Do not lower this without re-measuring against a reasoning model.
 */
export const MAX_OUTPUT_TOKENS = 800;

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
  /**
   * Tag identifying the caller in the observability log line (e.g.
   * `"explainDiagnostic"`). Cosmetic only — never sent to the gateway.
   */
  readonly label?: string | undefined;
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
        `be reached. Set AI_GATEWAY_BASE_URL and AI_PROVIDER_API_KEY to enable ` +
        `AI explanations (AI_GATEWAY_TOKEN only for an authenticated gateway).`,
    );
    this.name = 'AiGatewayNotAvailableError';
  }
}

// ── Retry ───────────────────────────────────────────────────────────────────

/**
 * Bounds how hard `generate` retries a failed request. Every field is
 * optional and defaults to a single retry with a 500ms backoff, so existing
 * `createAiGateway(config, fetchFn)` call sites need no change.
 */
export interface AiRetryOptions {
  /**
   * Total attempts, including the first. Hard-capped at 3 regardless of what
   * is passed — this is a spend guard, not a tunable. Default 2.
   */
  readonly maxAttempts?: number;
  /** Delay before a retry, in ms. Default 500. */
  readonly backoffMs?: number;
  /** Injectable so tests can retry without waiting out the real delay. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 2;
const MAX_ATTEMPTS_CAP = 3;
const DEFAULT_BACKOFF_MS = 500;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The `name` an error carries, if it has one — without assuming it extends `Error`. */
function errorName(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('name' in error)) return undefined;
  return String((error as { name: unknown }).name);
}

/**
 * Classifies which failures are worth a retry.
 *
 * Retryable: a network/fetch failure (`TypeError`, an `APICallError` with no
 * HTTP status, or the SDK's own `AI_RetryError`), a 429 or 5xx, and a
 * malformed structured-output response (`NoObjectGeneratedError`) — the
 * spec's "repair retry", since asking the model again is often enough to get
 * valid JSON the second time.
 *
 * Never retryable: an aborted request (retrying would ignore the caller's
 * own cancellation), or a 4xx other than 429 (the request itself is
 * malformed, so retrying repeats the same failure and burns spend for
 * nothing). `AiGatewayNotAvailableError` never reaches this function at all —
 * the unconfigured stub throws it before any retry loop exists.
 */
function isRetryableError(error: unknown, abortSignal: AbortSignal | undefined): boolean {
  if (abortSignal?.aborted || errorName(error) === 'AbortError') return false;

  if (NoObjectGeneratedError.isInstance(error)) return true;

  if (APICallError.isInstance(error)) {
    return error.statusCode === undefined || error.statusCode === 429 || error.statusCode >= 500;
  }

  return error instanceof TypeError || errorName(error) === 'AI_RetryError';
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
   * The GATEWAY's own token, sent as `cf-aig-authorization` — what an
   * authenticated AI Gateway checks before forwarding upstream. Distinct from
   * `providerApiKey`; conflating the two makes an authenticated gateway 401.
   *
   * OPTIONAL, because Cloudflare only requires this header on a gateway with
   * authentication switched on. An unauthenticated gateway answers 401 to a
   * cf-aig-authorization header it cannot validate, so leaving this unset must
   * omit the header rather than send an empty or placeholder one.
   */
  readonly gatewayToken?: string | undefined;
}

/**
 * Creates the real gateway from `config`, or a stub that throws
 * `AiGatewayNotAvailableError` when `config` is undefined (nothing configured).
 *
 * The two credentials travel on two DIFFERENT headers by design: the gateway
 * authenticates the caller via `cf-aig-authorization`, then authenticates
 * itself to the upstream provider with the `Authorization` bearer. The former
 * is omitted entirely for an unauthenticated gateway.
 *
 * `fetchFn` is injectable so tests can assert the request the SDK actually
 * builds without any network access. `retryOptions` bounds the retry loop
 * described on `AiRetryOptions`; omitted, it defaults to one retry.
 */
export function createAiGateway(
  config: AiGatewayConfig | undefined,
  fetchFn?: typeof fetch,
  retryOptions?: AiRetryOptions,
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
    // Only sent when the gateway is authenticated — see `gatewayToken`.
    ...(config.gatewayToken
      ? { headers: { 'cf-aig-authorization': `Bearer ${config.gatewayToken}` } }
      : {}),
    // Without this the SDK downgrades to `response_format: json_object`, which
    // asks for "some JSON" rather than JSON matching the schema. The strict
    // Zod schema would then be a post-hoc rejection instead of a constraint the
    // model was held to, and every malformed field would cost a wasted call.
    supportsStructuredOutputs: true,
    ...(fetchFn ? { fetch: fetchFn } : {}),
  });

  const maxAttempts = Math.min(
    Math.max(1, retryOptions?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
    MAX_ATTEMPTS_CAP,
  );
  const backoffMs = retryOptions?.backoffMs ?? DEFAULT_BACKOFF_MS;
  const sleep = retryOptions?.sleep ?? defaultSleep;

  return {
    async generate(prompt, schema, options = {}) {
      const label = options.label ?? 'generate';
      const start = Date.now();

      // Emits the ONE observability line the spec requires, after the final
      // attempt (success or failure). Never logs prompt/response content.
      const emit = (ok: boolean, attempts: number, usage?: TokenUsage): void => {
        console.log(
          JSON.stringify({
            ai: label,
            model: config.model,
            latencyMs: Date.now() - start,
            attempts,
            ok,
            ...(usage ? { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens } : {}),
          }),
        );
      };

      for (let attempt = 1; ; attempt += 1) {
        // Checked up front too, not just in the catch below: a signal that
        // is already aborted before the first attempt must still short
        // circuit rather than let one more request through.
        if (options.abortSignal?.aborted) {
          const error = new DOMException('The operation was aborted.', 'AbortError');
          emit(false, attempt);
          throw error;
        }

        try {
          const { object, usage } = await generateObject({
            model: provider(config.model),
            schema,
            prompt,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            // Retries are owned by the loop below (its own bound and
            // backoff), not the SDK's default — letting both retry would
            // multiply attempts past `maxAttempts`.
            maxRetries: 0,
            ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
          });

          const tokenUsage: TokenUsage = {
            promptTokens: usage.inputTokens ?? 0,
            completionTokens: usage.outputTokens ?? 0,
          };
          emit(true, attempt, tokenUsage);
          return { object, usage: tokenUsage };
        } catch (error) {
          const canRetry = attempt < maxAttempts && isRetryableError(error, options.abortSignal);
          if (!canRetry) {
            emit(false, attempt);
            throw error;
          }
          await sleep(backoffMs);
        }
      }
    },
  };
}
