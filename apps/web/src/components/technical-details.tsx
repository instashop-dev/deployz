'use client';

import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

// The one disclosure for implementation detail (ux-guidelines §8): same label
// everywhere, collapsed by default. Primary decision information never goes
// inside it.
export function TechnicalDetails({
  id,
  defaultOpen = false,
  className,
  children,
}: {
  /** Anchor for a deep link that opens the page at this section. */
  id?: string;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Collapsible
      id={id}
      defaultOpen={defaultOpen}
      className={cn('flex scroll-mt-20 flex-col', className)}
      data-testid="technical-details"
    >
      <CollapsibleTrigger className="group flex items-center gap-1 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        Technical details
        <ChevronDown aria-hidden className="size-4 transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3 pt-3">{children}</CollapsibleContent>
    </Collapsible>
  );
}
