import { describe, expect, it } from 'vitest';

import type { AnalysisResult } from '../src/analyser.js';
import { analyseRepo } from '../src/analyser.js';
import { deriveInfrastructureBindings, type InfrastructureBinding } from '../src/bindings.js';
import { evaluateManifestReadiness, normalizeDeploymentManifest } from '../src/manifest.js';
import type { FileTree } from '../src/detectors.js';

// ==========================================================================
// Fixtures (inline file trees — no real files on disk)
// ==========================================================================

/** A container-ready app shell reused across fixtures (health + port + start). */
function shell(overrides: Partial<FileTree>): FileTree {
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
    'src/index.js': "app.listen(process.env.PORT || 3000);\n",
    ...overrides,
  };
}

/** memos-shaped app: the connection URL is read from MEMOS_DSN. */
const memosTree: FileTree = shell({
  'src/index.js': [
    "const { Pool } = require('pg');",
    'function makePool(dsn) {',
    '  return new Pool({ connectionString: dsn });',
    '}',
    'module.exports = () => makePool(process.env.MEMOS_DSN);',
    "app.listen(process.env.PORT || 3000);",
    '',
  ].join('\n'),
});

/** paperless-shaped app: discrete connection parts under PAPERLESS_DB*. */
const paperlessTree: FileTree = shell({
  'src/settings.js': [
    'function configure(host, port, name, user, pass) {}',
    'configure(',
    '  process.env.PAPERLESS_DBHOST,',
    '  process.env.PAPERLESS_DBPORT,',
    '  process.env.PAPERLESS_DBNAME,',
    '  process.env.PAPERLESS_DBUSER,',
    '  process.env.PAPERLESS_DBPASS,',
    ');',
    '',
  ].join('\n'),
});

/** grafana-shaped app: GF_DATABASE_* part + URL names. */
const grafanaTree: FileTree = shell({
  'src/settings.js': [
    'function configure(url, host, name, user, pass) {}',
    'configure(',
    '  process.env.GF_DATABASE_URL,',
    '  process.env.GF_DATABASE_HOST,',
    '  process.env.GF_DATABASE_NAME,',
    '  process.env.GF_DATABASE_USER,',
    '  process.env.GF_DATABASE_PASSWORD,',
    ');',
    '',
  ].join('\n'),
});

/** flask-shaped app: SQLALCHEMY_DATABASE_URI via os.environ. */
const flaskTree: FileTree = {
  'Dockerfile': [
    'FROM python:3.12',
    'EXPOSE 3000',
    'HEALTHCHECK CMD curl -f http://localhost:3000/health || exit 1',
    'CMD ["python", "app.py"]',
    '',
  ].join('\n'),
  'requirements.txt': 'psycopg2==2.9.9\nFlask==3.0.0\n',
  '.env.example': 'DATABASE_URL=postgresql://localhost:5432/app\n',
  'app.py': [
    'import os',
    "SQLALCHEMY_DATABASE_URI = os.environ['SQLALCHEMY_DATABASE_URI']",
    '',
  ].join('\n'),
};

function analyse(tree: FileTree): AnalysisResult {
  return analyseRepo(tree);
}

function postgresBindings(tree: FileTree): InfrastructureBinding[] {
  return deriveInfrastructureBindings(tree, analyse(tree)).filter((b) => b.resource === 'postgres');
}

// ==========================================================================
// Detection
// ==========================================================================

describe('deriveInfrastructureBindings — postgres', () => {
  it('always lists the six standard DATABASE_* bindings for a required database', () => {
    const tree = shell({});
    const analysis = analyse(tree);
    expect((analysis.metadata['postgres'] as { required: boolean }).required).toBe(true);
    const names = postgresBindings(tree).map((b) => b.applicationVariable);
    expect(names).toEqual(
      expect.arrayContaining([
        'DATABASE_URL',
        'DATABASE_HOST',
        'DATABASE_PORT',
        'DATABASE_NAME',
        'DATABASE_USER',
        'DATABASE_PASSWORD',
      ]),
    );
  });

  it('detects MEMOS_DSN as a postgres URL binding the app reads', () => {
    const analysis = analyse(memosTree);
    expect(deriveInfrastructureBindings(memosTree, analysis)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resource: 'postgres',
          semantic: 'url',
          applicationVariable: 'MEMOS_DSN',
          source: 'explicit',
          confidence: 'high',
        }),
      ]),
    );
  });

  it('detects PAPERLESS_DBHOST/DBPORT/DBNAME/DBUSER/DBPASS as part bindings', () => {
    const analysis = analyse(paperlessTree);
    const bindings = deriveInfrastructureBindings(paperlessTree, analysis);
    for (const [name, semantic] of [
      ['PAPERLESS_DBHOST', 'host'],
      ['PAPERLESS_DBPORT', 'port'],
      ['PAPERLESS_DBNAME', 'database'],
      ['PAPERLESS_DBUSER', 'username'],
      ['PAPERLESS_DBPASS', 'password'],
    ] as const) {
      expect(bindings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            resource: 'postgres',
            semantic,
            applicationVariable: name,
            source: 'explicit',
            confidence: 'high',
          }),
        ]),
      );
    }
  });

  it('detects GF_DATABASE_* URL/part conventions', () => {
    const analysis = analyse(grafanaTree);
    const bindings = deriveInfrastructureBindings(grafanaTree, analysis);
    for (const [name, semantic] of [
      ['GF_DATABASE_URL', 'url'],
      ['GF_DATABASE_HOST', 'host'],
      ['GF_DATABASE_NAME', 'database'],
      ['GF_DATABASE_USER', 'username'],
      ['GF_DATABASE_PASSWORD', 'password'],
    ] as const) {
      expect(bindings).toEqual(
        expect.arrayContaining([expect.objectContaining({ applicationVariable: name, semantic })]),
      );
    }
  });

  it('detects SQLALCHEMY_DATABASE_URI as a postgres URL binding', () => {
    const analysis = analyse(flaskTree);
    const bindings = deriveInfrastructureBindings(flaskTree, analysis);
    expect(bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resource: 'postgres',
          semantic: 'url',
          applicationVariable: 'SQLALCHEMY_DATABASE_URI',
        }),
      ]),
    );
  });

  it('never infers a binding from a name that appears nowhere in the tree', () => {
    const analysis = analyse(shell({}));
    const names = deriveInfrastructureBindings(shell({}), analysis).map((b) => b.applicationVariable);
    expect(names).not.toContain('MEMOS_DSN');
    expect(names).not.toContain('PAPERLESS_DBHOST');
    expect(names).not.toContain('SQLALCHEMY_DATABASE_URI');
  });

  it('marks a convention name that only appears in a placeholder env file as medium-confidence detected', () => {
    const tree = shell({
      '.env.example': 'DATABASE_URL=postgresql://localhost:5432/app\nPAPERLESS_DBHOST=\n',
    });
    const analysis = analyse(tree);
    expect(deriveInfrastructureBindings(tree, analysis)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resource: 'postgres',
          semantic: 'host',
          applicationVariable: 'PAPERLESS_DBHOST',
          source: 'detected',
          confidence: 'medium',
        }),
      ]),
    );
  });
});

describe('deriveInfrastructureBindings — redis and s3', () => {
  it('detects corroborated CELERY_BROKER_URL as a redis url binding', () => {
    const tree: FileTree = {
      'requirements.txt': 'celery\nredis\n',
      '.env.example': 'CELERY_BROKER_URL=redis://localhost:6379/0\n',
      'app.py': [
        'import os',
        'from celery import Celery',
        "celery = Celery('app', broker=os.environ['CELERY_BROKER_URL'])",
        '',
      ].join('\n'),
    };
    const analysis = analyse(tree);
    expect((analysis.metadata['redis'] as { required: boolean }).required).toBe(true);
    expect(deriveInfrastructureBindings(tree, analysis)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resource: 'redis',
          semantic: 'url',
          applicationVariable: 'CELERY_BROKER_URL',
          source: 'detected',
          confidence: 'high',
        }),
      ]),
    );
  });

  it('detects S3_ATTACHMENTS_BUCKET as a s3 bucket binding', () => {
    const tree = shell({
      'package.json': JSON.stringify({
        name: 'app',
        scripts: { start: 'node src/index.js' },
        dependencies: { express: '^4.18.0', pg: '^8.12.0', '@aws-sdk/client-s3': '^3.500.0' },
      }),
      'src/storage.js': [
        "const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');",
        "const bucket = process.env.S3_ATTACHMENTS_BUCKET;",
        "const region = process.env.S3_REGION;",
        'new S3Client({ region });',
        '',
      ].join('\n'),
    });
    const analysis = analyse(tree);
    expect(analysis.metadata['usesS3']).toBe(true);
    const bindings = deriveInfrastructureBindings(tree, analysis);
    expect(bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resource: 's3',
          semantic: 'bucket',
          applicationVariable: 'S3_ATTACHMENTS_BUCKET',
          source: 'explicit',
          confidence: 'high',
        }),
      ]),
    );
    // Region candidates ride along; the standard bucket names are explicit.
    expect(bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resource: 's3', semantic: 'region', applicationVariable: 'S3_REGION' }),
        expect.objectContaining({ resource: 's3', semantic: 'bucket', applicationVariable: 'AWS_S3_BUCKET', source: 'explicit' }),
      ]),
    );
  });

  it('produces no bindings when nothing is provisioned', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({ name: 'x', scripts: { start: 'node index.js' } }),
    };
    expect(deriveInfrastructureBindings(tree, analyse(tree))).toEqual([]);
  });

  it('is deterministic and stored on metadata', () => {
    for (const tree of [memosTree, paperlessTree, grafanaTree, flaskTree]) {
      const first = analyse(tree);
      const second = analyse(tree);
      expect(second.metadata['infrastructureBindings']).toEqual(first.metadata['infrastructureBindings']);
      expect(first.metadata['infrastructureBindings']).toEqual(
        deriveInfrastructureBindings(tree, first),
      );
    }
  });
});

// ==========================================================================
// End to end: analysis → manifest → readiness gate
// ==========================================================================

describe('binding aliases end to end (analysis → manifest → readiness)', () => {
  it('serializes postgres binding aliases into database.envBindings', () => {
    const analysis = analyse(memosTree);
    const manifest = normalizeDeploymentManifest(analysis, {});
    const dbBindings = manifest.database.envBindings ?? [];
    expect(dbBindings[0]).toEqual({ name: 'DATABASE_URL', kind: 'url' });
    expect(dbBindings).toEqual(
      expect.arrayContaining([
        { name: 'DATABASE_HOST', kind: 'host' },
        { name: 'DATABASE_PORT', kind: 'port' },
        { name: 'DATABASE_NAME', kind: 'database' },
        { name: 'DATABASE_USER', kind: 'username' },
        { name: 'DATABASE_PASSWORD', kind: 'password' },
        { name: 'MEMOS_DSN', kind: 'url' },
      ]),
    );
  });

  it('serializes detected bucket aliases into storage.envBindings (AWS_S3_BUCKET first)', () => {
    const tree = shell({
      'package.json': JSON.stringify({
        name: 'app',
        scripts: { start: 'node src/index.js' },
        dependencies: { express: '^4.18.0', pg: '^8.12.0', '@aws-sdk/client-s3': '^3.500.0' },
      }),
      'src/storage.js': "const bucket = process.env.S3_ATTACHMENTS_BUCKET;\n",
    });
    const analysis = analyse(tree);
    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.storage.required).toBe(true);
    expect(manifest.storage.envBindings[0]).toEqual({ name: 'AWS_S3_BUCKET', kind: 'bucket' });
    expect(manifest.storage.envBindings).toEqual(
      expect.arrayContaining([{ name: 'S3_ATTACHMENTS_BUCKET', kind: 'bucket' }]),
    );
  });

  it('an app reading only MEMOS_DSN passes the required-env gate (binding is auto-provided)', () => {
    const analysis = analyse(memosTree);
    const required = (analysis.metadata['envVarModel'] as { key: string; required: boolean }[]).filter(
      (entry) => entry.required,
    );
    expect(required.map((entry) => entry.key)).toContain('MEMOS_DSN');

    const manifest = normalizeDeploymentManifest(analysis, {});
    const result = evaluateManifestReadiness(manifest, { providedEnvKeys: [] });
    expect(result.state).toBe('READY');
    expect(result.findings.some((f) => f.id === 'required-env-vars-missing')).toBe(false);
  });

  it('part-shaped aliases are auto-provided too', () => {
    const analysis = analyse(paperlessTree);
    const manifest = normalizeDeploymentManifest(analysis, {});
    const result = evaluateManifestReadiness(manifest, { providedEnvKeys: [] });
    expect(result.state).toBe('READY');
    expect(result.findings.some((f) => f.id === 'required-env-vars-missing')).toBe(false);
  });
});
