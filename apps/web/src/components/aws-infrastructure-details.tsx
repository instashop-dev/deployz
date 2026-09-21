'use client';

import { ChevronDown } from 'lucide-react';
import { Fragment } from 'react';

import type { DeploymentPlan } from '@deployz/contracts';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { awsResourceGroups, awsResourceRemovalLabel, installPlanRegionLabel } from '@/lib/install-plan';

// The "AWS infrastructure details" disclosure shared by the vendor
// application page and the customer install/deploy pages — collapsed by
// default so it never competes with the plain-English "Deployz will create"
// summary above it. Renders `plan.awsResources` verbatim: grouping, counting
// and mapping lifecycle to the two removal labels are the only UI logic.
export function AwsInfrastructureDetails({
  plan,
  region,
  triggerLabel,
}: {
  plan: DeploymentPlan | null;
  region?: string | null;
  /** Optional replacement trigger label — the deploy page's resource summary
   *  links into this same inventory as "View all AWS resources (N)". */
  triggerLabel?: string;
}) {
  if (!plan || plan.awsResources.length === 0) return null;

  const groups = awsResourceGroups(plan);
  const regionLabel = region ? installPlanRegionLabel(region) : null;
  const count = plan.awsResources.length;
  const summary = [regionLabel, `${count} AWS resource${count === 1 ? '' : 's'}`]
    .filter((part): part is string => Boolean(part))
    .join(' · ');

  return (
    <Collapsible className="rounded-md border" data-testid="aws-infrastructure-details">
      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-4 px-4 py-3 text-left text-sm">
        <span className="font-medium">{triggerLabel ?? 'AWS infrastructure details'}</span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {triggerLabel ? null : summary}
          <ChevronDown
            aria-hidden
            className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180"
          />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="overflow-x-auto border-t">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>AWS resource</TableHead>
                <TableHead>Purpose</TableHead>
                <TableHead>When removed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((groupEntry) => (
                <Fragment key={groupEntry.group}>
                  <TableRow>
                    <TableCell colSpan={3} className="bg-muted/50 text-xs font-medium text-muted-foreground">
                      {groupEntry.label}
                    </TableCell>
                  </TableRow>
                  {groupEntry.resources.map((resource) => (
                    <TableRow key={resource.id} data-testid={`aws-resource-${resource.id}`}>
                      <TableCell className="font-medium">{resource.name}</TableCell>
                      <TableCell className="text-muted-foreground">{resource.purpose}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {awsResourceRemovalLabel(resource.lifecycle)}
                      </TableCell>
                    </TableRow>
                  ))}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
