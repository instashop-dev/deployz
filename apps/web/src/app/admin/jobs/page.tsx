'use client';

import { Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

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
import { fetchAdminJobs, type AdminJobListRow, type JobListFilter } from '@/lib/admin';
import { JOB_PRESENTATION_BADGE, JOB_PRESENTATION_LABEL, jobPresentationState } from '@/lib/admin-vocabulary';
import { formatElapsedSeconds } from '@/lib/deployment-progress';
import { JOB_TYPE_LABEL } from '@/lib/deployment-vocabulary';
import { failureCodeCopy } from '@/lib/diagnostic-vocabulary';
import { relativeTime } from '@/lib/diagnostics';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'empty' }
  | { status: 'loaded'; jobs: AdminJobListRow[] };

const FILTER_OPTIONS: { value: JobListFilter | 'all'; label: string }[] = [
  { value: 'all', label: 'All jobs' },
  { value: 'queued', label: 'Queued' },
  { value: 'running', label: 'Running' },
  { value: 'failed', label: 'Failed' },
  { value: 'stuck', label: 'Stuck' },
];

// Global async-work view with the centralized STUCK definition
// (docs/admin/team-admin.md) — every row's `stuck` flag comes straight from
// the API's `isJobStuck`, never re-derived client-side.
export default function AdminJobsPage() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const router = useRouter();
  const searchParams = useSearchParams();

  const q = searchParams.get('q') ?? '';
  const filter = (searchParams.get('filter') as JobListFilter | null) ?? 'all';

  useEffect(() => {
    let cancelled = false;
    setState((current) => (current.status === 'loaded' ? current : { status: 'loading' }));
    async function run(): Promise<void> {
      try {
        const jobs = await fetchAdminJobs({ q: q || undefined, filter: filter === 'all' ? undefined : filter });
        if (cancelled) return;
        setState(jobs.length === 0 ? { status: 'empty' } : { status: 'loaded', jobs });
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
    router.replace(query ? `/admin/jobs?${query}` : '/admin/jobs', { scroll: false });
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Jobs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every async operation across every vendor.
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
            placeholder="Search job, customer, application, operation"
            aria-label="Search jobs"
            data-testid="admin-jobs-search"
            className="w-full pl-8 sm:w-72"
          />
        </div>
        <Select value={filter} onValueChange={(value) => setFilter('filter', value)}>
          <SelectTrigger aria-label="Filter jobs" data-testid="admin-jobs-filter" className="w-full sm:w-40">
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
        <p className="px-1 text-sm text-muted-foreground">No jobs match these filters.</p>
      ) : null}
      {state.status === 'loaded' ? <JobsTable jobs={state.jobs} /> : null}
    </div>
  );
}

function JobsTable({ jobs }: { jobs: AdminJobListRow[] }) {
  return (
    <Card>
      <CardContent className="overflow-x-auto p-0">
        <Table data-testid="admin-jobs-table">
          <TableHeader>
            <TableRow>
              <TableHead>Job</TableHead>
              <TableHead>Vendor</TableHead>
              <TableHead>Deployment</TableHead>
              <TableHead>Operation</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Error</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.map((job) => {
              const presentation = jobPresentationState(job.state, job.stuck);
              const failure = job.failureCode ? failureCodeCopy(job.failureCode) : null;
              return (
                <TableRow key={job.id} data-testid="admin-job-row">
                  <TableCell>
                    <Link href={`/admin/jobs/${job.id}`} className="font-medium hover:underline">
                      {job.id.slice(0, 8)}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{job.organizationName}</TableCell>
                  <TableCell>
                    <Link
                      href={`/admin/deployments/${job.deploymentId}`}
                      className="text-muted-foreground hover:underline"
                    >
                      {job.customerName}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{JOB_TYPE_LABEL[job.type]}</TableCell>
                  <TableCell>
                    <Badge variant={JOB_PRESENTATION_BADGE[presentation]}>
                      {JOB_PRESENTATION_LABEL[presentation]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{relativeTime(job.createdAt) ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {job.durationMs !== null ? formatElapsedSeconds(job.durationMs / 1000) : '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{failure?.label ?? '—'}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section
      aria-labelledby="jobs-error"
      className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center"
    >
      <h2 id="jobs-error" className="text-lg font-semibold">
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
    <div className="flex flex-col gap-3" data-testid="admin-jobs-loading">
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-24 w-full rounded-xl" />
    </div>
  );
}
