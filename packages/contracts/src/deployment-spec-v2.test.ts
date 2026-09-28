import { describe, expect, it } from 'vitest';

import {
  deployzTaskFamily,
  migrationTaskFromSpec,
  requirementsFromSpec,
  workloadServicesFromSpec,
  type DeploymentSpecV2,
} from './deployment-spec-v2.js';

/** migrationTaskFromSpec/workloadServicesFromSpec only read the compiled fields. */
function specWith(contract: unknown, ownershipRecords?: unknown): DeploymentSpecV2 {
  return { verificationContract: contract, ownershipRecords } as unknown as DeploymentSpecV2;
}

describe('workloadServicesFromSpec', () => {
  it('maps one compute check per workload to its service logical id', () => {
    const spec = specWith({
      checks: [
        { componentId: 'web', componentKind: 'application', capability: 'aws.ecs-fargate-service', check: 'compute', primaryResourceType: 'AWS::ECS::Service', logicalId: 'WebService' },
        { componentId: 'endpoint', componentKind: 'endpoint', capability: 'aws.alb', check: 'ingress', primaryResourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer', logicalId: 'EndpointLoadBalancer' },
        { componentId: 'email-worker', componentKind: 'application', capability: 'aws.ecs-fargate-service', check: 'compute', primaryResourceType: 'AWS::ECS::Service', logicalId: 'EmailWorkerService' },
      ],
    });
    expect(workloadServicesFromSpec(spec)).toEqual([
      { id: 'web', serviceLogicalId: 'WebService' },
      { id: 'email-worker', serviceLogicalId: 'EmailWorkerService' },
    ]);
    expect(requirementsFromSpec(spec)).toEqual({ databaseRequired: false, redisRequired: false });
  });

  it('is null on an uncompiled spec', () => {
    expect(workloadServicesFromSpec(specWith(null))).toBeNull();
  });
});

describe('migrationTaskFromSpec', () => {
  it('finds the one-shot migration task definition among the ownership records', () => {
    const spec = specWith(
      {
        checks: [
          { componentId: 'web', componentKind: 'application', capability: 'aws.ecs-fargate-service', check: 'compute', primaryResourceType: 'AWS::ECS::Service', logicalId: 'WebService' },
        ],
      },
      [
        { componentId: 'web', componentKind: 'application', capability: 'aws.ecs-fargate-service', logicalResourceId: 'WebService', physicalResourceId: null, stateful: false, retention: 'delete', purgeStrategy: null },
        { componentId: 'migration', componentKind: 'application', capability: 'aws.ecs-fargate-service', logicalResourceId: 'MigrationTaskDefinition', physicalResourceId: null, stateful: false, retention: 'delete', purgeStrategy: null },
      ],
    );
    expect(migrationTaskFromSpec(spec)).toEqual({
      id: 'migration',
      taskLogicalId: 'MigrationTaskDefinition',
      family: 'DeployzAppMigration',
    });
  });

  it('is null when the spec has no migration workload or is uncompiled', () => {
    const noMigration = specWith(
      { checks: [] },
      [{ componentId: 'web', componentKind: 'application', capability: 'aws.ecs-fargate-service', logicalResourceId: 'WebService', physicalResourceId: null, stateful: false, retention: 'delete', purgeStrategy: null }],
    );
    expect(migrationTaskFromSpec(noMigration)).toBeNull();
    expect(migrationTaskFromSpec(specWith(null, null))).toBeNull();
  });

  it('the family mirrors the compiler Family field (golden parity)', () => {
    expect(deployzTaskFamily('migration')).toBe('DeployzAppMigration');
    expect(deployzTaskFamily('web')).toBe('DeployzAppWeb');
    expect(deployzTaskFamily('email-worker')).toBe('DeployzAppEmailWorker');
  });
});
