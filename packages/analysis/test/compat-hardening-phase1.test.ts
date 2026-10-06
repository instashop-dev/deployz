import { describe, expect, it } from 'vitest';

import type { FileTree } from '../src/analyser.js';
import { analyseRepo } from '../src/analyser.js';
import { detectEnvVarModel, type ProvisionedResources } from '../src/detectors.js';
import { normalizeDeploymentManifest } from '../src/manifest.js';

// ==========================================================================
// Fixtures
// ==========================================================================

/** A container-ready Node app that provisions PostgreSQL; `files` add the evidence under test. */
function app(files: FileTree): FileTree {
  return {
    'Dockerfile': [
      'FROM node:20-alpine',
      'EXPOSE 3000',
      'HEALTHCHECK CMD curl -f http://localhost:3000/health || exit 1',
      'CMD ["node", "src/index.js"]',
      '',
    ].join('\n'),
    'package.json': JSON.stringify({
      name: 'app',
      scripts: { start: 'node src/index.js' },
      dependencies: { express: '^4.18.0', pg: '^8.12.0' },
    }),
    '.env.example': 'DATABASE_URL=postgresql://localhost:5432/app\n',
    'src/index.js': 'app.listen(process.env.PORT || 3000);\n',
    ...files,
  };
}

function manifestOf(tree: FileTree) {
  return normalizeDeploymentManifest(analyseRepo(tree), {});
}

function databaseBindings(tree: FileTree): Record<string, string> {
  return Object.fromEntries((manifestOf(tree).database.envBindings ?? []).map((b) => [b.name, b.kind]));
}

const POSTGRES: ProvisionedResources = { database: 'postgres', storage: false };
const MYSQL: ProvisionedResources = { database: 'mysql', storage: false };
const NOTHING: ProvisionedResources = { database: null, storage: false };
const STORAGE: ProvisionedResources = { database: null, storage: true };

function variable(tree: FileTree, key: string, provisioned: ProvisionedResources = POSTGRES) {
  return detectEnvVarModel(tree, [], provisioned).find((v) => v.key === key);
}

// ==========================================================================
// 1. Binding name conventions
// ==========================================================================

describe('Phase 1 — database binding name conventions', () => {
  const reads = (names: string[]): FileTree =>
    app({ 'src/config.js': `module.exports = [\n${names.map((n) => `  process.env.${n},`).join('\n')}\n];\n` });

  it('binds URL names', () => {
    const bindings = databaseBindings(
      reads([
        'SQLALCHEMY_DATABASE_URI',
        'DSN',
        'POSTGRES_CONNECTION_STRING',
        'POSTGRES_URI',
        'MYSQL_URL',
        'ACME_DB_CONNECTION_URI',
        'ACME_DB_CONNECTION_STRING',
        'DB_CONNECTION_URI',
        'ACME_POSTGRES_URI',
        'ACME_MYSQL_URL',
      ]),
    );
    for (const name of [
      'SQLALCHEMY_DATABASE_URI',
      'DSN',
      'POSTGRES_CONNECTION_STRING',
      'POSTGRES_URI',
      'MYSQL_URL',
      'ACME_DB_CONNECTION_URI',
      'ACME_DB_CONNECTION_STRING',
      'DB_CONNECTION_URI',
      'ACME_POSTGRES_URI',
      'ACME_MYSQL_URL',
    ]) {
      expect(bindings[name], name).toBe('url');
    }
  });

  it('binds connection parts, including the double-underscore delimiter', () => {
    const bindings = databaseBindings(
      reads([
        'ACME_DB_HOST',
        'ACME__DB_PORT',
        'ACME_DB__NAME',
        'ACME_DB_DATABASE',
        'ACME_DB_USER',
        'ACME_DB_USERNAME',
        'ACME_DB_PASSWORD',
        'ACME_DB_PASS',
        'ACME_POSTGRES_HOST',
        'ACME_POSTGRES_PORT',
        'ACME_POSTGRES_DB',
        'ACME_POSTGRES_USERNAME',
        'ACME_POSTGRES_PASSWORD',
        'POSTGRES_DATABASE',
        'POSTGRES_USERNAME',
        'POSTGRES_SERVER',
        'MYSQL_HOST',
        'MYSQL_PORT',
        'MYSQL_DATABASE',
        'MYSQL_USER',
        'MYSQL_PASSWORD',
      ]),
    );
    expect(bindings).toMatchObject({
      ACME_DB_HOST: 'host',
      ACME__DB_PORT: 'port',
      ACME_DB__NAME: 'database',
      ACME_DB_DATABASE: 'database',
      ACME_DB_USER: 'username',
      ACME_DB_USERNAME: 'username',
      ACME_DB_PASSWORD: 'password',
      ACME_DB_PASS: 'password',
      ACME_POSTGRES_HOST: 'host',
      ACME_POSTGRES_PORT: 'port',
      ACME_POSTGRES_DB: 'database',
      ACME_POSTGRES_USERNAME: 'username',
      ACME_POSTGRES_PASSWORD: 'password',
      POSTGRES_DATABASE: 'database',
      POSTGRES_USERNAME: 'username',
      POSTGRES_SERVER: 'host',
      MYSQL_HOST: 'host',
      MYSQL_PORT: 'port',
      MYSQL_DATABASE: 'database',
      MYSQL_USER: 'username',
      MYSQL_PASSWORD: 'password',
    });
  });

  it('binds JDBC URL names as jdbc_url and the datasource credentials as parts', () => {
    const bindings = databaseBindings(
      reads([
        'SPRING_DATASOURCE_URL',
        'ACME_DATASOURCE_URL',
        'ACME_DATASOURCE_JDBC_URL',
        'ACME_JDBC_URL',
        'ACME_DATASOURCE_USERNAME',
        'ACME_DATASOURCE_PASSWORD',
      ]),
    );
    expect(bindings).toMatchObject({
      SPRING_DATASOURCE_URL: 'jdbc_url',
      ACME_DATASOURCE_URL: 'jdbc_url',
      ACME_DATASOURCE_JDBC_URL: 'jdbc_url',
      ACME_JDBC_URL: 'jdbc_url',
      ACME_DATASOURCE_USERNAME: 'username',
      ACME_DATASOURCE_PASSWORD: 'password',
    });
  });

  it('never asks the vendor for a bound alias', () => {
    const model = analyseRepo(reads(['SPRING_DATASOURCE_URL', 'ACME_DB_PASSWORD'])).metadata['envVarModel'] as {
      key: string;
      classification: string;
      purpose: string;
    }[];
    for (const key of ['SPRING_DATASOURCE_URL', 'ACME_DB_PASSWORD']) {
      const entry = model.find((v) => v.key === key);
      expect(entry, key).toMatchObject({ classification: 'deployz_managed', purpose: 'infrastructure_binding' });
    }
  });
});

describe('Phase 1 — Redis binding name conventions', () => {
  const redisApp = (files: FileTree): FileTree =>
    app({
      'package.json': JSON.stringify({
        name: 'app',
        scripts: { start: 'node src/index.js' },
        dependencies: { express: '^4.18.0', pg: '^8.12.0', ioredis: '^5.0.0' },
      }),
      'docker-compose.yml': 'services:\n  cache:\n    image: redis:7\n',
      ...files,
    });
  const code = [
    'const Redis = require("ioredis");',
    'new Redis(process.env.BACKEND_CACHE_REDIS_URI);',
    'new Redis(process.env.NANGO_REDIS_URL);',
    'new Redis({ host: process.env.ACME_REDIS_HOST, port: process.env.ACME_REDIS_PORT, password: process.env.REDIS_PASSWORD });',
    '',
  ].join('\n');

  it('binds app-named Redis connection variables when Redis is required', () => {
    const manifest = manifestOf(redisApp({ 'src/redis.js': code }));
    expect(manifest.redis.required).toBe(true);
    const bindings = Object.fromEntries(manifest.redis.envBindings.map((b) => [b.name, b.kind]));
    expect(bindings).toMatchObject({
      BACKEND_CACHE_REDIS_URI: 'url',
      NANGO_REDIS_URL: 'url',
      ACME_REDIS_HOST: 'host',
      ACME_REDIS_PORT: 'port',
    });
    expect(bindings).not.toHaveProperty('REDIS_PASSWORD');
  });

  it('binds a Redis name documented only in an env sample', () => {
    const manifest = manifestOf(redisApp({ '.env.example': 'DATABASE_URL=postgresql://x/y\nSENTRY_REDIS_URL=redis://redis:6379\n' }));
    expect(manifest.redis.envBindings).toContainEqual({ name: 'SENTRY_REDIS_URL', kind: 'url' });
  });

  it('binds nothing when Redis is not required', () => {
    const manifest = manifestOf(app({ 'src/redis.js': 'const url = process.env.NANGO_REDIS_URL;\n' }));
    expect(manifest.redis.required).toBe(false);
    expect(manifest.redis.envBindings).toEqual([]);
  });
});

// ==========================================================================
// 2. Evidence sources
// ==========================================================================

describe('Phase 1 — Prisma datasource evidence', () => {
  const schema = (extra: string, provider = 'postgresql'): string =>
    `datasource db {\n  provider = "${provider}"\n  url = env("ACME_PRIMARY")\n  ${extra}\n}\n`;

  it('binds url, directUrl and shadowDatabaseUrl whatever they are called', () => {
    const bindings = databaseBindings(
      app({
        'prisma/schema.prisma': schema('directUrl = env("ACME_DIRECT")\n  shadowDatabaseUrl = env("ACME_SHADOW")'),
      }),
    );
    expect(bindings).toMatchObject({ ACME_PRIMARY: 'url', ACME_DIRECT: 'url', ACME_SHADOW: 'url' });
  });

  it('does not ask the vendor for the Prisma url variable', () => {
    const model = analyseRepo(app({ 'prisma/schema.prisma': schema('') })).metadata['envVarModel'] as {
      key: string;
      classification: string;
    }[];
    expect(model.find((v) => v.key === 'ACME_PRIMARY')?.classification).toBe('deployz_managed');
  });

  it('ignores a datasource of another engine', () => {
    const bindings = databaseBindings(app({ 'prisma/schema.prisma': schema('', 'sqlite') }));
    expect(bindings).not.toHaveProperty('ACME_PRIMARY');
  });
});

describe('Phase 1 — nested env sample evidence', () => {
  it('binds a name documented in a nested sample inside the app', () => {
    const tree = app({ 'server/.env.example': 'ACME_DB_HOST=db.internal\nACME_DB_PASSWORD=\n' });
    expect(databaseBindings(tree)).toMatchObject({ ACME_DB_HOST: 'host', ACME_DB_PASSWORD: 'password' });
  });

  it('does not list non-binding nested sample variables or make anything required', () => {
    const tree = app({ 'server/.env.example': 'ACME_DB_HOST=db.internal\nFEATURE_X_SECRET=\n' });
    const model = detectEnvVarModel(tree, [], POSTGRES);
    expect(model.find((v) => v.key === 'ACME_DB_HOST')).toMatchObject({ required: false });
    expect(model.find((v) => v.key === 'FEATURE_X_SECRET')).toBeUndefined();
  });

  it('ignores samples in docs, examples and sibling apps', () => {
    const tree: FileTree = {
      'apps/web/Dockerfile': 'FROM node:20\nEXPOSE 3000\nCMD ["node", "server.js"]\n',
      'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { pg: '^8.0.0' } }),
      'apps/web/server.js': 'listen(process.env.PORT);\n',
      'apps/other/.env.example': 'SIBLING_DB_HOST=x\n',
      'docs/.env.example': 'DOCS_DB_HOST=x\n',
      'examples/demo/.env.example': 'DEMO_DB_HOST=x\n',
    };
    const keys = detectEnvVarModel(tree, [], POSTGRES).map((v) => v.key);
    expect(keys).not.toContain('SIBLING_DB_HOST');
    expect(keys).not.toContain('DOCS_DB_HOST');
    expect(keys).not.toContain('DEMO_DB_HOST');
  });
});

describe('Phase 1 — config file env reads', () => {
  it('reads Rails config/*.yml ERB', () => {
    const tree = app({
      'config/database.yml': [
        'production:',
        '  host: <%= ENV["ACME_DB_HOST"] %>',
        '  port: <%= ENV.fetch("ACME_DB_PORT", 5432) %>',
        '  password: <%= ENV["ACME_DB_PASSWORD"] %>',
        '  pool: <%= ENV["ACME_POOL"] || 5 %>',
        '',
      ].join('\n'),
    });
    expect(databaseBindings(tree)).toMatchObject({
      ACME_DB_HOST: 'host',
      ACME_DB_PORT: 'port',
      ACME_DB_PASSWORD: 'password',
    });
    expect(variable(tree, 'ACME_DB_PORT')?.source).toContain('read in config/database.yml');
    expect(variable(tree, 'ACME_POOL')).toMatchObject({ required: false });
  });

  it('reads Laravel config/*.php and requires only a secret read without a default', () => {
    const tree = app({
      'config/services.php': [
        '<?php',
        "return ['key' => env('ACME_API_SECRET'), 'region' => env('ACME_REGION'), 'mode' => env('ACME_MODE', 'live')];",
        '',
      ].join('\n'),
    });
    expect(variable(tree, 'ACME_API_SECRET')).toMatchObject({ required: true });
    expect(variable(tree, 'ACME_REGION')).toMatchObject({ required: false });
    expect(variable(tree, 'ACME_MODE')).toMatchObject({ required: false });
  });

  it('reads Spring application files, including relaxed binding of spring.datasource', () => {
    const tree = app({
      'src/main/resources/application.yml': [
        'spring:',
        '  datasource:',
        '    driver-class-name: org.postgresql.Driver',
        'acme:',
        '  limit: ${ACME_LIMIT:10}',
        '',
      ].join('\n'),
    });
    expect(databaseBindings(tree)).toMatchObject({
      SPRING_DATASOURCE_URL: 'jdbc_url',
      SPRING_DATASOURCE_USERNAME: 'username',
      SPRING_DATASOURCE_PASSWORD: 'password',
    });
    expect(variable(tree, 'ACME_LIMIT')).toMatchObject({ required: false });
  });

  it('reads Spring application.properties', () => {
    const tree = app({
      'src/main/resources/application.properties': 'spring.datasource.url=jdbc:h2:mem:test\nacme.name=${ACME_NAME}\n',
    });
    expect(databaseBindings(tree)).toMatchObject({ SPRING_DATASOURCE_URL: 'jdbc_url' });
    expect(variable(tree, 'ACME_NAME')).toMatchObject({ required: false });
  });
});

// ==========================================================================
// 3. Engine selectors
// ==========================================================================

describe('Phase 1 — database engine selectors', () => {
  const selectorSource = (tree: FileTree, key: string, provisioned = POSTGRES): string | undefined =>
    variable(tree, key, provisioned)?.source.find((s) => s.startsWith('engine selector'));

  it('requires a JS selector defaulting to an embedded engine and names the value to use', () => {
    const tree = {
      'src/db.js': [
        "const client = process.env.DB_CLIENT || 'better-sqlite3';",
        "if (client === 'pg') connectPg();",
        '',
      ].join('\n'),
    };
    expect(variable(tree, 'DB_CLIENT')).toMatchObject({ required: true });
    expect(selectorSource(tree, 'DB_CLIENT')).toBe(
      'engine selector: default "better-sqlite3" stores data on the container disk — set "pg" to use the managed PostgreSQL database',
    );
  });

  it('handles ?? defaults and bracket reads', () => {
    expect(variable({ 'src/db.ts': "const t = process.env['DB_TYPE'] ?? 'sqlite';\n" }, 'DB_TYPE')).toMatchObject({
      required: true,
    });
  });

  it('requires a Python selector and takes the value from the code', () => {
    const tree = {
      'hc/settings.py': [
        'import os',
        "DB = os.environ.get('DB', 'sqlite')",
        "if DB == 'postgres':",
        "    ENGINE = 'django.db.backends.postgresql'",
        '',
      ].join('\n'),
    };
    expect(variable(tree, 'DB')).toMatchObject({ required: true });
    expect(selectorSource(tree, 'DB')).toContain('set "postgres" or "django.db.backends.postgresql"');
  });

  it('requires a Ruby selector defaulting to another engine', () => {
    const tree = {
      'config/application.rb': "adapter = ENV.fetch('DATABASE_ADAPTER', 'mysql2')\n",
      'lib/db.rb': "engine = ENV['DB_ENGINE'] || 'sqlite3'\n",
    };
    expect(variable(tree, 'DATABASE_ADAPTER')).toMatchObject({ required: true });
    expect(selectorSource(tree, 'DATABASE_ADAPTER')).toContain('is not the managed PostgreSQL engine');
    expect(variable(tree, 'DB_ENGINE')).toMatchObject({ required: true });
  });

  it('requires a PHP selector and uses the sample value for the managed engine', () => {
    const tree = {
      'config/database.php': "<?php return ['default' => env('DB_CONNECTION', 'sqlite')];\n",
      '.env.example': 'DB_CONNECTION=pgsql\n',
    };
    expect(variable(tree, 'DB_CONNECTION')).toMatchObject({ required: true });
    expect(selectorSource(tree, 'DB_CONNECTION')).toContain('set "pgsql"');
  });

  it('requires a Go viper selector under an env prefix', () => {
    const tree = {
      'cmd/root.go': [
        'viper.SetEnvPrefix("memos")',
        'viper.AutomaticEnv()',
        'viper.SetDefault("driver", "sqlite")',
        '',
      ].join('\n'),
    };
    expect(variable(tree, 'MEMOS_DRIVER')).toMatchObject({ required: true });
  });

  it('requires a Spring selector with an embedded default', () => {
    const tree = { 'src/main/resources/application.yml': 'acme:\n  db: ${ACME_DB_TYPE:h2}\n' };
    expect(variable(tree, 'ACME_DB_TYPE')).toMatchObject({ required: true });
  });

  it('requires a selector the code reads whose sample value is an embedded engine', () => {
    const tree = {
      'src/db.js': 'const type = process.env.DB_TYPE;\nif (type === "postgres") connect();\n',
      '.env.example': 'DB_TYPE=sqlite\n',
    };
    expect(variable(tree, 'DB_TYPE')).toMatchObject({ required: true });
    expect(selectorSource(tree, 'DB_TYPE')).toContain('set "postgres"');
  });

  it('requires a selector for a managed MySQL database when the default is PostgreSQL', () => {
    const tree = { 'src/db.js': "const t = process.env.DB_TYPE || 'postgres';\n" };
    expect(variable(tree, 'DB_TYPE', MYSQL)).toMatchObject({ required: true });
    expect(selectorSource(tree, 'DB_TYPE', MYSQL)).toContain('is not the managed MySQL engine');
  });

  it('does not require a selector whose default is the provisioned engine', () => {
    expect(variable({ 'src/db.js': "const t = process.env.DB_CLIENT || 'postgresql';\n" }, 'DB_CLIENT')).toMatchObject({
      required: false,
    });
    expect(
      variable({ 'src/db.js': "const t = process.env.DB_CLIENT || 'mysql2';\n" }, 'DB_CLIENT', MYSQL),
    ).toMatchObject({ required: false });
  });

  it('does not require a selector when no managed database is provisioned', () => {
    expect(
      variable({ 'src/db.js': "const t = process.env.DB_CLIENT || 'sqlite';\n" }, 'DB_CLIENT', NOTHING),
    ).toMatchObject({ required: false });
  });

  it('never treats an unrelated *_DRIVER as a selector', () => {
    const tree = {
      'config/mail.php': "<?php return ['driver' => env('MAIL_DRIVER', 'smtp')];\n",
      'src/log.js': "const d = process.env.LOG_DRIVER || 'json-file';\n",
      '.env.example': 'MAIL_DRIVER=smtp\nLOG_DRIVER=console\n',
    };
    expect(variable(tree, 'MAIL_DRIVER')).toMatchObject({ required: false });
    expect(variable(tree, 'LOG_DRIVER')).toMatchObject({ required: false });
  });

  it('does not treat the database name of a known engine as a selector', () => {
    expect(variable({ 'src/db.js': "const n = process.env.POSTGRES_DB || 'sqlite';\n" }, 'POSTGRES_DB')).toMatchObject({
      required: false,
    });
  });

  it('ignores a selector default in tests', () => {
    expect(
      variable({ 'src/db.test.js': "const t = process.env.DB_CLIENT || 'sqlite';\n" }, 'DB_CLIENT'),
    ).toBeUndefined();
  });

  it('blocks readiness through the analyser end to end', () => {
    const tree = app({
      'src/db.js': "const client = process.env.DB_CLIENT || 'sqlite3';\nif (client === 'pg') connect();\n",
    });
    const model = analyseRepo(tree).metadata['envVarModel'] as { key: string; classification: string }[];
    expect(model.find((v) => v.key === 'DB_CLIENT')?.classification).toBe('customer_required');
  });
});

describe('Phase 1 — storage selectors', () => {
  const storageSource = (tree: FileTree, key: string, provisioned = STORAGE): string | undefined =>
    variable(tree, key, provisioned)?.source.find((s) => s.startsWith('storage selector'));

  it('requires a storage selector defaulting to local disk and names the S3 value', () => {
    const tree = {
      'src/storage.js': [
        "const type = process.env.STORAGE_TYPE || 'local';",
        "if (type === 's3') useS3();",
        '',
      ].join('\n'),
    };
    expect(variable(tree, 'STORAGE_TYPE', STORAGE)).toMatchObject({ required: true });
    expect(storageSource(tree, 'STORAGE_TYPE')).toBe(
      'storage selector: default "local" stores files on the container disk — set "s3" to use the managed S3 bucket',
    );
  });

  it('requires a Rails Active Storage service defaulting to local', () => {
    const tree = { 'config/environments/production.rb': "config.active_storage.service = ENV.fetch('ACTIVE_STORAGE_SERVICE', 'local')\n" };
    expect(variable(tree, 'ACTIVE_STORAGE_SERVICE', STORAGE)).toMatchObject({ required: true });
  });

  it('does not require it when the default is already S3 or no storage is provisioned', () => {
    expect(variable({ 'src/s.js': "const t = process.env.STORAGE_TYPE || 's3';\n" }, 'STORAGE_TYPE', STORAGE)).toMatchObject({
      required: false,
    });
    expect(variable({ 'src/s.js': "const t = process.env.STORAGE_TYPE || 'local';\n" }, 'STORAGE_TYPE', NOTHING)).toMatchObject({
      required: false,
    });
  });
});
