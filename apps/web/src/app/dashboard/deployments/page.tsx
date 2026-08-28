'use client';

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

// §23 the fleet dashboard — the vendor's primary recurring-value view.
// Customer / Version / Region / Status, exactly as §23 specifies. §46
// vocabulary only (no raw AWS/CFN/ECS terms); M14: deployment health only,
// no app observability. Bulk deploy is not MVP scope, so the list carries no
// selection controls.
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
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Deployments</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every customer installation of your app, in one place.
          </p>
        </div>
        {/* The empty state owns the sole call to action; a header copy of it
            would show the same button twice on one screen. */}
        {state.status === 'empty' ? null : (
          <Button asChild size="sm">
            <Link href="/dashboard/deployments/new">Create Customer Deployment</Link>
          </Button>
        )}
      </div>

      {state.status === 'loading' ? <LoadingState /> : null}
      {state.status === 'error' ? (
        <ErrorState message={state.message} onRetry={() => setAttempt((n) => n + 1)} />
      ) : null}
      {state.status === 'empty' ? <EmptyState /> : null}
      {state.status === 'loaded' ? <FleetTable deployments={state.deployments} /> : null}
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

// §43 the post-onboarding empty-state product experience — exact copy.
function EmptyState() {
  return (
    <section
      aria-labelledby="empty-deployments"
      className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center"
    >
      <h2 id="empty-deployments" className="text-lg font-semibold">
        Your app is ready for private deployment
      </h2>
      <p className="max-w-md text-sm text-muted-foreground">
        Give your next customer their own AWS deployment.
      </p>
      <div className="mt-2 flex flex-col items-center gap-3 sm:flex-row">
        <Button asChild>
          <Link href="/dashboard/deployments/new">Create Customer Deployment</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/dashboard/applications">View Test Deployment</Link>
        </Button>
        <Button asChild variant="ghost">
          <Link href="/dashboard/applications">Create Release</Link>
        </Button>
      </div>
    </section>
  );
}

function FleetTable({ deployments }: { deployments: FleetDeployment[] }) {
  return (
    <Card>
      <CardContent className="overflow-x-auto p-0">
        <table className="w-full text-sm" data-testid="deployment-list">
          <thead>
            <tr className="border-b text-left">
              <th className="px-4 py-2.5 font-medium">Customer</th>
              <th className="px-2 py-2.5 font-medium">Version</th>
              <th className="px-2 py-2.5 font-medium">Region</th>
              <th className="px-2 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {deployments.map((deployment) => (
              <tr key={deployment.id} className="border-b last:border-0 hover:bg-accent/50">
                <td className="px-4 py-3">
                  <Link
                    href={`/dashboard/deployments/${deployment.id}`}
                    className="font-medium hover:underline"
                  >
                    {deployment.customerName}
                  </Link>
                  <p className="text-xs text-muted-foreground">{deployment.applicationName}</p>
                </td>
                <td className="px-2 py-3 text-muted-foreground">
                  {deployment.version ?? '—'}
                </td>
                <td className="px-2 py-3 text-muted-foreground">{deployment.region}</td>
                <td className="px-2 py-3">
                  <DeploymentStatusBadge state={deployment.state} />
                  {/* Relay connectivity is observed (last check-in), never
                      inferred from the lifecycle state above. */}
                  {deployment.relayStatus === 'DISCONNECTED' ? (
                    <p className="mt-0.5 text-xs text-destructive">Relay offline</p>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
