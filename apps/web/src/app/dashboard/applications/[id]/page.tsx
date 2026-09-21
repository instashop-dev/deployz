'use client';

import Link from 'next/link';

import { PublicInstallLinkCard } from '@/components/public-install-link-card';
import { Skeleton } from '@/components/ui/skeleton';
import type { ApplicationRecentEvent } from '@/lib/application-state';

import { ApplicationStateCard } from './application-state-card';
import { useApplicationPage } from './application-page-context';

// The Overview tab: the one state-aware card, the customer install-link card
// when it is not already the card's own primary action, and at most one
// recent-event line. Everything renders from `presentation` — see
// `lib/application-state.ts` for the single source of truth.
export default function ApplicationOverviewPage() {
  const { id, loading, presentation, refresh, reanalyse, reanalysing } = useApplicationPage();

  if (loading) {
    return (
      <div className="flex flex-col gap-4" data-testid="application-overview-loading" aria-busy="true">
        <Skeleton className="h-56 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <ApplicationStateCard
        applicationId={id}
        presentation={presentation}
        refresh={refresh}
        reanalyse={reanalyse}
        reanalysing={reanalysing}
      />
      {presentation.installLinkPlacement === 'card' ? (
        <PublicInstallLinkCard applicationId={id} installLink={presentation.installLink} onChanged={refresh} />
      ) : null}
      {presentation.recentEvent ? <RecentEventRow event={presentation.recentEvent} /> : null}
    </div>
  );
}

function RecentEventRow({ event }: { event: ApplicationRecentEvent }) {
  return (
    <div
      className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
      data-testid="application-recent-event"
    >
      <span className="font-medium text-foreground">{event.label}</span>
      <span aria-hidden>·</span>
      <span>{event.status}</span>
      <span aria-hidden>·</span>
      <span>{new Date(event.at).toLocaleDateString()}</span>
      <Link href={event.href} className="underline underline-offset-4 hover:text-foreground">
        View
      </Link>
    </div>
  );
}
