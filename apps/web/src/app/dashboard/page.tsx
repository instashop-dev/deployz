'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { DeploymentStatusBadge } from '@/components/deployment-status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  BULK_DEPLOYABLE_STATES,
  deployBulk,
  fetchDeployments,
  type FleetDeployment,
} from '@/lib/deployments';
import { fetchReleases, releaseStatusLabel, type Release } from '@/lib/releases';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'empty' }
  | { status: 'loaded'; deployments: FleetDeployment[] };

// §23 the fleet dashboard — the vendor's primary recurring-value view.
// Customer / Version / Region / Status, exactly as §23 specifies. §46
// vocabulary only (no raw AWS/CFN/ECS terms); M14: deployment health only,
// no app observability. §25: a vendor can select one, several, or all
// compatible customers and deploy a release to them at once.
export default function DeploymentsPage() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());

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

  function reload(): void {
    setSelected(new Set());
    setAttempt((n) => n + 1);
  }

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
      {state.status === 'loaded' ? (
        <FleetTable
          deployments={state.deployments}
          selected={selected}
          onSelectedChange={setSelected}
          onChanged={reload}
        />
      ) : null}
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

function FleetTable({
  deployments,
  selected,
  onSelectedChange,
  onChanged,
}: {
  deployments: FleetDeployment[];
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
  onChanged: () => void;
}) {
  const deployableIds = useMemo(
    () =>
      new Set(
        deployments
          .filter((d) => BULK_DEPLOYABLE_STATES.includes(d.state))
          .map((d) => d.id),
      ),
    [deployments],
  );
  const allDeployableSelected =
    deployableIds.size > 0 && [...deployableIds].every((id) => selected.has(id));

  function toggleAll(): void {
    onSelectedChange(allDeployableSelected ? new Set() : new Set(deployableIds));
  }

  function toggleOne(id: string): void {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectedChange(next);
  }

  const selectedDeployments = deployments.filter((d) => selected.has(d.id));

  return (
    <div className="flex flex-col gap-3">
      {selectedDeployments.length > 0 ? (
        <BulkDeployBar
          selected={selectedDeployments}
          onDone={() => {
            onSelectedChange(new Set());
            onChanged();
          }}
          onCancel={() => onSelectedChange(new Set())}
        />
      ) : null}

      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm" data-testid="deployment-list">
            <thead>
              <tr className="border-b text-left">
                <th className="w-10 px-4 py-2.5">
                  <input
                    type="checkbox"
                    aria-label="Select all deployable customers"
                    checked={allDeployableSelected}
                    disabled={deployableIds.size === 0}
                    onChange={toggleAll}
                  />
                </th>
                <th className="px-2 py-2.5 font-medium">Customer</th>
                <th className="px-2 py-2.5 font-medium">Version</th>
                <th className="px-2 py-2.5 font-medium">Region</th>
                <th className="px-2 py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {deployments.map((deployment) => (
                <tr key={deployment.id} className="border-b last:border-0 hover:bg-accent/50">
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      aria-label={`Select ${deployment.customerName}`}
                      checked={selected.has(deployment.id)}
                      disabled={!deployableIds.has(deployment.id)}
                      onChange={() => toggleOne(deployment.id)}
                    />
                  </td>
                  <td className="px-2 py-3">
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

// §25 upgrade workflow — deploy a release to one, several, or all compatible
// (HEALTHY / UPDATE_AVAILABLE) customers via POST /api/applications/:id/deploy-bulk.
// deploy-bulk is scoped to a single application, so a mixed-application
// selection is called out rather than silently deploying to the wrong app.
function BulkDeployBar({
  selected,
  onDone,
  onCancel,
}: {
  selected: FleetDeployment[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const applicationIds = useMemo(
    () => [...new Set(selected.map((d) => d.applicationId))],
    [selected],
  );
  const singleApplicationId = applicationIds.length === 1 ? applicationIds[0]! : null;

  const [releases, setReleases] = useState<Release[] | null>(null);
  const [releaseId, setReleaseId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setReleases(null);
    setReleaseId('');
    if (!singleApplicationId) return;
    async function load(): Promise<void> {
      try {
        const rows = await fetchReleases(singleApplicationId!);
        if (cancelled) return;
        setReleases(rows);
        setReleaseId(rows[0]?.id ?? '');
      } catch {
        if (!cancelled) setReleases([]);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [singleApplicationId]);

  async function onDeploy(): Promise<void> {
    if (!singleApplicationId || !releaseId) return;
    setPending(true);
    setError(null);
    try {
      await deployBulk(
        singleApplicationId,
        releaseId,
        selected.map((d) => d.id),
      );
      onDone();
    } catch {
      setError("We couldn't start this deployment. Try again in a moment.");
      setPending(false);
    }
  }

  return (
    <Card data-testid="bulk-deploy-bar">
      <CardContent className="flex flex-wrap items-center gap-3 py-3">
        <p className="text-sm font-medium">
          {selected.length} {selected.length === 1 ? 'customer' : 'customers'} selected
        </p>
        {!singleApplicationId ? (
          <p className="text-sm text-muted-foreground">
            Select customers for a single application to deploy a release to them together.
          </p>
        ) : releases === null ? (
          <p className="text-sm text-muted-foreground">Loading releases…</p>
        ) : releases.length === 0 ? (
          <p className="text-sm text-muted-foreground">This application has no releases yet.</p>
        ) : (
          <>
            <select
              aria-label="Release to deploy"
              className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none"
              value={releaseId}
              onChange={(event) => setReleaseId(event.target.value)}
            >
              {releases.map((release) => (
                <option key={release.id} value={release.id}>
                  {release.version} ({releaseStatusLabel(release.status)})
                </option>
              ))}
            </select>
            <Button size="sm" disabled={pending} onClick={onDeploy}>
              {pending ? 'Deploying…' : 'Deploy release'}
            </Button>
          </>
        )}
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Clear selection
        </Button>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
