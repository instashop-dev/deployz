import type { ScenarioDefinition } from '../types.js';

/**
 * Every infrastructure resource completes fine — network, database, storage,
 * load balancer — but the ECS service itself fails to stabilise
 * (`CREATE_FAILED`, "Service failed health checks"), and CloudFormation
 * rolls the whole stack back.
 *
 * The relay's failureCode for any INSTALL failure is uniformly
 * `STACK_CREATE_FAILED` (see `createInstallExecutor`) — what distinguishes
 * this scenario is that the ECS failure is the one actually surfaced in the
 * error/diagnostics text, not a different failure code.
 */
export const ecsFailure: ScenarioDefinition = {
  id: 'ecs-failure',
  description:
    'Infra completes; AWS::ECS::Service CREATE_FAILED ("Service failed health checks"); stack rolls back.',
  finalStackStatus: 'ROLLBACK_COMPLETE',
  redisRequired: false,
  timeline: [
    { afterMs: 30, atVirtualMs: 0, logicalResourceId: 'ApplicationVpc', resourceType: 'AWS::EC2::VPC', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 70, atVirtualMs: 30_000, logicalResourceId: 'ApplicationVpc', resourceType: 'AWS::EC2::VPC', status: 'CREATE_COMPLETE' },
    { afterMs: 90, atVirtualMs: 40_000, logicalResourceId: 'ApplicationDatabase', resourceType: 'AWS::RDS::DBInstance', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 160, atVirtualMs: 200_000, logicalResourceId: 'ApplicationDatabase', resourceType: 'AWS::RDS::DBInstance', status: 'CREATE_COMPLETE' },
    { afterMs: 170, atVirtualMs: 210_000, logicalResourceId: 'ApplicationBucket', resourceType: 'AWS::S3::Bucket', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 190, atVirtualMs: 230_000, logicalResourceId: 'ApplicationBucket', resourceType: 'AWS::S3::Bucket', status: 'CREATE_COMPLETE' },
    { afterMs: 200, atVirtualMs: 240_000, logicalResourceId: 'ApplicationLoadBalancer', resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 205, atVirtualMs: 242_000, logicalResourceId: 'ApplicationTargetGroup', resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 230, atVirtualMs: 260_000, logicalResourceId: 'ApplicationLoadBalancer', resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer', status: 'CREATE_COMPLETE' },
    { afterMs: 235, atVirtualMs: 262_000, logicalResourceId: 'ApplicationTargetGroup', resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup', status: 'CREATE_COMPLETE' },
    { afterMs: 250, atVirtualMs: 270_000, logicalResourceId: 'ApplicationService', resourceType: 'AWS::ECS::Service', status: 'CREATE_IN_PROGRESS' },
    {
      afterMs: 340,
      atVirtualMs: 400_000,
      logicalResourceId: 'ApplicationService',
      resourceType: 'AWS::ECS::Service',
      status: 'CREATE_FAILED',
      statusReason: 'Service failed health checks',
    },
    {
      afterMs: 350,
      atVirtualMs: 405_000,
      logicalResourceId: '__stack__',
      resourceType: 'AWS::CloudFormation::Stack',
      status: 'ROLLBACK_IN_PROGRESS',
      statusReason: 'The following resource(s) failed to create: [ApplicationService].',
    },
    {
      afterMs: 380,
      atVirtualMs: 420_000,
      logicalResourceId: '__stack__',
      resourceType: 'AWS::CloudFormation::Stack',
      status: 'ROLLBACK_COMPLETE',
    },
  ],
};
