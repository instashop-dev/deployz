/**
 * Re-export barrel — the §18 detectors moved to `@deployz/analysis` so they
 * can be shared with `apps/api` (which cannot depend on `@deployz/cdk`
 * without a workspace cycle, since cdk already depends on api). Every
 * existing `packages/cdk` import of `./detectors.js` keeps working unchanged.
 */
export type { FileTree, DetectorFinding } from '@deployz/analysis';
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
} from '@deployz/analysis';
