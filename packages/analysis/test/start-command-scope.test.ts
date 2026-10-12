import { describe, expect, it } from 'vitest';

import { detectStartupCommand } from '../src/detectors.js';

const DOCKERFILE_NO_CMD = 'FROM node:20\nWORKDIR /app\nCOPY . .\nRUN npm ci && npm run build\nEXPOSE 8080\n';

describe('package.json start script as the container command', () => {
  it('is not taken from a workspace root', () => {
    const finding = detectStartupCommand({
      Dockerfile: DOCKERFILE_NO_CMD,
      'package.json': JSON.stringify({ name: 'mono', workspaces: ['packages/*'], scripts: { start: 'node packages/server/index.js' } }),
    });
    expect(finding.detected).toBe(false);
  });

  it('is not taken when it compiles before it runs', () => {
    const finding = detectStartupCommand({
      Dockerfile: DOCKERFILE_NO_CMD,
      'package.json': JSON.stringify({ name: 'app', scripts: { start: 'tsc && node dist/app.js' } }),
    });
    expect(finding.detected).toBe(false);
  });

  it('is taken from a single-package app that only runs the server', () => {
    const finding = detectStartupCommand({
      Dockerfile: DOCKERFILE_NO_CMD,
      'package.json': JSON.stringify({ name: 'app', scripts: { start: 'node dist/app.js' } }),
    });
    expect(finding.value).toEqual(['start: node dist/app.js']);
  });

  it('keeps the Dockerfile CMD first whatever the scripts say', () => {
    const finding = detectStartupCommand({
      Dockerfile: `${DOCKERFILE_NO_CMD}CMD ["node", "dist/app.js"]\n`,
      'package.json': JSON.stringify({ name: 'app', scripts: { start: 'tsc && node dist/app.js' } }),
    });
    expect(finding.value).toEqual(['CMD: ["node", "dist/app.js"]']);
  });
});

describe('start script of a package the image does not run', () => {
  it('is not taken from a sibling package outside the image WORKDIR', () => {
    const finding = detectStartupCommand({
      Dockerfile: DOCKERFILE_NO_CMD,
      'package.json': JSON.stringify({ name: 'mono', workspaces: ['packages/*'] }),
      'packages/server/package.json': JSON.stringify({ name: 'server', scripts: { start: 'node dist/app.js' } }),
    });
    expect(finding.detected).toBe(false);
  });
});
