import type {
  InfrastructureComponentKind,
  InfrastructureComponentStatus,
  InfrastructureExpectations,
  InfrastructureLifecycle,
} from './infrastructure.js';
import type { InfrastructureProfile } from './index.js';

// The minimal component catalog — semantic metadata shared by verification
// (what SHOULD exist), lifecycle presentation (what happens on destroy), and
// plans. CDK creates the resources and CloudFormation owns their state; this
// catalog only describes them. `packages/cdk/test/lifecycle-parity.test.ts`
// fails when a `lifecycle` here disagrees with the committed templates'
// DeletionPolicy for `primaryResourceType`.

/** One of the five components a deployment can have. Excludes the
 *  supporting-only kinds (network, monitoring, container_registry, other). */
export interface InfrastructureComponentDefinition {
  readonly kind: 'application' | 'endpoint' | 'database' | 'cache' | 'storage';
  /** Whether a deployment with this profile has the component. */
  readonly requiredBy: (profile: InfrastructureProfile) => boolean;
  /** What happens on destroy — must agree with the CDK removal policy of
   *  `primaryResourceType` (parity test). */
  readonly lifecycle: InfrastructureLifecycle;
  /** The CloudFormation resource type whose COMPLETE presence proves the
   *  component exists. */
  readonly primaryResourceType: string;
  /** The relay verification check name. */
  readonly checkName: 'compute' | 'ingress' | 'database' | 'storage' | 'cache';
}

export const INFRASTRUCTURE_COMPONENTS: readonly InfrastructureComponentDefinition[] = [
  {
    kind: 'application',
    requiredBy: () => true,
    lifecycle: 'delete',
    primaryResourceType: 'AWS::ECS::Service',
    checkName: 'compute',
  },
  {
    kind: 'endpoint',
    requiredBy: () => true,
    lifecycle: 'delete',
    primaryResourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
    checkName: 'ingress',
  },
  {
    kind: 'database',
    requiredBy: (profile) => profile.postgres,
    lifecycle: 'retain',
    primaryResourceType: 'AWS::RDS::DBInstance',
    checkName: 'database',
  },
  {
    kind: 'storage',
    requiredBy: () => true,
    lifecycle: 'retain',
    primaryResourceType: 'AWS::S3::Bucket',
    checkName: 'storage',
  },
  {
    kind: 'cache',
    requiredBy: (profile) => profile.redis,
    lifecycle: 'delete',
    primaryResourceType: 'AWS::ElastiCache::ReplicationGroup',
    checkName: 'cache',
  },
] as const;

/** The catalog components a deployment with this profile has, in catalog order
 *  (the order the relay reports its verification checks in). */
export function requiredInfrastructureComponents(
  profile: InfrastructureProfile,
): readonly InfrastructureComponentDefinition[] {
  return INFRASTRUCTURE_COMPONENTS.filter((component) => component.requiredBy(profile));
}

const CATALOG_KINDS = INFRASTRUCTURE_COMPONENTS.map((component) => component.kind);

/**
 * Compares what a deployment's manifest requires (the catalog, filtered by
 * its infrastructure profile) against what the persisted inventory shows.
 * Pure — no database or AWS access; a report only, never an auto-repair. A
 * component is `present` when the inventory has a row of that kind whose
 * status is not `removed`.
 */
export function compareInfrastructureExpectations(
  expectedKinds: readonly InfrastructureComponentKind[],
  components: ReadonlyArray<{
    readonly kind: InfrastructureComponentKind;
    readonly status: InfrastructureComponentStatus;
  }>,
): InfrastructureExpectations {
  const expectedSet = new Set(expectedKinds);
  const presentKinds = new Set(
    components.filter((component) => component.status !== 'removed').map((component) => component.kind),
  );
  const catalogComponents = CATALOG_KINDS.map((kind) => ({
    kind,
    expected: expectedSet.has(kind),
    present: presentKinds.has(kind),
  }));
  return {
    schemaVersion: 1,
    components: catalogComponents,
    missing: catalogComponents.filter((c) => c.expected && !c.present).map((c) => c.kind),
    unexpected: catalogComponents.filter((c) => !c.expected && c.present).map((c) => c.kind),
  };
}
