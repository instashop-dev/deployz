'use client';

import { AlertTriangle, ArrowLeft, ChevronDown, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import { ActivityFeed } from '@/components/activity-feed';
import { DeploymentProgressCard } from '@/components/deployment-progress-card';
import { DeploymentStatusBadge } from '@/components/deployment-status-badge';
import { InfrastructureSection } from '@/components/infrastructure-section';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiRequestError, errorMessage } from '@/lib/api-client';
import {
  deriveConnectionState,
  fetchAdminDeployment,
  forceCompleteDestroyAdmin,
  relayResetAdmin,
  retryInstallAdmin,
  rollbackAdmin,
  type AdminDeploymentDetail,
  type AdminDeploymentJob,
} from '@/lib/admin';
import {
  CONNECTION_STATE_BADGE,
  CONNECTION_STATE_LABEL,
  CONNECTION_STATE_PROBLEM,
  JOB_PRESENTATION_BADGE,
  JOB_PRESENTATION_LABEL,
  jobPresentationState,
} from '@/lib/admin-vocabulary';
import { formatElapsedSeconds } from '@/lib/deployment-progress';
import {
  everInstalled,
  HEALTH_STATUS_BADGE,
  HEALTH_STATUS_LABEL,
  JOB_TYPE_LABEL,
  RELAY_STATUS_LABEL,
  showHealthBadge,
} from '@/lib/deployment-vocabulary';
import { failureCodeCopy } from '@/lib/diagnostic-vocabulary';
import { relativeTime } from '@/lib/diagnostics';

type DetailState =
  | { status: 'loading' }
  | { status: 'error'; message: string; notFound: boolean }
  | { status: 'loaded'; detail: AdminDeploymentDetail };

// Team Admin's command center — the most important admin page. Every section
// composes an existing shared component (DeploymentProgressCard,
// InfrastructureSection, ActivityFeed) fed with the admin API's response,
// which mirrors the vendor wire shapes exactly, so the two surfaces can never
// disagree about a deployment's state.
export default function AdminDeploymentDetailPage() {
  const params = useParams();
  const id = Array.isArray(params.id) ? (params.id[0] ?? '') : (params.id ?? '');
  const [state, setState] = useState<DetailState>({ status: 'loading' });

  const load = useCallback(async (): Promise<void> => {
    try {
      const detail = await fetchAdminDeployment(id);
      setState({ status: 'loaded', detail });
    } catch (caught) {
      const notFound = caught instanceof ApiRequestError && caught.code === 'NOT_FOUND';
      setState({
        status: 'error',
        notFound,
        message: notFound ? "This deployment doesn't exist." : errorMessage(caught),
      });
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2 self-start">
        <Link href="/admin/deployments">
          <ArrowLeft aria-hidden className="size-4" />
          Deployments
        </Link>
      </Button>

      {state.status === 'loading' ? <DetailSkeleton /> : null}
      {state.status === 'error' ? (
        <section
          aria-labelledby="deployment-error"
          className="rounded-xl border border-dashed px-6 py-16 text-center"
        >
          <h2 id="deployment-error" className="text-lg font-semibold">
            {state.notFound ? 'Deployment not found' : 'Something went wrong'}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
          {!state.notFound ? (
            <Button variant="outline" className="mt-4" onClick={() => void load()}>
              Try again
            </Button>
          ) : null}
        </section>
      ) : null}
      {state.status === 'loaded' ? (
        <DetailBody detail={state.detail} onChanged={load} />
      ) : null}
    </div>
  );
}

function DetailBody({
  detail,
  onChanged,
}: {
  detail: AdminDeploymentDetail;
  onChanged: () => void;
}) {
  const previousRelease = detail.releases.find((r) => r.id === detail.previousReleaseId) ?? null;
  const connectionState = deriveConnectionState(detail.connection);

  return (
    <>
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{detail.customerName}</h1>
          <DeploymentStatusBadge state={detail.state} />
          {showHealthBadge(detail.state, detail.currentReleaseId) ? (
            <Badge variant={HEALTH_STATUS_BADGE[detail.healthStatus]}>
              {HEALTH_STATUS_LABEL[detail.healthStatus]}
            </Badge>
          ) : null}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {detail.applicationName} ·{' '}
          <Link href={`/admin/vendors/${detail.organizationId}`} className="hover:underline">
            {detail.vendor.name}
          </Link>
        </p>
      </div>

      <section aria-labelledby="summary" className="flex flex-col gap-3">
        <h2 id="summary" className="text-base font-semibold">
          Summary
        </h2>
        <Card>
          <CardContent className="flex flex-col gap-3 py-4">
            {detail.appUrl ? <AppUrlRow url={detail.appUrl} /> : null}
            <MetaRow label="Current release" value={detail.version ?? 'Not deployed yet'} />
            {previousRelease ? (
              <MetaRow label="Previous release" value={`v${previousRelease.version}`} />
            ) : null}
            <MetaRow
              label="Vendor"
              value={
                <Link href={`/admin/vendors/${detail.organizationId}`} className="hover:underline">
                  {detail.vendor.name}
                </Link>
              }
            />
            <MetaRow label="Customer" value={`${detail.customer.name} (${detail.customer.email})`} />
            <MetaRow
              label="AWS account"
              value={detail.connection.awsAccountId ?? 'Not connected yet'}
            />
            <MetaRow label="Region" value={detail.region} />
            <MetaRow
              label="Created"
              value={new Date(detail.createdAt).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
            />
            <MetaRow label="Last update" value={relativeTime(detail.updatedAt) ?? '—'} />
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="actions" className="flex flex-col gap-3">
        <h2 id="actions" className="text-base font-semibold">
          Recovery actions
        </h2>
        <DeploymentActions detail={detail} onChanged={onChanged} />
      </section>

      <section aria-labelledby="progress" className="flex flex-col gap-3">
        <h2 id="progress" className="text-base font-semibold">
          Deployment progress
        </h2>
        <DeploymentProgressCard status={detail.deploymentStatus} />
      </section>

      <section aria-labelledby="infrastructure" className="flex flex-col gap-3">
        <h2 id="infrastructure" className="text-base font-semibold">
          Infrastructure
        </h2>
        <InfrastructureSection
          data={detail.infrastructure}
          deploymentId={detail.id}
          deploymentState={detail.state}
        />
      </section>

      <section aria-labelledby="release-history" className="flex flex-col gap-3">
        <h2 id="release-history" className="text-base font-semibold">
          Release history
        </h2>
        <ReleaseHistoryTable entries={detail.releaseHistory} />
      </section>

      <section aria-labelledby="connection-diagnostics" className="flex flex-col gap-3">
        <h2 id="connection-diagnostics" className="text-base font-semibold">
          AWS / relay diagnostics
        </h2>
        <ConnectionDiagnosticsCard
          detail={detail}
          connectionState={connectionState}
        />
      </section>

      <section aria-labelledby="jobs" className="flex flex-col gap-3">
        <h2 id="jobs" className="text-base font-semibold">
          Related jobs
        </h2>
        <JobsTable jobs={detail.jobs} />
      </section>

      <section aria-labelledby="activity" className="flex flex-col gap-3">
        <h2 id="activity" className="text-base font-semibold">
          Recent activity
        </h2>
        <ActivityFeed events={detail.recentEvents} />
      </section>
    </>
  );
}

function AppUrlRow({ url }: { url: string }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:justify-between">
      <dt className="text-sm text-muted-foreground">URL</dt>
      <dd>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          {url}
          <ExternalLink aria-hidden className="size-3.5" />
        </a>
      </dd>
    </div>
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

function ReleaseHistoryTable({ entries }: { entries: AdminDeploymentDetail['releaseHistory'] }) {
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">No release activity yet.</p>;
  }
  return (
    <Card>
      <CardContent className="overflow-x-auto p-0">
        <Table data-testid="release-history-table">
          <TableHeader>
            <TableRow>
              <TableHead>Operation</TableHead>
              <TableHead>Release</TableHead>
              <TableHead>Result</TableHead>
              <TableHead>Timestamp</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...entries].reverse().map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="font-medium">{JOB_TYPE_LABEL[entry.type]}</TableCell>
                <TableCell className="text-muted-foreground">
                  {entry.release.version ? `v${entry.release.version}` : '—'}
                </TableCell>
                <TableCell>
                  <Badge variant={JOB_PRESENTATION_BADGE[jobPresentationState(entry.state, false)]}>
                    {JOB_PRESENTATION_LABEL[jobPresentationState(entry.state, false)]}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {relativeTime(entry.finishedAt ?? entry.createdAt) ?? '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ConnectionDiagnosticsCard({
  detail,
  connectionState,
}: {
  detail: AdminDeploymentDetail;
  connectionState: ReturnType<typeof deriveConnectionState>;
}) {
  const problem = connectionState === 'CONNECTED' ? null : CONNECTION_STATE_PROBLEM[connectionState];
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={CONNECTION_STATE_BADGE[connectionState]}>
            {CONNECTION_STATE_LABEL[connectionState]}
          </Badge>
          <span className="text-sm text-muted-foreground">
            {detail.connection.communicationPossible
              ? 'Deployz can reach this account right now.'
              : 'Deployz cannot reach this account right now.'}
          </span>
        </div>
        {problem ? (
          <Alert>
            <AlertTriangle aria-hidden />
            <AlertTitle>{problem.heading}</AlertTitle>
            <AlertDescription>{problem.body}</AlertDescription>
          </Alert>
        ) : null}
        <MetaRow label="Relay status" value={RELAY_STATUS_LABEL[detail.connection.relayStatus]} />
        <MetaRow label="Last heartbeat" value={relativeTime(detail.connection.lastHealthAt) ?? 'Never'} />
        <MetaRow label="Relay version" value={detail.connection.relayVersion ?? 'Unknown'} />
        <MetaRow label="Bootstrap version" value={detail.connection.bootstrapVersion ?? 'Unknown'} />
        <MetaRow label="Attempt" value={String(detail.connection.attemptNumber)} />
        <TechnicalDetails detail={detail} />
      </CardContent>
    </Card>
  );
}

function TechnicalDetails({ detail }: { detail: AdminDeploymentDetail }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        Technical details
        <ChevronDown
          aria-hidden
          className="size-4 transition-transform group-data-[state=open]:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 flex flex-col gap-2">
          <MetaRow label="Bootstrap stack" value={detail.connection.bootstrapStackName ?? '—'} />
          <MetaRow label="Installation ID" value={detail.connection.installationId ?? '—'} />
          {detail.recentStackEvents.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {detail.recentStackEvents.slice(0, 10).map((event) => (
                <li
                  key={event.id}
                  className="flex flex-col gap-0.5 rounded-md bg-muted px-2 py-1.5 text-xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{event.logicalResourceId}</span>
                    <span className="text-muted-foreground">{event.resourceStatus}</span>
                  </div>
                  <span className="text-muted-foreground">{event.resourceType}</span>
                  {event.resourceStatusReason ? (
                    <span className="text-destructive">{event.resourceStatusReason}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function JobsTable({ jobs }: { jobs: AdminDeploymentJob[] }) {
  if (jobs.length === 0) {
    return <p className="text-sm text-muted-foreground">No jobs yet.</p>;
  }
  return (
    <Card>
      <CardContent className="overflow-x-auto p-0">
        <Table data-testid="admin-deployment-jobs-table">
          <TableHeader>
            <TableRow>
              <TableHead>Operation</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Failure</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...jobs].reverse().map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function JobRow({ job }: { job: AdminDeploymentJob }) {
  const [open, setOpen] = useState(false);
  const presentation = jobPresentationState(job.state, job.stuck);
  const duration = jobDurationLabel(job);
  const failure = job.failureCode ? failureCodeCopy(job.failureCode) : null;
  const hasTechnical = job.errorDetail !== null;

  return (
    <>
      <TableRow>
        <TableCell className="font-medium">{JOB_TYPE_LABEL[job.type]}</TableCell>
        <TableCell>
          <Badge variant={JOB_PRESENTATION_BADGE[presentation]}>
            {JOB_PRESENTATION_LABEL[presentation]}
          </Badge>
        </TableCell>
        <TableCell className="text-muted-foreground">{relativeTime(job.createdAt) ?? '—'}</TableCell>
        <TableCell className="text-muted-foreground">{duration}</TableCell>
        <TableCell>
          {failure ? (
            <button
              type="button"
              className="text-left text-sm text-destructive underline-offset-2 hover:underline"
              onClick={() => setOpen(!open)}
              aria-expanded={open}
            >
              {failure.label}
            </button>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </TableCell>
      </TableRow>
      {open && hasTechnical ? (
        <TableRow>
          <TableCell colSpan={5} className="bg-muted/50 text-xs text-muted-foreground">
            <code className="block whitespace-pre-wrap break-all">{job.errorDetail}</code>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

function jobDurationLabel(job: AdminDeploymentJob): string {
  const start = job.startedAt ?? job.createdAt;
  if (job.finishedAt) {
    return formatElapsedSeconds((Date.parse(job.finishedAt) - Date.parse(start)) / 1000);
  }
  if (job.startedAt) {
    return `${formatElapsedSeconds((Date.now() - Date.parse(job.startedAt)) / 1000)} (running)`;
  }
  return '—';
}

// ── Recovery actions ─────────────────────────────────────────────────────

function DeploymentActions({
  detail,
  onChanged,
}: {
  detail: AdminDeploymentDetail;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<'retry' | 'rollback' | 'force-complete' | 'relay-reset' | null>(null);

  const canRetryInstall = detail.state === 'FAILED' && !everInstalled(detail.state, detail.currentReleaseId);
  const readyReleases = detail.releases.filter(
    (release) => release.releaseStatus === 'READY' && release.id !== detail.currentReleaseId,
  );
  const canRollback = readyReleases.length > 0 && detail.state !== 'DELETING';

  const activeJobStates = ['REQUESTED', 'QUEUED', 'WAITING', 'RUNNING'];
  const pendingDestroy =
    detail.jobs
      .filter((job) => job.type === 'DESTROY' && activeJobStates.includes(job.state))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  const canForceCompleteDestroy =
    detail.state === 'DELETING' && pendingDestroy !== null && detail.connection.relayStatus === 'DISCONNECTED';

  const canResetRelay = detail.state !== 'DELETED';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={!canRetryInstall}
          data-testid="admin-retry-install"
          onClick={() => setOpen(open === 'retry' ? null : 'retry')}
        >
          Retry install
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!canRollback}
          data-testid="admin-rollback"
          onClick={() => setOpen(open === 'rollback' ? null : 'rollback')}
        >
          Rollback
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={!canForceCompleteDestroy}
          data-testid="admin-force-complete-destroy"
          onClick={() => setOpen(open === 'force-complete' ? null : 'force-complete')}
        >
          Force-complete destroy
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!canResetRelay}
          data-testid="admin-relay-reset"
          onClick={() => setOpen(open === 'relay-reset' ? null : 'relay-reset')}
        >
          Reset relay
        </Button>
      </div>
      {!canRetryInstall ? (
        <p className="text-xs text-muted-foreground">
          {detail.state !== 'FAILED'
            ? 'Retry install is only available on a failed first install.'
            : 'This deployment already completed an install — use Rollback instead.'}
        </p>
      ) : null}
      {!canRollback ? (
        <p className="text-xs text-muted-foreground">No ready release to roll back to.</p>
      ) : null}
      {!canForceCompleteDestroy ? (
        <p className="text-xs text-muted-foreground">
          Force-complete destroy is only available while a disconnect is pending and the relay is
          offline.
        </p>
      ) : null}

      <RetryInstallDialog
        open={open === 'retry'}
        deploymentId={detail.id}
        onDone={() => {
          setOpen(null);
          onChanged();
        }}
        onCancel={() => setOpen(null)}
      />
      <RollbackDialog
        open={open === 'rollback'}
        deploymentId={detail.id}
        releases={readyReleases}
        onDone={() => {
          setOpen(null);
          onChanged();
        }}
        onCancel={() => setOpen(null)}
      />
      <ForceCompleteDestroyDialog
        open={open === 'force-complete'}
        deploymentId={detail.id}
        customerName={detail.customerName}
        onDone={() => {
          setOpen(null);
          onChanged();
        }}
        onCancel={() => setOpen(null)}
      />
      <RelayResetDialog
        open={open === 'relay-reset'}
        deploymentId={detail.id}
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
    <Alert variant="destructive">
      <AlertTriangle aria-hidden />
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  );
}

function RetryInstallDialog({
  open,
  deploymentId,
  onDone,
  onCancel,
}: {
  open: boolean;
  deploymentId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onConfirm(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await retryInstallAdmin(deploymentId, reason.trim() || undefined);
      toast.success('Retry requested');
      setReason('');
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent data-testid="admin-retry-install-panel" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Retry install?</DialogTitle>
          <DialogDescription>
            The failed infrastructure from the previous attempt is removed, then the install runs
            again.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="retry-reason">Reason (optional)</Label>
          <Input
            id="retry-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why is this being retried?"
          />
        </div>
        <OperationError error={error} />
        <DialogFooter>
          <Button variant="ghost" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={pending} onClick={() => void onConfirm()}>
            {pending ? 'Starting…' : 'Retry install'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RollbackDialog({
  open,
  deploymentId,
  releases,
  onDone,
  onCancel,
}: {
  open: boolean;
  deploymentId: string;
  releases: AdminDeploymentDetail['releases'];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [releaseId, setReleaseId] = useState(releases[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setReleaseId(releases[0]?.id ?? '');
  }, [open, releases]);

  async function onConfirm(): Promise<void> {
    if (!releaseId || reason.trim() === '') return;
    setPending(true);
    setError(null);
    try {
      await rollbackAdmin(deploymentId, releaseId, reason.trim());
      toast.success('Rollback requested');
      setReason('');
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent data-testid="admin-rollback-panel" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rollback deployment?</DialogTitle>
          <DialogDescription>
            Application rollback does not automatically reverse database migrations.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="rollback-release">Release to roll back to</Label>
          <Select value={releaseId} onValueChange={setReleaseId}>
            <SelectTrigger id="rollback-release" className="w-full">
              <SelectValue placeholder="Pick a release" />
            </SelectTrigger>
            <SelectContent>
              {releases.map((release) => (
                <SelectItem key={release.id} value={release.id}>
                  v{release.version}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="rollback-reason">Reason (required)</Label>
          <Input
            id="rollback-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why is this being rolled back?"
          />
        </div>
        <OperationError error={error} />
        <DialogFooter>
          <Button variant="ghost" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={!releaseId || reason.trim() === '' || pending} onClick={() => void onConfirm()}>
            {pending ? 'Starting…' : 'Rollback'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ForceCompleteDestroyDialog({
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
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onConfirm(): Promise<void> {
    if (reason.trim() === '') return;
    setPending(true);
    setError(null);
    try {
      await forceCompleteDestroyAdmin(deploymentId, reason.trim());
      toast.success('Disconnect force-completed');
      setReason('');
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <AlertDialogContent data-testid="admin-force-complete-destroy-panel">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-destructive">
            Force-complete {customerName}&apos;s disconnect?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This marks the deployment as disconnected on the control plane even though the offline
            relay never confirmed the AWS resources were removed. Resources may remain in the
            customer&apos;s AWS account and continue generating charges until confirmed and removed.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="force-complete-reason">Reason (required)</Label>
          <Input
            id="force-complete-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why is this being force-completed?"
          />
        </div>
        <OperationError error={error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={reason.trim() === '' || pending}
            onClick={(event) => {
              event.preventDefault();
              void onConfirm();
            }}
          >
            {pending ? 'Completing…' : 'Force-complete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RelayResetDialog({
  open,
  deploymentId,
  onDone,
  onCancel,
}: {
  open: boolean;
  deploymentId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onConfirm(): Promise<void> {
    if (reason.trim() === '') return;
    setPending(true);
    setError(null);
    try {
      await relayResetAdmin(deploymentId, reason.trim());
      toast.success('Relay connection reset');
      setReason('');
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent data-testid="admin-relay-reset-panel" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reset relay connection?</DialogTitle>
          <DialogDescription>
            Clears the current relay binding and issues a fresh connection link. The customer must
            use it to reconnect.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="relay-reset-reason">Reason (required)</Label>
          <Input
            id="relay-reset-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why is the relay connection being reset?"
          />
        </div>
        <OperationError error={error} />
        <DialogFooter>
          <Button variant="ghost" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={reason.trim() === '' || pending} onClick={() => void onConfirm()}>
            {pending ? 'Resetting…' : 'Reset relay'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-6" data-testid="admin-deployment-detail-loading">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-40" />
      </div>
      <Skeleton className="h-10 w-full rounded-xl" />
      <Skeleton className="h-48 w-full rounded-xl" />
    </div>
  );
}
