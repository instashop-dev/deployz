'use client';

import { ArrowLeft, ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { ActivityFeed } from '@/components/activity-feed';
import { DeploymentStatusBadge } from '@/components/deployment-status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  fetchDeployment,
  fetchDeploymentEvents,
  type ActivityEvent,
  type DeploymentHealthSignal,
  type FleetDeploymentDetail,
} from '@/lib/deployments';

type DetailState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; detail: FleetDeploymentDetail; events: ActivityEvent[] };

const SIGNAL_STATUS_LABEL: Record<DeploymentHealthSignal['status'], string> = {
  HEALTHY: 'Healthy',
  DEGRADED: 'Needs attention',
  UNHEALTHY: 'Down',
};

const SIGNAL_STATUS_DOT: Record<DeploymentHealthSignal['status'], string> = {
  HEALTHY: 'bg-primary',
  DEGRADED: 'bg-muted-foreground',
  UNHEALTHY: 'bg-destructive',
};

// Deployment detail — status, customer, region, installation id, infra
// version, and the §28 health signals (§46/§65 vocabulary at the top level).
// The raw desired/observed state + signal values sit behind an expandable
// "Technical detail" section (same pattern as the security details page).
// M14: deployment health only — no application observability.
export default function DeploymentDetailPage() {
  const params = useParams();
  const id = Array.isArray(params.id) ? (params.id[0] ?? '') : (params.id ?? '');
  const [state, setState] = useState<DetailState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const [detail, events] = await Promise.all([
          fetchDeployment(id),
          fetchDeploymentEvents(id),
        ]);
        if (cancelled) return;
        setState({ status: 'loaded', detail, events });
      } catch {
        if (!cancelled) {
          setState({
            status: 'error',
            message: "We couldn't load this deployment. Try again in a moment.",
          });
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/dashboard">
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
            Something went wrong
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
        </section>
      ) : null}
      {state.status === 'loaded' ? <DetailBody detail={state.detail} events={state.events} /> : null}
    </div>
  );
}

function DetailBody({ detail, events }: { detail: FleetDeploymentDetail; events: ActivityEvent[] }) {
  return (
    <>
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{detail.name}</h1>
          <DeploymentStatusBadge state={detail.state} />
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{detail.customer}</p>
      </div>

      <section aria-labelledby="overview" className="flex flex-col gap-3">
        <h2 id="overview" className="text-base font-semibold">
          Overview
        </h2>
        <Card>
          <CardContent className="flex flex-col gap-3 py-4">
            <MetaRow label="Region" value={detail.region} />
            <MetaRow label="Installation ID" value={detail.installationId} />
            <MetaRow label="Infra version" value={detail.infraVersion} />
            <MetaRow
              label="Last health check"
              value={detail.lastHealthAt ? new Date(detail.lastHealthAt).toLocaleString() : 'Never'}
            />
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="health" className="flex flex-col gap-3">
        <h2 id="health" className="text-base font-semibold">
          Health
        </h2>
        <ul className="flex flex-col gap-2">
          {detail.signals.map((signal) => (
            <li
              key={signal.key}
              className="flex items-start gap-3 rounded-lg border px-3 py-2.5"
            >
              <span
                className={`mt-1.5 size-2 shrink-0 rounded-full ${SIGNAL_STATUS_DOT[signal.status]}`}
                aria-hidden
              />
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {signal.label}
                  {' '}
                  <span className="text-xs font-normal text-muted-foreground">
                    {SIGNAL_STATUS_LABEL[signal.status]}
                  </span>
                </p>
                <p className="mt-0.5 text-sm text-muted-foreground">{signal.summary}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="technical-detail" className="flex flex-col gap-3">
        <h2 id="technical-detail" className="text-base font-semibold">
          Technical detail
        </h2>
        <details className="group rounded-xl border">
          <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
            Raw state and signal values
            <ChevronDown aria-hidden className="size-4 transition-transform group-open:rotate-180" />
          </summary>
          <div className="flex flex-col gap-3 border-t px-4 py-3 text-sm text-muted-foreground">
            <CodeBlock label="Desired state" value={JSON.stringify(detail.desiredState)} />
            <CodeBlock
              label="Observed state"
              value={detail.observedState ? JSON.stringify(detail.observedState) : '—'}
            />
            {detail.signals.filter((s) => s.detail).map((signal) => (
              <CodeBlock
                key={signal.key}
                label={signal.label}
                value={JSON.stringify(signal.detail)}
              />
            ))}
          </div>
        </details>
      </section>

      <section aria-labelledby="activity" className="flex flex-col gap-3">
        <h2 id="activity" className="text-base font-semibold">
          Activity
        </h2>
        <ActivityFeed events={events} />
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

function CodeBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-medium text-foreground">{label}</span>
      <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{value}</code>
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
      <Skeleton className="h-48 w-full rounded-xl" />
      <Skeleton className="h-48 w-full rounded-xl" />
    </div>
  );
}
