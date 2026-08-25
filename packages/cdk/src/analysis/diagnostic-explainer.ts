/**
 * Re-export barrel — the §16/§20 diagnostic explanation layer moved to
 * `@deployz/analysis` so `apps/api` can call it from the diagnostics route.
 * `@deployz/cdk` depends on `@deployz/api`, so the API could not import it
 * from here without closing a dependency cycle.
 */

export type {
  DiagnosticExplainOptions,
  DiagnosticExplanation,
} from '@deployz/analysis';
export {
  buildDiagnosticPrompt,
  diagnosticExplanationSchema,
  explainDiagnostic,
} from '@deployz/analysis';
