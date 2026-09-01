import type { ScenarioDefinition } from '../types.js';
import { happyPath } from './happy-path.js';

/**
 * Lifecycle D2: install reaches HEALTHY, then DESTROY hits a stack-level
 * DELETE_FAILED with no resource-level DELETE_FAILED status to point at —
 * an intentionally rare "no attributable blocker" edge case. destroy.ts's
 * `settleDestroy` can only retry with `RetainResources` for a blocker it can
 * NAME; with none identifiable, and without `dataDeletionAuthorized` (the
 * default for a deployment that completed a real install, see
 * server.ts's destroy route), it fails outright rather than guessing.
 */
export const deleteFailure: ScenarioDefinition = {
  ...happyPath,
  id: 'delete-failure',
  description: 'Install reaches HEALTHY; DESTROY hits an unattributable stack-level DELETE_FAILED.',
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
        atVirtualMs: 30_000,
        logicalResourceId: '__stack__',
        resourceType: 'AWS::CloudFormation::Stack',
        status: 'DELETE_FAILED',
        statusReason: 'One or more resources could not be deleted.',
      },
    ],
    outcome: 'delete-failed',
  },
};
