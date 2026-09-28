import { describe, expect, it } from 'vitest';

import { analyseRepo, type FileTree } from '../src/analyser.js';
import { buildApplicationAnalysis } from '../src/application-analysis.js';
import { manifestToApplicationGraph } from '../src/graph.js';
import { normalizeDeploymentManifest } from '../src/manifest.js';
import { buildReadinessReport } from '../src/readiness-report.js';

// A Django app whose MySQL driver is installed by the Dockerfile (next to the
// OS headers it compiles against), not declared in requirements.txt, with a
// MySQL service in the production Compose file and a sibling React front end
// the Python image never builds. Every stage after analysis must keep MySQL,
// and no stage may give the Python workload the front end's commands.

const DJANGO_SETTINGS = [
  'import os',
  'DATABASES = {',
  "    'default': {",
  "        'ENGINE': 'django.db.backends.mysql',",
  "        'NAME': os.getenv('DB_NAME'),",
  "        'USER': os.getenv('DB_USER'),",
  "        'PASSWORD': os.getenv('DB_PASSWORD'),",
  "        'HOST': os.getenv('DB_HOST'),",
  "        'PORT': os.getenv('DB_PORT'),",
  '    }',
  '}',
].join('\r\n');

const DJANGO_MYSQL: FileTree = {
  Dockerfile: [
    'FROM python:3.9',
    'WORKDIR /app/backend',
    'COPY requirements.txt /app/backend',
    'RUN apt-get update \\',
    '    && apt-get install -y gcc default-libmysqlclient-dev pkg-config',
    'RUN pip install mysqlclient',
    'RUN pip install --no-cache-dir -r requirements.txt',
    'COPY . /app/backend',
    'EXPOSE 8000',
    'CMD ["python3", "manage.py", "runserver", "0.0.0.0:8000"]',
  ].join('\r\n'),
  'requirements.txt': 'Django==4.1.5\ngunicorn==20.1.0\n',
  'manage.py': 'import os\n',
  'notesapp/settings.py': DJANGO_SETTINGS,
  '.env': 'DB_NAME=\nDB_USER=\nDB_PASSWORD=\nDB_PORT=\nDB_HOST=\n',
  'docker-compose.yml': [
    'services:',
    '  django_app:',
    '    build:',
    '      context: .',
    '    ports:',
    '      - "8000:8000"',
    '    depends_on:',
    '      - db',
    '  db:',
    '    image: mysql',
    '    environment:',
    '      - MYSQL_DATABASE=test_db',
    '',
  ].join('\n'),
  'frontend/Dockerfile': 'FROM node:18\nCOPY . .\nRUN npm ci && npm run build\n',
  'frontend/package.json': JSON.stringify({
    name: 'frontend',
    scripts: { start: 'react-scripts start', build: 'react-scripts build' },
    dependencies: { react: '^18.2.0', 'react-scripts': '5.0.1' },
  }),
  'frontend/package-lock.json': '{}',
};

describe('Django + MySQL with the driver installed by the Dockerfile', () => {
  it('detects a required MySQL database', () => {
    const analysis = analyseRepo(DJANGO_MYSQL);
    const mysql = analysis.metadata.mysql as { required: boolean; detected: boolean; evidence: string[] };
    expect(mysql.detected).toBe(true);
    expect(mysql.required).toBe(true);
    expect(mysql.evidence).toContain('mysqlclient declared');
    expect(analysis.metadata.databaseState).toBe('mysql');
    expect(analysis.metadata.unsupportedReasons).toEqual([]);
  });

  it('keeps MySQL through the canonical model, manifest, graph and readiness report', () => {
    const analysis = analyseRepo(DJANGO_MYSQL);

    const detected = buildApplicationAnalysis(analysis, { analysisVersion: 1, aiResolved: [], resolvedMigrationCommand: null });
    expect(detected.database.required).toBe(true);
    expect(detected.database.type).toBe('mysql');
    expect(detected.database.evidence.map((entry) => entry.reason)).toContain('mysqlclient declared');

    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.database.postgres).toBe(true);
    expect(manifest.database.engine).toBe('mysql');
    const bindingNames = manifest.database.envBindings?.map((binding) => binding.name);
    expect(bindingNames).toEqual(expect.arrayContaining(['DATABASE_URL', 'DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_PORT']));

    const graph = manifestToApplicationGraph(manifest);
    const db = graph.resources.find((resource) => resource.id === 'primary-db');
    expect(db?.engine).toBe('mysql');
    const binding = graph.bindings.find((entry) => entry.targetId === 'primary-db');
    expect(binding?.sourceId).toBe('web');
    expect(binding?.envBindings.map((entry) => entry.name)).toContain('DB_HOST');

    const report = buildReadinessReport(analysis, { workerCommandResolved: false });
    expect(report.findings.find((finding) => finding.id.startsWith('unsupported-database'))).toBeUndefined();
  });

  it('asks how the schema is updated when the image never migrates (engine named MySQL)', () => {
    const analysis = analyseRepo(DJANGO_MYSQL);
    expect(analysis.metadata.migrationMode).toBe('unknown');
    const ambiguity = (analysis.metadata.ambiguities as { kind: string; detail: string }[]).find(
      (entry) => entry.kind === 'MIGRATION_STRATEGY',
    );
    expect(ambiguity?.detail).toContain('MySQL');

    const report = buildReadinessReport(analysis, { workerCommandResolved: false });
    const migrations = report.findings.find((finding) => finding.id === 'database-migrations');
    expect(migrations?.confidence).toBe('likely');
    expect(migrations?.technicalEvidence).toContain('MySQL');

    const graph = manifestToApplicationGraph(normalizeDeploymentManifest(analysis, {}));
    expect(graph.unresolved.find((entry) => entry.id === 'migration-strategy')?.question).toContain('uses MySQL');
  });

  it('reads Django migrations from an entrypoint copied to an absolute in-image path', () => {
    const analysis = analyseRepo({
      ...DJANGO_MYSQL,
      Dockerfile: [
        'FROM python:3.10-slim',
        'WORKDIR /usr/src/app',
        'RUN pip install mysqlclient',
        'COPY . .',
        'RUN cp docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh',
        'ENTRYPOINT ["bash", "/usr/local/bin/docker-entrypoint.sh"]',
      ].join('\n'),
      'docker-entrypoint.sh': '#!/bin/bash\npython manage.py migrate\nexec "$@"\n',
    });
    expect(analysis.metadata.migrationMode).toBe('startup');
    expect(analysis.metadata.migrationStartupEvidence).toEqual([
      { source: 'docker-entrypoint.sh', pattern: 'python manage.py migrate', fromDockerCommand: true },
    ]);
  });

  it('does not give the Python image the sibling front end build, start or package manager', () => {
    const analysis = analyseRepo(DJANGO_MYSQL);
    expect(analysis.metadata.runtime).toBe('python');
    expect(analysis.metadata.hasBuildCommand).toBe(false);
    expect(analysis.metadata.startupCommands).toEqual(['CMD: ["python3", "manage.py", "runserver", "0.0.0.0:8000"]']);
    expect(analysis.metadata.packageManager).toBeNull();
    const kinds = (analysis.metadata.ambiguities as { kind: string }[]).map((entry) => entry.kind);
    expect(kinds).not.toContain('BUILD_COMMAND');

    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.build.command).toBeNull();
    expect(manifest.web.command).toBe('CMD: ["python3", "manage.py", "runserver", "0.0.0.0:8000"]');
  });

  it('takes the Compose port from the application service, never the database service', () => {
    const analysis = analyseRepo({
      'app/Dockerfile': 'FROM python:3.10-slim\nRUN pip install mysqlclient\nCOPY . .\n',
      'app/requirements.txt': 'Django==4.1.3\n',
      'docker-compose.yml': [
        'services:',
        '  db:',
        '    image: mysql:8.0',
        '    environment:',
        '      - MYSQL_DATABASE=${SQL_DATABASE}',
        '    ports:',
        '      - 3306:3306',
        '  web:',
        '    build:',
        '      context: ./app',
        '    ports:',
        '      - 8000:8000',
        '',
      ].join('\n'),
    });
    expect(analysis.metadata.port).toBe('8000');
    expect((analysis.metadata.mysql as { required: boolean }).required).toBe(true);
  });
});

describe('evidence reconciliation keeps existing behaviour', () => {
  it('a Node image built from package.json keeps its build and start scripts', () => {
    const analysis = analyseRepo({
      Dockerfile: 'FROM python:3.12 AS api\nFROM node:20 AS web\nCOPY . .\nRUN npm ci && npm run build\nCMD ["node", "server.js"]\n',
      'package.json': JSON.stringify({ name: 'web', scripts: { build: 'vite build', start: 'node server.js' } }),
      'package-lock.json': '{}',
    });
    expect(analysis.metadata.buildCommands).toEqual(['vite build']);
    expect(analysis.metadata.packageManager).toBe('npm');
  });

  it('a Python image that builds its assets with npm keeps the package.json build script', () => {
    const analysis = analyseRepo({
      Dockerfile: 'FROM python:3.12\nRUN apt-get install -y nodejs npm \\\n  && npm ci && npm run build\nCMD ["gunicorn", "app.wsgi"]\n',
      'package.json': JSON.stringify({ name: 'assets', scripts: { build: 'webpack' } }),
      'requirements.txt': 'Django==5.0\n',
    });
    expect(analysis.metadata.buildCommands).toEqual(['webpack']);
  });

  it('Django + PostgreSQL stays a PostgreSQL database', () => {
    const analysis = analyseRepo({
      ...DJANGO_MYSQL,
      Dockerfile: 'FROM python:3.12\nCOPY . .\nRUN pip install -r requirements.txt\nEXPOSE 8000\nCMD ["gunicorn", "notesapp.wsgi"]\n',
      'requirements.txt': 'Django==5.0\npsycopg2-binary==2.9\n',
      'notesapp/settings.py': DJANGO_SETTINGS.replace('mysql', 'postgresql'),
      'docker-compose.yml': 'services:\n  web:\n    build: .\n  db:\n    image: postgres:16\n',
    });
    expect((analysis.metadata.postgres as { required: boolean }).required).toBe(true);
    expect((analysis.metadata.mysql as { detected: boolean }).detected).toBe(false);
    expect(analysis.metadata.databaseState).toBe('postgres');

    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.database.postgres).toBe(true);
    expect(manifest.database.engine).toBeUndefined();
    const graph = manifestToApplicationGraph(manifest);
    expect(graph.unresolved.find((entry) => entry.id === 'migration-strategy')?.question).toBe(
      'This application uses PostgreSQL but has no detected migration command. How should the database schema be updated on deploy?',
    );
  });

  it('a Django app without a database stays database-free', () => {
    const analysis = analyseRepo({
      Dockerfile: 'FROM python:3.12\nCOPY . .\nRUN pip install -r requirements.txt\nEXPOSE 8000\nCMD ["gunicorn", "site.wsgi"]\n',
      'requirements.txt': 'Django==5.0\ngunicorn==22.0\n',
    });
    expect(analysis.metadata.databaseState).toBe('none');
    expect(analysis.metadata.migrationMode).toBe('none');
    expect(analysis.metadata.infrastructureBindings).toEqual([]);
    expect(normalizeDeploymentManifest(analysis, {}).database.postgres).toBe(false);
  });

  it('an OS package or a commented-out install is not a language dependency', () => {
    const analysis = analyseRepo({
      Dockerfile: [
        'FROM python:3.12',
        'RUN apt-get install -y default-libmysqlclient-dev',
        '# RUN pip install mysqlclient',
        'CMD ["gunicorn", "site.wsgi"]',
      ].join('\n'),
      'requirements.txt': 'Django==5.0\n',
      'docker-compose.yml': 'services:\n  web:\n    build: .\n  db:\n    image: mysql:8.0\n',
    });
    expect((analysis.metadata.mysql as { detected: boolean }).detected).toBe(false);
    expect(analysis.metadata.databaseState).toBe('none');
  });
});

// A Node API using drizzle-orm (dialect-agnostic — it also drives MySQL) next
// to the mysql2 driver, a .env.example DATABASE_URL with a mysql:// scheme,
// and a compose mysql service. Neither signal is PostgreSQL evidence: the
// ORM proves nothing about the engine once a MySQL driver is present, and a
// DATABASE_URL whose declared value picks a different engine's scheme is not
// evidence for this one.
const NODE_DRIZZLE_MYSQL: FileTree = {
  Dockerfile: 'FROM node:20\nWORKDIR /app\nCOPY . .\nRUN npm ci && npm run build\nCMD ["node", "dist/server.js"]\n',
  'package.json': JSON.stringify({
    name: 'api',
    scripts: { build: 'tsc', start: 'node dist/server.js' },
    dependencies: { 'drizzle-orm': '^0.30.0', mysql2: '^3.9.0' },
  }),
  'package-lock.json': '{}',
  '.env.example': 'DATABASE_URL=mysql://user:password@localhost:3306/app\n',
  'docker-compose.yml': [
    'services:',
    '  api:',
    '    build: .',
    '    ports:',
    '      - "3000:3000"',
    '  db:',
    '    image: mysql:8.4',
    '    environment:',
    '      - MYSQL_DATABASE=app',
    '',
  ].join('\n'),
};

describe('a dialect-agnostic ORM is not PostgreSQL evidence when MySQL is detected', () => {
  it('resolves databaseState to mysql, not postgres, with postgres not required', () => {
    const analysis = analyseRepo(NODE_DRIZZLE_MYSQL);
    expect((analysis.metadata.postgres as { required: boolean }).required).toBe(false);
    expect((analysis.metadata.mysql as { required: boolean; detected: boolean }).required).toBe(true);
    expect(analysis.metadata.databaseState).toBe('mysql');

    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.database.postgres).toBe(true);
    expect(manifest.database.engine).toBe('mysql');

    const graph = manifestToApplicationGraph(manifest);
    const db = graph.resources.find((resource) => resource.id === 'primary-db');
    expect(db?.engine).toBe('mysql');
  });

  it('still counts drizzle-orm as PostgreSQL evidence when no MySQL driver competes for the engine', () => {
    const analysis = analyseRepo({
      ...NODE_DRIZZLE_MYSQL,
      'package.json': JSON.stringify({
        name: 'api',
        scripts: { build: 'tsc', start: 'node dist/server.js' },
        dependencies: { 'drizzle-orm': '^0.30.0', pg: '^8.11.0' },
      }),
      '.env.example': 'DATABASE_URL=postgres://user:password@localhost:5432/app\n',
      'docker-compose.yml': ['services:', '  api:', '    build: .', '  db:', '    image: postgres:16', ''].join('\n'),
    });
    expect((analysis.metadata.postgres as { required: boolean }).required).toBe(true);
    expect(analysis.metadata.databaseState).toBe('postgres');
  });

  it('keeps drizzle-orm alone with a postgres:// URL as PostgreSQL evidence', () => {
    const analysis = analyseRepo({
      Dockerfile: 'FROM node:20\nCOPY . .\nRUN npm ci && npm run build\nCMD ["node", "dist/server.js"]\n',
      'package.json': JSON.stringify({
        name: 'api',
        scripts: { build: 'tsc', start: 'node dist/server.js' },
        dependencies: { 'drizzle-orm': '^0.30.0' },
      }),
      '.env.example': 'DATABASE_URL=postgres://user:password@localhost:5432/app\n',
    });
    expect((analysis.metadata.postgres as { required: boolean }).required).toBe(true);
    expect(analysis.metadata.databaseState).toBe('postgres');
  });
});
