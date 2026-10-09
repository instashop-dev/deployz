'use client';

import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';

import type { CustomerActivityItem } from '@deployz/contracts';

import { recentActivityTimeLabel } from '@/lib/deployment-progress';
import { TONE_DOT, TONE_TEXT } from '@/lib/status-tone';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

// Live AWS activity, presented as a chronological secondary section. The
// top of the section shows the latest few meaningful events (default five);
// the "View full AWS activity" disclosure expands the same set when the
// server has reported more than the visible window. The server caps the
// payload at five today — when that changes the disclosure already widens
// to fit without further wiring.

const PRIMARY_LIMIT = 5;

export interface LiveAwsActivityProps {
  items: CustomerActivityItem[];
  /** Stale (no recent server confirmation): show the "Last confirmed" cue. */
  stale: boolean;
}

export function LiveAwsActivity({ items, stale }: LiveAwsActivityProps) {
  if (items.length === 0) return null;
  const now = Date.now();
  const primary = items.slice(0, PRIMARY_LIMIT);
  const hasMore = items.length > PRIMARY_LIMIT;
  return (
    <section aria-labelledby="deployment-activity" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            stale ? TONE_DOT.attention : TONE_DOT.progress,
            !stale && 'animate-pulse',
          )}
        />
        <h2 id="deployment-activity" className="text-base font-semibold">
          Live AWS activity
        </h2>
        <span className="text-xs text-muted-foreground">{stale ? 'Last confirmed update' : 'Live'}</span>
      </div>

      <ol className="flex flex-col gap-1.5" data-testid="live-aws-activity-list">
        {primary.map((item) => (
          <ActivityRow key={item.key} item={item} now={now} />
        ))}
      </ol>

      {hasMore ? (
        <Collapsible>
          <CollapsibleTrigger
            className="group flex items-center gap-1 self-start text-sm font-medium text-muted-foreground hover:text-foreground"
            data-testid="live-aws-activity-full-toggle"
          >
            View full AWS activity
            <span aria-hidden className="text-xs transition-transform group-data-[state=open]:rotate-180">▾</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ol className="mt-2 flex flex-col gap-1.5" data-testid="live-aws-activity-full">
              {items.slice(PRIMARY_LIMIT).map((item) => (
                <ActivityRow key={item.key} item={item} now={now} />
              ))}
            </ol>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </section>
  );
}

/** The newest meaningful AWS event as one concise row — the tracker's
 *  summary of the full feed under "Deployment details". */
export function LatestAwsActivity({
  item,
  stale,
  now,
}: {
  item: CustomerActivityItem;
  stale: boolean;
  now: number;
}) {
  return (
    <div className="flex flex-col gap-1.5 border-t pt-4" data-testid="latest-aws-activity">
      <p className="text-xs font-medium text-muted-foreground">
        {stale ? 'Last confirmed AWS activity' : 'Latest AWS activity'}
      </p>
      <p className="flex items-start gap-2 text-sm">
        <ActivityIcon state={item.state} />
        <span className="min-w-0 flex-1">{item.message}</span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums" suppressHydrationWarning>
          {recentActivityTimeLabel(item.at, now)}
        </span>
      </p>
    </div>
  );
}

function ActivityRow({ item, now }: { item: CustomerActivityItem; now: number }) {
  return (
    <li className="flex items-start gap-2 text-xs text-muted-foreground" data-testid={`activity-${item.key}`}>
      <ActivityIcon state={item.state} />
      <span className="flex-1">{item.message}</span>
      <span className="shrink-0 tabular-nums">{recentActivityTimeLabel(item.at, now)}</span>
    </li>
  );
}

function ActivityIcon({ state }: { state: CustomerActivityItem['state'] }) {
  switch (state) {
    case 'COMPLETE':
      return <CheckCircle2 aria-hidden className={cn('mt-0.5 size-3.5 shrink-0', TONE_TEXT.positive)} />;
    case 'FAILED':
      return <AlertCircle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-destructive" />;
    case 'IN_PROGRESS':
      return <Loader2 aria-hidden className={cn('mt-0.5 size-3.5 shrink-0 animate-spin', TONE_TEXT.progress)} />;
  }
}
