import { describe, expect, it } from 'vitest';

import type { FileTree } from '../src/analyser.js';
import { analyseRepo } from '../src/analyser.js';
import { detectEnvVarModel } from '../src/detectors.js';
import { evaluateManifestReadiness, normalizeDeploymentManifest } from '../src/manifest.js';

function rejectedDependency(tree: FileTree, dependency: string): string | undefined {
  return analyseRepo(tree).rejections.find((r) => r.detected && r.dependency === dependency)?.reason;
}

// ==========================================================================
// COMP-021 regression guard — documented limitation
// ==========================================================================

describe('COMP-021 regression guard — missing COPY source does NOT reject', () => {
  it('keeps a repo whose Dockerfile COPYs an absent source deployable (capped tree makes absence unsound)', () => {
    const tree: FileTree = {
      'Dockerfile': 'FROM node:20-alpine\nCOPY listmonk .\nCMD ["listmonk"]\n',
      'package.json': JSON.stringify({ name: 'x', scripts: { start: 'node index.js' } }),
    };
    expect(rejectedDependency(tree, 'missing-copy-source')).toBeUndefined();
  });

  it('never rejects multi-stage COPY --from= or generated-artifact directories', () => {
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

  // A config dir selected with a MULTILINE fallback (gethomepage/homepage)
  // and an app state home read as an env var (thelounge) both declare a
  // durable directory the same way an inline default does — COMP-025 must not
  // depend on the default sitting on the same line as the read.
  it('rejects a config dir read with a multiline local default (homepage)', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({ name: 'homepage', scripts: { start: 'node dist/index.js' } }),
      'src/utils/config/config.js': [
        'import { join } from "path";',
        'export const CONF_DIR = process.env.HOMEPAGE_CONFIG_DIR',
        '  ? process.env.HOMEPAGE_CONFIG_DIR',
        '  : join(process.cwd(), "config");',
        '',
      ].join('\n'),
      'Dockerfile': 'FROM node:20-alpine\nCMD ["node", "dist/index.js"]\n',
    };
    const reason = rejectedDependency(tree, 'local-filesystem');
    expect(reason).toContain('HOMEPAGE_CONFIG_DIR');
  });

  it('rejects an app state home read as an env var (thelounge)', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({ name: 'thelounge', scripts: { start: 'node index.js' } }),
      'server/command-line/index.ts': 'Config.setHome(process.env.THELOUNGE_HOME || Utils.defaultHome());\n',
    };
    const reason = rejectedDependency(tree, 'local-filesystem');
    expect(reason).toContain('THELOUNGE_HOME');
  });

  it('rejects a durable work dir the selected image names in its ENV (halo)', () => {
    const tree: FileTree = {
      'Dockerfile': [
        'FROM eclipse-temurin:21-jre',
        'ENV JVM_OPTS="" \\',
        '    HALO_WORK_DIR="/root/.halo2" \\',
        '    TZ=Asia/Shanghai',
        'EXPOSE 8090',
        '',
      ].join('\n'),
      'package.json': JSON.stringify({ name: 'halo', scripts: { start: 'node index.js' } }),
    };
    const reason = rejectedDependency(tree, 'local-filesystem');
    expect(reason).toContain('HALO_WORK_DIR');
  });

  // Build-tool search paths and relative tool directories are not durable app
  // state: a variable name alone never fires, only a durable-dir name with a
  // local value or read.
  it('ignores a pkg-config search path in a non-selected Dockerfile variant', () => {
    const tree: FileTree = {
      'Dockerfile': 'FROM ubuntu\nCMD ["node", "server.js"]\n',
      'docker/Dockerfile.s390x': 'FROM ubuntu\nENV PKG_CONFIG_PATH=/opt/rh/gcc-toolset-14/root/usr/lib64/pkgconfig\n',
    };
    expect(rejectedDependency(tree, 'local-filesystem')).toBeUndefined();
  });

  it('ignores a relative user-data directory read for an optional tool', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({ name: 'dashy', scripts: { start: 'node server.js' } }),
      'services/endpoints/save-config.js': "const userDataDirectory = process.env.USER_DATA_DIR || './user-data/';\n",
    };
    expect(rejectedDependency(tree, 'local-filesystem')).toBeUndefined();
  });
});

// COMP-024 precision — a Dockerfile VOLUME / compose mount for LOGS, CACHES or
// a single-file config mount is transient state, not durable app data. The
// same boundary the write-call rule draws ("a cache write, a temp file, a
// generated asset, a log line is not state the app needs back") applies to
// the VOLUME/mount evidence itself.
describe('COMP-024 — ephemeral and config mounts are not durable state', () => {
  it('ignores a compose volume mounted at a log/cache path (windmill worker logs)', () => {
    const tree: FileTree = {
      'Dockerfile': 'FROM rust:1.80\nCMD ["windmill"]\n',
      'docker-compose.yml': [
        'services:',
        '  windmill_worker:',
        '    image: windmill',
        '    volumes:',
        '      - worker_logs:/tmp/windmill/logs',
        '      - worker_dependency_cache:/tmp/windmill/cache',
        '      - lsp_cache:/pyls/.cache',
        'volumes:',
        '  worker_logs:',
        '  worker_dependency_cache:',
        '  lsp_cache:',
        '',
      ].join('\n'),
    };
    const analysis = analyseRepo(tree);
    expect(analysis.findings.find((f) => f.detector === 'local-filesystem')).toMatchObject({ detected: false });
  });

  it('ignores a single-file `.env` config mount (hedgedoc)', () => {
    const tree: FileTree = {
      'Dockerfile': 'FROM node:20-alpine\nCMD ["node", "dist/main.js"]\n',
      'docker-compose.yml': [
        'services:',
        '  backend:',
        '    build: .',
        '    volumes:',
        '      - ./.env:/usr/src/app/backend/.env',
        '',
      ].join('\n'),
    };
    const analysis = analyseRepo(tree);
    expect(analysis.findings.find((f) => f.detector === 'local-filesystem')).toMatchObject({ detected: false });
  });

  it('still detects a genuine data volume (changedetection /datastore)', () => {
    const tree: FileTree = {
      'Dockerfile': 'FROM python:3.11\nCMD ["python", "./changedetection.py", "-d", "/datastore"]\n',
      'docker-compose.yml': [
        'services:',
        '  changedetection:',
        '    image: ghcr.io/dgtlmoon/changedetection.io',
        '    volumes:',
        '      - changedetection-data:/datastore',
        'volumes:',
        '  changedetection-data:',
        '',
      ].join('\n'),
    };
    const analysis = analyseRepo(tree);
    expect(analysis.findings.find((f) => f.detector === 'local-filesystem')).toMatchObject({ detected: true });
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
