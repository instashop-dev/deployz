'use client';

import { ArrowLeft, CheckCircle2, ChevronDown, CircleDot, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiRequestError, errorMessage } from '@/lib/api-client';
import { fetchAdminJob, type AdminJobDetail, type AdminJobTimelineEntry } from '@/lib/admin';
import { JOB_PRESENTATION_BADGE, JOB_PRESENTATION_LABEL, jobPresentationState } from '@/lib/admin-vocabulary';
import { JOB_TYPE_LABEL } from '@/lib/deployment-vocabulary';
import { failureCodeCopy } from '@/lib/diagnostic-vocabulary';
import { relativeTime } from '@/lib/diagnostics';

type DetailState =
  | { status: 'loading' }
  | { status: 'error'; message: string; notFound: boolean }
  | { status: 'loaded'; detail: AdminJobDetail };

const TIMELINE_LABELS: Record<string, string> = {
  created: 'Job created',
  relay_pickup: 'Relay picked up the job',
  finished: 'Finished',
  failed: 'Failed',
};

export default function AdminJobDetailPage() {
  const params = useParams();
  const id = Array.isArray(params.id) ? (params.id[0] ?? '') : (params.id ?? '');
  const [state, setState] = useState<DetailState>({ status: 'loading' });

  const load = useCallback(async (): Promise<void> => {
    setState({ status: 'loading' });
    try {
      const detail = await fetchAdminJob(id);
      setState({ status: 'loaded', detail });
    } catch (caught) {
      const notFound = caught instanceof ApiRequestError && caught.code === 'NOT_FOUND';
      setState({
        status: 'error',
        notFound,
        message: notFound ? "This job doesn't exist." : errorMessage(caught),
      });
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2 self-start">
        <Link href="/admin/jobs">
          <ArrowLeft aria-hidden className="size-4" />
          Jobs
        </Link>
      </Button>

      {state.status === 'loading' ? <DetailSkeleton /> : null}
      {state.status === 'error' ? (
        <section
          aria-labelledby="job-error"
          className="rounded-xl border border-dashed px-6 py-16 text-center"
        >
          <h2 id="job-error" className="text-lg font-semibold">
            {state.notFound ? 'Job not found' : 'Something went wrong'}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
          {!state.notFound ? (
            <Button variant="outline" className="mt-4" onClick={() => void load()}>
              Try again
            </Button>
          ) : null}
        </section>
      ) : null}
      {state.status === 'loaded' ? <JobDetailBody detail={state.detail} /> : null}
    </div>
  );
}

function JobDetailBody({ detail }: { detail: AdminJobDetail }) {
  const presentation = jobPresentationState(detail.state, detail.stuck);
  const failure = detail.failureCode ? failureCodeCopy(detail.failureCode) : null;

  return (
    <>
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{JOB_TYPE_LABEL[detail.type]}</h1>
          <Badge variant={JOB_PRESENTATION_BADGE[presentation]}>{JOB_PRESENTATION_LABEL[presentation]}</Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {detail.vendor.name}
          {detail.customer ? ` · ${detail.customer.name}` : ''}
          {detail.application ? ` · ${detail.application.name}` : ''}
        </p>
        {detail.deployment ? (
          <Link
            href={`/admin/deployments/${detail.deployment.id}`}
            className="mt-1 inline-block text-sm text-primary hover:underline"
          >
            View deployment →
          </Link>
        ) : null}
      </div>

      {failure ? (
        <Card>
          <CardContent className="flex flex-col gap-1 py-4">
            <p className="text-sm font-medium text-destructive">{failure.label}</p>
            <p className="text-sm text-muted-foreground">{failure.description}</p>
          </CardContent>
        </Card>
      ) : null}

      <section aria-labelledby="job-summary" className="flex flex-col gap-3">
        <h2 id="job-summary" className="text-base font-semibold">
          Summary
        </h2>
        <Card>
          <CardContent className="flex flex-col gap-3 py-4">
            <MetaRow label="Job ID" value={detail.id} />
            <MetaRow label="Created" value={relativeTime(detail.createdAt) ?? '—'} />
            <MetaRow label="Started" value={relativeTime(detail.startedAt) ?? 'Not started'} />
            <MetaRow label="Finished" value={relativeTime(detail.finishedAt) ?? 'Not finished'} />
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="timeline" className="flex flex-col gap-3">
        <h2 id="timeline" className="text-base font-semibold">
          Execution timeline
        </h2>
        <Timeline entries={detail.timeline} />
      </section>

      <section aria-labelledby="job-technical" className="flex flex-col gap-3">
        <h2 id="job-technical" className="text-base font-semibold">
          Technical details
        </h2>
        <TechnicalDetails detail={detail} />
      </section>
    </>
  );
}

function Timeline({ entries }: { entries: AdminJobTimelineEntry[] }) {
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">No timeline data yet.</p>;
  }
  return (
    <ol className="flex flex-col" data-testid="job-timeline">
      {entries.map((entry, index) => (
        <li key={`${entry.at}-${index}`} className="relative flex gap-3 pb-4 last:pb-0">
          <div className="mt-0.5 flex flex-col items-center">
            <TimelineIcon entry={entry} />
          </div>
          <div className="min-w-0 flex-1 rounded-lg border px-3 py-2.5">
            <p className="text-sm font-medium">
              {entry.type === 'job' ? (TIMELINE_LABELS[entry.label] ?? entry.label) : entry.label}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {new Date(entry.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function TimelineIcon({ entry }: { entry: AdminJobTimelineEntry }) {
  if (entry.label === 'failed' || (entry.result != null && entry.result.startsWith('failed'))) {
    return <XCircle className="size-4 text-destructive" aria-hidden />;
  }
  if (entry.label === 'finished') {
    return <CheckCircle2 className="size-4 text-primary" aria-hidden />;
  }
  return <CircleDot className="size-4 text-muted-foreground" aria-hidden />;
}

function TechnicalDetails({ detail }: { detail: AdminJobDetail }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-4">
        {detail.errorDetail ? (
          <Collapsible>
            <CollapsibleTrigger className="group flex items-center gap-1 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
              Raw error
              <ChevronDown
                aria-hidden
                className="size-4 transition-transform group-data-[state=open]:rotate-180"
              />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <code className="mt-2 block whitespace-pre-wrap break-all rounded-md bg-muted px-2 py-1.5 text-xs">
                {detail.errorDetail}
              </code>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
            Payload
            <ChevronDown
              aria-hidden
              className="size-4 transition-transform group-data-[state=open]:rotate-180"
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <code className="mt-2 block whitespace-pre-wrap break-all rounded-md bg-muted px-2 py-1.5 text-xs">
              {JSON.stringify(detail.payload, null, 2)}
            </code>
          </CollapsibleContent>
        </Collapsible>
        {detail.stackEvents.count > 0 ? (
          <Collapsible>
            <CollapsibleTrigger className="group flex items-center gap-1 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
              {detail.stackEvents.count} AWS stack event{detail.stackEvents.count === 1 ? '' : 's'}
              <ChevronDown
                aria-hidden
                className="size-4 transition-transform group-data-[state=open]:rotate-180"
              />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="mt-2 flex flex-col gap-1">
                {detail.stackEvents.recent.map((event) => (
                  <li key={event.id} className="flex flex-col gap-0.5 rounded-md bg-muted px-2 py-1.5 text-xs">
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
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </CardContent>
    </Card>
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
    <div className="flex flex-col gap-6" data-testid="admin-job-detail-loading">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-32 w-full rounded-xl" />
      <Skeleton className="h-48 w-full rounded-xl" />
    </div>
  );
}
