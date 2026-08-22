/**
 * @deployz/analysis — the pure, deterministic §18/§19/§20 repository analysis
 * core: file-tree detectors, §10 rejection checks, the analyser orchestrator,
 * and the §19 compatibility rules engine.
 *
 * This package has ZERO dependencies on the rest of the monorepo (aside from
 * a test-only devDependency on @deployz/db for enum-drift assertions) so it
 * can be safely imported by BOTH @deployz/cdk and @deployz/api without
 * creating a workspace dependency cycle (cdk already depends on api).
 */

export type { FileTree, DetectorFinding } from './detectors.js';
export {
  detectDockerfile,
  detectFramework,
  detectPort,
  detectHealthEndpoint,
  detectEnvVars,
  detectPostgresql,
  detectLocalFilesystem,
  detectWorker,
  detectS3,
  detectMigrationCommand,
  detectStartupCommand,
  detectExternalServices,
} from './detectors.js';

export type { RejectionFinding } from './rejection.js';
export {
  checkRedis,
  checkMysql,
  checkMongo,
  checkElasticsearch,
  checkOtherUnsupportedDatabases,
} from './rejection.js';

export type { AnalysisResult } from './analyser.js';
export { analyseRepo } from './analyser.js';

export type {
  CompatibilityVerdict,
  IssueSeverity,
  CompatibilityIssue,
  CompatibilityResult,
  PersistedVerdict,
  VerdictStore,
} from './rules.js';
export { evaluateCompatibility, persistVerdict } from './rules.js';
