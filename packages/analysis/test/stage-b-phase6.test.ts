import { describe, expect, it } from 'vitest';

import type { FileTree } from '../src/analyser.js';
import { analyseRepo } from '../src/analyser.js';
import { detectStartupMigrationEvidence, hasPreDeployMigration } from '../src/detectors.js';
import { evaluateManifestReadiness, normalizeDeploymentManifest } from '../src/manifest.js';
import { buildReadinessReport } from '../src/readiness-report.js';

/** A container-ready, PostgreSQL-required app shell. */
function dbApp(extra: Partial<FileTree>): FileTree {
  return {
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
    '.env.example': 'DATABASE_URL=postgresql://localhost:5432/app\n',
    'src/index.ts': [
      "import express from 'express';",
      "app.get('/health', (_req, res) => res.json({ ok: true }));",
      'app.listen(3000);',
      '',
    ].join('\n'),
    ...extra,
  };
}

function analyse(tree: FileTree) {
  return analyseRepo(tree);
}

// ==========================================================================
// Mode derivation
// ==========================================================================

describe('migration modes (COMP-014)', () => {
  it('maps "no database" to mode none', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({
        name: 'x',
        scripts: { start: 'node index.js' },
        dependencies: { express: '^4.18.0' },
      }),
    };
    expect(analyse(tree).metadata['migrationMode']).toBe('none');
  });

  it('maps a deploy-safe migration script to mode pre_deploy', () => {
    const tree = dbApp({
      'package.json': JSON.stringify({
        name: 'app',
        scripts: { start: 'node dist/index.js', migrate: 'prisma migrate deploy' },
        dependencies: { express: '^4.18.0', pg: '^8.12.0', '@prisma/client': '^5.0.0' },
      }),
      'prisma/schema.prisma': 'datasource db {\n  provider = "postgresql"\n}\n',
    });
    const analysis = analyse(tree);
    expect(analysis.metadata['migrationMode']).toBe('pre_deploy');
    expect(hasPreDeployMigration(tree)).toBe(true);
  });

  it('maps a migration inside the Dockerfile CMD to mode startup', () => {
    const tree = dbApp({
      'Dockerfile': [
        'FROM node:20-alpine',
        'EXPOSE 3000',
        'HEALTHCHECK CMD curl -f http://localhost:3000/health || exit 1',
        'CMD ["sh", "-c", "prisma migrate deploy && node dist/index.js"]',
        '',
      ].join('\n'),
    });
    const analysis = analyse(tree);
    expect((analysis.metadata['postgres'] as { required: boolean }).required).toBe(true);
    expect(analysis.metadata['migrationMode']).toBe('startup');
    const evidence = analysis.metadata['migrationStartupEvidence'] as {
      source: string;
      pattern: string;
    }[];
    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'CMD (Dockerfile)', pattern: 'prisma migrate deploy' }),
      ]),
    );
  });

  it('maps a migration inside a package.json start script to mode startup', () => {
    const tree = dbApp({
      'package.json': JSON.stringify({
        name: 'app',
        scripts: { start: 'knex migrate:latest && node dist/index.js' },
        dependencies: { express: '^4.18.0', pg: '^8.12.0', knex: '^3.0.0' },
      }),
    });
    expect(analyse(tree).metadata['migrationMode']).toBe('startup');
  });

  it('finds startup evidence in an entrypoint.sh next to the Dockerfile', () => {
    const tree = dbApp({
      'entrypoint.sh': '#!/bin/sh\npython manage.py migrate\nexec node dist/index.js\n',
    });
    const analysis = analyse(tree);
    expect(analysis.metadata['migrationMode']).toBe('startup');
    expect(detectStartupMigrationEvidence(tree)).toEqual(
      expect.arrayContaining([expect.objectContaining({ pattern: 'python manage.py migrate' })]),
    );
  });

  it('ignores dev-shaped migration commands', () => {
    const tree = dbApp({
      'Dockerfile': [
        'FROM node:20-alpine',
        'EXPOSE 3000',
        'HEALTHCHECK CMD curl -f http://localhost:3000/health || exit 1',
        'CMD ["sh", "-c", "prisma migrate dev && node dist/index.js"]',
        '',
      ].join('\n'),
    });
    expect(analyse(tree).metadata['migrationMode']).toBe('unknown');
  });

  it('maps a required database with no migration evidence to mode unknown', () => {
    const analysis = analyse(dbApp({}));
    expect((analysis.metadata['postgres'] as { required: boolean }).required).toBe(true);
    expect(analysis.metadata['migrationMode']).toBe('unknown');
  });
});

// ==========================================================================
// DEPLOY-029: the CMD/ENTRYPOINT script chain wins over a package.json
// deploy-shaped script — an image that migrates itself at boot (umami's
// Dockerfile CMD -> scripts/start-docker.sh -> scripts/check-db.js ->
// `prisma migrate deploy`) must not also get an invented pre-deploy command.
// ==========================================================================

/** An umami-shaped tree: CMD runs a script that runs another script that migrates. */
function umamiApp(checkDbContent: string): FileTree {
  return {
    'Dockerfile': ['FROM node:20-alpine', 'EXPOSE 3000', 'CMD ["sh", "scripts/start-docker.sh"]', ''].join('\n'),
    'scripts/start-docker.sh': ['#!/bin/sh', 'node scripts/check-db.js', 'exec node dist/index.js', ''].join('\n'),
    'scripts/check-db.js': checkDbContent,
    'package.json': JSON.stringify({
      name: 'umami',
      scripts: { start: 'node dist/index.js', 'update-db': 'prisma migrate deploy' },
      dependencies: { '@prisma/client': '^5.0.0' },
    }),
    'prisma/schema.prisma': 'datasource db {\n  provider = "postgresql"\n}\n',
  };
}

describe('startup migration evidence follows the CMD/ENTRYPOINT script chain (DEPLOY-029)', () => {
  it('finds a migration two hops below CMD (CMD -> start-docker.sh -> check-db.js) and records the script path as the source', () => {
    const tree = umamiApp("const { execSync } = require('child_process');\nexecSync('prisma migrate deploy');\n");
    expect(detectStartupMigrationEvidence(tree)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'scripts/check-db.js',
          pattern: 'prisma migrate deploy',
          fromDockerCommand: true,
        }),
      ]),
    );
  });

  it('the CMD chain wins mode startup even though a deploy-shaped package.json script also exists', () => {
    const tree = umamiApp("const { execSync } = require('child_process');\nexecSync('prisma migrate deploy');\n");
    const analysis = analyse(tree);
    expect((analysis.metadata['postgres'] as { required: boolean }).required).toBe(true);
    // A pre-deploy candidate really is present — proves this is precedence,
    // not merely an absence of the old signal.
    expect(hasPreDeployMigration(tree)).toBe(true);
    expect(analysis.metadata['migrationMode']).toBe('startup');
    const evidence = analysis.metadata['migrationStartupEvidence'] as { source: string; pattern: string }[];
    expect(evidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: 'scripts/check-db.js', pattern: 'prisma migrate deploy' })]),
    );
  });

  it('a package.json deploy-shaped script alone (no CMD chain to a migrating script) still maps to pre_deploy', () => {
    const tree = dbApp({
      'Dockerfile': ['FROM node:20-alpine', 'EXPOSE 3000', 'CMD ["node", "dist/index.js"]', ''].join('\n'),
      'package.json': JSON.stringify({
        name: 'app',
        scripts: { start: 'node dist/index.js', 'update-db': 'prisma migrate deploy' },
        dependencies: { express: '^4.18.0', pg: '^8.12.0' },
      }),
    });
    expect(analyse(tree).metadata['migrationMode']).toBe('pre_deploy');
  });

  it('a CMD script chain with no migration pattern leaves mode unaffected (no false positive)', () => {
    const tree = umamiApp("const { execSync } = require('child_process');\nexecSync('pg_isready');\n");
    // The chain (CMD -> start-docker.sh -> check-db.js) has no migration
    // pattern in it — no evidence, so no spurious startup precedence.
    expect(detectStartupMigrationEvidence(tree)).toEqual([]);
    const analysis = analyse(tree);
    // `update-db: prisma migrate deploy` in package.json is still
    // deploy-shaped, so the existing order applies unchanged: pre_deploy.
    expect(hasPreDeployMigration(tree)).toBe(true);
    expect(analysis.metadata['migrationMode']).toBe('pre_deploy');
  });
});

// ==========================================================================
// Manifest + readiness behaviour
// ==========================================================================

describe('migration mode — manifest and readiness (COMP-014)', () => {
  it('serializes migration.mode on the manifest', () => {
    const tree = dbApp({
      'Dockerfile': [
        'FROM node:20-alpine',
        'EXPOSE 3000',
        'HEALTHCHECK CMD curl -f http://localhost:3000/health || exit 1',
        'CMD ["sh", "-c", "python manage.py migrate && node dist/index.js"]',
        '',
      ].join('\n'),
    });
    const manifest = normalizeDeploymentManifest(analyse(tree), {});
    expect(manifest.migration.mode).toBe('startup');
    expect(manifest.migration.command).toBeNull(); // never invented
  });

  it('startup mode is informational/recommended and never blocks the gate', () => {
    const tree = dbApp({
      'Dockerfile': [
        'FROM node:20-alpine',
        'EXPOSE 3000',
        'HEALTHCHECK CMD curl -f http://localhost:3000/health || exit 1',
        'CMD ["sh", "-c", "python manage.py migrate && node dist/index.js"]',
        '',
      ].join('\n'),
    });
    const analysis = analyse(tree);
    const report = buildReadinessReport(analysis);
    const finding = report.findings.find((f) => f.id === 'database-migrations');
    expect(finding).toBeDefined();
    expect(finding?.title).toContain('start');
    expect(finding?.severity).toBe('recommended');
    expect(finding?.blocking).toBe(false);

    const manifest = normalizeDeploymentManifest(analysis, {});
    const gate = evaluateManifestReadiness(manifest, { providedEnvKeys: [] });
    expect(gate.state).toBe('READY');
    expect(gate.findings.some((f) => f.severity === 'error')).toBe(false);
  });

  it('mode none produces no database-migrations finding', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({
        name: 'x',
        scripts: { start: 'node index.js' },
        dependencies: { express: '^4.18.0' },
      }),
    };
    const report = buildReadinessReport(analyse(tree));
    expect(report.findings.some((f) => f.id === 'database-migrations')).toBe(false);
  });

  it('mode unknown keeps the gentle recommendation', () => {
    const report = buildReadinessReport(analyse(dbApp({})));
    const finding = report.findings.find((f) => f.id === 'database-migrations');
    expect(finding).toBeDefined();
    expect(finding?.title).toContain('Give Deployz a way');
  });
});
