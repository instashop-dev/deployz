import { describe, expect, it } from 'vitest';

import { analyseRepo } from '../src/analyser.js';
import type { FileTree } from '../src/detectors.js';
import { evaluateManifestReadiness, normalizeDeploymentManifest } from '../src/manifest.js';

const PG_PREFIX = "const { Pool } = require('pg');\n";

function appTree(overrides: Record<string, string | undefined>): FileTree {
  const tree: Record<string, string | undefined> = {
    Dockerfile: [
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
    'src/index.js': 'app.listen(process.env.PORT || 3000);\n',
    'docker-compose.yml': 'services:\n  app:\n    build: .\n  db:\n    image: postgres:16\n',
    ...overrides,
  };
  return Object.fromEntries(Object.entries(tree).filter(([, content]) => content !== undefined)) as FileTree;
}

function manifestFor(tree: FileTree) {
  return normalizeDeploymentManifest(analyseRepo(tree), {});
}

describe('database.connectionUnverified', () => {
  it('is set when the app reads its database connection only under a name analysis cannot see', () => {
    const manifest = manifestFor(appTree({ 'src/db.js': PG_PREFIX + 'const pool = new Pool(config.get("database"));\n' }));
    expect(manifest.database.postgres).toBe(true);
    expect(manifest.database.connectionUnverified).toBe(true);
    const readiness = evaluateManifestReadiness(manifest);
    expect(readiness.state).toBe('NEEDS_CONFIGURATION');
    expect(readiness.findings).toContainEqual(
      expect.objectContaining({ id: 'database-connection-unverified', category: 'database', severity: 'error' }),
    );
  });

  it('is not set when the app reads DATABASE_URL', () => {
    const manifest = manifestFor(
      appTree({ 'src/db.js': PG_PREFIX + 'new Pool({ connectionString: process.env.DATABASE_URL });\n' }),
    );
    expect(manifest.database).not.toHaveProperty('connectionUnverified');
    expect(evaluateManifestReadiness(manifest).findings.map((finding) => finding.id)).not.toContain(
      'database-connection-unverified',
    );
  });

  it('is not set when the app reads a detected alias', () => {
    const manifest = manifestFor(
      appTree({
        'src/db.js': PG_PREFIX + 'function makePool(dsn) {\n  return new Pool({ connectionString: dsn });\n}\nmakePool(process.env.MEMOS_DSN);\n',
      }),
    );
    expect(manifest.database.envBindings).toContainEqual({ name: 'MEMOS_DSN', kind: 'url' });
    expect(manifest.database).not.toHaveProperty('connectionUnverified');
  });

  it('is not set when a sample file declares a standard name', () => {
    const manifest = manifestFor(appTree({ '.env.example': 'DATABASE_URL=postgresql://localhost:5432/app\n' }));
    expect(manifest.database).not.toHaveProperty('connectionUnverified');
  });

  it('is not set without a managed database', () => {
    const manifest = manifestFor(appTree({ 'package.json': JSON.stringify({ name: 'app', dependencies: { express: '^4' } }) }));
    expect(manifest.database.postgres).toBe(false);
    expect(manifest.database).not.toHaveProperty('connectionUnverified');
  });
});
