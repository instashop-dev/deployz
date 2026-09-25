/**
 * Phase 1 ApplicationGraph — pure, deterministic translation of a validated
 * DeploymentManifest (+ vendor overrides + analysis result) into the
 * AWS-independent application-requirements model.
 *
 * Shadow-mode only: does NOT change existing manifest behaviour.
 */

import {
  applicationGraphSchema,
  type ApplicationGraph,
  type Binding,
  type BuildArtifact,
  type DeploymentManifest,
  type DeploymentManifestOverrides,
  type EvidenceItem,
  type ExternalService,
  type ManifestEnvBinding,
  type Provenance,
  type Resource,
  type UnresolvedRequirement,
  type Workload,
} from '@deployz/contracts';

import type { AnalysisResult } from './analyser.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function detectedProvenance(evidence: EvidenceItem[]): Provenance {
  return { detected: true, overridden: false, evidence };
}

function fileEvidence(path: string, description: string, sourceType: EvidenceItem['sourceType'] = 'dockerfile'): EvidenceItem {
  return { sourceType, path, description };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// ── Build artifacts ─────────────────────────────────────────────────────────

function buildArtifacts(manifest: DeploymentManifest): BuildArtifact[] {
  const dockerfilePath = manifest.application.dockerfilePath;
  const evidence: EvidenceItem[] = dockerfilePath
    ? [fileEvidence(dockerfilePath, `Dockerfile at ${dockerfilePath}`)]
    : [fileEvidence(manifest.application.root, `Application root ${manifest.application.root}`, 'source_import')];

  return [
    {
      id: 'app',
      sourceRoot: manifest.application.root,
      dockerfilePath,
      buildContext: manifest.build.context,
      buildCommand: manifest.build.command,
      architecture: null,
      target: null,
      provenance: detectedProvenance(evidence),
    },
  ];
}

// ── Workloads ───────────────────────────────────────────────────────────────

function buildWorkloads(manifest: DeploymentManifest): Workload[] {
  const workloads: Workload[] = [];

  // Web workload — always present.
  workloads.push({
    id: 'web',
    kind: 'web',
    label: 'Web service',
    sourceRoot: manifest.application.root,
    buildArtifactId: 'app',
    command: manifest.web.command,
    port: manifest.web.port,
    public: true,
    healthCheck: manifest.health,
    desiredCount: 1,
    runtime: manifest.application.runtime,
    framework: manifest.application.framework,
    provenance: detectedProvenance(
      manifest.web.command
        ? [fileEvidence(manifest.application.root, `Web start command: ${manifest.web.command}`, 'source_import')]
        : [fileEvidence(manifest.application.root, 'Web workload (no start command detected)', 'source_import')],
    ),
  });

  // Worker workload — only when the manifest has a worker command.
  if (manifest.worker.command) {
    workloads.push({
      id: 'worker',
      kind: 'worker',
      label: 'Background worker',
      sourceRoot: manifest.application.root,
      buildArtifactId: 'app',
      command: manifest.worker.command,
      port: null,
      public: false,
      healthCheck: null,
      desiredCount: 1,
      runtime: manifest.application.runtime,
      framework: manifest.application.framework,
      provenance: detectedProvenance([
        fileEvidence(manifest.application.root, `Worker command: ${manifest.worker.command}`, 'source_import'),
      ]),
    });
  }

  // Migration workload — only when the manifest has a migration command.
  if (manifest.migration.command) {
    workloads.push({
      id: 'migration',
      kind: 'migration',
      label: 'Database migration',
      sourceRoot: manifest.application.root,
      buildArtifactId: 'app',
      command: manifest.migration.command,
      port: null,
      public: false,
      healthCheck: null,
      desiredCount: 1,
      runtime: manifest.application.runtime,
      framework: manifest.application.framework,
      provenance: detectedProvenance([
        fileEvidence(manifest.application.root, `Migration command: ${manifest.migration.command}`, 'source_import'),
      ]),
    });
  }

  return workloads;
}

// ── Resources ───────────────────────────────────────────────────────────────

const STANDARD_POSTGRES_BINDINGS: ManifestEnvBinding[] = [
  { name: 'DATABASE_URL', kind: 'url' },
  { name: 'DB_HOST', kind: 'host' },
  { name: 'DB_PORT', kind: 'port' },
  { name: 'DB_NAME', kind: 'database' },
  { name: 'DB_USER', kind: 'username' },
  { name: 'DB_PASSWORD', kind: 'password' },
];

const DEFAULT_STORAGE_BINDINGS: ManifestEnvBinding[] = [{ name: 'AWS_S3_BUCKET', kind: 'bucket' }];

function buildResources(manifest: DeploymentManifest): Resource[] {
  const resources: Resource[] = [];

  if (manifest.database.postgres) {
    resources.push({
      id: 'primary-db',
      kind: 'relational_database',
      label: 'PostgreSQL database',
      ownership: 'DEPLOYZ_MANAGED',
      quantity: 1,
      engine: 'postgres',
      envBindings: manifest.database.envBindings ?? STANDARD_POSTGRES_BINDINGS,
      provenance: detectedProvenance([
        { sourceType: 'orm_configuration', path: manifest.application.root, description: 'PostgreSQL requirement detected' },
      ]),
    });
  }

  if (manifest.redis.required) {
    resources.push({
      id: 'cache',
      kind: 'cache',
      label: 'Valkey cache',
      ownership: 'DEPLOYZ_MANAGED',
      quantity: 1,
      engine: 'valkey',
      envBindings: manifest.redis.envBindings,
      provenance: detectedProvenance([
        { sourceType: 'source_import', path: manifest.application.root, description: 'Redis/Valkey cache requirement detected' },
      ]),
    });
  }

  // S3 storage — always present.
  resources.push({
    id: 'storage',
    kind: 'object_storage',
    label: 'S3 bucket',
    ownership: 'DEPLOYZ_MANAGED',
    quantity: 1,
    engine: null,
    envBindings: manifest.storage.envBindings.length > 0 ? manifest.storage.envBindings : DEFAULT_STORAGE_BINDINGS,
    provenance: detectedProvenance([
      { sourceType: 'source_import', path: manifest.application.root, description: 'Object storage (S3 bucket)' },
    ]),
  });

  // ALB endpoint — always present.
  resources.push({
    id: 'endpoint',
    kind: 'generic_service',
    label: 'Application load balancer',
    ownership: 'DEPLOYZ_MANAGED',
    quantity: 1,
    engine: null,
    envBindings: [],
    provenance: detectedProvenance([
      { sourceType: 'source_import', path: manifest.application.root, description: 'ALB endpoint for public traffic' },
    ]),
  });

  // External services.
  for (const serviceName of manifest.externalServices) {
    resources.push({
      id: `ext-${slugify(serviceName) || 'service'}`,
      kind: 'external_service',
      label: serviceName,
      ownership: 'EXTERNAL_SAAS',
      quantity: 1,
      engine: null,
      envBindings: [],
      provenance: detectedProvenance([
        { sourceType: 'source_import', path: manifest.application.root, description: `External service: ${serviceName}` },
      ]),
    });
  }

  return resources;
}

// ── Bindings ────────────────────────────────────────────────────────────────

function buildBindings(manifest: DeploymentManifest, workloads: Workload[], resources: Resource[]): Binding[] {
  const bindings: Binding[] = [];
  const resourceMap = new Map(resources.map((r) => [r.id, r]));

  // Managed resource IDs workloads bind to.
  const managedResourceIds: string[] = [];
  if (manifest.database.postgres) managedResourceIds.push('primary-db');
  if (manifest.redis.required) managedResourceIds.push('cache');
  managedResourceIds.push('storage');

  let bindingIndex = 0;
  for (const workload of workloads) {
    for (const resourceId of managedResourceIds) {
      const resource = resourceMap.get(resourceId);
      if (!resource) continue;
      bindings.push({
        id: `binding-${bindingIndex++}`,
        sourceId: workload.id,
        targetId: resourceId,
        relationship: 'BINDING',
        envBindings: resource.envBindings,
        provenance: detectedProvenance([
          { sourceType: 'source_import', path: manifest.application.root, description: `${workload.id} → ${resourceId}` },
        ]),
      });
    }
  }

  // RUNTIME binding between web and worker.
  if (workloads.some((w) => w.id === 'web') && workloads.some((w) => w.id === 'worker')) {
    bindings.push({
      id: `binding-${bindingIndex++}`,
      sourceId: 'web',
      targetId: 'worker',
      relationship: 'RUNTIME',
      envBindings: [],
      provenance: detectedProvenance([
        { sourceType: 'source_import', path: manifest.application.root, description: 'Web ↔ Worker runtime relationship' },
      ]),
    });
  }

  // STARTUP binding from migration to primary-db.
  if (workloads.some((w) => w.id === 'migration') && manifest.database.postgres) {
    bindings.push({
      id: `binding-${bindingIndex++}`,
      sourceId: 'migration',
      targetId: 'primary-db',
      relationship: 'STARTUP',
      envBindings: resourceMap.get('primary-db')?.envBindings ?? [],
      provenance: detectedProvenance([
        { sourceType: 'source_import', path: manifest.application.root, description: 'Migration → primary-db startup dependency' },
      ]),
    });
  }

  return bindings;
}

// ── External services (graph-level list) ────────────────────────────────────

function buildExternalServices(manifest: DeploymentManifest): ExternalService[] {
  return manifest.externalServices.map((name) => ({
    id: `ext-${slugify(name) || 'service'}`,
    name,
    reason: 'saas' as const,
    provenance: detectedProvenance([
      { sourceType: 'source_import', path: manifest.application.root, description: `External service: ${name}` },
    ]),
  }));
}

// ── Unresolved requirements ─────────────────────────────────────────────────

function buildUnresolved(manifest: DeploymentManifest): UnresolvedRequirement[] {
  const unresolved: UnresolvedRequirement[] = [];

  // Unsupported reasons are blocking.
  for (let i = 0; i < manifest.unsupported.length; i++) {
    const reason = manifest.unsupported[i]!;
    unresolved.push({
      id: `unsupported-${i}`,
      field: 'compatibility',
      question: reason,
      evidence: [
        { sourceType: 'source_import', path: manifest.application.root, description: reason },
      ],
      blocking: true,
    });
  }

  // PostgreSQL without migration strategy.
  if (
    manifest.database.postgres &&
    !manifest.migration.command &&
    manifest.migration.mode === 'unknown'
  ) {
    unresolved.push({
      id: 'migration-strategy',
      field: 'migration_strategy',
      question:
        'This application uses PostgreSQL but has no detected migration command. How should the database schema be updated on deploy?',
      evidence: [
        {
          sourceType: 'orm_configuration',
          path: manifest.application.root,
          description: 'PostgreSQL detected but no migration command or strategy found',
        },
      ],
      blocking: false,
    });
  }

  // External services — ask whether they should be managed.
  for (const serviceName of manifest.externalServices) {
    unresolved.push({
      id: `external-${slugify(serviceName) || 'service'}`,
      field: 'external_service_ownership',
      question: `Should the external service "${serviceName}" be treated as a Deployz-managed resource?`,
      evidence: [
        {
          sourceType: 'source_import',
          path: manifest.application.root,
          description: `External service detected: ${serviceName}`,
        },
      ],
      blocking: false,
    });
  }

  return unresolved;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Build an ApplicationGraph from a validated manifest, analysis result, and
 * vendor overrides. The overrides parameter is accepted for interface
 * completeness; the manifest is the authoritative input (overrides are
 * already baked in by normalizeDeploymentManifest).
 */
export function buildApplicationGraph(input: {
  analysisResult: AnalysisResult;
  manifest: DeploymentManifest;
  overrides: DeploymentManifestOverrides;
}): ApplicationGraph {
  const { manifest } = input;
  const workloads = buildWorkloads(manifest);
  const resources = buildResources(manifest);

  const graph: ApplicationGraph = {
    schemaVersion: 1,
    applicationRoot: manifest.application.root,
    buildArtifacts: buildArtifacts(manifest),
    workloads,
    resources,
    bindings: buildBindings(manifest, workloads, resources),
    externalServices: buildExternalServices(manifest),
    unresolved: buildUnresolved(manifest),
  };

  return applicationGraphSchema.parse(graph);
}

/**
 * Build an ApplicationGraph from an existing v1 manifest alone (no analysis
 * result or overrides). Used for shadow comparison against the live manifest
 * pipeline.
 */
export function manifestToApplicationGraph(manifest: DeploymentManifest): ApplicationGraph {
  const workloads = buildWorkloads(manifest);
  const resources = buildResources(manifest);

  const graph: ApplicationGraph = {
    schemaVersion: 1,
    applicationRoot: manifest.application.root,
    buildArtifacts: buildArtifacts(manifest),
    workloads,
    resources,
    bindings: buildBindings(manifest, workloads, resources),
    externalServices: buildExternalServices(manifest),
    unresolved: buildUnresolved(manifest),
  };

  return applicationGraphSchema.parse(graph);
}
