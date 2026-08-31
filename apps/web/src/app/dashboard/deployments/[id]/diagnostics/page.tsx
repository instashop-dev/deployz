'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { DiagnosticCard } from '@/components/diagnostic-card';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  fetchDiagnostics,
  infraCheckIsIssue,
  infraCheckLabel,
  readInfraChecks,
  relativeTime,
  type Diagnostic,
} from '@/lib/diagnostics';
import { fetchDeployment, type FleetDeploymentDetail } from '@/lib/deployments';

type DiagnosticsState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; detail: FleetDeploymentDetail; diagnostics: Diagnostic[] };

// Diagnostics — the plain-English read of a deployment's failures. Each issue
// renders as a what/why/fix card (§65 top level) with the raw §61 code +
// structured event behind the expandable technical detail. Code-driven only:
// no diagnostic bundles, no log export (S3). Healthy deployments get the
// "no issues" empty state.
export default function DiagnosticsPage() {
  const params = useParams();
  const id = Array.isArray(params.id) ? (params.id[0] ?? '') : (params.id ?? '');
  const [state, setState] = useState<DiagnosticsState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const [detail, diagnostics] = await Promise.all([
          fetchDeployment(id),
          fetchDiagnostics(id),
        ]);
        if (cancelled) return;
        setState({ status: 'loaded', detail, diagnostics });
      } catch {
        if (!cancelled) {
          setState({
            status: 'error',
            message: "We couldn't load the diagnostics. Try again in a moment.",
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
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href={`/dashboard/deployments/${id}`}>
            <ArrowLeft aria-hidden className="size-4" />
            Deployment
          </Link>
        </Button>
      </div>

      {state.status === 'loading' ? <DiagnosticsSkeleton /> : null}
      {state.status === 'error' ? (
        <section
          aria-labelledby="diagnostics-error"
          className="rounded-xl border border-dashed px-6 py-16 text-center"
        >
          <h2 id="diagnostics-error" className="text-lg font-semibold">
            Something went wrong
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
        </section>
      ) : null}
      {state.status === 'loaded' ? (
        <DiagnosticsBody detail={state.detail} diagnostics={state.diagnostics} />
      ) : null}
    </div>
  );
}

function DiagnosticsBody({
  detail,
  diagnostics,
}: {
  detail: FleetDeploymentDetail;
  diagnostics: Diagnostic[];
}) {
  const checks = readInfraChecks(detail.observedState);
  const lastChecked = relativeTime(detail.lastHealthAt);

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Diagnostics</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {detail.applicationName} · {detail.customerName}
        </p>
      </div>

      {checks.length > 0 ? (
        <section aria-labelledby="relay-report" className="flex flex-col gap-3">
          <h2 id="relay-report" className="text-base font-semibold">
            Last relay report
          </h2>
          {lastChecked ? (
            <p className="text-sm text-muted-foreground" data-testid="relay-last-checked">
              Last checked {lastChecked}
            </p>
          ) : null}
          <Card>
            <CardContent className="flex flex-col gap-2 py-4">
              <ul className="flex flex-col gap-1.5">
                {checks.map((check) => (
                  <li key={`${check.name}-${check.detail}`} className="flex items-baseline gap-3">
                    <span
                      aria-hidden
                      className={`mt-1.5 size-2 shrink-0 rounded-full ${check.passed ? 'bg-primary' : infraCheckIsIssue(check) ? 'bg-destructive' : 'bg-muted-foreground'}`}
                    />
                    <span className="text-sm font-medium">{infraCheckLabel(check.name)}</span>
                    <span className="ml-auto text-right text-xs text-muted-foreground">
                      {check.detail}
                    </span>
                  </li>
                ))}
              </ul>
              {checks.every((check) => !infraCheckIsIssue(check)) ? (
                <p className="text-sm text-muted-foreground">No active issues.</p>
              ) : null}
            </CardContent>
          </Card>
        </section>
      ) : null}

      {diagnostics.length === 0 ? (
        <section
          aria-labelledby="diagnostics-empty"
          className="rounded-xl border border-dashed px-6 py-16 text-center"
        >
          <h2 id="diagnostics-empty" className="text-lg font-semibold">
            No issues found
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {detail.state === 'NOT_INSTALLED' || detail.state === 'WAITING_FOR_RELAY'
              ? 'This deployment has not been installed yet, so there is nothing to diagnose.'
              : 'This deployment is healthy, so there is nothing to diagnose.'}
          </p>
        </section>
      ) : (
        <section aria-labelledby="issues" className="flex flex-col gap-3">
          <h2 id="issues" className="text-base font-semibold">
            Issues
          </h2>
          <ul className="flex flex-col gap-3">
            {diagnostics.map((diagnostic, index) => (
              <li key={`${diagnostic.occurredAt}-${diagnostic.failureCode}-${index}`}>
                <DiagnosticCard diagnostic={diagnostic} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function DiagnosticsSkeleton() {
  return (
    <div className="flex flex-col gap-6" data-testid="diagnostics-loading">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-56" />
      </div>
      <Skeleton className="h-48 w-full rounded-xl" />
      <Skeleton className="h-48 w-full rounded-xl" />
    </div>
  );
}
