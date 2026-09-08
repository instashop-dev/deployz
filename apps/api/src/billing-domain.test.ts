import { describe, expect, it } from 'vitest';

import {
  applyBillingTransition,
  billableDeploymentQuantity,
  countBillableDeployments,
  productionDeploymentCounts,
  isBillableDeployment,
  DEPLOYMENT_PRICE_DOLLARS,
  PLATFORM_PRICE_DOLLARS,
} from './billing-domain.js';

// ── applyBillingTransition ───────────────────────────────────────────────

const now = new Date('2026-09-01T00:00:00.000Z');

describe('applyBillingTransition', () => {
  // Rule 1: TEST deployments never become billable.
  it('a TEST deployment ignores LIVE', () => {
    expect(
      applyBillingTransition({ deploymentType: 'TEST', billingState: 'NOT_STARTED' }, 'LIVE', now),
    ).toBeNull();
  });

  it('a TEST deployment ignores REMOVED', () => {
    expect(
      applyBillingTransition({ deploymentType: 'TEST', billingState: 'NOT_STARTED' }, 'REMOVED', now),
    ).toBeNull();
  });

  // Rule 2: PRODUCTION + NOT_STARTED + LIVE -> ACTIVE.
  it('a PRODUCTION deployment activates on its first LIVE event', () => {
    expect(
      applyBillingTransition({ deploymentType: 'PRODUCTION', billingState: 'NOT_STARTED' }, 'LIVE', now),
    ).toEqual({ billingState: 'ACTIVE', billingStartedAt: now });
  });

  // Rule 3: ACTIVE ignores every health/state change — expressed here as no
  // function taking `state` at all, so a second LIVE on ACTIVE is the only
  // way to probe it, and it must be a no-op (rule 5 covers the exact case).

  // Rule 4: PRODUCTION + not STOPPED + REMOVED -> STOPPED.
  it('an ACTIVE PRODUCTION deployment stops on REMOVED', () => {
    expect(
      applyBillingTransition({ deploymentType: 'PRODUCTION', billingState: 'ACTIVE' }, 'REMOVED', now),
    ).toEqual({ billingState: 'STOPPED', billingStoppedAt: now });
  });

  it('a never-live PRODUCTION deployment also stops on REMOVED, so it can never activate later', () => {
    expect(
      applyBillingTransition({ deploymentType: 'PRODUCTION', billingState: 'NOT_STARTED' }, 'REMOVED', now),
    ).toEqual({ billingState: 'STOPPED', billingStoppedAt: now });
  });

  // Rule 5: STOPPED is terminal; timestamps are write-once.
  it('LIVE after STOPPED is a no-op', () => {
    expect(
      applyBillingTransition({ deploymentType: 'PRODUCTION', billingState: 'STOPPED' }, 'LIVE', now),
    ).toBeNull();
  });

  it('REMOVED on an already-STOPPED deployment is a no-op', () => {
    expect(
      applyBillingTransition({ deploymentType: 'PRODUCTION', billingState: 'STOPPED' }, 'REMOVED', now),
    ).toBeNull();
  });

  it('a second LIVE on an ACTIVE deployment is a no-op — timestamps are write-once', () => {
    expect(
      applyBillingTransition({ deploymentType: 'PRODUCTION', billingState: 'ACTIVE' }, 'LIVE', now),
    ).toBeNull();
  });

  // "ACTIVE stays ACTIVE when nothing but health changes": the structural
  // guarantee is that no transition function accepts `state` at all, so a
  // health/rollback/recovery change cannot even be expressed as an input —
  // only LIVE and REMOVED exist, and LIVE on ACTIVE is already a no-op above.
});

describe('isBillableDeployment', () => {
  it('is true only for PRODUCTION + ACTIVE', () => {
    expect(isBillableDeployment({ deploymentType: 'PRODUCTION', billingState: 'ACTIVE' })).toBe(true);
  });

  it('is false for TEST + ACTIVE (never reachable, but the predicate itself must not bill it)', () => {
    expect(isBillableDeployment({ deploymentType: 'TEST', billingState: 'ACTIVE' })).toBe(false);
  });

  it('is false for PRODUCTION + NOT_STARTED', () => {
    expect(isBillableDeployment({ deploymentType: 'PRODUCTION', billingState: 'NOT_STARTED' })).toBe(false);
  });

  it('is false for PRODUCTION + STOPPED', () => {
    expect(isBillableDeployment({ deploymentType: 'PRODUCTION', billingState: 'STOPPED' })).toBe(false);
  });
});

describe('countBillableDeployments', () => {
  it('counts only the billable rows', () => {
    const rows = [
      { deploymentType: 'PRODUCTION', billingState: 'ACTIVE' },
      { deploymentType: 'PRODUCTION', billingState: 'NOT_STARTED' },
      { deploymentType: 'PRODUCTION', billingState: 'STOPPED' },
      { deploymentType: 'TEST', billingState: 'NOT_STARTED' },
      { deploymentType: 'PRODUCTION', billingState: 'ACTIVE' },
    ] as const;
    expect(countBillableDeployments(rows)).toBe(2);
  });

  it('is 0 for an empty list', () => {
    expect(countBillableDeployments([])).toBe(0);
  });
});

describe('billableDeploymentQuantity (included production deployments)', () => {
  it('is the active count when nothing is included — the pre-allowance behavior', () => {
    expect(billableDeploymentQuantity(5, 0)).toBe(5);
    expect(billableDeploymentQuantity(0, 0)).toBe(0);
  });

  it('subtracts the pooled allowance', () => {
    expect(billableDeploymentQuantity(5, 2)).toBe(3);
  });

  it('is 0 when active equals the allowance', () => {
    expect(billableDeploymentQuantity(3, 3)).toBe(0);
  });

  it('never goes negative when the allowance exceeds the active count', () => {
    expect(billableDeploymentQuantity(1, 3)).toBe(0);
    expect(billableDeploymentQuantity(0, 10000)).toBe(0);
  });

  it('crosses the threshold one deployment at a time', () => {
    expect([0, 1, 2, 3, 4].map((active) => billableDeploymentQuantity(active, 2))).toEqual([0, 0, 0, 1, 2]);
  });
});

describe('productionDeploymentCounts', () => {
  it('reports active, included and billable from the rows and the allowance', () => {
    const rows = [
      { deploymentType: 'PRODUCTION', billingState: 'ACTIVE' },
      { deploymentType: 'PRODUCTION', billingState: 'ACTIVE' },
      { deploymentType: 'PRODUCTION', billingState: 'ACTIVE' },
      { deploymentType: 'PRODUCTION', billingState: 'NOT_STARTED' },
      { deploymentType: 'TEST', billingState: 'ACTIVE' },
    ] as const;
    expect(productionDeploymentCounts(rows, 2)).toEqual({ active: 3, included: 2, billable: 1 });
  });

  it('a TEST deployment never consumes the allowance', () => {
    const rows = [
      { deploymentType: 'TEST', billingState: 'ACTIVE' },
      { deploymentType: 'TEST', billingState: 'NOT_STARTED' },
    ] as const;
    expect(productionDeploymentCounts(rows, 1)).toEqual({ active: 0, included: 1, billable: 0 });
  });
});

describe('display prices', () => {
  it('keeps the display-only platform and per-deployment prices', () => {
    expect(PLATFORM_PRICE_DOLLARS).toBe(49);
    expect(DEPLOYMENT_PRICE_DOLLARS).toBe(19);
  });
});
