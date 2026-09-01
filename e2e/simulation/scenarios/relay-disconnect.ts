import type { ScenarioDefinition } from '../types.js';

/**
 * The relay registers, starts the INSTALL, and reports one batch of early
 * progress (the stack and network resource going `CREATE_IN_PROGRESS`) —
 * then, in e2e/scenario-provisioning.spec.ts's relay-disconnect test, the
 * harness is started with `deployzRelayOptions: { stopAfterFirstProgress:
 * true }` (an additive knob on `startSimulatedRelay`, see
 * ./e2e/simulation/relay-harness.ts), which makes every report call AFTER
 * that first one hang forever — simulating a relay Lambda whose network
 * died mid-invocation. The collector only calls `report` again once a NEW
 * event is revealed (an unchanged poll is a silent no-op — see
 * `packages/relay/src/stack-events.ts`'s `poll()`), so the hang's
 * observable effect (nothing past the first batch ever reaches the control
 * plane) starts at whichever timeline entry comes next — here, VPC
 * `CREATE_COMPLETE` at afterMs 1s. Everything from that point on (VPC
 * completing, the database, the load balancer, the ECS service, the stack's
 * own terminal status) exists only for narrative completeness of what the
 * customer's account would have gone on to do, and is never actually
 * persisted by the test.
 */
export const relayDisconnect: ScenarioDefinition = {
  id: 'relay-disconnect',
  description:
    'Relay reports one early progress batch, then (via stopAfterFirstProgress) goes silent mid-install — never reports again.',
  finalStackStatus: 'CREATE_COMPLETE',
  outputs: {
    ExportDeployzApplicationPublicEndpoint: 'deployz-alb-relay-disconnect.us-east-1.elb.amazonaws.com',
  },
  redisRequired: false,
  ecsBehavior: { kind: 'healthy', desiredCount: 2, runningCount: 2 },
  timeline: [
    { afterMs: 5, atVirtualMs: 0, logicalResourceId: '__stack__', resourceType: 'AWS::CloudFormation::Stack', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 10, atVirtualMs: 0, logicalResourceId: 'ApplicationVpc', resourceType: 'AWS::EC2::VPC', status: 'CREATE_IN_PROGRESS' },
    // Revealed by the account's own clock, but never PERSISTED — this is
    // the first event whose report call hits the post-silence hang.
    { afterMs: 1_000, atVirtualMs: 30_000, logicalResourceId: 'ApplicationVpc', resourceType: 'AWS::EC2::VPC', status: 'CREATE_COMPLETE' },
    { afterMs: 1_010, atVirtualMs: 35_000, logicalResourceId: 'ApplicationBucket', resourceType: 'AWS::S3::Bucket', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 1_020, atVirtualMs: 40_000, logicalResourceId: 'ApplicationBucket', resourceType: 'AWS::S3::Bucket', status: 'CREATE_COMPLETE' },
    { afterMs: 1_050, atVirtualMs: 45_000, logicalResourceId: 'ApplicationDatabase', resourceType: 'AWS::RDS::DBInstance', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 1_200, atVirtualMs: 200_000, logicalResourceId: 'ApplicationDatabase', resourceType: 'AWS::RDS::DBInstance', status: 'CREATE_COMPLETE' },
    { afterMs: 1_250, atVirtualMs: 210_000, logicalResourceId: 'ApplicationLoadBalancer', resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 1_300, atVirtualMs: 220_000, logicalResourceId: 'ApplicationLoadBalancer', resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer', status: 'CREATE_COMPLETE' },
    { afterMs: 1_350, atVirtualMs: 230_000, logicalResourceId: 'ApplicationService', resourceType: 'AWS::ECS::Service', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 1_400, atVirtualMs: 240_000, logicalResourceId: 'ApplicationService', resourceType: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' },
    { afterMs: 1_450, atVirtualMs: 245_000, logicalResourceId: '__stack__', resourceType: 'AWS::CloudFormation::Stack', status: 'CREATE_COMPLETE' },
  ],
};
