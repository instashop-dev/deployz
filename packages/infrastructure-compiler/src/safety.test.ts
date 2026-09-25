import { describe, expect, it } from 'vitest';

import { CAPABILITY_KEYS, type DeployzIR } from '@deployz/contracts';

import { assertNoDestructiveStatefulChanges } from './safety.js';

// Destructive-change safety: a proposed IR must never replace or delete a
// managed stateful (retain) resource. This is the MVP fail-closed stop-gap
// before semantic diffing / Change Sets / migration workflows.

function ir(overrides: Partial<DeployzIR> = {}): DeployzIR {
  return {
    schemaVersion: 1,
    workloads: [],
    resources: [
      {
        componentId: 'primary-db',
        capabilityKey: CAPABILITY_KEYS.RDS_POSTGRES,
        label: 'PostgreSQL database',
        quantity: 1,
        configuration: {},
        lifecycle: 'retain',
        scope: 'REGIONAL',
        envBindings: [],
      },
      {
        componentId: 'cache',
        capabilityKey: CAPABILITY_KEYS.ELASTICACHE_VALKEY,
        label: 'Valkey cache',
        quantity: 1,
        configuration: {},
        lifecycle: 'delete',
        scope: 'REGIONAL',
        envBindings: [],
      },
    ],
    bindings: [],
    ingress: { public: false, capabilityKey: null, targetWorkloadIds: [] },
    schedules: [],
    policies: { allowTopologyChanges: false, defaultRetention: 'retain' },
    metadata: {
      graphSchemaVersion: 1,
      capabilityRegistryVersion: 'test',
      sizeProfileId: 'small-v1',
      region: 'us-east-1',
    },
    ...overrides,
  };
}

describe('assertNoDestructiveStatefulChanges', () => {
  it('allows an identical IR', () => {
    const frozen = ir();
    expect(assertNoDestructiveStatefulChanges(frozen, ir()).safe).toBe(true);
  });

  it('allows an additive non-stateful resource', () => {
    const frozen = ir();
    const next = ir({
      resources: [
        ...ir().resources,
        {
          componentId: 'extra-cache',
          capabilityKey: CAPABILITY_KEYS.ELASTICACHE_VALKEY,
          label: 'Extra cache',
          quantity: 1,
          configuration: {},
          lifecycle: 'delete',
          scope: 'REGIONAL',
          envBindings: [],
        },
      ],
    });
    const result = assertNoDestructiveStatefulChanges(frozen, next);
    expect(result.safe).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('rejects removal of a stateful resource', () => {
    const frozen = ir();
    const next = ir({
      resources: ir().resources.filter((r) => r.componentId !== 'primary-db'),
    });
    const result = assertNoDestructiveStatefulChanges(frozen, next);
    expect(result.safe).toBe(false);
    expect(result.reasons).toEqual(['stateful resource "primary-db" would be removed']);
  });

  it('rejects a capability change on a stateful resource', () => {
    const frozen = ir();
    const next = ir({
      resources: ir().resources.map((r) =>
        r.componentId === 'primary-db'
          ? { ...r, capabilityKey: CAPABILITY_KEYS.S3 }
          : r,
      ),
    });
    const result = assertNoDestructiveStatefulChanges(frozen, next);
    expect(result.safe).toBe(false);
    expect(result.reasons).toEqual([
      'stateful resource "primary-db" would change capability from "aws.rds-postgres" to "aws.s3" (replacement)',
    ]);
  });

  it('allows removal of a non-stateful (delete) resource', () => {
    const frozen = ir();
    const next = ir({
      resources: ir().resources.filter((r) => r.componentId !== 'cache'),
    });
    expect(assertNoDestructiveStatefulChanges(frozen, next).safe).toBe(true);
  });

  it('rejects only the stateful change, not additive changes, and lists every reason', () => {
    const frozen = ir();
    const next = ir({
      resources: [
        // primary-db removed entirely.
        ...ir().resources.filter((r) => r.componentId === 'cache'),
      ],
    });
    const result = assertNoDestructiveStatefulChanges(frozen, next);
    expect(result.safe).toBe(false);
    expect(result.reasons).toEqual(['stateful resource "primary-db" would be removed']);
  });
});
