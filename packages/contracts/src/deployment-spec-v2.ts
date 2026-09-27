import { z } from 'zod';

import { applicationGraphSchema } from './application-graph.js';
import { deployzIrSchema } from './deployz-ir.js';
import { deploymentFootprintSchema } from './footprint.js';
import { infrastructureComponentKindSchema, type ResourceClassification } from './infrastructure.js';

// ---------------------------------------------------------------------------
// DeploymentSpecV2 — the frozen deployment envelope.
//
// DeploymentSpecV2 freezes the v2 deployment contract: the ApplicationGraph,
// the DeployzIR, version and hash metadata, and (once compiled) the compiler's
// outputs — verification contract, ownership records, footprint and the
// published artifact location. It does not contain CloudFormation.
// ---------------------------------------------------------------------------

export const DEPLOYMENT_SPEC_V2_SCHEMA_VERSION = 1 as const;

/** Infrastructure generation values. */
export const INFRA_VERSION_RUNTIME_V1 = 'runtime-v1' as const;
export const INFRA_VERSION_DYNAMIC_COMPILER_V2 = 'dynamic-compiler-v2' as const;

/** One compiler-emitted verification check (what proves a component exists). */
export const deploymentVerificationCheckSchema = z
  .object({
    componentId: z.string().min(1),
    componentKind: infrastructureComponentKindSchema,
    capability: z.string().min(1),
    /** Relay check name (compute/ingress/database/storage/cache). */
    check: z.string().min(1),
    /** CFN resource type whose COMPLETE presence proves the component exists. */
    primaryResourceType: z.string().min(1),
    logicalId: z.string().min(1),
  })
  .strict();
export type DeploymentVerificationCheck = z.infer<typeof deploymentVerificationCheckSchema>;

/** The verification contract — what must exist, per component. */
export const deploymentVerificationContractSchema = z
  .object({
    checks: z.array(deploymentVerificationCheckSchema).readonly(),
  })
  .strict();
export type DeploymentVerificationContract = z.infer<typeof deploymentVerificationContractSchema>;

/** One resource ownership record (installation → … → purge strategy). */
export const deploymentOwnershipRecordSchema = z
  .object({
    componentId: z.string().min(1),
    componentKind: infrastructureComponentKindSchema,
    capability: z.string().min(1),
    logicalResourceId: z.string().min(1),
    /** Physical resource id — resolved at deploy time, null in the compiled artifact. */
    physicalResourceId: z.string().nullable(),
    stateful: z.boolean(),
    retention: z.enum(['retain', 'delete']),
    purgeStrategy: z.enum(['delete', 'require_manual', 'skip']).nullable(),
  })
  .strict();
export type DeploymentOwnershipRecord = z.infer<typeof deploymentOwnershipRecordSchema>;

/**
 * The completed-compilation fields a spec carries once the compiler has run
 * and the template artifact has been published. Structurally satisfied by the
 * compiler's CompilationResult, so callers can pass its fields straight in.
 */
export interface DeploymentSpecCompilation {
  readonly compilerVersion: string;
  readonly templateHash: string;
  readonly artifactLocation: string;
  readonly verificationContract: DeploymentVerificationContract;
  readonly ownershipRecords: readonly DeploymentOwnershipRecord[];
  readonly footprint: z.infer<typeof deploymentFootprintSchema>;
}

/**
 * The requirement booleans the spec's verification contract proves, or null
 * when the contract is absent (an uncompiled spec — never a guessed false).
 */
export function requirementsFromSpec(spec: DeploymentSpecV2): {
  databaseRequired: boolean;
  redisRequired: boolean;
} | null {
  if (spec.verificationContract === null) return null;
  const checks = new Set(spec.verificationContract.checks.map((check) => check.check));
  return { databaseRequired: checks.has('database'), redisRequired: checks.has('cache') };
}

/**
 * Inventory classification by CFN logical id, from the spec's ownership
 * records: a record's kind and retention, with the verification contract
 * naming the component's primary proof resource. Null on an uncompiled spec.
 */
export function ownershipClassificationsFromSpec(
  spec: DeploymentSpecV2,
): Map<string, ResourceClassification> | null {
  if (spec.ownershipRecords === null || spec.verificationContract === null) return null;
  const primaryLogicalIds = new Set(spec.verificationContract.checks.map((check) => check.logicalId));
  const classifications = new Map<string, ResourceClassification>();
  for (const record of spec.ownershipRecords) {
    classifications.set(record.logicalResourceId, {
      componentKind: record.componentKind,
      role: primaryLogicalIds.has(record.logicalResourceId) ? 'primary' : 'supporting',
      lifecycle: record.retention,
    });
  }
  return classifications;
}

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
    /** Compiler version — null until the spec has been compiled. */
    compilerVersion: z.string().nullable(),
    /** Template hash — null until the spec has been compiled. */
    templateHash: z.string().nullable(),
    /** https URL of the frozen compiled artifact — null until published. */
    artifactLocation: z.string().nullable(),
    /** What must exist, per component — from the compiled artifact. */
    verificationContract: deploymentVerificationContractSchema.nullable(),
    /** One ownership record per compiled logical resource. */
    ownershipRecords: z.array(deploymentOwnershipRecordSchema).nullable(),
    /** The compiler-resolved footprint (sizing + resources). */
    footprint: z.lazy(() => deploymentFootprintSchema).nullable(),
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
