/**
 * Re-export barrel — the analyser orchestrator moved to `@deployz/analysis`
 * so it can be shared with `apps/api` (which cannot depend on
 * `@deployz/cdk` without a workspace cycle, since cdk already depends on
 * api). Every existing `packages/cdk` import of `./analyser.js` keeps
 * working unchanged.
 */
export type { AnalysisResult } from '@deployz/analysis';
export { analyseRepo } from '@deployz/analysis';
