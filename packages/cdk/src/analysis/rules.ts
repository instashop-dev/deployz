/**
 * Re-export barrel — the §19 compatibility rules engine moved to
 * `@deployz/analysis` so it can be shared with `apps/api` (which cannot
 * depend on `@deployz/cdk` without a workspace cycle, since cdk already
 * depends on api). Every existing `packages/cdk` import of `./rules.js`
 * keeps working unchanged.
 */
export type {
  CompatibilityVerdict,
  IssueSeverity,
  CompatibilityIssue,
  CompatibilityResult,
  PersistedVerdict,
  VerdictStore,
} from '@deployz/analysis';
export { evaluateCompatibility, persistVerdict } from '@deployz/analysis';
