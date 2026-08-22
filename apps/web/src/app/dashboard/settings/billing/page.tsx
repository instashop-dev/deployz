import { Receipt } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { fetchBillingSummary, formatDollars, type BillingSummary } from '@/lib/billing';

// §48 billing display — the exact breakdown: a "Platform  $49" line, one line
// per billable deployment labelled with the CUSTOMER name at $19, and a
// "Monthly total" line. §65: jargon-free (no "Stripe", "meter event",
// "proration" at the top level).
export default async function BillingPage() {
  const billing = await fetchBillingSummary();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your subscription and usage details.
        </p>
      </div>

      <BillingSummaryCard billing={billing} />

      <p className="text-xs text-muted-foreground">
        A vendor-owned test deployment is not charged. The $19/month fee applies once a customer
        deployment becomes healthy, and stops as soon as that deployment is removed.
      </p>
    </div>
  );
}

function BillingSummaryCard({ billing }: { billing: BillingSummary }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Receipt className="size-5 text-muted-foreground" aria-hidden />
          <CardTitle>Current charges</CardTitle>
        </div>
        <CardDescription>Charges for the current billing period.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">Platform</span>
          <span className="font-medium tabular-nums">{formatDollars(billing.base)}</span>
        </div>
        {billing.deployments.map((deployment, index) => (
          <div
            key={`${deployment.name}-${index}`}
            className="flex items-center justify-between text-sm"
          >
            <div>
              <span className="font-medium">{deployment.name}</span>
              <span className="ml-1.5 text-muted-foreground">({deployment.applicationName})</span>
            </div>
            <span className="font-medium tabular-nums">{formatDollars(deployment.amount)}</span>
          </div>
        ))}
        {billing.deployments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No billable deployments yet. Healthy customer deployments appear here at $19/month
            each.
          </p>
        ) : null}
        <Separator />
        <div className="flex items-center justify-between text-sm font-semibold">
          <span>Monthly total</span>
          <span className="tabular-nums">{formatDollars(billing.total)}</span>
        </div>
      </CardContent>
    </Card>
  );
}
