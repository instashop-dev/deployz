/**
 * Re-export barrel — the §10 rejection checks moved to `@deployz/analysis`
 * so they can be shared with `apps/api` (which cannot depend on
 * `@deployz/cdk` without a workspace cycle, since cdk already depends on
 * api). Every existing `packages/cdk` import of `./rejection.js` keeps
 * working unchanged.
 */
export type { RejectionFinding } from '@deployz/analysis';
export {
  checkRedis,
  checkMysql,
  checkMongo,
  checkElasticsearch,
  checkOtherUnsupportedDatabases,
} from '@deployz/analysis';
