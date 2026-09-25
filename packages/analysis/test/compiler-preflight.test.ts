import { describe, expect, it } from 'vitest';

import type { DeployzIR } from '@deployz/contracts';
import { CAPABILITY_KEYS } from '@deployz/contracts';

import { evaluateCompilerPreflight } from '../src/compiler-preflight.js';

// Minimal valid IR fixture. Tests override specific fields per scenario.
function baseIr(overrides: Partial<DeployzIR> = {}): DeployzIR {
  return {
    schemaVersion: 1,
    workloads: [],
    resources: [],
    bindings: [],
    ingress: { public: false, capabilityKey: null, targetWorkloadIds: [] },
    schedules: [],
    policies: { allowTopologyChanges: false, defaultRetention: 'delete' },
    metadata: {
      graphSchemaVersion: 1,
      capabilityRegistryVersion: 'phase1-2026-09-25',
      sizeProfileId: 'small-v1',
      region: 'us-east-1',
    },
    ...overrides,
  };
}

describe('evaluateCompilerPreflight', () => {
  describe('region/capability availability', () => {
    it('blocks when region is null', () => {
      const result = evaluateCompilerPreflight({ ir: baseIr(), region: null });
      expect(result.state).toBe('ACTION_REQUIRED');
      expect(result.blockers.some((b) => b.includes('No region selected'))).toBe(true);
    });

    it('blocks when RDS is required but region is null', () => {
      const ir = baseIr({
        resources: [
          {
            componentId: 'db',
            capabilityKey: CAPABILITY_KEYS.RDS_POSTGRES,
            label: 'PostgreSQL',
            quantity: 1,
            configuration: {},
            lifecycle: 'retain',
            scope: 'REGIONAL',
            envBindings: [],
          },
        ],
      });
      const result = evaluateCompilerPreflight({ ir, region: null });
      expect(result.state).toBe('ACTION_REQUIRED');
      expect(result.blockers.some((b) => b.includes('RDS PostgreSQL 16'))).toBe(true);
    });

    it('blocks when ElastiCache is required but region is null', () => {
      const ir = baseIr({
        resources: [
          {
            componentId: 'cache',
            capabilityKey: CAPABILITY_KEYS.ELASTICACHE_VALKEY,
            label: 'Valkey',
            quantity: 1,
            configuration: {},
            lifecycle: 'delete',
            scope: 'REGIONAL',
            envBindings: [],
          },
        ],
      });
      const result = evaluateCompilerPreflight({ ir, region: null });
      expect(result.state).toBe('ACTION_REQUIRED');
      expect(result.blockers.some((b) => b.includes('ElastiCache Valkey'))).toBe(true);
    });

    it('is READY when region is supported and no special capabilities are required', () => {
      const result = evaluateCompilerPreflight({ ir: baseIr(), region: 'us-east-1' });
      expect(result.state).toBe('READY');
      expect(result.blockers).toHaveLength(0);
    });

    it('is READY when region is supported and RDS/ElastiCache are required', () => {
      const ir = baseIr({
        resources: [
          {
            componentId: 'db',
            capabilityKey: CAPABILITY_KEYS.RDS_POSTGRES,
            label: 'PostgreSQL',
            quantity: 1,
            configuration: {},
            lifecycle: 'retain',
            scope: 'REGIONAL',
            envBindings: [],
          },
          {
            componentId: 'cache',
            capabilityKey: CAPABILITY_KEYS.ELASTICACHE_VALKEY,
            label: 'Valkey',
            quantity: 1,
            configuration: {},
            lifecycle: 'delete',
            scope: 'REGIONAL',
            envBindings: [],
          },
        ],
      });
      const result = evaluateCompilerPreflight({ ir, region: 'eu-west-1' });
      expect(result.state).toBe('READY');
      expect(result.blockers).toHaveLength(0);
    });
  });

  describe('CloudFormation limits', () => {
    it('blocks when IR resource count exceeds 500', () => {
      const resources = Array.from({ length: 501 }, (_, i) => ({
        componentId: `r${i}`,
        capabilityKey: CAPABILITY_KEYS.S3,
        label: `Resource ${i}`,
        quantity: 1,
        configuration: {},
        lifecycle: 'delete' as const,
        scope: 'REGIONAL' as const,
        envBindings: [],
      }));
      const ir = baseIr({ resources });
      const result = evaluateCompilerPreflight({ ir, region: 'us-east-1' });
      expect(result.state).toBe('ACTION_REQUIRED');
      expect(result.blockers.some((b) => b.includes('exceeds the CloudFormation soft limit'))).toBe(true);
    });

    it('warns when IR resource count approaches 500', () => {
      const resources = Array.from({ length: 401 }, (_, i) => ({
        componentId: `r${i}`,
        capabilityKey: CAPABILITY_KEYS.S3,
        label: `Resource ${i}`,
        quantity: 1,
        configuration: {},
        lifecycle: 'delete' as const,
        scope: 'REGIONAL' as const,
        envBindings: [],
      }));
      const ir = baseIr({ resources });
      const result = evaluateCompilerPreflight({ ir, region: 'us-east-1' });
      expect(result.state).toBe('READY');
      expect(result.warnings.some((w) => w.includes('approaching the CloudFormation soft limit'))).toBe(true);
    });

    it('warns that parameter/output count check is not available at IR level', () => {
      const result = evaluateCompilerPreflight({ ir: baseIr(), region: 'us-east-1' });
      expect(result.warnings.some((w) => w.includes('parameter/output count check is not available'))).toBe(true);
    });
  });

  describe('VPC/networking sanity', () => {
    it('warns when many VPC-scoped capability groups suggest multi-NAT topology', () => {
      // 4 distinct capability+scope combos that require VPC
      const resources = [
        {
          componentId: 'svc',
          capabilityKey: CAPABILITY_KEYS.ECS_FARGATE_SERVICE,
          label: 'Service',
          quantity: 1,
          configuration: {},
          lifecycle: 'delete' as const,
          scope: 'REGIONAL' as const,
          envBindings: [],
        },
        {
          componentId: 'task',
          capabilityKey: CAPABILITY_KEYS.ECS_FARGATE_TASK,
          label: 'Task',
          quantity: 1,
          configuration: {},
          lifecycle: 'delete' as const,
          scope: 'REGIONAL' as const,
          envBindings: [],
        },
        {
          componentId: 'db',
          capabilityKey: CAPABILITY_KEYS.RDS_POSTGRES,
          label: 'DB',
          quantity: 1,
          configuration: {},
          lifecycle: 'retain' as const,
          scope: 'REGIONAL' as const,
          envBindings: [],
        },
        {
          componentId: 'cache',
          capabilityKey: CAPABILITY_KEYS.ELASTICACHE_VALKEY,
          label: 'Cache',
          quantity: 1,
          configuration: {},
          lifecycle: 'delete' as const,
          scope: 'REGIONAL' as const,
          envBindings: [],
        },
      ];
      const ir = baseIr({ resources });
      const result = evaluateCompilerPreflight({ ir, region: 'us-east-1' });
      expect(result.state).toBe('READY');
      expect(result.warnings.some((w) => w.includes('VPC-scoped capability groups'))).toBe(true);
    });

    it('does not warn when VPC-scoped groups are within MVP limits', () => {
      const resources = [
        {
          componentId: 'svc',
          capabilityKey: CAPABILITY_KEYS.ECS_FARGATE_SERVICE,
          label: 'Service',
          quantity: 1,
          configuration: {},
          lifecycle: 'delete' as const,
          scope: 'REGIONAL' as const,
          envBindings: [],
        },
        {
          componentId: 'db',
          capabilityKey: CAPABILITY_KEYS.RDS_POSTGRES,
          label: 'DB',
          quantity: 1,
          configuration: {},
          lifecycle: 'retain' as const,
          scope: 'REGIONAL' as const,
          envBindings: [],
        },
      ];
      const ir = baseIr({ resources });
      const result = evaluateCompilerPreflight({ ir, region: 'us-east-1' });
      expect(result.warnings.some((w) => w.includes('VPC-scoped capability groups'))).toBe(false);
    });
  });

  describe('quota defaults', () => {
    it('warns when resources target multiple distinct regions (multi-VPC)', () => {
      const resources = [
        {
          componentId: 'svc-a',
          capabilityKey: CAPABILITY_KEYS.ECS_FARGATE_SERVICE,
          label: 'Service A',
          quantity: 1,
          configuration: { targetRegion: 'us-east-1' },
          lifecycle: 'delete' as const,
          scope: 'FIXED_REGION' as const,
          envBindings: [],
        },
        {
          componentId: 'svc-b',
          capabilityKey: CAPABILITY_KEYS.ECS_FARGATE_SERVICE,
          label: 'Service B',
          quantity: 1,
          configuration: { targetRegion: 'eu-west-1' },
          lifecycle: 'delete' as const,
          scope: 'FIXED_REGION' as const,
          envBindings: [],
        },
      ];
      const ir = baseIr({ resources });
      const result = evaluateCompilerPreflight({ ir, region: 'us-east-1' });
      expect(result.state).toBe('READY');
      expect(result.warnings.some((w) => w.includes('distinct regions'))).toBe(true);
    });

    it('does not warn when all VPC resources share one region', () => {
      const resources = [
        {
          componentId: 'svc',
          capabilityKey: CAPABILITY_KEYS.ECS_FARGATE_SERVICE,
          label: 'Service',
          quantity: 1,
          configuration: { targetRegion: 'us-east-1' },
          lifecycle: 'delete' as const,
          scope: 'FIXED_REGION' as const,
          envBindings: [],
        },
      ];
      const ir = baseIr({ resources });
      const result = evaluateCompilerPreflight({ ir, region: 'us-east-1' });
      expect(result.warnings.some((w) => w.includes('distinct regions'))).toBe(false);
    });
  });
});
