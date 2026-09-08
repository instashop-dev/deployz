import { Receipt } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { fetchBillingSummary, formatDollars, type BillingSummary } from '@/lib/billing';
import { subscriptionStatusLabel } from '@/lib/organization-vocabulary';

// §48 billing display. Paddle migration Phase 11 splits it in two, because
// the old page charged every vendor $49 on screen whether or not they had
// ever bought anything: an organization with no subscription is EVALUATING,
// which is free and never expires, and showing it a monthly total is simply
// untrue. Once a subscription exists the page shows the real rate, the next
// billing date and the per-customer breakdown.
//
// §65: jargon-free. The provider is never named at the top level.
export default async function BillingPage() {
  const billing = await fetchBillingSummary();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {billing.subscription ? 'Your current monthly rate.' : 'You are evaluating Deployz.'}
        </p>
      </div>

      {billing.subscription ? (
        <SubscribedCard billing={billing} />
      ) : (
        <EvaluationCard billing={billing} />
      )}
    </div>
  );
}

/** No subscription: free, no card, no expiry — and what would start billing. */
function EvaluationCard({ billing }: { billing: BillingSummary }) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Evaluation — free</CardTitle>
          <CardDescription>
            No card, no time limit, and nothing to cancel. Take as long as you need.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p className="text-muted-foreground">Free for as long as you are evaluating:</p>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
            <li>Connecting applications, analysis and configuration</li>
            <li>One test deployment of your own app, per application</li>
            <li>Adding customers and building releases</li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What starts billing</CardTitle>
          <CardDescription>
            Your first customer deployment. Nothing is charged before then.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">Platform</span>
            <span className="tabular-nums text-muted-foreground">
              {formatDollars(billing.base)}/month
            </span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">Each customer deployment, once live</span>
            <span className="tabular-nums text-muted-foreground">$19/month</span>
          </div>
          <p className="text-xs text-muted-foreground">
            A test deployment of your own app is always free. A customer deployment is charged only
            once it is live, and the charge stops as soon as it is removed.
          </p>
        </CardContent>
      </Card>
    </>
  );
}

/** Subscribed: the real rate, the next billing date and the breakdown. */
function SubscribedCard({ billing }: { billing: BillingSummary }) {
  const subscription = billing.subscription!;
  const nextBillingDate = subscription.currentPeriodEnd
    ? new Date(subscription.currentPeriodEnd).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : null;

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Receipt className="size-5 text-muted-foreground" aria-hidden />
            <CardTitle>Current charges</CardTitle>
          </div>
          <CardDescription className="flex flex-wrap items-center gap-2">
            <Badge variant={subscription.status === 'ACTIVE' ? 'secondary' : 'destructive'}>
              {subscriptionStatusLabel(subscription.status)}
            </Badge>
            {nextBillingDate ? <span>Next billed {nextBillingDate}</span> : null}
          </CardDescription>
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
              No customer deployments are live yet. Each one appears here at $19/month once it is.
            </p>
          ) : null}
          <Separator />
          <div className="flex items-center justify-between text-sm font-semibold">
            <span>Monthly total</span>
            <span className="tabular-nums">{formatDollars(billing.total)}</span>
          </div>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        A test deployment of your own app is not charged. The $19/month fee applies once a customer
        deployment is live, and stops as soon as that deployment is removed.
      </p>
    </>
  );
}
