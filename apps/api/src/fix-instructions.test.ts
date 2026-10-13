import { describe, expect, it } from 'vitest';

import {
  AiGatewayNotAvailableError,
  fixInstructionsAiSchema,
  repositoryAiSchema,
  type ReadinessFinding,
  type ReadinessReport,
} from '@deployz/analysis';

import { createFixtureAiGateway } from './ai-fixture.js';
import {
  buildFixInstructionsContext,
  effectiveReadinessReport,
  fixInstructionsCacheKey,
  readCachedFixInstructions,
  readReadinessReport,
  readinessResolution,
  type FixInstructionsSource,
} from './fix-instructions.js';

// Fix-instructions context assembly (apps/api/src/fix-instructions.ts) — turns
// a persisted application row into the structured context
// generateFixInstructions consumes. No repository file contents ever reach
// this layer, only the merged analysis metadata and the §35 contract fields.

function finding(overrides: Partial<ReadinessFinding> = {}): ReadinessFinding {
  return {
    id: 'health-check',
    category: 'health',
    title: 'Give Deployz a way to check your app',
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

  it('database names the required engine, the same rule as the manifest', () => {
    const postgres = source({ detectedMetadata: { readiness: report(), usesPostgresql: true, postgres: { required: true } } });
    expect(buildFixInstructionsContext(postgres)!.facts.database).toBe('postgres');

    const mysqlWithOptionalPg = source({
      detectedMetadata: { readiness: report(), usesPostgresql: true, usesMysql: true, postgres: { required: false }, mysql: { required: true } },
    });
    expect(buildFixInstructionsContext(mysqlWithOptionalPg)!.facts.database).toBe('mysql');

    const driverOnly = source({
      detectedMetadata: { readiness: report(), usesPostgresql: true, postgres: { required: false } },
    });
    expect(buildFixInstructionsContext(driverOnly)!.facts.database).toBe('none');

    const unset = source({ detectedMetadata: { readiness: report() } });
    expect(buildFixInstructionsContext(unset)!.facts.database).toBe('none');
  });

  it('marks the health path as vendor-set only when the vendor owns it', () => {
    const detected = source({ healthPath: '/healthz', detectedMetadata: { readiness: report({ findings: [finding(), finding({ id: 'localhost-binding' })] }), vendorOverrides: [] } });
    const owned = source({ healthPath: '/healthz', detectedMetadata: { readiness: report({ findings: [finding(), finding({ id: 'localhost-binding' })] }), vendorOverrides: ['healthPath'] } });
    expect(buildFixInstructionsContext(detected)!.facts.healthPathSetByVendor).toBe(false);
    expect(buildFixInstructionsContext(owned)!.facts.healthPathSetByVendor).toBe(true);
  });

  it('strips the Dockerfile instruction label from the detected start command', () => {
    const app = source({ detectedMetadata: { readiness: report(), startupCommands: ['CMD: npm run migrate && npm start'] } });
    expect(buildFixInstructionsContext(app)!.facts.startCommand).toBe('npm run migrate && npm start');
  });

  it('carries the declared worker commands so the plan keeps them', () => {
    const app = source({
      detectedMetadata: {
        readiness: report(),
        resolvedWorkerCommands: [{ id: 'worker', command: 'node worker.js', source: 'Procfile' }, { id: 'bad' }],
      },
    });
    expect(buildFixInstructionsContext(app)!.facts.workerCommands).toEqual(['node worker.js']);
    expect(buildFixInstructionsContext(source({ detectedMetadata: { readiness: report() } }))!.facts.workerCommands).toEqual([]);
  });

  it('suggests the analysed migration command only while the vendor has not decided one', () => {
    const metadata = { readiness: report(), suggestedMigrationCommand: 'python manage.py migrate --noinput' };
    expect(buildFixInstructionsContext(source({ detectedMetadata: metadata }))!.facts.suggestedMigrationCommand).toBe(
      'python manage.py migrate --noinput',
    );
    expect(
      buildFixInstructionsContext(source({ detectedMetadata: { ...metadata, vendorOverrides: ['migrationCommand'] } }))!
        .facts.suggestedMigrationCommand,
    ).toBeNull();
    expect(
      buildFixInstructionsContext(source({ migrationCommand: 'npm run migrate', detectedMetadata: metadata }))!.facts
        .suggestedMigrationCommand,
    ).toBeNull();
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

  it('summarises env requirements from the env-var model (names only, split by phase)', () => {
    const app = source({
      detectedMetadata: {
        readiness: report(),
        envVarModel: [
          { key: 'NPM_TOKEN', required: true, source: ['Dockerfile declares NPM_TOKEN'] },
          { key: 'STRIPE_SECRET_KEY', required: true, source: ['read in src/billing.ts'] },
          { key: 'DATABASE_URL', required: true, source: ['read in src/db.ts'], classification: 'deployz_managed' },
        ],
      },
    });

    expect(buildFixInstructionsContext(app)!.facts.envRequirements).toEqual({
      buildTime: ['NPM_TOKEN'],
      runtime: ['STRIPE_SECRET_KEY'],
      platformInjected: ['DATABASE_URL'],
    });
  });

  it('envRequirements is null when the row carries no env-var model', () => {
    const context = buildFixInstructionsContext(source({ detectedMetadata: { readiness: report() } }));
    expect(context!.facts.envRequirements).toBeNull();
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


describe('effectiveReadinessReport — vendor configuration resolves findings', () => {
  const portFinding = finding({ id: 'port-unresolved', category: 'network', title: 'Tell Deployz which port your app listens on', confidence: 'confirmed' });
  const startFinding = finding({ id: 'start-command-missing', category: 'container', title: 'Tell Deployz how to start your app', confidence: 'confirmed' });
  const stored = report({ requiredCount: 2, findings: [portFinding, startFinding] });

  it('reads the container port column, the manifest-only start command and the migration choice as the resolution', () => {
    expect(
      readinessResolution({ containerPort: 8080, detectedMetadata: { manifestOverrides: { startCommand: 'node x.js' } } }),
    ).toEqual({ containerPort: 8080, startCommand: 'node x.js', migrationCommandDecided: false, healthPathDecided: false, dockerfilePathDecided: false });
    expect(readinessResolution({ containerPort: null, detectedMetadata: { manifestOverrides: { startCommand: '' } } })).toEqual({
      containerPort: null,
      startCommand: null,
      migrationCommandDecided: false,
      healthPathDecided: false,
      dockerfilePathDecided: false,
    });
    expect(readinessResolution({ containerPort: null, detectedMetadata: null })).toEqual({
      containerPort: null,
      startCommand: null,
      migrationCommandDecided: false,
      healthPathDecided: false,
      dockerfilePathDecided: false,
    });
    expect(
      readinessResolution({ containerPort: null, detectedMetadata: { vendorOverrides: ['migrationCommand'] } }).migrationCommandDecided,
    ).toBe(true);
  });

  it('reads the vendor health path and Dockerfile path as decisions', () => {
    expect(readinessResolution({ containerPort: null, detectedMetadata: { vendorOverrides: ['healthPath'] } }).healthPathDecided).toBe(true);
    expect(readinessResolution({ containerPort: null, detectedMetadata: { vendorOverrides: ['containerPort'] } }).healthPathDecided).toBe(false);
    expect(
      readinessResolution({ containerPort: null, detectedMetadata: { manifestOverrides: { dockerfilePath: 'apps/api/Dockerfile' } } })
        .dockerfilePathDecided,
    ).toBe(true);
    expect(readinessResolution({ containerPort: null, detectedMetadata: { manifestOverrides: {} } }).dockerfilePathDecided).toBe(false);
  });

  it('clears the health-check finding only when the vendor set the health path', () => {
    const health = report({ findings: [finding()] });
    const withOverride = effectiveReadinessReport({ containerPort: null, detectedMetadata: { readiness: health, vendorOverrides: ['healthPath'] } });
    expect(withOverride?.findings).toEqual([]);
    expect(withOverride?.passed.map((check) => check.id)).toContain('health-check');
    const without = effectiveReadinessReport({ containerPort: null, detectedMetadata: { readiness: health } });
    expect(without?.findings.map((f) => f.id)).toEqual(['health-check']);
  });

  it('applies the resolution to the stored report without changing it', () => {
    const metadata = { readiness: stored, manifestOverrides: { startCommand: 'node x.js' } };
    const effective = effectiveReadinessReport({ containerPort: 8080, detectedMetadata: metadata });
    expect(effective?.state).toBe('READY');
    expect(effective?.findings).toEqual([]);
    expect((metadata.readiness as ReadinessReport).findings).toHaveLength(2);
    expect(effectiveReadinessReport({ containerPort: null, detectedMetadata: null })).toBeNull();
  });

  it('keeps a resolved finding out of the fix instructions', () => {
    const source: FixInstructionsSource = {
      repoFullName: 'acme/app',
      containerPort: 8080,
      healthPath: null,
      migrationCommand: null,
      redisRequired: false,
      detectedMetadata: { readiness: stored },
    };
    const context = buildFixInstructionsContext(source);
    expect(context?.findings.map((f) => f.id)).toEqual(['start-command-missing']);
    expect(
      buildFixInstructionsContext({
        ...source,
        detectedMetadata: { readiness: stored, manifestOverrides: { startCommand: 'node x.js' } },
      }),
    ).toBeNull();
  });
});


describe('fixInstructionsCacheKey / readCachedFixInstructions', () => {
  const source: FixInstructionsSource = {
    repoFullName: 'acme/app',
    containerPort: null,
    healthPath: null,
    migrationCommand: null,
    redisRequired: false,
    detectedMetadata: { readiness: report(), analysisCommitSha: 'abc', runtime: 'node' },
  };
  const context = buildFixInstructionsContext(source)!;

  it('is deterministic and includes the runtime fact', () => {
    expect(fixInstructionsCacheKey(context, 13, 'model-a')).toBe(fixInstructionsCacheKey(context, 13, 'model-a'));
    expect(fixInstructionsCacheKey(context, 13, 'model-a')).toMatch(/^[0-9a-f]{64}$/);
    expect(context.facts.runtime).toBe('node');
  });

  it('changes with the model, so a model switch regenerates the document', () => {
    expect(fixInstructionsCacheKey(context, 13, 'model-b')).not.toBe(fixInstructionsCacheKey(context, 13, 'model-a'));
  });

  it('changes with the commit, the analysis version, a fact, or a finding', () => {
    const base = fixInstructionsCacheKey(context, 13, 'model-a');
    expect(fixInstructionsCacheKey({ ...context, commitSha: 'def' }, 13, 'model-a')).not.toBe(base);
    expect(fixInstructionsCacheKey(context, 14, 'model-a')).not.toBe(base);
    expect(fixInstructionsCacheKey({ ...context, facts: { ...context.facts, port: '8080' } }, 13, 'model-a')).not.toBe(base);
    expect(
      fixInstructionsCacheKey({ ...context, findings: [{ ...context.findings[0]!, confidence: 'confirmed' }] }, 13, 'model-a'),
    ).not.toBe(base);
    expect(fixInstructionsCacheKey(context, 'not-a-number', 'model-a')).toBe(fixInstructionsCacheKey(context, null, 'model-a'));
  });

  it('reads a stored document only for exactly its key, and never a partial one', () => {
    const key = fixInstructionsCacheKey(context, 13, 'model-a');
    const stored = { key, instructions: '# doc', generatedAt: '2026-09-05T10:00:00.000Z' };
    expect(readCachedFixInstructions({ fixInstructions: stored }, key)).toEqual(stored);
    expect(readCachedFixInstructions({ fixInstructions: stored }, 'other')).toBeNull();
    expect(readCachedFixInstructions({ fixInstructions: { key, instructions: '' } }, key)).toBeNull();
    expect(readCachedFixInstructions({}, key)).toBeNull();
    expect(readCachedFixInstructions(null, key)).toBeNull();
  });
});
