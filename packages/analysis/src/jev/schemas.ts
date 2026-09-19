/**
 * Jev wire schemas — the typed decision model's strict request/response
 * shapes, discriminated on `type` for both questions and answers.
 *
 * PR 1 foundation: nothing constructs requests from these yet; the client
 * validates every gateway response against `jevResponseSchema`, so a contract
 * drift surfaces as a `malformed` JevError instead of untyped data reaching
 * callers. `.strict()` rejects any field outside the documented shape.
 */

import { z } from 'zod';

// ── Request ─────────────────────────────────────────────────────────────────

/** `instructions` is free-form by design: prose, an ordered list, or a keyed map. */
export const jevInstructionsSchema = z.union([
  z.string(),
  z.array(z.string()),
  z.record(z.string(), z.unknown()),
]);

/** The state the model decides over: prose, a structure, or a list. */
export const jevStateSchema = z.union([
  z.string(),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
]);
export type JevState = z.infer<typeof jevStateSchema>;

/** Yes/no. Criteria describe what a 1 (yes) and a 0 (no) mean. */
export const jevNoulQuestionSchema = z
  .object({
    type: z.literal('noul'),
    instructions: jevInstructionsSchema,
    criteria: z.object({ true: z.string(), false: z.string() }).optional(),
  })
  .strict();

/** Multiple choice: one criteria entry per option, `null` for no mapped level. */
export const jevChoiceQuestionSchema = z
  .object({
    type: z.literal('choice'),
    instructions: jevInstructionsSchema,
    criteria: z.record(z.string(), z.string().nullable()),
  })
  .strict();

/** Ordered scale: at least two levels, weakest first. */
export const jevScoreQuestionSchema = z
  .object({
    type: z.literal('score'),
    instructions: jevInstructionsSchema,
    criteria: z.array(z.string()).min(2),
  })
  .strict();

export const jevQuestionSchema = z.discriminatedUnion('type', [
  jevNoulQuestionSchema,
  jevChoiceQuestionSchema,
  jevScoreQuestionSchema,
]);
export type JevQuestion = z.infer<typeof jevQuestionSchema>;

export const jevRequestSchema = z
  .object({
    state: jevStateSchema,
    model: z.string(),
    questions: z.record(z.string(), jevQuestionSchema),
  })
  .strict();
export type JevRequest = z.infer<typeof jevRequestSchema>;

// ── Response ────────────────────────────────────────────────────────────────

/** Noul answer: the model's probability the answer is yes (0–1). */
export const jevNoulAnswerSchema = z
  .object({
    type: z.literal('noul'),
    noul: z.number().min(0).max(1),
  })
  .strict();

/** Choice answer: the picked option plus its probability distribution. */
export const jevChoiceAnswerSchema = z
  .object({
    type: z.literal('choice'),
    choice: z.string(),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number(),
  })
  .strict();

/** Score answer: the level index, its legend text, and the distribution over levels. */
export const jevScoreAnswerSchema = z
  .object({
    type: z.literal('score'),
    score: z.number(),
    legend: z.record(z.string(), z.string()),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number(),
  })
  .strict();

export const jevAnswerSchema = z.discriminatedUnion('type', [
  jevNoulAnswerSchema,
  jevChoiceAnswerSchema,
  jevScoreAnswerSchema,
]);
export type JevAnswer = z.infer<typeof jevAnswerSchema>;

export const jevUsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  })
  .strict();
export type JevUsage = z.infer<typeof jevUsageSchema>;

export const jevResponseSchema = z
  .object({
    model: z.string(),
    answers: z.record(z.string(), jevAnswerSchema),
    usage: jevUsageSchema,
  })
  .strict();
export type JevResponse = z.infer<typeof jevResponseSchema>;
