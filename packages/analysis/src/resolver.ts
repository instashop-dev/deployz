import {
  CAPABILITY_KEYS,
  type InfrastructureSizeProfile,
  type Resource,
} from '@deployz/contracts';

// ---------------------------------------------------------------------------
// Resolver — deterministic kind/engine/ownership → capability key mapping.
//
// Lives at the Graph → IR boundary. The ApplicationGraph describes what the
// application needs (kind, engine, ownership); the Resolver translates that
// into AWS capability selection for DEPLOYZ_MANAGED resources.
// ---------------------------------------------------------------------------

/**
 * Resolve a Resource to its AWS capability key. Returns null for non-managed
 * resources or resources whose kind/engine combination has no known mapping.
 */
export function resolveResourceCapability(resource: Resource): string | null {
  if (resource.ownership !== 'DEPLOYZ_MANAGED') return null;

  const { kind, engine, id } = resource;

  if (kind === 'relational_database' && engine === 'postgres') {
    return CAPABILITY_KEYS.RDS_POSTGRES;
  }
  if (kind === 'cache' && engine === 'valkey') {
    return CAPABILITY_KEYS.ELASTICACHE_VALKEY;
  }
  if (kind === 'object_storage') {
    return CAPABILITY_KEYS.S3;
  }
  if (kind === 'generic_service' && id === 'endpoint') {
    return CAPABILITY_KEYS.ALB;
  }

  return null;
}

/**
 * Build capability-specific sizing/configuration for a resolved capability
 * key, using the given infrastructure size profile.
 */
export function buildCapabilityConfiguration(
  capabilityKey: string,
  profile: InfrastructureSizeProfile,
): Record<string, unknown> {
  if (capabilityKey === CAPABILITY_KEYS.RDS_POSTGRES) {
    return {
      engine: 'postgres',
      engineVersion: '16',
      instanceType: profile.database.instanceClass,
      storageGb: profile.database.storageGb,
      maxStorageGb: profile.database.maxStorageGb,
    };
  }
  if (capabilityKey === CAPABILITY_KEYS.ELASTICACHE_VALKEY) {
    return {
      engine: 'valkey',
      nodeType: profile.cache.nodeType,
      nodes: profile.cache.nodeCount,
    };
  }
  return {};
}
