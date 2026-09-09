import { describe, expect, it } from 'vitest';

import { previewIncludedDeploymentsChange } from '@/lib/admin-billing';

// The Team Admin allowance editor's preview math — mirrors the API's own
// max(active - included, 0) formula so the confirmation dialog can show the
// billable-quantity effect before the request is sent.
describe('previewIncludedDeploymentsChange', () => {
  it('raising the allowance reduces billable and reports an increase', () => {
    expect(
      previewIncludedDeploymentsChange({
        activeProductionDeployments: 5,
        currentIncluded: 1,
        nextIncluded: 3,
      }),
    ).toEqual({ previousBillable: 4, nextBillable: 2, direction: 'increase' });
  });

  it('lowering the allowance raises billable and reports a decrease', () => {
    expect(
      previewIncludedDeploymentsChange({
        activeProductionDeployments: 5,
        currentIncluded: 3,
        nextIncluded: 1,
      }),
    ).toEqual({ previousBillable: 2, nextBillable: 4, direction: 'decrease' });
  });

  it('the same allowance reports unchanged with equal billable on both sides', () => {
    expect(
      previewIncludedDeploymentsChange({
        activeProductionDeployments: 5,
        currentIncluded: 2,
        nextIncluded: 2,
      }),
    ).toEqual({ previousBillable: 3, nextBillable: 3, direction: 'unchanged' });
  });

  it('billable never goes negative when the allowance exceeds active deployments', () => {
    expect(
      previewIncludedDeploymentsChange({
        activeProductionDeployments: 2,
        currentIncluded: 5,
        nextIncluded: 10,
      }),
    ).toEqual({ previousBillable: 0, nextBillable: 0, direction: 'increase' });
  });
});
