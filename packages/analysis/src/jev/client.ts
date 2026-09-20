/**
 * The Jev client seam — a typed decision model behind the Cloudflare AI
 * Gateway's `typesafe-ai` custom provider, on TypeSafe's native typed
 * decisions API, structured to mirror `ai-gateway.ts`: per-attempt timeout,
 * bounded retry with fixed backoff, and ONE structured log line per evaluate
 * call.
 *
 * PR 1 foundation: shadow-mode only, nothing in production calls it yet.
 * Everything is injectable (`fetchImpl`, `sleep`, `breaker`) so tests drive
 * the full retry/breaker matrix with no network, no credentials, and no real
 * time.
 */

import type { JevCircuitBreaker } from './circuit-breaker.js';
import { JevError, type JevErrorKind } from './errors.js';
import {
  jevResponseSchema,
  type JevAnswer,
  type JevQuestion,
  type JevState,
  type JevUsage,
} from './schemas.js';

/** How long a single attempt may take before it is abandoned. */
export const JEV_DEFAULT_TIMEOUT_MS = 10_000;

const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_BACKOFF_MS = 500;
const ENDPOINT_PATH = '/v1/systemone';

/**
 * Everything needed to reach Jev through the gateway. Assembled by the
 * application's env module (`apps/api/src/env.ts`), not read from
 * `process.env` here — one place touches the environment.
 */
export interface JevClientConfig {
  /**
   * The custom-provider base, e.g.
   * `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/custom-typesafe-ai`.
   * A trailing slash is stripped; `/v1/systemone` is appended once — correct
   * for any custom provider rooted at `https://api.typesafe.ai`.
   */
  readonly baseUrl: string;
  /** The Jev API key. Sent as `Authorization: Bearer`. */
  readonly apiKey: string;
  readonly model: string;
  /**
   * The GATEWAY's own token, sent as `cf-aig-authorization`. OPTIONAL, and
   * omitted entirely when unset — an unauthenticated gateway answers 401 to a
   * header it cannot validate.
   */
  readonly gatewayToken?: string | undefined;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly backoffMs?: number;
  /** Injectable so tests assert the request without network access. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable so tests retry without waiting out the real delay. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Checked before the first attempt; the final outcome is recorded on it. */
  readonly breaker?: JevCircuitBreaker | undefined;
}

export interface JevEvaluateOptions {
  /** Tag identifying the caller in the observability log line. */
  readonly label: string;
  /** Abort the request when this signal fires. */
  readonly signal?: AbortSignal | undefined;
}

export interface JevEvaluateResult {
  readonly answers: Record<string, JevAnswer>;
  readonly model: string;
  readonly usage: JevUsage;
  /** Reported usage cost in USD — present only when the provider reports one. */
  readonly usageCost?: number | undefined;
  readonly latencyMs: number;
  readonly attempts: number;
}

export interface JevClient {
  evaluate(
    state: JevState,
    questions: Record<string, JevQuestion>,
    options?: JevEvaluateOptions,
  ): Promise<JevEvaluateResult>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Map an HTTP status to the error kind callers branch on. */
function statusKind(status: number): JevErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 422) return 'validation';
  if (status === 429) return 'rate-limited';
  if (status === 529) return 'overloaded';
  if (status >= 500) return 'gateway-error';
  // Any other 4xx means the request itself is wrong — a retry repeats the
  // same failure and spends tokens for nothing.
  return 'validation';
}

const RETRYABLE_KINDS: ReadonlySet<JevErrorKind> = new Set([
  'rate-limited',
  'overloaded',
  'gateway-error',
  'network',
  'timeout',
]);

/**
 * Wrap a thrown non-Jev error. An abort is the per-attempt timeout (the
 * caller's signal aborts the same controller, so both cut-offs arrive here
 * indistinguishably); anything else a fetch can throw is a network failure.
 */
function toJevError(error: unknown, attempts: number): JevError {
  if (error instanceof JevError) return error;
  if (error instanceof Error && error.name === 'AbortError') {
    return new JevError('timeout', { attempts });
  }
  return new JevError('network', { attempts });
}

export function createJevClient(config: JevClientConfig): JevClient {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const timeoutMs = config.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS;
  const maxAttempts = Math.max(1, config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const backoffMs = config.backoffMs ?? DEFAULT_BACKOFF_MS;
  const fetchImpl = config.fetchImpl ?? fetch;
  const sleep = config.sleep ?? defaultSleep;

  return {
    async evaluate(state, questions, options) {
      const label = options?.label ?? 'evaluate';
      const start = Date.now();

      // Emits the ONE observability line per evaluate call, after the final
      // outcome. Never logs state, questions, answers, or header values.
      const emit = (ok: boolean, attempts: number, fields: Record<string, unknown>): void => {
        console.log(
          JSON.stringify({
            jev: label,
            model: config.model,
            latencyMs: Date.now() - start,
            attempts,
            ok,
            ...fields,
          }),
        );
      };

      // Checked before any attempt, so an open breaker costs zero fetches.
      // No outcome is recorded, so the bypass window runs undisturbed.
      if (config.breaker && !config.breaker.allow()) {
        emit(false, 0, { error: 'breaker-open' });
        throw new JevError('breaker-open', { attempts: 0 });
      }

      for (let attempt = 1; ; attempt += 1) {
        // Per-attempt timeout: a fresh controller each time, so one timed-out
        // attempt does not poison the next. The caller's signal aborts the
        // same controller, so both cut-offs reach fetch through one path.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const onCallerAbort = (): void => controller.abort();
        options?.signal?.addEventListener('abort', onCallerAbort);
        try {
          const response = await fetchImpl(`${baseUrl}${ENDPOINT_PATH}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${config.apiKey}`,
              // Only sent when the gateway is authenticated — an
              // unauthenticated gateway 401s on a header it cannot validate.
              ...(config.gatewayToken
                ? { 'cf-aig-authorization': `Bearer ${config.gatewayToken}` }
                : {}),
            },
            body: JSON.stringify({ state, model: config.model, questions }),
            signal: controller.signal,
          });

          if (!response.ok) {
            throw new JevError(statusKind(response.status), {
              status: response.status,
              attempts: attempt,
            });
          }

          let body: unknown;
          try {
            body = await response.json();
          } catch {
            throw new JevError('malformed', { attempts: attempt });
          }
          const parsed = jevResponseSchema.safeParse(body);
          if (!parsed.success) {
            throw new JevError('malformed', { attempts: attempt });
          }
          const usageCost = parsed.data.usage.cost;

          config.breaker?.recordSuccess();
          emit(true, attempt, {
            inputTokens: parsed.data.usage.input_tokens,
            outputTokens: parsed.data.usage.output_tokens,
            ...(usageCost !== undefined ? { costUsd: usageCost } : {}),
          });
          return {
            answers: parsed.data.answers,
            model: parsed.data.model,
            usage: parsed.data.usage,
            ...(usageCost !== undefined ? { usageCost } : {}),
            latencyMs: Date.now() - start,
            attempts: attempt,
          };
        } catch (error) {
          const jevError = toJevError(error, attempt);
          // A caller-initiated abort is never retried — the caller gave up.
          const canRetry =
            attempt < maxAttempts &&
            RETRYABLE_KINDS.has(jevError.kind) &&
            !options?.signal?.aborted;
          if (!canRetry) {
            config.breaker?.recordFailure();
            emit(false, attempt, { error: jevError.kind });
            throw jevError;
          }
          await sleep(backoffMs);
        } finally {
          clearTimeout(timer);
          options?.signal?.removeEventListener('abort', onCallerAbort);
        }
      }
    },
  };
}
