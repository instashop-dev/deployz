import type { ScenarioDefinition } from '../types.js';
import { retainedResources } from './retained-resources.js';

/**
 * Lifecycle D2 extension of `retained-resources`: the same clean destroy
 * (DELETE_COMPLETE; database/storage retained by CloudFormation policy), but
 * the PURGE that follows finds one tag-owned orphan — an S3 bucket left
 * behind — that will not delete. settlePurge's S3 phase (packages/relay/src/
 * purge.ts) calls `deleteBucket` with no surrounding try/catch, so the
 * thrown error propagates out of `settlePurge` and `createPurgeExecutor`'s
 * own try/catch reports the job FAILED (`AWS_PERMISSION_DENIED`) instead of
 * a clean purge — proving the control plane records `cleanupState:
 * PURGE_FAILED` (never `COMPLETE`) and names the leftover, rather than
 * claiming a clean purge that did not happen.
 */
export const purgeFailure: ScenarioDefinition = {
  ...retainedResources,
  id: 'purge-failure',
  description:
    'Install reaches HEALTHY; DESTROY completes cleanly; PURGE finds one orphaned S3 bucket it cannot delete.',
  purge: {
    undeletableBucket: {
      bucketName: 'deployz-e2e-orphan-bucket',
      failureReason: 'BucketNotEmpty: The bucket you tried to delete is not empty',
    },
  },
};
