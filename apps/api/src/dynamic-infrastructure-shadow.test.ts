import { describe, expect, it, vi } from 'vitest';

import { analyseRepo } from '@deployz/analysis';

import { createDynamicInfraShadowRunner } from './dynamic-infrastructure-shadow.js';

// Phase 1 dynamic-infrastructure shadow: derives graph → IR → spec from the
// same manifest the production path freezes, then logs one summary line.
// Shadow-only — it must never throw.

const STATELESS_TREE = {
  Dockerfile: ['FROM node:20-alpine', 'WORKDIR /app', 'EXPOSE 3000', 'CMD ["node", "index.js"]'].join('\n'),
  'package.json': JSON.stringify({
    name: 'stateless',
    scripts: { start: 'node index.js', build: 'tsc' },
    dependencies: { express: '^4.18.0' },
  }),
};

const OVERRIDES = {
  containerPort: 3000,
  healthPath: '/health',
  migrationCommand: null,
  workerCommand: null,
  databaseRequired: false,
  storageRequired: false,
  redisRequired: false,
};

describe('createDynamicInfraShadowRunner', () => {
  it('derives graph → IR → spec and logs a summary without throwing', () => {
    const analysis = analyseRepo(STATELESS_TREE);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const runner = createDynamicInfraShadowRunner();
    expect(() =>
      runner.run({
        applicationId: 'app-1',
        detectedMetadata: analysis.metadata,
        overrides: OVERRIDES,
      }),
    ).not.toThrow();

    expect(logSpy).toHaveBeenCalledTimes(1);
    const summary = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(summary.event).toBe('dynamic-infra:shadow');
    expect(summary.applicationId).toBe('app-1');
    expect(summary.workloads).toBe(1); // web only
    expect(summary.managedResources).toBeGreaterThanOrEqual(2); // storage + endpoint
    expect(summary.graphHash).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.irHash).toMatch(/^[0-9a-f]{64}$/);
    logSpy.mockRestore();
  });

  it('never throws on config-incomplete metadata', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runner = createDynamicInfraShadowRunner();
    expect(() =>
      runner.run({ applicationId: 'app-2', detectedMetadata: {}, overrides: OVERRIDES }),
    ).not.toThrow();
    errorSpy.mockRestore();
  });
});
