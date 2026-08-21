/**
 * §20 + S10 AI explanation layer — human-language explanation over the
 * deterministic verdict (todo 23).
 *
 * The rules engine (`evaluateCompatibility`) is the SINGLE SOURCE OF TRUTH for
 * the readiness verdict. This layer wraps that verdict in a plain-English
 * explanation produced by a model behind Cloudflare AI Gateway (via the Vercel
 * AI SDK's structured-output / Zod API). It is deliberately THIN:
 *
 * - §20 — the AI can NEVER flip the deterministic verdict. The `verdict` field
 *   the model returns is validated for shape and then OVERRIDDEN with the
 *   deterministic value. A guard test proves a model trying to flip READY →
 *   NOT_COMPATIBLE cannot.
 * - S10 — explanations ONLY. The Zod schema has exactly three text fields plus
 *   the verdict. It has NO fields for code, config, Terraform, IAM, or
 *   infrastructure, and it is `.strict()`, so any such content the model
 *   hallucinates into an extra field is rejected at parse time.
 * - One default model per task — a single `DEFAULT_MODEL` constant (no
 *   multi-model routing).
 * - Spend-limit config — a per-request token budget (`DEFAULT_MAX_TOKENS`) that
 *   is enforced by truncating an oversized prompt and refusing a response whose
 *   reported usage exceeds the budget.
 *
 * AWS/Cloudflare/GitHub credentials are NOT available in this environment, so
 * the real gateway is an injectable seam (`AiGateway`). Tests inject a
 * recorded-fixture gateway that replays pre-recorded responses (simulating the
 * real gateway's structured JSON) and report token usage; token volume for the
 * U5 spike is measured from those recorded fixtures. The real
 * `createCloudflareAiGateway()` throws until the Vercel AI SDK + Cloudflare
 * credentials are configured (same graceful-degradation seam as todo 14's
 * `createAwsClients()`).
 */

import { generateObject } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';

import type { CompatibilityResult, CompatibilityVerdict } from './rules.js';

// ── Structured-output schema (S10: explanations ONLY) ───────────────────────

/**
 * The Zod schema the model's structured output MUST satisfy.
 *
 * S10 constraint made structural: exactly three text fields (`summary`, `why`,
 * `fix`) plus the `verdict` echo. There are NO fields for code, configuration,
 * Terraform, IAM, or infrastructure, and `.strict()` rejects ANY extra key —
 * so a model that attempts to emit such content fails validation.
 */
export const explanationSchema = z
  .object({
    /**
     * The verdict the model thinks applies. IGNORED by the engine — the
     * deterministic verdict (todo 23) always wins (§20). It is still validated
     * here (must be a real verdict string) so a malformed echo fails early.
     */
    verdict: z.enum(['READY', 'NEEDS_ATTENTION', 'NOT_COMPATIBLE']),
    /** What the verdict means — plain English, §65 jargon-free. */
    summary: z.string(),
    /** Why this verdict was reached — plain English, §65 jargon-free. */
    why: z.string(),
    /** How to become compatible (or "nothing to do" when ready) — §65. */
    fix: z.string(),
  })
  .strict();

/** The validated explanation (the AI text + the deterministic verdict). */
export type Explanation = z.infer<typeof explanationSchema>;

// ── Model + spend-limit config ──────────────────────────────────────────────

/**
 * The single default model for the AI explanation task. No multi-model routing
 * — every explanation request uses this model behind Cloudflare AI Gateway.
 * (Cloudflare Workers AI model id; override per-deployment if needed.)
 */
export const DEFAULT_MODEL = '@cf/meta/llama-3.1-8b-instruct';

/**
 * Default spend-limit: max total tokens (prompt + completion) per explanation
 * request. The engine truncates an oversized prompt and refuses a response
 * whose reported usage exceeds this budget.
 */
export const DEFAULT_MAX_TOKENS = 1000;

/**
 * Rough token estimator. This environment has no tokenizer installed, so the
 * budget uses a conservative ~4 chars/token heuristic (same class of
 * approximation the U5 spike documents). The REAL token count comes from the
 * gateway's reported `usage` — this estimate only gates prompt truncation.
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

// ── Injectable gateway seam ─────────────────────────────────────────────────

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
   * (`generateObject`). Validated locally against `explanationSchema`.
   */
  readonly object: unknown;
  /** Token usage reported by the gateway (the U5 spike measures this). */
  readonly usage: TokenUsage;
}

/**
 * The AI gateway seam. The real implementation calls Cloudflare AI Gateway via
 * the Vercel AI SDK (`generateObject` with the Zod schema); tests inject a
 * recorded-fixture gateway that replays pre-recorded responses.
 */
export interface AiGateway {
  generate(prompt: string, schema: z.ZodType): Promise<AiGatewayResponse>;
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
 * Thrown by the real gateway when the Vercel AI SDK is not installed or
 * Cloudflare credentials are missing. The explanation layer is PENDING-AI until
 * the SDK + credentials are provided (recorded fixtures stand in meanwhile).
 */
export class AiGatewayNotAvailableError extends Error {
  constructor(model: string) {
    super(
      `Cloudflare AI Gateway not available — the Vercel AI SDK is not installed ` +
        `or credentials are missing, so the "${model}" model cannot be reached. ` +
        `Install the SDK and configure credentials (or inject a recorded-fixture ` +
        `gateway) to run real explanations (todo 24 PENDING-AI).`,
    );
    this.name = 'AiGatewayNotAvailableError';
  }
}

// ── Prompt + explain context ────────────────────────────────────────────────

/** Input context for the explanation (what the model is explaining). */
export interface ExplainContext {
  /** Human-readable application/repository name for the prompt. */
  readonly applicationName: string;
  /** Optional detected metadata (todo 22) to enrich the explanation. */
  readonly metadata?: Record<string, unknown> | undefined;
}

/** Tunables for `explainCompatibility`. */
export interface ExplainOptions {
  /** Max total tokens (prompt + completion). Defaults to `DEFAULT_MAX_TOKENS`. */
  readonly maxTokens?: number | undefined;
}

/**
 * Build the prompt from the deterministic verdict + context. The prompt tells
 * the model it is explaining (not deciding) and constrains it to §65
 * jargon-free text with no code/config/infra content.
 */
export function buildPrompt(
  verdict: CompatibilityResult,
  context: ExplainContext,
): string {
  const issues =
    verdict.issues.length > 0
      ? verdict.issues.map((i) => `  - ${i.code}: ${i.message}`).join('\n')
      : '  - none';

  const metadata = context.metadata
    ? `\nDetected metadata (JSON):\n${JSON.stringify(context.metadata)}`
    : '';

  return [
    `You are explaining a deterministic deployment-readiness verdict for the application ` +
      `"${context.applicationName}" to its developer. The verdict was computed by a rules ` +
      `engine, not by you — you only add plain-English explanation. Do NOT change the verdict.`,
    '',
    `Deterministic verdict: ${verdict.verdict}`,
    `Reason: ${verdict.reason}`,
    'Issues:',
    issues,
    metadata,
    '',
    'Respond with JSON matching the schema: {"verdict", "summary", "why", "fix"}.',
    '- summary: what this verdict means, in one or two plain sentences.',
    '- why: the reasons behind it, in plain language.',
    '- fix: what to do next to become compatible, in plain language (or "nothing to do" if ready).',
    'Use plain language only — no AWS/ECS/CFN/IAM service names, no code, no config, ' +
      'no Terraform, no infrastructure redesign.',
  ].join('\n');
}

// ── The explainer ───────────────────────────────────────────────────────────

/**
 * Produce a Zod-validated, plain-English explanation of a deterministic verdict.
 *
 * Pipeline (order matters):
 *   1. Build the prompt and truncate it to the token budget (prompt side).
 *   2. Ask the model for structured output via the injectable `AiGateway`.
 *   3. Refuse if the gateway's reported usage exceeds the budget (completion side).
 *   4. Validate the raw output against `explanationSchema` (strict — rejects
 *      malformed output, missing fields, and any code/config/infra content).
 *   5. §20 guard — override the model's `verdict` with the deterministic value.
 *      The AI can NEVER flip the verdict; `verdict.verdict` is the source of truth.
 *
 * A validation failure (malformed output / missing fields) propagates as a
 * ZodError — the caller (todo 25) decides how to degrade the explanation.
 */
export async function explainCompatibility(
  verdict: CompatibilityResult,
  context: ExplainContext,
  gateway: AiGateway,
  options: ExplainOptions = {},
): Promise<Explanation> {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

  // 1. Prompt + prompt-side budget (truncate an oversized prompt).
  const prompt = truncateToTokens(buildPrompt(verdict, context), maxTokens);

  // 2. Structured output through the (injectable) gateway.
  const response = await gateway.generate(prompt, explanationSchema);

  // 3. Completion-side budget (refuse an overspending response).
  const usedTokens = response.usage.promptTokens + response.usage.completionTokens;
  if (usedTokens > maxTokens) {
    throw new SpendLimitExceededError(usedTokens, maxTokens);
  }

  // 4. Validate the structured output against the strict Zod schema.
  const parsed = explanationSchema.parse(response.object);

  // 5. §20 guard — the deterministic verdict is the source of truth.
  return {
    verdict: verdict.verdict,
    summary: parsed.summary,
    why: parsed.why,
    fix: parsed.fix,
  };
}

// ── Real gateway ───────────────────────────────────────────────────────────

/**
 * Creates the REAL gateway that calls Cloudflare AI Gateway via the Vercel AI
 * SDK. Uses `createOpenAICompatible` with the gateway endpoint as the base URL
 * and the gateway API token for authentication. The SDK appends
 * `/chat/completions` to the base URL, so the endpoint env var is stripped
 * of that suffix if present.
 *
 * Falls back to `AiGatewayNotAvailableError` when credentials are missing.
 */
export function createCloudflareAiGateway(
  model: string = DEFAULT_MODEL,
): AiGateway {
  const endpoint = process.env.CLOUDFLARE_AI_GATEWAY_ENDPOINT;
  const apiKey = process.env.CLOUDFLARE_AI_GATEWAY_API_TOKEN;

  if (!endpoint || !apiKey) {
    return {
      async generate() {
        throw new AiGatewayNotAvailableError(model);
      },
    };
  }

  const baseURL = endpoint.replace(/\/chat\/completions\/?$/, '');
  const provider = createOpenAICompatible({
    name: 'cloudflare',
    baseURL,
    apiKey,
  });

  return {
    async generate(prompt, schema) {
      const { object, usage } = await generateObject({
        model: provider(model),
        schema,
        prompt,
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

// Re-export the verdict vocabulary so callers can type-check the guard without
// importing rules.js directly.
export type { CompatibilityResult, CompatibilityVerdict };
