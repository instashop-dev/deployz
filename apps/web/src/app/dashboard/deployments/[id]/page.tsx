'use client';

import { AlertTriangle, ArrowLeft, ChevronDown, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import { ActivityFeed } from '@/components/activity-feed';
import { DeploymentProgressCard } from '@/components/deployment-progress-card';
import { DeploymentStatusBadge } from '@/components/deployment-status-badge';
import { InfrastructureEvents } from '@/components/infrastructure-events';
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
  DESTROY_PENDING_STALE_AFTER_MS,
  DeploymentActionError,
  actionErrorMessage,
  deployRelease,
  destroyDeployment,
  fetchDeployment,
  fetchDeploymentEvents,
  fetchDeploymentInfrastructure,
  forceCompleteDisconnect,
  isDeploymentNotFound,
  purgeDeployment,
  resetRelay,
  restartDeployment,
  retryInstall,
  rollbackDeployment,
  type ActivityEvent,
  type FleetDeploymentDetail,
  type InfrastructureResponse,
  type RelayCapabilities,
} from '@/lib/deployments';
import {
  HEALTH_STATUS_BADGE,
  HEALTH_STATUS_LABEL,
  RELAY_STUCK_GUIDANCE,
  RELAY_STATUS_LABEL,
  actionSupported,
  actionsUnavailableReason,
  everInstalled,
  relayWaitingStuck,
  showHealthBadge,
  showInfrastructureRows,
  type RelayStatus,
} from '@/lib/deployment-vocabulary';
import { DOMAIN_STATUS_LABEL } from '@/lib/domains';
import { relativeTime } from '@/lib/diagnostics';
import {
  NO_DEPLOYABLE_RELEASES_COPY,
  deployableReleases,
  fetchReleases,
  type Release,
} from '@/lib/releases';
import { InfrastructureSection } from '@/components/infrastructure-section';
import { isTerminalStage } from '@/lib/deployment-progress';
import { useStatusPoll } from '@/lib/use-status-poll';

type DetailState =
  | { status: 'loading' }
  | { status: 'error'; message: string; notFound: boolean }
  | {
      status: 'loaded';
      detail: FleetDeploymentDetail;
      events: ActivityEvent[];
      releases: Release[];
    };

const RELAY_DOT: Record<RelayStatus, string> = {
  CONNECTED: 'bg-primary',
  DISCONNECTED: 'bg-destructive',
  UNKNOWN: 'bg-muted-foreground',
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
  const [infrastructure, setInfrastructure] = useState<InfrastructureResponse | null>(null);
  // Signature of the last (stage, state) pair the poll observed — refetching
  // the activity feed on every 5s tick would hammer it for nothing, so it
  // only happens when this actually moved.
  const lastSignature = useRef<{ stage: string; state: string } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const detail = await fetchDeployment(id);
      const [events, releases, infrastructure] = await Promise.all([
        fetchDeploymentEvents(id),
        fetchReleases(detail.applicationId),
        fetchDeploymentInfrastructure(id),
      ]);
      lastSignature.current = { stage: detail.deploymentStatus.stage, state: detail.state };
      setState({ status: 'loaded', detail, events, releases });
      setInfrastructure(infrastructure);
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

  // Silent background refresh of the deployment's derived status. Only the
  // `detail` object is replaced — open dialogs and in-flight actions keep
  // their own local state, so a poll tick never resets them.
  const poll = useStatusPoll({
    fetcher: () => fetchDeployment(id),
    intervalMs: 5000,
    terminalIntervalMs: 60000,
    isTerminal: (detail) => isTerminalStage(detail.deploymentStatus.stage),
    enabled: state.status === 'loaded',
  });

  useEffect(() => {
    if (poll.data === null) return;
    const detail = poll.data;
    setState((current) => (current.status === 'loaded' ? { ...current, detail } : current));

    const signature = { stage: detail.deploymentStatus.stage, state: detail.state };
    const moved =
      lastSignature.current === null ||
      lastSignature.current.stage !== signature.stage ||
      lastSignature.current.state !== signature.state;
    lastSignature.current = signature;
    if (moved) {
      void fetchDeploymentEvents(id).then((events) => {
        setState((current) => (current.status === 'loaded' ? { ...current, events } : current));
      });
    }
    // Refresh the infrastructure snapshot on every poll tick so the
    // component list stays live during disconnect.
    void fetchDeploymentInfrastructure(id).then((infrastructure) => {
      setInfrastructure(infrastructure);
    });
  }, [poll.data, id]);

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
          infrastructure={infrastructure}
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
  infrastructure,
  onChanged,
}: {
  detail: FleetDeploymentDetail;
  events: ActivityEvent[];
  releases: Release[];
  infrastructure: InfrastructureResponse | null;
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

      {detail.state === 'DELETED' && detail.cleanupState !== 'COMPLETE' ? (
        <div className="flex flex-col gap-3">
          <Alert>
            <AlertTriangle aria-hidden />
            {detail.cleanupState === 'SKIPPED_RELAY_OFFLINE' || detail.cleanupState === 'PURGE_FAILED' ? (
              <>
                <AlertTitle>Resources may remain in the customer AWS account</AlertTitle>
                <AlertDescription>
                  AWS resources may still exist because the Deployz Relay was offline during
                  disconnect.
                </AlertDescription>
              </>
            ) : (
              <>
                <AlertTitle>Retained resources remain in the customer AWS account</AlertTitle>
                <AlertDescription>
                  The database, its credentials, the stored files and the Deployz connector stay
                  until you purge them, and may continue to generate AWS charges.
                </AlertDescription>
              </>
            )}
          </Alert>
          <PurgeRetainedResources
            deploymentId={detail.id}
            applicationName={detail.applicationName}
            onChanged={onChanged}
          />
        </div>
      ) : null}

      {detail.state === 'DELETED' && detail.cleanupState === 'COMPLETE' && detail.bootstrapStackName ? (
        <Alert>
          <AlertTriangle aria-hidden />
          <AlertTitle>The Deployz connector is still installed in the customer AWS account</AlertTitle>
          <AlertDescription>
            Deployz removed everything it created for this deployment. The connector stack{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              {detail.bootstrapStackName}
            </code>{' '}
            was created by your customer, so only they can delete it — ask them to delete that
            stack in CloudFormation. Their install link shows the same step.
          </AlertDescription>
        </Alert>
      ) : null}

      <section aria-labelledby="actions" className="flex flex-col gap-3">
        <h2 id="actions" className="sr-only">
          Actions
        </h2>
        <DeploymentActions
          detail={detail}
          releases={releases}
          previousVersion={previousVersion}
          infrastructure={infrastructure}
          onChanged={onChanged}
        />
      </section>

      <section aria-labelledby="deployment-progress" className="flex flex-col gap-3">
        <h2 id="deployment-progress" className="text-base font-semibold">
          Deployment progress
        </h2>
        <DeploymentProgressCard status={detail.deploymentStatus} deploymentState={detail.state} />
      </section>

      <InfrastructureEvents deploymentId={detail.id} stage={detail.deploymentStatus.stage} />

      {detail.state === 'DELETING' ? (
        <DisconnectStatusPanel
          detail={detail}
          infrastructure={infrastructure}
          onChanged={onChanged}
        />
      ) : null}

      {detail.state === 'NOT_INSTALLED' || detail.state === 'WAITING_FOR_RELAY' ? (
        <InstallLinkCard detail={detail} />
      ) : null}

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
        {showInfrastructureRows(detail.state, detail.currentReleaseId) || detail.state === 'DELETED' ? (
          <>
            <InfrastructureSection
              data={infrastructure}
              deploymentId={detail.id}
              deploymentState={detail.state}
            />
            <RelayRow status={detail.relayStatus} lastContact={relativeTime(detail.lastHealthAt)} />
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

function RelayRow({ status, lastContact }: { status: RelayStatus; lastContact: string | null }) {
  return (
    <li className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
      <span className={`size-2 shrink-0 rounded-full ${RELAY_DOT[status]}`} aria-hidden />
      <span className="text-sm font-medium">Deployz Relay</span>
      <span className="ml-auto text-sm text-muted-foreground">
        {lastContact ? `${RELAY_STATUS_LABEL[status]} · ${lastContact}` : RELAY_STATUS_LABEL[status]}
      </span>
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
  infrastructure,
  onChanged,
}: {
  detail: FleetDeploymentDetail;
  releases: Release[];
  previousVersion: string | null;
  infrastructure: InfrastructureResponse | null;
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
  // A pending DESTROY owns the deployment: every other mutating action
  // targets a stack that is about to disappear underneath it.
  const disconnecting = detail.state === 'DELETING';
  const canDeploy = everRan && !disconnecting && actionSupported(capabilities, 'deploy');
  const canRollback = everRan && !disconnecting && actionSupported(capabilities, 'rollback');
  const canRestart = everRan && !disconnecting && actionSupported(capabilities, 'restart');
  const canConfig = everRan && !disconnecting && actionSupported(capabilities, 'configUpdate');
  const canDisconnect = !disconnecting && actionSupported(capabilities, 'disconnect');
  // Recovery for a failed FIRST install: the API refuses it once any install
  // has succeeded, so it is offered exactly where the day-2 actions are not.
  const canRetryInstall = detail.state === 'FAILED' && !everRan;
  const anyCapabilityGatedOff =
    everRan && !disconnecting && (!canDeploy || !canRollback || !canRestart || !canConfig || !canDisconnect);
  const actionsUnavailable = actionsUnavailableReason({
    state: detail.state,
    everRan,
    anyCapabilityGatedOff,
  });
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

      {actionsUnavailable ? (
        <p className="text-sm text-muted-foreground">{actionsUnavailable}</p>
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
        infrastructure={infrastructure}
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
    } catch (caught) {
      setError(actionErrorMessage(caught, "We couldn't start this update. Try again in a moment."));
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
    } catch (caught) {
      setError(actionErrorMessage(caught, "We couldn't start the rollback. Try again in a moment."));
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
  const [relayDisconnected, setRelayDisconnected] = useState(false);

  async function onConfirm(): Promise<void> {
    setPending(true);
    setError(null);
    setRelayDisconnected(false);
    try {
      await retryInstall(deploymentId);
      toast.success('Retry requested');
      onDone();
    } catch (caught) {
      // A bound-but-disconnected relay never picks the retry job up — the
      // fix is re-enrollment, so point at the reconnect path instead.
      if (caught instanceof DeploymentActionError && caught.code === 'RELAY_DISCONNECTED') {
        setRelayDisconnected(true);
      } else {
        setError(actionErrorMessage(caught, "We couldn't start the retry. Try again in a moment."));
      }
      setPending(false);
    }
  }

  async function onReconnect(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await resetRelay(deploymentId);
      window.location.reload();
    } catch {
      setError("We couldn't reconnect the relay. Try again in a moment.");
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
        {relayDisconnected ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              The relay is disconnected — reconnect it first.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              disabled={pending}
              onClick={() => void onReconnect()}
            >
              {pending ? 'Reconnecting…' : 'Reconnect relay'}
            </Button>
          </div>
        ) : null}
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

// P1 dead-relay disconnect: while a DESTROY is pending, the disconnect owns
// this deployment — the panel keeps its status, the relay's state and last
// contact visible. When the relay is confirmed offline and the DESTROY has
// been pending past the shared threshold, the vendor can settle the
// control-plane side alone. That never claims the AWS resources were
// removed — the warning at the top of the page stays until a purge runs.
function DisconnectStatusPanel({
  detail,
  infrastructure,
  onChanged,
}: {
  detail: FleetDeploymentDetail;
  infrastructure: InfrastructureResponse | null;
  onChanged: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeJobStates = ['REQUESTED', 'QUEUED', 'WAITING', 'RUNNING'];
  const pendingDestroy =
    detail.jobs
      .filter((job) => job.type === 'DESTROY' && activeJobStates.includes(job.state))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  const pendingSince = pendingDestroy
    ? Date.parse(
        pendingDestroy.lastProgressAt ?? pendingDestroy.startedAt ?? pendingDestroy.createdAt,
      )
    : Number.NaN;
  const forceCompleteEligible =
    detail.relayStatus === 'DISCONNECTED' &&
    Number.isFinite(pendingSince) &&
    Date.now() - pendingSince >= DESTROY_PENDING_STALE_AFTER_MS;
  const lastContact = relativeTime(detail.lastHealthAt);

  async function onForceComplete(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await forceCompleteDisconnect(detail.id);
      toast.success('Deployment disconnected');
      onChanged();
    } catch {
      setError("We couldn't complete this disconnect. Try again in a moment.");
      setPending(false);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-4">
        <div>
          <p className="text-sm font-medium">Disconnect in progress</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Deployz is waiting for the relay to remove the AWS resources.
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          {lastContact
            ? `${RELAY_STATUS_LABEL[detail.relayStatus]} · ${lastContact}`
            : RELAY_STATUS_LABEL[detail.relayStatus]}
        </p>
        {infrastructure ? (
          <ul className="flex flex-col gap-2">
            {infrastructure.components.map((component) => (
              <li
                key={component.kind}
                className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm"
              >
                <span className="font-medium">{component.name}</span>
                <span className="text-muted-foreground">
                  {disconnectStatusLabel(component.lifecycle)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {forceCompleteEligible ? (
          <div className="flex flex-col gap-3 rounded-lg border border-destructive/50 p-4">
            <p className="text-sm font-medium">Relay is offline.</p>
            <p className="text-sm text-muted-foreground">
              Deployz cannot verify or remove resources in the customer AWS account.
            </p>
            <Button
              size="sm"
              variant="destructive"
              disabled={pending}
              onClick={() => void onForceComplete()}
            >
              {pending ? 'Completing…' : 'Complete disconnect anyway'}
            </Button>
          </div>
        ) : null}
        <OperationError error={error} />
      </CardContent>
    </Card>
  );
}

function disconnectStatusLabel(lifecycle: 'delete' | 'retain' | 'snapshot' | 'conditional'): string {
  if (lifecycle === 'delete') return 'Removing';
  if (lifecycle === 'retain') return 'Retained';
  if (lifecycle === 'snapshot') return 'Snapshot retained';
  return 'Retained conditionally';
}

// P2 purge: the explicit destructive action for resources a force-completed
// disconnect left behind. Typed application-name confirmation, because this
// permanently deletes the retained database, stored files, and cache — and
// the bootstrap/relay stack itself.
function PurgeRetainedResources({
  deploymentId,
  applicationName,
  onChanged,
}: {
  deploymentId: string;
  applicationName: string;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmed = confirmText.trim() === applicationName;

  async function onConfirm(): Promise<void> {
    if (!confirmed) return;
    setPending(true);
    setError(null);
    try {
      await purgeDeployment(deploymentId);
      toast.success('Purge requested');
      setOpen(false);
      setConfirmText('');
      onChanged();
    } catch (caught) {
      setError(actionErrorMessage(caught, "We couldn't start the purge. Try again in a moment."));
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        size="sm"
        variant="destructive"
        className="self-start"
        onClick={() => setOpen(true)}
      >
        Permanently remove retained AWS resources
      </Button>
      <AlertDialog open={open} onOpenChange={(next) => (next ? undefined : setOpen(false))}>
        <AlertDialogContent data-testid="purge-panel" className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-destructive">
              Permanently remove {applicationName}&apos;s retained resources?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the retained database, stored files, backups, and cache in
              your customer&apos;s AWS account, and removes the Deployz connector. This
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="purge-confirm">
              Type <span className="font-medium text-foreground">{applicationName}</span> to confirm.
            </Label>
            <Input
              id="purge-confirm"
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
              aria-label={`Type ${applicationName} to confirm`}
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
              {pending ? 'Purging…' : 'Permanently remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function DisconnectDialog({
  open,
  deploymentId,
  customerName,
  infrastructure,
  onDone,
  onCancel,
}: {
  open: boolean;
  deploymentId: string;
  customerName: string;
  infrastructure: InfrastructureResponse | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [confirmText, setConfirmText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmed = confirmText.trim() === customerName;

  const removed =
    infrastructure?.components.filter((component) => component.lifecycle === 'delete') ?? [];
  const retained =
    infrastructure?.components.filter(
      (component) => component.lifecycle === 'retain' || component.lifecycle === 'snapshot',
    ) ?? [];

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
        <div className="flex flex-col gap-3 text-sm text-muted-foreground">
          {infrastructure ? (
            <>
              {removed.length > 0 ? (
                <div className="flex flex-col gap-1">
                  <p className="font-medium text-foreground">Will be removed</p>
                  <ul className="list-disc pl-5">
                    {removed.map((component) => (
                      <li key={component.kind}>{component.name}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {retained.length > 0 ? (
                <div className="flex flex-col gap-1">
                  <p className="font-medium text-foreground">Will be retained</p>
                  <ul className="list-disc pl-5">
                    {retained.map((component) => (
                      <li key={component.kind}>{component.name}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <p>
                Retained AWS resources may continue generating charges after this deployment is
                removed.
              </p>
            </>
          ) : (
            <p>Your database, stored files, and backups will be retained.</p>
          )}
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
  // The customer launched the install but no relay has enrolled within the
  // staleness window — guidance, never a failure.
  const stuck =
    detail.state === 'WAITING_FOR_RELAY' && relayWaitingStuck(detail.installStartedAt);

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
          {stuck ? (
            <div className="flex flex-col gap-1">
              <p className="text-sm text-muted-foreground">{RELAY_STUCK_GUIDANCE}</p>
              {detail.bootstrapStackName ? (
                <p className="text-xs text-muted-foreground">
                  Expected stack name:{' '}
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {detail.bootstrapStackName}
                  </code>
                </p>
              ) : null}
            </div>
          ) : null}
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
