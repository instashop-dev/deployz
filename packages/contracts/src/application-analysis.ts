import { z } from 'zod';

import { manifestEnvVariableSchema } from './manifest.js';

// ---------------------------------------------------------------------------
// Canonical application analysis (AI MVP Phase 1).
//
// The typed projection of what Deployz understands about an application:
// every fact carries its normalized value, where the value came from, how
// sure the analyser is, and the concise evidence behind it. It is built once
// per analysis from the same detector output that feeds the flat
// `detected_metadata` keys and the deployment manifest, persisted beside them
// as `detected_metadata.application`, and served on the readiness endpoint.
// It never replaces the manifest: the manifest is the deployment contract,
// this is the explanation.
// ---------------------------------------------------------------------------

/** Where a fact's value was read from. */
export const factSourceSchema = z.enum([
  'dockerfile',
  'package-manifest',
  'compose',
  'env-file',
  'procfile',
  'source',
  'ai',
  'none',
]);
export type FactSource = z.infer<typeof factSourceSchema>;

/** Mirrors the readiness report's finding confidence vocabulary. */
export const factConfidenceSchema = z.enum(['confirmed', 'likely', 'needs_confirmation']);
export type FactConfidence = z.infer<typeof factConfidenceSchema>;

/** One concise piece of evidence — never a source-code dump. */
export const analysisEvidenceSchema = z
  .object({
    file: z.string().min(1).optional(),
    reason: z.string().min(1),
  })
  .strict();
export type AnalysisEvidence = z.infer<typeof analysisEvidenceSchema>;

function fact<T extends z.ZodTypeAny>(value: T) {
  return z
    .object({
      value,
      source: factSourceSchema,
      confidence: factConfidenceSchema,
      evidence: z.array(analysisEvidenceSchema),
    })
    .strict();
}

export const runtimeFamilySchema = z.enum([
  'node',
  'python',
  'ruby',
  'go',
  'jvm',
  'dotnet',
  'php',
  'elixir',
  'rust',
  'unknown',
]);
export type RuntimeFamily = z.infer<typeof runtimeFamilySchema>;

export const applicationAnalysisSchema = z
  .object({
    analysisVersion: z.number().int().positive(),
    runtime: fact(runtimeFamilySchema),
    framework: fact(z.string().min(1).nullable()),
    build: fact(z.string().min(1).nullable()),
    start: fact(z.string().min(1).nullable()),
    network: z
      .object({
        port: fact(z.number().int().positive().nullable()),
        /** `localhost` when the server binds only to a loopback address. */
        bindAddress: fact(z.enum(['all-interfaces', 'localhost']).nullable()),
      })
      .strict(),
    database: z
      .object({
        required: z.boolean(),
        type: z.enum(['postgres', 'unsupported', 'none']),
        confidence: factConfidenceSchema,
        evidence: z.array(analysisEvidenceSchema),
      })
      .strict(),
    redis: z
      .object({
        required: z.boolean(),
        detected: z.boolean(),
        supported: z.boolean(),
        confidence: factConfidenceSchema,
        purposes: z.array(z.string()),
        evidence: z.array(analysisEvidenceSchema),
      })
      .strict(),
    storage: z
      .object({
        /** Durable local filesystem state the app declares (unsupported at MVP). */
        persistentLocalRequired: z.boolean(),
        objectStorageDetected: z.boolean(),
        evidence: z.array(analysisEvidenceSchema),
      })
      .strict(),
    healthCheck: z
      .object({
        detected: z.boolean(),
        path: z.string().min(1).nullable(),
        confidence: factConfidenceSchema,
        evidence: z.array(analysisEvidenceSchema),
      })
      .strict(),
    migrations: z
      .object({
        detected: z.boolean(),
        /** The deploy-safe command Deployz runs, when one resolved. */
        command: z.string().min(1).nullable(),
        tools: z.array(z.string()),
        evidence: z.array(analysisEvidenceSchema),
      })
      .strict(),
    environmentVariables: z.array(manifestEnvVariableSchema),
  })
  .strict();
export type ApplicationAnalysis = z.infer<typeof applicationAnalysisSchema>;
