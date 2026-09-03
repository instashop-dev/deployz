'use client';

import type { VendorDeploymentStatus } from '@deployz/contracts';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock,
  Loader2,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { DeploymentUrlCard } from '@/components/deployment-url-card';
import { ElapsedTime, PROGRESS_DOT, timedSteps } from '@/components/deployment-progress-card';
import { DeploymentProgressSteps } from '@/components/deployment-progress-steps';
import { Card, CardContent, CardFooter } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { HeroModel, HeroTone } from '@/lib/deployment-hero';
import { COMPONENT_PROGRESS_LABEL } from '@/lib/deployment-progress';
import { JOB_STATE_LABEL, JOB_TYPE_LABEL } from '@/lib/deployment-vocabulary';
import type { FleetDeploymentDetail } from '@/lib/deployments';
import { relativeTime } from '@/lib/diagnostics';
import { cn } from '@/lib/utils';

const TONE_ICON: Record<HeroTone, ReactNode> = {
  neutral: <Clock aria-hidden className="size-5 text-muted-foreground" />,
  progress: <Loader2 aria-hidden className="size-5 animate-spin text-primary" />,
  success: <CheckCircle2 aria-hidden className="size-5 text-primary" />,
  warning: <AlertTriangle aria-hidden className="size-5 text-destructive" />,
  destructive: <AlertCircle aria-hidden className="size-5 text-destructive" />,
};

/**
 * The state-aware hero at the top of the vendor deployment detail page. The
 * words come from deriveHero (lib/deployment-hero.ts); this component only
 * lays them out, adds the state-specific block (the live URL, the install
 * step list, the failure reference) and hosts the contextual action row.
 */
export function DeploymentHero({
  detail,
  hero,
  actions,
  children,
}: {
  detail: FleetDeploymentDetail;
  hero: HeroModel;
  /** The contextual action row rendered in the card footer. */
  actions: ReactNode;
  /** State-specific extra content (disconnect progress, retained-resource alerts). */
  children?: ReactNode;
}) {
  const status = detail.deploymentStatus;
  const failure = status.failure;
  // The address shows whenever the application is (or is believed to be)
  // serving — including after a failed update, when the previous release is
  // exactly what the vendor may want to check.
  const showUrl =
    (hero.kind === 'live' ||
      hero.kind === 'operation-failed' ||
      hero.kind === 'degraded' ||
      hero.kind === 'lost-contact') &&
    detail.appUrl !== null;

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 shrink-0">{TONE_ICON[hero.tone]}</span>
          <div className="min-w-0 flex-1">
            {/* The one aria-live region on this page: the headline itself,
                so assistive tech announces a transition without re-reading
                the whole card on every poll tick. */}
            <h2
              aria-live="polite"
              className={cn(
                'text-xl font-semibold tracking-tight',
                hero.tone === 'destructive' && 'text-destructive',
              )}
            >
              {hero.title}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{hero.description}</p>
            {hero.liveReleaseNote ? (
              <p className="mt-1 text-sm font-medium">{hero.liveReleaseNote}</p>
            ) : null}
            {status.statusUpdatesUnavailable ? (
              <p className="mt-1 text-sm text-muted-foreground">
                Status updates are temporarily unavailable — showing the last confirmed state.
              </p>
            ) : null}
          </div>
        </div>

        {showUrl && detail.appUrl ? <DeploymentUrlCard detail={detail} /> : null}

        {hero.kind === 'updating' ? <OperationProgress detail={detail} /> : null}

        {hero.showSteps ? <InstallSteps status={status} /> : null}

        {failure ? (
          <p className="text-xs text-muted-foreground">
            Reference{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">{failure.reference}</code>
            {' · '}Diagnostics has the full explanation and the recommended fix.
          </p>
        ) : null}

        {children}
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-2">{actions}</CardFooter>
    </Card>
  );
}

const ACTIVE_JOB_STATES = ['REQUESTED', 'QUEUED', 'WAITING', 'RUNNING'];

/** The running day-2 operation: which job, and for how long. The install
 *  step list does not apply here — an update never re-creates the stack. */
function OperationProgress({ detail }: { detail: FleetDeploymentDetail }) {
  const job =
    detail.jobs
      .filter((candidate) => ACTIVE_JOB_STATES.includes(candidate.state))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  if (!job) return null;
  const startedAt = job.startedAt ?? job.createdAt;
  return (
    <p className="text-sm text-muted-foreground">
      {JOB_TYPE_LABEL[job.type as keyof typeof JOB_TYPE_LABEL] ?? job.type} ·{' '}
      {JOB_STATE_LABEL[job.state as keyof typeof JOB_STATE_LABEL] ?? job.state} ·{' '}
      <span className="tabular-nums">
        <ElapsedTime startedAt={startedAt} />
      </span>
    </p>
  );
}

/**
 * The install step list (first → last, the process order) with the shared
 * per-step timing, plus the relay/job/stack detail a vendor occasionally
 * needs while an install is in flight — behind "Show deployment details".
 */
function InstallSteps({ status }: { status: VendorDeploymentStatus }) {
  const steps = timedSteps(status);
  const lastSeen = relativeTime(status.relay.lastSeenAt);
  const lastUpdate = relativeTime(status.updatedAt);

  return (
    <div className="flex flex-col gap-3">
      {steps.length > 0 ? (
        <DeploymentProgressSteps steps={steps} className="sm:grid sm:grid-cols-2 sm:gap-x-8" />
      ) : null}
      <Collapsible>
        <CollapsibleTrigger className="group flex items-center gap-1 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
          Show deployment details
          <ChevronDown
            aria-hidden
            className="size-4 transition-transform group-data-[state=open]:rotate-180"
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="mt-2 flex flex-col divide-y rounded-lg border text-sm">
            {status.components.map((component) => (
              <li key={component.key} className="flex items-center gap-3 px-3 py-2">
                <span
                  className={`size-2 shrink-0 rounded-full ${PROGRESS_DOT[component.status]}`}
                  aria-hidden
                />
                <span className="font-medium">{component.label}</span>
                <span className="ml-auto text-muted-foreground">
                  {COMPONENT_PROGRESS_LABEL[component.status]}
                </span>
              </li>
            ))}
            <li className="flex items-center gap-3 px-3 py-2">
              <span
                className={`size-2 shrink-0 rounded-full ${status.relay.connected ? 'bg-primary' : 'bg-destructive'}`}
                aria-hidden
              />
              <span className="font-medium">Deployz Relay</span>
              <span className="ml-auto text-muted-foreground" data-testid="status-updated">
                {status.relay.connected ? 'Connected' : 'Offline'}
                {lastSeen ? ` · ${lastSeen}` : ''}
              </span>
            </li>
            {status.job ? (
              <li className="flex items-center gap-3 px-3 py-2">
                <span className="font-medium">Latest job</span>
                <span className="ml-auto text-muted-foreground">
                  {JOB_TYPE_LABEL[status.job.type]} · {JOB_STATE_LABEL[status.job.status]}
                </span>
              </li>
            ) : null}
            <li className="flex items-center gap-3 px-3 py-2">
              <span className="font-medium">Last update</span>
              <span className="ml-auto text-muted-foreground" data-testid="status-updated">
                {lastUpdate ?? '—'}
              </span>
            </li>
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
