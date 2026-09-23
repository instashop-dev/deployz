'use client';

import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  CircleMinus,
  Info,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

import { DiagnosticCard } from '@/components/diagnostic-card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import {
  fetchDiagnostics,
  infraCheckPresentation,
  infraCheckReport,
  readInfraChecks,
  relativeTime,
  type Diagnostic,
  type InfraCheck,
  type InfraCheckOutcome,
} from '@/lib/diagnostics';
import { fetchDeployment, type FleetDeploymentDetail } from '@/lib/deployments';
import { formatReleaseVersion } from '@/lib/release-version';
import { TONE_TEXT } from '@/lib/status-tone';
import { cn } from '@/lib/utils';

type DiagnosticsState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; detail: FleetDeploymentDetail; diagnostics: Diagnostic[] };

// Diagnostics — the plain-English read of a deployment's failures and of the
// relay's latest infrastructure check. Each failure renders as a
// what/why/fix card (§65 top level) with the raw §61 code + structured event
// behind the expandable technical detail. Code-driven only: no diagnostic
// bundles, no log export (S3). The infrastructure check never stands in for
// application health — that stays on the deployment page.
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
    <div className="flex max-w-3xl flex-col gap-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/dashboard/deployments">Deployments</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href={`/dashboard/deployments/${id}`}>
                {state.status === 'loaded' ? state.detail.applicationName : 'Deployment'}
              </Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Diagnostics</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

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

  return (
    <>
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Diagnostics</h1>
        <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <Fact label="Application" value={detail.applicationName} />
          <Fact label="Customer" value={detail.customerName} />
          <Fact
            label="Running release"
            value={
              detail.version ? (
                <span className="tabular-nums">{formatReleaseVersion(detail.version)}</span>
              ) : (
                'Not deployed yet'
              )
            }
          />
        </dl>
      </div>

      {diagnostics.length > 0 ? (
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
      ) : null}

      <InfrastructureCheck detail={detail} checks={checks} />
    </>
  );
}

function InfrastructureCheck({
  detail,
  checks,
}: {
  detail: FleetDeploymentDetail;
  checks: InfraCheck[];
}) {
  const report = infraCheckReport(checks, detail.lastHealthAt, detail.relayStatus);
  const checkedAgo = relativeTime(detail.lastHealthAt);
  const checkedAt = detail.lastHealthAt ? new Date(detail.lastHealthAt).toLocaleString() : undefined;
  const checkedLine = checkedAgo ? (
    <span data-testid="relay-last-checked" title={checkedAt}>
      Checked {checkedAgo}.
    </span>
  ) : null;
  const notInstalled = detail.state === 'NOT_INSTALLED' || detail.state === 'WAITING_FOR_RELAY';

  return (
    <section aria-labelledby="infra-check" className="flex flex-col gap-3">
      <h2 id="infra-check" className="text-base font-semibold">
        Latest infrastructure check
      </h2>

      {report.kind === 'passed' ? (
        <Alert data-testid="infra-check-outcome">
          <CheckCircle2 aria-hidden className={TONE_TEXT.positive} />
          <AlertTitle>No issues found in the latest infrastructure check.</AlertTitle>
          <AlertDescription>
            <p>
              {checkedLine} This check covers the AWS infrastructure only. Application health is
              on the deployment page.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      {report.kind === 'stale' ? (
        <Alert data-testid="infra-check-outcome">
          <AlertTriangle aria-hidden className={TONE_TEXT.attention} />
          <AlertTitle>The latest infrastructure check is out of date.</AlertTitle>
          <AlertDescription>
            <p>
              {checkedLine} The Deployz connector has not sent a new report since then, so these
              results may no longer match the customer&apos;s AWS account.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      {report.kind === 'issues' ? (
        <Alert variant="destructive" data-testid="infra-check-outcome">
          <AlertCircle aria-hidden />
          <AlertTitle>
            {report.issues.length === 1
              ? '1 issue found in the latest infrastructure check.'
              : `${report.issues.length} issues found in the latest infrastructure check.`}
          </AlertTitle>
          <AlertDescription>
            <ul className="flex flex-col gap-2" data-testid="relay-report-issues">
              {report.issues.map((check) => {
                const presentation = infraCheckPresentation(check);
                return (
                  <li key={check.name} className="flex flex-col gap-0.5">
                    <span className="font-medium text-foreground">{presentation.label}</span>
                    <span>{presentation.problem}</span>
                    <span>Next step: {presentation.nextAction}</span>
                  </li>
                );
              })}
            </ul>
            <p>
              {checkedLine}
              {report.stale ? ' The Deployz connector has not reported since then.' : null}
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      {report.kind === 'unavailable' ? (
        <Alert data-testid="infra-check-outcome">
          <Info aria-hidden />
          <AlertTitle>
            {notInstalled ? 'Nothing to check yet' : 'No infrastructure check has completed yet'}
          </AlertTitle>
          <AlertDescription>
            <p>
              {notInstalled
                ? 'This deployment has not been installed yet, so there is nothing to diagnose.'
                : detail.relayStatus === 'CONNECTED'
                  ? 'Results appear here after the Deployz connector reports on the infrastructure.'
                  : 'The Deployz connector is not connected, so it cannot check the infrastructure. The deployment page shows the connection status.'}
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      {checks.length > 0 ? (
        <>
          <div className="overflow-hidden rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Check
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Result
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {checks.map((check) => {
                  const presentation = infraCheckPresentation(check);
                  return (
                    <tr key={check.name}>
                      <th scope="row" className="px-3 py-2 text-left align-top font-medium">
                        {presentation.label}
                      </th>
                      <td className="px-3 py-2 align-top">
                        <span className="inline-flex items-start gap-1.5">
                          {RESULT_ICON[presentation.outcome]}
                          <span
                            className={cn(
                              presentation.outcome === 'issue' && 'text-destructive',
                              presentation.outcome === 'not_required' && 'text-muted-foreground',
                            )}
                          >
                            {presentation.statusText}
                          </span>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <Collapsible>
            <CollapsibleTrigger className="group flex items-center gap-1 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
              Technical check details
              <ChevronDown
                aria-hidden
                className="size-4 transition-transform group-data-[state=open]:rotate-180"
              />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div
                className="mt-2 flex flex-col gap-2 rounded-lg border px-3 py-2.5 text-xs text-muted-foreground"
                data-testid="relay-report-technical"
              >
                {checks.map((check) => (
                  <div key={check.name} className="flex flex-col gap-0.5">
                    <span className="font-medium text-foreground">{check.name}</span>
                    <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono">
                      {check.detail}
                    </code>
                  </div>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        </>
      ) : null}
    </section>
  );
}

const RESULT_ICON: Record<InfraCheckOutcome, ReactNode> = {
  passed: <CheckCircle2 aria-hidden className={cn('mt-0.5 size-4 shrink-0', TONE_TEXT.positive)} />,
  issue: <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />,
  not_required: <CircleMinus aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />,
};

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words font-medium">{value}</dd>
    </div>
  );
}

function DiagnosticsSkeleton() {
  return (
    <div className="flex flex-col gap-6" data-testid="diagnostics-loading" aria-busy="true">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-56" />
      </div>
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-48 w-full rounded-xl" />
    </div>
  );
}
