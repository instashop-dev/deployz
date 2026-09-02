'use client';

import { AlertTriangle, ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { deriveConnectionState, fetchAdminConnection, type AdminConnectionDetail } from '@/lib/admin';
import {
  CONNECTION_STATE_BADGE,
  CONNECTION_STATE_LABEL,
  CONNECTION_STATE_PROBLEM,
  JOB_PRESENTATION_BADGE,
  JOB_PRESENTATION_LABEL,
  jobPresentationState,
} from '@/lib/admin-vocabulary';
import { HEALTH_STATUS_BADGE, HEALTH_STATUS_LABEL, JOB_TYPE_LABEL, RELAY_STATUS_LABEL } from '@/lib/deployment-vocabulary';
import { relativeTime } from '@/lib/diagnostics';

type DetailState =
  | { status: 'loading' }
  | { status: 'error'; message: string; notFound: boolean }
  | { status: 'loaded'; detail: AdminConnectionDetail };

export default function AdminConnectionDetailPage() {
  const params = useParams();
  const id = Array.isArray(params.id) ? (params.id[0] ?? '') : (params.id ?? '');
  const [state, setState] = useState<DetailState>({ status: 'loading' });

  const load = useCallback(async (): Promise<void> => {
    setState({ status: 'loading' });
    try {
      const detail = await fetchAdminConnection(id);
      setState({ status: 'loaded', detail });
    } catch (caught) {
      const notFound = caught instanceof ApiRequestError && caught.code === 'NOT_FOUND';
      setState({
        status: 'error',
        notFound,
        message: notFound ? "This connection doesn't exist." : errorMessage(caught),
      });
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2 self-start">
        <Link href="/admin/connections">
          <ArrowLeft aria-hidden className="size-4" />
          AWS Connections
        </Link>
      </Button>

      {state.status === 'loading' ? <DetailSkeleton /> : null}
      {state.status === 'error' ? (
        <section
          aria-labelledby="connection-error"
          className="rounded-xl border border-dashed px-6 py-16 text-center"
        >
          <h2 id="connection-error" className="text-lg font-semibold">
            {state.notFound ? 'Connection not found' : 'Something went wrong'}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
          {!state.notFound ? (
            <Button variant="outline" className="mt-4" onClick={() => void load()}>
              Try again
            </Button>
          ) : null}
        </section>
      ) : null}
      {state.status === 'loaded' ? <ConnectionDetailBody detail={state.detail} /> : null}
    </div>
  );
}

function ConnectionDetailBody({ detail }: { detail: AdminConnectionDetail }) {
  const connectionState = deriveConnectionState(detail.connection);
  const problem = connectionState === 'CONNECTED' ? null : CONNECTION_STATE_PROBLEM[connectionState];

  return (
    <>
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{detail.deployment.customerName}</h1>
          <Badge variant={CONNECTION_STATE_BADGE[connectionState]}>
            {CONNECTION_STATE_LABEL[connectionState]}
          </Badge>
          <Badge variant={HEALTH_STATUS_BADGE[detail.deployment.healthStatus]}>
            {HEALTH_STATUS_LABEL[detail.deployment.healthStatus]}
          </Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {detail.deployment.applicationName} ·{' '}
          <Link href={`/admin/vendors/${detail.deployment.organizationId}`} className="hover:underline">
            {detail.deployment.organizationName}
          </Link>
        </p>
        <Link
          href={`/admin/deployments/${detail.deployment.id}`}
          className="mt-1 inline-block text-sm text-primary hover:underline"
        >
          View deployment →
        </Link>
      </div>

      {problem ? (
        <Alert>
          <AlertTriangle aria-hidden />
          <AlertTitle>{problem.heading}</AlertTitle>
          <AlertDescription>{problem.body}</AlertDescription>
        </Alert>
      ) : null}

      <section aria-labelledby="connection-summary" className="flex flex-col gap-3">
        <h2 id="connection-summary" className="text-base font-semibold">
          Connection
        </h2>
        <Card>
          <CardContent className="flex flex-col gap-3 py-4">
            <MetaRow label="AWS account" value={detail.connection.awsAccountId ?? '—'} />
            <MetaRow label="Region" value={detail.connection.region} />
            <MetaRow label="Bootstrap stack" value={detail.connection.bootstrapStackName ?? '—'} />
            <MetaRow label="Attempt" value={String(detail.connection.attemptNumber)} />
            <MetaRow label="Relay status" value={RELAY_STATUS_LABEL[detail.connection.relayStatus]} />
            <MetaRow label="Last heartbeat" value={relativeTime(detail.connection.lastHealthAt) ?? 'Never'} />
            <MetaRow label="Relay version" value={detail.connection.relayVersion ?? 'Unknown'} />
            <MetaRow label="Bootstrap version" value={detail.connection.bootstrapVersion ?? 'Unknown'} />
            <MetaRow
              label="Can Deployz reach this account?"
              value={detail.connection.communicationPossible ? 'Yes' : 'No'}
            />
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="connection-jobs" className="flex flex-col gap-3">
        <h2 id="connection-jobs" className="text-base font-semibold">
          Recent jobs
        </h2>
        {detail.jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No jobs yet.</p>
        ) : (
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <Table data-testid="connection-jobs-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Operation</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.jobs.map((job) => {
                    const presentation = jobPresentationState(job.state, job.stuck);
                    return (
                      <TableRow key={job.id}>
                        <TableCell>
                          <Link href={`/admin/jobs/${job.id}`} className="font-medium hover:underline">
                            {JOB_TYPE_LABEL[job.type]}
                          </Link>
                        </TableCell>
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
    </>
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
    <div className="flex flex-col gap-6" data-testid="admin-connection-detail-loading">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-32 w-full rounded-xl" />
      <Skeleton className="h-48 w-full rounded-xl" />
    </div>
  );
}
