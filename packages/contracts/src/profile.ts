import { z } from 'zod';

// Immutable infrastructure-size profile registry (MVP Readiness 2, Phase 1).
//
// A profile is the ONE source of truth for the AWS sizing of a deployment's
// application stack: how many vCPU/MiB the web/worker containers get, what
// RDS instance class and storage the managed PostgreSQL uses, and what
// ElastiCache node type/count the managed Valkey cache uses. It is
// deliberately DISTINCT from the graph-shaping `InfrastructureProfile`
// (`{ postgres, redis }`) in `index.ts`, which selects the template variant;
// the size profile selects the sizes within that variant.
//
// Profiles are immutable: a published `id`+`version` never changes its values.
// A topology- or sizing-changing option (a future `minimal` profile, a
// different RDS class) requires a NEW version plus a new `infra_version` and a
// security review — it never mutates a published entry. `small-v1` is the only
// published profile today and captures exactly the pre-registry sizing.

export const INFRASTRUCTURE_SIZE_PROFILE_SCHEMA_VERSION = 1 as const;

export interface InfrastructureSizeProfile {
  readonly id: string;
  readonly version: number;
  readonly label: string;
  readonly description: string;
  readonly workload: {
    readonly cpuUnits: number;
    readonly memoryMiB: number;
    readonly desiredCount: number;
  };
  readonly database: {
    readonly instanceClass: string;
    readonly storageGb: number;
    readonly maxStorageGb: number;
  };
  readonly cache: {
    readonly nodeType: string;
    readonly nodeCount: number;
  };
}

export const SMALL_PROFILE: InfrastructureSizeProfile = {
  id: 'small',
  version: 1,
  label: 'Small',
  description:
    'A single web container (0.25 vCPU / 512 MiB), a db.t4g.micro PostgreSQL 16 instance (20 GB), and a single-node Valkey cache when the application needs one.',
  workload: {
    cpuUnits: 256,
    memoryMiB: 512,
    desiredCount: 1,
  },
  database: {
    instanceClass: 'db.t4g.micro',
    storageGb: 20,
    maxStorageGb: 100,
  },
  cache: {
    nodeType: 'cache.t4g.micro',
    nodeCount: 1,
  },
};

// The published registry. Adding a new profile appends here and appends a
// `resolveInfrastructureSizeProfile` entry; it never edits `SMALL_PROFILE`.
export const INFRASTRUCTURE_SIZE_PROFILES: readonly InfrastructureSizeProfile[] = [SMALL_PROFILE];

const PROFILES_BY_KEY = new Map<string, InfrastructureSizeProfile>(
  INFRASTRUCTURE_SIZE_PROFILES.map((profile) => [profileKey(profile), profile]),
);

/** The stable registry key for a profile: `small-v1`. */
export function profileKey(profile: InfrastructureSizeProfile): string {
  return `${profile.id}-v${profile.version}`;
}

/** Resolve a published profile by id + version; `undefined` when unknown. */
export function resolveInfrastructureSizeProfile(
  id: string,
  version: number,
): InfrastructureSizeProfile | undefined {
  return PROFILES_BY_KEY.get(`${id}-v${version}`);
}

/** The one profile the MVP publishes and every deployment defaults to. */
export function defaultInfrastructureSizeProfile(): InfrastructureSizeProfile {
  return SMALL_PROFILE;
}

/** Zod schema for the frozen profile reference stored in a deployment's desired state. */
export const infrastructureSizeProfileRefSchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().min(1),
  })
  .strict();
export type InfrastructureSizeProfileRef = z.infer<typeof infrastructureSizeProfileRefSchema>;

/**
 * Resolve the profile a deployment was frozen with, from its desired state.
 * Existing deployments (no stored profile) resolve safely to `small-v1`. A
 * stored reference that does not resolve to a published profile returns
 * `undefined` — callers must fail closed rather than guess a size.
 */
export function resolveStoredInfrastructureSizeProfile(
  desiredState: Record<string, unknown> | null | undefined,
): InfrastructureSizeProfile | undefined {
  const ref = (desiredState as { infrastructureProfile?: unknown } | null | undefined)?.infrastructureProfile;
  if (ref === undefined) return defaultInfrastructureSizeProfile();
  const parsed = infrastructureSizeProfileRefSchema.safeParse(ref);
  if (!parsed.success) return undefined;
  return resolveInfrastructureSizeProfile(parsed.data.id, parsed.data.version);
}
