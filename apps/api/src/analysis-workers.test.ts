import { describe, expect, it } from 'vitest';

import type { FileTree } from '@deployz/analysis';

import { resolveWorkerCommands } from './analysis.js';

describe('resolveWorkerCommands — package.json worker scripts', () => {
  const app = 'FROM node:22\nCOPY . .\nCMD ["node", "server.js"]\n';

  it('never takes a dev or watch script as the worker', () => {
    const tree: FileTree = {
      Dockerfile: app,
      'packages/backend/package.json': JSON.stringify({
        scripts: { worker: 'nodemon src/worker.js', 'start:worker': 'node --loader ./alias-loader.mjs src/worker.js' },
      }),
    };
    expect(resolveWorkerCommands(tree).map((worker) => worker.command)).toEqual(['node --loader ./alias-loader.mjs src/worker.js']);
  });

  it('declares no worker when the only worker script is a dev script', () => {
    const tree: FileTree = {
      Dockerfile: app,
      'package.json': JSON.stringify({ scripts: { 'worker:dev': 'tsx watch index.ts' } }),
    };
    expect(resolveWorkerCommands(tree)).toEqual([]);
  });

  it('declares no worker when the image start command already runs it next to the web process', () => {
    const tree: FileTree = {
      Dockerfile: 'FROM node:22\nCOPY . .\nCMD ["sh", "-c", "exec concurrently -k \\"next start\\" \\"tsx worker.ts\\""]\n',
      'package.json': JSON.stringify({ scripts: { 'worker:start': 'dotenv -- yarn workspace @app/worker start' } }),
    };
    expect(resolveWorkerCommands(tree)).toEqual([]);
  });

  it('keeps a real worker script and a Procfile worker', () => {
    const script: FileTree = {
      Dockerfile: app,
      'package.json': JSON.stringify({ scripts: { 'start:worker': 'node dist/worker.js' } }),
    };
    expect(resolveWorkerCommands(script)).toEqual([{ id: 'worker', command: 'node dist/worker.js', source: 'package.json' }]);
    const procfile: FileTree = { Dockerfile: app, Procfile: 'web: node server.js\nworker: node dist/worker.js\ndev: nodemon x.js\n' };
    expect(resolveWorkerCommands(procfile)).toEqual([{ id: 'worker', command: 'node dist/worker.js', source: 'Procfile' }]);
  });
});
