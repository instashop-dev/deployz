'use client';

import { AlertTriangle, ArrowLeft, ChevronDown, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import { ActivityFeed } from '@/components/activity-feed';
import { DeploymentStatusBadge } from '@/components/deployment-status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage } from '@/lib/api-client';
import {
  deployRelease,
  destroyDeployment,
  fetchDeployment,
  fetchDeploymentEvents,
  isDeploymentNotFound,
  resetRelay,
  restartDeployment,
  retryInstall,
  rollbackDeployment,
  type ActivityEvent,
  type FleetDeploymentDetail,
  type RelayCapabilities,
} from '@/lib/deployments';
import {
  HEALTH_STATUS_BADGE,
  HEALTH_STATUS_DOT,
  HEALTH_STATUS_LABEL,
  NOT_YET_RUNNING_ACTION_COPY,
  RELAY_STATUS_LABEL,
  UNSUPPORTED_ACTION_COPY,
  actionSupported,
  everInstalled,
  showHealthBadge,
  showInfrastructureRows,
  type HealthStatus,
  type RelayStatus,
} from '@/lib/deployment-vocabulary';
import { DOMAIN_STATUS_LABEL } from '@/lib/domains';
import { REDIS_STATUS_LABEL, redisProvisioningStatus, readInfraChecks, type RedisProvisioningStatus } from '@/lib/diagnostics';
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

const REDIS_DOT: Record<RedisProvisioningStatus, string> = {
  HEALTHY: 'bg-primary',
  UNHEALTHY: 'bg-destructive',
  NOT_PROVISIONED: 'bg-muted-foreground',
  NOT_REPORTING: 'bg-muted-foreground',
};

const NO_PREVIOUS_RELEASE_COPY = 'No previous successful release to roll back to.';

// §24 deployment detail — all five required actions (Deploy Update, Rollback,
// View Diagnostics, Configuration, Disconnect Deployment), the masked AWS
// account + Created date, and the five named infrastructure rows (Application,
// Database, Storage, Load Balancer, Deployz Relay), organized into
// Overview / Infrastructure / Activity tabs. M14: deployment health only — no
// application observability.
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
    <div className="flex flex-col gap-6">
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
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{detail.applicationName}</h1>
          <DeploymentStatusBadge state={detail.state} />
          {showHealthBadge(detail.state, detail.currentReleaseId) ? (
            <Badge variant={HEALTH_STATUS_BADGE[detail.healthStatus]}>
              {HEALTH_STATUS_LABEL[detail.healthStatus]}
            </Badge>
          ) : null}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{detail.customerName}</p>
        {detail.version ? (
          <p className="mt-0.5 text-sm text-muted-foreground">
            v{detail.version} · {detail.region}
          </p>
        ) : (
          <p className="mt-0.5 text-sm text-muted-foreground">{detail.region}</p>
        )}
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

      {detail.state === 'NOT_INSTALLED' ? <InstallLinkCard detail={detail} /> : null}

      {/* Stacked sections rather than tabs: everything a vendor debugging a
          deployment needs stays visible without an extra click, and the
          committed E2E contract reads this page as one scroll. */}
      <section aria-labelledby="overview" className="flex flex-col gap-3">
        <h2 id="overview" className="text-base font-semibold">
          Overview
        </h2>
        <Card>
          <CardContent className="flex flex-col gap-3 py-4">
            {detail.appUrl ? <AppUrlRow url={detail.appUrl} /> : null}
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

      <DomainSection detail={detail} />

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
          Redis is deliberately excluded here: its row comes from observed
          provisioning, not the component map (see RedisRow below).
        */}
        {showInfrastructureRows(detail.state, detail.currentReleaseId) ? (
          <>
            <ul className="flex flex-col gap-2">
              {COMPONENT_LABELS.filter(
                ([key]) => key !== 'redis' && detail.components?.[key] !== undefined,
              ).map(([key, label]) => (
                <InfraRow key={key} label={label} status={detail.components![key]!} />
              ))}
              <RedisRow
                status={redisProvisioningStatus(
                  detail.components?.['redis'],
                  readInfraChecks(detail.observedState),
                )}
              />
              <RelayRow status={detail.relayStatus} />
            </ul>
            {detail.components === null ? (
              <p className="text-sm text-muted-foreground">
                No health reports yet — this deployment has not checked in.
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {detail.state === 'NOT_INSTALLED'
              ? 'This deployment has not been installed yet.'
              : detail.state === 'FAILED'
                ? "This deployment isn't running, so there's nothing to report."
                : 'This deployment has been removed.'}
          </p>
        )}
        <AwsDetails detail={detail} />
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
      <span className={`size-2 shrink-0 rounded-full ${HEALTH_STATUS_DOT[status]}`} aria-hidden />
      <span className="text-sm font-medium">{label}</span>
      <span className="ml-auto text-sm text-muted-foreground">{HEALTH_STATUS_LABEL[status]}</span>
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

function RedisRow({ status }: { status: RedisProvisioningStatus | null }) {
  if (status === null) return null;
  return (
    <li className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
      <span className={`size-2 shrink-0 rounded-full ${REDIS_DOT[status]}`} aria-hidden />
      <span className="text-sm font-medium">Redis</span>
      <span className="ml-auto text-sm text-muted-foreground">{REDIS_STATUS_LABEL[status]}</span>
    </li>
  );
}

// §25 — implementation detail progressively disclosed under "AWS details".
// Nothing here is required reading; the product-level rows above carry the
// state that matters.
function AwsDetails({ detail }: { detail: FleetDeploymentDetail }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        AWS details
        <ChevronDown
          aria-hidden
          className="size-4 transition-transform group-data-[state=open]:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Card className="mt-2">
          <CardContent className="flex flex-col gap-2 py-4">
            <MetaRow label="AWS account" value={detail.awsAccountId ?? 'Not connected yet'} />
            <MetaRow label="Region" value={detail.region} />
            {detail.infraVersion ? (
              <MetaRow label="Infrastructure version" value={detail.infraVersion} />
            ) : null}
          </CardContent>
        </Card>
      </CollapsibleContent>
    </Collapsible>
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
  const [open, setOpen] = useState<
    'deploy' | 'rollback' | 'restart' | 'disconnect' | 'retryInstall' | null
  >(null);
  const capabilities: RelayCapabilities | null = detail.relayCapabilities;
  // §24: deploy/rollback/restart/config all act on a running application, so
  // they are gated on TWO independent signals — the relay-reported
  // capability, and whether this deployment has ever completed an install
  // (a relay can connect and advertise capabilities before that happens).
  // Disconnect is exempt from the second gate: a deployment that failed to
  // ever come up must still be removable.
  const everRan = everInstalled(detail.state, detail.currentReleaseId);
  const canDeploy = everRan && actionSupported(capabilities, 'deploy');
  const canRollback = everRan && actionSupported(capabilities, 'rollback');
  const canRestart = everRan && actionSupported(capabilities, 'restart');
  const canConfig = everRan && actionSupported(capabilities, 'configUpdate');
  const canDisconnect = actionSupported(capabilities, 'disconnect');
  // Recovery for a failed FIRST install: the API refuses it once any install
  // has succeeded, so it is offered exactly where the day-2 actions are not.
  const canRetryInstall = detail.state === 'FAILED' && !everRan;
  const anyCapabilityGatedOff =
    everRan && (!canDeploy || !canRollback || !canRestart || !canConfig || !canDisconnect);
  const hasPreviousRelease = detail.previousReleaseId !== null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {detail.appUrl ? (
          <Button asChild size="sm" variant="outline">
            <a href={detail.appUrl} target="_blank" rel="noreferrer">
              Open app
              <ExternalLink aria-hidden />
            </a>
          </Button>
        ) : null}
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
        <Button
          size="sm"
          variant="outline"
          disabled={!canRestart}
          onClick={() => setOpen(open === 'restart' ? null : 'restart')}
        >
          Restart
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
        {canRetryInstall ? (
          <Button
            size="sm"
            onClick={() => setOpen(open === 'retryInstall' ? null : 'retryInstall')}
          >
            Retry Install
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="destructive"
          disabled={!canDisconnect}
          onClick={() => setOpen(open === 'disconnect' ? null : 'disconnect')}
        >
          Disconnect Deployment
        </Button>
      </div>

      {!everRan ? (
        <p className="text-sm text-muted-foreground">{NOT_YET_RUNNING_ACTION_COPY}</p>
      ) : anyCapabilityGatedOff ? (
        <p className="text-sm text-muted-foreground">{UNSUPPORTED_ACTION_COPY}</p>
      ) : null}
      {!hasPreviousRelease ? (
        <p className="text-sm text-muted-foreground">{NO_PREVIOUS_RELEASE_COPY}</p>
      ) : null}

      <DeployUpdateDialog
        open={open === 'deploy'}
        deploymentId={detail.id}
        applicationName={detail.applicationName}
        currentVersion={detail.version}
        releases={releases}
        currentReleaseId={detail.currentReleaseId}
        onDone={() => {
          setOpen(null);
          onChanged();
        }}
        onCancel={() => setOpen(null)}
      />

      <RollbackDialog
        open={open === 'rollback' && hasPreviousRelease}
        deploymentId={detail.id}
        previousReleaseId={detail.previousReleaseId}
        previousVersion={previousVersion}
        currentVersion={detail.version}
        onDone={() => {
          setOpen(null);
          onChanged();
        }}
        onCancel={() => setOpen(null)}
      />

      <RestartDialog
        open={open === 'restart'}
        deploymentId={detail.id}
        applicationName={detail.applicationName}
        onDone={() => {
          setOpen(null);
          onChanged();
        }}
        onCancel={() => setOpen(null)}
      />

      <RetryInstallDialog
        open={open === 'retryInstall'}
        deploymentId={detail.id}
        applicationName={detail.applicationName}
        onDone={() => {
          setOpen(null);
          onChanged();
        }}
        onCancel={() => setOpen(null)}
      />

      <DisconnectDialog
        open={open === 'disconnect'}
        deploymentId={detail.id}
        customerName={detail.customerName}
        onDone={() => {
          setOpen(null);
          onChanged();
        }}
        onCancel={() => setOpen(null)}
      />
    </div>
  );
}

function OperationError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  );
}

function DeployUpdateDialog({
  open,
  deploymentId,
  applicationName,
  currentVersion,
  releases,
  currentReleaseId,
  onDone,
  onCancel,
}: {
  open: boolean;
  deploymentId: string;
  applicationName: string;
  currentVersion: string | null;
  releases: Release[];
  currentReleaseId: string | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const candidates = deployableReleases(releases, currentReleaseId);
  const [releaseId, setReleaseId] = useState(candidates[0]?.id ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = candidates.find((release) => release.id === releaseId);

  async function onConfirm(): Promise<void> {
    if (!releaseId) return;
    setPending(true);
    setError(null);
    try {
      await deployRelease(deploymentId, releaseId);
      toast.success('Update requested');
      onDone();
    } catch {
      setError("We couldn't start this update. Try again in a moment.");
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent data-testid="deploy-update-panel" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Deploy update</DialogTitle>
          <DialogDescription>
            Pick the release to deploy to {applicationName}.
          </DialogDescription>
        </DialogHeader>
        {candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">{NO_DEPLOYABLE_RELEASES_COPY}</p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 rounded-lg border px-3 py-2.5 text-sm">
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Current</span>
                <span className="font-medium">{currentVersion ? `v${currentVersion}` : '—'}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">New</span>
                <span className="font-medium">{selected ? `v${selected.version}` : '—'}</span>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="release-to-deploy">Release to deploy</Label>
              <Select value={releaseId} onValueChange={setReleaseId}>
                <SelectTrigger id="release-to-deploy" className="w-full">
                  <SelectValue placeholder="Pick a release" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((release) => (
                    <SelectItem key={release.id} value={release.id}>
                      v{release.version}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Alert>
              <AlertTriangle aria-hidden />
              <AlertTitle>The application will restart behind the load balancer.</AlertTitle>
              <AlertDescription>
                Deployz updates the application while preserving existing persistent resources
                according to current behavior.
              </AlertDescription>
            </Alert>
            <OperationError error={error} />
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={!releaseId || pending} onClick={onConfirm}>
            {pending ? 'Starting…' : 'Deploy update'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RollbackDialog({
  open,
  deploymentId,
  previousReleaseId,
  previousVersion,
  currentVersion,
  onDone,
  onCancel,
}: {
  open: boolean;
  deploymentId: string;
  previousReleaseId: string | null;
  previousVersion: string | null;
  currentVersion: string | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onConfirm(): Promise<void> {
    if (!previousReleaseId) return;
    setPending(true);
    setError(null);
    try {
      await rollbackDeployment(deploymentId, previousReleaseId);
      toast.success('Rollback requested');
      onDone();
    } catch {
      setError("We couldn't start the rollback. Try again in a moment.");
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <AlertDialogContent data-testid="rollback-panel">
        <AlertDialogHeader>
          <AlertDialogTitle>Rollback deployment?</AlertDialogTitle>
          <AlertDialogDescription>
            The application returns to its previous release.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-3 rounded-lg border px-3 py-2.5 text-sm">
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">Current version</span>
            <span className="font-medium">{currentVersion ? `v${currentVersion}` : '—'}</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">Rollback to</span>
            <span className="font-medium">
              {previousVersion ? `v${previousVersion}` : 'the previous version'}
            </span>
          </div>
        </div>
        {/* §26 required copy — verbatim. */}
        <Alert variant="destructive">
          <AlertTriangle aria-hidden />
          <AlertTitle>Application rollback does not automatically reverse database migrations.</AlertTitle>
        </Alert>
        <OperationError error={error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={(event) => {
              event.preventDefault();
              void onConfirm();
            }}
          >
            {pending ? 'Rolling back…' : 'Rollback'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RestartDialog({
  open,
  deploymentId,
  applicationName,
  onDone,
  onCancel,
}: {
  open: boolean;
  deploymentId: string;
  applicationName: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onConfirm(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await restartDeployment(deploymentId);
      toast.success('Restart requested');
      onDone();
    } catch {
      setError("We couldn't restart this application. Try again in a moment.");
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <AlertDialogContent data-testid="restart-panel">
        <AlertDialogHeader>
          <AlertDialogTitle>Restart {applicationName}?</AlertDialogTitle>
          <AlertDialogDescription>
            The application will restart behind the load balancer. The running version does not
            change.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <OperationError error={error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={(event) => {
              event.preventDefault();
              void onConfirm();
            }}
          >
            {pending ? 'Restarting…' : 'Restart'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RetryInstallDialog({
  open,
  deploymentId,
  applicationName,
  onDone,
  onCancel,
}: {
  open: boolean;
  deploymentId: string;
  applicationName: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onConfirm(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await retryInstall(deploymentId);
      toast.success('Retry requested');
      onDone();
    } catch {
      setError("We couldn't start the retry. Try again in a moment.");
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <AlertDialogContent data-testid="retry-install-panel">
        <AlertDialogHeader>
          <AlertDialogTitle>Retry installing {applicationName}?</AlertDialogTitle>
          <AlertDialogDescription>
            The failed infrastructure from the previous attempt is removed from the
            customer&apos;s account first, then the install runs again. Nothing from this
            deployment was ever in use, so no data is lost.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <OperationError error={error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={(event) => {
              event.preventDefault();
              void onConfirm();
            }}
          >
            {pending ? 'Starting…' : 'Retry install'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DisconnectDialog({
  open,
  deploymentId,
  customerName,
  onDone,
  onCancel,
}: {
  open: boolean;
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
      toast.success('Disconnect requested');
      onDone();
    } catch {
      setError("We couldn't disconnect this deployment. Try again in a moment.");
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <AlertDialogContent data-testid="disconnect-panel" className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-destructive">
            Disconnect {customerName}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Disconnecting removes the running application and its networking.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-1 text-sm text-muted-foreground">
          <p>Your database, stored files, and backups will be retained.</p>
          <p>The Deployz connector remains installed.</p>
          <p>This stops the $19/month charge for this deployment.</p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="disconnect-confirm">
            Type <span className="font-medium text-foreground">{customerName}</span> to confirm.
          </Label>
          <Input
            id="disconnect-confirm"
            value={confirmText}
            onChange={(event) => setConfirmText(event.target.value)}
            aria-label={`Type ${customerName} to confirm`}
            autoComplete="off"
          />
        </div>
        <OperationError error={error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={!confirmed || pending}
            onClick={(event) => {
              event.preventDefault();
              void onConfirm();
            }}
          >
            {pending ? 'Disconnecting…' : 'Disconnect Deployment'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function MetaRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{value}</dd>
    </div>
  );
}

function AppUrlRow({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can fail (permissions, insecure context); the link
      // below still lets the user open or select the URL by hand.
    }
  }

  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:justify-between">
      <dt className="text-sm text-muted-foreground">URL</dt>
      <dd className="flex items-center gap-2">
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          {url}
          <ExternalLink aria-hidden className="size-3.5" />
        </a>
        <Button type="button" size="sm" variant="outline" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </dd>
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
      <Skeleton className="h-10 w-full rounded-xl" />
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

// §8.1 — domain management lives IN the dashboard, but through the install
// page's manage view: this section is the compact summary (hostname, status,
// Manage link) — add/check/remove happen where the full card already lives.
function DomainSection({ detail }: { detail: FleetDeploymentDetail }) {
  const domain = detail.customDomain;

  return (
    <section aria-labelledby="custom-domain" className="flex flex-col gap-3">
      <h2 id="custom-domain" className="text-base font-semibold">
        Custom domain
      </h2>
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 py-4">
          {domain ? (
            <>
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm">
                {domain.hostname}
              </code>
              <Badge variant={domain.status === 'error' ? 'destructive' : 'secondary'}>
                {DOMAIN_STATUS_LABEL[domain.status]}
              </Badge>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">No custom domain.</span>
          )}
          <Link
            href={`/install/${detail.installLinkId}`}
            className="ml-auto inline-flex items-center gap-1 rounded-md text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Manage →
          </Link>
        </CardContent>
      </Card>
    </section>
  );
}
