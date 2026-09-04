import { describe, expect, it } from 'vitest';

import type { AnalysisResult } from '../src/analyser.js';
import { analyseRepo } from '../src/analyser.js';
import { detectEnvVarModel, classifyEnvVarPurpose, type FileTree } from '../src/detectors.js';
import { evaluateManifestReadiness, normalizeDeploymentManifest } from '../src/manifest.js';

function modelByKey(tree: FileTree) {
  return new Map(detectEnvVarModel(tree).map((entry) => [entry.key, entry]));
}

// ==========================================================================
// Node/TS: zod, envalid, throwing env() helper
// ==========================================================================

describe('env reads via schema libraries (COMP-017)', () => {
  it('Node: zod object members without default/optional are required reads', () => {
    const tree: FileTree = {
      'config/env.ts': [
        "import { z } from 'zod';",
        '',
        'export const env = z',
        '  .object({',
        '    CORE_SECRET: z.string().min(1),',
        '    NEXTAUTH_SECRET: z.string(),',
        "    DATABASE_URL: z.string().min(1, { message: 'db url' }),",
        "    LOG_LEVEL: z.string().default('info'),",
        '    PORT: z.coerce.number().default(3000),',
        '  })',
        '  .parse(process.env);',
        '',
      ].join('\n'),
    };
    const byKey = modelByKey(tree);
    expect(byKey.get('CORE_SECRET')).toMatchObject({ required: true, secret: true });
    expect(byKey.get('NEXTAUTH_SECRET')).toMatchObject({ required: true, secret: true });
    expect(byKey.get('DATABASE_URL')).toMatchObject({ required: true });
    expect(byKey.get('LOG_LEVEL')).toMatchObject({ required: false });
    expect(byKey.get('PORT')).toMatchObject({ required: false });
    // A schema default is a real usable default — never a vendor requirement.
    expect(byKey.get('LOG_LEVEL')!.source.some((s) => s.startsWith('read in '))).toBe(true);
  });

  it('Node: envalid str()/str({desc}) are required; devDefault/default are not', () => {
    const tree: FileTree = {
      'config/env.ts': [
        "import { cleanEnv, str, num } from 'envalid';",
        '',
        'export const env = cleanEnv(process.env, {',
        '  ACCESS_TOKEN_SALT: str(),',
        "  JWT_SECRET: str({ desc: 'signing secret' }),",
        "  SESSION_SECRET: str({ default: 'dev-only' }),",
        '  PORT: num({ default: 3000 }),',
        '});',
        '',
      ].join('\n'),
    };
    const byKey = modelByKey(tree);
    expect(byKey.get('ACCESS_TOKEN_SALT')).toMatchObject({ required: true });
    expect(byKey.get('JWT_SECRET')).toMatchObject({ required: true });
    expect(byKey.get('SESSION_SECRET')).toMatchObject({ required: false });
    expect(byKey.get('PORT')).toMatchObject({ required: false });
  });

  it('Node: a throwing env("KEY") helper marks its calls required', () => {
    const tree: FileTree = {
      'config/env.ts': [
        'function env(key: string): string {',
        '  const value = process.env[key];',
        '  if (!value) throw new Error(`missing env ${key}`);',
        '  return value;',
        '}',
        '',
        'export const coreSecret = env("CORE_SECRET");',
        "export const logLevel = process.env.LOG_LEVEL || 'info';",
        '',
      ].join('\n'),
    };
    const byKey = modelByKey(tree);
    expect(byKey.get('CORE_SECRET')).toMatchObject({ required: true, secret: true });
    expect(byKey.get('LOG_LEVEL')).toMatchObject({ required: false });
  });
});

// ==========================================================================
// Python: pydantic v2 BaseSettings
// ==========================================================================

describe('Python pydantic-settings reads (COMP-017)', () => {
  const tree: FileTree = {
    'config/settings.py': [
      'from typing import Optional',
      'from pydantic import Field',
      'from pydantic_settings import BaseSettings',
      '',
      'class Settings(BaseSettings):',
      '    DATABASE_URL: str',
      '    SECRET_KEY: str = Field(...)',
      "    DB_HOST: str = Field(alias='DATABASE_HOST')",
      "    LOG_LEVEL: str = 'info'",
      '    OPTIONAL_FLAG: Optional[str] = None',
      '',
    ].join('\n'),
  };

  it('marks default-less typed fields required and defaulted/optional fields optional', () => {
    const byKey = modelByKey(tree);
    expect(byKey.get('DATABASE_URL')).toMatchObject({ required: true });
    expect(byKey.get('SECRET_KEY')).toMatchObject({ required: true, secret: true });
    expect(byKey.get('DATABASE_HOST')).toMatchObject({ required: true });
    expect(byKey.get('LOG_LEVEL')).toMatchObject({ required: false });
    expect(byKey.get('OPTIONAL_FLAG')).toMatchObject({ required: false });
  });
});

// ==========================================================================
// JVM, Go, .NET
// ==========================================================================

describe('JVM / Go / .NET env reads (COMP-017)', () => {
  it('JVM: @Value("${KEY}") is required unless a :default is present; System.getenv is optional', () => {
    const tree: FileTree = {
      'src/main/java/com/app/EnvConfig.java': [
        'package com.app;',
        'import org.springframework.beans.factory.annotation.Value;',
        'public class EnvConfig {',
        '  @Value("${DATABASE_URL}")',
        '  private String dbUrl;',
        '  @Value("${REDIS_URL:redis://localhost:6379}")',
        '  private String redis;',
        '  @Value("${db.host}")',
        '  private String host;',
        '  public String token() { return System.getenv("INTERNAL_API_TOKEN"); }',
        '}',
        '',
      ].join('\n'),
    };
    const byKey = modelByKey(tree);
    expect(byKey.get('DATABASE_URL')).toMatchObject({ required: true });
    expect(byKey.get('REDIS_URL')).toMatchObject({ required: false });
    expect(byKey.get('INTERNAL_API_TOKEN')).toMatchObject({ required: false, secret: true });
    expect(byKey.has('DB')).toBe(false);
  });

  it('Go: plain os.Getenv is optional; an if-empty log.Fatal or required tag makes it required', () => {
    const tree: FileTree = {
      'main.go': [
        'package main',
        '',
        'import (',
        '  "log"',
        '  "os"',
        ')',
        '',
        'type Config struct {',
        '  Port  int    `envconfig:"PORT"`',
        '  Token string `envconfig:"AUTH_TOKEN,required"`',
        '  Base  string `envconfig:"BASE_URL" validate:"required"`',
        '}',
        '',
        'func main() {',
        '  apiKey := os.Getenv("API_KEY")',
        '  dbHost := os.Getenv("DB_HOST")',
        '  if os.Getenv("REQUIRED_TOKEN") == "" {',
        '    log.Fatal("REQUIRED_TOKEN must be set")',
        '  }',
        '  _ = apiKey',
        '  _ = dbHost',
        '}',
        '',
      ].join('\n'),
    };
    const byKey = modelByKey(tree);
    expect(byKey.get('API_KEY')).toMatchObject({ required: false, secret: true });
    expect(byKey.get('DB_HOST')).toMatchObject({ required: false });
    expect(byKey.get('REQUIRED_TOKEN')).toMatchObject({ required: true, secret: true });
    expect(byKey.get('AUTH_TOKEN')).toMatchObject({ required: true, secret: true });
    expect(byKey.get('BASE_URL')).toMatchObject({ required: true });
    expect(byKey.get('PORT')).toMatchObject({ required: false });
  });

  it('.NET: GetConnectionString with a ?? throw guard and GetRequiredSection are required', () => {
    const tree: FileTree = {
      'Program.cs': [
        'var builder = WebApplication.CreateBuilder(args);',
        'var conn = builder.Configuration.GetConnectionString("DATABASE_URL")',
        '  ?? throw new InvalidOperationException("DATABASE_URL not configured");',
        'var section = builder.Configuration.GetRequiredSection("SECRET_SECTION");',
        'var optional = builder.Configuration.GetConnectionString("OPTIONAL_CONNECTION");',
        '',
      ].join('\n'),
    };
    const byKey = modelByKey(tree);
    expect(byKey.get('DATABASE_URL')).toMatchObject({ required: true });
    expect(byKey.get('SECRET_SECTION')).toMatchObject({ required: true });
    expect(byKey.get('OPTIONAL_CONNECTION')).toMatchObject({ required: false });
  });
});

// ==========================================================================
// Purpose classification
// ==========================================================================

describe('env-var purpose classification (Stage B phase 3)', () => {
  it('classifies infra names high, catalog credentials high, aliases/secret-names medium', () => {
    expect(classifyEnvVarPurpose('DATABASE_URL')).toEqual({
      purpose: 'infrastructure_binding',
      confidence: 'high',
    });
    expect(classifyEnvVarPurpose('MEMOS_DSN')).toEqual({
      purpose: 'infrastructure_binding',
      confidence: 'medium',
    });
    expect(classifyEnvVarPurpose('PAPERLESS_DBHOST')).toEqual({
      purpose: 'infrastructure_binding',
      confidence: 'medium',
    });
    expect(classifyEnvVarPurpose('S3_ATTACHMENTS_BUCKET')).toEqual({
      purpose: 'infrastructure_binding',
      confidence: 'medium',
    });
    expect(classifyEnvVarPurpose('STRIPE_SECRET_KEY')).toEqual({
      purpose: 'external_credential',
      confidence: 'high',
    });
    expect(classifyEnvVarPurpose('INTERNAL_API_TOKEN')).toEqual({
      purpose: 'internal_secret',
      confidence: 'medium',
    });
    expect(classifyEnvVarPurpose('LOG_LEVEL')).toEqual({
      purpose: 'optional_configuration',
      confidence: 'medium',
    });
  });

  it('populates purpose/confidence on the env-var model entries', () => {
    const tree: FileTree = {
      '.env.example': [
        'STRIPE_SECRET_KEY=',
        'DATABASE_URL=',
        'MEMOS_DSN=',
        'INTERNAL_API_TOKEN=',
        'LOG_LEVEL=info',
        '',
      ].join('\n'),
    };
    const byKey = modelByKey(tree);
    expect(byKey.get('STRIPE_SECRET_KEY')).toMatchObject({
      purpose: 'external_credential',
      confidence: 'high',
      secret: true,
    });
    expect(byKey.get('DATABASE_URL')).toMatchObject({
      purpose: 'infrastructure_binding',
      confidence: 'high',
    });
    expect(byKey.get('MEMOS_DSN')).toMatchObject({
      purpose: 'infrastructure_binding',
      confidence: 'medium',
    });
    expect(byKey.get('INTERNAL_API_TOKEN')).toMatchObject({
      purpose: 'internal_secret',
      confidence: 'medium',
    });
    expect(byKey.get('LOG_LEVEL')).toMatchObject({
      purpose: 'optional_configuration',
      confidence: 'medium',
    });
  });
});

// ==========================================================================
// End to end: a schema-required secret drives the manifest gate
// ==========================================================================

describe('schema-required secrets reach the deployment gate', () => {
  const tree: FileTree = {
    'Dockerfile': [
      'FROM node:20-alpine',
      'EXPOSE 3000',
      'HEALTHCHECK CMD curl -f http://localhost:3000/health || exit 1',
      'CMD ["node", "dist/index.js"]',
      '',
    ].join('\n'),
    'package.json': JSON.stringify({
      name: 'app',
      scripts: { start: 'node dist/index.js' },
      dependencies: { express: '^4.18.0', pg: '^8.12.0' },
    }),
    'src/config.ts': [
      "import { z } from 'zod';",
      'export const env = z',
      '  .object({',
      '    NEXTAUTH_SECRET: z.string().min(1),',
      "    LOG_LEVEL: z.string().default('info'),",
      '  })',
      '  .parse(process.env);',
      '',
    ].join('\n'),
    'src/index.js': "app.listen(process.env.PORT || 3000);\n",
  };

  it('blocks the deployment until the schema-required secret is configured', () => {
    const analysis = analyseRepo(tree);
    const envVarModel = analysis.metadata['envVarModel'] as {
      key: string;
      required: boolean;
      secret: boolean;
    }[];
    const nextauth = envVarModel.find((entry) => entry.key === 'NEXTAUTH_SECRET');
    expect(nextauth).toMatchObject({ required: true, secret: true });
    const logLevel = envVarModel.find((entry) => entry.key === 'LOG_LEVEL');
    expect(logLevel).toMatchObject({ required: false });

    const manifest = normalizeDeploymentManifest(analysis, {});
    const result = evaluateManifestReadiness(manifest, { providedEnvKeys: [] });
    expect(result.state).toBe('NEEDS_CONFIGURATION');
    const finding = result.findings.find((f) => f.id === 'required-env-vars-missing');
    expect(finding?.message).toContain('NEXTAUTH_SECRET');
  });

  it('stays optional when a default makes the schema read optional', () => {
    const analysis: AnalysisResult = analyseRepo(tree);
    const manifest = normalizeDeploymentManifest(analysis, {});
    const result = evaluateManifestReadiness(manifest, {
      providedEnvKeys: ['NEXTAUTH_SECRET'],
    });
    expect(result.state).toBe('READY');
  });
});
