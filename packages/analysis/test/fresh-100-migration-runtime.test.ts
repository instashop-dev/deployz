import { describe, expect, it } from 'vitest';

import type { FileTree } from '../src/analyser.js';
import { analyseRepo } from '../src/analyser.js';
import { selectMigrationScript } from '../src/detectors.js';

const PRUNED_DOCKERFILE = [
  'FROM node:20-alpine AS build',
  'COPY . .',
  'RUN npm ci && npm run build && npm prune --omit=dev',
  'FROM node:20-alpine',
  'COPY --from=build /app ./',
  'EXPOSE 3000',
  'CMD ["node", "dist/index.js"]',
  '',
].join('\n');

const KEEPS_DEV_DOCKERFILE = [
  'FROM node:20-alpine',
  'COPY . .',
  'RUN npm install',
  'EXPOSE 3000',
  'CMD ["node", "dist/index.js"]',
  '',
].join('\n');

function app(
  command: string,
  options: { dockerfile?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {},
): FileTree {
  return {
    'Dockerfile': options.dockerfile ?? PRUNED_DOCKERFILE,
    'package.json': JSON.stringify({
      name: 'app',
      scripts: { start: 'node dist/index.js', 'db:migrate': command },
      dependencies: { express: '^4.18.0', pg: '^8.12.0', knex: '^3.0.0', ...options.dependencies },
      devDependencies: options.devDependencies ?? {},
    }),
    '.env.example': 'DATABASE_URL=postgresql://localhost:5432/app\n',
  };
}

describe('a migration command that needs a development-only tool is not selected', () => {
  const dev = { 'vite-node': '^1.0.0' };

  it.each(['vite-node', 'babel-node', 'ts-node-dev', 'esno'])('rejects %s when it is a devDependency of a pruned image', (cli) => {
    const tree = app(`${cli} scripts/fix.ts && npx knex migrate:latest`, { devDependencies: { ...dev, [cli]: '^1.0.0' } });
    expect(selectMigrationScript(tree)).toBeUndefined();
    expect(analyseRepo(tree).metadata['migrationMode']).not.toBe('pre_deploy');
  });

  it('accepts the same command when the tool is a runtime dependency', () => {
    const tree = app('vite-node scripts/fix.ts && npx knex migrate:latest', { dependencies: dev });
    expect(selectMigrationScript(tree)?.[1]).toBe('vite-node scripts/fix.ts && npx knex migrate:latest');
  });

  it('accepts the same command when the final image keeps development dependencies', () => {
    const tree = app('vite-node scripts/fix.ts && npx knex migrate:latest', {
      dockerfile: KEEPS_DEV_DOCKERFILE,
      devDependencies: dev,
    });
    expect(selectMigrationScript(tree)).toBeDefined();
  });

  it('keeps a command that uses only runtime tools', () => {
    expect(selectMigrationScript(app('knex migrate:latest'))?.[1]).toBe('knex migrate:latest');
  });
});
