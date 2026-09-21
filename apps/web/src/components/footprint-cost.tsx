'use client';

import { ChevronDown } from 'lucide-react';

import type { FootprintCostEstimate } from '@deployz/contracts';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { formatMonthlyRange, footprintCostLines } from '@/lib/footprint';

// The baseline AWS cost estimate for a deployment footprint, rendered from
// the API's `costEstimate` — never computed in the client. Ranges are the
// server's; this component only formats. An incomplete estimate says so; a
// fully unpriceable footprint says so; neither ever blocks the deployment.
export function FootprintCost({ estimate }: { estimate: FootprintCostEstimate | null | undefined }) {
  if (!estimate) return null;

  const range = formatMonthlyRange(estimate.monthlyMin, estimate.monthlyMax);
  const lines = footprintCostLines(estimate);

  return (
    <div className="flex flex-col gap-2 rounded-md border p-4" data-testid="footprint-cost">
      <h3 className="text-sm font-medium">Estimated AWS infrastructure</h3>
      {range ? (
        <>
          <p className="text-2xl font-semibold tracking-tight" data-testid="footprint-cost-range">
            {range}
          </p>
          <p className="text-sm text-muted-foreground">
            Baseline estimate for this deployment configuration. AWS bills your account directly.
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="footprint-cost-unavailable">
          AWS cost estimate unavailable.
        </p>
      )}
      {!estimate.complete ? (
        <p className="text-sm text-muted-foreground" data-testid="footprint-cost-incomplete">
          Estimate incomplete — some resources could not be priced.
        </p>
      ) : null}
      <Collapsible>
        <CollapsibleTrigger className="group flex items-center gap-1 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
          View breakdown
          <ChevronDown
            aria-hidden
            className="size-4 transition-transform group-data-[state=open]:rotate-180"
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-2 flex flex-col gap-1.5" data-testid="footprint-cost-breakdown">
            {lines.map((line) => (
              <div key={line.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0">{line.label}</span>
                <span className="shrink-0 text-muted-foreground" data-testid={`footprint-cost-item-${line.id}`}>
                  {line.range ?? (line.status === 'usage_based' ? 'Usage based' : 'Pricing unavailable')}
                </span>
              </div>
            ))}
            {estimate.usageDependent.length > 0 ? (
              <div className="mt-2 text-xs text-muted-foreground">
                Additional usage-based costs: {estimate.usageDependent.join(', ')}.
              </div>
            ) : null}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
