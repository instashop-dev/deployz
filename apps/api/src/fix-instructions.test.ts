import { describe, expect, it } from 'vitest';

import {
  AiGatewayNotAvailableError,
  fixInstructionsAiSchema,
  repositoryAiSchema,
  type ReadinessFinding,
  type ReadinessReport,
} from '@deployz/analysis';

import { createFixtureAiGateway } from './ai-fixture.js';
import { buildFixInstructionsContext, readReadinessReport, type FixInstructionsSource } from './fix-instructions.js';

// Fix-instructions context assembly (apps/api/src/fix-instructions.ts) — turns
// a persisted application row into the structured context
// generateFixInstructions consumes. No repository file contents ever reach
// this layer, only the merged analysis metadata and the §35 contract fields.

function finding(overrides: Partial<ReadinessFinding> = {}): ReadinessFinding {
  return {
    id: 'health-check',
    category: 'health',
    title: 'Deployment health check',
    severity: 'required',
    blocking: false,
    plainEnglishExplanation: 'Deployz needs a reliable way to know when your app is running and ready.',
    whyItMatters: 'During every deployment, Deployz waits for your app to report healthy.',
    technicalEvidence: 'No health endpoint or container health check was found.',
    suggestedOutcome: 'Expose a lightweight route that returns success once the app is ready.',
    confidence: 'likely',
    ...overrides,
  };
}

function report(overrides: Partial<ReadinessReport> = {}): ReadinessReport {
  return {
    state: 'ALMOST_READY',
    requiredCount: 1,
    recommendedCount: 0,
    summary: 'Deployz found a few things to address before this app can be deployed reliably.',
    findings: [finding()],
    passed: [],
    ...overrides,
  };
}

function source(overrides: Partial<FixInstructionsSource> = {}): FixInstructionsSource {
  return {
    repoFullName: 'acme/widgets',
    containerPort: null,
    healthPath: null,
    migrationCommand: null,
    redisRequired: false,
    detectedMetadata: null,
    ...overrides,
  };
}

describe('fix-instructions — readReadinessReport', () => {
  it('returns null when metadata is null', () => {
    expect(readReadinessReport(null)).toBeNull();
  });

  it('returns null when metadata has no readiness key', () => {
    expect(readReadinessReport({ framework: 'express' })).toBeNull();
  });

  it('returns null when readiness.findings is missing or not an array', () => {
    expect(readReadinessReport({ readiness: { passed: [] } })).toBeNull();
    expect(readReadinessReport({ readiness: { findings: 'nope', passed: [] } })).toBeNull();
  });

  it('returns null when readiness.passed is missing or not an array', () => {
    expect(readReadinessReport({ readiness: { findings: [] } })).toBeNull();
    expect(readReadinessReport({ readiness: { findings: [], passed: 'nope' } })).toBeNull();
  });

  it('returns the report verbatim when the shape is well-formed', () => {
    const stored = report();
    expect(readReadinessReport({ readiness: stored })).toEqual(stored);
  });
});

describe('fix-instructions — buildFixInstructionsContext', () => {
  it('returns null when there is no stored report', () => {
    expect(buildFixInstructionsContext(source({ detectedMetadata: null }))).toBeNull();
    expect(buildFixInstructionsContext(source({ detectedMetadata: { framework: 'express' } }))).toBeNull();
  });

  it('returns null when the stored report has zero findings', () => {
    const app = source({ detectedMetadata: { readiness: report({ findings: [], requiredCount: 0 }) } });
    expect(buildFixInstructionsContext(app)).toBeNull();
  });

  it('maps repo identity, commit sha, and findings straight through', () => {
    const findings = [finding(), finding({ id: 'container-setup', severity: 'required' })];
    const app = source({
      repoFullName: 'acme/widgets',
      detectedMetadata: {
        readiness: report({ findings, requiredCount: 2 }),
        analysisCommitSha: 'abc123',
      },
    });

    const context = buildFixInstructionsContext(app);
    expect(context).not.toBeNull();
    expect(context!.repoFullName).toBe('acme/widgets');
    expect(context!.commitSha).toBe('abc123');
    expect(context!.findings).toEqual(findings);
  });

  it('commitSha is null when analysisCommitSha is not a string', () => {
    const app = source({ detectedMetadata: { readiness: report() } });
    expect(buildFixInstructionsContext(app)!.commitSha).toBeNull();
  });

  it('vendor-edited row columns win over detected metadata for port, migrationCommand, and healthPath', () => {
    const app = source({
      containerPort: 8080,
      healthPath: '/live',
      migrationCommand: 'npm run migrate:custom',
      detectedMetadata: {
        readiness: report(),
        port: '3000',
        migrationCommands: ['npx drizzle-kit push'],
      },
    });

    const context = buildFixInstructionsContext(app);
    expect(context!.facts.port).toBe('8080');
    expect(context!.facts.healthPath).toBe('/live');
    expect(context!.facts.migrationCommand).toBe('npm run migrate:custom');
  });

  it('falls back to detected metadata for the port, never to the migration pattern label', () => {
    const app = source({
      containerPort: null,
      healthPath: null,
      migrationCommand: null,
      detectedMetadata: {
        readiness: report(),
        port: '3000',
        // The detector records pattern labels here, not runnable commands.
        migrationCommands: ['drizzle-kit'],
      },
    });

    const context = buildFixInstructionsContext(app);
    expect(context!.facts.port).toBe('3000');
    expect(context!.facts.healthPath).toBeNull();
    expect(context!.facts.migrationCommand).toBeNull();
  });

  it('database is "postgres" iff usesPostgresql is true', () => {
    const withDb = source({ detectedMetadata: { readiness: report(), usesPostgresql: true } });
    expect(buildFixInstructionsContext(withDb)!.facts.database).toBe('postgres');

    const withoutDb = source({ detectedMetadata: { readiness: report(), usesPostgresql: false } });
    expect(buildFixInstructionsContext(withoutDb)!.facts.database).toBe('none');

    const unset = source({ detectedMetadata: { readiness: report() } });
    expect(buildFixInstructionsContext(unset)!.facts.database).toBe('none');
  });

  it('redisRequired is true from either the row column or the detected redis.required flag', () => {
    const fromRow = source({ redisRequired: true, detectedMetadata: { readiness: report() } });
    expect(buildFixInstructionsContext(fromRow)!.facts.redisRequired).toBe(true);

    const fromMetadata = source({
      redisRequired: false,
      detectedMetadata: { readiness: report(), redis: { required: true } },
    });
    expect(buildFixInstructionsContext(fromMetadata)!.facts.redisRequired).toBe(true);

    const neither = source({ redisRequired: false, detectedMetadata: { readiness: report() } });
    expect(buildFixInstructionsContext(neither)!.facts.redisRequired).toBe(false);
  });

  it('maps framework, packageManager, buildCommand, startCommand, dockerfilePath, and workingDirectory from metadata', () => {
    const app = source({
      detectedMetadata: {
        readiness: report(),
        framework: 'express',
        packageManager: 'pnpm',
        buildCommands: ['npm run build'],
        startupCommands: ['node dist/index.js'],
        dockerfilePath: 'Dockerfile',
        workingDirectory: 'apps/api',
      },
    });

    const context = buildFixInstructionsContext(app);
    expect(context!.facts.framework).toBe('express');
    expect(context!.facts.packageManager).toBe('pnpm');
    expect(context!.facts.buildCommand).toBe('npm run build');
    expect(context!.facts.startCommand).toBe('node dist/index.js');
    expect(context!.facts.dockerfilePath).toBe('Dockerfile');
    expect(context!.facts.workingDirectory).toBe('apps/api');
  });
});

describe('fix-instructions — createFixtureAiGateway', () => {
  it('parses a schema-valid fixture for the "fix-instructions" label', async () => {
    const gateway = createFixtureAiGateway();
    const response = await gateway.generate('prompt', fixInstructionsAiSchema, { label: 'fix-instructions' });
    expect(fixInstructionsAiSchema.parse(response.object)).toEqual(response.object);
    expect(response.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
  });

  it('parses a schema-valid fixture for the "repository-analysis" label', async () => {
    const gateway = createFixtureAiGateway();
    const response = await gateway.generate('prompt', repositoryAiSchema, { label: 'repository-analysis' });
    expect(repositoryAiSchema.parse(response.object)).toEqual(response.object);
  });

  it('throws AiGatewayNotAvailableError for an unknown label', async () => {
    const gateway = createFixtureAiGateway();
    await expect(
      gateway.generate('prompt', fixInstructionsAiSchema, { label: 'some-other-label' }),
    ).rejects.toBeInstanceOf(AiGatewayNotAvailableError);
  });

  it('throws AiGatewayNotAvailableError when no label is given', async () => {
    const gateway = createFixtureAiGateway();
    await expect(gateway.generate('prompt', fixInstructionsAiSchema, {})).rejects.toBeInstanceOf(
      AiGatewayNotAvailableError,
    );
  });
});
