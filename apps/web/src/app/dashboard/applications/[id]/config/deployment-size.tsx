'use client';

import type { DeploymentPlan } from '@deployz/contracts';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { deriveSizeOptions, estimateKind, type EstimateKind } from '@/lib/configuration-inventory';
import { formatMonthlyRange } from '@/lib/footprint';
import { regionOptionLabel } from '@/lib/regions';
import { cn } from '@/lib/utils';

const ESTIMATE_KIND_COPY: Record<EstimateKind, { label: string; variant: 'secondary' | 'warning' | 'outline' }> = {
  complete: { label: 'Complete estimate', variant: 'secondary' },
  'baseline-plus-usage': { label: 'Baseline plus usage', variant: 'secondary' },
  partial: { label: 'Partial estimate', variant: 'warning' },
  unavailable: { label: 'Estimate unavailable', variant: 'outline' },
};

// Deployment size and the per-deployment AWS estimate. Sizes come from the
// published profile registry only: a size with no published profile shows
// as not available, never as a price. Every number is the plan's own
// `costEstimate` — this card only formats it.
export function DeploymentSize({
  plan,
  externalServices,
  unestimatedWorkload,
}: {
  plan: DeploymentPlan | null;
  externalServices: string[];
  unestimatedWorkload: boolean;
}) {
  const options = deriveSizeOptions(plan);
  const estimate = plan?.costEstimate ?? null;
  const kind = estimateKind(estimate);
  const range = estimate ? formatMonthlyRange(estimate.monthlyMin, estimate.monthlyMax) : null;
  const region = plan?.region ?? null;

  return (
    <Card id="deployment-size" className="scroll-mt-20" data-testid="deployment-size">
      <CardHeader>
        <CardTitle>Deployment size</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul aria-label="Deployment sizes" className="grid gap-2 sm:grid-cols-3">
          {options.map((option) => (
            <li
              key={option.id}
              aria-current={option.selected || undefined}
              data-testid={`deployment-size-${option.id}`}
              data-profile={option.profileKey ?? undefined}
              className={cn(
                'flex flex-col gap-0.5 rounded-lg border px-3 py-2',
                option.selected ? 'border-primary' : 'text-muted-foreground',
              )}
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                {option.label}
                {option.selected ? <Badge variant="secondary">Current</Badge> : null}
              </span>
              <span className="text-xs">
                {option.selected
                  ? (range ?? 'Estimate unavailable')
                  : option.available
                    ? 'Available'
                    : 'Not available yet'}
              </span>
            </li>
          ))}
        </ul>
        {options.some((option) => !option.available) ? (
          <p className="text-xs text-muted-foreground" data-testid="deployment-size-gap">
            Only the {options.filter((option) => option.available).map((option) => option.label).join(', ')} size is
            available today.
          </p>
        ) : null}

        <div className="flex flex-col gap-1.5 border-t pt-4" data-testid="deployment-cost">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">Estimated AWS cost per deployment</span>
            <Badge variant={ESTIMATE_KIND_COPY[kind].variant} data-testid="deployment-cost-kind">
              {ESTIMATE_KIND_COPY[kind].label}
            </Badge>
          </div>
          <p className="text-2xl font-semibold tracking-tight" data-testid="deployment-cost-total">
            {range ? `${range}${kind === 'baseline-plus-usage' || kind === 'partial' ? ' + usage' : ''}` : 'Unavailable'}
          </p>
          {kind === 'partial' ? (
            <p className="text-sm text-muted-foreground">Some resources could not be priced. The real cost is higher.</p>
          ) : null}
          {unestimatedWorkload ? (
            <p className="text-sm text-muted-foreground">The background worker is not estimated.</p>
          ) : null}
          <p className="text-xs text-muted-foreground" data-testid="deployment-cost-assumptions">
            {region ? `Region: ${regionOptionLabel(region)}` : 'Region: US East (N. Virginia) baseline. The customer’s region can change the price.'}{' '}
            · On-demand prices · 730 hours a month · USD
          </p>
          {estimate && estimate.usageDependent.length > 0 ? (
            <p className="text-xs text-muted-foreground">Not included: {estimate.usageDependent.join(', ')}.</p>
          ) : null}
          <ul className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground" data-testid="deployment-cost-charges">
            <li>AWS charges go to the customer’s AWS account.</li>
            <li>Deployz fees are not included in this estimate.</li>
            <li>
              External services
              {externalServices.length > 0 ? ` (${externalServices.join(', ')})` : ''} are billed separately and not
              estimated.
            </li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
