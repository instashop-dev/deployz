/**
 * AI MVP Phase 4 — environment-variable classification. Deterministic rules
 * only: who supplies each value, decided from names, detected requirements
 * and the external-service catalog. No value is ever read.
 */

import { describe, expect, it } from 'vitest';

import type { ManifestEnvVariable } from '@deployz/contracts';

import { analyseRepo } from '../src/analyser.js';
import { classifyEnvVariables, isGeneratableSecretName } from '../src/env-classification.js';
import type { FileTree } from '../src/detectors.js';
import { evaluateManifestReadiness, generatedEnvKeys, normalizeDeploymentManifest } from '../src/manifest.js';

const NO_REQUIREMENTS = {
  postgresRequired: false,
  redisRequired: false,
  redisBindingNames: [],
  storageRequired: false,
  externalServices: [],
};

function variable(key: string, overrides: Partial<ManifestEnvVariable> = {}): ManifestEnvVariable {
  return { key, required: true, secret: false, source: [`read in src/index.ts`], ...overrides };
}

describe('isGeneratableSecretName', () => {
  it('accepts application-internal secrets', () => {
    for (const key of [
      'SESSION_SECRET',
      'JWT_SECRET',
      'NEXTAUTH_SECRET',
      'AUTH_SECRET',
      'SECRET_KEY_BASE',
      'SECRET_KEY',
      'APP_KEY',
      'ENCRYPTION_KEY',
      'NEXT_PRIVATE_ENCRYPTION_KEY',
      'COOKIE_SECRET',
      'HASH_SALT',
    ]) {
      expect(isGeneratableSecretName(key), key).toBe(true);
    }
  });

  it('rejects third-party credentials, connection strings and API keys', () => {
    for (const key of [
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'GITHUB_CLIENT_SECRET',
      'GOOGLE_CLIENT_SECRET',
      'SMTP_PASSWORD',
      'AWS_SECRET_ACCESS_KEY',
      'OPENAI_API_KEY',
      'DATABASE_URL',
      'REDIS_URL',
      'LICENSE_KEY',
      'SENTRY_DSN',
      'OAUTH_CLIENT_SECRET',
      'S3_SECRET_KEY',
      // Shared with another party — must match theirs, never minted.
      'WEBHOOK_SECRET',
      'HMAC_SECRET',
      'LICENSE_SECRET',
      'PARTNER_SIGNING_KEY',
      'SHARED_SECRET',
    ]) {
      expect(isGeneratableSecretName(key), key).toBe(false);
    }
  });
});

describe('classifyEnvVariables', () => {
  it('marks the names Deployz injects as managed — only for the requirements this app has', () => {
    const model = [variable('DATABASE_URL'), variable('REDIS_URL'), variable('AWS_S3_BUCKET'), variable('PORT', { required: false })];
    const none = classifyEnvVariables(model, NO_REQUIREMENTS);
    expect(none.map((v) => v.classification)).toEqual(['customer_required', 'customer_required', 'customer_required', 'deployz_managed']);

    const all = classifyEnvVariables(model, {
      postgresRequired: true,
      redisRequired: true,
      redisBindingNames: ['REDIS_URL'],
      storageRequired: true,
      externalServices: [],
    });
    expect(all.every((v) => v.classification === 'deployz_managed')).toBe(true);
  });

  it('generates app-internal secrets, never a third-party or service credential', () => {
    const model = [
      variable('SESSION_SECRET', { secret: true }),
      variable('STRIPE_SECRET_KEY', { secret: true }),
      variable('GITHUB_CLIENT_SECRET', { secret: true }),
      variable('SMTP_PASS', { secret: true }),
    ];
    const classified = classifyEnvVariables(model, { ...NO_REQUIREMENTS, externalServices: ['stripe', 'smtp'] });
    expect(classified.map((v) => [v.key, v.classification])).toEqual([
      ['SESSION_SECRET', 'deployz_generated'],
      ['STRIPE_SECRET_KEY', 'customer_required'],
      ['GITHUB_CLIENT_SECRET', 'customer_required'],
      ['SMTP_PASS', 'customer_required'],
    ]);
  });

  it('never generates a value for a secret the app does not require, or a non-secret', () => {
    const classified = classifyEnvVariables(
      [variable('SESSION_SECRET', { secret: true, required: false }), variable('APP_SECRET', { secret: false })],
      NO_REQUIREMENTS,
    );
    expect(classified.map((v) => v.classification)).toEqual(['optional', 'customer_required']);
  });

  it('distinguishes optional reads from sample-only declarations', () => {
    const classified = classifyEnvVariables(
      [
        variable('LOG_LEVEL', { required: false, source: ['read in src/log.ts'] }),
        variable('FEATURE_X', { required: false, source: ['.env.example declares FEATURE_X'] }),
      ],
      NO_REQUIREMENTS,
    );
    expect(classified.map((v) => v.classification)).toEqual(['optional', 'unknown']);
  });

  it('is pure and preserves every other attribute', () => {
    const model = [variable('LICENSE_KEY', { secret: true })];
    const classified = classifyEnvVariables(model, NO_REQUIREMENTS);
    expect(model[0]).not.toHaveProperty('classification');
    expect(classified[0]).toEqual({ ...model[0], classification: 'customer_required' });
  });
});

describe('analyseRepo → manifest gate (Phase 4)', () => {
  const tree: FileTree = {
    Dockerfile: 'FROM node:20-alpine\nEXPOSE 3000\nCMD ["node", "server.js"]\n',
    'package.json': JSON.stringify({ name: 'app', dependencies: { express: '^4', pg: '^8', stripe: '^12' } }),
    'server.js': [
      "const secret = process.env.SESSION_SECRET;",
      "const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);",
      "const license = process.env.LICENSE_KEY;",
      "const level = process.env.LOG_LEVEL || 'info';",
      "require('express')().get('/health', (_q, r) => r.send(secret && stripe && license && level)).listen(3000);",
    ].join('\n'),
    '.env.example': 'DATABASE_URL=\nSESSION_SECRET=\nSTRIPE_SECRET_KEY=\nLICENSE_KEY=\nLOG_LEVEL=info\nUNUSED_FLAG=\n',
  };

  it('classifies the model in the analysis metadata', () => {
    const model = analyseRepo(tree).metadata['envVarModel'] as ManifestEnvVariable[];
    const byKey = Object.fromEntries(model.map((v) => [v.key, v.classification]));
    expect(byKey).toMatchObject({
      DATABASE_URL: 'deployz_managed',
      SESSION_SECRET: 'deployz_generated',
      STRIPE_SECRET_KEY: 'customer_required',
      LICENSE_KEY: 'customer_required',
      LOG_LEVEL: 'optional',
      UNUSED_FLAG: 'unknown',
    });
  });

  it('carries the classification into the manifest and never asks the vendor for a generated secret', () => {
    const manifest = normalizeDeploymentManifest(analyseRepo(tree), {});
    expect(generatedEnvKeys(manifest)).toEqual(['SESSION_SECRET']);

    const missing = evaluateManifestReadiness(manifest, { providedEnvKeys: [] });
    expect(missing.state).toBe('NEEDS_CONFIGURATION');
    const finding = missing.findings.find((f) => f.id === 'required-env-vars-missing');
    expect(finding?.message).toContain('STRIPE_SECRET_KEY');
    expect(finding?.message).toContain('LICENSE_KEY');
    expect(finding?.message).not.toContain('SESSION_SECRET');

    const provided = evaluateManifestReadiness(manifest, { providedEnvKeys: ['STRIPE_SECRET_KEY', 'LICENSE_KEY'] });
    expect(provided.state).toBe('READY');
  });

  it('keeps a pre-Phase-4 model (no classification) on the old rule: every required key is the vendor\'s', () => {
    const manifest = normalizeDeploymentManifest(
      { metadata: { hasDockerfile: true, dockerfilePath: 'Dockerfile', port: '3000', startupCommands: ['CMD: node x'], envVarModel: [variable('SESSION_SECRET', { secret: true })] } },
      {},
    );
    expect(generatedEnvKeys(manifest)).toEqual([]);
    expect(evaluateManifestReadiness(manifest, { providedEnvKeys: [] }).state).toBe('NEEDS_CONFIGURATION');
  });
});
