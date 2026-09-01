import { AiGatewayNotAvailableError, type AiGateway } from '@deployz/analysis';

// AI fixture gateway (AI_FIXTURE_MODE) — mirrors GITHUB_FIXTURE_MODE /
// DOMAIN_FIXTURE_MODE so the E2E suite can exercise the fix-instructions flow
// without a live model or credentials. Responses are canned per call label
// and schema-valid; any label without a fixture throws the same error an
// unconfigured gateway would, so degraded paths stay exercised as degraded.

const FIXTURE_RESPONSES: Record<string, unknown> = {
  // fix-instructions.ts (packages/analysis) — no per-finding guidance; the
  // deterministically assembled document is complete without it.
  'fix-instructions': {
    perFinding: [],
    generalNotes: ['Verify each finding against the repository before making changes.'],
  },
  // repository-ai.ts §15 fallback — resolves nothing, so the deterministic
  // metadata stands exactly as the real degraded path would leave it.
  'repository-analysis': {
    workingDirectory: '.',
    buildCommand: null,
    startCommand: null,
    port: null,
    postgres: { required: false, evidence: [] },
    redis: { required: false, evidence: [] },
    migrationCommand: null,
    warnings: [],
  },
};

/** A canned AiGateway for fixture mode. */
export function createFixtureAiGateway(): AiGateway {
  return {
    async generate(_prompt, schema, options) {
      const fixture = FIXTURE_RESPONSES[options?.label ?? ''];
      if (fixture === undefined) {
        throw new AiGatewayNotAvailableError(`fixture:${options?.label ?? 'unlabelled'}`);
      }
      return { object: schema.parse(fixture), usage: { promptTokens: 0, completionTokens: 0 } };
    },
  };
}
