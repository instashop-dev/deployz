import { z } from 'zod';

import { INFRASTRUCTURE_COMPONENT_DISPLAY } from './infrastructure.js';
import { INFRASTRUCTURE_COMPONENTS, requiredInfrastructureComponents } from './components.js';
import type { InfrastructureComponentDefinition } from './components.js';
import type { DeploymentManifest } from './manifest.js';
// Value imports from './index.js' are used ONLY inside function bodies below
// (never at this module's top level) — `plan.ts` is re-exported from
// `index.ts`, so a top-level reference to a value still being initialized
// there (e.g. `regionSchema`) would throw. `regionSchema` itself is only
// reachable from a lazy schema for the same reason.
import { infrastructureProfileForManifest, regionSchema } from './index.js';
import type { InfrastructureProfile, Region } from './index.js';

// A deployment plan — the deterministic, derived-only description of what
// INSTALL/UPDATE/DESTROY will do to a deployment's infrastructure. Built
// entirely from the manifest and the component catalog (`components.ts`);
// never from AWS, never from an LLM. See docs/architecture.md "Deployment
// plans".

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

function requirementDriftFor(
  deployedProfile: InfrastructureProfile,
  desiredProfile: InfrastructureProfile,
): DeploymentPlan['requirementDrift'] {
  return [driftFor('database', deployedProfile, desiredProfile), driftFor('cache', deployedProfile, desiredProfile)].filter(
    (entry): entry is DeploymentPlan['requirementDrift'][number] => entry !== null,
  );
}

/** INSTALL plan — every required component is CREATE. */
export function buildInstallPlan(input: { manifest: DeploymentManifest; region: Region | null }): DeploymentPlan {
  const profile = infrastructureProfileForManifest(input.manifest);
  return {
    schemaVersion: DEPLOYMENT_PLAN_SCHEMA_VERSION,
    action: 'INSTALL',
    region: input.region,
    components: requiredInfrastructureComponents(profile).map((component) => toPlanComponent(component, 'CREATE')),
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
}): DeploymentPlan {
  const deployedProfile = infrastructureProfileForManifest(input.deployedManifest);
  const desiredProfile = infrastructureProfileForManifest(input.desiredManifest);
  const components = requiredInfrastructureComponents(deployedProfile).map((component) =>
    toPlanComponent(component, component.kind === 'application' && input.newRelease ? 'UPDATE' : 'UNCHANGED'),
  );
  return {
    schemaVersion: DEPLOYMENT_PLAN_SCHEMA_VERSION,
    action: 'UPDATE',
    region: input.region,
    components,
    requirementDrift: requirementDriftFor(deployedProfile, desiredProfile),
  };
}

/** DESTROY plan — required components DELETE (lifecycle 'delete') or RETAIN (lifecycle 'retain'). */
export function buildDestroyPlan(input: { manifest: DeploymentManifest; region: Region }): DeploymentPlan {
  const profile = infrastructureProfileForManifest(input.manifest);
  return {
    schemaVersion: DEPLOYMENT_PLAN_SCHEMA_VERSION,
    action: 'DESTROY',
    region: input.region,
    components: requiredInfrastructureComponents(profile).map((component) =>
      toPlanComponent(component, component.lifecycle === 'delete' ? 'DELETE' : 'RETAIN'),
    ),
    requirementDrift: [],
  };
}
