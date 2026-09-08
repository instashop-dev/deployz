import { describe, expect, it } from 'vitest';

import { deploymentBillingLabel, isTestDeployment } from '@/lib/deployment-billing';

// Paddle migration Phase 11 — what a vendor is told a deployment costs. The
// label reads the deployment's own billing state, never its health: that
// separation is the whole reason billing_state exists apart from §46 state.
describe('deploymentBillingLabel', () => {
  it('a test deployment is always free, whatever its billing state says', () => {
    for (const billingState of ['NOT_STARTED', 'ACTIVE', 'STOPPED'] as const) {
      expect(deploymentBillingLabel({ deploymentType: 'TEST', billingState })).toBe(
        'Free test deployment',
      );
    }
  });

  it('a live production deployment costs $19/month', () => {
    expect(deploymentBillingLabel({ deploymentType: 'PRODUCTION', billingState: 'ACTIVE' })).toBe(
      '$19/month',
    );
  });

  it('a production deployment that never went live is not billed yet', () => {
    expect(
      deploymentBillingLabel({ deploymentType: 'PRODUCTION', billingState: 'NOT_STARTED' }),
    ).toBe('Not billed until live — then $19/month');
  });

  it('a removed production deployment reads as stopped, not as a charge', () => {
    expect(deploymentBillingLabel({ deploymentType: 'PRODUCTION', billingState: 'STOPPED' })).toBe(
      'Billing stopped',
    );
  });
});

describe('isTestDeployment', () => {
  it('is true only for TEST', () => {
    expect(isTestDeployment({ deploymentType: 'TEST', billingState: 'NOT_STARTED' })).toBe(true);
    expect(isTestDeployment({ deploymentType: 'PRODUCTION', billingState: 'ACTIVE' })).toBe(false);
  });
});
