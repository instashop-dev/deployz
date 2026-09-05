// Environment plan (AI MVP Phase 4) — what Deployz configures automatically
// and what the vendor must provide, derived from the analysis's classified
// env-var model and the values already saved for one scope. Pure; the config
// screen renders it above the forms. §65: plain words, never a value.

import type { DetectedApplication } from '@/lib/readiness';

export type EnvVariableClassification =
  | 'deployz_managed'
  | 'deployz_generated'
  | 'customer_required'
  | 'optional'
  | 'unknown';

export interface EnvPlanRow {
  key: string;
  classification: EnvVariableClassification;
  /** One short line of why, in plain words. */
  reason: string;
  /** For customer-required and optional variables: a value is saved for this scope. */
  provided: boolean;
  secret: boolean;
}

export interface EnvPlan {
  /** Deployz-managed and Deployz-generated variables, in that order. */
  automatic: EnvPlanRow[];
  /** Customer-required variables, missing first. */
  required: EnvPlanRow[];
  /** Optional and unknown variables. */
  optional: EnvPlanRow[];
}

const REASONS: Record<EnvVariableClassification, string> = {
  deployz_managed: 'Set at installation',
  deployz_generated: 'Generated securely for each deployment',
  customer_required: 'Required — no default in the repository',
  optional: 'Read with a default',
  unknown: 'Listed in a sample file, not read by the code',
};

/**
 * Build the plan. Variables without a classification (analysed before Phase 4)
 * fall back on `required`: required ones are customer-required, the rest
 * optional — never silently "automatic".
 */
export function buildEnvPlan(
  variables: DetectedApplication['environmentVariables'],
  providedKeys: readonly string[],
): EnvPlan {
  const provided = new Set(providedKeys);
  const rows: EnvPlanRow[] = variables.map((variable) => {
    const classification: EnvVariableClassification =
      variable.classification ?? (variable.required ? 'customer_required' : 'optional');
    return {
      key: variable.key,
      classification,
      reason: REASONS[classification],
      provided: provided.has(variable.key),
      secret: variable.secret,
    };
  });
  const byClass = (...classes: EnvVariableClassification[]) =>
    classes.flatMap((wanted) => rows.filter((row) => row.classification === wanted));
  return {
    automatic: byClass('deployz_managed', 'deployz_generated'),
    required: byClass('customer_required').sort((a, b) => Number(a.provided) - Number(b.provided)),
    optional: byClass('optional', 'unknown'),
  };
}

/** "2 of 3 required values provided" / "All required values provided". */
export function envPlanSummary(plan: EnvPlan): string {
  if (plan.required.length === 0) return 'Nothing for you to provide — Deployz configures every variable.';
  const provided = plan.required.filter((row) => row.provided).length;
  if (provided === plan.required.length) return 'All required values provided.';
  return `${provided} of ${plan.required.length} required ${plan.required.length === 1 ? 'value' : 'values'} provided.`;
}
