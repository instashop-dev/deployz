import { z } from 'zod';

// ---------------------------------------------------------------------------
// Canonical deployment manifest (Phase 2 boundary).
//
// The typed, authoritative deployment contract derived from detector output
// + vendor overrides (packages/analysis/src/manifest.ts) and persisted on
// `deployments.desired_state.manifest` at deployment creation. The relay's
// INSTALL/DEPLOY_RELEASE/ROLLBACK execution reads from it, so a deployment
// keeps the exact config it was created with even if the application's
// analysis or overrides change afterwards.
//
// Every field is deliberately narrow: nullable where a detector can honestly
// miss a value, so the manifest can represent a config-incomplete app and the
// readiness evaluator can say WHY instead of failing to build one.
// ---------------------------------------------------------------------------

/** One env var a provisioned dependency is injected as. */
export const manifestEnvBindingSchema = z
  .object({
    name: z.string().min(1),
    kind: z.enum(['url', 'host', 'port', 'bucket']),
  })
  .strict();
export type ManifestEnvBinding = z.infer<typeof manifestEnvBindingSchema>;

/**
 * One env var the application reads (§11.2 Phase 7 model). Replaces the
 * Phase 2 name-list: `required`/`secret` are only ever true when detection
 * has honest evidence (a documented sample value missing, a bare read with no
 * default, a well-known service credential), and `source` names that evidence
 * so the vendor can see WHY a variable is flagged.
 */
export const manifestEnvVariableSchema = z
  .object({
    key: z.string().min(1),
    /** The app has no default and Deployz will not inject a value — the vendor must supply one. */
    required: z.boolean(),
    /** Name/convention evidence says the value is a credential (never a value). */
    secret: z.boolean(),
    /** Evidence strings: file paths, reads, or service detections that produced this entry. */
    source: z.array(z.string()),
  })
  .strict();
export type ManifestEnvVariable = z.infer<typeof manifestEnvVariableSchema>;

export const deploymentManifestSchema = z
  .object({
    application: z
      .object({
        /** Repository path the app lives in (e.g. `.`, `apps/web`). */
        root: z.string().min(1),
        /** Runtime family ('node' today; 'unknown' when undetectable). */
        runtime: z.string().min(1),
        /** Detected framework, when any (e.g. 'express', 'next'). */
        framework: z.string().nullable(),
        /** Path to the build Dockerfile, or null when none was found. */
        dockerfilePath: z.string().min(1).nullable(),
      })
      .strict(),
    build: z
      .object({
        /** Image build command (e.g. `npm run build`), when one was found. */
        command: z.string().nullable(),
        /** Build context directory — usually the app root. */
        context: z.string().min(1),
      })
      .strict(),
    web: z
      .object({
        /** Process start command (Dockerfile CMD / `start` script), or null. */
        command: z.string().nullable(),
        /** TCP port the app listens on, or null when undetected. */
        port: z.number().int().nullable(),
      })
      .strict(),
    health: z
      .object({
        /** ALB/container health-check path. Defaults to `/health`. */
        path: z.string().min(1),
      })
      .strict(),
    database: z
      .object({
        /** Whether Deployz provisions a managed PostgreSQL instance. */
        postgres: z.boolean(),
      })
      .strict(),
    redis: z
      .object({
        required: z.boolean(),
        /** Env vars injected pointing at the provisioned cache. */
        envBindings: z.array(manifestEnvBindingSchema),
      })
      .strict(),
    storage: z
      .object({
        required: z.boolean(),
        /** Env vars injected naming the provisioned bucket. */
        envBindings: z.array(manifestEnvBindingSchema),
      })
      .strict(),
    migration: z
      .object({
        /** Unattended migration command run on deploy, or null. */
        command: z.string().nullable(),
      })
      .strict(),
    worker: z
      .object({
        /** Worker process start command, or null when the app has no worker. */
        command: z.string().nullable(),
      })
      .strict(),
    environment: z
      .object({
        /**
         * The env vars the app reads, for the config surface. Phase 7 model:
         * each entry carries required/secret/source (§11.2) — a plain
         * name-list could not express that a missing required value needs
         * configuration before provisioning.
         */
        variables: z.array(manifestEnvVariableSchema),
      })
      .strict(),
    /** External (non-Deployz) services the app integrates with. Informational. */
    externalServices: z.array(z.string()),
    /** Why the app is not compatible with Deployz hosting, when it isn't. */
    unsupported: z.array(z.string()),
  })
  .strict();
export type DeploymentManifest = z.infer<typeof deploymentManifestSchema>;

/**
 * The vendor-correctable manifest inputs — mirrors PATCH /api/applications/:id.
 * Nullish so an absent override reads as "let detection decide". Values that
 * live on applications columns (port, health/migration/worker commands, the
 * boolean requirements) arrive from there; the five manifest-only paths
 * (app root, Dockerfile, build context/command, start command) arrive from
 * `detected_metadata.manifestOverrides`.
 */
export const deploymentManifestOverridesSchema = z
  .object({
    appRoot: z.string().nullish(),
    dockerfilePath: z.string().nullish(),
    buildContext: z.string().nullish(),
    buildCommand: z.string().nullish(),
    startCommand: z.string().nullish(),
    port: z.number().int().nullish(),
    healthPath: z.string().nullish(),
    migrationCommand: z.string().nullish(),
    workerCommand: z.string().nullish(),
    databaseRequired: z.boolean().optional(),
    storageRequired: z.boolean().optional(),
    redisRequired: z.boolean().optional(),
  })
  .strict();
export type DeploymentManifestOverrides = z.infer<typeof deploymentManifestOverridesSchema>;

// ── Readiness gate output (evaluated from the FINAL manifest) ──────────────

export const manifestReadinessStateSchema = z.enum([
  'READY',
  'NEEDS_CONFIGURATION',
  'NOT_COMPATIBLE',
]);
export type ManifestReadinessState = z.infer<typeof manifestReadinessStateSchema>;

export const manifestReadinessFindingSchema = z
  .object({
    /** Stable machine id, e.g. 'dockerfile-missing'. */
    id: z.string().min(1),
    /** Coarse grouping, e.g. 'container', 'compatibility'. */
    category: z.string().min(1),
    severity: z.enum(['error', 'warning']),
    message: z.string().min(1),
  })
  .strict();
export type ManifestReadinessFinding = z.infer<typeof manifestReadinessFindingSchema>;

export const manifestReadinessResultSchema = z
  .object({
    state: manifestReadinessStateSchema,
    findings: z.array(manifestReadinessFindingSchema),
  })
  .strict();
export type ManifestReadinessResult = z.infer<typeof manifestReadinessResultSchema>;