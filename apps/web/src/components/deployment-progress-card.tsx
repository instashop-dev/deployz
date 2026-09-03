'use client';

import { useEffect, useState } from 'react';

import type { ComponentProgressStatus, DeploymentStep, VendorDeploymentStatus } from '@deployz/contracts';
import { AlertTriangle } from 'lucide-react';

import { DeploymentProgressSteps } from '@/components/deployment-progress-steps';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { relativeTime } from '@/lib/diagnostics';
import {
  AWAITING_DOMAIN_STEP_DETAIL,
  COMPONENT_PROGRESS_LABEL,
  formatElapsedSeconds,
  stepDetailLine,
  stepWaitingOnInput,
  stepsFromStatus,
  STAGE_LABEL,
  removedProgress,
} from '@/lib/deployment-progress';
import { JOB_STATE_LABEL, JOB_TYPE_LABEL } from '@/lib/deployment-vocabulary';

/** Live elapsed time since `startedAt`, ticking every second — isolated here
 *  so only this small counter re-renders on each tick, not the whole card. */
function ElapsedTime({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const elapsedSeconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  return <>{formatElapsedSeconds(elapsedSeconds)}</>;
}

/**
 * The vendor step list with per-step timing: completed steps show their
 * recorded duration, the active step shows a live elapsed counter plus a
 * muted detail line (typical duration, or a slow-step nudge with the raw AWS
 * stack status — vendors may see it, customers never do).
 */
function timedSteps(status: VendorDeploymentStatus) {
  // `?? []` covers the mixed-version rollout window where an older API
  // (without stepTimings) still serves a newer client bundle — see
  // stepsFromStatus, which degrades the same way.
  const timingByStep = new Map((status.stepTimings ?? []).map((timing) => [timing.step, timing]));
  const waitingOnInput = stepWaitingOnInput({
    step: status.step,
    needsDomainSetup: status.needsDomainSetup,
  });
  return stepsFromStatus({ steps: status.steps, step: status.step, stage: status.stage }).map((step) => {
    if (step.state === 'current') {
      // No elapsed counter while a step waits on someone: a ticking clock
      // there reads as Deployz stalling on work nothing is doing.
      if (waitingOnInput) {
        return { ...step, detail: AWAITING_DOMAIN_STEP_DETAIL };
      }
      return {
        ...step,
        detail: stepDetailLine({
          takingLongerThanUsual: status.takingLongerThanUsual,
          typicalDurationSeconds: status.typicalDurationSeconds,
          longerMessage: `Taking longer than usual${status.aws.stackStatus ? ` · AWS: ${status.aws.stackStatus}` : ''}`,
          typicalLabel: (range) => `Typical: ${range}`,
        }),
        meta: status.stepStartedAt ? <ElapsedTime startedAt={status.stepStartedAt} /> : undefined,
      };
    }
    const durationSeconds = timingByStep.get(step.key as DeploymentStep)?.durationSeconds;
    return durationSeconds != null ? { ...step, meta: formatElapsedSeconds(durationSeconds) } : step;
  });
}

/** Dot color per component-progress status — semantic tokens only (opacity
 *  modifiers, not a raw palette), paired with COMPONENT_PROGRESS_LABEL text
 *  so color never carries meaning alone. */
const PROGRESS_DOT: Record<ComponentProgressStatus, string> = {
  PENDING: 'bg-muted-foreground/50',
  IN_PROGRESS: 'bg-primary/60',
  READY: 'bg-primary',
  FAILED: 'bg-destructive',
  NOT_REQUIRED: 'bg-muted-foreground/30',
};

/**
 * The vendor-side "where is this deployment right now" card, driven entirely
 * by the server-derived `deploymentStatus` — the same stage/step model the
 * customer install page renders, so the two surfaces can never disagree.
 *
 * This is deliberately NOT a duplicate of the page's existing Infrastructure
 * section: that section only appears once a deployment has completed an
 * install (`showInfrastructureRows`), so it renders nothing for the entire
 * WAITING_FOR_AWS / CONNECTING / PROVISIONING run. This card fills that gap
 * with the relay/job/component detail a vendor needs while an install is in
 * flight, and keeps showing it afterwards for continuity.
 */
export function DeploymentProgressCard({
  status,
  deploymentState,
}: {
  status: VendorDeploymentStatus;
  /** The lifecycle state, so a removed deployment is not announced with the
   *  live stage it last earned (`removedProgress`). */
  deploymentState: string;
}) {
  const removed = removedProgress(deploymentState);
  const lastSeen = relativeTime(status.relay.lastSeenAt);
  const lastUpdate = relativeTime(status.updatedAt);
  // Rendered whenever the API surfaces one — the FAILED stage, but also a
  // failed day-2 operation on a deployment whose previous release keeps
  // serving (stage READY/VERIFYING with a non-null failure).
  const failure = status.failure;
  const failureComponentLabel = failure?.component
    ? (status.components.find((component) => component.key === failure.component)?.label ??
      failure.component)
    : null;

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 py-4">
        <div>
          {/* The one aria-live region on this card: the stage text itself,
              so assistive tech announces a transition without re-reading
              the whole card on every poll tick. */}
          <p aria-live="polite" className="text-sm font-semibold">
            {removed ? removed.title : STAGE_LABEL[status.stage]}
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {removed ? removed.body : status.currentActivity}
          </p>
        </div>

        {status.statusUpdatesUnavailable ? (
          <p className="text-sm text-muted-foreground">
            Status updates temporarily unavailable — showing last confirmed state.
          </p>
        ) : null}

        {failure ? (
          <Alert variant="destructive">
            <AlertTriangle aria-hidden />
            <AlertTitle>{failure.message}</AlertTitle>
            <AlertDescription className="flex flex-col gap-1">
              {status.stage !== 'FAILED' ? (
                // A failure surfaced on a live stage is a failed day-2
                // operation: the deployment itself is not down.
                <span>The previous version is still running.</span>
              ) : null}
              {failureComponentLabel ? <span>Component: {failureComponentLabel}</span> : null}
              {failure.awsStatus ? (
                <span>
                  AWS status:{' '}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                    {failure.awsStatus}
                  </code>
                </span>
              ) : null}
              <span>
                Reference:{' '}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                  {failure.reference}
                </code>
              </span>
            </AlertDescription>
          </Alert>
        ) : null}

        <DeploymentProgressSteps steps={timedSteps(status)} />

        <ul className="flex flex-col gap-2">
          {status.components.map((component) => (
            <li
              key={component.key}
              className="flex items-center gap-3 rounded-lg border px-3 py-2.5"
            >
              <span
                className={`size-2 shrink-0 rounded-full ${PROGRESS_DOT[component.status]}`}
                aria-hidden
              />
              <span className="text-sm font-medium">{component.label}</span>
              <span className="ml-auto text-sm text-muted-foreground">
                {COMPONENT_PROGRESS_LABEL[component.status]}
              </span>
            </li>
          ))}
          <li className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
            <span
              className={`size-2 shrink-0 rounded-full ${status.relay.connected ? 'bg-primary' : 'bg-destructive'}`}
              aria-hidden
            />
            <span className="text-sm font-medium">Deployz Relay</span>
            {/* data-testid: masked in visual regression — relative time
                drifts with the clock. */}
            <span className="ml-auto text-sm text-muted-foreground" data-testid="status-updated">
              {status.relay.connected ? 'Connected' : 'Offline'}
              {lastSeen ? ` · ${lastSeen}` : ''}
            </span>
          </li>
          {status.job ? (
            <li className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
              <span className="text-sm font-medium">Latest job</span>
              <span className="ml-auto text-sm text-muted-foreground">
                {JOB_TYPE_LABEL[status.job.type]} · {JOB_STATE_LABEL[status.job.status]}
              </span>
            </li>
          ) : null}
          {status.aws.stackStatus ? (
            <li className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
              <span className="text-sm font-medium">AWS stack</span>
              <code className="ml-auto rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                {status.aws.stackStatus}
              </code>
            </li>
          ) : null}
          <li className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
            <span className="text-sm font-medium">Last update</span>
            <span className="ml-auto text-sm text-muted-foreground" data-testid="status-updated">
              {lastUpdate ?? '—'}
            </span>
          </li>
        </ul>
      </CardContent>
    </Card>
  );
}
