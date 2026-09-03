'use client';

import { REGION_LABELS, type Region } from '@deployz/contracts';
import { AlertTriangle, ChevronDown, ExternalLink, MoreHorizontal } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import { ActivityFeed } from '@/components/activity-feed';
import { DeploymentHero } from '@/components/deployment-hero';
import { DeploymentStatusBadge } from '@/components/deployment-status-badge';
import { InfrastructureEvents } from '@/components/infrastructure-events';
import { InfrastructureSummary } from '@/components/infrastructure-summary';
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
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { deriveHero, type HeroModel } from '@/lib/deployment-hero';
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
  JOB_STATE_LABEL,
  JOB_TYPE_LABEL,
  RELAY_STATUS_LABEL,
  RELAY_STUCK_GUIDANCE,
  UNSUPPORTED_ACTION_COPY,
  actionSupported,
  everInstalled,
  relayWaitingStuck,
  showHealthBadge,
} from '@/lib/deployment-vocabulary';
import { DOMAIN_STATUS_LABEL } from '@/lib/domains';
import { relativeTime } from '@/lib/diagnostics';
import {
  NO_DEPLOYABLE_RELEASES_COPY,
  deployableReleases,
  fetchReleases,
  type Release,
} from '@/lib/releases';
import { isTerminalStage } from '@/lib/deployment-progress';
import { useStatusPoll } from '@/lib/use-status-poll';

type DetailState =
  | { status: 'loading' }
  | { status: 'error'; message: string; notFound: boolean }
  | {
      status: 'loaded';
      detail: FleetDeploymentDetail;
      /** Null when the activity request failed — the feed says so. */
      events: ActivityEvent[] | null;
      releases: Release[];
    };

/** The resource inventory: loading, failed (the page stays up), or loaded. */
type InfrastructureState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'loaded'; data: InfrastructureResponse };

const NO_PREVIOUS_RELEASE_COPY = 'No previous successful release to roll back to.';
const INSTALL_STAGES = new Set(['WAITING_FOR_AWS', 'CONNECTING', 'PROVISIONING']);
const BUSY_ACTION_COPY = 'Other actions become available when this operation finishes.';

// §24 deployment detail, laid out as a status page rather than a console:
// compact header → state-aware hero with contextual actions → metadata →
// infrastructure summary → recent activity → collapsed technical details.
// M14: deployment health only — no application observability.
export default function DeploymentDetailPage() {
  const params = useParams();
  const id = Array.isArray(params.id) ? (params.id[0] ?? '') : (params.id ?? '');
  const [state, setState] = useState<DetailState>({ status: 'loading' });
  const [infrastructure, setInfrastructure] = useState<InfrastructureState>({ status: 'loading' });
  // Signature of the last (stage, state) pair the poll observed — refetching
  // the activity feed on every 5s tick would hammer it for nothing, so it
  // only happens when this actually moved.
  const lastSignature = useRef<{ stage: string; state: string } | null>(null);

  const refreshInfrastructure = useCallback(async (): Promise<void> => {
    try {
      const data = await fetchDeploymentInfrastructure(id);
      setInfrastructure({ status: 'loaded', data });
    } catch {
      // Keep the last inventory if there is one; only a first load that
      // fails shows the section-level warning. The deployment itself is
      // unaffected either way.
      setInfrastructure((current) => (current.status === 'loaded' ? current : { status: 'error' }));
    }
  }, [id]);

  const load = useCallback(async (): Promise<void> => {
    let detail: FleetDeploymentDetail;
    try {
      detail = await fetchDeployment(id);
    } catch (caught) {
      // Only the deployment itself decides whether this page exists. A 404
      // is permanent for this URL — no retry-oriented copy for it.
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
      return;
    }
    // The supporting requests degrade independently: a failed inventory or
    // activity fetch marks its own section, never the whole page.
    const [events, releases] = await Promise.all([
      fetchDeploymentEvents(id).catch((): ActivityEvent[] | null => null),
      fetchReleases(detail.applicationId).catch((): Release[] => []),
      refreshInfrastructure(),
    ]);
    lastSignature.current = { stage: detail.deploymentStatus.stage, state: detail.state };
    setState({ status: 'loaded', detail, events, releases });
  }, [id, refreshInfrastructure]);

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
      void fetchDeploymentEvents(id)
        .then((events) => {
          setState((current) => (current.status === 'loaded' ? { ...current, events } : current));
        })
        .catch(() => {
          // Keep the last feed; a transient failure is not a lifecycle change.
        });
    }
    // Refresh the infrastructure snapshot on every poll tick so the
    // component list stays live during disconnect.
    void refreshInfrastructure();
  }, [poll.data, id, refreshInfrastructure]);

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/dashboard/deployments">Deployments</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>
              {state.status === 'loaded' ? state.detail.applicationName : 'Deployment'}
            </BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

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
  events: ActivityEvent[] | null;
  releases: Release[];
  infrastructure: InfrastructureState;
  onChanged: () => void;
}) {
  const previousVersion = releases.find((r) => r.id === detail.previousReleaseId)?.version ?? null;
  const hero = deriveHero(detail);
  const inventory = infrastructure.status === 'loaded' ? infrastructure.data : null;

  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="min-w-0 break-words text-2xl font-semibold tracking-tight">
            {detail.applicationName}
          </h1>
          <DeploymentStatusBadge state={detail.state} />
          {showHealthBadge(detail.state, detail.currentReleaseId) ? (
            <Badge variant={HEALTH_STATUS_BADGE[detail.healthStatus]}>
              {HEALTH_STATUS_LABEL[detail.healthStatus]}
            </Badge>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">
          {detail.customerName}
          {detail.version ? (
            <>
              {' · '}
              <span className="tabular-nums">v{detail.version}</span>
            </>
          ) : null}
        </p>
      </div>

      <section aria-labelledby="deployment-progress" className="flex flex-col gap-3">
        <h2 id="deployment-progress" className="sr-only">
          Deployment status
        </h2>
        <DeploymentHero
          detail={detail}
          hero={hero}
          actions={
            <DeploymentActions
              detail={detail}
              hero={hero}
              releases={releases}
              previousVersion={previousVersion}
              infrastructure={inventory}
              onChanged={onChanged}
            />
          }
        >
          {detail.state === 'DELETING' ? (
            <DisconnectStatusPanel
              detail={detail}
              infrastructure={inventory}
              onChanged={onChanged}
            />
          ) : null}
          {detail.state === 'DELETED' ? (
            <RemovedDeploymentNotes detail={detail} onChanged={onChanged} />
          ) : null}
        </DeploymentHero>
      </section>

      {detail.state === 'NOT_INSTALLED' || detail.state === 'WAITING_FOR_RELAY' ? (
        <InstallLinkCard detail={detail} />
      ) : null}

      <DeploymentMetadata detail={detail} />

      <section aria-labelledby="infrastructure" className="flex flex-col gap-3">
        <h2 id="infrastructure" className="text-base font-semibold">
          Infrastructure
        </h2>
        <InfrastructureSummary
          detail={detail}
          infrastructure={inventory}
          infrastructureError={infrastructure.status === 'error'}
        />
      </section>

      <section aria-labelledby="activity" className="flex flex-col gap-3">
        <h2 id="activity" className="text-base font-semibold">
          Recent activity
        </h2>
        {events === null ? (
          <p className="text-sm text-muted-foreground">
            Activity is unavailable right now. It refreshes automatically.
          </p>
        ) : (
          <ActivityFeed events={events} />
        )}
      </section>

      <AdvancedDetails detail={detail} infrastructure={inventory} />
    </>
  );
}

/**
 * Compact vendor-level facts. The AWS account, stack status and version
 * identifiers live under Advanced details — nothing here needs AWS knowledge.
 */
function DeploymentMetadata({ detail }: { detail: FleetDeploymentDetail }) {
  const created = new Date(detail.createdAt);
  const domain = detail.customDomain;

  return (
    <section aria-labelledby="overview" className="flex flex-col gap-3">
      <h2 id="overview" className="sr-only">
        Overview
      </h2>
      <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <MetaRow label="Customer" value={detail.customerName} />
        <MetaRow label="Region" value={REGION_LABELS[detail.region as Region] ?? detail.region} />
        <MetaRow
          label="Release"
          value={detail.version ? <span className="tabular-nums">v{detail.version}</span> : 'Not deployed yet'}
        />
        <MetaRow
          label="Created"
          value={
            <time dateTime={detail.createdAt} title={created.toLocaleString()}>
              {created.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </time>
          }
        />
        {detail.appUrl ? <AppUrlRow url={detail.appUrl} /> : null}
        <div className="flex min-w-0 flex-col gap-0.5 sm:col-span-2">
          <dt className="text-muted-foreground">Custom domain</dt>
          <dd className="flex min-w-0 flex-wrap items-center gap-2">
            {domain ? (
              <>
                <span className="min-w-0 truncate font-medium">{domain.hostname}</span>
                <Badge variant={domain.status === 'error' ? 'destructive' : 'secondary'}>
                  {DOMAIN_STATUS_LABEL[domain.status]}
                </Badge>
              </>
            ) : (
              <span className="text-muted-foreground">None</span>
            )}
            <Link
              href={`/install/${detail.installLinkId}`}
              className="inline-flex items-center gap-1 rounded-md text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {domain ? 'Manage →' : 'Add domain →'}
            </Link>
          </dd>
        </div>
      </dl>
    </section>
  );
}

// Implementation detail progressively disclosed — nothing here is required
// reading; the hero and metadata above carry the state that matters. The raw
// CloudFormation event feed lives here too, as the diagnostics-grade
// complement to the hero's derived step list.
function AdvancedDetails({
  detail,
  infrastructure,
}: {
  detail: FleetDeploymentDetail;
  infrastructure: InfrastructureResponse | null;
}) {
  const status = detail.deploymentStatus;
  return (
    <section aria-labelledby="advanced" className="flex flex-col gap-3">
      <Collapsible>
        <CollapsibleTrigger
          id="advanced"
          className="group flex items-center gap-1 self-start text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          Advanced details
          <ChevronDown
            aria-hidden
            className="size-4 transition-transform group-data-[state=open]:rotate-180"
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-3 pt-3">
          <Card>
            <CardContent>
              <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
                <MetaRow label="AWS account" value={detail.awsAccountId ?? 'Not connected yet'} />
                <MetaRow label="AWS region" value={detail.region} />
                <MetaRow label="Infrastructure version" value={detail.infraVersion} />
                {detail.relayVersion ? (
                  <MetaRow label="Connector version" value={detail.relayVersion} />
                ) : null}
                {detail.bootstrapStackName ? (
                  <MetaRow label="Connector stack" value={<Mono>{detail.bootstrapStackName}</Mono>} />
                ) : null}
                <MetaRow
                  label="Stack status"
                  value={
                    status.aws.stackStatus ?? infrastructure?.stackStatus ? (
                      <Mono>{status.aws.stackStatus ?? infrastructure?.stackStatus}</Mono>
                    ) : (
                      '—'
                    )
                  }
                />
                {status.job ? (
                  <MetaRow
                    label="Latest job"
                    value={`${JOB_TYPE_LABEL[status.job.type]} · ${JOB_STATE_LABEL[status.job.status]}`}
                  />
                ) : null}
                {status.failure?.awsStatus ? (
                  <MetaRow label="Failure status" value={<Mono>{status.failure.awsStatus}</Mono>} />
                ) : null}
                <MetaRow
                  label="Relay"
                  value={
                    <span data-testid="status-updated">
                      {RELAY_STATUS_LABEL[detail.relayStatus]}
                      {relativeTime(detail.lastHealthAt) ? ` · ${relativeTime(detail.lastHealthAt)}` : ''}
                    </span>
                  }
                />
                <MetaRow label="Deployment ID" value={<Mono>{detail.id}</Mono>} />
              </dl>
            </CardContent>
          </Card>
          <InfrastructureEvents deploymentId={detail.id} stage={status.stage} />
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return (
    <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{children}</code>
  );
}

// The contextual action row. Day-2 actions are gated on the installed relay
// advertising the matching capability — an enabled button over a stub
// executor would report success having done nothing — and on the deployment
// having ever completed an install (a relay can connect and advertise
// capabilities before that happens). Disconnect is exempt from the second
// gate: a deployment that failed to ever come up must still be removable.
// Rare and destructive actions live behind "More actions" so they never
// compete with the one thing the vendor should do next.
function DeploymentActions({
  detail,
  hero,
  releases,
  previousVersion,
  infrastructure,
  onChanged,
}: {
  detail: FleetDeploymentDetail;
  hero: HeroModel;
  releases: Release[];
  previousVersion: string | null;
  infrastructure: InfrastructureResponse | null;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<
    'deploy' | 'rollback' | 'restart' | 'disconnect' | 'retryInstall' | null
  >(null);
  const capabilities: RelayCapabilities | null = detail.relayCapabilities;
  // Day-2 actions act on a running application: nothing to act on before
  // the first install has completed (an install in flight included).
  const everRan =
    everInstalled(detail.state, detail.currentReleaseId) &&
    !INSTALL_STAGES.has(detail.deploymentStatus.stage);
  // A pending DESTROY owns the deployment: every other mutating action
  // targets a stack that is about to disappear underneath it. A running
  // update owns it the same way (the API answers DEPLOYMENT_BUSY).
  const disconnecting = detail.state === 'DELETING';
  const busy = detail.state === 'UPDATING';
  const removed = detail.state === 'DELETED';
  const available = everRan && !disconnecting && !busy && !removed;
  const canDeploy = available && actionSupported(capabilities, 'deploy');
  const canRollback = available && actionSupported(capabilities, 'rollback');
  const canRestart = available && actionSupported(capabilities, 'restart');
  const canConfig = available && actionSupported(capabilities, 'configUpdate');
  const canDisconnect = !disconnecting && !removed && actionSupported(capabilities, 'disconnect');
  // Recovery for a failed FIRST install: the API refuses it once any install
  // has succeeded, so it is offered exactly where the day-2 actions are not.
  const canRetryInstall = detail.state === 'FAILED' && !everRan;
  const anyCapabilityGatedOff =
    available &&
    (!actionSupported(capabilities, 'deploy') ||
      !actionSupported(capabilities, 'rollback') ||
      !actionSupported(capabilities, 'restart') ||
      !actionSupported(capabilities, 'configUpdate') ||
      !actionSupported(capabilities, 'disconnect'));
  const hasPreviousRelease = detail.previousReleaseId !== null;
  const deployIsPrimary =
    detail.state === 'UPDATE_AVAILABLE' || hero.kind === 'operation-failed';

  if (removed) {
    return (
      <section aria-labelledby="actions" className="flex flex-col gap-3">
        <h2 id="actions" className="sr-only">
          Actions
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild size="sm" variant="outline">
            <Link href={`/dashboard/deployments/${detail.id}/diagnostics`}>View Diagnostics</Link>
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="actions" className="flex flex-col gap-2">
      <h2 id="actions" className="sr-only">
        Actions
      </h2>
      <div className="flex flex-wrap items-center gap-2">
        {canRetryInstall ? (
          <Button size="sm" onClick={() => setOpen(open === 'retryInstall' ? null : 'retryInstall')}>
            Retry deployment
          </Button>
        ) : null}
        {hero.kind === 'removal-failed' ? (
          <Button
            size="sm"
            variant="destructive"
            disabled={!canDisconnect}
            onClick={() => setOpen('disconnect')}
          >
            Retry removal
          </Button>
        ) : null}
        {everRan ? (
          <Button
            size="sm"
            variant={deployIsPrimary ? 'default' : 'outline'}
            disabled={!canDeploy}
            onClick={() => setOpen(open === 'deploy' ? null : 'deploy')}
          >
            Deploy Update
          </Button>
        ) : null}
        <Button asChild size="sm" variant="outline">
          <Link href={`/dashboard/deployments/${detail.id}/diagnostics`}>View Diagnostics</Link>
        </Button>
        {everRan ? (
          canConfig ? (
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
          )
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="outline" aria-label="More actions" className="ml-auto">
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            {everRan ? (
              <>
                <DropdownMenuItem disabled={!canRestart} onSelect={() => setOpen('restart')}>
                  Restart
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!canRollback || !hasPreviousRelease}
                  onSelect={() => setOpen('rollback')}
                  className="flex-col items-start gap-0"
                >
                  <span>Rollback{previousVersion ? ` to v${previousVersion}` : ''}</span>
                  {!hasPreviousRelease ? (
                    <span className="text-xs text-muted-foreground">{NO_PREVIOUS_RELEASE_COPY}</span>
                  ) : null}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuItem
              variant="destructive"
              disabled={!canDisconnect}
              onSelect={() => setOpen('disconnect')}
            >
              Disconnect Deployment
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {busy ? (
        <p className="text-xs text-muted-foreground">{BUSY_ACTION_COPY}</p>
      ) : anyCapabilityGatedOff ? (
        <p className="text-xs text-muted-foreground">{UNSUPPORTED_ACTION_COPY}</p>
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
    </section>
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
          <AlertDialogTitle>Retry deploying {applicationName}?</AlertDialogTitle>
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
            {pending ? 'Starting…' : 'Retry deployment'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// P1 dead-relay disconnect: while a DESTROY is pending, the disconnect owns
// this deployment — the hero keeps the relay's state, last contact and the
// per-service removal progress visible. When the relay is confirmed offline
// and the DESTROY has been pending past the shared threshold, the vendor can
// settle the control-plane side alone. That never claims the AWS resources
// were removed — the retained-resources note stays until a purge runs.
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
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {lastContact
          ? `${RELAY_STATUS_LABEL[detail.relayStatus]} · ${lastContact}`
          : RELAY_STATUS_LABEL[detail.relayStatus]}
      </p>
      {infrastructure ? (
        <ul className="flex flex-col divide-y rounded-lg border text-sm">
          {infrastructure.components.map((component) => (
            <li
              key={component.kind}
              className="flex items-center justify-between gap-3 px-3 py-2"
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
            className="self-start"
            disabled={pending}
            onClick={() => void onForceComplete()}
          >
            {pending ? 'Completing…' : 'Complete disconnect anyway'}
          </Button>
        </div>
      ) : null}
      <OperationError error={error} />
    </div>
  );
}

function disconnectStatusLabel(lifecycle: 'delete' | 'retain' | 'snapshot' | 'conditional'): string {
  if (lifecycle === 'delete') return 'Removing';
  if (lifecycle === 'retain') return 'Retained';
  if (lifecycle === 'snapshot') return 'Snapshot retained';
  return 'Retained conditionally';
}

/** What a removed deployment left behind, and the one action that clears it. */
function RemovedDeploymentNotes({
  detail,
  onChanged,
}: {
  detail: FleetDeploymentDetail;
  onChanged: () => void;
}) {
  if (detail.cleanupState !== 'COMPLETE') {
    return (
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
    );
  }

  if (detail.bootstrapStackName) {
    return (
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
    );
  }

  return null;
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
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words font-medium">{value}</dd>
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
    <div className="flex min-w-0 flex-col gap-0.5 sm:col-span-2">
      <dt className="text-muted-foreground">URL</dt>
      <dd className="flex min-w-0 items-center gap-2">
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-w-0 items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
        >
          <span className="truncate">{url}</span>
          <ExternalLink aria-hidden className="size-3.5 shrink-0" />
        </a>
        <Button type="button" size="xs" variant="outline" onClick={copy}>
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
      <Skeleton className="h-44 w-full rounded-xl" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
      <Skeleton className="h-32 w-full rounded-xl" />
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
