import { describe, expect, it } from 'vitest';

import type { FileTree } from '../src/analyser.js';
import {
  checkExplicitPersistentDataDir,
  checkKubernetes,
  checkOtherUnsupportedDatabases,
  checkTerraform,
  listIgnoredDeploymentFiles,
} from '../src/rejection.js';

const DOCKERFILE = 'FROM node:20-alpine\nCMD ["node", "server.js"]\n';

describe('dogfood and scaletest directories are not the deployment', () => {
  const coder: FileTree = {
    'Dockerfile': DOCKERFILE,
    'dogfood/coder/main.tf': 'resource "docker_container" "workspace" {}\n',
    'scaletest/templates/scaletest-runner/main.tf': 'resource "kubernetes_pod" "runner" {}\n',
  };

  it('does not reject Terraform there and lists both files as ignored', () => {
    expect(checkTerraform(coder).detected).toBe(false);
    expect(listIgnoredDeploymentFiles(coder)).toEqual(
      expect.arrayContaining(['dogfood/coder/main.tf', 'scaletest/templates/scaletest-runner/main.tf']),
    );
  });

  it('still rejects a root main.tf', () => {
    expect(checkTerraform({ ...coder, 'main.tf': 'resource "aws_instance" "web" {}\n' }).detected).toBe(true);
  });

  it('still rejects a Go module that imports client-go', () => {
    const tree: FileTree = {
      ...coder,
      'go.mod': 'module example.com/app\n\nrequire (\n\tk8s.io/client-go v0.30.0\n)\n',
      'deploy/kustomization.yaml': 'resources: []\n',
    };
    expect(checkKubernetes(tree).detected).toBe(true);
  });
});

describe('PostgreSQL extension images in the production Compose file', () => {
  const compose = (image: string): string => `services:\n  database:\n    image: ${image}\n    ports:\n      - "5432:5432"\n`;

  it.each(['paradedb/paradedb:latest', 'timescale/timescaledb:latest-pg16', 'citusdata/citus:12.1'])('rejects %s', (image) => {
    const finding = checkOtherUnsupportedDatabases({ 'Dockerfile': DOCKERFILE, 'docker-compose.yml': compose(image) });
    expect(finding.detected).toBe(true);
    expect(finding.dependency).toBe('other-database');
    expect(finding.reason).toContain('PostgreSQL extension');
  });

  it.each(['pgvector/pgvector:pg16', 'postgis/postgis:16-3.4', 'postgres:16'])('accepts %s', (image) => {
    expect(checkOtherUnsupportedDatabases({ 'Dockerfile': DOCKERFILE, 'docker-compose.yml': compose(image) }).detected).toBe(false);
  });

  it('ignores a ParadeDB image in a dev Compose file', () => {
    const tree: FileTree = { 'Dockerfile': DOCKERFILE, 'docker-compose.yml': compose('postgres:16'), 'docker-compose.dev.yml': compose('paradedb/paradedb') };
    expect(checkOtherUnsupportedDatabases(tree).detected).toBe(false);
    expect(checkOtherUnsupportedDatabases({ 'Dockerfile': DOCKERFILE, 'dev/docker-compose.yml': compose('paradedb/paradedb') }).detected).toBe(false);
  });
});

describe('shipped configuration is not customer-written state', () => {
  it('does not flag a config directory that the Dockerfile copies', () => {
    const tree: FileTree = {
      'Dockerfile': 'FROM node:20-alpine\nENV APP_CONFIG_DIR=/app/config\nCOPY config /app/config\nCMD ["node", "server.js"]\n',
      'config/settings.yaml': 'title: app\n',
    };
    expect(checkExplicitPersistentDataDir(tree).detected).toBe(false);
  });

  it('does not flag a config directory under a copied build context', () => {
    const tree: FileTree = {
      'Dockerfile': 'FROM node:20-alpine\nENV APP_CONFIG_DIR=/app/config\nCOPY . /app\nCMD ["node", "server.js"]\n',
    };
    expect(checkExplicitPersistentDataDir(tree).detected).toBe(false);
  });

  it('still flags a config directory that the Dockerfile only creates (Homepage shape)', () => {
    const tree: FileTree = {
      'Dockerfile': 'FROM node:20-alpine\nENV HOMEPAGE_CONFIG_DIR=/app/config\nRUN mkdir config\nCMD ["node", "server.js"]\n',
    };
    expect(checkExplicitPersistentDataDir(tree).detected).toBe(true);
  });

  it('still flags a data directory even when the Dockerfile copies into it', () => {
    const tree: FileTree = {
      'Dockerfile': 'FROM node:20-alpine\nENV APP_DATA_DIR=/data\nCOPY seed /data\nCMD ["node", "server.js"]\n',
    };
    expect(checkExplicitPersistentDataDir(tree).detected).toBe(true);
  });
});
