import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  SpendLimitExceededError,
  type AiGateway,
  type AiGatewayResponse,
  type AiGenerateOptions,
} from '../src/ai-gateway.js';
import {
  FIX_INSTRUCTIONS_GUARDRAIL,
  FIX_INSTRUCTIONS_MAX_OUTPUT_TOKENS,
  FIX_INSTRUCTIONS_MAX_TOTAL_TOKENS,
  assembleFixInstructions,
  buildFixInstructionsAiPrompt,
  generateFixInstructions,
  type FixInstructionsAiOutput,
  type FixInstructionsContext,
  type FixInstructionsFacts,
} from '../src/fix-instructions.js';
import type { ReadinessFinding } from '../src/readiness-report.js';

// ==========================================================================
// Fixtures
// ==========================================================================

const postgresFacts: FixInstructionsFacts = {
  framework: 'express',
  packageManager: 'pnpm',
  buildCommand: 'pnpm build',
  startCommand: 'node dist/index.js',
  port: '3000',
  dockerfilePath: null,
  database: 'postgres',
  migrationCommand: null,
  healthPath: '/health',
  redisRequired: false,
  workingDirectory: null,
};

const noDbFacts: FixInstructionsFacts = {
  ...postgresFacts,
  database: 'none',
};

/** Required + fixable finding (container-setup). */
const containerFinding: ReadinessFinding = {
  id: 'container-setup',
  category: 'container',
  title: 'Container setup',
  severity: 'required',
  blocking: false,
  plainEnglishExplanation: 'Deployz could not determine how to package and start this application.',
  whyItMatters: 'Deployz builds and runs your app in its own container for every customer.',
  technicalEvidence: 'No Dockerfile was found in the repository.',
  suggestedOutcome: 'Add container build instructions (a Dockerfile) that install, build, and start the app.',
  confidence: 'confirmed',
};

/** Recommended finding (database-migrations). */
const migrationFinding: ReadinessFinding = {
  id: 'database-migrations',
  category: 'database',
  title: 'Database migrations',
  severity: 'recommended',
  blocking: false,
  plainEnglishExplanation:
    'This app uses a database, but Deployz could not find a command that updates the database structure during deploys.',
  whyItMatters: 'Deployz runs your migration command automatically on every deploy.',
  technicalEvidence:
    'A PostgreSQL library is present (pg) but no migration script was found in any package.json.',
  suggestedOutcome: 'Add a script that applies database migrations non-interactively.',
  confidence: 'likely',
};

const baseContext: FixInstructionsContext = {
  repoFullName: 'acme/widget-api',
  commitSha: 'abc123def456',
  facts: postgresFacts,
  findings: [containerFinding, migrationFinding],
};

function fixtureGateway(response: AiGatewayResponse): AiGateway {
  return { async generate() { return response; } };
}

// ==========================================================================
// buildFixInstructionsAiPrompt
// ==========================================================================

describe('buildFixInstructionsAiPrompt', () => {
  it('contains the detected facts', () => {
    const prompt = buildFixInstructionsAiPrompt(baseContext);
    expect(prompt).toContain('express');
    expect(prompt).toContain('pnpm');
    expect(prompt).toContain('pnpm build');
    expect(prompt).toContain('node dist/index.js');
    expect(prompt).toContain('3000');
    expect(prompt).toContain('PostgreSQL');
  });

  it('contains every finding id and its evidence', () => {
    const prompt = buildFixInstructionsAiPrompt(baseContext);
    expect(prompt).toContain('id: container-setup');
    expect(prompt).toContain('No Dockerfile was found in the repository.');
    expect(prompt).toContain('id: database-migrations');
    expect(prompt).toContain(
      'A PostgreSQL library is present (pg) but no migration script was found in any package.json.',
    );
  });

  it('does not contain repository file contents', () => {
    const prompt = buildFixInstructionsAiPrompt(baseContext);
    // FixInstructionsContext carries only structured facts and finding
    // evidence — never raw source. Guard against a regression that starts
    // embedding actual file bodies (import statements, code fences, etc).
    expect(prompt).not.toContain('```');
    expect(prompt).not.toContain('import express');
    expect(prompt).not.toContain('app.listen(');
  });
});

// ==========================================================================
// assembleFixInstructions
// ==========================================================================

describe('assembleFixInstructions', () => {
  const aiOutput: FixInstructionsAiOutput = {
    perFinding: [{ id: 'container-setup', guidance: 'Add a multi-stage Dockerfile that builds and runs the app.' }],
    generalNotes: ['Double-check the Node version pinned in the Dockerfile matches CI.'],
  };

  it('contains the guardrail verbatim', () => {
    const doc = assembleFixInstructions(baseContext, aiOutput);
    expect(doc).toContain(FIX_INSTRUCTIONS_GUARDRAIL);
  });

  it('contains the objective line', () => {
    const doc = assembleFixInstructions(baseContext, aiOutput);
    expect(doc).toContain('Prepare this repository for deployment through Deployz');
  });

  it('contains a per-finding section with a severity label for every finding', () => {
    const doc = assembleFixInstructions(baseContext, aiOutput);
    expect(doc).toContain('### 1. Container setup (REQUIRED)');
    expect(doc).toContain('### 2. Database migrations (RECOMMENDED)');
  });

  it('includes the disposable-database validation line only when database is postgres', () => {
    const withDb = assembleFixInstructions(baseContext, aiOutput);
    expect(withDb).toContain('Validate the migration command against a disposable local database only');

    const withoutDb = assembleFixInstructions({ ...baseContext, facts: noDbFacts }, aiOutput);
    expect(withoutDb).not.toContain('Validate the migration command against a disposable local database only');
  });

  it('contains a completion-report section', () => {
    const doc = assembleFixInstructions(baseContext, aiOutput);
    expect(doc).toContain('## Completion report');
    expect(doc).toContain('Do not claim success for tests or validations that were not actually run.');
  });

  it('embeds AI guidance for a finding whose id matches', () => {
    const doc = assembleFixInstructions(baseContext, aiOutput);
    expect(doc).toContain('Implementation guidance: Add a multi-stage Dockerfile that builds and runs the app.');
  });

  it('remains a complete document when perFinding is empty', () => {
    const emptyAi: FixInstructionsAiOutput = { perFinding: [], generalNotes: [] };
    const doc = assembleFixInstructions(baseContext, emptyAi);

    expect(doc).not.toContain('Implementation guidance:');
    expect(doc).toContain(FIX_INSTRUCTIONS_GUARDRAIL);
    expect(doc).toContain('### 1. Container setup (REQUIRED)');
    expect(doc).toContain('### 2. Database migrations (RECOMMENDED)');
    expect(doc).toContain('## Validation');
    expect(doc).toContain('## Completion report');
  });
});

// ==========================================================================
// generateFixInstructions
// ==========================================================================

const validAiObject: FixInstructionsAiOutput = {
  perFinding: [{ id: 'container-setup', guidance: 'Add a Dockerfile that builds and runs the app.' }],
  generalNotes: [],
};

describe('generateFixInstructions', () => {
  it('happy path: assembles the document via the injected gateway', async () => {
    let seenOptions: AiGenerateOptions | undefined;
    const gateway: AiGateway = {
      async generate(_prompt, _schema, options) {
        seenOptions = options;
        return { object: validAiObject, usage: { promptTokens: 500, completionTokens: 100 } };
      },
    };

    const doc = await generateFixInstructions(baseContext, gateway);

    expect(doc).toContain(FIX_INSTRUCTIONS_GUARDRAIL);
    expect(doc).toContain('Implementation guidance: Add a Dockerfile that builds and runs the app.');
    expect(seenOptions?.label).toBe('fix-instructions');
    expect(seenOptions?.maxOutputTokens).toBe(FIX_INSTRUCTIONS_MAX_OUTPUT_TOKENS);
  });

  it('throws on a schema-violating response', async () => {
    await expect(
      generateFixInstructions(
        baseContext,
        fixtureGateway({
          object: { perFinding: 'nope', generalNotes: 'also nope' },
          usage: { promptTokens: 500, completionTokens: 100 },
        }),
      ),
    ).rejects.toBeInstanceOf(z.ZodError);
  });

  it('throws SpendLimitExceededError when reported usage exceeds the total-token budget', async () => {
    await expect(
      generateFixInstructions(
        baseContext,
        fixtureGateway({
          object: validAiObject,
          usage: { promptTokens: FIX_INSTRUCTIONS_MAX_TOTAL_TOKENS, completionTokens: 1 },
        }),
      ),
    ).rejects.toBeInstanceOf(SpendLimitExceededError);
  });

  it('propagates an abort/gateway error from the gateway unchanged', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    const gateway: AiGateway = {
      async generate() {
        throw abortError;
      },
    };

    await expect(generateFixInstructions(baseContext, gateway)).rejects.toBe(abortError);
  });

  it('propagates a network/gateway failure unchanged', async () => {
    const networkError = new Error('fetch failed');
    const gateway: AiGateway = {
      async generate() {
        throw networkError;
      },
    };

    await expect(generateFixInstructions(baseContext, gateway)).rejects.toBe(networkError);
  });
});
