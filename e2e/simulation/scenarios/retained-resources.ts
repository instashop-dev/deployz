import type { ScenarioDefinition } from '../types.js';
import { happyPath } from './happy-path.js';

/**
 * Lifecycle D2: install reaches HEALTHY, then DESTROY completes cleanly
 * (DELETE_COMPLETE) — the database and storage bucket are retained by their
 * CloudFormation retention policies, not by any special-cased simulation
 * here: `classifyResource` (packages/contracts/src/infrastructure.ts)
 * statically marks `AWS::RDS::DBInstance`/`AWS::S3::Bucket` as
 * `lifecyclePolicy: 'retain'` regardless of the actual delete outcome, and
 * `aggregateInfrastructureComponents` re-derives every persisted resource's
 * status from that policy once `deployment.state === 'DELETED'` — retain →
 * 'retained', delete → 'removed'. This scenario only needs a normal,
 * successful destroy for that already-real behaviour to surface.
 */
export const retainedResources: ScenarioDefinition = {
  ...happyPath,
  id: 'retained-resources',
  description:
    'Install reaches HEALTHY; DESTROY completes (DELETE_COMPLETE) while the database/storage stay retained.',
  destroy: {
    timeline: [
      {
        afterMs: 10,
        atVirtualMs: 0,
        logicalResourceId: '__stack__',
        resourceType: 'AWS::CloudFormation::Stack',
        status: 'DELETE_IN_PROGRESS',
      },
      {
        afterMs: 40,
        atVirtualMs: 60_000,
        logicalResourceId: '__stack__',
        resourceType: 'AWS::CloudFormation::Stack',
        status: 'DELETE_COMPLETE',
      },
    ],
    outcome: 'complete',
  },
};
