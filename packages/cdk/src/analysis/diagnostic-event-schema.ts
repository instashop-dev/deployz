/**
 * §16 data boundary — the INPUT-EDGE Zod schema for structured diagnostic events.
 *
 * This is the load-bearing §16 enforcement point: Deployz stores operational
 * metadata only; NO raw application logs ever leave the customer account. This
 * schema REJECTS free-form log fields BEFORE anything reaches the classifier
 * (todo 27) or the AI explanation payloads (this todo's explainer).
 *
 * The schema is `.strict()` and carries NO field capable of holding a raw log
 * line — `log`, `logs`, `rawLog`, `stdout`, `stderr`, `output`, `stack`,
 * `detail`, or a top-level `message`. The ONE concession is `error.message`:
 * a structured AWS error message (e.g. "explicit deny in a service control
 * policy"), never a raw application log.
 *
 * The validated event mirrors todo 27's `StructuredEvent`, now Zod-enforced.
 * Optional fields use `exactOptional()` (not `optional()`) so the inferred type
 * stays assignable to `StructuredEvent` under `exactOptionalPropertyTypes`.
 */

import { z } from 'zod';

// ── Known sources ──────────────────────────────────────────────────────────

/**
 * The eight structured event sources the input edge admits. Anything else is a
 * parse error — the classifier's `source: string` over-permissiveness is
 * deliberately tightened here at the boundary.
 */
export const DIAGNOSTIC_EVENT_SOURCES = [
  'relay',
  'ecs',
  'rds',
  'cloudformation',
  'health-check',
  'install',
  'deploy',
  'preflight',
] as const;

/** A known diagnostic event source. */
export type DiagnosticEventSource = (typeof DIAGNOSTIC_EVENT_SOURCES)[number];

// ── The §16 input-edge schema ──────────────────────────────────────────────

/**
 * Structured scalar values ONLY for `context` — string, number, or boolean.
 * No object/array/null may smuggle a nested raw-log blob through the context
 * record.
 */
const diagnosticContextValue = z.union([z.string(), z.number(), z.boolean()]);

/**
 * The structured diagnostic event, enforced at the input edge.
 *
 * `.strict()` (top-level AND inside `error`) rejects any unknown key rather
 * than silently stripping it, so a free-form log field (`log`, `stdout`,
 * `stderr`, `rawLog`, `output`, `stack`, `detail`, top-level `message`) is a
 * ZodError. The only free-text concession is `error.message` — a structured
 * AWS error message, not a raw application log.
 */
export const diagnosticEventSchema = z
  .object({
    source: z.enum(DIAGNOSTIC_EVENT_SOURCES),
    action: z.string().exactOptional(),
    signal: z.string().exactOptional(),
    error: z
      .object({
        code: z.string().exactOptional(),
        message: z.string().exactOptional(),
        statusCode: z.number().int().exactOptional(),
      })
      .strict()
      .exactOptional(),
    context: z.record(z.string(), diagnosticContextValue).exactOptional(),
  })
  .strict();

/** The validated structured diagnostic event (assignable to `StructuredEvent`). */
export type DiagnosticEvent = z.infer<typeof diagnosticEventSchema>;

/**
 * Parse + validate a raw input against the §16 input-edge schema.
 *
 * A raw-log-bearing input throws a ZodError here — it NEVER reaches the
 * classifier or the AI payloads.
 */
export function parseDiagnosticEvent(input: unknown): DiagnosticEvent {
  return diagnosticEventSchema.parse(input);
}
