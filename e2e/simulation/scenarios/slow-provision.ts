import type { ScenarioDefinition } from '../types.js';

/**
 * Everything succeeds, but the database takes a realistic long time: RDS
 * goes `CREATE_IN_PROGRESS` almost immediately and does not reach
 * `CREATE_COMPLETE` until roughly 15 virtual minutes later — deliberately
 * past `TYPICAL_STEP_DURATION_SECONDS.DATABASE_STORAGE.max` (720s, see
 * packages/contracts/src/index.ts) — then the rest of the stack (load
 * balancer, target group, ECS service) completes quickly and the whole
 * install reaches HEALTHY.
 *
 * This exercises `apps/api/src/deployment-status.ts`'s `takingLongerThanUsual`
 * flag honestly: `SimulatedCustomerAccount`'s virtual clock is anchored so
 * the LAST timeline event lands at (real) install start
 * (docs/testing/discovery/phase1-design-decisions.md D4), so an
 * as-yet-incomplete step's reported elapsed time is approximately
 * `totalVirtualDuration - stepStartVirtualOffset` — here, ~885s for the
 * still-running DATABASE_STORAGE step, comfortably past its 720s max. No
 * scenario-engine change was needed to make this reachable: it falls
 * straight out of the existing anchor design once the timeline's virtual
 * gap for the active step is authored past the step's own typical max.
 *
 * Real-time gap between the RDS CREATE_IN_PROGRESS and CREATE_COMPLETE
 * events below (~3.5s) is what gives e2e/scenario-provisioning.spec.ts a
 * window to poll the ladder while DATABASE_STORAGE is genuinely the active
 * step.
 *
 * VPC `CREATE_COMPLETE` and RDS `CREATE_IN_PROGRESS` deliberately share the
 * same `afterMs` (both reveal in the same real-time instant, hence the same
 * progress-ingest batch): `advanceStepTimings` (apps/api/src/step-timings.ts)
 * persists a step's `startedAt` write-once from whatever `deriveDeploymentStatus`
 * resolves the FIRST time that step becomes active, falling back to the real
 * wall clock only when the snapshot has nothing to say yet
 * (`resolveStepStartedAt`). If NETWORK's completion were reported in an
 * earlier batch than RDS's own first event, the ladder would already read
 * DATABASE_STORAGE for one batch with no `database` category entry at all,
 * getting a real-clock (not virtual) `startedAt` baked in permanently — which
 * would make `takingLongerThanUsual` false for the rest of this test. Sharing
 * one `afterMs` makes both land in the same batch deterministically, so the
 * category always has its correct (virtual, ~60s-in) `startedAt` by the time
 * the ladder first names DATABASE_STORAGE.
 */
export const slowProvision: ScenarioDefinition = {
  id: 'slow-provision',
  description:
    'RDS stays CREATE_IN_PROGRESS for ~15 virtual minutes (past DATABASE_STORAGE\'s typical max) before the stack finishes and reaches HEALTHY.',
  finalStackStatus: 'CREATE_COMPLETE',
  outputs: {
    ExportDeployzApplicationPublicEndpoint: 'deployz-alb-slow-provision.us-east-1.elb.amazonaws.com',
  },
  redisRequired: false,
  ecsBehavior: { kind: 'healthy', desiredCount: 2, runningCount: 2 },
  timeline: [
    { afterMs: 10, atVirtualMs: 0, logicalResourceId: '__stack__', resourceType: 'AWS::CloudFormation::Stack', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 15, atVirtualMs: 0, logicalResourceId: 'ApplicationVpc', resourceType: 'AWS::EC2::VPC', status: 'CREATE_IN_PROGRESS' },
    // `verifyInstallation` (packages/relay/src/verify.ts) requires a
    // complete storage bucket unconditionally, regardless of the
    // application's own `storageRequired` flag — same as happy-path.ts.
    { afterMs: 40, atVirtualMs: 20_000, logicalResourceId: 'ApplicationVpc', resourceType: 'AWS::EC2::VPC', status: 'CREATE_COMPLETE' },
    { afterMs: 40, atVirtualMs: 30_000, logicalResourceId: 'ApplicationBucket', resourceType: 'AWS::S3::Bucket', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 40, atVirtualMs: 40_000, logicalResourceId: 'ApplicationBucket', resourceType: 'AWS::S3::Bucket', status: 'CREATE_COMPLETE' },
    { afterMs: 40, atVirtualMs: 60_000, logicalResourceId: 'ApplicationDatabase', resourceType: 'AWS::RDS::DBInstance', status: 'CREATE_IN_PROGRESS' },
    // ~3.55s of real time pass here while RDS is "still creating" — the
    // window the spec polls DATABASE_STORAGE/takingLongerThanUsual in.
    { afterMs: 3_600, atVirtualMs: 900_000, logicalResourceId: 'ApplicationDatabase', resourceType: 'AWS::RDS::DBInstance', status: 'CREATE_COMPLETE' },
    { afterMs: 3_650, atVirtualMs: 905_000, logicalResourceId: 'ApplicationLoadBalancer', resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 3_655, atVirtualMs: 905_000, logicalResourceId: 'ApplicationTargetGroup', resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 3_700, atVirtualMs: 910_000, logicalResourceId: 'ApplicationLoadBalancer', resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer', status: 'CREATE_COMPLETE' },
    { afterMs: 3_705, atVirtualMs: 910_000, logicalResourceId: 'ApplicationTargetGroup', resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup', status: 'CREATE_COMPLETE' },
    { afterMs: 3_710, atVirtualMs: 915_000, logicalResourceId: 'ApplicationService', resourceType: 'AWS::ECS::Service', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 3_900, atVirtualMs: 940_000, logicalResourceId: 'ApplicationService', resourceType: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' },
    { afterMs: 3_950, atVirtualMs: 945_000, logicalResourceId: '__stack__', resourceType: 'AWS::CloudFormation::Stack', status: 'CREATE_COMPLETE' },
  ],
};
