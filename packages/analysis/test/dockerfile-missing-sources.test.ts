import { describe, expect, it } from 'vitest';

import { analyseRepo } from '../src/analyser.js';
import { detectDockerfileBuildContext, detectDockerfileMissingCopySources, TREE_PATHS, type FileTree } from '../src/detectors.js';
import { evaluateManifestReadiness, normalizeDeploymentManifest } from '../src/manifest.js';

function withPaths(tree: Record<string, string>, extra: string[] = []): FileTree {
  Object.defineProperty(tree, TREE_PATHS, { value: [...Object.keys(tree), ...extra], enumerable: false });
  return tree;
}

const GO_MOD = 'module example.com/app\n';

describe('Dockerfile COPY sources the repository does not contain', () => {
  it('flags a prebuilt binary that only a CI step makes', () => {
    const tree = withPaths({
      'go.mod': GO_MOD,
      Dockerfile: 'FROM alpine:3.20\nCOPY listmonk .\nCOPY config.toml.sample config.toml\nEXPOSE 9000\nCMD ["./listmonk"]\n',
      'config.toml.sample': '[app]\n',
    });
    expect(detectDockerfileMissingCopySources(tree)).toEqual(['listmonk']);
    const manifest = normalizeDeploymentManifest(analyseRepo(tree), {});
    expect(manifest.build.missingSources).toEqual(['listmonk']);
    expect(evaluateManifestReadiness(manifest).findings.map((finding) => finding.id)).toContain('dockerfile-missing-sources');
  });

  it('finds a source relative to the Dockerfile directory and an unfetched directory', () => {
    const tree = withPaths(
      { 'docker/app/Dockerfile': 'FROM node:20\nCOPY server ./server\nCOPY entry.sh /entry.sh\nCMD ["node", "server/index.js"]\n', 'docker/app/entry.sh': '#!/bin/sh\n' },
      ['server/index.js'],
    );
    expect(detectDockerfileMissingCopySources(tree)).toEqual([]);
  });

  it('ignores stage copies, globs, URLs and build args', () => {
    const tree = withPaths({
      Dockerfile:
        'FROM node:20 AS build\nCOPY . .\nRUN npm run build\nFROM node:20\nCOPY --from=build /app/dist ./dist\nCOPY *.json ./\nADD https://example.com/a.tar.gz /a\nCOPY ${APP_DIR} /app\nCMD ["node", "dist/index.js"]\n',
      'package.json': '{"name":"app"}',
    });
    expect(detectDockerfileMissingCopySources(tree)).toEqual([]);
  });

  it('reads a flagged JSON form and a context-absolute source', () => {
    const tree = withPaths(
      { Dockerfile: 'FROM node:20\nCOPY --chown=node ["Community License DE.md", "Gemfile.lock", "./"]\nCOPY /backend /app\nCMD ["node", "index.js"]\n' },
      ['Community License DE.md', 'Gemfile.lock', 'backend/index.js'],
    );
    expect(detectDockerfileMissingCopySources(tree)).toEqual([]);
  });

  it('checks nothing when the full path list is unknown', () => {
    expect(detectDockerfileMissingCopySources({ Dockerfile: 'FROM alpine\nCOPY missing .\nCMD ["./missing"]\n' })).toEqual([]);
  });
});

describe('build context for a Dockerfile in a subdirectory', () => {
  it('is the repository root when a COPY source exists only at the root', () => {
    const tree = withPaths(
      { 'scripts/Dockerfile': 'FROM golang:1.25 AS backend\nCOPY go.mod go.sum ./\nRUN go mod download\nCOPY . .\nCMD ["./memos"]\n' },
      ['go.mod', 'go.sum', 'cmd/memos/main.go'],
    );
    expect(detectDockerfileBuildContext(tree)).toMatchObject({ detected: true, value: '.' });
  });

  it('stays the Dockerfile directory when the source sits next to it', () => {
    const tree = withPaths(
      { 'docker/Dockerfile': 'FROM node:20\nCOPY package.json ./\nCMD ["node", "index.js"]\n', 'docker/package.json': '{}' },
      ['package.json'],
    );
    expect(detectDockerfileBuildContext(tree).detected).toBe(false);
  });
});
