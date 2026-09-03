'use client';

import { Eye, MoreHorizontal, Search, Stethoscope } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { DeploymentStatusBadge } from '@/components/deployment-status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
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
import type { VendorDeploymentStatus } from '@deployz/contracts';

import { fetchDeployments, listedUnderStatus, type FleetDeployment } from '@/lib/deployments';
import { DEPLOYMENT_STATES, deploymentStateLabel } from '@/lib/deployment-vocabulary';
import { STAGE_LABEL, STEP_LABEL, removedProgress } from '@/lib/deployment-progress';
import { relativeTime } from '@/lib/diagnostics';
import { attentionReason } from '@/lib/home-state';
import { useStatusPoll } from '@/lib/use-status-poll';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'empty' }
  | { status: 'loaded'; deployments: FleetDeployment[] };

// Status filter values: the §46 states plus "attention", the homepage's
// needs-attention classification, so both views speak about the same fleet
// the same way.
type StatusFilter = (typeof DEPLOYMENT_STATES)[number] | 'attention';

const STATUS_FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'attention', label: 'Needs attention' },
  ...DEPLOYMENT_STATES.map((state) => ({
    value: state as StatusFilter,
    label: state === 'DELETED' ? 'Removed' : deploymentStateLabel(state),
  })),
];

function matchesStatus(deployment: FleetDeployment, filter: StatusFilter): boolean {
  if (filter === 'attention') return attentionReason(deployment) !== null;
  return listedUnderStatus(deployment, filter);
}

/** True once a deployment's derived stage can no longer advance on its own —
 *  the list slows its poll cadence the same way the detail page does. */
function isSettled(status: VendorDeploymentStatus): boolean {
  return status.stage === 'READY' || status.stage === 'FAILED';
}

/** The compact detail shown next to the stage on the fleet list: the
 *  server-derived step during PROVISIONING (more specific than the
 *  stage-level activity sentence), falling back to the component actively
 *  being created, then to the server's own currentActivity sentence. */
function progressDetail(status: VendorDeploymentStatus): string {
  // The step lookup tolerates an older API without `step` (a mixed-version
  // rollout window) by falling through to the activity sentence.
  if (status.stage === 'PROVISIONING' && status.step && STEP_LABEL[status.step]) {
    return STEP_LABEL[status.step].pending;
  }
  return status.currentActivity;
}

// The fleet dashboard — the vendor's primary recurring-value view. Customer /
// Application / Version / Region / Status with client-side search and filters
// persisted in the URL (e.g. /dashboard/deployments?status=attention), all
// derived from data the list already carries. §46 vocabulary only; bulk deploy
// is not MVP scope, so the list carries no selection controls.
export default function DeploymentsPage() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const router = useRouter();
  const searchParams = useSearchParams();

  const search = searchParams.get('q') ?? '';
  const status = searchParams.get('status') ?? 'all';
  const application = searchParams.get('application') ?? 'all';
  const region = searchParams.get('region') ?? 'all';

  useEffect(() => {
    let cancelled = false;
    async function run(): Promise<void> {
      try {
        const deployments = await fetchDeployments({ includeDeleted: true });
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

  // Background refresh of the fleet's derived status, once the initial load
  // has already produced a list to update — the loading/error skeleton above
  // never re-triggers from this. Filters/search stay untouched: they are
  // client-side and URL-persisted, derived fresh from the updated rows below.
  const poll = useStatusPoll({
    fetcher: () => fetchDeployments({ includeDeleted: true }),
    intervalMs: 12_000,
    terminalIntervalMs: 60_000,
    isTerminal: (list) =>
      list.length === 0 || list.every((deployment) => isSettled(deployment.deploymentStatus)),
    enabled: state.status === 'loaded' || state.status === 'empty',
  });

  useEffect(() => {
    if (poll.data === null) return;
    setState(
      poll.data.length === 0 ? { status: 'empty' } : { status: 'loaded', deployments: poll.data },
    );
  }, [poll.data]);

  function setFilter(key: string, value: string): void {
    const params = new URLSearchParams(searchParams.toString());
    if (value === 'all' || value === '') params.delete(key);
    else params.set(key, value);
    const query = params.toString();
    router.replace(query ? `/dashboard/deployments?${query}` : '/dashboard/deployments', {
      scroll: false,
    });
  }

  const deployments = state.status === 'loaded' ? state.deployments : [];

  const applications = useMemo(
    () => [...new Set(deployments.map((deployment) => deployment.applicationName))].sort(),
    [deployments],
  );
  const regions = useMemo(
    () => [...new Set(deployments.map((deployment) => deployment.region))].sort(),
    [deployments],
  );

  const filtered = useMemo(() => {
    if (state.status !== 'loaded') return [];
    const needle = search.trim().toLowerCase();
    return deployments.filter((deployment) => {
      if (!matchesStatus(deployment, status as StatusFilter)) return false;
      if (application !== 'all' && deployment.applicationName !== application) return false;
      if (region !== 'all' && deployment.region !== region) return false;
      if (needle !== '') {
        const haystack =
          `${deployment.customerName} ${deployment.applicationName} ${deployment.version ?? ''}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [state, deployments, search, status, application, region]);

  const hasFilters = search !== '' || status !== 'all' || application !== 'all' || region !== 'all';
  const removedCount = deployments.filter((deployment) => deployment.state === 'DELETED').length;

  return (
    <div className="flex flex-col gap-6">
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
            <Link href="/dashboard/deployments/new">Deploy customer</Link>
          </Button>
        )}
      </div>

      {state.status === 'loading' ? <LoadingState /> : null}
      {state.status === 'error' ? (
        <ErrorState message={state.message} onRetry={() => setAttempt((n) => n + 1)} />
      ) : null}
      {state.status === 'empty' ? <EmptyState /> : null}
      {state.status === 'loaded' ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={search}
                onChange={(event) => setFilter('q', event.target.value)}
                placeholder="Search customers"
                aria-label="Search deployments"
                className="w-full pl-8 sm:w-56"
              />
            </div>
            <Select value={status} onValueChange={(value) => setFilter('status', value)}>
              <SelectTrigger aria-label="Filter by status" className="w-full sm:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {STATUS_FILTER_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {applications.length > 1 ? (
              <Select
                value={application}
                onValueChange={(value) => setFilter('application', value)}
              >
                <SelectTrigger aria-label="Filter by application" className="w-full sm:w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All applications</SelectItem>
                  {applications.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            {regions.length > 1 ? (
              <Select value={region} onValueChange={(value) => setFilter('region', value)}>
                <SelectTrigger aria-label="Filter by region" className="w-full sm:w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All regions</SelectItem>
                  {regions.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>

          {filtered.length === 0 ? (
            hasFilters ? (
              <p className="px-1 text-sm text-muted-foreground">
                No deployments match these filters.
              </p>
            ) : removedCount > 0 ? (
              <p className="px-1 text-sm text-muted-foreground">
                No active deployments.{' '}
                <button
                  type="button"
                  className="underline underline-offset-4"
                  onClick={() => setFilter('status', 'DELETED')}
                >
                  {removedCount === 1
                    ? '1 removed deployment may still have retained resources.'
                    : `${removedCount} removed deployments may still have retained resources.`}
                </button>
              </p>
            ) : null
          ) : (
            <FleetTable deployments={filtered} />
          )}
        </>
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

function FleetTable({ deployments }: { deployments: FleetDeployment[] }) {
  return (
    <Card>
      <CardContent className="overflow-x-auto p-0">
        <Table data-testid="deployment-list">
          <TableHeader>
            <TableRow>
              <TableHead>Customer</TableHead>
              <TableHead>Application</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Region</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {deployments.map((deployment) => (
              <TableRow key={deployment.id}>
                <TableCell>
                  <Link
                    href={`/dashboard/deployments/${deployment.id}`}
                    className="font-medium hover:underline"
                  >
                    {deployment.customerName}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {deployment.applicationName}
                </TableCell>
                <TableCell className="text-muted-foreground tabular-nums">
                  {deployment.version ?? '—'}
                </TableCell>
                <TableCell className="text-muted-foreground">{deployment.region}</TableCell>
                <TableCell>
                  <DeploymentStatusBadge state={deployment.state} />
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {removedProgress(deployment.state)?.body ??
                      `${STAGE_LABEL[deployment.deploymentStatus.stage]} · ${progressDetail(deployment.deploymentStatus)}`}
                  </p>
                  {relativeTime(deployment.deploymentStatus.updatedAt) ? (
                    // data-testid: masked in visual regression — relative
                    // time drifts with the clock.
                    <p className="text-xs text-muted-foreground" data-testid="status-updated">
                      Updated {relativeTime(deployment.deploymentStatus.updatedAt)}
                    </p>
                  ) : null}
                  {/* Relay connectivity is observed (last check-in), never
                      inferred from the lifecycle state above. */}
                  {deployment.relayStatus === 'DISCONNECTED' ? (
                    <p className="mt-0.5 text-xs text-destructive">Relay offline</p>
                  ) : null}
                </TableCell>
                <TableCell className="w-10">
                  <RowActions deploymentId={deployment.id} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// Only actions whose availability is derivable from list data: navigation to
// screens that already exist. Day-2 operations keep their gating on the
// detail page — one place, one rule.
function RowActions({ deploymentId }: { deploymentId: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Deployment actions"
          className="ml-auto"
        >
          <MoreHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link href={`/dashboard/deployments/${deploymentId}`}>
            <Eye aria-hidden />
            View deployment
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={`/dashboard/deployments/${deploymentId}/diagnostics`}>
            <Stethoscope aria-hidden />
            View diagnostics
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
