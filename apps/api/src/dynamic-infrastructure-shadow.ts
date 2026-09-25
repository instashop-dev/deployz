import {
  manifestToApplicationGraph,
  normalizeDeploymentManifest,
  planApplicationGraphWithSpec,
} from '@deployz/analysis';

import { applicationToManifestOverrides, type ManifestApplicationRow } from './manifest.js';

// Phase 1 dynamic-infrastructure shadow.
//
// Shadow-only by contract: derives the ApplicationGraph → DeployzIR →
// DeploymentSpecV2 pipeline from the SAME manifest the production v1 path
// freezes, then emits one structured log line for observability. It never
// throws and never touches production state — the deterministic v1 manifest
// stays the single source of truth for provisioning.

export interface DynamicInfraShadowParams {
  applicationId: string;
  detectedMetadata: Record<string, unknown>;
  overrides: Omit<ManifestApplicationRow, 'detectedMetadata'>;
}

export interface DynamicInfraShadowRunner {
  run(params: DynamicInfraShadowParams): void;
}

export function createDynamicInfraShadowRunner(): DynamicInfraShadowRunner {
  return { run };
}

function run(params: DynamicInfraShadowParams): void {
  try {
    const manifest = normalizeDeploymentManifest(
      { metadata: params.detectedMetadata },
      applicationToManifestOverrides({ ...params.overrides, detectedMetadata: params.detectedMetadata }),
    );
    const graph = manifestToApplicationGraph(manifest);
    const { ir, spec } = planApplicationGraphWithSpec({ graph, region: null });
    console.log(
      JSON.stringify({
        event: 'dynamic-infra:shadow',
        applicationId: params.applicationId,
        workloads: graph.workloads.length,
        resources: graph.resources.length,
        managedResources: graph.resources.filter((r) => r.ownership === 'DEPLOYZ_MANAGED').length,
        unresolved: graph.unresolved.length,
        blockingUnresolved: graph.unresolved.filter((u) => u.blocking).length,
        irWorkloads: ir.workloads.length,
        irResources: ir.resources.length,
        graphHash: spec.graphHash,
        irHash: spec.irHash,
      }),
    );
  } catch (error) {
    // Shadow-only: a derivation failure must never affect the analysis flow.
    console.error(
      JSON.stringify({
        event: 'dynamic-infra:shadow-failed',
        applicationId: params.applicationId,
        error: String(error),
      }),
    );
  }
}
