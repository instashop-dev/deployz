import { describe, expect, it } from 'vitest';

import { requirementsFromSpec, workloadServicesFromSpec, type DeploymentSpecV2 } from './deployment-spec-v2.js';

/** workloadServicesFromSpec/requirementsFromSpec only read `verificationContract`. */
function specWith(contract: unknown): DeploymentSpecV2 {
  return { verificationContract: contract } as unknown as DeploymentSpecV2;
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
