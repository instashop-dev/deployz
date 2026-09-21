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
  FIX_INSTRUCTIONS_TIMEOUT_MS,
  assembleFixInstructions,
  buildFixInstructionsAiPrompt,
  generateFixInstructions,
  summariseEnvRequirements,
  type FixInstructionsAiOutput,
  type FixInstructionsContext,
  type FixInstructionsFacts,
} from '../src/fix-instructions.js';
import type { ReadinessFinding } from '../src/readiness-report.js';

// ==========================================================================
// Fixtures
// ==========================================================================

const postgresFacts: FixInstructionsFacts = {
  runtime: 'node',
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
  envRequirements: null,
};

const noDbFacts: FixInstructionsFacts = {
  ...postgresFacts,
  database: 'none',
};

/** Required + fixable finding (container-setup). */
const containerFinding: ReadinessFinding = {
  id: 'container-setup',
  category: 'container',
  title: "Deployz doesn't know how to start your app",
  severity: 'required',
  blocking: false,
  plainEnglishExplanation: 'Deployz could not determine how to package and start this application.',
  whyItMatters: 'Deployz builds and runs your app in its own container for every customer.',
  technicalEvidence: 'No Dockerfile was found in the repository.',
  suggestedOutcome: 'Add container build instructions (a Dockerfile) that install, build, and start the app.',
  confidence: 'confirmed',
};

/** Recommended finding (database-migrations, unknown mode). */
const migrationFinding: ReadinessFinding = {
  id: 'database-migrations',
  category: 'database',
  title: 'Give Deployz a way to update your database',
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

/** Informational finding (migrations run at startup — nothing to do). */
const informationalFinding: ReadinessFinding = {
  ...migrationFinding,
  title: 'Database migrations run when the application starts',
  technicalEvidence: 'Migrations run at startup: migrate on boot (src/index.ts).',
  suggestedOutcome: 'No action needed — migrations run on application startup.',
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
// summariseEnvRequirements
// ==========================================================================

describe('summariseEnvRequirements', () => {
  it('returns null for a missing or non-array model', () => {
    expect(summariseEnvRequirements(undefined)).toBeNull();
    expect(summariseEnvRequirements(null)).toBeNull();
    expect(summariseEnvRequirements('nope')).toBeNull();
    expect(summariseEnvRequirements([])).toBeNull();
  });

  it('puts required vars read in code or required by a service at runtime', () => {
    const summary = summariseEnvRequirements([
      { key: 'STRIPE_SECRET_KEY', required: true, source: ['read in src/billing.ts'] },
      { key: 'SMTP_URL', required: true, source: ['smtp requires SMTP_URL'] },
    ]);
    expect(summary).toEqual({
      buildTime: [],
      runtime: ['SMTP_URL', 'STRIPE_SECRET_KEY'],
      platformInjected: [],
    });
  });

  it('puts required vars declared only in a build-context file at build time', () => {
    const summary = summariseEnvRequirements([
      { key: 'NPM_TOKEN', required: true, source: ['Dockerfile declares NPM_TOKEN'] },
    ]);
    expect(summary?.buildTime).toEqual(['NPM_TOKEN']);
    expect(summary?.runtime).toEqual([]);
  });

  it('keeps a Dockerfile-declared var at runtime when the code also reads it', () => {
    const summary = summariseEnvRequirements([
      {
        key: 'GA_ID',
        required: true,
        source: ['Dockerfile declares GA_ID', 'read in src/analytics.ts'],
      },
    ]);
    expect(summary?.runtime).toEqual(['GA_ID']);
    expect(summary?.buildTime).toEqual([]);
  });

  it('fails safe: a required var declared only outside build context lands at runtime', () => {
    const summary = summariseEnvRequirements([
      { key: 'FEATURE_TOKEN', required: true, source: ['.env declares FEATURE_TOKEN'] },
    ]);
    expect(summary?.runtime).toEqual(['FEATURE_TOKEN']);
  });

  it('routes platform-managed and platform-generated names to platformInjected', () => {
    const summary = summariseEnvRequirements([
      { key: 'DATABASE_URL', required: true, source: ['read in src/db.ts'], classification: 'deployz_managed' },
      { key: 'SESSION_SECRET', required: true, source: ['read in src/auth.ts'], classification: 'deployz_generated' },
      { key: 'STRIPE_KEY', required: true, source: ['read in src/billing.ts'] },
    ]);
    expect(summary).toEqual({
      buildTime: [],
      runtime: ['STRIPE_KEY'],
      platformInjected: ['DATABASE_URL', 'SESSION_SECRET'],
    });
  });
});

// ==========================================================================
// buildFixInstructionsAiPrompt
// ==========================================================================

describe('buildFixInstructionsAiPrompt', () => {
  it('contains the detected facts relevant to the blockers', () => {
    const prompt = buildFixInstructionsAiPrompt(baseContext);
    expect(prompt).toContain('express');
    expect(prompt).toContain('pnpm');
    expect(prompt).toContain('pnpm build');
    expect(prompt).toContain('node dist/index.js');
    expect(prompt).toContain('3000');
    expect(prompt).toContain('PostgreSQL');
  });

  it('contains every blocker id, its accurate name, and its evidence', () => {
    const prompt = buildFixInstructionsAiPrompt(baseContext);
    expect(prompt).toContain('id: container-setup');
    expect(prompt).toContain('name: Container packaging missing');
    expect(prompt).toContain('No Dockerfile was found in the repository.');
    expect(prompt).toContain('id: database-migrations');
    expect(prompt).toContain(
      'A PostgreSQL library is present (pg) but no migration script was found in any package.json.',
    );
  });

  it('carries the coding-agent rules (serving, invented details, scope, infrastructure, ambiguity)', () => {
    const prompt = buildFixInstructionsAiPrompt(baseContext);
    expect(prompt).toContain('Do not require a Dockerfile HEALTHCHECK');
    expect(prompt).toContain('Corepack applies to pnpm and yarn only, never npm');
    expect(prompt).toContain('never invent repository details');
    expect(prompt).toContain('npm run preview');
    expect(prompt).toContain('Never mention readiness endpoints');
    expect(prompt).toContain('Terraform, Kubernetes');
    expect(prompt).toContain('ambiguity instead of guessing');
  });

  it('embeds the deterministic steps and demands an empty generalNotes array', () => {
    const prompt = buildFixInstructionsAiPrompt(baseContext);
    expect(prompt).toContain('deterministic steps already given to the agent:');
    expect(prompt).toContain('Check existing deployment files first');
    expect(prompt).toContain('return generalNotes as an empty array');
    expect(prompt).toContain('never restate, summarize, or contradict them');
  });

  it('bounds the guidance length so the completion fits the synchronous request budget', () => {
    // Measured live against deepseek-v4-flash with thinking off: unbounded
    // guidance for four findings took ~27s (1179 completion tokens); bounded
    // to three sentences it took 8-9s (~430 tokens). The route has under 30s
    // end to end, so the bound is load-bearing.
    const prompt = buildFixInstructionsAiPrompt(baseContext);
    expect(prompt).toContain('at most three sentences');
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

  it('skips informational findings whose outcome requires no action', () => {
    const prompt = buildFixInstructionsAiPrompt({
      ...baseContext,
      findings: [containerFinding, informationalFinding],
    });
    expect(prompt).toContain('id: container-setup');
    expect(prompt).not.toContain('Migrations run at startup');
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

  it('is structured around the six required sections in order', () => {
    const doc = assembleFixInstructions(baseContext, aiOutput);
    const sections = [
      '## Repository facts',
      '## Blocking issues',
      '## Required outcome',
      '## Implementation guidance',
      '## Validation',
      '## Completion report',
    ];
    let cursor = 0;
    for (const section of sections) {
      const at = doc.indexOf(section);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('names blockers accurately instead of the plain-English UI titles', () => {
    const doc = assembleFixInstructions(baseContext, aiOutput);
    expect(doc).toContain('**Container packaging missing**');
    expect(doc).toContain('**Database migration command missing** (recommended)');
    expect(doc).not.toContain("Deployz doesn't know how to start your app");
    expect(doc).not.toContain('Give Deployz a way to update your database');
  });

  it('grounds each blocker in evidence and a required outcome', () => {
    const doc = assembleFixInstructions(baseContext, aiOutput);
    expect(doc).toContain('Evidence: No Dockerfile was found in the repository.');
    expect(doc).toContain(
      'Container packaging missing: Add container build instructions (a Dockerfile) that install, build, and start the app.',
    );
  });

  it('adds a verify note only for non-confirmed blockers', () => {
    const doc = assembleFixInstructions(baseContext, aiOutput);
    expect(doc).toContain('verify first: static analysis can miss an existing solution');
    expect(doc).not.toContain('confirm this applies before changing anything');

    const ambiguous = assembleFixInstructions(
      { ...baseContext, findings: [{ ...containerFinding, confidence: 'needs_confirmation' }] },
      { perFinding: [], generalNotes: [] },
    );
    expect(ambiguous).toContain('confirm this applies before changing anything');
  });

  it('carries deterministic guidance and embeds AI guidance under the same blocker', () => {
    const doc = assembleFixInstructions(baseContext, aiOutput);
    expect(doc).toContain('Check existing deployment files first');
    expect(doc).toContain('Add a multi-stage Dockerfile that builds and runs the app.');
  });

  it('never renders AI generalNotes (the scope-creep channel stays closed)', () => {
    const doc = assembleFixInstructions(baseContext, aiOutput);
    expect(doc).not.toContain('Notes:');
    expect(doc).not.toContain('Double-check the Node version');
  });

  it('remains a complete document when perFinding is empty', () => {
    const emptyAi: FixInstructionsAiOutput = { perFinding: [], generalNotes: [] };
    const doc = assembleFixInstructions(baseContext, emptyAi);

    expect(doc).toContain('Check existing deployment files first');
    expect(doc).toContain(FIX_INSTRUCTIONS_GUARDRAIL);
    expect(doc).toContain('**Container packaging missing**');
    expect(doc).toContain('## Validation');
    expect(doc).toContain('## Completion report');
  });

  it('omits informational findings that require no action', () => {
    const doc = assembleFixInstructions(
      { ...baseContext, findings: [containerFinding, informationalFinding] },
      aiOutput,
    );
    expect(doc).not.toContain('No action needed');
    expect(doc).not.toContain('Migrations run at startup');
  });

  it('renders only detected facts the included blockers justify', () => {
    const doc = assembleFixInstructions(
      { ...baseContext, findings: [containerFinding], facts: { ...noDbFacts, migrationCommand: null } },
      aiOutput,
    );
    // Packaging-relevant facts are in…
    expect(doc).toContain('- Runtime:');
    expect(doc).toContain('- Package manager: pnpm');
    // …and unrequested or undetected ones stay out.
    expect(doc).not.toContain('Migration command');
    expect(doc).not.toContain('not detected');
  });

  it('includes the disposable-database validation line only for the migration blocker', () => {
    const withMigration = assembleFixInstructions(baseContext, aiOutput);
    expect(withMigration).toContain('disposable local database only');

    const containerOnly = assembleFixInstructions(
      { ...baseContext, findings: [containerFinding] },
      aiOutput,
    );
    expect(containerOnly).not.toContain('disposable local database only');
  });

  it('contains a completion-report section', () => {
    const doc = assembleFixInstructions(baseContext, aiOutput);
    expect(doc).toContain('## Completion report');
    expect(doc).toContain('do not claim success for steps not run');
  });
});

// ==========================================================================
// Representative repository shapes
// ==========================================================================

describe('assembleFixInstructions — representative repository shapes', () => {
  const emptyAi: FixInstructionsAiOutput = { perFinding: [], generalNotes: [] };

  it('missing container packaging: names the blocker and pins the detected toolchain', () => {
    const doc = assembleFixInstructions(
      { ...baseContext, facts: postgresFacts, findings: [containerFinding] },
      emptyAi,
    );
    expect(doc).toContain('**Container packaging missing**');
    expect(doc).toContain('(`pnpm`, via Corepack when package.json declares `packageManager`)');
    expect(doc).toContain('(`pnpm build`)');
    expect(doc).toContain('with `node dist/index.js`');
    expect(doc).toContain('- Build the container image when Docker is available.');
  });

  it('missing readiness endpoint: reuse first, smallest route second, no Dockerfile HEALTHCHECK', () => {
    const healthFinding: ReadinessFinding = {
      id: 'health-check',
      category: 'health',
      title: 'Give Deployz a way to check your app',
      severity: 'required',
      blocking: false,
      plainEnglishExplanation: 'Deployz needs a reliable way to know when your app is running and ready.',
      whyItMatters: 'Deployz waits for a health signal during deployments.',
      technicalEvidence: 'No health endpoint or container health check was found.',
      suggestedOutcome: 'Expose a lightweight route that returns success once the app is ready.',
      confidence: 'likely',
    };
    const doc = assembleFixInstructions(
      { ...baseContext, facts: noDbFacts, findings: [healthFinding] },
      emptyAi,
    );
    expect(doc).toContain('**Readiness endpoint missing**');
    expect(doc).toContain('reuse a suitable one instead of adding a new route');
    expect(doc).toContain('no redirect, no auth, no expensive work');
    expect(doc).toContain('A Dockerfile HEALTHCHECK instruction is not required');
    expect(doc).toContain('confirm a direct HTTP 2xx response with no redirect');
  });

  it('existing valid Dockerfile: treated as evidence, referenced by name', () => {
    const startFinding: ReadinessFinding = {
      id: 'start-command-missing',
      category: 'container',
      title: 'Tell Deployz how to start your app',
      severity: 'required',
      blocking: false,
      plainEnglishExplanation: 'Deployz found container instructions but no command that starts the app.',
      whyItMatters: 'Without a start command the container exits immediately.',
      technicalEvidence: 'The Dockerfile has no CMD or ENTRYPOINT instruction.',
      suggestedOutcome: 'Add a CMD or ENTRYPOINT instruction to the Dockerfile.',
      confidence: 'confirmed',
    };
    const doc = assembleFixInstructions(
      {
        ...baseContext,
        facts: { ...postgresFacts, dockerfilePath: 'Dockerfile' },
        findings: [startFinding],
      },
      emptyAi,
    );
    expect(doc).toContain('- Container build file: Dockerfile');
    expect(doc).toContain('Add a CMD or ENTRYPOINT to Dockerfile');
    expect(doc).toContain('(`node dist/index.js`)');
  });

  it('existing health endpoint: validation reuses the configured path', () => {
    const healthFinding: ReadinessFinding = {
      id: 'health-check',
      category: 'health',
      title: 'Give Deployz a way to check your app',
      severity: 'required',
      blocking: false,
      plainEnglishExplanation: 'Deployz needs a reliable way to know when your app is running and ready.',
      whyItMatters: 'Deployz waits for a health signal during deployments.',
      technicalEvidence: 'No health endpoint or container health check was found.',
      suggestedOutcome: 'Expose a lightweight route that returns success once the app is ready.',
      confidence: 'likely',
    };
    const doc = assembleFixInstructions(
      {
        ...baseContext,
        facts: { ...noDbFacts, healthPath: '/api/status' },
        findings: [healthFinding],
      },
      emptyAi,
    );
    expect(doc).toContain('- Configured health path: /api/status');
    expect(doc).toContain('(`/api/status`)');
  });

  it('monorepo workspace: build context and application directory render', () => {
    const doc = assembleFixInstructions(
      {
        ...baseContext,
        facts: { ...postgresFacts, workingDirectory: 'apps/web' },
        findings: [containerFinding],
      },
      emptyAi,
    );
    expect(doc).toContain('- Application directory (workspace): apps/web');
    expect(doc).toContain('with `apps/web` as the build context');
  });

  it('npm: version guidance comes from engines/.nvmrc, not Corepack', () => {
    const doc = assembleFixInstructions(
      { ...baseContext, facts: { ...postgresFacts, packageManager: 'npm', buildCommand: 'npm run build' } },
      emptyAi,
    );
    expect(doc).toContain('match the Node and npm versions from `engines`/`.nvmrc`');
    expect(doc).not.toContain('via Corepack');
  });

  it('no detected start command: static-output serving guidance', () => {
    const doc = assembleFixInstructions(
      { ...baseContext, facts: { ...postgresFacts, startCommand: null } },
      emptyAi,
    );
    expect(doc).toContain('serve the built files with a production-grade static server');
    expect(doc).toContain('never a dev or preview server');
  });

  it('unknown port: validation points at the Dockerfile as the declaration point', () => {
    const doc = assembleFixInstructions(
      { ...baseContext, facts: { ...postgresFacts, port: null }, findings: [containerFinding] },
      emptyAi,
    );
    expect(doc).toContain('the port the Dockerfile declares');
  });

  it('build-time and runtime env requirements render separately with platform-provided names', () => {
    const doc = assembleFixInstructions(
      {
        ...baseContext,
        facts: {
          ...postgresFacts,
          envRequirements: {
            buildTime: ['NPM_TOKEN'],
            runtime: ['STRIPE_SECRET_KEY'],
            platformInjected: ['DATABASE_URL', 'PORT'],
          },
        },
        findings: [containerFinding],
      },
      emptyAi,
    );
    expect(doc).toContain('- Required at build time (names only): NPM_TOKEN');
    expect(doc).toContain('- Required at runtime (names only): STRIPE_SECRET_KEY');
    expect(doc).toContain('- Provided by the platform at runtime (names only): DATABASE_URL, PORT');
  });

  it('env requirements stay out when no packaging blocker justifies them', () => {
    const healthFinding: ReadinessFinding = {
      id: 'health-check',
      category: 'health',
      title: 'Give Deployz a way to check your app',
      severity: 'required',
      blocking: false,
      plainEnglishExplanation: 'Deployz needs a reliable way to know when your app is running and ready.',
      whyItMatters: 'Deployz waits for a health signal during deployments.',
      technicalEvidence: 'No health endpoint or container health check was found.',
      suggestedOutcome: 'Expose a lightweight route that returns success once the app is ready.',
      confidence: 'likely',
    };
    const doc = assembleFixInstructions(
      {
        ...baseContext,
        facts: {
          ...noDbFacts,
          envRequirements: { buildTime: ['NPM_TOKEN'], runtime: ['STRIPE_SECRET_KEY'], platformInjected: [] },
        },
        findings: [healthFinding],
      },
      emptyAi,
    );
    expect(doc).not.toContain('NPM_TOKEN');
    expect(doc).not.toContain('STRIPE_SECRET_KEY');
  });

  it('ambiguous blockers instruct the agent to report instead of guess', () => {
    const doc = assembleFixInstructions(
      {
        ...baseContext,
        findings: [{ ...migrationFinding, confidence: 'needs_confirmation' }],
      },
      emptyAi,
    );
    expect(doc).toContain('confirm this applies before changing anything');
    expect(doc).toContain('report the ambiguity instead of guessing');
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
    expect(doc).toContain('Add a Dockerfile that builds and runs the app.');
    expect(seenOptions?.label).toBe('fix-instructions');
    expect(seenOptions?.maxOutputTokens).toBe(FIX_INSTRUCTIONS_MAX_OUTPUT_TOKENS);
    expect(seenOptions?.reasoning).toBe(false);
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

// ==========================================================================
// Synchronous request budget
// ==========================================================================

describe('FIX_INSTRUCTIONS_TIMEOUT_MS', () => {
  it('abandons generation before the API Lambda and HTTP API 30-second limits', () => {
    // The route runs inside a 30s Lambda behind a 30s HTTP API integration.
    // An abort at or above that mark never fires: the platform kills the
    // request first, the vendor gets an opaque gateway error, and the
    // 'fix-instructions generation failed' log line is never written.
    expect(FIX_INSTRUCTIONS_TIMEOUT_MS).toBeLessThan(30_000);
  });
});
