/**
 * §16 + §20 + S10 AI diagnostic explanation layer — what/why/fix over a
 * classified failure code (todo 29).
 *
 * The failure classifier (`classifyFailure`, todo 27) is the SINGLE SOURCE OF
 * TRUTH for the failure code. This layer wraps that code in a plain-English
 * what/why/fix explanation produced by a model behind Cloudflare AI Gateway.
 * It is deliberately THIN and mirrors todo 24's `ai-explainer.ts`:
 *
 * - §20 — the AI can NEVER flip the deterministic failure code. The
 *   `failureCode` field the model returns is validated for shape and then
 *   OVERRIDDEN with the deterministic value.
 * - §16 — the prompt NEVER includes raw log content. The input event is the
 *   Zod-validated structured event (`diagnosticEventSchema`, this todo's input
 *   edge), which REJECTS free-form log fields before anything reaches this
 *   layer. The prompt is built only from the deterministic code + structured
 *   fields.
 * - S10 — explanations only. The output schema has exactly three text fields
 *   (`what`, `why`, `fix`) plus the failure code, and is `.strict()`.
 *
 * The real gateway is the injectable `AiGateway` seam + spend-limit config
 * from ai-gateway.ts. When the gateway is unconfigured it throws
 * `AiGatewayNotAvailableError` and the caller degrades to deterministic
 * remediation text.
 */

import { z } from 'zod';

import {
  MAX_PROMPT_TOKENS,
  MAX_TOTAL_TOKENS,
  SpendLimitExceededError,
  truncateToTokens,
  type AiGateway,
} from './ai-gateway.js';
import {
  FAILURE_CODES,
  type FailureCode,
  type StructuredEvent,
} from './failure-codes.js';
import { redactSecrets } from './redact.js';

// ── Structured-output schema (S10: what/why/fix ONLY) ───────────────────────

/**
 * The Zod schema the model's structured output MUST satisfy.
 *
 * S10 made structural: exactly three text fields (`what`, `why`, `fix`) plus
 * the `failureCode` echo. There are NO fields for code, config, Terraform,
 * IAM, or infrastructure, and `.strict()` rejects ANY extra key — a model that
 * attempts to emit such content fails validation.
 */
export const diagnosticExplanationSchema = z
  .object({
    /**
     * The failure code the model thinks applies. IGNORED by the engine — the
     * deterministic code (todo 27) always wins (§20). It is still validated
     * here (must be a real §61 code) so a malformed echo fails early.
     */
    failureCode: z.enum(FAILURE_CODES),
    /** What went wrong — plain English, §65 jargon-free. */
    what: z.string(),
    /** Why it happened — plain English, §65 jargon-free. */
    why: z.string(),
    /** How to fix it — plain English, §65 jargon-free. */
    fix: z.string(),
  })
  .strict();

/** The validated diagnostic explanation (the AI text + the deterministic code). */
export type DiagnosticExplanation = z.infer<typeof diagnosticExplanationSchema>;

// ── Tunables ────────────────────────────────────────────────────────────────

/** Tunables for `explainDiagnostic`. */
export interface DiagnosticExplainOptions {
  /** Max total tokens (prompt + completion). Defaults to `MAX_TOTAL_TOKENS`. */
  readonly maxTokens?: number | undefined;
  /** Abort the gateway request when this signal fires (the caller's timeout). */
  readonly abortSignal?: AbortSignal | undefined;
}

// ── Prompt ──────────────────────────────────────────────────────────────────

/**
 * Build the prompt from the deterministic failure code + the structured event.
 *
 * §16 — the prompt is assembled ONLY from structured fields (`source`, `action`,
 * `signal`, `error.{code,statusCode,message}`, scalar `context` entries). There
 * is no raw-log field on `StructuredEvent`, and the input-edge schema
 * (`diagnosticEventSchema`) has already rejected any free-form log before this
 * point — so raw log content can never enter the AI payload.
 */
export function buildDiagnosticPrompt(
  failureCode: FailureCode,
  event: StructuredEvent,
): string {
  const lines = [
    'You are explaining a deterministic deployment failure to the application developer.',
    'The failure code was computed by a deterministic classifier, not by you — you only ' +
      'add plain-English explanation. Do NOT change the failure code.',
    '',
    `Deterministic failure code: ${failureCode}`,
    'Structured diagnostic event:',
    `  source: ${event.source}`,
  ];
  if (event.action !== undefined) lines.push(`  action: ${event.action}`);
  if (event.signal !== undefined) lines.push(`  signal: ${event.signal}`);
  if (event.error !== undefined) {
    lines.push('  error:');
    if (event.error.code !== undefined) lines.push(`    code: ${event.error.code}`);
    if (event.error.statusCode !== undefined) {
      lines.push(`    statusCode: ${event.error.statusCode}`);
    }
    if (event.error.message !== undefined) {
      lines.push(`    message: ${redactSecrets(event.error.message)}`);
    }
  }
  if (event.context !== undefined) {
    lines.push('  context:');
    for (const [key, value] of Object.entries(event.context)) {
      lines.push(`    ${key}: ${redactSecrets(JSON.stringify(value))}`);
    }
  }
  lines.push(
    '',
    'Respond with JSON matching the schema: {"failureCode", "what", "why", "fix"}.',
    '- what: what went wrong, in one or two plain sentences.',
    '- why: why it happened, in plain language.',
    '- fix: how to fix it, in plain language (or "contact support" if the developer cannot fix it).',
    'Use plain language only — no AWS/ECS/CFN/IAM service names, no code, no config, ' +
      'no raw log text.',
  );
  return lines.join('\n');
}

// ── The explainer ───────────────────────────────────────────────────────────

/**
 * Produce a Zod-validated, plain-English what/why/fix explanation of a
 * deterministic failure code.
 *
 * Pipeline (order matters):
 *   1. Build the prompt from the deterministic code + structured event, and
 *      truncate it to the token budget (prompt side).
 *   2. Ask the model for structured output via the injectable `AiGateway`.
 *   3. Refuse if the gateway's reported usage exceeds the budget (completion side).
 *   4. Validate the raw output against `diagnosticExplanationSchema` (strict —
 *      rejects malformed output, missing fields, and any code/config/infra content).
 *   5. §20 guard — override the model's `failureCode` with the deterministic value.
 *      The AI can NEVER flip the failure code; the deterministic code is the
 *      source of truth.
 *
 * A validation failure (malformed output / missing fields) propagates as a
 * ZodError — the caller (todo 30/31) decides how to degrade the explanation.
 */
export async function explainDiagnostic(
  failureCode: FailureCode,
  event: StructuredEvent,
  gateway: AiGateway,
  options: DiagnosticExplainOptions = {},
): Promise<DiagnosticExplanation> {
  const maxTokens = options.maxTokens ?? MAX_TOTAL_TOKENS;
  // The PROMPT budget is deliberately smaller than the TOTAL budget, so a
  // maximally truncated prompt still leaves room for a full completion. One
  // shared number makes the total check below unsatisfiable.
  const promptBudget = Math.min(MAX_PROMPT_TOKENS, maxTokens);

  // 1. Prompt + prompt-side budget (truncate an oversized prompt).
  const prompt = truncateToTokens(buildDiagnosticPrompt(failureCode, event), promptBudget);

  // 2. Structured output through the (injectable) gateway.
  const response = await gateway.generate(prompt, diagnosticExplanationSchema, {
    abortSignal: options.abortSignal,
  });

  // 3. Completion-side budget (refuse an overspending response).
  const usedTokens = response.usage.promptTokens + response.usage.completionTokens;
  if (usedTokens > maxTokens) {
    throw new SpendLimitExceededError(usedTokens, maxTokens);
  }

  // 4. Validate the structured output against the strict Zod schema.
  const parsed = diagnosticExplanationSchema.parse(response.object);

  // 5. §20 guard — the deterministic failure code is the source of truth.
  return {
    failureCode,
    what: parsed.what,
    why: parsed.why,
    fix: parsed.fix,
  };
}
