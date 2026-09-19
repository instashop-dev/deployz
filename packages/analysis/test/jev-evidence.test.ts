import { describe, expect, it } from 'vitest';

import type { ManifestEnvVariable } from '@deployz/contracts';

import { analyseRepo } from '../src/analyser.js';
import { deriveInfrastructureBindings } from '../src/bindings.js';
import { collectDependencyNames, type FileTree } from '../src/detectors.js';
import { collectRepositoryEvidence, deriveAmbiguities, type RepositoryEvidence } from '../src/evidence.js';
import {
  JEV_EVIDENCE_MAX_JSON_CHARS,
  JEV_EVIDENCE_SCHEMA_VERSION,
  buildJevEvidence,
  fingerprintJevEvidence,
  sanitizeSnippet,
  type JevEvidence,
  type JevEvidenceInput,
} from '../src/jev/evidence.js';

// ==========================================================================
// Fixtures
// ==========================================================================

const SECRET_URI = 'postgres://user:pass@host/db';

/** Express + pg app whose Dockerfile ENV carries a fake secret value. */
const fixture: FileTree = {
  Dockerfile: [
    'FROM node:20-alpine',
    'WORKDIR /app',
    `ENV DATABASE_URL=${SECRET_URI}`,
    'COPY . .',
    'EXPOSE 3000',
    'HEALTHCHECK CMD curl -f http://localhost:3000/health || exit 1',
    'CMD ["node", "server.js"]',
  ].join('\n'),
  'package.json': JSON.stringify({
    name: 'jev-fixture',
    scripts: { start: 'node server.js', build: 'node build.js' },
    dependencies: { express: '^4.18.0', pg: '^8.12.0' },
  }),
  'pnpm-lock.yaml': 'lockfileVersion: 6.0\n',
  '.env.example': 'DATABASE_URL=postgresql://localhost:5432/app\n',
  'server.js': [
    "const { Pool } = require('pg');",
    'const pool = new Pool({ connectionString: process.env.DATABASE_URL });',
    "const app = require('express')();",
    "app.get('/health', (_req, res) => res.send('ok'));",
    'app.listen(process.env.PORT || 3000);',
    'module.exports = app;',
    '',
  ].join('\n'),
};

const emptyEvidence: RepositoryEvidence = {
  application: { name: null, framework: null, packageManager: null, dockerfilePath: null, port: null, healthPath: null },
  environment: [],
  database: [],
  redis: [],
  storage: [],
};

/** Assemble the input the future shadow-verifier hook will have in hand. */
function inputFromAnalysis(tree: FileTree): JevEvidenceInput {
  const analysis = analyseRepo(tree);
  const postgres = analysis.metadata['postgres'] as { required?: boolean };
  const redis = analysis.metadata['redis'] as { required?: boolean };
  return {
    findings: analysis.findings,
    evidence: collectRepositoryEvidence(tree, analysis),
    ambiguities: deriveAmbiguities(tree, analysis),
    dependencies: collectDependencyNames(tree),
    envVariables: (analysis.metadata['envVarModel'] ?? []) as ManifestEnvVariable[],
    requirements: {
      postgres: postgres.required === true,
      redisRequired: redis.required === true,
      storageRequired: analysis.metadata['usesS3'] === true,
    },
    bindings: deriveInfrastructureBindings(tree, analysis),
    rejections: analysis.rejections,
  };
}

/** The same object with every object's key order reversed. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([key, entry]) => [key, reverseKeys(entry)]),
    );
  }
  return value;
}

// ==========================================================================
// buildJevEvidence — from a real analyser run
// ==========================================================================

describe('buildJevEvidence', () => {
  it('maps the analyser facts and never carries the secret value', () => {
    const evidence = buildJevEvidence({
      ...inputFromAnalysis(fixture),
      snippets: [{ sourcePath: 'Dockerfile', excerpt: `ENV DATABASE_URL=${SECRET_URI}` }],
    });

    expect(evidence.evidenceSchemaVersion).toBe(JEV_EVIDENCE_SCHEMA_VERSION);
    expect(JEV_EVIDENCE_SCHEMA_VERSION).toBe(1);
    expect(evidence.runtimes).toEqual(['node']);
    expect(evidence.framework).toBe('express');
    expect(evidence.packageManager).toBe('pnpm');
    expect(evidence.dependencies).toContain('express');
    expect(evidence.dependencies).toContain('pg');
    expect(evidence.docker.present).toBe(true);
    expect(evidence.docker.exposedPorts).toEqual([3000]);
    expect(evidence.docker.healthEndpoint).toBe('/health');
    expect(evidence.docker.startupCommand).toContain('node');
    expect(evidence.docker.buildCommand).toBe('node build.js');
    expect(evidence.docker.bindAddress).toBeUndefined();
    expect(evidence.database.postgresDetected).toBe(true);
    expect(evidence.database.enginesSeen).toEqual([]);
    expect(evidence.manifestRequirements).toEqual({ postgres: true, redisRequired: false, storageRequired: false });
    expect(evidence.ambiguities).toContain('MIGRATION_STRATEGY');
    expect(evidence.bindings.some((b) => b.resource === 'postgres' && b.applicationVariable === 'DATABASE_URL')).toBe(
      true,
    );

    const database = evidence.envVariables.find((variable) => variable.name === 'DATABASE_URL');
    expect(database?.classification).toBe('deployz_managed');

    const json = JSON.stringify(evidence);
    expect(json).not.toContain(SECRET_URI);
    expect(json).not.toContain('user:pass');
    expect(json).not.toContain('postgresql://');
    expect(evidence.snippets).toHaveLength(1);
    expect(evidence.snippets[0]?.excerpt).toBe('ENV DATABASE_URL=[REDACTED]');
  });
});

// ==========================================================================
// sanitizeSnippet
// ==========================================================================

describe('sanitizeSnippet', () => {
  it('redacts KEY=value assignments', () => {
    expect(sanitizeSnippet('ENV MAX_CONNECTIONS=10 DATABASE_URL=postgres://user:pass@host/db')).toBe(
      'ENV MAX_CONNECTIONS=[REDACTED] DATABASE_URL=[REDACTED]',
    );
  });

  it('redacts credential keywords followed by a value', () => {
    expect(sanitizeSnippet('Authorization: Bearer ghp_16C7e42F292c6912E7710c838347Ae178B4a')).toBe(
      'Authorization: [REDACTED]',
    );
    expect(sanitizeSnippet('password: hunter2')).toBe('password: [REDACTED]');
  });

  it('redacts credentials embedded in a URI', () => {
    expect(sanitizeSnippet('redis://admin:s3cret@cache.internal:6379/0')).toBe('redis://[REDACTED]@cache.internal:6379/0');
  });

  it('redacts long base64 and hex runs', () => {
    expect(sanitizeSnippet('payload c2VjcmV0LXZhbHVlLXRoaXMtaXMtbG9uZw== end')).toBe('payload [REDACTED] end');
    expect(sanitizeSnippet('checksum deadbeefdeadbeefdeadbeefdeadbeef')).toBe('checksum [REDACTED]');
  });

  it('collapses whitespace and caps the excerpt at 200 chars', () => {
    expect(sanitizeSnippet('a\n  b\t\tc')).toBe('a b c');
    const capped = sanitizeSnippet(`${'w-'.repeat(75)} ${'v-'.repeat(75)}`);
    expect(capped.length).toBe(200);
    expect(capped.endsWith('...')).toBe(true);
  });
});

// ==========================================================================
// fingerprintJevEvidence
// ==========================================================================

describe('fingerprintJevEvidence', () => {
  it('is stable across rebuilds and key order, and differs for different evidence', () => {
    const input = inputFromAnalysis(fixture);
    const evidence = buildJevEvidence(input);

    expect(fingerprintJevEvidence(buildJevEvidence(input))).toBe(fingerprintJevEvidence(evidence));
    expect(fingerprintJevEvidence(reverseKeys(evidence) as JevEvidence)).toBe(fingerprintJevEvidence(evidence));

    const reorderedDependencies = buildJevEvidence({ ...input, dependencies: [...input.dependencies].reverse() });
    expect(fingerprintJevEvidence(reorderedDependencies)).toBe(fingerprintJevEvidence(evidence));

    const different = buildJevEvidence({
      ...input,
      requirements: { ...input.requirements, redisRequired: true },
    });
    expect(fingerprintJevEvidence(different)).not.toBe(fingerprintJevEvidence(evidence));
  });
});

// ==========================================================================
// List caps and the JSON size cap
// ==========================================================================

describe('caps', () => {
  it('truncates dependencies to 50', () => {
    const evidence = buildJevEvidence({
      ...inputFromAnalysis(fixture),
      dependencies: Array.from({ length: 70 }, (_, i) => `pkg-${i}`),
    });
    expect(evidence.dependencies).toHaveLength(50);
    expect(evidence.dependencies).toContain('pkg-0');
    expect(evidence.dependencies).not.toContain('pkg-69');
  });

  it('truncates source signals to 60', () => {
    const environment = Array.from({ length: 70 }, (_, i) => ({
      sourcePath: `src/file-${i}.ts`,
      type: 'required-env',
      value: `VAR_${i}`,
      confidence: 'high' as const,
    }));
    const evidence = buildJevEvidence({
      ...inputFromAnalysis(fixture),
      evidence: { ...emptyEvidence, environment },
    });
    expect(evidence.sourceSignals).toHaveLength(60);
  });

  it('reduces an oversized input below the size cap, deterministically and without throwing', () => {
    const bulkyInput: JevEvidenceInput = {
      ...inputFromAnalysis(fixture),
      dependencies: [],
      evidence: emptyEvidence,
      envVariables: Array.from({ length: 100 }, (_, i) => ({
        key: `BULKY_VAR_${i}_`.padEnd(400, 'x'),
        required: false,
        secret: false,
        source: [],
      })),
    };
    const result = buildJevEvidence(bulkyInput);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(JEV_EVIDENCE_MAX_JSON_CHARS);
    expect(result.envVariables).toHaveLength(0);
    expect(JSON.stringify(buildJevEvidence(bulkyInput))).toBe(JSON.stringify(result));
  });

  it('returns without throwing when an uncapped scalar alone exceeds the cap, dropping snippets', () => {
    const runtime = 'r'.repeat(JEV_EVIDENCE_MAX_JSON_CHARS);
    const result = buildJevEvidence({
      ...inputFromAnalysis(fixture),
      findings: [{ detector: 'runtime', detected: true, value: runtime }],
      snippets: [{ sourcePath: 'Dockerfile', excerpt: 'CMD ["node", "server.js"]' }],
    });
    expect(result.runtimes).toEqual([runtime]);
    expect(result.snippets).toHaveLength(0);
  });
});
