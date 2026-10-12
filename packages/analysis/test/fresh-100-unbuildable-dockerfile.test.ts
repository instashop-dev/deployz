import { describe, expect, it } from 'vitest';

import { analyseRepo } from '../src/analyser.js';
import { TREE_PATHS, type FileTree } from '../src/detectors.js';
import { evaluateManifestReadiness, normalizeDeploymentManifest } from '../src/manifest.js';

function withPaths(tree: Record<string, string>, extra: string[] = []): FileTree {
  Object.defineProperty(tree, TREE_PATHS, { value: [...Object.keys(tree), ...extra], enumerable: false });
  return tree;
}

function gate(tree: FileTree) {
  const analysis = analyseRepo(tree);
  const rejected = analysis.rejections.find((r) => r.detected && r.dependency === 'no-buildable-dockerfile');
  const state = evaluateManifestReadiness(normalizeDeploymentManifest(analysis, {})).state;
  return { rejected, state };
}

const APP = { 'package.json': JSON.stringify({ name: 'x', scripts: { start: 'node index.js' } }), 'index.js': 'listen(3000)\n' };

describe('a repository with no Dockerfile that builds a production image', () => {
  it('is NOT_COMPATIBLE when no Dockerfile exists', () => {
    const { rejected, state } = gate(withPaths({ ...APP }));
    expect(rejected?.reason).toContain('No Dockerfile exists');
    expect(state).toBe('NOT_COMPATIBLE');
  });

  it('is NOT_COMPATIBLE when the only Dockerfile is a template', () => {
    const { rejected, state } = gate(
      withPaths({ ...APP, Dockerfile: '{{#ubi}}\nFROM ubi9\n{{/ubi}}\n{{^ubi}}\nFROM debian\n{{/ubi}}\nCMD ["node", "index.js"]\n' }),
    );
    expect(rejected?.reason).toContain('development or a template');
    expect(state).toBe('NOT_COMPATIBLE');
  });

  it('is NOT_COMPATIBLE when the only Dockerfile is for development', () => {
    const { rejected, state } = gate(
      withPaths({ ...APP, 'Dockerfile.dev': 'FROM node:20\nCOPY . .\nEXPOSE 3000\nCMD ["npm", "run", "dev"]\n' }),
    );
    expect(rejected).toBeDefined();
    expect(state).toBe('NOT_COMPATIBLE');
  });

  it('is NOT_COMPATIBLE when the only Dockerfile copies a prebuilt binary the repository lacks', () => {
    const { rejected, state } = gate(
      withPaths({ ...APP, Dockerfile: 'FROM alpine:3.20\nCOPY server /usr/bin/server\nEXPOSE 3000\nCMD ["server"]\n' }),
    );
    expect(rejected?.reason).toContain('server');
    expect(state).toBe('NOT_COMPATIBLE');
  });
});

describe('evidence that is not complete never rejects (COMP-021)', () => {
  const missingSource = 'FROM alpine:3.20\nCOPY server /usr/bin/server\nEXPOSE 3000\nCMD ["server"]\n';

  it('does not reject without the full tracked path list', () => {
    expect(gate({ ...APP, Dockerfile: missingSource }).rejected).toBeUndefined();
    expect(gate({ ...APP }).rejected).toBeUndefined();
  });

  it('does not reject when a second candidate Dockerfile exists', () => {
    const tree = withPaths({ ...APP, Dockerfile: missingSource, 'docker/Dockerfile.web': 'FROM node:20\nCOPY . .\nCMD ["node", "index.js"]\n' });
    expect(gate(tree).rejected).toBeUndefined();
  });

  it('does not reject when a tracked Dockerfile was not fetched', () => {
    const tree = withPaths({ ...APP, Dockerfile: missingSource }, ['deploy/Dockerfile.prod']);
    expect(gate(tree).rejected).toBeUndefined();
  });

  it('does not reject when a git submodule may hold the source', () => {
    const tree = withPaths({ ...APP, '.gitmodules': '[submodule "x"]\n', Dockerfile: missingSource });
    expect(gate(tree).rejected).toBeUndefined();
  });

  it('does not reject COPY --from= or a generated directory', () => {
    const tree = withPaths({
      ...APP,
      Dockerfile: 'FROM golang:1.22 AS build\nRUN go build -o /out/app .\nFROM alpine\nCOPY --from=build /out/app /usr/bin/app\nCOPY dist ./dist\nEXPOSE 3000\nCMD ["app"]\n',
    });
    expect(gate(tree).rejected).toBeUndefined();
  });

  it('does not reject a buildable Dockerfile', () => {
    const tree = withPaths({ ...APP, Dockerfile: 'FROM node:20\nCOPY . .\nEXPOSE 3000\nCMD ["node", "index.js"]\n' });
    expect(gate(tree).rejected).toBeUndefined();
  });
});
