'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { apiRequest, errorMessage } from '@/lib/api-client';

// §48 the way a vendor actually starts paying.
//
// POST /api/billing/checkout existed and worked from the day billing landed,
// but nothing in the dashboard ever called it: there was no subscribe control
// anywhere, organizations.plan stayed FREE forever, and §67 items 23-25 could
// not happen through the product. This is that missing control.

export function SubscribeButton({
  status,
}: {
  /** Subscription status, or null when the organization has never subscribed. */
  status: string | null;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = status === 'ACTIVE' || status === 'TRIALING';

  async function startCheckout(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const { url } = await apiRequest<{ url: string | null }>('/api/billing/checkout', {
        method: 'POST',
        body: {},
      });
      if (!url) {
        // Stripe is not configured on this deployment. Say so plainly rather
        // than leaving a button that silently does nothing.
        setError('Billing is not available right now. Try again shortly.');
        setPending(false);
        return;
      }
      window.location.href = url;
    } catch (caught) {
      setError(errorMessage(caught));
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={startCheckout} disabled={pending}>
          {pending ? 'Opening…' : active ? 'Manage billing' : 'Start subscription'}
        </Button>
        {status === 'PAST_DUE' ? (
          <p className="text-sm text-destructive">
            Your last payment did not go through. Update your card to keep your deployments
            running.
          </p>
        ) : null}
        {status === null ? (
          <p className="text-sm text-muted-foreground">
            You are not subscribed yet. Deployments keep working; charges start when you
            subscribe.
          </p>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
