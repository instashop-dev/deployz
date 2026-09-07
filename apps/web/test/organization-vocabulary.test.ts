import { describe, expect, it } from 'vitest';

import { SUBSCRIPTION_STATUS_LABELS, subscriptionStatusLabel } from '../src/lib/organization-vocabulary';

describe('subscriptionStatusLabel', () => {
  it('labels null as evaluating', () => {
    expect(subscriptionStatusLabel(null)).toBe('Evaluating');
  });

  it('labels each subscription status', () => {
    expect(subscriptionStatusLabel('ACTIVE')).toBe('Active');
    expect(subscriptionStatusLabel('PAST_DUE')).toBe('Past due');
    expect(subscriptionStatusLabel('PAUSED')).toBe('Paused');
    expect(subscriptionStatusLabel('CANCELED')).toBe('Canceled');
  });

  it('matches SUBSCRIPTION_STATUS_LABELS', () => {
    expect(subscriptionStatusLabel('ACTIVE')).toBe(SUBSCRIPTION_STATUS_LABELS.ACTIVE);
    expect(subscriptionStatusLabel(null)).toBe(SUBSCRIPTION_STATUS_LABELS.EVALUATION);
  });
});
