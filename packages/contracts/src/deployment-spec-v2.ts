import { z } from 'zod';

import { applicationGraphSchema } from './application-graph.js';
import { deployzIrSchema } from './deployz-ir.js';

// ---------------------------------------------------------------------------
// DeploymentSpecV2 — Phase 1 frozen deployment envelope.
//
// DeploymentSpecV2 freezes the v2 deployment contract: the ApplicationGraph,
// the DeployzIR, version and hash metadata. It does not contain CloudFormation.
// Phase 2 will add compiler version, capability versions, template hash and
// artifact location once the compiler exists.
// ---------------------------------------------------------------------------

export const DEPLOYMENT_SPEC_V2_SCHEMA_VERSION = 1 as const;

/** Infrastructure generation values. */
export const INFRA_VERSION_RUNTIME_V1 = 'runtime-v1' as const;
export const INFRA_VERSION_DYNAMIC_COMPILER_V2 = 'dynamic-compiler-v2' as const;

export const deploymentSpecV2Schema = z
  .object({
    schemaVersion: z.literal(DEPLOYMENT_SPEC_V2_SCHEMA_VERSION).default(DEPLOYMENT_SPEC_V2_SCHEMA_VERSION),
    /** Infrastructure generation this spec belongs to. */
    infraVersion: z.literal(INFRA_VERSION_DYNAMIC_COMPILER_V2),
    /** Source graph — what the application needs. */
    graph: applicationGraphSchema,
    /** Resolved provisioning intent. */
    ir: deployzIrSchema,
    /** Graph canonical hash for identity/diff. */
    graphHash: z.string().min(1),
    /** IR canonical hash for identity/diff. */
    irHash: z.string().min(1),
    /** Capability registry version used to resolve the IR. */
    capabilityRegistryVersion: z.string().min(1),
    /** Size profile id used for sizing. */
    sizeProfileId: z.string().min(1),
    /** Compiler version placeholder — null until Phase 2. */
    compilerVersion: z.string().nullable(),
    /** Template hash placeholder — null until Phase 2. */
    templateHash: z.string().nullable(),
    /** Artifact location placeholder — null until Phase 2. */
    artifactLocation: z.string().nullable(),
    /** When the spec was frozen. */
    frozenAt: z.string().datetime(),
  })
  .strict();
export type DeploymentSpecV2 = z.infer<typeof deploymentSpecV2Schema>;

export const deploymentSpecV2SummarySchema = z
  .object({
    schemaVersion: z.literal(DEPLOYMENT_SPEC_V2_SCHEMA_VERSION),
    infraVersion: z.literal(INFRA_VERSION_DYNAMIC_COMPILER_V2),
    graphHash: z.string().min(1),
    irHash: z.string().min(1),
    capabilityRegistryVersion: z.string().min(1),
    compilerVersion: z.string().nullable(),
    templateHash: z.string().nullable(),
  })
  .strict();
export type DeploymentSpecV2Summary = z.infer<typeof deploymentSpecV2SummarySchema>;

export function summarizeDeploymentSpecV2(spec: DeploymentSpecV2): DeploymentSpecV2Summary {
  return {
    schemaVersion: DEPLOYMENT_SPEC_V2_SCHEMA_VERSION,
    infraVersion: spec.infraVersion,
    graphHash: spec.graphHash,
    irHash: spec.irHash,
    capabilityRegistryVersion: spec.capabilityRegistryVersion,
    compilerVersion: spec.compilerVersion,
    templateHash: spec.templateHash,
  };
}
