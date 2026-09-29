'use client';

import Link from 'next/link';

import { PublicInstallLinkCard } from '@/components/public-install-link-card';
import { Skeleton } from '@/components/ui/skeleton';
import { footprintComponentRows } from '@/lib/footprint';

import { ApplicationStateCard } from './application-state-card';
import { useApplicationPage } from './application-page-context';

// The Overview tab: at most three blocks (ux-guidelines §3) — the one
// state-aware card, the customer install-link card when it is not already
// the card's own primary action, and one "N services detected" line into
// Configuration › Services. Everything renders from `presentation` — see
// `lib/application-state.ts` for the single source of truth.
export default function ApplicationOverviewPage() {
  const { id, data, loading, presentation, refresh, reanalyse, reanalysing } = useApplicationPage();

  if (loading) {
    return (
      <div className="flex flex-col gap-4" data-testid="application-overview-loading" aria-busy="true">
        <Skeleton className="h-56 w-full rounded-xl" />
      </div>
    );
  }

  // Same source the Services section itself renders from: the detected
  // application architecture when analysis found one, else the INSTALL
  // plan's own component rows.
  const serviceCount =
    data !== null
      ? (data.readiness.architecture?.groups.reduce((total, group) => total + group.nodes.length, 0) ??
        (data.plan?.footprint ? footprintComponentRows(data.plan.footprint).length : null))
      : null;

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
      {serviceCount !== null && serviceCount > 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="application-services-count">
          {serviceCount} {serviceCount === 1 ? 'service' : 'services'} detected ·{' '}
          <Link
            href={`/dashboard/applications/${id}/config#services`}
            className="underline underline-offset-4 hover:text-foreground"
          >
            View
          </Link>
        </p>
      ) : null}
    </div>
  );
}
