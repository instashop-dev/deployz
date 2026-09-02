import type { ScenarioDefinition } from '../types.js';

/**
 * Full successful install: network, database, storage and application all
 * reach `CREATE_COMPLETE`; `verifyInstallation` passes; ECS reports every
 * target healthy.
 *
 * Timeline events are authored in strictly non-decreasing `afterMs` (and
 * correspondingly non-decreasing `atVirtualMs`) order — see
 * `SimulatedCustomerAccount`'s doc comment on why array order doubles as
 * reveal order.
 */
export const happyPath: ScenarioDefinition = {
  id: 'happy-path',
  description:
    'VPC/subnets, RDS, S3, ALB/target-group and ECS service all reach CREATE_COMPLETE; verify passes; ECS healthy.',
  finalStackStatus: 'CREATE_COMPLETE',
  outputs: {
    ExportDeployzApplicationPublicEndpoint: 'deployz-alb-happy-path.us-east-1.elb.amazonaws.com',
  },
  redisRequired: false,
  ecsBehavior: { kind: 'healthy', desiredCount: 2, runningCount: 2 },
  timeline: [
    { afterMs: 20, atVirtualMs: 0, logicalResourceId: '__stack__', resourceType: 'AWS::CloudFormation::Stack', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 30, atVirtualMs: 0, logicalResourceId: 'ApplicationVpc', resourceType: 'AWS::EC2::VPC', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 50, atVirtualMs: 5_000, logicalResourceId: 'PublicSubnet1', resourceType: 'AWS::EC2::Subnet', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 55, atVirtualMs: 5_000, logicalResourceId: 'PrivateSubnet1', resourceType: 'AWS::EC2::Subnet', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 90, atVirtualMs: 45_000, logicalResourceId: 'ApplicationVpc', resourceType: 'AWS::EC2::VPC', status: 'CREATE_COMPLETE' },
    { afterMs: 100, atVirtualMs: 60_000, logicalResourceId: 'PublicSubnet1', resourceType: 'AWS::EC2::Subnet', status: 'CREATE_COMPLETE' },
    { afterMs: 105, atVirtualMs: 60_000, logicalResourceId: 'PrivateSubnet1', resourceType: 'AWS::EC2::Subnet', status: 'CREATE_COMPLETE' },
    { afterMs: 130, atVirtualMs: 75_000, logicalResourceId: 'ApplicationDatabase', resourceType: 'AWS::RDS::DBInstance', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 150, atVirtualMs: 90_000, logicalResourceId: 'ApplicationBucket', resourceType: 'AWS::S3::Bucket', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 180, atVirtualMs: 120_000, logicalResourceId: 'ApplicationBucket', resourceType: 'AWS::S3::Bucket', status: 'CREATE_COMPLETE' },
    { afterMs: 260, atVirtualMs: 300_000, logicalResourceId: 'ApplicationDatabase', resourceType: 'AWS::RDS::DBInstance', status: 'CREATE_COMPLETE' },
    { afterMs: 280, atVirtualMs: 310_000, logicalResourceId: 'ApplicationLoadBalancer', resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 290, atVirtualMs: 315_000, logicalResourceId: 'ApplicationTargetGroup', resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 320, atVirtualMs: 340_000, logicalResourceId: 'ApplicationLoadBalancer', resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer', status: 'CREATE_COMPLETE' },
    { afterMs: 330, atVirtualMs: 345_000, logicalResourceId: 'ApplicationTargetGroup', resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup', status: 'CREATE_COMPLETE' },
    { afterMs: 350, atVirtualMs: 360_000, logicalResourceId: 'ApplicationService', resourceType: 'AWS::ECS::Service', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 420, atVirtualMs: 420_000, logicalResourceId: 'ApplicationService', resourceType: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' },
    { afterMs: 430, atVirtualMs: 425_000, logicalResourceId: '__stack__', resourceType: 'AWS::CloudFormation::Stack', status: 'CREATE_COMPLETE' },
  ],
};
