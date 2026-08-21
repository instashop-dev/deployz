'use client';

import { ChevronDown } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import type { ActivityEvent } from '@/lib/deployments';
import {
  eventResultLabel,
  eventTypeLabel,
} from '@/lib/deployment-vocabulary';

// Reusable activity feed — renders a deployment's §40 event timeline. The
// top level is §65 jargon-free (human event label + Succeeded/Failed/Skipped);
// the raw event type, result code, and payload live behind a collapsible
// <details> (the same expandable-detail pattern as the security page).
export function ActivityFeed({ events }: { events: ActivityEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No activity yet for this deployment.</p>
    );
  }

  return (
    <ol className="flex flex-col" data-testid="activity-feed">
      {events.map((event, index) => (
        <ActivityFeedItem key={`${event.occurredAt}-${event.eventType}-${index}`} event={event} />
      ))}
    </ol>
  );
}

function ActivityFeedItem({ event }: { event: ActivityEvent }) {
  const result = eventResultLabel(event.result);

  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      <TimelineRail event={event} />
      <details className="group min-w-0 flex-1 rounded-lg border">
        <summary className="flex cursor-pointer list-none items-start justify-between gap-2 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
          <div className="min-w-0">
            <p className="text-sm font-medium">{eventTypeLabel(event.eventType)}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {formatTimestamp(event.occurredAt)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {result ? <ResultBadge result={result} /> : null}
            <ChevronDown
              aria-hidden
              className="size-4 text-muted-foreground transition-transform group-open:rotate-180"
            />
          </div>
        </summary>
        <div className="flex flex-col gap-2 border-t px-3 py-2.5 text-xs text-muted-foreground">
          <DetailRow label="Event" value={event.eventType} />
          {event.result !== null ? <DetailRow label="Result" value={event.result} /> : null}
          {event.previousState && event.requestedState ? (
            <DetailRow label="State" value={`${event.previousState} → ${event.requestedState}`} />
          ) : null}
          <DetailRow label="Payload" value={JSON.stringify(event.payload)} />
        </div>
      </details>
    </li>
  );
}

function TimelineRail({ event }: { event: ActivityEvent }) {
  const tone =
    event.result === null ? 'bg-muted' : event.result.startsWith('failed') ? 'bg-destructive' : 'bg-primary';
  return (
    <div className="mt-1.5 flex flex-col items-center">
      <span className={`size-2 rounded-full ${tone}`} aria-hidden />
    </div>
  );
}

function ResultBadge({ result }: { result: string }) {
  const variant = result === 'Failed' ? 'destructive' : result === 'Skipped' ? 'secondary' : 'outline';
  return <Badge variant={variant}>{result}</Badge>;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-medium text-foreground">{label}</span>
      <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono">{value}</code>
    </div>
  );
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
