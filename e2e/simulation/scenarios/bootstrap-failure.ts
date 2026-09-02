import type { ScenarioDefinition } from '../types.js';

/**
 * The bootstrap stack (the relay Lambda + its IAM role + its 5-minute
 * EventBridge schedule — `packages/cdk/src/bootstrap/bootstrap-stack.ts`)
 * fails to create in the customer's own account BEFORE the relay it would
 * have deployed ever runs. There is no relay to register, so this scenario
 * is never played back by a `SimulatedCustomerAccount` at all — the
 * `bootstrap-failure` test in e2e/scenario-provisioning.spec.ts sets
 * `deployzStartRelay: false` and never starts one. Registered here purely
 * so the scenario has a name and a documented shape, consistent with the
 * rest of the Phase 1 scenario list; the empty timeline is never read.
 */
export const bootstrapFailure: ScenarioDefinition = {
  id: 'bootstrap-failure',
  description:
    'The customer\'s bootstrap stack fails before the relay Lambda inside it ever registers — no relay, nothing to simulate.',
  finalStackStatus: 'CREATE_FAILED',
  redisRequired: false,
  timeline: [],
};
