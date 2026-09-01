'use client';

import type { DeploymentStage } from '@deployz/contracts';
import { ChevronDown } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { isTerminalStage } from '@/lib/deployment-progress';
import { fetchStackEvents, type VendorStackEvent } from '@/lib/stack-events';
import { useStatusPoll } from '@/lib/use-status-poll';

// Vendor-only raw CloudFormation stack-event feed — the diagnostics-grade
// complement to DeploymentProgressCard's derived phase timeline. This IS the
// raw-diagnostics surface (docs/ui-system.md): default-collapsed, and every
// status shown comes straight from the fetched event, never a literal.
export function InfrastructureEvents({
  deploymentId,
  stage,
}: {
  deploymentId: string;
  stage: DeploymentStage;
}) {
  const poll = useStatusPoll({
    fetcher: () => fetchStackEvents(deploymentId),
    intervalMs: 5000,
    terminalIntervalMs: 60000,
    isTerminal: () => isTerminalStage(stage),
  });

  const events = poll.data ?? [];
  if (events.length === 0) return null;

  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        Infrastructure events ({events.length})
        <ChevronDown
          aria-hidden
          className="size-4 transition-transform group-data-[state=open]:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Card className="mt-2">
          <CardContent className="max-h-80 overflow-y-auto py-4">
            <ol className="flex flex-col divide-y">
              {events.map((event) => (
                <StackEventRow key={event.id} event={event} />
              ))}
            </ol>
          </CardContent>
        </Card>
      </CollapsibleContent>
    </Collapsible>
  );
}

function StackEventRow({ event }: { event: VendorStackEvent }) {
  return (
    <li className="flex flex-col gap-0.5 py-2 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">{event.logicalResourceId}</span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {formatEventTime(event.eventAt)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">{event.resourceType}</span>
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
          {event.resourceStatus}
        </code>
      </div>
      {event.resourceStatusReason ? (
        <p className="text-xs text-muted-foreground">{event.resourceStatusReason}</p>
      ) : null}
    </li>
  );
}

function formatEventTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
