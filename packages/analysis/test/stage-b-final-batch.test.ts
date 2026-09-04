import { describe, expect, it } from 'vitest';

import type { FileTree } from '../src/analyser.js';
import { analyseRepo } from '../src/analyser.js';
import { detectEnvVarModel } from '../src/detectors.js';
import { evaluateManifestReadiness, normalizeDeploymentManifest } from '../src/manifest.js';

function rejectedDependency(tree: FileTree, dependency: string): string | undefined {
  return analyseRepo(tree).rejections.find((r) => r.detected && r.dependency === dependency)?.reason;
}

// ==========================================================================
// COMP-021 — Dockerfile copies an artifact the repository does not contain
// ==========================================================================

describe('COMP-021 — missing COPY source', () => {
  it('rejects a Dockerfile that COPYs a path absent from the tree', () => {
    const tree: FileTree = {
      'Dockerfile': 'FROM node:20-alpine\nCOPY listmonk .\nCMD ["listmonk"]\n',
      'package.json': JSON.stringify({ name: 'x', scripts: { start: 'node index.js' } }),
    };
    const reason = rejectedDependency(tree, 'missing-copy-source');
    expect(reason).toContain('listmonk');
    expect(reason).toContain('not in the repository');
  });

  it('ignores multi-stage COPY --from= and generated-artifact directories', () => {
    const tree: FileTree = {
      'Dockerfile': [
        'FROM golang:1.22 AS build',
        'WORKDIR /src',
        'COPY main.go .',
        'RUN go build -o /out/app .',
        'FROM node:20-alpine',
        'COPY --from=build /out/app /usr/local/bin/app',
        'COPY dist ./dist',
        'CMD ["app"]',
        '',
      ].join('\n'),
      'main.go': 'package main\n',
    };
    expect(rejectedDependency(tree, 'missing-copy-source')).toBeUndefined();
  });

  it('leaves a legitimate Dockerfile alone (sources exist)', () => {
    const tree: FileTree = {
      'Dockerfile': 'FROM node:20-alpine\nCOPY package.json .\nCOPY src ./src\nCMD ["node", "src/index.js"]\n',
      'package.json': '{}',
      'src/index.js': 'console.log("hi");\n',
    };
    expect(rejectedDependency(tree, 'missing-copy-source')).toBeUndefined();
  });
});

// ==========================================================================
// COMP-022 — database engine selected by an env value
// ==========================================================================

describe('COMP-022 — engine selector defaults to a non-Postgres engine', () => {
  const tree: FileTree = {
    'requirements.txt': 'django\npsycopg2\n',
    'hc/settings.py': [
      'import os',
      "DB = os.getenv('DB', 'sqlite')",
      "if DB == 'postgres':",
      '    DATABASES = { "default": { "ENGINE": "django.db.backends.postgresql" } }',
      '',
    ].join('\n'),
  };

  it('makes the SQLite-defaulting engine selector required', () => {
    const model = detectEnvVarModel(tree);
    expect(model.find((v) => v.key === 'DB')).toMatchObject({ required: true });
  });

  it('surfaces as NEEDS_CONFIGURATION at the manifest gate, not READY', () => {
    const analysis = analyseRepo({
      ...tree,
      'Dockerfile': [
        'FROM python:3.12',
        'EXPOSE 3000',
        'HEALTHCHECK CMD curl -f http://localhost:3000/health || exit 1',
        'CMD ["python", "manage.py", "runserver", "0.0.0.0:3000"]',
        '',
      ].join('\n'),
    });
    const manifest = normalizeDeploymentManifest(analysis, {});
    const result = evaluateManifestReadiness(manifest, { providedEnvKeys: [] });
    expect(result.state).toBe('NEEDS_CONFIGURATION');
    expect(result.findings.some((f) => f.id === 'required-env-vars-missing')).toBe(true);
  });
});

// ==========================================================================
// COMP-025 — durable data directory with no VOLUME / Compose mount
// ==========================================================================

describe('COMP-025 — explicit durable data directory', () => {
  it('rejects a declared data/config dir with no VOLUME or Compose mount', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({
        name: 'homepage',
        scripts: { start: 'node dist/index.js' },
        dependencies: { express: '^4.18.0' },
      }),
      'src/config.ts': "const dir = process.env.HOMEPAGE_CONFIG_DIR || '/app/config';\n",
      'Dockerfile': 'FROM node:20-alpine\nCMD ["node", "dist/index.js"]\n',
    };
    const reason = rejectedDependency(tree, 'local-filesystem');
    expect(reason).toContain('HOMEPAGE_CONFIG_DIR');
  });

  it('does not reject when a production Compose mount covers the directory', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({ name: 'homepage', scripts: { start: 'node index.js' } }),
      'src/config.ts': "const dir = process.env.HOMEPAGE_CONFIG_DIR || '/app/config';\n",
      'docker-compose.yml': [
        'services:',
        '  app:',
        '    build: .',
        '    volumes:',
        '      - ./config:/app/config',
        '',
      ].join('\n'),
    };
    expect(rejectedDependency(tree, 'local-filesystem')).toBeUndefined();
  });

  it('leaves a plain app alone', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({ name: 'app', scripts: { start: 'node index.js' } }),
      'src/index.js': 'console.log("hi");\n',
    };
    expect(rejectedDependency(tree, 'local-filesystem')).toBeUndefined();
  });
});

// ==========================================================================
// COMP-010 — optional worker service in a reference Compose file
// ==========================================================================

describe('COMP-010 — optional compose service (deploy.replicas: 0)', () => {
  it('does not reject a second application service scaled to zero replicas', () => {
    const tree: FileTree = {
      'docker-compose.yml': [
        'services:',
        '  web:',
        '    image: myapp/web',
        '    ports:',
        '      - "3000:3000"',
        '  processor:',
        '    image: myapp/web',
        '    command: run-task-processor',
        '    deploy:',
        '      replicas: 0',
        '',
      ].join('\n'),
    };
    expect(rejectedDependency(tree, 'docker-compose-multi-service')).toBeUndefined();
  });

  it('still rejects a genuinely required second application service', () => {
    const tree: FileTree = {
      'docker-compose.yml': [
        'services:',
        '  web:',
        '    image: myapp/web',
        '  worker:',
        '    image: myapp/worker',
        '',
      ].join('\n'),
    };
    expect(rejectedDependency(tree, 'docker-compose-multi-service')).toContain('2 application services');
  });
});

// ==========================================================================
// COMP-033 — deployment descriptors reach the cloud checks
// ==========================================================================

describe('COMP-033 — deployment descriptors fire the cloud checks', () => {
  it('kustomization.yaml fires the kubernetes rejection', () => {
    const tree: FileTree = {
      'k8s/kustomization.yaml': 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\n',
      'package.json': JSON.stringify({ name: 'x', scripts: { start: 'node index.js' } }),
    };
    expect(rejectedDependency(tree, 'kubernetes')).toContain('kustomization.yaml');
  });

  it('a .tf file fires the terraform rejection', () => {
    const tree: FileTree = {
      'infra/main.tf': 'resource "aws_instance" "web" {}\n',
      'package.json': JSON.stringify({ name: 'x', scripts: { start: 'node index.js' } }),
    };
    expect(rejectedDependency(tree, 'terraform')).toContain('main.tf');
  });

  it('a .bicep file fires the azure rejection', () => {
    const tree: FileTree = {
      'infra/main.bicep': 'resource storageAccount "Microsoft.Storage/storageAccounts@2021-09-01" = {}\n',
      'package.json': JSON.stringify({ name: 'x', scripts: { start: 'node index.js' } }),
    };
    expect(rejectedDependency(tree, 'azure')).toBeDefined();
  });
});

describe('COMP-031 — required Temporal server', () => {
  it('rejects a default-stack Temporal service Deployz cannot provision', () => {
    const tree: FileTree = {
      'docker-compose.yml': [
        'services:',
        '  app:',
        '    image: postiz/app',
        '    environment:',
        '      - TEMPORAL_ADDRESS=temporal:7233',
        '  temporal:',
        '    image: temporalio/auto-setup:1.24',
        '',
      ].join('\n'),
    };
    const reason = rejectedDependency(tree, 'temporal');
    expect(reason).toContain('Temporal');
  });

  it('ignores an optional (profile-gated) Temporal service', () => {
    const tree: FileTree = {
      'docker-compose.yml': [
        'services:',
        '  app:',
        '    image: postiz/app',
        '  temporal:',
        '    image: temporalio/auto-setup:1.24',
        '    profiles:',
        '      - dev',
        '',
      ].join('\n'),
    };
    expect(rejectedDependency(tree, 'temporal')).toBeUndefined();
  });
});
