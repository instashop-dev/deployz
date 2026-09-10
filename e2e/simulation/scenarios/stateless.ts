import type { ScenarioDefinition } from '../types.js';

/**
 * Full successful install WITHOUT a database: network, storage,
 * ALB/target-group and ECS service all reach `CREATE_COMPLETE`.
 * No RDS instance. Verifies the STATELESS template variant
 * (application-template-stateless-v1.json, DZ-AUDIT-017).
 */
export const stateless: ScenarioDefinition = {
  id: 'stateless',
  description:
    'VPC/subnets, S3, ALB/target-group and ECS service all reach CREATE_COMPLETE; no RDS; verify passes; ECS healthy.',
  finalStackStatus: 'CREATE_COMPLETE',
  outputs: {
    ExportDeployzApplicationPublicEndpoint: 'deployz-alb-stateless.us-east-1.elb.amazonaws.com',
  },
  redisRequired: false,
  postgres: false,
  ecsBehavior: { kind: 'healthy', desiredCount: 2, runningCount: 2 },
  timeline: [
    { afterMs: 20, atVirtualMs: 0, logicalResourceId: '__stack__', resourceType: 'AWS::CloudFormation::Stack', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 30, atVirtualMs: 0, logicalResourceId: 'ApplicationVpc', resourceType: 'AWS::EC2::VPC', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 50, atVirtualMs: 5_000, logicalResourceId: 'PublicSubnet1', resourceType: 'AWS::EC2::Subnet', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 55, atVirtualMs: 5_000, logicalResourceId: 'PrivateSubnet1', resourceType: 'AWS::EC2::Subnet', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 90, atVirtualMs: 45_000, logicalResourceId: 'ApplicationVpc', resourceType: 'AWS::EC2::VPC', status: 'CREATE_COMPLETE' },
    { afterMs: 100, atVirtualMs: 60_000, logicalResourceId: 'PublicSubnet1', resourceType: 'AWS::EC2::Subnet', status: 'CREATE_COMPLETE' },
    { afterMs: 105, atVirtualMs: 60_000, logicalResourceId: 'PrivateSubnet1', resourceType: 'AWS::EC2::Subnet', status: 'CREATE_COMPLETE' },
    { afterMs: 130, atVirtualMs: 75_000, logicalResourceId: 'ApplicationBucket', resourceType: 'AWS::S3::Bucket', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 160, atVirtualMs: 100_000, logicalResourceId: 'ApplicationBucket', resourceType: 'AWS::S3::Bucket', status: 'CREATE_COMPLETE' },
    { afterMs: 200, atVirtualMs: 140_000, logicalResourceId: 'ApplicationLoadBalancer', resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 210, atVirtualMs: 145_000, logicalResourceId: 'ApplicationTargetGroup', resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 250, atVirtualMs: 170_000, logicalResourceId: 'ApplicationLoadBalancer', resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer', status: 'CREATE_COMPLETE' },
    { afterMs: 260, atVirtualMs: 175_000, logicalResourceId: 'ApplicationTargetGroup', resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup', status: 'CREATE_COMPLETE' },
    { afterMs: 300, atVirtualMs: 200_000, logicalResourceId: 'ApplicationService', resourceType: 'AWS::ECS::Service', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 370, atVirtualMs: 260_000, logicalResourceId: 'ApplicationService', resourceType: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' },
    { afterMs: 380, atVirtualMs: 265_000, logicalResourceId: '__stack__', resourceType: 'AWS::CloudFormation::Stack', status: 'CREATE_COMPLETE' },
  ],
};