import {
  CAPABILITY_KEYS,
  SUPPORTED_AWS_REGIONS,
  type DeployzIR,
  type Region,
} from '@deployz/contracts';

// ---------------------------------------------------------------------------
// Compiler-v2 preflight — pure checks on the frozen DeployzIR before the
// infrastructure compiler produces a CloudFormation template.
//
// No AWS calls. No generalized quota framework. Targeted MVP checks only.
// ---------------------------------------------------------------------------

export interface CompilerPreflightInput {
  ir: DeployzIR;
  region: Region | null;
}

export interface CompilerPreflightResult {
  state: 'READY' | 'ACTION_REQUIRED';
  blockers: string[];
  warnings: string[];
}

// AWS CloudFormation soft limit for resources per template.
const CFN_MAX_RESOURCES = 500;

// Capabilities that require RDS PostgreSQL 16 in the chosen region.
const RDS_CAPABILITY_KEYS = new Set<string>([CAPABILITY_KEYS.RDS_POSTGRES]);

// Capabilities that require ElastiCache Valkey in the chosen region.
const ELASTICACHE_CAPABILITY_KEYS = new Set<string>([CAPABILITY_KEYS.ELASTICACHE_VALKEY]);

// Capabilities that require VPC networking (and thus consume a VPC slot).
const VPC_REQUIRING_CAPABILITY_KEYS = new Set<string>([
  CAPABILITY_KEYS.ECS_FARGATE_SERVICE,
  CAPABILITY_KEYS.ECS_FARGATE_TASK,
  CAPABILITY_KEYS.RDS_POSTGRES,
  CAPABILITY_KEYS.ELASTICACHE_VALKEY,
  CAPABILITY_KEYS.ALB,
]);

/**
 * Evaluate compiler-v2 preflight on the frozen IR. Pure — same inputs always
 * give the same result. No AWS calls.
 */
export function evaluateCompilerPreflight(input: CompilerPreflightInput): CompilerPreflightResult {
  const { ir, region } = input;
  const blockers: string[] = [];
  const warnings: string[] = [];

  // 1. Region availability — null is a blocker; unsupported region is a blocker.
  if (region === null) {
    blockers.push('No region selected. Choose a supported AWS region before deployment.');
  } else if (!(SUPPORTED_AWS_REGIONS as readonly string[]).includes(region)) {
    blockers.push(`Region "${region}" is not in the supported AWS region list.`);
  }

  // Region/capability availability for RDS PostgreSQL 16 and ElastiCache Valkey.
  // All 17 supported regions offer both services for MVP; the blocker only fires
  // when the region is null (handled above). If a future region is added that
  // lacks one of these, extend this check.
  const hasRds = ir.resources.some((r) => RDS_CAPABILITY_KEYS.has(r.capabilityKey));
  const hasElastiCache = ir.resources.some((r) => ELASTICACHE_CAPABILITY_KEYS.has(r.capabilityKey));
  if (hasRds && region === null) {
    blockers.push('RDS PostgreSQL 16 requires a supported region, but no region is selected.');
  }
  if (hasElastiCache && region === null) {
    blockers.push('ElastiCache Valkey requires a supported region, but no region is selected.');
  }

  // 2. CloudFormation limits.
  // Resources: use IR resource count as a lower-bound proxy. The compiler may
  // expand each IR resource into multiple CFN resources, so we warn (not block)
  // when the IR count alone approaches the limit.
  const irResourceCount = ir.resources.length;
  if (irResourceCount > CFN_MAX_RESOURCES) {
    blockers.push(
      `IR declares ${irResourceCount} resources, which exceeds the CloudFormation soft limit of ${CFN_MAX_RESOURCES}. Reduce the composition.`,
    );
  } else if (irResourceCount > Math.floor(CFN_MAX_RESOURCES * 0.8)) {
    warnings.push(
      `IR declares ${irResourceCount} resources, approaching the CloudFormation soft limit of ${CFN_MAX_RESOURCES}.`,
    );
  }

  // Parameters and outputs: the IR does not yet carry these counts. Warn that
  // the check cannot be performed — fail safely.
  warnings.push(
    'CloudFormation parameter/output count check is not available at the IR level; the compiler will validate at template synthesis.',
  );

  // 3. VPC/networking sanity — MVP uses one NAT gateway.
  const vpcRequiringResources = ir.resources.filter((r) => VPC_REQUIRING_CAPABILITY_KEYS.has(r.capabilityKey));
  if (vpcRequiringResources.length > 0) {
    // Heuristic: if more than 3 distinct AZ-scoped resource groups exist,
    // a multi-AZ NAT topology might be implied. MVP uses one NAT gateway.
    const distinctAzScopedGroups = new Set(
      vpcRequiringResources.map((r) => `${r.capabilityKey}:${r.scope}`),
    );
    if (distinctAzScopedGroups.size > 3) {
      warnings.push(
        `Composition includes ${distinctAzScopedGroups.size} VPC-scoped capability groups; MVP uses one NAT gateway. Verify networking fits single-NAT topology.`,
      );
    }
  }

  // 4. Quota defaults — warn if the composition would create more than one VPC.
  // Heuristic: any VPC-requiring resource implies one shared VPC. If the IR
  // declares resources in multiple FIXED_REGION scopes targeting different
  // regions, that would imply multiple VPCs.
  const fixedRegionScopes = new Set(
    ir.resources.filter((r) => r.scope === 'FIXED_REGION' && VPC_REQUIRING_CAPABILITY_KEYS.has(r.capabilityKey))
      .map((r) => r.configuration?.targetRegion as string | undefined)
      .filter((v): v is string => typeof v === 'string' && v.length > 0),
  );
  if (fixedRegionScopes.size > 1) {
    warnings.push(
      `Resources target ${fixedRegionScopes.size} distinct regions (${[...fixedRegionScopes].join(', ')}); each would require its own VPC. Default quota is one VPC per deployment.`,
    );
  }

  const state: CompilerPreflightResult['state'] = blockers.length > 0 ? 'ACTION_REQUIRED' : 'READY';
  return { state, blockers, warnings };
}
