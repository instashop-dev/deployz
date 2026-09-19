import { boolean, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { createdAt, id } from './common.js';
import { applications } from './core.js';

// Jev requirements/plan shadow verifications — append-only telemetry for the
// shadow-mode decision experiment. One row per shadow run: which evidence was
// asked about (fingerprint + schema versions), what Deployz would provision,
// and what Jev answered (or how the call failed). Nothing in the deployment
// flow reads it; the analysis flow writes it fire-and-forget, and a failure
// to write it never fails the analysis.
export const jevShadowVerifications = pgTable('jev_shadow_verifications', {
  id: id(),
  applicationId: uuid('application_id')
    .notNull()
    .references(() => applications.id),
  analysisCommitSha: text('analysis_commit_sha').notNull(),
  evidenceSchemaVersion: integer('evidence_schema_version').notNull(),
  decisionSetVersion: integer('decision_set_version').notNull(),
  evidenceFingerprint: text('evidence_fingerprint').notNull(),
  // The Deployz side of the comparison: the manifest's own requirement booleans.
  deployzRequirements: jsonb('deployz_requirements')
    .$type<{ postgres: boolean; redisRequired: boolean; storageRequired: boolean }>()
    .notNull(),
  // Null on any failure path (JevError or internal) — the error columns carry it.
  jevResult: jsonb('jev_result').$type<Record<string, unknown>>(),
  ok: boolean('ok').notNull(),
  errorKind: text('error_kind'),
  latencyMs: integer('latency_ms'),
  model: text('model'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  createdAt: createdAt(),
});
