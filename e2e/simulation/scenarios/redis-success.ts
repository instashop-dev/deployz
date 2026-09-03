import type { ScenarioDefinition } from '../types.js';
import { happyPath } from './happy-path.js';

/**
 * Phase 14 scenario-matrix B: a SUCCESSFUL Redis install. happy-path's
 * timeline plus an `ApplicationRedis` (AWS::ElastiCache::ReplicationGroup)
 * reaching CREATE_COMPLETE before the ECS service, and `redisRequired: true`
 * so verifyInstallation expects the cache resource — the same install
 * redis-failure exercises, but ending HEALTHY. Carried by the
 * deployz-demo/bullmq-worker fixture, whose `redisRequired` comes from the
 * real analyser, and driven to a real DEPLOY_RELEASE so the migration stage
 * runs through the same install (the app's manifest carries a migration
 * command — see e2e/scenario-matrix.spec.ts).
 *
 * Events are authored in strictly non-decreasing `afterMs`/`atVirtualMs`
 * order (array order doubles as reveal order), exactly like happyPath; the
 * Redis events are interleaved where a real cache create would sit: started
 * after the database, completed before the load balancer.
 */
export const redisSuccess: ScenarioDefinition = {
  ...happyPath,
  id: 'redis-success',
  description:
    'VPC/subnets, RDS, S3, Redis cache, ALB/target-group and ECS service all reach CREATE_COMPLETE; verify passes; ECS healthy.',
  redisRequired: true,
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
    { afterMs: 220, atVirtualMs: 200_000, logicalResourceId: 'ApplicationRedis', resourceType: 'AWS::ElastiCache::ReplicationGroup', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 260, atVirtualMs: 300_000, logicalResourceId: 'ApplicationDatabase', resourceType: 'AWS::RDS::DBInstance', status: 'CREATE_COMPLETE' },
    { afterMs: 270, atVirtualMs: 310_000, logicalResourceId: 'ApplicationRedis', resourceType: 'AWS::ElastiCache::ReplicationGroup', status: 'CREATE_COMPLETE' },
    { afterMs: 280, atVirtualMs: 315_000, logicalResourceId: 'ApplicationLoadBalancer', resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 290, atVirtualMs: 320_000, logicalResourceId: 'ApplicationTargetGroup', resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 320, atVirtualMs: 345_000, logicalResourceId: 'ApplicationLoadBalancer', resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer', status: 'CREATE_COMPLETE' },
    { afterMs: 330, atVirtualMs: 350_000, logicalResourceId: 'ApplicationTargetGroup', resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup', status: 'CREATE_COMPLETE' },
    { afterMs: 350, atVirtualMs: 365_000, logicalResourceId: 'ApplicationService', resourceType: 'AWS::ECS::Service', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 420, atVirtualMs: 425_000, logicalResourceId: 'ApplicationService', resourceType: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' },
    { afterMs: 430, atVirtualMs: 430_000, logicalResourceId: '__stack__', resourceType: 'AWS::CloudFormation::Stack', status: 'CREATE_COMPLETE' },
  ],
};
