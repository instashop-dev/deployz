'use client';

import { ChevronDown } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { PLAN_COMPONENT_GROUP_DISPLAY } from '@deployz/contracts';

import type { ApplicationArchitecture, ArchitectureNode } from '@/lib/readiness';

const GROUP_HINTS: Record<string, string> = {
  application: 'Runs the application code',
  data: 'Stores application data',
  cache: 'Caches data or queues jobs',
  storage: 'Stores files',
  messaging: 'Passes messages between components',
  networking: 'Connects components',
  edge: 'Receives external traffic',
  security: 'Controls access',
};

const STATE_COPY: Record<ArchitectureNode['state'], string> = {
  detected: 'Detected automatically',
  confirmed: 'Confirmed',
};

interface ArchitectureDetectedCardProps {
  architecture: ApplicationArchitecture;
  summary: string | null;
}

/**
 * Compact overview card for the detected application architecture.
 * Shows grouped component labels with state indicators and a disclosure
 * with a simple explanatory list. Never a graph, editor, or confidence
 * percentage.
 */
export function ArchitectureDetectedCard({ architecture, summary }: ArchitectureDetectedCardProps) {
  const hasContent = architecture.groups.length > 0 || architecture.unresolved.length > 0;
  if (!hasContent) return null;

  return (
    <Card data-testid="architecture-detected-card">
      <CardHeader>
        <CardTitle>Architecture detected</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul className="flex flex-col gap-3" data-testid="architecture-detected-groups">
          {architecture.groups.map((group) => (
            <li key={group.group} data-testid={`architecture-group-${group.group}`}>
              <p className="text-sm font-medium">
                {PLAN_COMPONENT_GROUP_DISPLAY[group.group]}
              </p>
              <ul className="mt-1 flex flex-col gap-1">
                {group.nodes.map((node) => (
                  <li
                    key={node.label}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-2.5 py-1.5"
                    data-testid={`architecture-node-${group.group}-${node.label}`}
                  >
                    <span className="text-sm">{node.label}</span>
                    <StateBadge state={node.state} />
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>

        {architecture.unresolved.length > 0 ? (
          <ul className="flex flex-col gap-2" data-testid="architecture-unresolved-summary">
            {architecture.unresolved.map((item, index) => (
              <li
                key={`${item.kind}-${index}`}
                className="flex items-center gap-2 text-sm"
                data-testid={`architecture-unresolved-${item.kind}-${index}`}
              >
                <Badge variant="destructive">Needs input</Badge>
                <span className="text-muted-foreground">{item.question}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {summary ? (
          <p className="text-sm text-muted-foreground" data-testid="architecture-summary">
            {summary}
          </p>
        ) : null}

        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button variant="outline" size="sm" data-testid="architecture-view-toggle">
              View architecture
              <ChevronDown
                aria-hidden
                className="size-4 transition-transform group-data-[state=open]:rotate-180"
              />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent
            className="flex flex-col gap-4 pt-4"
            data-testid="architecture-detail"
          >
            {architecture.groups.map((group) => (
              <div key={group.group} data-testid={`architecture-detail-group-${group.group}`}>
                <p className="text-sm font-medium">
                  {PLAN_COMPONENT_GROUP_DISPLAY[group.group]}
                </p>
                <ul className="mt-1 flex flex-col gap-1 text-sm text-muted-foreground">
                  {group.nodes.map((node) => (
                    <li key={`${group.group}-${node.label}`} data-testid={`architecture-detail-node-${group.group}-${node.label}`}>
                      <span className="font-medium text-foreground">{node.label}</span>
                      {' — '}
                      {GROUP_HINTS[group.group]}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {architecture.unresolved.length > 0 ? (
              <div data-testid="architecture-detail-unresolved">
                <p className="text-sm font-medium">Needs input</p>
                <ul className="mt-1 flex flex-col gap-1 text-sm text-muted-foreground">
                  {architecture.unresolved.map((item, index) => (
                    <li key={`${item.kind}-${index}`}>
                      {item.question}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}

function StateBadge({ state }: { state: ArchitectureNode['state'] }) {
  return (
    <Badge variant={state === 'confirmed' ? 'success' : 'secondary'} className="text-[10px]">
      {STATE_COPY[state]}
    </Badge>
  );
}
