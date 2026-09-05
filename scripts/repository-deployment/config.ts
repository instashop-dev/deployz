/**
 * Stage B per-repository vendor configuration and wave membership —
 * `docs/testing/repository-deployment/deploy-config.yaml`.
 *
 * Everything here is what a real vendor could set through the product
 * (application overrides, configuration values) plus what the audit needs
 * to verify a deployment (health path to probe, expected response,
 * dependency checks). It references Stage A entries by id and never
 * repeats the corpus. Secret VALUES are never stored: `secrets` names the
 * keys the harness generates at run time.
 */
import { readFileSync } from 'node:fs';

import { parse } from 'yaml';
import { z } from 'zod';

const ENTRY_ID_REGEX = /^repo-\d{3}$/;
const WAVE_ID_REGEX = /^[a-z0-9-]+$/;

/** Mirrors PATCH /api/applications/:id — the vendor-correctable manifest inputs. */
export const vendorOverridesSchema = z
  .object({
    containerPort: z.number().int().positive().optional(),
    healthPath: z.string().min(1).optional(),
    migrationCommand: z.string().min(1).nullable().optional(),
    databaseRequired: z.boolean().optional(),
    storageRequired: z.boolean().optional(),
    redisRequired: z.boolean().optional(),
    appRoot: z.string().min(1).optional(),
    dockerfilePath: z.string().min(1).optional(),
    buildContext: z.string().min(1).optional(),
    buildCommand: z.string().min(1).optional(),
    startCommand: z.string().min(1).optional(),
  })
  .strict();
export type VendorOverrides = z.infer<typeof vendorOverridesSchema>;

/**
 * A non-secret configuration value the vendor would type into the
 * Configuration screen. `${DEPLOYZ_APP_URL}` in a value stands for the
 * deployment's permanent default-HTTPS address: the harness writes a
 * placeholder at the vendor scope (so the gate sees the key) and the real
 * address at the customer scope as soon as the deployment id exists.
 */
export const configValueSchema = z
  .object({
    key: z.string().min(1),
    value: z.string(),
  })
  .strict();

export const APP_URL_TOKEN = '${DEPLOYZ_APP_URL}';

export const SECRET_FORMATS = ['base64url', 'hex32', 'hex64', 'password'] as const;
export type SecretFormat = (typeof SECRET_FORMATS)[number];

/** A secret key the harness generates at run time — a bare key, or a key with the format the app validates. */
export const secretSpecSchema = z.union([
  z.string().min(1),
  z.object({ key: z.string().min(1), format: z.enum(SECRET_FORMATS) }).strict(),
]);
export type SecretSpec = z.infer<typeof secretSpecSchema>;

export function secretKey(spec: SecretSpec): string {
  return typeof spec === 'string' ? spec : spec.key;
}

export function secretFormat(spec: SecretSpec): SecretFormat {
  return typeof spec === 'string' ? 'base64url' : spec.format;
}

export const DEPENDENCY_CHECKS = ['verify', 'skip'] as const;

export const verifySchema = z
  .object({
    /** The path Stage B probes for health (precedence 1). Defaults to the manifest's health path. */
    healthPath: z.string().min(1).optional(),
    /** The path that must return an application-generated response. Default `/`. */
    appPath: z.string().min(1).optional(),
    /** Acceptable status codes on `appPath`. Default: any non-5xx. */
    appStatus: z.array(z.number().int().min(100).max(599)).min(1).optional(),
    /** How long the healthy state must hold before PASS. Default 180. */
    observationSeconds: z.number().int().min(30).max(900).optional(),
  })
  .strict();

export const dependenciesSchema = z
  .object({
    postgres: z.enum(DEPENDENCY_CHECKS).optional(),
    redis: z.enum(DEPENDENCY_CHECKS).optional(),
    storage: z.enum(DEPENDENCY_CHECKS).optional(),
  })
  .strict();

export const repositoryConfigSchema = z
  .object({
    id: z.string().regex(ENTRY_ID_REGEX),
    /** The fork the vendor GitHub App installation can read. Default `instashop-dev/<repo>`. */
    fork: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/)
      .optional(),
    overrides: vendorOverridesSchema.optional(),
    config: z.array(configValueSchema).optional(),
    /** Secret keys the harness generates at run time (never values). */
    secrets: z.array(secretSpecSchema).optional(),
    verify: verifySchema.optional(),
    dependencies: dependenciesSchema.optional(),
    /** Registry findings (findings.md) that explain this entry's known outcome. */
    findings: z.array(z.string().regex(/^DEPLOY-\d{3}$/)).default([]),
    notes: z.array(z.string()).default([]),
  })
  .strict();
export type RepositoryConfig = z.infer<typeof repositoryConfigSchema>;

export const deployConfigSchema = z
  .object({
    version: z.literal(1),
    /** Wave name → Stage A ids, in execution order. */
    waves: z.record(z.string().regex(WAVE_ID_REGEX), z.array(z.string().regex(ENTRY_ID_REGEX)).min(1)).default({}),
    repositories: z.array(repositoryConfigSchema).default([]),
  })
  .strict();
export type DeployConfig = z.infer<typeof deployConfigSchema>;

/**
 * Parse and cross-validate: unique repository ids, unique keys within an
 * entry's config, no key both configured and generated, unique ids within a
 * wave. Whether every id exists in the Stage A benchmark is checked by the
 * caller, which holds the benchmark.
 */
export function parseDeployConfig(text: string): DeployConfig {
  const config = deployConfigSchema.parse(parse(text) ?? {});
  const ids = new Set<string>();
  for (const entry of config.repositories) {
    if (ids.has(entry.id)) throw new Error(`duplicate repository config ${entry.id}`);
    ids.add(entry.id);
    const keys = new Set<string>();
    for (const value of entry.config ?? []) {
      if (keys.has(value.key)) throw new Error(`${entry.id} configures ${value.key} twice`);
      keys.add(value.key);
    }
    for (const secret of entry.secrets ?? []) {
      const key = secretKey(secret);
      if (keys.has(key)) throw new Error(`${entry.id} both configures and generates ${key}`);
      keys.add(key);
    }
  }
  for (const [wave, members] of Object.entries(config.waves)) {
    if (new Set(members).size !== members.length) throw new Error(`wave ${wave} lists a repository twice`);
  }
  return config;
}

export function loadDeployConfig(path: string): DeployConfig {
  return parseDeployConfig(readFileSync(path, 'utf8'));
}

/** The configuration for one Stage A entry — an empty one when nothing is configured. */
export function configFor(config: DeployConfig, id: string): RepositoryConfig {
  return config.repositories.find((entry) => entry.id === id) ?? { id, findings: [], notes: [] };
}

/** Every configuration key the harness will provide for an entry (values and generated secrets). */
export function providedKeys(entry: RepositoryConfig): string[] {
  return [...(entry.config ?? []).map((value) => value.key), ...(entry.secrets ?? []).map(secretKey)].sort();
}

/** The configuration keys whose value must carry the deployment's own address. */
export function appUrlKeys(entry: RepositoryConfig): string[] {
  return (entry.config ?? []).filter((value) => value.value.includes(APP_URL_TOKEN)).map((value) => value.key);
}
