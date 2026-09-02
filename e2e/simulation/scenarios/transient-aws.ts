import type { ScenarioDefinition } from '../types.js';
import { happyPath } from './happy-path.js';

/**
 * Resilience: the install succeeds exactly like happy-path, but the first
 * two post-create DescribeStacks polls answer as unreadable — how the real
 * relay client surfaces a throttled/timed-out describe. The INSTALL wait
 * loop must ride these out (its UNREADABLE_POLLS_BEFORE_FAILING budget is
 * three consecutive misses) and still finish HEALTHY, never failing a live
 * install over a transient AWS error.
 */
export const transientAws: ScenarioDefinition = {
  ...happyPath,
  id: 'transient-aws',
  description:
    'Install succeeds despite the first two DescribeStacks polls answering as unreadable (throttled/timed out).',
  transientDescribeFailures: 2,
};
