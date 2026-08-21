'use client';

import { MapPin } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { DeploymentStatusBadge } from '@/components/deployment-status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchDeployments, type FleetDeployment } from '@/lib/deployments';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'empty' }
  | { status: 'loaded'; deployments: FleetDeployment[] };

// The fleet dashboard — the vendor's primary view of their customers'
// deployments. §46 vocabulary only (no raw AWS/CFN/ECS terms); M14:
// deployment health only, no app observability. The deployments endpoint may
// not exist yet, so fetchDeployments falls back to fixture data on a 404.
export default function DeploymentsPage() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function run(): Promise<void> {
      try {
        const deployments = await fetchDeployments();
        if (cancelled) return;
        setState(
          deployments.length === 0
            ? { status: 'empty' }
            : { status: 'loaded', deployments },
        );
      } catch {
        if (!cancelled) {
          setState({
            status: 'error',
            message: "We couldn't load your deployments. Try again in a moment.",
          });
        }
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Deployments</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every customer installation of your app, in one place.
        </p>
      </div>

      {state.status === 'loading' ? <LoadingState /> : null}
      {state.status === 'error' ? (
        <ErrorState message={state.message} onRetry={() => setAttempt((n) => n + 1)} />
      ) : null}
      {state.status === 'empty' ? <EmptyState /> : null}
      {state.status === 'loaded' ? <DeploymentList deployments={state.deployments} /> : null}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-col gap-3" data-testid="deployments-loading">
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-24 w-full rounded-xl" />
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section
      aria-labelledby="deployments-error"
      className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center"
    >
      <h2 id="deployments-error" className="text-lg font-semibold">
        Something went wrong
      </h2>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </section>
  );
}

// §43 empty state — preserved verbatim from the placeholder it replaces.
function EmptyState() {
  return (
    <>
      <section
        aria-labelledby="empty-deployments"
        className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center"
      >
        <h2 id="empty-deployments" className="text-lg font-semibold">
          No deployments yet
        </h2>
        <p className="max-w-md text-sm text-muted-foreground">
          When a customer installs your app, their deployment shows up here with its status and
          health. Add your first customer to get started.
        </p>
        <div className="mt-2 flex flex-col items-center gap-3 sm:flex-row">
          <Button asChild>
            <Link href="/dashboard/customers">Add your first customer</Link>
          </Button>
          <Button asChild variant="ghost">
            <Link href="#how-it-works">Learn how it works</Link>
          </Button>
        </div>
      </section>

      <section aria-labelledby="how-it-works" className="flex flex-col gap-3">
        <h2 id="how-it-works" className="text-base font-semibold">
          How it works
        </h2>
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-muted-foreground">
          <li>Connect your repository — we check that your app is ready to deploy.</li>
          <li>
            Your customer opens your install link and signs in to their own cloud account. Their
            credentials never touch Deployz.
          </li>
          <li>Their deployment appears here, and we keep it healthy and up to date.</li>
        </ol>
      </section>
    </>
  );
}

function DeploymentList({ deployments }: { deployments: FleetDeployment[] }) {
  return (
    <ul className="flex flex-col gap-3" data-testid="deployment-list">
      {deployments.map((deployment) => (
        <li key={deployment.id}>
          <Link
            href={`/dashboard/deployments/${encodeURIComponent(deployment.id)}`}
            className="block"
          >
            <Card className="transition-colors hover:bg-accent/50">
              <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2.5">
                    <p className="truncate font-medium">{deployment.name}</p>
                    <DeploymentStatusBadge state={deployment.state} />
                  </div>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {deployment.customer}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-4 text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <MapPin className="size-4" aria-hidden />
                    {deployment.region}
                  </span>
                  <span>
                    {deployment.lastHealthAt
                      ? `Checked ${formatRelative(deployment.lastHealthAt)}`
                      : 'Not checked in yet'}
                  </span>
                </div>
              </CardContent>
            </Card>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const deltaMs = Date.now() - then;
  const minutes = Math.max(1, Math.round(deltaMs / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
