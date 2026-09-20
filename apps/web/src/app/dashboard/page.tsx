'use client';

import { AlertTriangle, Check } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useState } from 'react';

import { ApplicationPreparingCard } from '@/components/application-preparing-card';
import { ApplicationReadyCard } from '@/components/application-ready-card';
import { EvaluationNotice } from '@/components/evaluation-notice';
import { FirstDeploymentCard } from '@/components/first-deployment-card';
import { FleetSummary } from '@/components/fleet-summary';
import { GetStartedCard } from '@/components/get-started-card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchApplications } from '@/lib/applications';
import { fetchDeployments } from '@/lib/deployments';
import { deriveHomeState, type HomeState } from '@/lib/home-state';
import { useStatusPoll } from '@/lib/use-status-poll';

/** How often to re-check while something is still being set up. */
const TRANSIENT_POLL_MS = 5000;

// The homepage. One route, five states, all derived from the organization's
// real applications and deployments: get started, preparing an application,
// ready to deploy, following the first deployment, and the operational fleet
// view. The full Customer/Version/Region/Status table lives one click deeper,
// on /dashboard/deployments.
export default function HomePage() {
  const fetcher = useCallback(async (): Promise<HomeState> => {
    const [applications, deployments] = await Promise.all([
      fetchApplications(),
      fetchDeployments(),
    ]);
    return deriveHomeState({ applications, deployments });
  }, []);

  const poll = useStatusPoll<HomeState>({
    fetcher,
    intervalMs: TRANSIENT_POLL_MS,
    terminalIntervalMs: 60_000,
    isTerminal: (home) =>
      !(
        home.kind === 'first-deployment' ||
        (home.kind === 'preparing' && home.application.analysisStatus !== 'COMPLETE')
      ),
  });

  if (poll.loading && poll.data === null) return <LoadingState />;
  if (poll.data === null) return <ErrorState onRetry={poll.refresh} />;

  // Paddle migration Phase 11 — the evaluation line rides above whichever
  // homepage state is showing, and disappears once a subscription exists.
  return (
    <>
      <EvaluationNotice />
      {poll.stale ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <AlertTriangle aria-hidden className="size-4 shrink-0" />
          Updates unavailable — showing last known state
        </p>
      ) : null}
      {homeStateContent(poll.data)}
    </>
  );
}

function homeStateContent(home: HomeState) {
  switch (home.kind) {
    case 'setup':
      return <GetStartedCard />;
    case 'preparing':
      return <ApplicationPreparingCard application={home.application} />;
    case 'ready':
      return <ApplicationReadyCard application={home.application} />;
    case 'first-deployment':
      return <FirstDeploymentCard deployment={home.deployment} />;
    case 'operational':
      return <OperationalHome home={home} />;
  }
}

function OperationalHome({ home }: { home: Extract<HomeState, { kind: 'operational' }> }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Deployments</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your customer infrastructure at a glance.
          </p>
        </div>
        <Button asChild size="sm">
          <Link href="/dashboard/deployments/new">Create deployment</Link>
        </Button>
      </div>

      <FleetSummary summary={home.summary} />

      {/* Only claimed when it is true of every deployment — a fleet that is
          still installing is not yet healthy. */}
      {home.summary.attention === 0 && home.summary.healthy === home.summary.total ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Check className="size-4 shrink-0" aria-hidden />
          All deployments healthy
        </p>
      ) : null}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" data-testid="home-loading">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-4 w-72" />
      <Skeleton className="h-48 w-full rounded-xl" />
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => Promise<void> }) {
  const [retrying, setRetrying] = useState(false);

  async function handleRetry(): Promise<void> {
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <section
      aria-labelledby="home-error"
      className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center"
    >
      <h1 id="home-error" className="text-lg font-semibold">
        Something went wrong
      </h1>
      <p className="max-w-md text-sm text-muted-foreground">
        We couldn&apos;t load this page. Try again in a moment.
      </p>
      <Button variant="outline" onClick={() => void handleRetry()} loading={retrying} loadingText="Trying again…">
        Try again
      </Button>
    </section>
  );
}
