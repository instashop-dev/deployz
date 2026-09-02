'use client';

import { AlertTriangle, Cable, HeartCrack, Loader2, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { DeploymentStatusBadge } from '@/components/deployment-status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { errorMessage } from '@/lib/api-client';
import { fetchAdminOverview, type AdminOverview } from '@/lib/admin';
import { JOB_PRESENTATION_BADGE, JOB_PRESENTATION_LABEL, jobPresentationState } from '@/lib/admin-vocabulary';
import { JOB_TYPE_LABEL } from '@/lib/deployment-vocabulary';
import { relativeTime } from '@/lib/diagnostics';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; overview: AdminOverview };

// Team Admin's landing page (docs/admin/team-admin.md): what needs attention
// right now, cross-tenant, with every count and row deep-linking to the
// pre-filtered list page or the item's own detail. No charts, no vanity
// metrics — only actionable items.
export default function AdminOverviewPage() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function run(): Promise<void> {
      try {
        const overview = await fetchAdminOverview();
        if (!cancelled) setState({ status: 'loaded', overview });
      } catch (caught) {
        if (!cancelled) setState({ status: 'error', message: errorMessage(caught) });
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Cross-tenant items that need attention right now.
        </p>
      </div>

      {state.status === 'loading' ? <OverviewSkeleton /> : null}
      {state.status === 'error' ? (
        <ErrorState message={state.message} onRetry={() => setAttempt((n) => n + 1)} />
      ) : null}
      {state.status === 'loaded' ? <OverviewBody overview={state.overview} /> : null}
    </div>
  );
}

function OverviewBody({ overview }: { overview: AdminOverview }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" data-testid="admin-overview-counts">
        <CountCard
          label="Failed deployments"
          value={overview.counts.failedDeployments}
          href="/admin/deployments?filter=failed"
          icon={XCircle}
          testId="count-failed-deployments"
        />
        <CountCard
          label="Unhealthy"
          value={overview.counts.unhealthyDeployments}
          href="/admin/deployments?filter=unhealthy"
          icon={HeartCrack}
          testId="count-unhealthy"
        />
        <CountCard
          label="Stuck jobs"
          value={overview.counts.stuckJobs}
          href="/admin/jobs?filter=stuck"
          icon={AlertTriangle}
          testId="count-stuck-jobs"
        />
        <CountCard
          label="Disconnected"
          value={overview.counts.disconnectedRelays}
          href="/admin/connections?filter=DISCONNECTED"
          icon={Cable}
          testId="count-disconnected"
        />
        <CountCard
          label="In progress"
          value={overview.counts.inProgressDeployments}
          href="/admin/deployments?filter=active"
          icon={Loader2}
          testId="count-in-progress"
        />
      </div>

      <section aria-labelledby="recent-failures" className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 id="recent-failures" className="text-base font-semibold">
            Recent failures
          </h2>
          <Button asChild variant="ghost" size="sm">
            <Link href="/admin/deployments?filter=failed">View all</Link>
          </Button>
        </div>
        {overview.recentFailures.length === 0 ? (
          <EmptySection message="No failed deployments." />
        ) : (
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <Table data-testid="overview-recent-failures">
                <TableHeader>
                  <TableRow>
                    <TableHead>Vendor</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Application</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last change</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {overview.recentFailures.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="text-muted-foreground">{row.organizationName}</TableCell>
                      <TableCell>
                        <Link href={`/admin/deployments/${row.id}`} className="font-medium hover:underline">
                          {row.customerName}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{row.applicationName}</TableCell>
                      <TableCell>
                        <DeploymentStatusBadge state={row.state} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {relativeTime(row.updatedAt) ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </section>

      <section aria-labelledby="stuck-jobs" className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 id="stuck-jobs" className="text-base font-semibold">
            Stuck jobs
          </h2>
          <Button asChild variant="ghost" size="sm">
            <Link href="/admin/jobs?filter=stuck">View all</Link>
          </Button>
        </div>
        {overview.stuckJobs.length === 0 ? (
          <EmptySection message="No stuck jobs." />
        ) : (
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <Table data-testid="overview-stuck-jobs">
                <TableHeader>
                  <TableRow>
                    <TableHead>Vendor</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Operation</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {overview.stuckJobs.map((job) => {
                    const presentation = jobPresentationState(job.state, job.stuck);
                    return (
                      <TableRow key={job.id}>
                        <TableCell className="text-muted-foreground">{job.organizationName}</TableCell>
                        <TableCell>
                          <Link href={`/admin/jobs/${job.id}`} className="font-medium hover:underline">
                            {job.customerName}
                          </Link>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{JOB_TYPE_LABEL[job.type]}</TableCell>
                        <TableCell>
                          <Badge variant={JOB_PRESENTATION_BADGE[presentation]}>
                            {JOB_PRESENTATION_LABEL[presentation]}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {relativeTime(job.createdAt) ?? '—'}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </section>

      <section aria-labelledby="disconnected-connections" className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 id="disconnected-connections" className="text-base font-semibold">
            Disconnected connections
          </h2>
          <Button asChild variant="ghost" size="sm">
            <Link href="/admin/connections?filter=DISCONNECTED">View all</Link>
          </Button>
        </div>
        {overview.disconnectedConnections.length === 0 ? (
          <EmptySection message="No disconnected connections." />
        ) : (
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <Table data-testid="overview-disconnected-connections">
                <TableHeader>
                  <TableRow>
                    <TableHead>Vendor</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Application</TableHead>
                    <TableHead>Last change</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {overview.disconnectedConnections.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="text-muted-foreground">{row.organizationName}</TableCell>
                      <TableCell>
                        <Link href={`/admin/connections/${row.id}`} className="font-medium hover:underline">
                          {row.customerName}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{row.applicationName}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {relativeTime(row.updatedAt) ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </section>
    </>
  );
}

function CountCard({
  label,
  value,
  href,
  icon: Icon,
  testId,
}: {
  label: string;
  value: number;
  href: string;
  icon: typeof XCircle;
  testId: string;
}) {
  return (
    <Link href={href} data-testid={testId}>
      <Card className="transition-colors hover:bg-muted/50">
        <CardHeader className="flex-row items-center gap-3 space-y-0">
          <Icon className="size-5 text-muted-foreground" aria-hidden />
          <div>
            <CardDescription>{label}</CardDescription>
            <CardTitle className="text-2xl">{value}</CardTitle>
          </div>
        </CardHeader>
      </Card>
    </Link>
  );
}

function EmptySection({ message }: { message: string }) {
  return <p className="px-1 text-sm text-muted-foreground">{message}</p>;
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section
      aria-labelledby="overview-error"
      className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center"
    >
      <h2 id="overview-error" className="text-lg font-semibold">
        Something went wrong
      </h2>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </section>
  );
}

function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-6" data-testid="admin-overview-loading">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-48 w-full rounded-xl" />
      <Skeleton className="h-48 w-full rounded-xl" />
    </div>
  );
}
