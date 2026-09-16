import { describe, expect, it } from 'vitest';

import { requiredInfrastructureComponents } from './components.js';

describe('requiredInfrastructureComponents', () => {
  it('v1 (postgres, no redis): application, endpoint, database, storage', () => {
    const kinds = requiredInfrastructureComponents({ postgres: true, redis: false }).map((c) => c.kind);
    expect(kinds).toEqual(['application', 'endpoint', 'database', 'storage']);
  });

  it('redis-v1 (postgres + redis): application, endpoint, database, cache, storage', () => {
    const kinds = requiredInfrastructureComponents({ postgres: true, redis: true }).map((c) => c.kind);
    expect(kinds).toEqual(['application', 'endpoint', 'database', 'cache', 'storage']);
  });

  it('stateless-v1 (neither): application, endpoint, storage', () => {
    const kinds = requiredInfrastructureComponents({ postgres: false, redis: false }).map((c) => c.kind);
    expect(kinds).toEqual(['application', 'endpoint', 'storage']);
  });

  it('stateless-redis-v1 (redis only): application, endpoint, cache, storage', () => {
    const kinds = requiredInfrastructureComponents({ postgres: false, redis: true }).map((c) => c.kind);
    expect(kinds).toEqual(['application', 'endpoint', 'cache', 'storage']);
  });
});
