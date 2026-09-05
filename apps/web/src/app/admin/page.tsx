'use client';

import { AlertTriangle, Cable, HeartCrack, Loader2, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';

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
import {
  fetchAdminOverview,
  type AdminOverview,
  type AdminOverviewDays,
  type AdminPilotInsights,
} from '@/lib/admin';
import {
  JOB_PRESENTATION_BADGE,
  JOB_PRESENTATION_LABEL,
  jobPresentationState,
  pilotFailureLabel,
} from '@/lib/admin-vocabulary';
import { formatElapsedSeconds } from '@/lib/deployment-progress';
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
  const [days, setDays] = useState<AdminOverviewDays>(30);

  useEffect(() => {
    let cancelled = false;
    // Keep the last loaded overview on the screen while the window refetches
    // (same keep-loaded pattern as the admin jobs list on filter change).
    setState((current) => (current.status === 'loaded' ? current : { status: 'loading' }));
    async function run(): Promise<void> {
      try {
        const overview = await fetchAdminOverview(days);
        if (!cancelled) setState({ status: 'loaded', overview });
      } catch (caught) {
        if (!cancelled) setState({ status: 'error', message: errorMessage(caught) });
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [attempt, days]);

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
      {state.status === 'loaded' ? (
        <OverviewBody overview={state.overview} days={days} onDaysChange={setDays} />
      ) : null}
    </div>
  );
}

function OverviewBody({
  overview,
  days,
  onDaysChange,
}: {
  overview: AdminOverview;
  days: AdminOverviewDays;
  onDaysChange: (days: AdminOverviewDays) => void;
}) {
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

      <PilotInsights insights={overview.pilotInsights} days={days} onDaysChange={onDaysChange} />
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

// ── Pilot insights (§ docs/admin/team-admin.md "Pilot insights") ────────────
//
// A compact MVP-program readout over the trailing `days` window — kept to
// muted labels + tabular counts so it reads as an operational support
// console, never a dashboard. Every count comes straight from the API's
// pilotInsights read model; nothing here is re-derived.

const PILOT_DAYS_OPTIONS: { value: AdminOverviewDays; label: string }[] = [
  { value: 7, label: '7d' },
  { value: 30, label: '30d' },
  { value: 90, label: '90d' },
];

const PILOT_FUNNEL_STEPS: { key: keyof AdminPilotInsights['funnel']; label: string }[] = [
  { key: 'applicationsCreated', label: 'Applications' },
  { key: 'analysisCompleted', label: 'Analysis completed' },
  { key: 'preflightPassed', label: 'Ready to provision' },
  { key: 'awsLaunched', label: 'Provisioning started' },
  { key: 'relayConnected', label: 'Relay connected' },
  { key: 'healthy', label: 'Healthy' },
];

/** The pilot section is empty only when every windowed metric is at its
 *  zero/null baseline — the API's empty-window contract. */
function pilotInsightsEmpty(insights: AdminPilotInsights): boolean {
  const { funnel, quality, failures, deployLinks, support } = insights;
  return (
    funnel.applicationsCreated === 0 &&
    funnel.analysisCompleted === 0 &&
    funnel.preflightPassed === 0 &&
    funnel.awsLaunched === 0 &&
    funnel.relayConnected === 0 &&
    funnel.healthy === 0 &&
    quality.installSuccessRate === null &&
    quality.retryRate === null &&
    quality.medianTimeToHealthyMs === null &&
    quality.p90TimeToHealthyMs === null &&
    quality.sampleSize === 0 &&
    failures.length === 0 &&
    deployLinks.created === 0 &&
    deployLinks.opened === 0 &&
    deployLinks.launched === 0 &&
    deployLinks.relayConnected === 0 &&
    deployLinks.healthy === 0 &&
    support.healthyWithoutSupport === 0 &&
    support.requiredSupportIntervention === 0 &&
    support.supportSessions === 0
  );
}

function formatRate(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function PilotInsights({
  insights,
  days,
  onDaysChange,
}: {
  insights: AdminPilotInsights;
  days: AdminOverviewDays;
  onDaysChange: (days: AdminOverviewDays) => void;
}) {
  return (
    <section aria-labelledby="pilot-insights" className="flex flex-col gap-3" data-testid="pilot-insights">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="pilot-insights" className="text-base font-semibold">
            Pilot insights
          </h2>
          <p data-testid="pilot-window" className="mt-0.5 text-xs text-muted-foreground">
            Last {insights.window.days} days
          </p>
        </div>
        <div
          role="group"
          aria-label="Insight window"
          className="inline-flex items-center gap-1 rounded-lg bg-muted p-1"
          data-testid="pilot-days-toggle"
        >
          {PILOT_DAYS_OPTIONS.map((option) => (
            <Button
              key={option.value}
              size="xs"
              variant="ghost"
              aria-pressed={days === option.value}
              onClick={() => onDaysChange(option.value)}
              className={
                days === option.value
                  ? 'bg-background text-foreground shadow-sm hover:bg-background'
                  : 'text-muted-foreground'
              }
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>

      {pilotInsightsEmpty(insights) ? (
        <EmptySection message="No pilot activity in this window" />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <PilotFunnelCard funnel={insights.funnel} />
          <PilotQualityCard quality={insights.quality} />
          <PilotDeployLinksCard deployLinks={insights.deployLinks} />
          <PilotFailuresCard failures={insights.failures} />
          <PilotSupportCard support={insights.support} />
        </div>
      )}
    </section>
  );
}

function MetricList({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="flex flex-col text-sm">
      {rows.map((row) => (
        <div
          key={row.label}
          className="flex items-baseline justify-between gap-4 border-b py-2 last:border-0"
        >
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="flex items-baseline gap-2 font-medium tabular-nums">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function PilotFunnelCard({ funnel }: { funnel: AdminPilotInsights['funnel'] }) {
  return (
    <Card data-testid="pilot-funnel">
      <CardHeader>
        <CardTitle>Pilot funnel</CardTitle>
      </CardHeader>
      <CardContent>
        <MetricList
          rows={PILOT_FUNNEL_STEPS.map((step, index) => {
            const count = funnel[step.key];
            const previousCount = index === 0 ? null : funnel[PILOT_FUNNEL_STEPS[index - 1]!.key];
            // A zero previous stage means the funnel has not reached it yet —
            // rendering a 0% would misread as a conversion failure.
            const showConversion = previousCount !== null && previousCount > 0;
            return {
              label: step.label,
              value: (
                <>
                  {showConversion ? (
                    <span className="text-xs font-normal text-muted-foreground">
                      {formatRate(Math.min(count / previousCount, 1))}
                    </span>
                  ) : null}
                  <span>{count}</span>
                </>
              ),
            };
          })}
        />
      </CardContent>
    </Card>
  );
}

function PilotQualityCard({ quality }: { quality: AdminPilotInsights['quality'] }) {
  const { installSuccessRate, retryRate, medianTimeToHealthyMs, p90TimeToHealthyMs, sampleSize } =
    quality;
  const rows: { label: string; value: ReactNode }[] = [
    {
      label: 'Install success rate',
      value: installSuccessRate === null ? '—' : formatRate(installSuccessRate),
    },
    { label: 'Retry rate', value: retryRate === null ? '—' : formatRate(retryRate) },
    {
      label: 'Median time to healthy',
      value:
        medianTimeToHealthyMs === null ? '—' : formatElapsedSeconds(medianTimeToHealthyMs / 1000),
    },
    {
      label: 'P90 time to healthy',
      value:
        p90TimeToHealthyMs === null || sampleSize < 10 ? (
          <span className="text-xs font-normal text-muted-foreground">Sample too small</span>
        ) : (
          formatElapsedSeconds(p90TimeToHealthyMs / 1000)
        ),
    },
  ];
  return (
    <Card data-testid="pilot-quality">
      <CardHeader>
        <CardTitle>Deployment quality</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <MetricList rows={rows} />
        {sampleSize > 0 ? (
          <p className="text-xs text-muted-foreground">
            Time-to-healthy measured on {sampleSize} deployment{sampleSize === 1 ? '' : 's'}.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function PilotFailuresCard({ failures }: { failures: AdminPilotInsights['failures'] }) {
  return (
    <Card data-testid="pilot-failures">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle>Common failures</CardTitle>
        <Button asChild variant="ghost" size="sm">
          <Link href="/admin/deployments?filter=failed">View deployments</Link>
        </Button>
      </CardHeader>
      {failures.length === 0 ? (
        <CardContent>
          <p className="text-sm text-muted-foreground">No failures in this window.</p>
        </CardContent>
      ) : (
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Failure</TableHead>
                <TableHead>Count</TableHead>
                <TableHead>Deployments affected</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {failures.map((failure) => {
                const label = pilotFailureLabel(failure.code);
                return (
                  <TableRow key={failure.code}>
                    <TableCell>
                      {label ?? <span className="text-muted-foreground">{failure.code}</span>}
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">{failure.count}</TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {failure.affectedDeployments}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      )}
    </Card>
  );
}

function PilotDeployLinksCard({ deployLinks }: { deployLinks: AdminPilotInsights['deployLinks'] }) {
  const rows: { label: string; value: ReactNode }[] = [
    { label: 'Created', value: deployLinks.created },
    { label: 'Opened', value: deployLinks.opened },
    { label: 'Launched', value: deployLinks.launched },
    { label: 'Relay connected', value: deployLinks.relayConnected },
    { label: 'Healthy', value: deployLinks.healthy },
  ];
  return (
    <Card data-testid="pilot-deploy-links">
      <CardHeader>
        <CardTitle>Deploy Links</CardTitle>
      </CardHeader>
      <CardContent>
        <MetricList rows={rows} />
      </CardContent>
    </Card>
  );
}

function PilotSupportCard({ support }: { support: AdminPilotInsights['support'] }) {
  const rows: { label: string; value: ReactNode }[] = [
    { label: 'Healthy without support', value: support.healthyWithoutSupport },
    { label: 'Required support intervention', value: support.requiredSupportIntervention },
  ];
  return (
    <Card data-testid="pilot-support">
      <CardHeader>
        <CardTitle>Support</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <MetricList rows={rows} />
        <p className="text-xs text-muted-foreground">{support.supportSessions} support sessions</p>
      </CardContent>
    </Card>
  );
}
