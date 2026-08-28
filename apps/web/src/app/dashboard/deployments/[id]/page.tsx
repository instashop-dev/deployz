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
import { errorMessage } from '@/lib/api-client';
import {
  deployRelease,
  destroyDeployment,
  fetchDeployment,
  fetchDeploymentEvents,
  isDeploymentNotFound,
  resetRelay,
  rollbackDeployment,
  type ActivityEvent,
  type FleetDeploymentDetail,
  type HealthStatus,
  type RelayCapabilities,
} from '@/lib/deployments';
import {
  RELAY_STATUS_LABEL,
  UNSUPPORTED_ACTION_COPY,
  actionSupported,
  type RelayStatus,
} from '@/lib/deployment-vocabulary';
import { DOMAIN_STATUS_LABEL } from '@/lib/domains';
import {
  NO_DEPLOYABLE_RELEASES_COPY,
  deployableReleases,
  fetchReleases,
  type Release,
} from '@/lib/releases';

type DetailState =
  | { status: 'loading' }
  | { status: 'error'; message: string; notFound: boolean }
  | {
      status: 'loaded';
      detail: FleetDeploymentDetail;
      events: ActivityEvent[];
      releases: Release[];
    };

const HEALTH_LABEL: Record<HealthStatus, string> = {
  UNKNOWN: 'Not reported',
  HEALTHY: 'Healthy',
  DEGRADED: 'Degraded',
  UNHEALTHY: 'Unhealthy',
};

const HEALTH_DOT: Record<HealthStatus, string> = {
  UNKNOWN: 'bg-muted-foreground',
  HEALTHY: 'bg-primary',
  DEGRADED: 'bg-amber-500',
  UNHEALTHY: 'bg-destructive',
};

/** The components a relay can report, in the order they are shown. */
const COMPONENT_LABELS = [
  ['application', 'Application'],
  ['database', 'Database'],
  ['redis', 'Redis'],
  ['storage', 'Storage'],
  ['loadBalancer', 'Load Balancer'],
] as const;

const RELAY_DOT: Record<RelayStatus, string> = {
  CONNECTED: 'bg-primary',
  DISCONNECTED: 'bg-destructive',
  UNKNOWN: 'bg-muted-foreground',
};

const NO_PREVIOUS_RELEASE_COPY = 'No previous successful release to roll back to.';

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
    } catch (caught) {
      // A 404 is permanent for this URL — no retry-oriented copy for it.
      setState(
        isDeploymentNotFound(caught)
          ? {
              status: 'error',
              notFound: true,
              message: "This deployment doesn't exist or you don't have access to it.",
            }
          : {
              status: 'error',
              notFound: false,
              message: "We couldn't load this deployment. Try again in a moment.",
            },
      );
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/dashboard/deployments">
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
            {state.notFound ? 'Deployment not found' : 'Something went wrong'}
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
            {detail.customDomain?.status === 'active' ? (
              <MetaRow label="URL" value={`https://${detail.customDomain.hostname}`} />
            ) : null}
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

      {detail.customDomain ? (
        <section aria-labelledby="custom-domain" className="flex flex-col gap-3">
          <h2 id="custom-domain" className="text-base font-semibold">
            Custom domain
          </h2>
          <Card>
            <CardContent className="flex flex-wrap items-center gap-3 py-4">
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm">
                {detail.customDomain.hostname}
              </code>
              <span className="text-sm text-muted-foreground">
                {DOMAIN_STATUS_LABEL[detail.customDomain.status]}
              </span>
              <Button asChild size="sm" variant="ghost" className="ml-auto">
                <Link href={`/install/${detail.installLinkId}`}>Manage →</Link>
              </Button>
            </CardContent>
          </Card>
        </section>
      ) : null}

      {detail.state === 'NOT_INSTALLED' ? <InstallLinkCard detail={detail} /> : null}

      <section aria-labelledby="infrastructure" className="flex flex-col gap-3">
        <h2 id="infrastructure" className="text-base font-semibold">
          Infrastructure
        </h2>
        {/*
          Only components the relay has actually reported on. These four rows
          used to render the SAME single healthStatus column four times — a
          value the database defaulted to HEALTHY at row creation — so a
          deployment with nothing provisioned showed four green ticks, and a
          Database row appeared for applications that have no database.
        */}
        <ul className="flex flex-col gap-2">
          {COMPONENT_LABELS.filter(([key]) => detail.components?.[key] !== undefined).map(
            ([key, label]) => (
              <InfraRow key={key} label={label} status={detail.components![key]!} />
            ),
          )}
          <RelayRow status={detail.relayStatus} />
        </ul>
        {detail.components === null ? (
          <p className="text-sm text-muted-foreground">
            No health reports yet — this deployment has not checked in.
          </p>
        ) : null}
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

function InfraRow({ label, status }: { label: string; status: HealthStatus }) {
  return (
    <li className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
      <span className={`size-2 shrink-0 rounded-full ${HEALTH_DOT[status]}`} aria-hidden />
      <span className="text-sm font-medium">{label}</span>
      <span className="ml-auto text-sm text-muted-foreground">{HEALTH_LABEL[status]}</span>
    </li>
  );
}

function RelayRow({ status }: { status: RelayStatus }) {
  return (
    <li className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
      <span className={`size-2 shrink-0 rounded-full ${RELAY_DOT[status]}`} aria-hidden />
      <span className="text-sm font-medium">Deployz Relay</span>
      <span className="ml-auto text-sm text-muted-foreground">{RELAY_STATUS_LABEL[status]}</span>
    </li>
  );
}

// §24 the five required actions. Day-2 actions are gated on the installed
// relay advertising the matching capability — an enabled button over a stub
// executor would report success having done nothing.
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
  const capabilities: RelayCapabilities | null = detail.relayCapabilities;
  const canDeploy = actionSupported(capabilities, 'deploy');
  const canRollback = actionSupported(capabilities, 'rollback');
  const canConfig = actionSupported(capabilities, 'configUpdate');
  const canDisconnect = actionSupported(capabilities, 'disconnect');
  const anyGatedOff = !canDeploy || !canRollback || !canConfig || !canDisconnect;
  const hasPreviousRelease = detail.previousReleaseId !== null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={!canDeploy}
          onClick={() => setOpen(open === 'deploy' ? null : 'deploy')}
        >
          Deploy Update
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!canRollback || !hasPreviousRelease}
          onClick={() => setOpen(open === 'rollback' ? null : 'rollback')}
        >
          Rollback
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href={`/dashboard/deployments/${detail.id}/diagnostics`}>View Diagnostics</Link>
        </Button>
        {canConfig ? (
          <Button asChild size="sm" variant="outline">
            <Link
              href={`/dashboard/applications/${detail.applicationId}/config?customer=${detail.customerId}`}
            >
              Configuration
            </Link>
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled>
            Configuration
          </Button>
        )}
        <Button
          size="sm"
          variant="destructive"
          disabled={!canDisconnect}
          onClick={() => setOpen(open === 'disconnect' ? null : 'disconnect')}
        >
          Disconnect Deployment
        </Button>
      </div>

      {anyGatedOff ? (
        <p className="text-sm text-muted-foreground">{UNSUPPORTED_ACTION_COPY}</p>
      ) : null}
      {!hasPreviousRelease ? (
        <p className="text-sm text-muted-foreground">{NO_PREVIOUS_RELEASE_COPY}</p>
      ) : null}

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
  const candidates = deployableReleases(releases, currentReleaseId);
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
          <p className="text-sm text-muted-foreground">{NO_DEPLOYABLE_RELEASES_COPY}</p>
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
                  {release.version}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-3">
              <Button size="sm" disabled={pending || !releaseId} onClick={onSubmit}>
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

/**
 * §67 step 8 — the install link, after the moment it was created.
 *
 * It used to appear only on the success screen right after creating the
 * deployment: not on this page, not on the customers table, nowhere. A vendor
 * who closed that tab, or whose customer lost the email, had no way to get it
 * back, which made sending a customer their install link a one-shot.
 */
function InstallLinkCard({ detail }: { detail: FleetDeploymentDetail }) {
  const [copied, setCopied] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url =
    typeof window === 'undefined'
      ? ''
      : `${window.location.origin}/install/${detail.installLinkId}`;

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Copying failed. Select the link and copy it by hand.');
    }
  }

  async function reconnect(): Promise<void> {
    setResetting(true);
    setError(null);
    try {
      await resetRelay(detail.id);
      window.location.reload();
    } catch (caught) {
      setError(errorMessage(caught));
      setResetting(false);
    }
  }

  return (
    <section aria-labelledby="install-link" className="flex flex-col gap-3">
      <h2 id="install-link" className="text-base font-semibold">
        Install link
      </h2>
      <Card>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Send this to {detail.customerName}. They sign in to their own cloud account — their
            credentials never touch Deployz.
          </p>
          <code className="block overflow-x-auto rounded-lg border bg-muted px-3 py-2 font-mono text-xs">
            {url}
          </code>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" onClick={copy}>
              {copied ? 'Copied' : 'Copy link'}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={resetting} onClick={reconnect}>
              {resetting ? 'Reconnecting…' : 'Reconnect relay'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Reconnecting issues a new link and stops the old one working. Use it if the customer
            needs to install again.
          </p>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}
