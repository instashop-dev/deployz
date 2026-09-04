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
  // metadata stands exactly as the real degraded path would leave it. The
  // answer carries the structured per-field shape with null values only.
  'repository-analysis': {
    dockerfile: { value: null, confidence: 0, evidencePaths: [], explanation: 'No answer provided by the fixture gateway.' },
    workingDirectory: { value: null, confidence: 0, evidencePaths: [], explanation: 'No answer provided by the fixture gateway.' },
    buildCommand: { value: null, confidence: 0, evidencePaths: [], explanation: 'No answer provided by the fixture gateway.' },
    startCommand: { value: null, confidence: 0, evidencePaths: [], explanation: 'No answer provided by the fixture gateway.' },
    port: { value: null, confidence: 0, evidencePaths: [], explanation: 'No answer provided by the fixture gateway.' },
    postgresRequired: { value: null, confidence: 0, evidencePaths: [], explanation: 'No answer provided by the fixture gateway.' },
    redisRequired: { value: null, confidence: 0, evidencePaths: [], explanation: 'No answer provided by the fixture gateway.' },
    healthPath: { value: null, confidence: 0, evidencePaths: [], explanation: 'No answer provided by the fixture gateway.' },
    migrationMode: { value: null, confidence: 0, evidencePaths: [], explanation: 'No answer provided by the fixture gateway.' },
    storageRequired: { value: null, confidence: 0, evidencePaths: [], explanation: 'No answer provided by the fixture gateway.' },
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
