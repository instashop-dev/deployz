import type { JevClient, JevEvaluateResult } from './client.js';
import { JevError } from './errors.js';
import { jevResponseSchema, type JevAnswer, type JevUsage } from './schemas.js';

// Jev fixture client — mirrors apps/api's ai-fixture gateway so offline and
// integration tests drive the full shadow flow without a live model or
// credentials. Responses are canned per evaluate label and schema-valid; any
// label without a fixture throws the same error an unconfigured client would.

/** One canned response: the answers, plus optional model and usage overrides. */
export interface FixtureJevResponse {
  readonly answers: Record<string, JevAnswer>;
  readonly model?: string;
  readonly usage?: JevUsage;
}

/** A canned JevClient for offline tests. */
export function createFixtureJevClient(
  responses: Record<string, FixtureJevResponse>,
): JevClient {
  return {
    async evaluate(_state, _questions, options = { label: 'evaluate' }) {
      const fixture = responses[options.label];
      if (fixture === undefined) {
        throw new JevError('unconfigured', { attempts: 0 });
      }
      const parsed = jevResponseSchema.parse({
        model: fixture.model ?? 'jev-fixture',
        answers: fixture.answers,
        usage: fixture.usage ?? { input_tokens: 0, output_tokens: 0 },
      });
      const result: JevEvaluateResult = {
        answers: parsed.answers,
        model: parsed.model,
        usage: parsed.usage,
        latencyMs: 0,
        attempts: 1,
      };
      return result;
    },
  };
}
