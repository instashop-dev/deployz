import { currentInfrastructureSizeProfile, type InfrastructureSizeTier } from '@deployz/contracts';

export function sizeTierLabel(tier: InfrastructureSizeTier): string {
  return currentInfrastructureSizeProfile(tier).label;
}

/** The compute of one container, as customers read it: `1 vCPU · 2 GiB`. */
export function formatCompute({ cpuUnits, memoryMiB }: { cpuUnits: number; memoryMiB: number }): string {
  const memory = memoryMiB >= 1024 ? `${memoryMiB / 1024} GiB` : `${memoryMiB} MiB`;
  return `${cpuUnits / 1024} vCPU · ${memory}`;
}

/** The compute of one container in a size. */
export function sizeTierCompute(tier: InfrastructureSizeTier): string {
  return formatCompute(currentInfrastructureSizeProfile(tier).workload);
}
