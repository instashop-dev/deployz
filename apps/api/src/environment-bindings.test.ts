import { normalizeDeploymentManifest } from '@deployz/analysis';
import { applyEnvironmentBindings, type EnvironmentSetting } from '@deployz/contracts';
import { describe, expect, it } from 'vitest';

import { compileDeploymentIntent } from './compiler-artifact.js';
import { evaluatePreflight } from './preflight.js';

// A vendor maps a variable that analysis could not see (Grafana's
// GF_DATABASE_URL) to the managed database URL. The mapping clears the
// "connection unverified" blocker and reaches the compiled task definition.

const METADATA = {
  hasDockerfile: true,
  dockerfilePath: 'Dockerfile',
  framework: 'express',
  port: '3000',
  startupCommands: ['node dist/index.js'],
  hasStartupCommand: true,
  postgres: { required: true, evidence: [] },
  redis: { required: false, connectionEnvVars: [], compatibility: { supported: true } },
  usesS3: false,
  usesLocalFilesystem: false,
  buildCommands: ['npm run build'],
  envVars: [],
  envVarModel: [],
  infrastructureBindings: [],
  databaseState: 'postgres',
};

const OVERRIDES = { healthPath: '/health', migrationCommand: 'npm run migrate' };

const MAPPING: EnvironmentSetting = {
  key: 'GF_DATABASE_URL',
  stage: 'runtime',
  required: false,
  secret: false,
  provider: 'deployz',
  binding: { resource: 'database', kind: 'url' },
};

function templateEnvNames(template: Record<string, unknown>): string[] {
  return [...JSON.stringify(template).matchAll(/"Name":"([A-Z_0-9]+)"/g)].map((match) => match[1]!);
}

describe('vendor-mapped database value', () => {
  const analysed = normalizeDeploymentManifest({ metadata: METADATA }, OVERRIDES);

  it('blocks the preflight until the vendor maps a variable', () => {
    expect(analysed.database.connectionUnverified).toBe(true);
    const result = evaluatePreflight({ manifest: analysed, providedEnvKeys: [], readiness: null });
    expect(result.state).toBe('ACTION_REQUIRED');
    expect(result.blockers.map((finding) => finding.id)).toContain('database-connection-unverified');
  });

  it('clears the blocker and freezes the mapped key in the manifest bindings', () => {
    const manifest = applyEnvironmentBindings(analysed, [MAPPING]);
    expect(manifest.database).not.toHaveProperty('connectionUnverified');
    expect(manifest.database.envBindings).toContainEqual({ name: 'GF_DATABASE_URL', kind: 'url' });
    const result = evaluatePreflight({ manifest, providedEnvKeys: [], readiness: null, settings: [MAPPING] });
    expect(result.blockers.map((finding) => finding.id)).not.toContain('database-connection-unverified');
  });

  it('puts the mapped key into the compiled task definition', () => {
    const before = compileDeploymentIntent({ manifest: analysed, region: 'us-east-1' });
    const after = compileDeploymentIntent({
      manifest: applyEnvironmentBindings(analysed, [MAPPING]),
      region: 'us-east-1',
    });
    expect(templateEnvNames(before.template)).not.toContain('GF_DATABASE_URL');
    expect(templateEnvNames(after.template)).toContain('GF_DATABASE_URL');
  });
});
