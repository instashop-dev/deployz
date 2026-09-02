'use client';

import { Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { DeploymentStatusBadge } from '@/components/deployment-status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { errorMessage } from '@/lib/api-client';
import { fetchAdminDeployments, type AdminDeploymentListRow, type DeploymentListFilter } from '@/lib/admin';
import { STUCK_BADGE, STUCK_LABEL } from '@/lib/admin-vocabulary';
import { HEALTH_STATUS_BADGE, HEALTH_STATUS_LABEL } from '@/lib/deployment-vocabulary';
import { relativeTime } from '@/lib/diagnostics';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'empty' }
  | { status: 'loaded'; deployments: AdminDeploymentListRow[] };

const FILTER_OPTIONS: { value: DeploymentListFilter | 'all'; label: string }[] = [
  { value: 'all', label: 'All deployments' },
  { value: 'active', label: 'Active' },
  { value: 'failed', label: 'Failed' },
  { value: 'unhealthy', label: 'Unhealthy' },
  { value: 'stuck', label: 'Stuck' },
  { value: 'deleting', label: 'Deleting' },
  { value: 'disconnected', label: 'Disconnected' },
];

// Cross-tenant fleet table — the primary command-center list. Search/filter
// are wired to the admin API's q/filter params (server-side, not
// client-filtered), URL-persisted so a deep link (e.g. from the Overview
// count cards) reproduces the same list.
export default function AdminDeploymentsPage() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const router = useRouter();
  const searchParams = useSearchParams();

  const q = searchParams.get('q') ?? '';
  const filter = (searchParams.get('filter') as DeploymentListFilter | null) ?? 'all';

  useEffect(() => {
    let cancelled = false;
    setState((current) => (current.status === 'loaded' ? current : { status: 'loading' }));
    async function run(): Promise<void> {
      try {
        const deployments = await fetchAdminDeployments({
          q: q || undefined,
          filter: filter === 'all' ? undefined : filter,
        });
        if (cancelled) return;
        setState(deployments.length === 0 ? { status: 'empty' } : { status: 'loaded', deployments });
      } catch (caught) {
        if (!cancelled) setState({ status: 'error', message: errorMessage(caught) });
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [q, filter, attempt]);

  function setFilter(key: string, value: string): void {
    const params = new URLSearchParams(searchParams.toString());
    if (value === 'all' || value === '') params.delete(key);
    else params.set(key, value);
    const query = params.toString();
    router.replace(query ? `/admin/deployments?${query}` : '/admin/deployments', { scroll: false });
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Deployments</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every customer installation across every vendor.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={q}
            onChange={(event) => setFilter('q', event.target.value)}
            placeholder="Search customer, application, AWS account, region"
            aria-label="Search deployments"
            data-testid="admin-deployments-search"
            className="w-full pl-8 sm:w-72"
          />
        </div>
        <Select value={filter} onValueChange={(value) => setFilter('filter', value)}>
          <SelectTrigger
            aria-label="Filter deployments"
            data-testid="admin-deployments-filter"
            className="w-full sm:w-48"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FILTER_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {state.status === 'loading' ? <ListSkeleton /> : null}
      {state.status === 'error' ? (
        <ErrorState message={state.message} onRetry={() => setAttempt((n) => n + 1)} />
      ) : null}
      {state.status === 'empty' ? (
        <p className="px-1 text-sm text-muted-foreground">No deployments match these filters.</p>
      ) : null}
      {state.status === 'loaded' ? <DeploymentsTable deployments={state.deployments} /> : null}
    </div>
  );
}

function DeploymentsTable({ deployments }: { deployments: AdminDeploymentListRow[] }) {
  return (
    <Card>
      <CardContent className="overflow-x-auto p-0">
        <Table data-testid="admin-deployments-table">
          <TableHeader>
            <TableRow>
              <TableHead>Vendor</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Application</TableHead>
              <TableHead>AWS account</TableHead>
              <TableHead>Region</TableHead>
              <TableHead>Release</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Health</TableHead>
              <TableHead>Last change</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {deployments.map((deployment) => (
              <TableRow key={deployment.id} data-testid="admin-deployment-row">
                <TableCell className="text-muted-foreground">{deployment.organizationName}</TableCell>
                <TableCell>
                  <Link
                    href={`/admin/deployments/${deployment.id}`}
                    className="font-medium hover:underline"
                  >
                    {deployment.customerName}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">{deployment.applicationName}</TableCell>
                <TableCell className="text-muted-foreground">{deployment.awsAccountId ?? '—'}</TableCell>
                <TableCell className="text-muted-foreground">{deployment.region}</TableCell>
                <TableCell className="text-muted-foreground tabular-nums">
                  {deployment.version ?? '—'}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1">
                    <DeploymentStatusBadge state={deployment.state} />
                    {deployment.stuck ? <Badge variant={STUCK_BADGE}>{STUCK_LABEL}</Badge> : null}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={HEALTH_STATUS_BADGE[deployment.healthStatus]}>
                    {HEALTH_STATUS_LABEL[deployment.healthStatus]}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {relativeTime(deployment.updatedAt) ?? '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
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

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-3" data-testid="admin-deployments-loading">
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-24 w-full rounded-xl" />
    </div>
  );
}
