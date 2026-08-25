/**
 * §20 + S10 AI explanation layer — human-language explanation over the
 * deterministic compatibility verdict (todo 23).
 *
 * The rules engine (`evaluateCompatibility`) is the SINGLE SOURCE OF TRUTH for
 * the readiness verdict. This layer wraps that verdict in a plain-English
 * explanation produced by a model behind Cloudflare AI Gateway. It is
 * deliberately THIN:
 *
 * - §20 — the AI can NEVER flip the deterministic verdict. The `verdict` field
 *   the model returns is validated for shape and then OVERRIDDEN with the
 *   deterministic value. A guard test proves a model trying to flip READY →
 *   NOT_COMPATIBLE cannot.
 * - S10 — explanations ONLY. The Zod schema has exactly three text fields plus
 *   the verdict. It has NO fields for code, config, Terraform, IAM, or
 *   infrastructure, and it is `.strict()`, so any such content the model
 *   hallucinates into an extra field is rejected at parse time.
 * - Spend limits — a per-request token budget enforced by truncating an
 *   oversized prompt and refusing a response whose reported usage exceeds it.
 *
 * The gateway seam itself (`AiGateway`, `createAiGateway`, the token budget)
 * lives in `@deployz/analysis` so `apps/api` can reach it without closing a
 * dependency cycle; this module re-exports it for existing callers.
 *
 * NOTE: unlike the diagnostic explainer, this compatibility explainer is not
 * yet wired into a route — `apps/web/src/lib/readiness.ts` documents that the
 * readiness page deliberately carries no AI field on the wire.
 */

import { z } from 'zod';

import {
  MAX_PROMPT_TOKENS,
  MAX_TOTAL_TOKENS,
  SpendLimitExceededError,
  truncateToTokens,
  type AiGateway,
} from '@deployz/analysis';

import type { CompatibilityResult, CompatibilityVerdict } from './rules.js';

// ── Re-exported gateway seam ────────────────────────────────────────────────

export type {
  AiGateway,
  AiGatewayConfig,
  AiGatewayResponse,
  AiGenerateOptions,
  TokenUsage,
} from '@deployz/analysis';
export {
  AiGatewayNotAvailableError,
  MAX_OUTPUT_TOKENS,
  MAX_PROMPT_TOKENS,
  MAX_TOTAL_TOKENS,
  SpendLimitExceededError,
  createAiGateway,
  estimateTokens,
  truncateToTokens,
} from '@deployz/analysis';

/**
 * The total per-request token budget (prompt + completion).
 *
 * Kept as a named alias of `MAX_TOTAL_TOKENS` because the budget is now split
 * into a prompt half and a completion half — see `@deployz/analysis`'s
 * `ai-gateway.ts` for why one shared number could never be satisfied.
 */
export const DEFAULT_MAX_TOKENS = MAX_TOTAL_TOKENS;

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
  /** Max total tokens (prompt + completion). Defaults to `MAX_TOTAL_TOKENS`. */
  readonly maxTokens?: number | undefined;
  /** Abort the gateway request when this signal fires (the caller's timeout). */
  readonly abortSignal?: AbortSignal | undefined;
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
 *   1. Build the prompt and truncate it to the PROMPT budget.
 *   2. Ask the model for structured output via the injectable `AiGateway`.
 *   3. Refuse if the gateway's reported usage exceeds the TOTAL budget.
 *   4. Validate the raw output against `explanationSchema` (strict — rejects
 *      malformed output, missing fields, and any code/config/infra content).
 *   5. §20 guard — override the model's `verdict` with the deterministic value.
 *      The AI can NEVER flip the verdict; `verdict.verdict` is the source of truth.
 *
 * A validation failure (malformed output / missing fields) propagates as a
 * ZodError — the caller decides how to degrade the explanation.
 */
export async function explainCompatibility(
  verdict: CompatibilityResult,
  context: ExplainContext,
  gateway: AiGateway,
  options: ExplainOptions = {},
): Promise<Explanation> {
  const maxTokens = options.maxTokens ?? MAX_TOTAL_TOKENS;
  // The PROMPT budget is deliberately smaller than the TOTAL budget, so a
  // maximally truncated prompt still leaves room for a full completion.
  const promptBudget = Math.min(MAX_PROMPT_TOKENS, maxTokens);

  // 1. Prompt + prompt-side budget (truncate an oversized prompt).
  const prompt = truncateToTokens(buildPrompt(verdict, context), promptBudget);

  // 2. Structured output through the (injectable) gateway.
  const response = await gateway.generate(prompt, explanationSchema, {
    abortSignal: options.abortSignal,
  });

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

// Re-export the verdict vocabulary so callers can type-check the guard without
// importing rules.js directly.
export type { CompatibilityResult, CompatibilityVerdict };
