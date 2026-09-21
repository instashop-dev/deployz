'use client';

import { ChevronDown } from 'lucide-react';

import type { DeploymentPlan } from '@deployz/contracts';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { installPlanRetentionNote, installPlanRetainedComponents } from '@/lib/install-plan';

// The deploy page's single collapsed "Data retention" section — what stays in
// the customer's AWS account if the deployment is removed, merged from the
// separate lines the review layout used to print. Retained component names
// come from the plan the API derived (never guessed), so a component this
// deployment does not have is never mentioned.
export function DataRetentionCard({ plan }: { plan: DeploymentPlan | null }) {
  const retained = installPlanRetainedComponents(plan);
  const note = installPlanRetentionNote(plan);
  const singular = retained.length === 1;
  return (
    <Collapsible className="rounded-md border">
      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-4 px-4 py-3 text-left text-sm">
        <span className="font-medium">Data retention</span>
        <ChevronDown
          aria-hidden
          className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-2 border-t px-4 py-3 text-sm text-muted-foreground">
          {note ? (
            <>
              <p>{note}</p>
              <p>
                {singular ? 'It can' : 'They can'} continue to generate AWS charges until{' '}
                {singular ? 'it is' : 'they are'} permanently purged.
              </p>
            </>
          ) : null}
          <p className="text-foreground">Your data stays in your AWS account.</p>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
