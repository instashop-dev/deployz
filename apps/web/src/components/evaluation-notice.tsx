'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { fetchSubscriptionStatus } from '@/lib/billing-checkout';

// Paddle migration Phase 11 — the evaluation message. Shown only while the
// organization has no subscription at all, and gone the moment one exists.
//
// Deliberately one muted line, not a card or a banner: evaluation is free and
// never expires, so there is nothing here to act on. A vendor who is still
// evaluating is not behind on anything, and dressing this up as an alert
// would invent urgency the product does not have.
export function EvaluationNotice() {
  const [evaluating, setEvaluating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchSubscriptionStatus()
      .then((status) => {
        if (!cancelled) setEvaluating(status === null);
      })
      .catch(() => {
        // Silent: a missing status is not worth a message of its own.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!evaluating) return null;

  return (
    <p className="text-sm text-muted-foreground" data-testid="evaluation-notice">
      You are evaluating Deployz — free, with no card and no time limit. Test deployments of your
      own app stay free. Billing starts with your first customer deployment.{' '}
      <Link
        href="/dashboard/settings/billing"
        className="font-medium underline underline-offset-4"
      >
        What it costs
      </Link>
    </p>
  );
}
