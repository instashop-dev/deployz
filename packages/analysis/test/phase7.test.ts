import { describe, expect, it } from 'vitest';

import { analyseRepo, type FileTree } from '../src/analyser.js';
import {
  detectEnvVarModel,
  detectExternalServices,
  detectPostgresql,
  detectS3,
  detectLocalFilesystem,
} from '../src/detectors.js';
import { evaluateManifestReadiness, normalizeDeploymentManifest } from '../src/manifest.js';
import { buildReadinessReport } from '../src/readiness-report.js';

// ==========================================================================
// §11.2 env-var model
// ==========================================================================

describe('detectEnvVarModel (§11.2)', () => {
  it('marks a sample-empty var the app reads (Prisma env()) as required, with evidence', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({ dependencies: { '@prisma/client': '^5.0.0' } }),
      'prisma/schema.prisma': 'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n',
      '.env.example': 'DATABASE_URL=\nPORT=3000\nNEXTAUTH_SECRET=\n',
      'src/index.ts': [
        "import { PrismaClient } from '@prisma/client';",
        'const db = new PrismaClient();',
        'app.listen(process.env.PORT ?? 3000);',
        'if (process.env.NODE_ENV === "production") console.log("prod");',
        '',
      ].join('\n'),
    };
    const model = detectEnvVarModel(tree);
    const byKey = new Map(model.map((entry) => [entry.key, entry]));

    expect(byKey.get('DATABASE_URL')).toMatchObject({ required: true, secret: false });
    expect(byKey.get('DATABASE_URL')!.source.join(' ')).toContain('schema.prisma');
    // A real sample default + a `??` fallback read is NOT required.
    expect(byKey.get('PORT')).toMatchObject({ required: false });
    // A sample entry the app never reads is documented but NOT required.
    expect(byKey.get('NEXTAUTH_SECRET')).toMatchObject({ required: false });
    // A presence-guard read is not a required value.
    expect(byKey.get('NODE_ENV')).toMatchObject({ required: false });
  });

  it('requires a code-only bare read of a secret-named variable with no default anywhere', () => {
    const tree: FileTree = {
      'src/index.js': "const token = process.env.INTERNAL_API_TOKEN;\n",
    };
    const model = detectEnvVarModel(tree);
    expect(model).toEqual([
      {
        key: 'INTERNAL_API_TOKEN',
        required: true,
        secret: true,
        source: ['read in src/index.js'],
        purpose: 'internal_secret',
        confidence: 'medium',
      },
    ]);
    // A non-secret option stored as-is proves nothing about need (COMP-023).
    const stored = detectEnvVarModel({ 'src/index.js': 'const url = process.env.INTERNAL_API_URL;\n' });
    expect(stored).toEqual([
      {
        key: 'INTERNAL_API_URL',
        required: false,
        secret: false,
        source: ['read in src/index.js'],
        purpose: 'optional_configuration',
        confidence: 'medium',
      },
    ]);
  });

  it('does not require a defaulted or guarded read', () => {
    const tree: FileTree = {
      '.env.example': 'LOG_LEVEL=info\n',
      'src/index.js': [
        "const level = process.env.LOG_LEVEL || 'info';",
        "if (process.env.DEBUG) console.log('debug');",
        '',
      ].join('\n'),
    };
    const model = detectEnvVarModel(tree);
    const byKey = new Map(model.map((entry) => [entry.key, entry]));
    expect(byKey.get('LOG_LEVEL')).toMatchObject({ required: false });
    expect(byKey.get('DEBUG')).toMatchObject({ required: false });
  });
});

describe('detectExternalServices (§11.3)', () => {
  it('records a canonical service from a declared SDK and upgrades its key to required+secret', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({
        name: 'shop',
        dependencies: { stripe: '^14.0.0', express: '^4.18.0' },
      }),
      'src/index.ts': [
        "import Stripe from 'stripe';",
        'const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);',
        '',
      ].join('\n'),
    };
    const finding = detectExternalServices(tree);
    expect(finding.detected).toBe(true);
    expect(finding.value).toContain('stripe');

    const services = (finding.value as string[]) ?? [];
    const model = detectEnvVarModel(tree, services);
    const secretKey = model.find((entry) => entry.key === 'STRIPE_SECRET_KEY');
    expect(secretKey).toMatchObject({ required: true, secret: true });
    expect(secretKey!.source.join(' ')).toContain('stripe requires STRIPE_SECRET_KEY');
  });

  it('does not invent integrations from prose or unrelated URLs', () => {
    const tree: FileTree = {
      'README.md': 'This app is the best thing since Stripe and uses OpenAI ideas.',
      'src/index.js': [
        "const res = await fetch('https://example.com/webhooks/not-a-service');",
        '',
      ].join('\n'),
    };
    expect(detectExternalServices(tree).detected).toBe(false);
  });
});

// ==========================================================================
// §11.4 architecture rejections
// ==========================================================================

describe('§11.4 architecture rejections', () => {
  const rejection = (tree: FileTree, dependency: string) =>
    analyseRepo(tree).rejections.find((r) => r.dependency === dependency);

  it('sqlite', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({ dependencies: { 'better-sqlite3': '^11.0.0' } }),
    };
    expect(rejection(tree, 'sqlite')?.detected).toBe(true);
  });

  it('kafka', () => {
    // A client plus a connection variable the app cannot run without; a bare
    // client dependency is an optional integration (COMP-002).
    const tree: FileTree = {
      'package.json': JSON.stringify({ dependencies: { kafkajs: '^2.2.0' } }),
      'src/consumer.js': "const brokers = process.env.KAFKA_BROKERS.split(',');\n",
    };
    expect(rejection(tree, 'kafka')?.detected).toBe(true);
    expect(rejection({ 'package.json': tree['package.json']! }, 'kafka')).toBeUndefined();
  });

  it('rabbitmq', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({ dependencies: { amqplib: '^0.10.0' } }),
      'src/queue.js': 'const connection = await amqp.connect(process.env.AMQP_URL);\n',
    };
    expect(rejection(tree, 'rabbitmq')?.detected).toBe(true);
  });

  it('sqs event consumer', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({ dependencies: { '@aws-sdk/client-sqs': '^3.0.0' } }),
      'src/consumer.js': "sqs.receiveMessage({ QueueUrl }, cb);\n",
    };
    expect(rejection(tree, 'sqs-event-consumer')?.detected).toBe(true);
  });

  it('kubernetes', () => {
    const tree: FileTree = {
      'k8s/kustomization.yaml': 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\n',
    };
    expect(rejection(tree, 'kubernetes')?.detected).toBe(true);
  });

  it('kubernetes via a plain Deployment manifest (no kustomize/helm files)', () => {
    const tree: FileTree = {
      'deploy/web.yaml': [
        'apiVersion: apps/v1',
        'kind: Deployment',
        'metadata:',
        '  name: web',
        '',
      ].join('\n'),
    };
    expect(rejection(tree, 'kubernetes')?.detected).toBe(true);
  });

  it('serverless', () => {
    const tree: FileTree = {
      'serverless.yml': 'service: demo\nprovider:\n  name: aws\n',
    };
    expect(rejection(tree, 'serverless')?.detected).toBe(true);
  });

  it('docker compose multi-service', () => {
    const tree: FileTree = {
      'docker-compose.yml': [
        'services:',
        '  web:',
        '    image: node:20-alpine',
        '  worker:',
        '    image: node:20-alpine',
        '',
      ].join('\n'),
    };
    expect(rejection(tree, 'docker-compose-multi-service')?.detected).toBe(true);
  });

  it('persistent volume', () => {
    const tree: FileTree = {
      'k8s/pvc.yaml': 'apiVersion: v1\nkind: PersistentVolumeClaim\nmetadata:\n  name: data\n',
    };
    expect(rejection(tree, 'persistent-volume')?.detected).toBe(true);
  });

  it('terraform', () => {
    const tree: FileTree = { 'infra/main.tf': 'resource "aws_instance" "web" {}\n' };
    expect(rejection(tree, 'terraform')?.detected).toBe(true);
  });

  it('pulumi', () => {
    const tree: FileTree = { 'Pulumi.yaml': 'name: demo\nruntime: nodejs\n' };
    expect(rejection(tree, 'pulumi')?.detected).toBe(true);
  });

  it('customer CloudFormation', () => {
    const tree: FileTree = { 'cloudformation/app.json': '{"AWSTemplateFormatVersion": "2010-09-09"}' };
    expect(rejection(tree, 'cloudformation')?.detected).toBe(true);
  });

  it('azure', () => {
    const tree: FileTree = { 'azure-pipelines.yml': 'trigger:\n  - main\n' };
    expect(rejection(tree, 'azure')?.detected).toBe(true);
  });

  it('gcp', () => {
    const tree: FileTree = { 'app.yaml': 'runtime: nodejs18\n' };
    expect(rejection(tree, 'gcp')?.detected).toBe(true);
  });

  it('gpu', () => {
    const tree: FileTree = { 'Dockerfile': 'FROM nvidia/cuda:12.0-base\nCMD ["echo"]\n' };
    expect(rejection(tree, 'gpu')?.detected).toBe(true);
  });

  it('clean repos are never blocked by the architecture checks', () => {
    const tree: FileTree = {
      'Dockerfile': 'FROM node:20-alpine\nCMD ["node", "index.js"]\n',
      'package.json': JSON.stringify({ dependencies: { express: '^4.18.0' } }),
      'src/index.js': 'app.listen(process.env.PORT || 3000);\n',
    };
    const analysis = analyseRepo(tree);
    const blocked = analysis.rejections.filter((r) => r.detected);
    expect(blocked).toEqual([]);
  });

  // ── CANARY-002: dev-only compose files, and cloud SDK packages that are
  // not evidence of a cloud deployment ─────────────────────────────────────

  it('a dev-only compose file with two app services is NOT rejected', () => {
    const tree: FileTree = {
      'docker/development/compose.yml': [
        'services:',
        '  inbucket:',
        '    image: inbucket/inbucket:latest',
        '  gotenberg:',
        '    image: gotenberg/gotenberg:8',
        '',
      ].join('\n'),
    };
    expect(rejection(tree, 'docker-compose-multi-service')?.detected).toBeFalsy();
  });

  it('a production compose file with two app services IS rejected', () => {
    const tree: FileTree = {
      'docker/production/compose.yml': [
        'services:',
        '  web:',
        '    image: myapp/web:latest',
        '  worker:',
        '    image: myapp/worker:latest',
        '',
      ].join('\n'),
    };
    expect(rejection(tree, 'docker-compose-multi-service')?.detected).toBe(true);
  });

  it('a root docker-compose.yml (one app service) wins over a nested production compose (two app services)', () => {
    const tree: FileTree = {
      'docker-compose.yml': [
        'services:',
        '  web:',
        '    image: myapp/web:latest',
        '',
      ].join('\n'),
      'docker/production/compose.yml': [
        'services:',
        '  web:',
        '    image: myapp/web:latest',
        '  worker:',
        '    image: myapp/worker:latest',
        '',
      ].join('\n'),
    };
    // If the nested two-service file were consulted instead of the root
    // file, this would reject — the root file must win.
    expect(rejection(tree, 'docker-compose-multi-service')?.detected).toBeFalsy();
  });

  it('@azure/storage-blob alone is NOT rejected; azure-pipelines.yml still is', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({ dependencies: { '@azure/storage-blob': '^12.0.0' } }),
    };
    expect(rejection(tree, 'azure')?.detected).toBeFalsy();

    const withPipeline: FileTree = { ...tree, 'azure-pipelines.yml': 'trigger:\n  - main\n' };
    expect(rejection(withPipeline, 'azure')?.detected).toBe(true);
  });

  it('@google-cloud/kms alone is NOT rejected; cloudbuild.yaml still is', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({ dependencies: { '@google-cloud/kms': '^4.0.0' } }),
    };
    expect(rejection(tree, 'gcp')?.detected).toBeFalsy();

    const withCloudBuild: FileTree = { ...tree, 'cloudbuild.yaml': 'steps:\n  - name: gcr.io/cloud-builders/docker\n' };
    expect(rejection(withCloudBuild, 'gcp')?.detected).toBe(true);
  });

  it('documenso-shaped fixture: dev compose + optional cloud SDKs are not rejected', () => {
    const tree: FileTree = {
      'docker/development/compose.yml': [
        'services:',
        '  inbucket:',
        '    image: inbucket/inbucket:latest',
        '  gotenberg:',
        '    image: gotenberg/gotenberg:8',
        '',
      ].join('\n'),
      'docker/production/compose.yml': [
        'services:',
        '  documenso:',
        '    image: documenso/documenso:latest',
        '  postgres:',
        '    image: postgres:15',
        '',
      ].join('\n'),
      'docker/Dockerfile': 'FROM node:20-alpine\nCMD ["node", "start.js"]\n',
      'packages/lib/package.json': JSON.stringify({
        name: '@documenso/lib',
        dependencies: { '@azure/storage-blob': '^12.0.0' },
      }),
      'packages/signing/package.json': JSON.stringify({
        name: '@documenso/signing',
        dependencies: { '@google-cloud/kms': '^4.0.0' },
      }),
    };
    const analysis = analyseRepo(tree);
    const blocked = analysis.rejections.filter((r) => r.detected);
    expect(blocked).toEqual([]);
  });
});

// ==========================================================================
// §11.5 language breadth
// ==========================================================================

describe('§11.5 language breadth', () => {
  it('detects Python psycopg2 + a postgres:// URL as a required PostgreSQL app', () => {
    const tree: FileTree = {
      'requirements.txt': 'psycopg2==2.9.9\n',
      'app.py': [
        'import psycopg2',
        "conn = psycopg2.connect('postgres://user:pass@db:5432/app')",
        '',
      ].join('\n'),
    };
    const finding = detectPostgresql(tree);
    expect(finding.detected).toBe(true);
    expect(finding.value).toEqual(
      expect.arrayContaining(['psycopg2', 'postgres connection URL']),
    );
    const analysis = analyseRepo(tree);
    expect((analysis.metadata['postgres'] as { required: boolean }).required).toBe(true);
  });

  it('detects Go pgx from go.mod', () => {
    const tree: FileTree = {
      'go.mod': 'module example.com/app\n\ngo 1.22\n\nrequire github.com/jackc/pgx/v5 v5.6.0\n',
      'main.go': 'package main\n',
    };
    expect(detectPostgresql(tree).value).toEqual(expect.arrayContaining(['jackc/pgx']));
  });

  it('detects boto3 S3 usage from requirements + client calls', () => {
    const tree: FileTree = {
      'requirements.txt': 'boto3==1.34.0\n',
      'upload.py': "import boto3\ns3 = boto3.client('s3')\ns3.upload_file('a', 'bucket', 'b')\n",
    };
    const finding = detectS3(tree);
    expect(finding.detected).toBe(true);
    expect(finding.value).toEqual(expect.arrayContaining(['boto3']));
  });

  it('detects declared local state in Python and Ruby images, not bare writes', () => {
    const python: FileTree = {
      Dockerfile: 'FROM python:3.12\nVOLUME ["/var/data"]\nCMD ["python", "app.py"]\n',
      'writer.py': "with open('/var/data/file.json', 'w') as f:\n    f.write('x')\n",
    };
    const py = detectLocalFilesystem(python);
    expect(py.detected).toBe(true);
    expect(py.value).toEqual(['VOLUME /var/data (Dockerfile)']);

    const ruby: FileTree = {
      'writer.rb': "File.write('/var/data/file.json', 'x')\n",
    };
    expect(detectLocalFilesystem(ruby).detected).toBe(false);
  });
});

// ==========================================================================
// Fixture classification end to end (analysis → manifest → readiness)
// ==========================================================================

describe('fixture classification (analysis → manifest → readiness)', () => {
  const SUPPORTED_TREE: FileTree = {
    'Dockerfile': [
      'FROM node:20-alpine',
      'HEALTHCHECK --interval=30s CMD curl -f http://localhost:3000/health || exit 1',
      'CMD ["node", "src/index.js"]',
      '',
    ].join('\n'),
    'package.json': JSON.stringify({
      name: 'supported-app',
      scripts: { start: 'node src/index.js', 'db:migrate': 'npx drizzle-kit push' },
      dependencies: { express: '^4.18.0', pg: '^8.12.0' },
    }),
    'src/index.js': [
      "app.get('/health', (_req, res) => res.json({ ok: true }));",
      'app.listen(process.env.PORT || 3000);',
      '',
    ].join('\n'),
    '.env.example': 'DATABASE_URL=\n',
  };

  it('classifies a supported app READY at both layers', () => {
    const analysis = analyseRepo(SUPPORTED_TREE);
    expect(buildReadinessReport(analysis).state).toBe('READY');
    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(evaluateManifestReadiness(manifest).state).toBe('READY');
    expect(manifest.unsupported).toEqual([]);
  });

  it('classifies an unsupported app NOT_COMPATIBLE at the manifest gate (never provisions)', () => {
    const tree: FileTree = {
      ...SUPPORTED_TREE,
      'package.json': JSON.stringify({
        name: 'queue-app',
        scripts: { start: 'node src/index.js' },
        dependencies: { express: '^4.18.0', kafkajs: '^2.2.0' },
      }),
      'src/consumer.js': "const brokers = process.env.KAFKA_BROKERS.split(',');\n",
    };
    const analysis = analyseRepo(tree);
    // Semantic layer: blocking required finding.
    const report = buildReadinessReport(analysis);
    expect(report.state).toBe('NEEDS_CHANGES');
    expect(report.findings.some((f) => f.id === 'unsupported-message-queue' && f.blocking)).toBe(true);
    // Manifest layer: NOT_COMPATIBLE regardless of how complete the container
    // config is — the deployment gate blocks before AWS provisioning.
    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.unsupported.length).toBeGreaterThan(0);
    expect(evaluateManifestReadiness(manifest).state).toBe('NOT_COMPATIBLE');
  });

  it('classifies a missing required env var as NEEDS_CONFIGURATION only when no value is provided', () => {
    const analysis = analyseRepo({
      ...SUPPORTED_TREE,
      'src/index.js': [
        'const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);',
        'app.listen(process.env.PORT || 3000);',
        '',
      ].join('\n'),
      'package.json': JSON.stringify({
        name: 'stripe-app',
        scripts: { start: 'node src/index.js' },
        dependencies: { express: '^4.18.0', stripe: '^14.0.0' },
      }),
    });
    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.environment.variables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'STRIPE_SECRET_KEY', required: true, secret: true }),
      ]),
    );

    // No provided value → NEEDS_CONFIGURATION naming the key.
    const blocked = evaluateManifestReadiness(manifest, { providedEnvKeys: [] });
    expect(blocked.state).toBe('NEEDS_CONFIGURATION');
    const finding = blocked.findings.find((f) => f.id === 'required-env-vars-missing');
    expect(finding?.message).toContain('STRIPE_SECRET_KEY');

    // Deployz-provided bindings count as provided: DATABASE_URL is injected
    // because the app requires PostgreSQL.
    const ready = evaluateManifestReadiness(manifest, { providedEnvKeys: ['STRIPE_SECRET_KEY'] });
    expect(ready.state).toBe('READY');
  });

  it('classifies the monorepo shape as one deployable app rooted at the nested Dockerfile', () => {
    const tree: FileTree = {
      'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
      'pnpm-lock.yaml': '',
      'package.json': JSON.stringify({ name: 'monorepo', private: true, packageManager: 'pnpm@9' }),
      'apps/web/package.json': JSON.stringify({
        name: 'web',
        scripts: { build: 'next build' },
        dependencies: { next: '^14.2.0' },
      }),
      'apps/api/package.json': JSON.stringify({
        name: 'api',
        scripts: { start: 'node src/index.js' },
        dependencies: { express: '^4.18.0' },
      }),
      'apps/api/Dockerfile': [
        'FROM node:20-alpine',
        'WORKDIR /app',
        'COPY apps/api/package.json ./',
        'COPY apps/api/src ./src',
        'EXPOSE 3000',
        'CMD ["node", "src/index.js"]',
        '',
      ].join('\n'),
      'apps/api/src/index.js': 'app.listen(process.env.PORT || 3000);\n',
    };
    const analysis = analyseRepo(tree);
    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.application.root).toBe('apps/api');
    expect(manifest.application.dockerfilePath).toBe('apps/api/Dockerfile');
    expect(manifest.build.context).toBe('.');
    expect(evaluateManifestReadiness(manifest).state).toBe('READY');
  });
});
