import { CreditCard, Receipt } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { fetchBilling, formatDate, type BillingInfo } from '@/lib/billing';

// §48 billing display — shows the org's subscription status, current period,
// line items (base + metered), and invoice total. §65: all copy is jargon-free
// (no "Stripe", "meter event", "proration" at the top level). The billing API
// endpoint 404s until the backend route lands, so fetchBilling falls back to
// fixture data (same pattern as todos 19/25/26/30).

export default async function BillingPage() {
  const billing = await fetchBilling();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your subscription and usage details.
        </p>
      </div>

      <BillingStatusCard billing={billing} />

      {billing.hasSubscription ? (
        <>
          <BillingSummaryCard billing={billing} />
          <BillingHistoryCard />
        </>
      ) : (
        <NoSubscriptionCard manageUrl={billing.manageUrl} />
      )}
    </div>
  );
}

// ── Status card ─────────────────────────────────────────────────────────────

function BillingStatusCard({ billing }: { billing: BillingInfo }) {
  const statusConfig = getStatusConfig(billing.status);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CreditCard className="size-5 text-muted-foreground" aria-hidden />
          <CardTitle>Subscription</CardTitle>
        </div>
        <CardDescription>
          {billing.hasSubscription
            ? `Your subscription is ${statusConfig.label.toLowerCase()}.`
            : 'You do not have an active subscription.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Status</span>
          <Badge variant={statusConfig.variant}>{statusConfig.label}</Badge>
        </div>
        {billing.currentPeriod ? (
          <div className="text-sm text-muted-foreground">
            Current period:{' '}
            <span className="font-medium text-foreground">
              {formatDate(billing.currentPeriod.start)} – {formatDate(billing.currentPeriod.end)}
            </span>
          </div>
        ) : null}
        {billing.manageUrl ? (
          <div>
            <a
              href={billing.manageUrl}
              className="text-sm font-medium underline underline-offset-4 hover:text-primary"
            >
              Manage billing
            </a>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ── Summary card ────────────────────────────────────────────────────────────

function BillingSummaryCard({ billing }: { billing: BillingInfo }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Receipt className="size-5 text-muted-foreground" aria-hidden />
          <CardTitle>Current charges</CardTitle>
        </div>
        <CardDescription>
          Charges for the current billing period. Usage is calculated daily.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {billing.lineItems.map((item) => (
          <div key={item.label} className="flex items-center justify-between text-sm">
            <div>
              <span className="font-medium">{item.label}</span>
              {item.detail ? (
                <span className="ml-1.5 text-muted-foreground">({item.detail})</span>
              ) : null}
            </div>
            <span className="font-medium tabular-nums">{item.amountDisplay}</span>
          </div>
        ))}
        <Separator />
        <div className="flex items-center justify-between text-sm font-semibold">
          <span>Total</span>
          <span className="tabular-nums">{billing.totalDisplay}</span>
        </div>
      </CardContent>
    </Card>
  );
}

// ── History card (placeholder) ──────────────────────────────────────────────

function BillingHistoryCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Invoice history</CardTitle>
        <CardDescription>
          Past invoices will appear here once your first billing period completes.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          No invoices yet. Your first invoice will be generated at the end of the current billing
          period.
        </p>
      </CardContent>
    </Card>
  );
}

// ── No subscription card ────────────────────────────────────────────────────

function NoSubscriptionCard({ manageUrl }: { manageUrl: string | null }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>No subscription</CardTitle>
        <CardDescription>
          Subscribe to start deploying applications for your customers.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Deployz costs $49/month for the base subscription plus $19/month for each healthy
          deployment. Your first deployment is free — it is a test deployment for verifying
          compatibility.
        </p>
        {manageUrl ? (
          <div className="mt-4">
            <a
              href={manageUrl}
              className="text-sm font-medium underline underline-offset-4 hover:text-primary"
            >
              Subscribe now
            </a>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ── Status config ───────────────────────────────────────────────────────────

function getStatusConfig(
  status: BillingInfo['status'],
): { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' } {
  switch (status) {
    case 'ACTIVE':
      return { label: 'Active', variant: 'default' };
    case 'TRIALING':
      return { label: 'Trialing', variant: 'secondary' };
    case 'PAST_DUE':
      return { label: 'Past due', variant: 'destructive' };
    case 'CANCELED':
      return { label: 'Canceled', variant: 'outline' };
    case 'INCOMPLETE':
      return { label: 'Incomplete', variant: 'secondary' };
    case 'NONE':
    default:
      return { label: 'None', variant: 'outline' };
  }
}