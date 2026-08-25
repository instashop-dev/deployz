'use client';

import { AlertTriangle, ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { ActivityFeed } from '@/components/activity-feed';
import { DeploymentStatusBadge } from '@/components/deployment-status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  deployRelease,
  destroyDeployment,
  fetchDeployment,
  fetchDeploymentEvents,
  rollbackDeployment,
  type ActivityEvent,
  type FleetDeploymentDetail,
  type HealthStatus,
  type RelayStatus,
} from '@/lib/deployments';
import { fetchReleases, releaseStatusLabel, type Release } from '@/lib/releases';

type DetailState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'loaded';
      detail: FleetDeploymentDetail;
      events: ActivityEvent[];
      releases: Release[];
    };

// `null` is "no health report yet" — a deployment that is not installed has
// no health to show, and calling that Healthy paints a green row for
// infrastructure that does not exist.
const HEALTH_LABEL: Record<HealthStatus | 'UNREPORTED', string> = {
  HEALTHY: 'Healthy',
  DEGRADED: 'Degraded',
  UNHEALTHY: 'Unhealthy',
  UNREPORTED: 'Not reported yet',
};

const HEALTH_DOT: Record<HealthStatus | 'UNREPORTED', string> = {
  HEALTHY: 'bg-primary',
  DEGRADED: 'bg-amber-500',
  UNHEALTHY: 'bg-destructive',
  UNREPORTED: 'bg-muted-foreground',
};

const RELAY_LABEL: Record<RelayStatus, string> = {
  CONNECTED: 'Connected',
  DISCONNECTED: 'Disconnected',
  UNKNOWN: 'Unknown',
};

const RELAY_DOT: Record<RelayStatus, string> = {
  CONNECTED: 'bg-primary',
  DISCONNECTED: 'bg-destructive',
  UNKNOWN: 'bg-muted-foreground',
};

// §24 deployment detail — all five required actions (Deploy Update, Rollback,
// View Diagnostics, Configuration, Disconnect Deployment), the masked AWS
// account + Created date, and the five named infrastructure rows (Application,
// Database, Storage, Load Balancer, Deployz Relay). M14: deployment health
// only — no application observability.
export default function DeploymentDetailPage() {
  const params = useParams();
  const id = Array.isArray(params.id) ? (params.id[0] ?? '') : (params.id ?? '');
  const [state, setState] = useState<DetailState>({ status: 'loading' });

  const load = useCallback(async (): Promise<void> => {
    try {
      const detail = await fetchDeployment(id);
      const [events, releases] = await Promise.all([
        fetchDeploymentEvents(id),
        fetchReleases(detail.applicationId),
      ]);
      setState({ status: 'loaded', detail, events, releases });
    } catch {
      setState({
        status: 'error',
        message: "We couldn't load this deployment. Try again in a moment.",
      });
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/dashboard">
            <ArrowLeft aria-hidden className="size-4" />
            Deployments
          </Link>
        </Button>
      </div>

      {state.status === 'loading' ? <DetailSkeleton /> : null}
      {state.status === 'error' ? (
        <section
          aria-labelledby="detail-error"
          className="rounded-xl border border-dashed px-6 py-16 text-center"
        >
          <h2 id="detail-error" className="text-lg font-semibold">
            Something went wrong
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
        </section>
      ) : null}
      {state.status === 'loaded' ? (
        <DetailBody
          detail={state.detail}
          events={state.events}
          releases={state.releases}
          onChanged={load}
        />
      ) : null}
    </div>
  );
}

function DetailBody({
  detail,
  events,
  releases,
  onChanged,
}: {
  detail: FleetDeploymentDetail;
  events: ActivityEvent[];
  releases: Release[];
  onChanged: () => void;
}) {
  const previousVersion = releases.find((r) => r.id === detail.previousReleaseId)?.version ?? null;

  return (
    <>
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{detail.applicationName}</h1>
          <DeploymentStatusBadge state={detail.state} />
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{detail.customerName}</p>
      </div>

      <section aria-labelledby="actions" className="flex flex-col gap-3">
        <h2 id="actions" className="sr-only">
          Actions
        </h2>
        <DeploymentActions
          detail={detail}
          releases={releases}
          previousVersion={previousVersion}
          onChanged={onChanged}
        />
      </section>

      <section aria-labelledby="overview" className="flex flex-col gap-3">
        <h2 id="overview" className="text-base font-semibold">
          Overview
        </h2>
        <Card>
          <CardContent className="flex flex-col gap-3 py-4">
            <MetaRow label="Application" value={detail.applicationName} />
            <MetaRow label="AWS account" value={detail.awsAccountId ?? 'Not connected yet'} />
            <MetaRow label="Region" value={detail.region} />
            <MetaRow label="Version" value={detail.version ?? 'Not deployed yet'} />
            <MetaRow
              label="Created"
              value={new Date(detail.createdAt).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
            />
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="infrastructure" className="flex flex-col gap-3">
        <h2 id="infrastructure" className="text-base font-semibold">
          Infrastructure
        </h2>
        <ul className="flex flex-col gap-2">
          <InfraRow label="Application" status={detail.healthStatus} />
          <InfraRow label="Database" status={detail.healthStatus} />
          <InfraRow label="Storage" status={detail.healthStatus} />
          <InfraRow label="Load Balancer" status={detail.healthStatus} />
          <RelayRow status={detail.relayStatus} />
        </ul>
      </section>

      <section aria-labelledby="activity" className="flex flex-col gap-3">
        <h2 id="activity" className="text-base font-semibold">
          Recent activity
        </h2>
        <ActivityFeed events={events} />
      </section>
    </>
  );
}

function InfraRow({ label, status }: { label: string; status: HealthStatus | null }) {
  const key = status ?? 'UNREPORTED';
  return (
    <li className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
      <span className={`size-2 shrink-0 rounded-full ${HEALTH_DOT[key]}`} aria-hidden />
      <span className="text-sm font-medium">{label}</span>
      <span className="ml-auto text-sm text-muted-foreground">{HEALTH_LABEL[key]}</span>
    </li>
  );
}

function RelayRow({ status }: { status: RelayStatus }) {
  return (
    <li className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
      <span className={`size-2 shrink-0 rounded-full ${RELAY_DOT[status]}`} aria-hidden />
      <span className="text-sm font-medium">Deployz Relay</span>
      <span className="ml-auto text-sm text-muted-foreground">{RELAY_LABEL[status]}</span>
    </li>
  );
}

// §24 the five required actions.
function DeploymentActions({
  detail,
  releases,
  previousVersion,
  onChanged,
}: {
  detail: FleetDeploymentDetail;
  releases: Release[];
  previousVersion: string | null;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<'deploy' | 'rollback' | 'disconnect' | null>(null);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => setOpen(open === 'deploy' ? null : 'deploy')}>
          Deploy Update
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!detail.previousReleaseId}
          onClick={() => setOpen(open === 'rollback' ? null : 'rollback')}
        >
          Rollback
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href={`/dashboard/deployments/${detail.id}/diagnostics`}>View Diagnostics</Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href={`/dashboard/applications/${detail.applicationId}/config?customer=${detail.customerId}`}>
            Configuration
          </Link>
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => setOpen(open === 'disconnect' ? null : 'disconnect')}
        >
          Disconnect Deployment
        </Button>
      </div>

      {open === 'deploy' ? (
        <DeployUpdatePanel
          deploymentId={detail.id}
          releases={releases}
          currentReleaseId={detail.currentReleaseId}
          onDone={() => {
            setOpen(null);
            onChanged();
          }}
          onCancel={() => setOpen(null)}
        />
      ) : null}

      {open === 'rollback' && detail.previousReleaseId ? (
        <RollbackPanel
          deploymentId={detail.id}
          previousReleaseId={detail.previousReleaseId}
          previousVersion={previousVersion}
          onDone={() => {
            setOpen(null);
            onChanged();
          }}
          onCancel={() => setOpen(null)}
        />
      ) : null}

      {open === 'disconnect' ? (
        <DisconnectPanel
          deploymentId={detail.id}
          customerName={detail.customerName}
          onDone={() => {
            setOpen(null);
            onChanged();
          }}
          onCancel={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}

function DeployUpdatePanel({
  deploymentId,
  releases,
  currentReleaseId,
  onDone,
  onCancel,
}: {
  deploymentId: string;
  releases: Release[];
  currentReleaseId: string | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const candidates = releases.filter((r) => r.id !== currentReleaseId);
  const [releaseId, setReleaseId] = useState(candidates[0]?.id ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(): Promise<void> {
    if (!releaseId) return;
    setPending(true);
    setError(null);
    try {
      await deployRelease(deploymentId, releaseId);
      onDone();
    } catch {
      setError("We couldn't start this update. Try again in a moment.");
      setPending(false);
    }
  }

  return (
    <Card data-testid="deploy-update-panel">
      <CardContent className="flex flex-col gap-3 py-4">
        <p className="text-sm font-medium">Deploy an update</p>
        {candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No other releases are available yet. Create a release first.
          </p>
        ) : (
          <>
            <select
              aria-label="Release to deploy"
              className="h-8 w-full max-w-xs rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none"
              value={releaseId}
              onChange={(event) => setReleaseId(event.target.value)}
            >
              {candidates.map((release) => (
                <option key={release.id} value={release.id}>
                  {release.version} ({releaseStatusLabel(release.status)})
                </option>
              ))}
            </select>
            <div className="flex items-center gap-3">
              <Button size="sm" disabled={pending} onClick={onSubmit}>
                {pending ? 'Starting…' : 'Deploy'}
              </Button>
              <Button size="sm" variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function RollbackPanel({
  deploymentId,
  previousReleaseId,
  previousVersion,
  onDone,
  onCancel,
}: {
  deploymentId: string;
  previousReleaseId: string;
  previousVersion: string | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onConfirm(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await rollbackDeployment(deploymentId, previousReleaseId);
      onDone();
    } catch {
      setError("We couldn't start the rollback. Try again in a moment.");
      setPending(false);
    }
  }

  return (
    <Card data-testid="rollback-panel">
      <CardContent className="flex flex-col gap-3 py-4">
        <p className="text-sm font-medium">
          Roll back to {previousVersion ?? 'the previous version'}?
        </p>
        {/* §26 required copy — verbatim. */}
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
          <p>Application rollback does not automatically reverse database migrations.</p>
        </div>
        <div className="flex items-center gap-3">
          <Button size="sm" variant="outline" disabled={pending} onClick={onConfirm}>
            {pending ? 'Rolling back…' : 'Confirm rollback'}
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function DisconnectPanel({
  deploymentId,
  customerName,
  onDone,
  onCancel,
}: {
  deploymentId: string;
  customerName: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [confirmText, setConfirmText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmed = confirmText.trim() === customerName;

  async function onConfirm(): Promise<void> {
    if (!confirmed) return;
    setPending(true);
    setError(null);
    try {
      await destroyDeployment(deploymentId);
      onDone();
    } catch {
      setError("We couldn't disconnect this deployment. Try again in a moment.");
      setPending(false);
    }
  }

  return (
    <Card data-testid="disconnect-panel" className="border-destructive/40">
      <CardContent className="flex flex-col gap-3 py-4">
        <p className="text-sm font-medium text-destructive">Disconnect {customerName}?</p>
        <p className="text-sm text-muted-foreground">
          This removes the application, database, storage, and networking Deployz created for{' '}
          {customerName}. Their AWS bootstrap stack and any retained database backups are not
          removed by this action — the customer controls those. This cannot be undone from
          Deployz, and stops the $19/month charge for this deployment.
        </p>
        <label className="flex flex-col gap-1.5 text-sm">
          Type <span className="font-medium">{customerName}</span> to confirm.
          <input
            className="h-8 w-full max-w-xs rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none"
            value={confirmText}
            onChange={(event) => setConfirmText(event.target.value)}
            aria-label={`Type ${customerName} to confirm`}
          />
        </label>
        <div className="flex items-center gap-3">
          <Button size="sm" variant="destructive" disabled={!confirmed || pending} onClick={onConfirm}>
            {pending ? 'Disconnecting…' : 'Disconnect Deployment'}
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{value}</dd>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-6" data-testid="detail-loading">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-40" />
      </div>
      <Skeleton className="h-48 w-full rounded-xl" />
      <Skeleton className="h-48 w-full rounded-xl" />
    </div>
  );
}
