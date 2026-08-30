'use client';

import { ArrowRight, Check } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { ApplicationPreparingCard } from '@/components/application-preparing-card';
import { ApplicationReadyCard } from '@/components/application-ready-card';
import { DeploymentList } from '@/components/deployment-list';
import { FirstDeploymentCard } from '@/components/first-deployment-card';
import { FleetSummary } from '@/components/fleet-summary';
import { GetStartedCard } from '@/components/get-started-card';
import { NeedsAttentionList } from '@/components/needs-attention-list';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchApplications } from '@/lib/applications';
import { fetchDeployments } from '@/lib/deployments';
import {
  deriveHomeState,
  HOMEPAGE_ATTENTION_LIMIT,
  HOMEPAGE_DEPLOYMENT_LIMIT,
  type HomeState,
} from '@/lib/home-state';

/** How often to re-check while something is still being set up. */
const TRANSIENT_POLL_MS = 5000;

type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'loaded'; home: HomeState };

// The homepage. One route, five states, all derived from the organization's
// real applications and deployments: get started, preparing an application,
// ready to deploy, following the first deployment, and the operational fleet
// view. The full Customer/Version/Region/Status table lives one click deeper,
// on /dashboard/deployments.
export default function HomePage() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(async (): Promise<HomeState> => {
    const [applications, deployments] = await Promise.all([
      fetchApplications(),
      fetchDeployments(),
    ]);
    return deriveHomeState({ applications, deployments });
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function run(): Promise<void> {
      try {
        const home = await load();
        if (!cancelled) setState({ status: 'loaded', home });
      } catch {
        if (!cancelled) setState({ status: 'error' });
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [load, attempt]);

  // While an application is being prepared or a first deployment is being set
  // up, the answer changes without the person doing anything — so keep asking.
  const transient =
    state.status === 'loaded' &&
    (state.home.kind === 'first-deployment' ||
      (state.home.kind === 'preparing' && state.home.application.analysisStatus !== 'COMPLETE'));

  useEffect(() => {
    if (!transient) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void load()
        .then((home) => {
          if (!cancelled) setState({ status: 'loaded', home });
        })
        .catch(() => {
          // A failed poll leaves the last known state on screen; the next
          // tick tries again.
        });
    }, TRANSIENT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [transient, load]);

  if (state.status === 'loading') return <LoadingState />;
  if (state.status === 'error') return <ErrorState onRetry={() => setAttempt((n) => n + 1)} />;

  switch (state.home.kind) {
    case 'setup':
      return <GetStartedCard />;
    case 'preparing':
      return <ApplicationPreparingCard application={state.home.application} />;
    case 'ready':
      return <ApplicationReadyCard application={state.home.application} />;
    case 'first-deployment':
      return <FirstDeploymentCard deployment={state.home.deployment} />;
    case 'operational':
      return <OperationalHome home={state.home} />;
  }
}

function OperationalHome({ home }: { home: Extract<HomeState, { kind: 'operational' }> }) {
  const attention = home.attention.slice(0, HOMEPAGE_ATTENTION_LIMIT);
  const rows = home.deployments.slice(0, HOMEPAGE_DEPLOYMENT_LIMIT);

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
          <Link href="/dashboard/deployments/new">Deploy customer</Link>
        </Button>
      </div>

      <FleetSummary summary={home.summary} />

      {attention.length > 0 ? <NeedsAttentionList items={attention} /> : null}
      {/* Only claimed when it is true of every deployment — a fleet that is
          still installing is not yet healthy. */}
      {home.summary.attention === 0 && home.summary.healthy === home.summary.total ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Check className="size-4 shrink-0" aria-hidden />
          All deployments healthy
        </p>
      ) : null}

      <section aria-labelledby="customer-deployments" className="flex flex-col gap-3">
        <h2 id="customer-deployments" className="text-base font-semibold">
          Customer deployments
        </h2>
        <DeploymentList deployments={rows} showApplication={home.showApplication} />
        {/* Always offered: the homepage shows the first few rows and the most
            urgent attention items, never the whole fleet. */}
        <Link
          href="/dashboard/deployments"
          className="inline-flex items-center gap-1 self-start rounded-md text-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          View all deployments
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </section>
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

function ErrorState({ onRetry }: { onRetry: () => void }) {
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
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </section>
  );
}
