'use client';

import { ChevronDown } from 'lucide-react';
import { useId, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ACTIVITY_PREVIEW_COUNT,
  activityFailureSummary,
  activityRawError,
  newestFirst,
} from '@/lib/activity';
import type { ActivityEvent } from '@/lib/deployments';
import { eventResultLabel, eventTypeLabel } from '@/lib/deployment-vocabulary';

// Reusable activity feed — renders a deployment's §40 event timeline,
// newest first. The top level is §65 jargon-free (human event label, a
// Succeeded/Failed/Skipped badge, and the classified failure's plain-English
// summary); the raw event type, result code, relay error and payload live
// behind an accessible button-driven disclosure per row.
export function ActivityFeed({
  events,
  previewCount = ACTIVITY_PREVIEW_COUNT,
}: {
  events: ActivityEvent[];
  /** Rows shown before "View full activity"; pass Infinity to show everything. */
  previewCount?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const ordered = newestFirst(events);
  const visible = expanded ? ordered : ordered.slice(0, previewCount);
  const hidden = ordered.length - visible.length;

  if (ordered.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No activity yet for this deployment.</p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <ol className="flex flex-col divide-y rounded-lg border" data-testid="activity-feed">
        {visible.map((event, index) => (
          // Keyed by distance from the OLDEST event: a new event inserted at
          // the top never re-keys (and so never re-collapses) an older row.
          <ActivityFeedItem
            key={`${event.occurredAt}-${event.eventType}-${ordered.length - index}`}
            event={event}
          />
        ))}
      </ol>
      {hidden > 0 || expanded ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Show less' : `View full activity (${ordered.length})`}
        </Button>
      ) : null}
    </div>
  );
}

function ActivityFeedItem({ event }: { event: ActivityEvent }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const result = eventResultLabel(event.result);
  const summary = activityFailureSummary(event);
  const rawError = activityRawError(event);

  return (
    <li>
      <button
        type="button"
        className="flex w-full cursor-pointer items-start gap-3 px-3 py-2 text-left"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
      >
        <time
          dateTime={event.occurredAt}
          className="w-[4.75rem] shrink-0 pt-px text-xs whitespace-nowrap tabular-nums text-muted-foreground"
          title={formatFullTimestamp(event.occurredAt)}
        >
          {formatTime(event.occurredAt)}
        </time>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{eventTypeLabel(event.eventType)}</span>
          {summary ? (
            <span className="block text-xs text-muted-foreground">{summary}</span>
          ) : null}
          <span className="block text-xs text-muted-foreground sm:hidden">
            {formatDate(event.occurredAt)}
          </span>
        </span>
        <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
          {formatDate(event.occurredAt)}
        </span>
        {result ? <ResultBadge result={result} /> : null}
        <ChevronDown
          aria-hidden
          className={`mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open ? (
        <div
          id={panelId}
          className="flex flex-col gap-2 border-t bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground"
        >
          {rawError ? <DetailRow label="Error" value={rawError} /> : null}
          <DetailRow label="Event" value={event.eventType} />
          {event.result !== null ? <DetailRow label="Result" value={event.result} /> : null}
          {event.previousState && event.requestedState ? (
            <DetailRow label="State" value={`${event.previousState} → ${event.requestedState}`} />
          ) : null}
          <DetailRow label="Payload" value={JSON.stringify(event.payload)} />
        </div>
      ) : null}
    </li>
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

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatFullTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
