import {
  workloadServicesFromSpec,
  type DeploymentManifest,
  type DeploymentSpecV2,
  type ReleaseEvidence,
} from '@deployz/contracts';

import { compileDeploymentIntent } from './compiler-artifact.js';

// Test fixture: a compiled web-only spec and the relay's healthy release
// evidence for it, as a heartbeat carries it in observedState.releaseEvidence.

const WEB_ONLY_MANIFEST: DeploymentManifest = {
  schemaVersion: 1,
  application: { root: '.', runtime: 'node', framework: null, dockerfilePath: null },
  build: { command: null, context: '.' },
  web: { command: 'npm start', port: 3000 },
  health: { path: '/health' },
  database: { postgres: false },
  redis: { required: false, envBindings: [] },
  storage: { required: false, envBindings: [] },
  migration: { command: null },
  worker: { command: null },
  environment: { variables: [] },
  externalServices: [],
  unsupported: [],
};

export function webOnlySpec(): DeploymentSpecV2 {
  return compileDeploymentIntent({ manifest: WEB_ONLY_MANIFEST, region: 'us-east-1' }).spec;
}

/** Complete healthy evidence for every workload of `spec`, all running `digest`, observed now. */
export function healthyReleaseEvidence(spec: DeploymentSpecV2, digest: string): ReleaseEvidence {
  const at = new Date().toISOString();
  return {
    version: 1,
    observedAt: at,
    services: workloadServicesFromSpec(spec)!.map((workload) => ({
      workloadId: workload.id,
      serviceLogicalId: workload.serviceLogicalId,
      observed: true,
      desiredCount: 1,
      runningCount: 1,
      rolloutState: 'COMPLETED',
      runningDigests: [digest],
      targets: workload.id === 'web' ? { healthy: 1, unhealthy: 0, pending: 0, unknown: 0 } : null,
    })),
    httpProbe: { ok: true, status: 200, checkedAt: at },
  };
}
