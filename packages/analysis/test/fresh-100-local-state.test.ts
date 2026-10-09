import { describe, expect, it } from 'vitest';

import { analyseRepo } from '../src/analyser.js';
import { TREE_PATHS, type FileTree } from '../src/detectors.js';
import { evaluateManifestReadiness, normalizeDeploymentManifest } from '../src/manifest.js';

function gate(tree: Record<string, string>, dependency: string) {
  Object.defineProperty(tree, TREE_PATHS, { value: Object.keys(tree), enumerable: false });
  const analysis = analyseRepo(tree as FileTree);
  const rejected = analysis.rejections.find((r) => r.detected && r.dependency === dependency);
  const state = evaluateManifestReadiness(normalizeDeploymentManifest(analysis, {})).state;
  return { rejected, state };
}

const RAILS_DOCKERFILE = 'FROM ruby:3.4-slim\nWORKDIR /rails\nCOPY . .\nEXPOSE 80\nCMD ["bin/rails", "server", "-b", "0.0.0.0", "-p", "80"]\n';
const SQLITE_DATABASE_YML = 'default: &default\n  adapter: sqlite3\nproduction:\n  <<: *default\n  database: storage/db/production.sqlite3\n';

describe('a Rails app whose only database adapter is sqlite3', () => {
  it('is NOT_COMPATIBLE', () => {
    const { rejected, state } = gate(
      { Dockerfile: RAILS_DOCKERFILE, Gemfile: 'source "https://rubygems.org"\ngem "rails"\ngem "sqlite3"\n', 'config/database.yml': SQLITE_DATABASE_YML },
      'sqlite',
    );
    expect(rejected?.reason).toContain('sqlite3 adapter');
    expect(state).toBe('NOT_COMPATIBLE');
  });

  it('is not rejected when the app also configures PostgreSQL', () => {
    const { rejected } = gate(
      {
        Dockerfile: RAILS_DOCKERFILE,
        Gemfile: 'gem "rails"\ngem "sqlite3"\ngem "pg"\n',
        'config/database.yml': `${SQLITE_DATABASE_YML}staging:\n  adapter: postgresql\n`,
      },
      'sqlite',
    );
    expect(rejected).toBeUndefined();
  });
});

describe('an image started with a configuration file that nothing creates', () => {
  const DOCKERFILE = 'FROM alpine:3\nCOPY app .\nEXPOSE 8080\nENTRYPOINT ["/app/server", "--config", "/app/config/server.yml"]\n';
  const APP = { 'go.mod': 'module example.com/server\n\ngo 1.22\n', 'main.go': 'package main\nfunc main() {}\n' };

  it('is NOT_COMPATIBLE', () => {
    const { rejected, state } = gate({ ...APP, Dockerfile: DOCKERFILE }, 'local-filesystem');
    expect(rejected?.reason).toContain('/app/config/server.yml');
    expect(state).toBe('NOT_COMPATIBLE');
  });

  it('is not rejected when the Dockerfile copies the file or the repository ships it', () => {
    expect(gate({ ...APP, Dockerfile: DOCKERFILE.replace('EXPOSE', 'COPY config/ /app/config/\nEXPOSE') }, 'local-filesystem').rejected).toBeUndefined();
    expect(gate({ ...APP, Dockerfile: DOCKERFILE, 'config/server.yml': 'port: 8080\n' }, 'local-filesystem').rejected).toBeUndefined();
  });
});
