import { describe, expect, it } from 'vitest';

import { compareInfrastructureExpectations, requiredInfrastructureComponents } from './components.js';

describe('requiredInfrastructureComponents', () => {
  it('v1 (postgres, no redis): application, endpoint, database, storage', () => {
    const kinds = requiredInfrastructureComponents({ postgres: true, redis: false }).map((c) => c.kind);
    expect(kinds).toEqual(['application', 'endpoint', 'database', 'storage']);
  });

  it('redis-v1 (postgres + redis): application, endpoint, database, cache, storage', () => {
    const kinds = requiredInfrastructureComponents({ postgres: true, redis: true }).map((c) => c.kind);
    expect(kinds).toEqual(['application', 'endpoint', 'database', 'storage', 'cache']);
  });

  it('stateless-v1 (neither): application, endpoint, storage', () => {
    const kinds = requiredInfrastructureComponents({ postgres: false, redis: false }).map((c) => c.kind);
    expect(kinds).toEqual(['application', 'endpoint', 'storage']);
  });

  it('stateless-redis-v1 (redis only): application, endpoint, cache, storage', () => {
    const kinds = requiredInfrastructureComponents({ postgres: false, redis: true }).map((c) => c.kind);
    expect(kinds).toEqual(['application', 'endpoint', 'storage', 'cache']);
  });
});

describe('compareInfrastructureExpectations', () => {
  const STATELESS_KINDS = requiredInfrastructureComponents({ postgres: false, redis: false }).map((c) => c.kind);
  const POSTGRES_KINDS = requiredInfrastructureComponents({ postgres: true, redis: false }).map((c) => c.kind);
  const REDIS_KINDS = requiredInfrastructureComponents({ postgres: true, redis: true }).map((c) => c.kind);

  it('stateless with no database: nothing missing, nothing unexpected', () => {
    const result = compareInfrastructureExpectations(STATELESS_KINDS, [
      { kind: 'application', status: 'ready' },
      { kind: 'endpoint', status: 'ready' },
      { kind: 'storage', status: 'ready' },
    ]);
    expect(result.missing).toEqual([]);
    expect(result.unexpected).toEqual([]);
    // Storage is always in the catalog, so it is always expected.
    expect(result.components.find((c) => c.kind === 'storage')).toEqual({
      kind: 'storage',
      expected: true,
      present: true,
    });
  });

  it('postgres required, database absent: missing database', () => {
    const result = compareInfrastructureExpectations(POSTGRES_KINDS, [
      { kind: 'application', status: 'ready' },
      { kind: 'endpoint', status: 'ready' },
      { kind: 'storage', status: 'ready' },
    ]);
    expect(result.missing).toEqual(['database']);
    expect(result.unexpected).toEqual([]);
  });

  it('redis required, cache absent: missing cache', () => {
    const result = compareInfrastructureExpectations(REDIS_KINDS, [
      { kind: 'application', status: 'ready' },
      { kind: 'endpoint', status: 'ready' },
      { kind: 'database', status: 'ready' },
      { kind: 'storage', status: 'ready' },
    ]);
    expect(result.missing).toEqual(['cache']);
    expect(result.unexpected).toEqual([]);
  });

  it('redis not required, cache present: unexpected cache', () => {
    const result = compareInfrastructureExpectations(POSTGRES_KINDS, [
      { kind: 'application', status: 'ready' },
      { kind: 'endpoint', status: 'ready' },
      { kind: 'database', status: 'ready' },
      { kind: 'storage', status: 'ready' },
      { kind: 'cache', status: 'ready' },
    ]);
    expect(result.missing).toEqual([]);
    expect(result.unexpected).toEqual(['cache']);
  });

  it('a removed component does not count as present', () => {
    const result = compareInfrastructureExpectations(POSTGRES_KINDS, [
      { kind: 'application', status: 'ready' },
      { kind: 'endpoint', status: 'ready' },
      { kind: 'database', status: 'removed' },
      { kind: 'storage', status: 'ready' },
    ]);
    expect(result.missing).toEqual(['database']);
  });

  it('components carries the five catalog kinds in catalog order', () => {
    const result = compareInfrastructureExpectations(REDIS_KINDS, []);
    expect(result.components.map((c) => c.kind)).toEqual([
      'application',
      'endpoint',
      'database',
      'storage',
      'cache',
    ]);
  });
});
