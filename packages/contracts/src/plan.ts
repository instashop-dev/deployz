import { z } from 'zod';

import { INFRASTRUCTURE_COMPONENT_DISPLAY } from './infrastructure.js';
import { INFRASTRUCTURE_COMPONENTS, requiredInfrastructureComponents } from './components.js';
import { deploymentPlanAwsResourceSchema, requiredAwsResources, toPlanAwsResource } from './aws-resources.js';
import { resolveDeploymentFootprint, deploymentFootprintSchema } from './footprint.js';
import type { DeploymentFootprint } from './footprint.js';
import { estimateFootprintCost, footprintCostEstimateSchema } from './pricing.js';
import type { FootprintCostEstimate } from './pricing.js';
import type { InfrastructureComponentDefinition } from './components.js';
import type { DeploymentManifest } from './manifest.js';
// Value imports from './index.js' are used ONLY inside function bodies below
// (never at this module's top level) — `plan.ts` is re-exported from
// `index.ts`, so a top-level reference to a value still being initialized
// there (e.g. `regionSchema`) would throw. `regionSchema` itself is only
// reachable from a lazy schema for the same reason.
import { regionSchema } from './index.js';
import type { InfrastructureProfile, Region } from './index.js';
import type { InfrastructureSizeProfile } from './profile.js';

// A deployment plan — the deterministic, derived-only description of what
// INSTALL/UPDATE/DESTROY will do to a deployment's infrastructure. Built
// entirely from the manifest's requirement booleans (the same two values the
// graph→planner chain reads), the component catalog (`components.ts`) and the
// AWS resource catalog (`aws-resources.ts`); never from AWS, never from an
// LLM. When the deployment carries a compiled spec, its persisted compiler
// footprint is used verbatim so display and provisioning cannot disagree.
// See docs/architecture.md "Deployment plans".

/** The graph-shaping requirement booleans, straight from the manifest. */
function manifestRequirements(manifest: Pick<DeploymentManifest, 'database' | 'redis'>): InfrastructureProfile {
  return { postgres: manifest.database.postgres, redis: manifest.redis.required };
}

export const DEPLOYMENT_PLAN_SCHEMA_VERSION = 1 as const;

export const planActionSchema = z.enum(['INSTALL', 'UPDATE', 'DESTROY']);
export type PlanAction = z.infer<typeof planActionSchema>;

export const planComponentActionSchema = z.enum(['CREATE', 'UPDATE', 'UNCHANGED', 'DELETE', 'RETAIN']);
export type PlanComponentAction = z.infer<typeof planComponentActionSchema>;

const planComponentKindSchema = z.enum(['application', 'endpoint', 'database', 'cache', 'storage']);

export const deploymentPlanComponentSchema = z
  .object({
    kind: planComponentKindSchema,
    name: z.string(),
    action: planComponentActionSchema,
    lifecycle: z.enum(['delete', 'retain']),
  })
  .strict();
export type DeploymentPlanComponent = z.infer<typeof deploymentPlanComponentSchema>;

const planRequirementDriftSchema = z
  .object({
    kind: z.enum(['database', 'cache']),
    deployed: z.boolean(),
    desired: z.boolean(),
  })
  .strict();

export const deploymentPlanSchema = z
  .object({
    schemaVersion: z.literal(DEPLOYMENT_PLAN_SCHEMA_VERSION),
    action: planActionSchema,
    region: z.lazy(() => regionSchema).nullable(),
    components: z.array(deploymentPlanComponentSchema),
    /** The meaningful AWS resources behind `components` — the "AWS
     *  infrastructure details" preview. Same profile rule as the components,
     *  so the two lists can never disagree. */
    awsResources: z.array(deploymentPlanAwsResourceSchema),
    /** The resolved Deployment Footprint (workloads + managed resources with
     *  exact sizing) for the same manifest — optional so payloads built
     *  before the field existed stay valid. Lazy for the same init-order
     *  reason as `region`: footprint.ts is initialized through the
     *  index.ts cycle and must not be read while plan.ts is evaluating. */
    footprint: z.lazy(() => deploymentFootprintSchema).nullable().optional(),
    /** Baseline monthly AWS cost estimate for `footprint`. Optional for the
     *  same reason; display stays approximate and never blocks deployment. */
    costEstimate: z.lazy(() => footprintCostEstimateSchema).nullable().optional(),
    /** UPDATE only — requirement differences the current architecture cannot apply in place. Empty otherwise. */
    requirementDrift: z.array(planRequirementDriftSchema),
  })
  .strict();
export type DeploymentPlan = z.infer<typeof deploymentPlanSchema>;

// The five catalog components only ever carry 'delete' or 'retain' (the
// other two InfrastructureLifecycle values describe supporting resources
// outside this catalog) — narrow rather than widen the plan schema for them.
function toPlanComponent(
  component: InfrastructureComponentDefinition,
  action: PlanComponentAction,
): DeploymentPlanComponent {
  return {
    kind: component.kind,
    name: INFRASTRUCTURE_COMPONENT_DISPLAY[component.kind].name,
    action,
    lifecycle: component.lifecycle === 'retain' ? 'retain' : 'delete',
  };
}

/** Requirement drift for one catalog kind — null when the two profiles agree. */
function driftFor(
  kind: 'database' | 'cache',
  deployedProfile: InfrastructureProfile,
  desiredProfile: InfrastructureProfile,
): DeploymentPlan['requirementDrift'][number] | null {
  const component = INFRASTRUCTURE_COMPONENTS.find((candidate) => candidate.kind === kind)!;
  const deployed = component.requiredBy(deployedProfile);
  const desired = component.requiredBy(desiredProfile);
  return deployed === desired ? null : { kind, deployed, desired };
}

/** Requirement drift between two profiles — shared by buildUpdatePlan and the readiness API's per-deployment summary. */
export function requirementDriftFor(
  deployedProfile: InfrastructureProfile,
  desiredProfile: InfrastructureProfile,
): DeploymentPlan['requirementDrift'] {
  return [driftFor('database', deployedProfile, desiredProfile), driftFor('cache', deployedProfile, desiredProfile)].filter(
    (entry): entry is DeploymentPlan['requirementDrift'][number] => entry !== null,
  );
}

/**
 * The footprint + baseline cost estimate every plan carries. The compiler's
 * persisted footprint is used verbatim when given; otherwise it is derived
 * from the SAME manifest and region as the plan itself, so the displayed
 * sizing can never disagree with the plan's components. Pricing is
 * decorative — nothing in provisioning reads it, and a pricing adapter gap
 * degrades the estimate, never the plan.
 */
function footprintFor(input: {
  manifest: DeploymentManifest;
  region: Region | null;
  infraVersion: string | null;
  profile?: InfrastructureSizeProfile;
  compiledFootprint?: DeploymentFootprint;
}): {
  footprint: DeploymentFootprint;
  costEstimate: FootprintCostEstimate;
} {
  const footprint =
    input.compiledFootprint ??
    resolveDeploymentFootprint({
      manifest: input.manifest,
      region: input.region,
      infraVersion: input.infraVersion,
      ...(input.profile !== undefined ? { profile: input.profile } : {}),
    });
  return { footprint, costEstimate: estimateFootprintCost(footprint) };
}

/** INSTALL plan — every required component is CREATE. */
export function buildInstallPlan(input: {
  manifest: DeploymentManifest;
  region: Region | null;
  infraVersion?: string | null;
  profile?: InfrastructureSizeProfile;
  /** The compiler's persisted footprint (spec_v2.footprint) when known. */
  compiledFootprint?: DeploymentFootprint;
}): DeploymentPlan {
  const profile = manifestRequirements(input.manifest);
  return {
    schemaVersion: DEPLOYMENT_PLAN_SCHEMA_VERSION,
    action: 'INSTALL',
    region: input.region,
    components: requiredInfrastructureComponents(profile).map((component) => toPlanComponent(component, 'CREATE')),
    awsResources: requiredAwsResources(profile).map(toPlanAwsResource),
    ...footprintFor({
      manifest: input.manifest,
      region: input.region,
      infraVersion: input.infraVersion ?? null,
      ...(input.profile !== undefined ? { profile: input.profile } : {}),
      ...(input.compiledFootprint !== undefined ? { compiledFootprint: input.compiledFootprint } : {}),
    }),
    requirementDrift: [],
  };
}

/**
 * UPDATE plan — the MVP boundary means topology never changes on an
 * existing deployment: application is UPDATE when a newer release exists,
 * every other component of the DEPLOYED profile is UNCHANGED, and any
 * difference between the deployed and desired profiles is reported as
 * `requirementDrift`, never as a CREATE/DELETE action.
 */
export function buildUpdatePlan(input: {
  deployedManifest: DeploymentManifest;
  desiredManifest: DeploymentManifest;
  region: Region;
  newRelease: boolean;
  infraVersion?: string | null;
  profile?: InfrastructureSizeProfile;
  /** The compiler's persisted footprint (spec_v2.footprint) when known. */
  compiledFootprint?: DeploymentFootprint;
}): DeploymentPlan {
  const deployedProfile = manifestRequirements(input.deployedManifest);
  const desiredProfile = manifestRequirements(input.desiredManifest);
  const components = requiredInfrastructureComponents(deployedProfile).map((component) =>
    toPlanComponent(component, component.kind === 'application' && input.newRelease ? 'UPDATE' : 'UNCHANGED'),
  );
  return {
    schemaVersion: DEPLOYMENT_PLAN_SCHEMA_VERSION,
    action: 'UPDATE',
    region: input.region,
    components,
    awsResources: requiredAwsResources(deployedProfile).map(toPlanAwsResource),
    ...footprintFor({
      manifest: input.deployedManifest,
      region: input.region,
      infraVersion: input.infraVersion ?? null,
      ...(input.profile !== undefined ? { profile: input.profile } : {}),
      ...(input.compiledFootprint !== undefined ? { compiledFootprint: input.compiledFootprint } : {}),
    }),
    requirementDrift: requirementDriftFor(deployedProfile, desiredProfile),
  };
}

/** DESTROY plan — required components DELETE (lifecycle 'delete') or RETAIN (lifecycle 'retain'). */
export function buildDestroyPlan(input: {
  manifest: DeploymentManifest;
  region: Region;
  infraVersion?: string | null;
  profile?: InfrastructureSizeProfile;
  /** The compiler's persisted footprint (spec_v2.footprint) when known. */
  compiledFootprint?: DeploymentFootprint;
}): DeploymentPlan {
  const profile = manifestRequirements(input.manifest);
  return {
    schemaVersion: DEPLOYMENT_PLAN_SCHEMA_VERSION,
    action: 'DESTROY',
    region: input.region,
    components: requiredInfrastructureComponents(profile).map((component) =>
      toPlanComponent(component, component.lifecycle === 'delete' ? 'DELETE' : 'RETAIN'),
    ),
    awsResources: requiredAwsResources(profile).map(toPlanAwsResource),
    ...footprintFor({
      manifest: input.manifest,
      region: input.region,
      infraVersion: input.infraVersion ?? null,
      ...(input.profile !== undefined ? { profile: input.profile } : {}),
      ...(input.compiledFootprint !== undefined ? { compiledFootprint: input.compiledFootprint } : {}),
    }),
    requirementDrift: [],
  };
}
