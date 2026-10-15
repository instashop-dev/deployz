/**
 * Size certification: the pure comparison behind `assertSizing`. Three
 * sources must agree - the frozen profile for the expected tier, the install
 * plan footprint the customer approved, and what AWS actually runs.
 */
import { currentInfrastructureSizeProfile, profileKey, type InfrastructureSizeProfile, type InfrastructureSizeTier } from '@deployz/contracts';

import type { PlanFootprint } from './control-plane.js';

export interface ObservedSizing {
  readonly services: readonly { readonly name: string; readonly cpuUnits: number | null; readonly memoryMiB: number | null; readonly desiredCount: number }[];
  readonly database: { readonly instanceClass: string; readonly storageGb: number; readonly storageType: string } | null;
  readonly cache: { readonly nodeType: string; readonly nodeCount: number } | null;
}

export interface PlannedSizing {
  readonly workloads: readonly { readonly id: string; readonly cpuUnits: number; readonly memoryMiB: number }[];
  readonly database: { readonly instanceClass: string; readonly storageGb: number } | null;
  readonly cache: { readonly nodeType: string; readonly nodeCount: number } | null;
}

export function plannedSizingFromFootprint(footprint: PlanFootprint): PlannedSizing {
  const database = footprint.resources.find((r) => r.category === 'database');
  const cache = footprint.resources.find((r) => r.category === 'cache');
  return {
    workloads: footprint.workloads.map((w) => ({ id: w.id, cpuUnits: w.compute.cpuUnits, memoryMiB: w.compute.memoryMiB })),
    database: database
      ? { instanceClass: String(database.configuration['instanceType']), storageGb: Number(database.configuration['storageGb']) }
      : null,
    cache: cache ? { nodeType: String(cache.configuration['nodeType']), nodeCount: Number(cache.configuration['nodes']) } : null,
  };
}

export interface SizingExpectation {
  readonly tier: InfrastructureSizeTier;
  readonly expectDatabase: boolean;
  readonly expectCache: boolean;
}

function distinct(values: readonly (string | number)[]): string {
  const unique = [...new Set(values.map(String))];
  return unique.length === 0 ? 'none' : unique.join('|');
}

/**
 * Every disagreement between AWS, the plan and the expected profile, as one
 * precise message each. An empty list means all three agree.
 */
export function compareSizing(input: {
  readonly expectation: SizingExpectation;
  readonly observed: ObservedSizing;
  readonly planned: PlannedSizing;
  readonly frozenSize: { readonly profileKey: string; readonly label: string } | null;
}): string[] {
  const { expectation, observed, planned, frozenSize } = input;
  const profile: InfrastructureSizeProfile = currentInfrastructureSizeProfile(expectation.tier);
  const problems: string[] = [];

  const expectedKey = profileKey(profile);
  if (!frozenSize) problems.push(`the deployment detail carries no size, expected ${expectedKey}`);
  else if (frozenSize.profileKey !== expectedKey) {
    problems.push(`frozen size is ${frozenSize.profileKey}, expected ${expectedKey}`);
  }

  const check = (field: string, aws: string | number | null, plan: string | number, expected: string | number): void => {
    if (String(aws) !== String(expected)) problems.push(`${field}: AWS has ${String(aws)}, expected ${String(expected)}`);
    if (String(plan) !== String(expected)) problems.push(`${field}: plan footprint has ${String(plan)}, expected ${String(expected)}`);
    if (String(aws) !== String(plan)) problems.push(`${field}: plan and AWS disagree (plan ${String(plan)}, AWS ${String(aws)})`);
  };

  const plannedCpu = distinct(planned.workloads.map((w) => w.cpuUnits));
  const plannedMemory = distinct(planned.workloads.map((w) => w.memoryMiB));
  if (observed.services.length === 0) problems.push('no ECS service found in the application stack');
  for (const service of observed.services) {
    check(`ECS service ${service.name} CPU units`, service.cpuUnits, plannedCpu, profile.workload.cpuUnits);
    check(`ECS service ${service.name} memory MiB`, service.memoryMiB, plannedMemory, profile.workload.memoryMiB);
    if (service.desiredCount !== profile.workload.desiredCount) {
      problems.push(`ECS service ${service.name} desired count: AWS has ${service.desiredCount}, expected ${profile.workload.desiredCount}`);
    }
  }

  if (expectation.expectDatabase) {
    if (!observed.database) problems.push('database: no RDS instance found in the application stack');
    else {
      check('RDS instance class', observed.database.instanceClass, planned.database?.instanceClass ?? 'none', profile.database.instanceClass);
      check('RDS allocated storage GB', observed.database.storageGb, planned.database?.storageGb ?? 'none', profile.database.storageGb);
      if (observed.database.storageType !== profile.database.storageType) {
        problems.push(`RDS storage type: AWS has ${observed.database.storageType}, expected ${profile.database.storageType}`);
      }
    }
  } else if (planned.database) {
    problems.push('the plan footprint has a database this profile does not use');
  }

  if (expectation.expectCache) {
    if (!observed.cache) problems.push('cache: no ElastiCache replication group or cluster found in the application stack');
    else {
      check('ElastiCache node type', observed.cache.nodeType, planned.cache?.nodeType ?? 'none', profile.cache.nodeType);
      check('ElastiCache node count', observed.cache.nodeCount, planned.cache?.nodeCount ?? 'none', profile.cache.nodeCount);
    }
  } else if (planned.cache) {
    problems.push('the plan footprint has a cache this profile does not use');
  }

  return problems;
}
