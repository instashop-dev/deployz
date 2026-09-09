import { describe, expect, it } from 'vitest';

import {
  deploymentBillingLabel,
  isTestDeployment,
  nextProductionDeploymentCopy,
  nextProductionDeploymentImpact,
} from '@/lib/deployment-billing';

// Paddle migration Phase 11 — what a vendor is told a deployment costs. The
// label reads the deployment's own billing state, never its health: that
// separation is the whole reason billing_state exists apart from §46 state.
// With included production deployments the allowance is pooled, so no label
// ever names a per-deployment price.
describe('deploymentBillingLabel', () => {
  it('a test deployment is always free, whatever its billing state says', () => {
    for (const billingState of ['NOT_STARTED', 'ACTIVE', 'STOPPED'] as const) {
      expect(deploymentBillingLabel({ deploymentType: 'TEST', billingState })).toBe(
        'Free test deployment',
      );
    }
  });

  it('a live production deployment counts toward the pooled total — never "$19"', () => {
    const label = deploymentBillingLabel({ deploymentType: 'PRODUCTION', billingState: 'ACTIVE' });
    expect(label).toBe('Counts toward your production deployment total');
    expect(label).not.toMatch(/\$/);
  });

  it('a production deployment that never went live counts only once live', () => {
    expect(
      deploymentBillingLabel({ deploymentType: 'PRODUCTION', billingState: 'NOT_STARTED' }),
    ).toBe('Counts toward your production deployment total once live');
  });

  it('a removed production deployment no longer counts', () => {
    expect(deploymentBillingLabel({ deploymentType: 'PRODUCTION', billingState: 'STOPPED' })).toBe(
      'No longer counts toward your production deployment total',
    );
  });
});

describe('isTestDeployment', () => {
  it('is true only for TEST', () => {
    expect(isTestDeployment({ deploymentType: 'TEST', billingState: 'NOT_STARTED' })).toBe(true);
    expect(isTestDeployment({ deploymentType: 'PRODUCTION', billingState: 'ACTIVE' })).toBe(false);
  });
});

describe('nextProductionDeploymentImpact', () => {
  it('below the allowance the next deployment adds no charge', () => {
    expect(nextProductionDeploymentImpact({ active: 2, included: 3, billable: 0 })).toEqual({
      activeAfter: 3,
      included: 3,
      billedAfter: 0,
      addsCharge: false,
    });
  });

  it('at the allowance the next deployment is the first billed one', () => {
    expect(nextProductionDeploymentImpact({ active: 3, included: 3, billable: 0 })).toEqual({
      activeAfter: 4,
      included: 3,
      billedAfter: 1,
      addsCharge: true,
    });
  });

  it('with no allowance every deployment adds a charge', () => {
    expect(nextProductionDeploymentImpact({ active: 0, included: 0, billable: 0 })).toMatchObject({
      billedAfter: 1,
      addsCharge: true,
    });
  });
});

describe('nextProductionDeploymentCopy', () => {
  it('a subscribed org with no allowance hears the plain price', () => {
    expect(nextProductionDeploymentCopy(true, { active: 4, included: 0, billable: 4 })).toBe(
      'This adds $19/month once the deployment is live.',
    );
  });

  it('falls back to the price while the counts are unknown', () => {
    expect(nextProductionDeploymentCopy(true, null)).toBe('This adds $19/month once the deployment is live.');
    expect(nextProductionDeploymentCopy(false, null)).toMatch(/starts your subscription: \$49\/month/);
  });

  it('a covered deployment says so, with the counts after it goes live', () => {
    expect(nextProductionDeploymentCopy(true, { active: 2, included: 3, billable: 0 })).toBe(
      'After this deployment goes live: 3 active, 3 included, 0 billed. This deployment is covered by your included allowance and adds no deployment charge.',
    );
  });

  it('the first deployment beyond the allowance names the charge', () => {
    expect(nextProductionDeploymentCopy(true, { active: 3, included: 3, billable: 0 })).toBe(
      'After this deployment goes live: 4 active, 3 included, 1 billed at $19/month. This deployment counts toward your production deployment total once it is live.',
    );
  });

  it('an unsubscribed org with an allowance still starts the $49 platform subscription', () => {
    const copy = nextProductionDeploymentCopy(false, { active: 0, included: 2, billable: 0 });
    expect(copy).toMatch(/starts your subscription: \$49\/month for the platform/);
    expect(copy).toMatch(/2 production deployments are included with your account/);
    expect(copy).toMatch(/adds no deployment charge/);
    expect(copy).toMatch(/Starting monthly rate: \$49\/month/);
  });
});
