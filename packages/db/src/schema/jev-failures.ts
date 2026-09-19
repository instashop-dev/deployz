import { boolean, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { createdAt, id } from './common.js';

// Jev UNKNOWN-failure shadow classifications — append-only telemetry for the
// shadow-mode failure-domain experiment. One row per shadow run, written
// fire-and-forget AFTER a job settles with effective failure code UNKNOWN
// (deterministic refinement and every known signature stay untouched). Like
// event_logs, no foreign keys by design: telemetry must survive the deletion
// of the rows it references, and nothing in the failure flow ever reads it.
export const jevFailureClassifications = pgTable('jev_failure_classifications', {
  id: id(),
  deploymentId: uuid('deployment_id').notNull(),
  jobId: uuid('job_id').notNull(),
  deploymentStage: text('deployment_stage').notNull(),
  evidenceSchemaVersion: integer('evidence_schema_version').notNull(),
  decisionSetVersion: integer('decision_set_version').notNull(),
  deployzFailureCode: text('deployz_failure_code').notNull(),
  // Null on any failure path (JevError or internal) — the error columns carry it.
  classification: jsonb('classification').$type<Record<string, unknown>>(),
  ok: boolean('ok').notNull(),
  errorKind: text('error_kind'),
  latencyMs: integer('latency_ms'),
  model: text('model'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  createdAt: createdAt(),
});
