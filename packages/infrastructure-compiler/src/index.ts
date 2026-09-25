import type { InfrastructureSizeProfile, Region } from '@deployz/contracts';
import { defaultInfrastructureSizeProfile } from '@deployz/contracts';

import type { DeployzIR } from '@deployz/contracts';

import { emitCloudFormation } from './cfn-emit.js';
import { compileInfrastructure } from './compile.js';
import { deriveFootprint, deriveOwnershipRecords, deriveVerificationContract } from './derived.js';
import { stableHash } from './hashing.js';
import type { CompilationResult } from './resolved-graph.js';

export * from './stable-identity.js';
export * from './resolved-graph.js';
export * from './compile.js';
export * from './cfn-emit.js';
export * from './derived.js';
export * from './hashing.js';

/**
 * The deterministic compiler entry point. Turns a frozen DeployzIR into the
 * full compiler output — resolved AWS graph, CloudFormation template,
 * footprint, verification contract, ownership records, and immutable-artifact
 * hashes — all derived from the SAME resolved graph.
 *
 * Pure: no AI, no synth-time AWS discovery, no wall-clock, no randomness.
 */
export function compileDeployzInfrastructure(input: {
  ir: DeployzIR;
  region: Region | null;
  sizeProfile?: InfrastructureSizeProfile;
}): CompilationResult {
  const profile = input.sizeProfile ?? defaultInfrastructureSizeProfile();
  const { graph, compilerVersion, capabilityRegistryVersion, region } = compileInfrastructure({
    ir: input.ir,
    region: input.region,
    sizeProfile: profile,
  });

  const template = emitCloudFormation(graph);
  const footprint = deriveFootprint({ ir: input.ir, region, profile });
  const verificationContract = deriveVerificationContract(graph);
  const ownershipRecords = deriveOwnershipRecords(graph);

  const irHash = stableHash(input.ir);
  const templateHash = stableHash(template);

  return {
    resolvedGraph: graph,
    template,
    footprint,
    verificationContract,
    ownershipRecords,
    artifact: {
      compilerVersion,
      capabilityRegistryVersion,
      irHash,
      templateHash,
    },
    region,
  };
}
