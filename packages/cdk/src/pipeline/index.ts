export { BuildPipeline } from './build-pipeline.js';
export type { BuildPipelineProps } from './build-pipeline.js';

// The ECR pull-grant lifecycle moved to the control plane (@deployz/api) in
// Phase 1.1 — the customer account id is only known there. Re-exported so
// the historical @deployz/cdk surface keeps resolving.
export {
  ECR_PULL_ACTIONS,
  installationGrantSid,
  buildPullStatement,
  buildRepoPolicyDocument,
  grantPull,
  revokePull,
} from '@deployz/api/ecr-grants';
export type {
  EcrClient,
  EcrPolicy,
  EcrGrantStatement,
  GrantResult,
  RevokeResult,
} from '@deployz/api/ecr-grants';

export {
  fetchRepoArchive,
  needsStreaming,
  STREAMING_THRESHOLD_BYTES,
} from './source-fetch.js';
export type {
  FetchFn,
  FetchRepoArchiveResult,
  FetchRepoArchiveOptions,
} from './source-fetch.js';